/**
 * deterministicVerifier.js — Tier 1 of tiered adjudication (post-submission,
 * tiered-adjudication scoping doc, Phase 1 — see CHANGELOG.md).
 *
 * Everything mechanically checkable about an oracle response stops being
 * Claude's job. This module runs on every response BEFORE any adjudicator
 * call and produces a binary verdict: `hard_breach` (short-circuits straight
 * to slash — Claude is never invoked) or `pass` (hands off to Tier 2, the
 * LLM semantic tier — unchanged for now; a later phase narrows what Claude
 * sees and is allowed to decide).
 *
 * Checks, all pure/mechanical, no judgment call involved:
 *   - signature_valid      — reuses verifier.js's verifyOracleSignature();
 *                             this module never re-implements signature
 *                             recovery, just interprets its result.
 *   - timestamp_fresh      — response age <= sla.max_age_seconds. Integer
 *                             comparison.
 *   - schema_valid         — response has the fields/types the protocol
 *                             expects (value present & numeric-parseable,
 *                             timestamp a number, oracle an address-shaped
 *                             string, sla.max_age_seconds a number).
 *   - attestation_current  — OPTIONAL (only when config.REGISTRY_ADDRESS is
 *                             set): the oracle wallet still resolves to a
 *                             non-zero agentId in ArcIDRegistryV2.
 *                             HONEST LIMITATION: ArcIDRegistryV2 has no
 *                             expiry or deregistration concept today —
 *                             registration is permanent once made (see
 *                             contracts/ArcIDRegistryV2.sol). "Currency"
 *                             here means "still resolves to a registered
 *                             agentId right now," the closest real check
 *                             the current contract supports — not a true
 *                             lapse/expiry check. A genuine expiry
 *                             mechanism would need a registry contract
 *                             change; out of scope here. When
 *                             REGISTRY_ADDRESS is unset this check is
 *                             skipped (`null`) and never affects the verdict.
 *
 * NOTE ON BEHAVIOR CHANGE: the pre-tiering system asked Claude to show
 * "restraint" on the null/malformed-response fault (verdict: uncertain, no
 * slash) as a deliberate demonstration of adjudicator judgment — see
 * SUBMISSION.md Beat 3 and the Phase 3 README section. Under this tier, a
 * null signature and a null value are both mechanically-checkable facts
 * (signature_valid: false, schema_valid: false) — the "was this malice or a
 * blip" question that used to route to Claude for is now the epoch-
 * escalation problem (a later phase of the tiered-adjudication doc), not a
 * per-incident LLM judgment call. This is an intentional narrative change,
 * not a regression: the "null" fault mode now hard-breaches instantly, with
 * no LLM call in the trace at all — which is the literal demo point of this
 * redesign.
 */

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { verifyOracleSignature } = require("./verifier");
const config = require("./config");

const LOG_PATH = path.join(path.resolve(config.LOG_DIR), "deterministic_breaches.jsonl");
const REGISTRY_ABI = ["function agentIdBySigner(address) view returns (bytes32)"];

let cachedAttestationCurrent; // resolved at most once per process — mirrors auditTrail.js's agentId cache

async function checkAttestationCurrent(oracleAddress) {
  if (!config.REGISTRY_ADDRESS) return null; // not configured — skipped, never affects the verdict
  if (cachedAttestationCurrent !== undefined) return cachedAttestationCurrent;
  try {
    const provider = config.getProvider();
    const registry = new ethers.Contract(config.REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    const id = await registry.agentIdBySigner(oracleAddress);
    return (cachedAttestationCurrent = id !== ethers.ZeroHash);
  } catch {
    return null; // an RPC hiccup must not itself become a hard breach
  }
}

function checkSchema(response) {
  const problems = [];
  if (typeof response.timestamp !== "number") problems.push("timestamp is not a number");
  if (typeof response.oracle !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(response.oracle)) {
    problems.push("oracle is not a well-formed address");
  }
  if (!response.sla || typeof response.sla.max_age_seconds !== "number") {
    problems.push("sla.max_age_seconds is missing or not a number");
  }
  const valuePresent = response.value !== null && response.value !== undefined && response.value !== "";
  if (!valuePresent) {
    problems.push("value is null/undefined/empty");
  } else if (Number.isNaN(Number(response.value))) {
    problems.push("value is not numeric-parseable");
  }
  return { valid: problems.length === 0, problems };
}

/**
 * @param {object} opts
 * @param {object} opts.response    Raw oracle response {value, timestamp, oracle, signature, sla}
 * @param {number} opts.ageSeconds  Response age in seconds (computed once by the caller)
 * @returns {Promise<{verdict:"hard_breach"|"pass", code:string|null, reason:string|null, checks:object, sigResult:object}>}
 */
async function verifyDeterministic({ response, ageSeconds }) {
  const sigResult = verifyOracleSignature(
    response.value,
    response.timestamp,
    config.ORACLE_WALLET_ADDRESS,
    response.signature
  );

  const maxAge = response.sla?.max_age_seconds ?? 30;
  const timestampFresh = typeof response.timestamp === "number" ? ageSeconds <= maxAge : false;

  const schema = checkSchema(response);
  const attestationCurrent = await checkAttestationCurrent(config.ORACLE_WALLET_ADDRESS);

  const checks = {
    signature_valid:     sigResult.valid,
    timestamp_fresh:     timestampFresh,
    schema_valid:        schema.valid,
    attestation_current: attestationCurrent, // null = not checked (REGISTRY_ADDRESS unset)
  };

  let code = null;
  if (!checks.signature_valid)                    code = "SIG_INVALID";
  else if (!checks.timestamp_fresh)                code = "TIMESTAMP_STALE";
  else if (!checks.schema_valid)                   code = "SCHEMA_FAIL";
  else if (checks.attestation_current === false)   code = "ATTESTATION_LAPSED";

  if (!code) {
    return { verdict: "pass", code: null, reason: null, checks, sigResult };
  }

  const detail = {
    SIG_INVALID:        sigResult.error || "signature does not recover to the registered oracle wallet",
    TIMESTAMP_STALE:    `response age ${ageSeconds}s exceeds SLA max_age_seconds ${maxAge}`,
    SCHEMA_FAIL:         schema.problems.join("; "),
    ATTESTATION_LAPSED:  `oracle wallet ${config.ORACLE_WALLET_ADDRESS} does not resolve to a registered agentId in ArcIDRegistryV2`,
  }[code];

  return { verdict: "hard_breach", code, reason: `[${code}] ${detail}`, checks, sigResult };
}

// Own logging channel, per the project's existing rule that failure/breach
// classes don't get merged into each other's logs (see settlement.js's
// logFailure()/logAlert() and CHANGELOG.md's Phase 2.4/8 entries).
function logHardBreach(record) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

module.exports = { verifyDeterministic, logHardBreach };
