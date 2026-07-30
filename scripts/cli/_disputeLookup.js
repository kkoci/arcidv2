"use strict";
/**
 * _disputeLookup.js — Shared off-chain rationale lookup for dispute-list.js
 * and dispute-resolve.js (Phase 6.3, post-submission — see CHANGELOG.md).
 *
 * ArcIDBond only stores `rationaleHash` on-chain (see fileIndictment() in
 * ArcIDBond.sol) — the full Claude rationale + evidence[] never goes
 * on-chain, same reasoning as PaymentSettled's verdictHash. The one place
 * the full text survives is the consumer agent's own per-cycle log
 * (consumer/logs/*.jsonl), which slasher.js (Phase 6.2) tags with
 * `dispute_id` on every successful fileIndictment() call. This scans those
 * logs for the matching record — a best-effort local lookup, not a
 * guarantee: logs rotated away, run on a different machine, or simply
 * never written locally will come up empty, and callers must handle that
 * (verify the on-chain rationaleHash independently) rather than assume it.
 */

const fs   = require("fs");
const path = require("path");

const DISPUTE_STATE = ["None", "Indicted", "Resolved"];

const CONSUMER_LOG_DIR = path.join(__dirname, "..", "..", "consumer", "logs");

/**
 * @param {string|number|bigint} disputeId
 * @returns {object|null} the matching per-cycle log record, or null if not found locally
 */
function findOffChainRecord(disputeId) {
  if (!fs.existsSync(CONSUMER_LOG_DIR)) return null;
  const target = String(disputeId);

  const files = fs.readdirSync(CONSUMER_LOG_DIR).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    const lines = fs
      .readFileSync(path.join(CONSUMER_LOG_DIR, file), "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // tolerate a malformed/partial line rather than aborting the whole scan
      }
      if (rec.dispute_id === target) return rec;
    }
  }
  return null;
}

module.exports = { findOffChainRecord, DISPUTE_STATE };
