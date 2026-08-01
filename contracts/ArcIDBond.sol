// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArcIDRegistry} from "./interfaces/IArcIDRegistry.sol";
import {IArcIDBondSlash} from "./interfaces/IArcIDBondSlash.sol";
import {IERC8004ReputationAdapter} from "./interfaces/IERC8004ReputationAdapter.sol";

/// @title ArcIDBond
/// @notice Bonded reputation contract for ArcID agents on Arc.
///
///         Agents post ERC-20 collateral (USDC or USYC) to register with the
///         bond contract.  A consumer agent that purchases a service via x402
///         nanopayments uses a tiered adjudication pipeline (deterministic
///         Tier 1 + LLM-narrowed Tier 2 — see tiered-adjudication doc,
///         post-submission, CHANGELOG.md) to decide whether the provider
///         delivered.  On a confirmed breach the consumer calls slash(),
///         which transfers a breach-class-proportional share of the bond to
///         the consumer wallet — making reputation capital-at-risk rather
///         than a score you ask to be trusted.
///
/// MOAT
///   TEE-gating:    Only agents whose wallet is registered in ArcIDRegistry
///                  (i.e. agentIdBySigner[address] != bytes32(0)) may post a
///                  bond.  Unverified wallets revert with the literal string
///                  "Agent not TEE-verified in ArcID registry" — this is your
///                  proof-of-gating screenshot.  A wrong answer is
///                  cryptographically attributable to a real verified agent.
///
///   USYC support:  Deploy with the USYC token address (Phase 5) to issue
///                  yield-bearing bonds.  Same contract, different constructor
///                  arg — no new code needed.
///
/// PROPORTIONAL SLASHING (tiered-adjudication Phase 4, post-submission —
/// see CHANGELOG.md)
///   A single incident no longer drains the full bond. Each slash() call is
///   classified Semantic (Tier 2 / LLM) or Hard (Tier 1 / deterministic) and
///   capped as a fraction of the REMAINING bond (or a fee multiple for
///   Semantic, whichever is smaller) — see _computeSlashAmount(). Repeated
///   breaches within a rolling 24h epoch escalate: past a configurable
///   per-class threshold, the *next* slash in that epoch takes whatever
///   remains and permanently blacklists the agent from ever posting a bond
///   on this contract again (see `blacklisted` — this contract has no write
///   access to ArcIDRegistryV2 and never modifies the identity layer; the
///   blacklist is bond-contract-local).
///
///   KNOWN LIMITATION, documented rather than hidden: the current schedule
///   is "cheap to nibble, then a cliff" — e.g. with the shipped defaults,
///   5 semantic breaches in one epoch cost only ~5% of the bond combined,
///   and the 6th takes the remaining ~95% in one shot. A graduated
///   per-breach cap that ramps up as the count approaches the threshold
///   (rather than a flat cap until a sudden full drain) is a deferred
///   future refinement, not built now — same deferral pattern as the
///   session-key-guard-vs-ERC-4337 scope call in Phase 6 of the
///   payment-execution doc.
///
/// OPTIMISTIC CHALLENGE WINDOW (Phase 6, post-submission — see CHANGELOG.md)
///   A single Claude-authored semantic verdict deciding a large slash in one
///   shot is a real single-point-of-failure risk once amounts get big
///   enough to matter. Above `challengeThreshold`, a semantic slash is no
///   longer instant: slash() itself reverts (ChallengeThresholdExceeded)
///   and the off-chain consumer must call fileIndictment() instead, which
///   records the claim and starts a `disputeWindow` countdown rather than
///   moving funds immediately. It resolves one of two ways:
///     - resolveDispute() — the interim resolver (Option A: `owner`, stated
///       explicitly as a placeholder, NOT the end state — see NatSpec on
///       resolveDispute() itself) approves or rejects before the deadline.
///     - finalizeExpiredDispute() — permissionless; if nobody resolves it
///       before the deadline, the indictment finalizes as approved. This
///       default-execute (not default-block) behavior is what makes the
///       window "optimistic" rather than a veto gate.
///   Both paths recompute the transferred amount at resolution time via the
///   same _computeSlashAmount() slash() uses — never trusting whatever the
///   amount looked like at indictment time — so the amount can't be
///   pre-baked incorrectly if the bond's state changed in between.
///
///   Deliberately NOT disputable, regardless of size: Hard (Tier 1) breaches
///   — mechanical certainty doesn't need a second checkpoint — and any
///   breach that would cross this agent's epoch escalation threshold, which
///   always executes instantly through slash() even if classified Semantic
///   — an escalation is a compounding pattern backed by multiple already-
///   confirmed prior breaches, not a single fresh judgment call, so the
///   risk the window exists to catch doesn't apply the same way. Both
///   scope limits are enforced on-chain (slash()/fileIndictment() revert on
///   misuse), not just by off-chain convention.
///
///   Roadmap: a decentralized resolver (Kleros or equivalent) is the actual
///   target for resolveDispute()'s authority — see README. A multi-model
///   LLM quorum was considered and rejected: models trained on similar data
///   with similar biases can fail in a correlated way on the same input,
///   so adding more LLM votes doesn't buy real independence the way a
///   human/economic arbitration layer does.
///
/// SIMPLIFICATIONS (deliberate, note in writeup)
///   - authorizedSlasher defaults to the deployer wallet.  For the hackathon
///     the consumer agent runs under this key.  A multi-slasher / dispute-
///     window model is deliberate future work noted in the README.
///   - No minimum bond enforced on-chain.  The consumer agent's adjudication
///     logic is the trust-but-verify layer; the contract handles the transfer.
///
/// @custom:security ReentrancyGuard on all state-mutating external functions.
contract ArcIDBond is Ownable, ReentrancyGuard, IArcIDBondSlash {

    // -------------------------------------------------------------------------
    // types
    // -------------------------------------------------------------------------

    struct BondInfo {
        uint256 amount;     // REMAINING collateral held in this contract —
                             // decreases with each partial (non-escalated) slash
        uint64  postedAt;   // block.timestamp of postBond() call
        bool    slashed;    // true once the bond is fully closed out — either by
                             // an escalated full-drain or by depleting to zero
                             // via repeated partial slashes
    }

    /// @dev Tracks breach counts for a single agent within a fixed 24h window.
    ///      `epochStart` only advances when the window has actually elapsed —
    ///      never on every breach — so an agent can't reset its own window by
    ///      timing incidents (a "since-last-breach" window would be gameable
    ///      that way; a fixed calendar window anchored to when it started is not).
    struct BreachEpoch {
        uint64 epochStart;
        uint16 hardCount;
        uint16 semanticCount;
    }

    /// @dev Optimistic challenge window (Phase 6). `None` is also the zero
    ///      value, so `disputes[id].state == None` doubles as "this
    ///      disputeId was never filed" — no separate existence flag needed.
    enum DisputeState { None, Indicted, Resolved }

    /// @dev `claimAmount` is what the amount WOULD be at indictment time —
    ///      informational only. The actual transferred amount is always
    ///      recomputed fresh at resolution via _computeSlashAmount(); this
    ///      struct never stores a number that resolution trusts blindly.
    ///      No breachClass field: disputes are semantic-only by
    ///      construction (see fileIndictment()), so it's implicit.
    struct Dispute {
        address consumer;
        address provider;
        uint256 claimAmount;
        uint256 challengeDeadline;
        bytes32 rationaleHash;
        DisputeState state;
    }

    // -------------------------------------------------------------------------
    // storage
    // -------------------------------------------------------------------------

    IERC20             public immutable collateralToken; // USDC or USYC — fixed at deploy
    IArcIDRegistry     public immutable registry;         // live ArcIDRegistry on Arc

    address public authorizedSlasher; // consumer agent wallet; owner can update

    /// @dev ERC-8004 reputation dual-write (Phase 8.2, post-submission — see
    ///      CHANGELOG.md). Zero address (the default) disables the dual-write
    ///      entirely — every existing deployment, and every existing test,
    ///      keeps working unchanged until this is explicitly set.
    address public reputationAdapter;

    mapping(address => BondInfo) public bonds;

    /// @dev Dedupes recordSettlement() calls — the off-chain consumer agent
    ///      already has its own idempotency ledger, but a duplicate on-chain
    ///      log entry for the same verdict would corrupt the audit trail
    ///      just as a double-slash would, so it's guarded the same way.
    mapping(bytes32 => bool) public settledVerdicts;

    /// @dev Per-agent rolling 24h breach counters. See BreachEpoch.
    mapping(address => BreachEpoch) public breachEpochs;

    /// @dev Permanently barred from postBond() on this contract again.
    ///      Set only when an epoch escalation fully drains a bond. This is a
    ///      bond-contract-local blacklist, NOT a registry deregistration —
    ///      ArcIDRegistryV2 is never written to (see contract-level docs).
    mapping(address => bool) public blacklisted;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint64  public constant EPOCH_DURATION  = 24 hours;

    /// @dev Slash-schedule config — owner-tunable, not hardcoded, so the
    ///      starting parameters can be recalibrated without a redeploy.
    ///      Defaults match the real testnet setup at the time this was
    ///      written: $0.001 USDC oracle fee (6-decimal atomic units), k=100,
    ///      1% (100 bps) semantic cap, 10% (1000 bps) hard cap.
    uint256 public serviceFeeAtomic     = 1_000; // $0.001 USDC @ 6 decimals — owner-settable per collateral token
    uint256 public semanticFeeMultiple  = 100;   // k
    uint256 public semanticCapBps       = 100;   // 1% of remaining bond
    uint256 public hardCapBps           = 1_000; // 10% of remaining bond
    uint16  public hardEscalationThreshold     = 3; // hard breaches per epoch before full-drain
    uint16  public semanticEscalationThreshold = 5; // semantic breaches per epoch before full-drain

    /// @dev Optimistic challenge window config (Phase 6) — owner-tunable,
    ///      same pattern as the slash schedule above. Default threshold is
    ///      set at a real-world-meaningful level ($1.00), well above what
    ///      today's live testnet bond sizes and fee config actually produce
    ///      per semantic slash — demoing a real crossing intentionally
    ///      requires scaling the demo's inputs, not lowering this default
    ///      to something that trivially trips on every breach (see the
    ///      Phase 6.4 demo commands' own honesty note about that).
    uint256 public challengeThreshold = 1_000_000; // $1.00 USDC @ 6 decimals
    uint64  public disputeWindow      = 24 hours;

    mapping(uint256 => Dispute) public disputes;
    uint256 public nextDisputeId; // 1-based; 0 is never a real disputeId

    // -------------------------------------------------------------------------
    // events — consumed by the frontend live counters and the consumer agent log
    // -------------------------------------------------------------------------

    /// @dev Emitted on every successful postBond(). Frontend reads TVL from these.
    event BondPosted(
        address indexed agent,
        uint256 amount,
        address indexed token
    );

    /// @dev Emitted on every slash() (partial or escalated). Signature
    ///      unchanged from pre-Phase-4 — existing frontend/tooling that
    ///      decodes this event keeps working without changes. `amount` is
    ///      whatever this specific call actually transferred (proportional
    ///      or full, depending on escalation), not always the full bond
    ///      anymore.
    event AgentSlashed(
        address indexed agent,
        address indexed consumer,
        uint256 amount,
        string  reason      // LLM-authored (or Tier 1 machine-generated) rationale
    );

    /// @dev New in Phase 4 — the richer companion to AgentSlashed carrying
    ///      the classification data a judge or reviewer would actually want:
    ///      which tier, how many breaches this agent has racked up in the
    ///      current epoch, and whether this specific call was the
    ///      escalation event.
    event BreachClassified(
        address indexed agent,
        IArcIDBondSlash.BreachClass breachClass,
        uint256 amount,
        uint16  epochBreachCount,
        bool    escalated
    );

    /// @dev Emitted once, only on the escalation path — the full-drain +
    ///      permanent-blacklist event. Distinct from AgentSlashed/
    ///      BreachClassified so "this agent is now permanently done" is a
    ///      single, unambiguous signal rather than something a reader has
    ///      to infer from `escalated` on BreachClassified.
    event AgentEscalatedAndBlacklisted(
        address indexed agent,
        uint256 amountTaken,
        IArcIDBondSlash.BreachClass breachClass
    );

    /// @dev Emitted on recordSettlement(). The "no breach" counterpart to
    ///      AgentSlashed — same event-log auditability for the clean path.
    ///      The settlement itself (Circle Gateway payment) already happened
    ///      off-chain; this call only logs it against the bonded agent.
    event PaymentSettled(
        address indexed agent,
        address indexed consumer,
        uint256 amount,
        bytes32 verdictHash  // ties back to the off-chain adjudication record
    );

    /// @dev Emitted on voluntarywithdrawal.
    event BondWithdrawn(address indexed agent, uint256 amount);

    /// @dev Emitted when the owner rotates the slasher key.
    event SlasherUpdated(address indexed oldSlasher, address indexed newSlasher);

    /// @dev Emitted when the owner retunes the slash-amount schedule.
    event SlashParametersUpdated(uint256 semanticFeeMultiple, uint256 semanticCapBps, uint256 hardCapBps);

    /// @dev Emitted when the owner retunes the configured service fee basis.
    event ServiceFeeUpdated(uint256 serviceFeeAtomic);

    /// @dev Emitted when the owner retunes the escalation thresholds.
    event EscalationThresholdsUpdated(uint16 hardThreshold, uint16 semanticThreshold);

    /// @dev Emitted by fileIndictment() — a large semantic slash held
    ///      pending dispute instead of executing immediately. `claimAmount`
    ///      is the amount at indictment time (informational; see Dispute
    ///      struct docs). `rationaleHash` ties back to the off-chain
    ///      Claude evidence, same pattern as PaymentSettled's verdictHash.
    event IndictmentFiled(
        uint256 indexed disputeId,
        address indexed agent,
        address indexed consumer,
        uint256 claimAmount,
        uint256 challengeDeadline,
        bytes32 rationaleHash
    );

    /// @dev Emitted by resolveDispute() or finalizeExpiredDispute(). On
    ///      approval (owner-approved or auto-finalized), the same
    ///      AgentSlashed + BreachClassified events also fire from the
    ///      underlying _executeSlash() call. On rejection, this is the
    ///      only event — no funds moved, bond untouched.
    event DisputeResolved(
        uint256 indexed disputeId,
        bool    approved,
        uint256 amountTransferred,
        bool    autoFinalized
    );

    /// @dev Emitted when the owner retunes the challenge-window config.
    event ChallengeParametersUpdated(uint256 challengeThreshold, uint64 disputeWindow);

    /// @dev ERC-8004 reputation dual-write (Phase 8.2, post-submission — see
    ///      CHANGELOG.md).
    event ReputationAdapterUpdated(address indexed oldAdapter, address indexed newAdapter);

    // -------------------------------------------------------------------------
    // custom errors (gas-efficient; BondPosted gating uses require() for demo UX)
    // -------------------------------------------------------------------------

    error ZeroAmount();
    error BondAlreadyActive();
    error NoBondFound();
    error AlreadySlashed();
    error NotAuthorizedSlasher();
    error AlreadySettled();
    error AgentBlacklisted();
    error InvalidBps();
    error InvalidThreshold();
    error InvalidDisputeWindow();
    error ChallengeThresholdExceeded();   // slash(): amount too large for instant execution — use fileIndictment()
    error ChallengeThresholdNotExceeded(); // fileIndictment(): amount too small to dispute — use slash()
    error EscalatingBreachNotDisputable(); // fileIndictment(): this call would escalate — use slash()
    error DisputeNotIndicted();            // resolveDispute()/finalizeExpiredDispute(): unknown or already-resolved disputeId
    error ChallengeWindowNotExpired();     // finalizeExpiredDispute(): deadline hasn't passed yet

    // -------------------------------------------------------------------------
    // constructor
    // -------------------------------------------------------------------------

    /// @param _collateralToken ERC-20 used as bond collateral. Arc testnet USDC:
    ///        0x3600000000000000000000000000000000000000
    ///        Arc testnet USYC (Phase 5):
    ///        0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C
    /// @param _registry        Live ArcIDRegistry contract address on Arc.
    constructor(address _collateralToken, address _registry) Ownable(msg.sender) {
        collateralToken  = IERC20(_collateralToken);
        registry         = IArcIDRegistry(_registry);
        authorizedSlasher = msg.sender; // default: deployer == consumer agent for hackathon
    }

    // -------------------------------------------------------------------------
    // core: bond posting
    // -------------------------------------------------------------------------

    /// @notice Post a bond. Caller must be TEE-verified in ArcIDRegistry and
    ///         must have approved this contract to spend `amount` of collateralToken.
    ///
    /// @dev    The gating revert string "Agent not TEE-verified in ArcID registry"
    ///         is intentionally a human-readable require() rather than a custom error
    ///         so it appears verbatim in explorers and curl output — it is the
    ///         proof-of-gating screenshot for the case study.
    function postBond(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (blacklisted[msg.sender]) revert AgentBlacklisted();

        // THE MOAT: only TEE-attested wallets may post
        require(
            registry.agentIdBySigner(msg.sender) != bytes32(0),
            "Agent not TEE-verified in ArcID registry"
        );

        // Allow re-bonding after a slash (agent reposts after losing a bond)
        if (bonds[msg.sender].postedAt != 0 && !bonds[msg.sender].slashed) {
            revert BondAlreadyActive();
        }

        collateralToken.transferFrom(msg.sender, address(this), amount);

        bonds[msg.sender] = BondInfo({
            amount:   amount,
            postedAt: uint64(block.timestamp),
            slashed:  false
        });

        emit BondPosted(msg.sender, amount, address(collateralToken));
    }

    // -------------------------------------------------------------------------
    // core: slash
    // -------------------------------------------------------------------------

    /// @notice Slash a bonded agent on a confirmed service breach. Transfers
    ///         a breach-class-proportional share of the REMAINING bond to
    ///         `consumer` — see _computeSlashAmount() — unless this call
    ///         crosses this agent's epoch escalation threshold, in which
    ///         case it takes whatever remains and permanently blacklists
    ///         the agent (see AgentEscalatedAndBlacklisted).
    ///
    ///         The amount is always computed internally from on-chain
    ///         config and on-chain state — callers, including
    ///         ConsumerSessionKeyGuard, cannot pass or influence an amount.
    ///
    ///         Phase 6: a non-escalating Semantic breach whose computed
    ///         amount exceeds `challengeThreshold` reverts here
    ///         (ChallengeThresholdExceeded) — the caller must use
    ///         fileIndictment() instead. Hard breaches and any escalating
    ///         breach are never subject to this gate, at any size — see the
    ///         contract-level NatSpec's Optimistic Challenge Window section.
    ///
    /// @param agent       The bonded provider agent that underdelivered.
    /// @param consumer    The consumer wallet that paid for the service.
    /// @param reason      LLM-authored (or Tier 1 machine-generated) rationale.
    ///                    Logged in AgentSlashed event for on-chain accountability.
    /// @param breachClass Semantic (Tier 2 / LLM) or Hard (Tier 1 / deterministic).
    function slash(
        address agent,
        address consumer,
        string calldata reason,
        BreachClass breachClass
    ) external nonReentrant {
        if (msg.sender != authorizedSlasher) revert NotAuthorizedSlasher();

        if (breachClass == BreachClass.Semantic) {
            (uint256 previewAmount, bool wouldEscalate) = _previewSlash(agent, breachClass);
            if (!wouldEscalate && previewAmount > challengeThreshold) {
                revert ChallengeThresholdExceeded();
            }
        }

        // keccak256(reason) is slash()'s only evidentiary hash — its ABI has
        // no separate hash parameter (deliberately unchanged, see
        // IArcIDBondSlash.sol), unlike fileIndictment()/recordSettlement().
        // Dispute-resolution paths pass their own stored rationaleHash
        // instead — see resolveDispute()/finalizeExpiredDispute() below.
        _executeSlash(agent, consumer, reason, breachClass, keccak256(bytes(reason)));
    }

    /// @dev Shared by slash() (instant path) and resolveDispute() /
    ///      finalizeExpiredDispute() (Phase 6 dispute path) so the actual
    ///      fund-moving + epoch/escalation bookkeeping logic exists in
    ///      exactly one place. This is the entire body of what slash() did
    ///      before Phase 6 — unchanged behavior, just callable from a
    ///      second entry point.
    ///
    ///      `evidenceHash` (Phase 8.2, post-submission — see CHANGELOG.md) is
    ///      purely for the ERC-8004 reputation dual-write below — it does not
    ///      affect fund movement or escalation bookkeeping in any way.
    function _executeSlash(
        address agent,
        address consumer,
        string memory reason,
        BreachClass breachClass,
        bytes32 evidenceHash
    ) internal returns (uint256 amount) {
        BondInfo storage b = bonds[agent];
        if (b.postedAt == 0) revert NoBondFound();
        if (b.slashed)       revert AlreadySlashed();

        uint256 bondBeforeSlash = b.amount;

        (uint16 hardCount, uint16 semanticCount, bool epochExpired) = _epochCounts(agent);

        BreachEpoch storage ep = breachEpochs[agent];
        if (epochExpired) {
            ep.epochStart = uint64(block.timestamp);
            hardCount = 0;
            semanticCount = 0;
        }

        bool escalated;
        uint16 newCount;
        if (breachClass == BreachClass.Hard) {
            newCount = hardCount + 1;
            ep.hardCount = newCount;
            escalated = newCount >= hardEscalationThreshold;
        } else {
            newCount = semanticCount + 1;
            ep.semanticCount = newCount;
            escalated = newCount >= semanticEscalationThreshold;
        }

        if (escalated) {
            amount = b.amount;
            b.amount = 0;
            b.slashed = true;
            blacklisted[agent] = true;
            emit AgentEscalatedAndBlacklisted(agent, amount, breachClass);
        } else {
            amount = _computeSlashAmount(b.amount, breachClass);
            b.amount -= amount;
            if (b.amount == 0) b.slashed = true; // bond exhausted via repeated partial slashes
        }

        collateralToken.transfer(consumer, amount);

        emit AgentSlashed(agent, consumer, amount, reason);
        emit BreachClassified(agent, breachClass, amount, newCount, escalated);

        // ERC-8004 reputation dual-write (Phase 8.2, post-submission — see
        // CHANGELOG.md). try/catch here is load-bearing, not defensive
        // boilerplate: an external registry failure (paused, unavailable,
        // gas griefing) must never be able to revert a real slash. See the
        // "Critical Invariants" section of CLAUDE.md.
        if (reputationAdapter != address(0)) {
            try IERC8004ReputationAdapter(reputationAdapter).reportSlash(
                agent, amount, bondBeforeSlash, breachClass == BreachClass.Hard, evidenceHash
            ) {} catch {}
        }
    }

    /// @dev Used ONLY by resolveDispute()/finalizeExpiredDispute() — never
    ///      by slash() itself, which must keep reverting on an invalid
    ///      target (that's a genuine caller error on the instant path).
    ///
    ///      For the two dispute-resolution paths, an agent that was
    ///      already fully slashed by an unrelated event (e.g. a Hard-breach
    ///      escalation) between indictment and resolution is not a caller
    ///      error — the underlying claim has simply become moot, there is
    ///      nothing left to take. Reverting here would strand the dispute
    ///      in Indicted state forever on the permissionless
    ///      finalizeExpiredDispute() path, with no way to close it out
    ///      except an owner noticing and manually rejecting. Returns 0
    ///      without touching any state instead — the caller still marks
    ///      the dispute Resolved either way, so this is a clean void, not
    ///      a stuck dispute silently swept under the rug. `NoBondFound`
    ///      (postedAt == 0 — e.g. the agent voluntarily withdrew the bond
    ///      entirely while the dispute was pending) is a related,
    ///      still-open gap NOT covered here — deliberately out of scope
    ///      for this fix; still reverts, still stuck. See CHANGELOG.md.
    function _executeSlashOrVoid(
        address agent,
        address consumer,
        string memory reason,
        BreachClass breachClass,
        bytes32 evidenceHash
    ) internal returns (uint256 amount) {
        if (bonds[agent].slashed) return 0;
        return _executeSlash(agent, consumer, reason, breachClass, evidenceHash);
    }

    /// @dev Shared by slash() and previewSlash() so the two can never drift —
    ///      one formula, read by both the state-changing path and the
    ///      read-only preview a judge/reviewer/test would use to verify it.
    ///      `remaining` * capBps is safe from overflow for any realistic
    ///      ERC-20 balance (uint256 headroom is enormous relative to bps
    ///      math), consistent with the rest of this codebase's tokens.
    function _computeSlashAmount(uint256 remaining, BreachClass breachClass)
        internal view returns (uint256 amount)
    {
        if (breachClass == BreachClass.Hard) {
            amount = (remaining * hardCapBps) / BPS_DENOMINATOR;
        } else {
            uint256 feeMultiple = semanticFeeMultiple * serviceFeeAtomic;
            uint256 bondCap = (remaining * semanticCapBps) / BPS_DENOMINATOR;
            amount = feeMultiple < bondCap ? feeMultiple : bondCap;
        }
        // Never a free (zero-cost) breach against a nonzero bond — bps math
        // rounds to 0 once `remaining` is small enough, which would
        // otherwise let a bond sit forever in an untouchable near-zero
        // state (amount always computing to 0, b.amount never reaching
        // exactly 0 either). Floor to the smallest atomic unit instead.
        if (amount == 0 && remaining > 0) amount = 1;
        if (amount > remaining) amount = remaining; // safety clamp; unreachable while bps <= BPS_DENOMINATOR
    }

    /// @dev Fixed 24h calendar window per agent — see BreachEpoch. Returns
    ///      what the counts WOULD be after accounting for expiry, without
    ///      writing anything (slash() applies the reset itself).
    function _epochCounts(address agent)
        internal view returns (uint16 hardCount, uint16 semanticCount, bool epochExpired)
    {
        BreachEpoch storage ep = breachEpochs[agent];
        epochExpired = ep.epochStart == 0 || block.timestamp >= ep.epochStart + EPOCH_DURATION;
        hardCount     = epochExpired ? 0 : ep.hardCount;
        semanticCount = epochExpired ? 0 : ep.semanticCount;
    }

    /// @notice Read-only preview of what slash(agent, breachClass) would do
    ///         right now, without executing it. Returns (0, false) if there
    ///         is no active bond to slash. Exists so the exact on-chain
    ///         formula can be verified independently (tests, judges,
    ///         tooling) rather than trusted from a description.
    function previewSlash(address agent, BreachClass breachClass)
        external view returns (uint256 amount, bool wouldEscalate)
    {
        return _previewSlash(agent, breachClass);
    }

    /// @dev Shared by previewSlash() (external, read-only) and slash() /
    ///      fileIndictment() (which both need this to decide, respectively,
    ///      whether to revert into the dispute path or accept an
    ///      indictment) — one formula, three callers, so they can never drift.
    function _previewSlash(address agent, BreachClass breachClass)
        internal view returns (uint256 amount, bool wouldEscalate)
    {
        BondInfo storage b = bonds[agent];
        if (b.postedAt == 0 || b.slashed) return (0, false);

        (uint16 hardCount, uint16 semanticCount, ) = _epochCounts(agent);

        if (breachClass == BreachClass.Hard) {
            wouldEscalate = (hardCount + 1) >= hardEscalationThreshold;
        } else {
            wouldEscalate = (semanticCount + 1) >= semanticEscalationThreshold;
        }

        amount = wouldEscalate ? b.amount : _computeSlashAmount(b.amount, breachClass);
    }

    // -------------------------------------------------------------------------
    // core: settlement logging (no-breach path)
    // -------------------------------------------------------------------------

    /// @notice Record a successful off-chain settlement (Circle Gateway
    ///         payment) against a bonded agent's clean adjudication verdict.
    ///
    ///         This does NOT move funds — settlement already happened via
    ///         Circle Gateway before this call. Its only job is to give the
    ///         "no breach" outcome the same on-chain event-log auditability
    ///         that slash() already gives the breach outcome.
    ///
    ///         Requiring an active, unslashed bond means a payment can never
    ///         be logged for an agent whose bond was already slashed — the
    ///         two outcomes are mutually exclusive on-chain, not just by
    ///         convention in the consumer agent's off-chain logic.
    ///
    /// @param agent       The bonded provider agent that was paid.
    /// @param consumer    The consumer wallet that made the payment.
    /// @param amount      Amount settled, in the payment token's smallest unit.
    /// @param verdictHash Hash of the adjudicator's verdict outcome (off-chain
    ///                     identifier); prevents the same verdict being
    ///                     recorded on-chain twice.
    function recordSettlement(
        address agent,
        address consumer,
        uint256 amount,
        bytes32 verdictHash
    ) external nonReentrant {
        if (msg.sender != authorizedSlasher) revert NotAuthorizedSlasher();

        BondInfo storage b = bonds[agent];
        if (b.postedAt == 0) revert NoBondFound();
        if (b.slashed)       revert AlreadySlashed();

        if (settledVerdicts[verdictHash]) revert AlreadySettled();
        settledVerdicts[verdictHash] = true;

        emit PaymentSettled(agent, consumer, amount, verdictHash);

        // ERC-8004 reputation dual-write (Phase 8.2, post-submission — see
        // CHANGELOG.md). Same load-bearing try/catch reasoning as
        // _executeSlash() above.
        if (reputationAdapter != address(0)) {
            try IERC8004ReputationAdapter(reputationAdapter).reportSettlement(agent, verdictHash) {} catch {}
        }
    }

    // -------------------------------------------------------------------------
    // core: optimistic challenge window (Phase 6, post-submission — see CHANGELOG.md)
    // -------------------------------------------------------------------------

    /// @notice Hold a large semantic slash pending dispute instead of
    ///         executing it immediately. Called by the off-chain consumer's
    ///         post-verdict handler — the same authorizedSlasher key that
    ///         would otherwise have called slash() directly — the moment it
    ///         determines the amount exceeds `challengeThreshold`. There is
    ///         no separate human "file a dispute" action; this IS the
    ///         verdict handler's response to a large semantic breach.
    ///
    ///         Always evaluated as BreachClass.Semantic — Hard breaches
    ///         never reach this function; there's no breachClass parameter
    ///         to misuse, by construction. Reverts if this breach would
    ///         escalate (EscalatingBreachNotDisputable — escalations always
    ///         execute instantly through slash(), regardless of size) or if
    ///         the amount doesn't actually exceed the threshold
    ///         (ChallengeThresholdNotExceeded — should have gone through
    ///         slash() instead). Together with slash()'s own threshold
    ///         check, this makes "which function do I call" a fact about
    ///         on-chain state, not a convention the caller has to get right.
    ///
    /// @param agent          The bonded provider agent being disputed.
    /// @param consumer       The consumer wallet that would receive the slash.
    /// @param rationaleHash  keccak256 of the off-chain Claude evidence —
    ///                       same verdictHash pattern as PaymentSettled.
    ///                       The full rationale text lives in the consumer's
    ///                       own audit log, not on-chain.
    /// @return disputeId     1-based identifier for dispute:list / dispute:resolve.
    function fileIndictment(
        address agent,
        address consumer,
        bytes32 rationaleHash
    ) external nonReentrant returns (uint256 disputeId) {
        if (msg.sender != authorizedSlasher) revert NotAuthorizedSlasher();

        BondInfo storage b = bonds[agent];
        if (b.postedAt == 0) revert NoBondFound();
        if (b.slashed)       revert AlreadySlashed();

        (uint256 previewAmount, bool wouldEscalate) = _previewSlash(agent, BreachClass.Semantic);
        if (wouldEscalate) revert EscalatingBreachNotDisputable();
        if (previewAmount <= challengeThreshold) revert ChallengeThresholdNotExceeded();

        disputeId = ++nextDisputeId;
        uint256 deadline = block.timestamp + disputeWindow;

        disputes[disputeId] = Dispute({
            consumer:          consumer,
            provider:          agent,
            claimAmount:       previewAmount,
            challengeDeadline: deadline,
            rationaleHash:     rationaleHash,
            state:             DisputeState.Indicted
        });

        emit IndictmentFiled(disputeId, agent, consumer, previewAmount, deadline, rationaleHash);
    }

    /// @notice Resolve a pending dispute before its deadline.
    ///
    /// @dev    Interim resolver: this function is currently owner-only.
    ///         This is a placeholder for a decentralized dispute-resolution
    ///         integration (see README) once dispute volume and stakes
    ///         justify that integration's cost. A single owner-controlled
    ///         resolver is a known centralization point, stated here rather
    ///         than obscured.
    ///
    ///         On approval the amount is recomputed fresh via
    ///         _computeSlashAmount() at resolution time — never trusted
    ///         from the indictment's stored claimAmount — so a bond change
    ///         between indictment and resolution can't produce a stale or
    ///         manipulated transfer. On rejection, nothing moves and the
    ///         provider's bond is untouched.
    ///
    ///         GRACEFUL VOID (not a revert): if the agent's bond was
    ///         independently fully slashed (e.g. by an escalation from an
    ///         unrelated breach) between indictment and resolution, an
    ///         approval here does NOT revert — it executes through
    ///         _executeSlashOrVoid(), which returns 0 without touching any
    ///         state, and the dispute still finalizes to Resolved with
    ///         `DisputeResolved(disputeId, true, 0, ...)`: `approved=true`
    ///         records the intent, `amountTransferred=0` records that
    ///         nothing was left to take. This matters most for
    ///         finalizeExpiredDispute() below, which is permissionless —
    ///         a revert there would strand the dispute in Indicted state
    ///         forever with no permissionless way to close it out. An
    ///         explicit REJECTION (resolveDispute(id, false)) never calls
    ///         the slash-execution path at all, so it was and remains
    ///         unaffected by any of this — it always succeeds regardless of
    ///         the bond's state.
    ///
    ///         STILL-OPEN, narrower gap (deliberately not fixed here): if
    ///         the agent voluntarily withdrew the bond entirely via
    ///         withdrawBond() while the dispute was pending (`postedAt`
    ///         reset to 0, not `slashed=true`), approval still reverts
    ///         NoBondFound and the dispute can still get stuck — only an
    ///         explicit owner rejection closes it out in that case. Left
    ///         out of this fix deliberately, at hackathon scope; see
    ///         CHANGELOG.md.
    ///
    /// @param disputeId Dispute to resolve.
    /// @param approved  true = execute the slash now; false = dismiss it.
    function resolveDispute(uint256 disputeId, bool approved) external onlyOwner nonReentrant {
        Dispute storage d = disputes[disputeId];
        if (d.state != DisputeState.Indicted) revert DisputeNotIndicted();

        d.state = DisputeState.Resolved;

        uint256 amount;
        if (approved) {
            amount = _executeSlashOrVoid(
                d.provider,
                d.consumer,
                "[DISPUTE APPROVED] see rationaleHash on IndictmentFiled event",
                BreachClass.Semantic,
                d.rationaleHash
            );
        }

        emit DisputeResolved(disputeId, approved, amount, false);
    }

    /// @notice Permissionlessly finalize a dispute whose challenge window
    ///         has expired with no resolveDispute() call — the "optimistic"
    ///         default: unless the interim resolver intervenes, the
    ///         indictment executes exactly as if approved. Anyone may call
    ///         this once the deadline has passed; there's no privileged
    ///         decision being made, only a deterministic deadline check.
    ///
    /// @dev    If the agent was already fully slashed by an unrelated event
    ///         before this call, this does NOT revert — see the GRACEFUL
    ///         VOID note on resolveDispute() above. Being permissionless is
    ///         exactly why this path in particular cannot be allowed to
    ///         revert on a moot claim: there would be no one obligated to
    ///         notice and clean it up.
    /// @param disputeId Dispute to finalize.
    function finalizeExpiredDispute(uint256 disputeId) external nonReentrant {
        Dispute storage d = disputes[disputeId];
        if (d.state != DisputeState.Indicted) revert DisputeNotIndicted();
        if (block.timestamp < d.challengeDeadline) revert ChallengeWindowNotExpired();

        d.state = DisputeState.Resolved;

        uint256 amount = _executeSlashOrVoid(
            d.provider,
            d.consumer,
            "[DISPUTE AUTO-FINALIZED] see rationaleHash on IndictmentFiled event",
            BreachClass.Semantic,
            d.rationaleHash
        );

        emit DisputeResolved(disputeId, true, amount, true);
    }

    // -------------------------------------------------------------------------
    // core: voluntary withdrawal
    // -------------------------------------------------------------------------

    /// @notice Withdraw an unslashed bond. Only the bonded agent can call.
    ///         Withdraws whatever REMAINS — if prior partial slashes have
    ///         reduced the bond, this returns the reduced amount, not the
    ///         original deposit.
    function withdrawBond() external nonReentrant {
        BondInfo storage b = bonds[msg.sender];
        if (b.postedAt == 0) revert NoBondFound();
        if (b.slashed)       revert AlreadySlashed();

        uint256 amount = b.amount;
        delete bonds[msg.sender];

        collateralToken.transfer(msg.sender, amount);

        emit BondWithdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // views
    // -------------------------------------------------------------------------

    /// @notice True if agent has an active (un-slashed) bond on file.
    ///         Used by the consumer agent before deciding whether to call slash().
    function isActiveBondedAgent(address agent) external view returns (bool) {
        BondInfo storage b = bonds[agent];
        return b.postedAt != 0 && !b.slashed;
    }

    // -------------------------------------------------------------------------
    // admin
    // -------------------------------------------------------------------------

    /// @notice Rotate the authorized slasher to a new consumer agent wallet.
    function setAuthorizedSlasher(address newSlasher) external onlyOwner {
        emit SlasherUpdated(authorizedSlasher, newSlasher);
        authorizedSlasher = newSlasher;
    }

    /// @notice Retune the slash-amount schedule. `_semanticCapBps` and
    ///         `_hardCapBps` are basis points of the remaining bond (must be
    ///         <= BPS_DENOMINATOR, i.e. <= 100%). `_semanticFeeMultiple` is
    ///         the k in `k * serviceFeeAtomic` for the semantic-tier cap.
    function setSlashParameters(
        uint256 _semanticFeeMultiple,
        uint256 _semanticCapBps,
        uint256 _hardCapBps
    ) external onlyOwner {
        if (_semanticCapBps > BPS_DENOMINATOR || _hardCapBps > BPS_DENOMINATOR) revert InvalidBps();
        semanticFeeMultiple = _semanticFeeMultiple;
        semanticCapBps      = _semanticCapBps;
        hardCapBps          = _hardCapBps;
        emit SlashParametersUpdated(_semanticFeeMultiple, _semanticCapBps, _hardCapBps);
    }

    /// @notice Retune the configured service fee basis (atomic units of
    ///         collateralToken) used in the semantic-tier `k * fee` term.
    function setServiceFee(uint256 _serviceFeeAtomic) external onlyOwner {
        serviceFeeAtomic = _serviceFeeAtomic;
        emit ServiceFeeUpdated(_serviceFeeAtomic);
    }

    /// @notice Retune how many breaches per rolling 24h epoch trigger
    ///         full-drain escalation, per breach class. Both must be >= 1.
    function setEscalationThresholds(uint16 _hardThreshold, uint16 _semanticThreshold) external onlyOwner {
        if (_hardThreshold == 0 || _semanticThreshold == 0) revert InvalidThreshold();
        hardEscalationThreshold     = _hardThreshold;
        semanticEscalationThreshold = _semanticThreshold;
        emit EscalationThresholdsUpdated(_hardThreshold, _semanticThreshold);
    }

    /// @notice Retune the optimistic challenge window. `_challengeThreshold`
    ///         is in atomic units of collateralToken; `_disputeWindow` is a
    ///         duration in seconds and must be nonzero (a zero window would
    ///         make finalizeExpiredDispute() callable in the same block as
    ///         fileIndictment(), defeating the point of a window at all).
    function setChallengeParameters(uint256 _challengeThreshold, uint64 _disputeWindow) external onlyOwner {
        if (_disputeWindow == 0) revert InvalidDisputeWindow();
        challengeThreshold = _challengeThreshold;
        disputeWindow      = _disputeWindow;
        emit ChallengeParametersUpdated(_challengeThreshold, _disputeWindow);
    }

    /// @notice Set (or clear, via address(0)) the ERC-8004 reputation
    ///         dual-write adapter (Phase 8.2, post-submission — see
    ///         CHANGELOG.md). Deliberately not validated beyond being an
    ///         address — every call into it is try/catch-wrapped at the
    ///         call site regardless, so a wrong address here degrades to
    ///         "every dual-write attempt fails silently," never a stuck
    ///         slash/settlement.
    function setReputationAdapter(address newAdapter) external onlyOwner {
        emit ReputationAdapterUpdated(reputationAdapter, newAdapter);
        reputationAdapter = newAdapter;
    }
}
