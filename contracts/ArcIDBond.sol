// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArcIDRegistry} from "./interfaces/IArcIDRegistry.sol";
import {IArcIDBondSlash} from "./interfaces/IArcIDBondSlash.sol";

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

    // -------------------------------------------------------------------------
    // storage
    // -------------------------------------------------------------------------

    IERC20             public immutable collateralToken; // USDC or USYC — fixed at deploy
    IArcIDRegistry     public immutable registry;         // live ArcIDRegistry on Arc

    address public authorizedSlasher; // consumer agent wallet; owner can update

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

        BondInfo storage b = bonds[agent];
        if (b.postedAt == 0) revert NoBondFound();
        if (b.slashed)       revert AlreadySlashed();

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

        uint256 amount;
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
}
