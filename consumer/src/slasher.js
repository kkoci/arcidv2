/**
 * slasher.js — Calls ArcIDBond.slash() on-chain when the adjudicator returns a breach verdict.
 *
 * In DEV_MODE=true: logs the slash without sending an on-chain tx (no RPC needed locally) —
 *                    UNLESS config.FORCE_REAL_SLASH is also set, which sends a real tx anyway.
 *                    Exists because DEV_MODE also selects which x402 payment protocol
 *                    oracle.js speaks (see that file's own comment) — the oracle sometimes
 *                    needs DEV_MODE=true for an unrelated reason (its /admin/* auth gate),
 *                    and FORCE_REAL_SLASH lets a demo still produce a genuine on-chain slash
 *                    in that situation instead of a simulated one.
 * In production:    sends a real tx to Arc testnet.
 *
 * Phase 6 (post-submission — see CHANGELOG.md): when config.SESSION_GUARD_ADDRESS
 * is set, CONSUMER_PRIVATE_KEY is treated as a bounded session key and the call
 * routes through ConsumerSessionKeyGuard.guardedSlash() instead of hitting
 * ArcIDBond.slash() directly. The guard enforces its own fixed payout address
 * on-chain, so `consumerAddress` below is only used for the pre-flight bond
 * check and log lines in that mode, not as the actual on-chain recipient.
 *
 * Tiered adjudication, Phase 3 (post-submission — see CHANGELOG.md): every
 * call runs through slashGate.js's gateSlash() first — payee, target,
 * breach-classification, and verdict-hash checks — BEFORE the DEV_MODE
 * branch, so gate violations are demonstrable without a funded testnet
 * wallet, same reasoning Phase 8 applied to the circuit breaker. A gate
 * rejection throws SlashGateError, which propagates to the caller exactly
 * like any other slash failure already did.
 *
 * Tiered adjudication, Phase 5 (post-submission — see CHANGELOG.md):
 * ArcIDBond.slash() (Phase 4) requires a breachClass argument — derived
 * here from verdict.tier, the same signal deterministicVerifier.js (Phase 1)
 * and adjudicator.js (Phase 2) already attach to every verdict, so there is
 * exactly one place in the codebase that maps tier -> BreachClass.
 *
 * Optimistic challenge window, Phase 6.2 (post-submission — see
 * CHANGELOG.md): gateSlash() now also returns a `route` ("instant" |
 * "dispute"), decided by its 5th check against live on-chain state. This
 * file just acts on whichever route the gate already decided — it does not
 * re-derive or second-guess it — calling bond.slash() for "instant" and the
 * new bond.fileIndictment() for "dispute". KNOWN GAP, stated rather than
 * silently unhandled: fileIndictment() has no ConsumerSessionKeyGuard
 * passthrough yet (guardedSlash()/guardedRecordSettlement() exist;
 * guardedFileIndictment() does not) — if SESSION_GUARD_ADDRESS is set and
 * routing decides "dispute", this throws a clear, explicit error rather
 * than silently bypassing the dispute requirement (unsafe) or silently
 * falling back to an instant slash the contract would just reject anyway.
 * Wiring guard support is out of scope for this phase.
 */

const { ethers } = require("ethers");
const config     = require("./config");
const { gateSlash } = require("./slashGate");
const { writeAuditRecord } = require("./auditTrail");

// BreachClass enum values — must match IArcIDBondSlash.sol exactly
// (Semantic = 0, Hard = 1).
const BREACH_CLASS = { semantic: 0, deterministic: 1 };

function breachClassFor(verdict) {
  return BREACH_CLASS[verdict.tier ?? "semantic"] ?? BREACH_CLASS.semantic;
}

// Human-readable ABI — ethers v6 parses these directly
const BOND_ABI = [
  "function slash(address agent, address consumer, string calldata reason, uint8 breachClass) external",
  "function fileIndictment(address agent, address consumer, bytes32 rationaleHash) external returns (uint256 disputeId)",
  "function isActiveBondedAgent(address agent) external view returns (bool)",
  "function bonds(address) external view returns (uint256 amount, uint64 postedAt, bool slashed)",
  "event IndictmentFiled(uint256 indexed disputeId, address indexed agent, address indexed consumer, uint256 claimAmount, uint256 challengeDeadline, bytes32 rationaleHash)",
  "event AgentSlashed(address indexed agent, address indexed consumer, uint256 amount, string reason)",
];

