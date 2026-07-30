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
 *   3. BREACH CLASSIFICATION — HONEST LIMITATION, stated up front: Phase 4
 *      of the tiered-adjudication doc (not yet shipped) is what makes
 *      slash amounts proportional to breach class via an on-chain formula.
 *      ArcIDBond.slash() today still transfers the full bond
 *      unconditionally and has no amount or breachClass parameter to
 *      validate against — there is no formula yet to recompute and match.
 *      Until Phase 4 lands, this check validates the closest real
 *      invariant available: the verdict carries no externally-asserted
 *      amount at all (true by schema construction for both tiers — neither
 *      deterministicVerifier.js's hard-breach result nor adjudicator.js's
 *      deliver_verdict schema has an amount field), and the two
 *      independent tier-tracking signals — the caller's own `tier` value
 *      and, for semantic verdicts, Claude's own `breach_class` field —
 *      agree with each other. Once Phase 4 ships a real formula and an
 *      amount-accepting slash() signature, this check upgrades to
 *      recompute and match that formula's output; it does not do that yet
 *      and does not pretend to.
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
const config = require("./config");
const { serviceIdFor } = require("./serviceId");
const { writeAuditRecord } = require("./auditTrail");

const FAILURE_LOG_PATH = path.join(path.resolve(config.LOG_DIR), "slash_failures.jsonl");

class SlashGateError extends Error {}

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
 * Run all four checks. Throws SlashGateError on the first failure (after
 * awaiting the failure's audit-log write); returns { serviceId,
 * verdictHash } on success.
 *
 * @param {object} params
 * @param {string} params.agentAddress     Address about to be slashed
 * @param {string} params.consumerAddress  Address slash proceeds are intended for
 * @param {object} params.oracleResponse   The raw oracle response this verdict was adjudicated over
 * @param {object} params.verdict          The finalized verdict object (either tier)
 * @param {string} params.expectedHash     Hash captured by the caller at verdict-finalization time
 * @returns {Promise<{serviceId: string, verdictHash: string}>}
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

  return { serviceId, verdictHash: recomputedHash };
}

module.exports = { gateSlash, computeVerdictHash, SlashGateError };
