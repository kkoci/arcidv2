/**
 * auditTrail.js — Attributable audit record for every settlement attempt
 * (Phase 9, post-submission — see CHANGELOG.md).
 *
 * Why: ArcIDBond.slash() already gives the breach path a first-class,
 * queryable record — the AgentSlashed event with Claude's rationale
 * attached. Before this, the payment path's provenance was scattered across
 * three separate files (settlement_ledger.json, settlement_failures.jsonl,
 * circuit_breaker_alerts.jsonl), each covering only one class of outcome,
 * with no single record per attempt and no link back to the TEE-attested
 * agent identity. That's "the agent paid, trust us," not the standard the
 * slash flow meets.
 *
 * writeAuditRecord() is called from every exit path of
 * settlement.js's executeSettlement() — settled (real or simulated), gated
 * (Phase 7), circuit-breaker-blocked (Phase 8), payment-failed,
 * on-chain-write-failed, or deduped — each producing exactly one line in
 * settlement_audit.jsonl with the same fixed schema, so "what happened to
 * this clean verdict's payment" is answerable from one file without knowing
 * which of the class-specific logs to check.
 *
 * This does not replace those class-specific logs — they remain the
 * detailed record for their own failure class, per this project's existing
 * rule that failure classes don't get merged (Phase 2.4). This is the flat,
 * uniform index across all of them.
 */

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("./config");

const AUDIT_LOG_PATH = path.join(path.resolve(config.LOG_DIR), "settlement_audit.jsonl");

const REGISTRY_ABI = ["function agentIdBySigner(address) view returns (bytes32)"];

let cachedAgentId; // resolved at most once per process — the oracle wallet doesn't change mid-run

/**
 * Resolve the oracle wallet's on-chain agentId (bytes32) from
 * ArcIDRegistryV2, if config.REGISTRY_ADDRESS is set. Read-only, free (view
 * call), cached after the first resolution. Returns null if unset,
 * unregistered, or unresolvable — the audit record still gets written with
 * the raw wallet address either way; this is enrichment, not a dependency.
 */
async function resolveAgentId(agentAddress) {
  if (cachedAgentId !== undefined) return cachedAgentId;
  if (!config.REGISTRY_ADDRESS) return (cachedAgentId = null);
  try {
    const provider = config.getProvider();
    const registry = new ethers.Contract(config.REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    const id = await registry.agentIdBySigner(agentAddress);
    return (cachedAgentId = id === ethers.ZeroHash ? null : id);
  } catch {
    return null; // do not cache a transient RPC failure as "unregistered"
  }
}

/**
 * Write one attributable audit record. Never throws — a failure to WRITE
 * the audit record must never mask or block the settlement outcome it
 * describes; on error it logs a console warning and returns null.
 *
 * @param {object} params
 * @param {string} params.agent        Oracle wallet — the party the settlement is FOR
 * @param {string|null} [params.payee] Address proceeds/credit were intended to go to
 * @param {string} params.verdictHash  bytes32 hash of the verdict outcome this was authorized under
 * @param {string|null} [params.amount]    Atomic-unit amount (string), or null if never determined
 * @param {string|null} [params.txHash]    Gateway payment tx hash, if the payment itself went through
 * @param {string|null} [params.onChainTx] recordSettlement()/guardedRecordSettlement() tx hash, if written
 * @param {"settled"|"gated"|"circuit_breaker"|"payment_failed"|"onchain_failed"|"deduped"} params.outcome
 * @param {string} [params.reason]     Human-readable explanation
 * @param {string} params.serviceId    Ties back to the exact oracle interaction
 * @param {boolean} [params.simulated] True for DEV_MODE runs — no real funds moved
 */
async function writeAuditRecord(params) {
  try {
    const agentId = await resolveAgentId(params.agent);
    const record = {
      at:          new Date().toISOString(),
      agentId:     agentId,
      agent:       params.agent,
      payee:       params.payee ?? null,
      verdictHash: params.verdictHash,
      serviceId:   params.serviceId,
      amount:      params.amount ?? null,
      txHash:      params.txHash ?? null,
      onChainTx:   params.onChainTx ?? null,
      simulated:   !!params.simulated,
      outcome:     params.outcome,
      reason:      params.reason ?? null,
    };
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + "\n");
    return record;
  } catch (err) {
    console.error(`  [audit] WARNING: failed to write audit record: ${err.message}`);
    return null;
  }
}

module.exports = { writeAuditRecord };
