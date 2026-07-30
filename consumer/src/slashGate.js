/**
 * slashGate.js — Deterministic, non-LLM gate between an adjudication
 * verdict (either tier) and the slash() call. Tiered adjudication, Phase 3
 * (post-submission — see CHANGELOG.md). The exact mirror of
 * paymentGate.js's role in front of Gateway settlement, applied to the
 * older, higher-stakes half of the system: slashing.
 *
 * Four checks, all synchronous/local — no LLM or network round-trip:
 *
 *   1. PAYEE — the consumer address slash proceeds go to must equal
 *      config.CONSUMER_WALLET_ADDRESS exactly. Never a value read from
 *      verdict or response content. This is already true everywhere
 *      executeSlash() is called from today — this check makes it an
 *      enforced invariant instead of an implicit one, same
 *      safety-by-construction-made-explicit move paymentGate.js already
 *      makes on the payment side.
 *
 *   2. TARGET — the agent address about to be slashed must be the same
 *      address that actually produced/signed the response this
 *      serviceId refers to: agentAddress === oracleResponse.oracle ===
 *      config.ORACLE_WALLET_ADDRESS. Prevents a manipulated verdict from
 *      redirecting punishment to a different bonded agent than the one the
 *      interaction was actually with.
 *
 *   3. BREACH CLASSIFICATION — as of Phase 4 (shipped — see CHANGELOG.md),
 *      ArcIDBond.slash() DOES compute a real, proportional amount on-chain
 *      from a `breachClass` argument (BreachClass.Semantic | Hard), and
 *      exposes `previewSlash()` to check that formula's output ahead of a
 *      call. This gate still does NOT call previewSlash() to cross-check
 *      against the live on-chain formula — deliberately, to stay a purely
 *      local/synchronous check with no RPC round-trip, same as
 *      paymentGate.js's checks. What it validates instead: the verdict
 *      carries no externally-asserted amount at all (true by schema
 *      construction for both tiers — neither deterministicVerifier.js's
 *      hard-breach result nor adjudicator.js's deliver_verdict schema has
 *      an amount field, so there's nowhere for one to come from), and the
 *      two independent tier-tracking signals — the caller's own `tier`
 *      value and, for semantic verdicts, Claude's own `breach_class` field
 *      — agree with each other. The actual amount enforcement is the
 *      contract's job (ArcIDBond._computeSlashAmount(), always internal,
 *      never caller-supplied) — this gate's job is catching a
 *      classification mismatch before the call, not re-deriving the dollar
 *      figure.
 *
 *   4. VERDICT-HASH BINDING — recomputes a hash over (serviceId,
 *      verdict.verdict, verdict.should_slash, tier, classification code)
 *      from the (oracleResponse, verdict) values this call actually
 *      received, and compares it against the hash the caller captured at
 *      the moment the verdict was finalized. Refuses on mismatch. NOTE:
 *      in the current synchronous call flow (adjudicate → gate → slash,
 *      all within one runCycle(), no queue or cache in between) both
 *      hashes are always computed from the same live objects, so this is
 *      primarily a structural invariant today, not a defense against a
 *      currently-exploitable time-of-check/time-of-use gap. It becomes a
 *      real defense the moment any async gap, retry queue, or verdict
 *      cache is introduced later — stated honestly rather than oversold.
 *
 *   5. ROUTING (Phase 6.2, post-submission — see CHANGELOG.md) — decides
 *      instant `slash()` vs. held-for-dispute `fileIndictment()` for a
 *      Semantic breach, by reading the live `challengeThreshold` and
 *      `previewSlash()` result from ArcIDBond and mirroring the contract's
 *      own routing rule exactly: Hard breaches are always instant
 *      regardless of size (mechanical certainty doesn't need a challenge
 *      window — a deliberate scope limit, not an oversight); an escalating
 *      Semantic breach is always instant regardless of size (a compounding
 *      pattern backed by multiple already-confirmed prior breaches, not a
 *      single fresh judgment call); a non-escalating Semantic breach whose
 *      previewed amount exceeds `challengeThreshold` routes to dispute.
 *      This is the ONE check of the five that makes a real network
 *      round-trip — a deliberate, documented departure from checks 1-4's
 *      "purely local/synchronous" property, because getting the routing
 *      decision right on the first attempt matters (a wrong guess still
 *      fails safely — ArcIDBond's own `slash()`/`fileIndictment()` gates
 *      independently enforce the identical rule and simply revert on a
 *      mismatch — but a wrong guess wastes a transaction and a demo beat).
 *      If the RPC read itself fails, this fails the gate outright rather
 *      than guessing a route — consistent with every other check here
 *      refusing on anything it can't verify.
 *
 * Rejections throw SlashGateError, are logged to their own
 * `stage: "slash-gate"` entry in slash_failures.jsonl (new — mirrors
 * settlement_failures.jsonl's per-stage shape, kept in a separate file per
 * this project's existing rule that failure classes don't get merged), and
 * write a `gated` line to the shared settlement_audit.jsonl via
 * auditTrail.js, reusing its existing outcome enum rather than inventing a
 * parallel one. A successful slash does NOT get a new audit line here — it
 * already has the on-chain AgentSlashed event as its first-class record
 * (the exact asymmetry Phase 9 built writeAuditRecord() to fix on the
 * payment side, where a gated/failed attempt has no other record at all).
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const config = require("./config");
const { serviceIdFor } = require("./serviceId");
const { writeAuditRecord } = require("./auditTrail");

const FAILURE_LOG_PATH = path.join(path.resolve(config.LOG_DIR), "slash_failures.jsonl");

class SlashGateError extends Error {}

// Minimal ABI for check 5 (routing) only — this module has no other reason
// to touch the chain, same "each file defines exactly the ABI subset it
// needs" convention as deterministicVerifier.js's/auditTrail.js's own
// REGISTRY_ABI, rather than importing slasher.js's larger BOND_ABI.
const BOND_ROUTING_ABI = [
  "function challengeThreshold() view returns (uint256)",
  "function previewSlash(address agent, uint8 breachClass) view returns (uint256 amount, bool wouldEscalate)",
];

// BreachClass enum value — must match IArcIDBondSlash.sol exactly (Semantic = 0).
const BREACH_CLASS_SEMANTIC = 0;

/**
 * Mirrors ArcIDBond's own routing rule exactly (see slash()'s
 * ChallengeThresholdExceeded gate and fileIndictment()'s
 * EscalatingBreachNotDisputable / ChallengeThresholdNotExceeded gates):
 * Hard breaches and escalating Semantic breaches are always instant,
 * regardless of size; a non-escalating Semantic breach above
 * challengeThreshold routes to dispute. Never guesses on an RPC failure —
 * throws instead, so the caller's gate fails loud rather than attempting a
 * call that's likely to just revert anyway.
 */