const GUARD_ABI = [
  "function guardedSlash(address agent, string calldata reason, uint8 breachClass) external",
  "function payoutAddress() external view returns (address)",
  "function hasActiveSession() external view returns (bool)",
];

function getBondContract(signerOrProvider) {
  return new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ABI, signerOrProvider);
}

function getGuardContract(signerOrProvider) {
  return new ethers.Contract(config.SESSION_GUARD_ADDRESS, GUARD_ABI, signerOrProvider);
}

/**
 * Execute a slash on-chain (or simulate in dev mode). Since Phase 6.2, may
 * instead file an indictment (held pending dispute) if the gate's routing
 * check decided the amount crosses challengeThreshold — see slashGate.js.
 *
 * @param {object} params
 * @param {string} params.agentAddress     Oracle provider wallet to slash
 * @param {string} params.consumerAddress  Consumer wallet that receives the bond (ignored
 *                                         on-chain when routing through the session guard —
 *                                         the guard's fixed payoutAddress wins instead)
 * @param {string} params.reason           LLM-authored (or Tier 1 machine-generated) rationale,
 *                                         written to AgentSlashed event
 * @param {object} params.oracleResponse   The raw oracle response this verdict was adjudicated over
 * @param {object} params.verdict          The finalized verdict object (either tier)
 * @param {string} params.expectedHash     Verdict-hash captured at verdict-finalization time
 * @returns {Promise<{txHash: string|null, simulated: boolean, route?: "instant"|"dispute", disputeId?: string|null}>}
 */