async function determineRoute({ agentAddress, tier }) {
  if (tier !== "semantic") {
    return { route: "instant" }; // Hard breaches never disputed — see module docs
  }

  const provider = config.getProvider();
  const bond = new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ROUTING_ABI, provider);

  const [challengeThreshold, previewResult] = await Promise.all([
    bond.challengeThreshold(),
    bond.previewSlash(agentAddress, BREACH_CLASS_SEMANTIC),
  ]);
  const [previewAmount, wouldEscalate] = previewResult;

  if (wouldEscalate) {
    return { route: "instant", previewAmount, wouldEscalate: true }; // escalation always instant, any size
  }
  if (previewAmount > challengeThreshold) {
    return { route: "dispute", previewAmount, wouldEscalate: false };
  }
  return { route: "instant", previewAmount, wouldEscalate: false };
}

function logFailure(record) {
  fs.mkdirSync(path.dirname(FAILURE_LOG_PATH), { recursive: true });
  fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

// The classification signal available today, ahead of Phase 4's real
// breachClass/amount formula: Tier 1's machine code (e.g. "TIMESTAMP_STALE")
// or Tier 2's breach_class marker ("semantic").
function classificationOf(verdict) {
  return verdict.code ?? verdict.breach_class ?? null;
}

/**
 * Computes the verdict-hash binding value. Exported so index.js can capture
 * it once, right when the verdict is finalized, and pass it back in as
 * `expectedHash` for the gate to independently recompute and compare.
 */
function computeVerdictHash({ serviceId, verdict, tier }) {
  return "0x" + crypto
    .createHash("sha256")
    .update(JSON.stringify({
      serviceId,
      verdict:       verdict.verdict,
      should_slash:  verdict.should_slash,
      tier,
      classification: classificationOf(verdict),
    }))
    .digest("hex");
}

/**
 * Run all five checks. Throws SlashGateError on the first failure (after
 * awaiting the failure's audit-log write); returns { serviceId,
 * verdictHash, route, previewAmount, wouldEscalate } on success.
 *
 * @param {object} params
 * @param {string} params.agentAddress     Address about to be slashed
 * @param {string} params.consumerAddress  Address slash proceeds are intended for
 * @param {object} params.oracleResponse   The raw oracle response this verdict was adjudicated over
 * @param {object} params.verdict          The finalized verdict object (either tier)
 * @param {string} params.expectedHash     Hash captured by the caller at verdict-finalization time
 * @returns {Promise<{serviceId: string, verdictHash: string, route: "instant"|"dispute", previewAmount: bigint, wouldEscalate: boolean}>}
 */
async function gateSlash({ agentAddress, consumerAddress, oracleResponse, verdict, expectedHash }) {
  const serviceId = serviceIdFor(oracleResponse);
  const tier = verdict.tier ?? "semantic";

  const fail = async (reason) => {
    logFailure({ serviceId, stage: "slash-gate", agent: agentAddress, reason });
    await writeAuditRecord({
      agent: agentAddress, payee: consumerAddress, verdictHash: expectedHash ?? null,
      serviceId, outcome: "gated", reason,
    });
    throw new SlashGateError(reason);
  };

  // 1. PAYEE
  if (!consumerAddress || consumerAddress.toLowerCase() !== config.CONSUMER_WALLET_ADDRESS.toLowerCase()) {
    await fail(`payee ${consumerAddress} does not match the known consumer wallet ${config.CONSUMER_WALLET_ADDRESS}`);
  }

  // 2. TARGET
  if (!agentAddress || agentAddress.toLowerCase() !== config.ORACLE_WALLET_ADDRESS.toLowerCase()) {
    await fail(`target ${agentAddress} does not match the known oracle wallet ${config.ORACLE_WALLET_ADDRESS}`);
  }
  if (!oracleResponse.oracle || oracleResponse.oracle.toLowerCase() !== agentAddress.toLowerCase()) {
    await fail(`response.oracle ${oracleResponse.oracle} does not match the agent being slashed ${agentAddress} — this response was not produced by the agent this slash targets`);
  }

  // 3. BREACH CLASSIFICATION (partial — see module docs re: Phase 4 dependency)
  if ("amount" in verdict) {
    await fail(`verdict carries an externally-asserted amount field, which is never authorized — slash amount is not model-determined`);
  }
  if (tier === "semantic" && verdict.breach_class !== "semantic") {
    await fail(`tier is "semantic" but verdict.breach_class is "${verdict.breach_class}" — tier-tracking signals disagree`);
  }
  if (tier === "deterministic" && !verdict.code) {
    await fail(`tier is "deterministic" but verdict carries no machine code — tier-tracking signals disagree`);
  }

  // 4. VERDICT-HASH BINDING
  const recomputedHash = computeVerdictHash({ serviceId, verdict, tier });
  if (expectedHash && recomputedHash !== expectedHash) {
    await fail(`verdict hash mismatch — recomputed ${recomputedHash} vs expected ${expectedHash}; the verdict being acted on is not the one adjudicated for this interaction`);
  }

  // 5. ROUTING (Phase 6.2 — see module docs above)
  let routing;
  try {
    routing = await determineRoute({ agentAddress, tier });
  } catch (err) {
    await fail(`unable to determine on-chain slash routing (challengeThreshold/previewSlash read failed): ${err.message}`);
  }

  return {
    serviceId,
    verdictHash:   recomputedHash,
    route:         routing.route,
    previewAmount: routing.previewAmount ?? null,
    wouldEscalate: routing.wouldEscalate ?? false,
  };
}

module.exports = { gateSlash, computeVerdictHash, SlashGateError };