async function executeSlash({ agentAddress, consumerAddress, reason, oracleResponse, verdict, expectedHash }) {
  const gateResult = await gateSlash({ agentAddress, consumerAddress, oracleResponse, verdict, expectedHash });
  const { route, verdictHash, serviceId, previewAmount } = gateResult;
  const breachClass = breachClassFor(verdict);

  if (config.DEV_MODE && !config.FORCE_REAL_SLASH) {
    const label = route === "dispute" ? "indictment (challenge window)" : "slash";
    console.log(`  [slash] DEV_MODE — simulated ${label}`);
    console.log(`  [slash] agent:    ${agentAddress}`);
    console.log(`  [slash] consumer: ${consumerAddress}`);
    console.log(`  [slash] breachClass: ${verdict.tier ?? "semantic"} (${breachClass})`);
    console.log(`  [slash] reason:   ${reason.slice(0, 120)}...`);
    if (route === "dispute") {
      console.log(`  [slash] route: DISPUTE — preview amount ${previewAmount} exceeds challengeThreshold`);
      await writeAuditRecord({
        agent: agentAddress, payee: consumerAddress, verdictHash, serviceId,
        amount: previewAmount?.toString() ?? null, outcome: "indicted", simulated: true,
        reason: "DEV_MODE — indictment simulated, not filed on-chain",
      });
    }
    // Phase 8.2 — same hash-selection logic as the real on-chain paths below,
    // so DEV_MODE records carry a realistic verdictHash too.
    return { txHash: null, simulated: true, route, verdictHash: route === "dispute" ? verdictHash : ethers.keccak256(ethers.toUtf8Bytes(reason)) };
  }

  const provider = config.getProvider();
  const signer   = new ethers.Wallet(config.CONSUMER_PRIVATE_KEY, provider);
  const bond     = getBondContract(provider);

  // Confirm there's an active bond to slash before sending the tx
  const isActive = await bond.isActiveBondedAgent(agentAddress);
  if (!isActive) {
    console.warn(`  [slash] WARNING: agent ${agentAddress} has no active bond — skipping slash`);
    return { txHash: null, simulated: false, skipped: true, route };
  }

  // Phase 8.2 — captured BEFORE the slash tx so the off-chain ERC-8004 write
  // (consumer/src/erc8004.js) can compute the same percentage-of-bond
  // severity value the on-chain adapter would have, had the real registry
  // allowed a contract-relayed call (see CHANGELOG.md's Phase 8.2 entry).
  const bondBeforeSlash = (await bond.bonds(agentAddress)).amount;

  if (route === "dispute") {
    if (config.SESSION_GUARD_ADDRESS) {
      // See module docs: no guardedFileIndictment() passthrough exists yet.
      // Fail loud rather than silently bypass the dispute requirement or
      // silently fall back to an instant slash the contract would reject.
      throw new Error(
        "fileIndictment() routing via ConsumerSessionKeyGuard is not wired yet (Phase 6.2 scope). " +
        "Unset SESSION_GUARD_ADDRESS to use the direct-signer path for disputed slashes."
      );
    }

    const tx      = await bond.connect(signer).fileIndictment(agentAddress, consumerAddress, verdictHash);
    const receipt = await tx.wait();
    const filedEvent = receipt.logs
      .map((l) => { try { return bond.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "IndictmentFiled");
    const disputeId = filedEvent ? filedEvent.args.disputeId.toString() : null;

    await writeAuditRecord({
      agent: agentAddress, payee: consumerAddress, verdictHash, serviceId,
      amount: previewAmount?.toString() ?? null, onChainTx: receipt.hash,
      outcome: "indicted", simulated: false,
      reason: `filed as disputeId=${disputeId} — pending challenge window`,
    });

    // Phase 8.2 — this is the SAME hash stored as disputes[disputeId].rationaleHash,
    // which resolveDispute()/finalizeExpiredDispute() later pass as the
    // ERC-8004 dual-write's evidenceHash once the dispute resolves.
    return { txHash: receipt.hash, simulated: false, route: "dispute", disputeId, verdictHash };
  }

  if (config.SESSION_GUARD_ADDRESS) {
    const guard = getGuardContract(signer);

    const active = await guard.hasActiveSession();
    if (!active) {
      console.warn(`  [slash] WARNING: no active session key on the guard — skipping slash`);
      return { txHash: null, simulated: false, skipped: true, route };
    }

    const guardPayout = await guard.payoutAddress();
    if (guardPayout.toLowerCase() !== consumerAddress.toLowerCase()) {
      console.warn(
        `  [slash] NOTE: guard payoutAddress (${guardPayout}) differs from ` +
        `CONSUMER_WALLET_ADDRESS (${consumerAddress}) — funds go to the guard's ` +
        `fixed payout address regardless.`
      );
    }

    const tx      = await guard.guardedSlash(agentAddress, reason, breachClass);
    const receipt = await tx.wait();
    const amountSlashed = parseAgentSlashedAmount(bond, receipt);
    // Phase 8.2 — same hash ArcIDBond's slash() computes internally
    // (keccak256(reason)) for the ERC-8004 dual-write's feedbackHash.
    return {
      txHash: receipt.hash, simulated: false, route: "instant",
      verdictHash: ethers.keccak256(ethers.toUtf8Bytes(reason)),
      amountSlashed, bondBeforeSlash,
    };
  }

  const tx      = await bond.connect(signer).slash(agentAddress, consumerAddress, reason, breachClass);
  const receipt = await tx.wait();
  const amountSlashed = parseAgentSlashedAmount(bond, receipt);

  return {
    txHash: receipt.hash, simulated: false, route: "instant",
    verdictHash: ethers.keccak256(ethers.toUtf8Bytes(reason)),
    amountSlashed, bondBeforeSlash,
  };
}

/** Phase 8.2 — parse the real transferred amount from the AgentSlashed event,
 *  rather than trusting previewSlash()'s pre-tx estimate (which could differ
 *  in principle if state changed between preview and execution). */
function parseAgentSlashedAmount(bond, receipt) {
  const event = receipt.logs
    .map((l) => { try { return bond.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "AgentSlashed");
  return event ? event.args.amount : null;
}

/**
 * Read current bond info for an agent (useful for display / traction logging).
 * @returns {Promise<{amount: string, postedAt: number, slashed: boolean}|null>}
 */
async function getBondInfo(agentAddress) {
  try {
    const provider = config.getProvider();
    const bond     = getBondContract(provider);
    const info     = await bond.bonds(agentAddress);
    return {
      amount:   ethers.formatUnits(info.amount, 6), // USDC has 6 decimals
      postedAt: Number(info.postedAt),
      slashed:  info.slashed,
    };
  } catch {
    return null;
  }
}

module.exports = { executeSlash, getBondInfo };
