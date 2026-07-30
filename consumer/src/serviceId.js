/**
 * serviceId.js — Identifies the exact service interaction an oracle
 * response belongs to: the oracle's own signature over (value, timestamp).
 * Stable across a retried handler invocation for the same response,
 * distinct across any two different oracle responses.
 *
 * Extracted out of settlement.js (Phase 2/8) so slashGate.js (Phase 3,
 * tiered-adjudication doc — post-submission, see CHANGELOG.md) can use the
 * identical definition rather than a second copy that could drift from it.
 */
function serviceIdFor(oracleResponse) {
  return oracleResponse.signature || `${oracleResponse.value}:${oracleResponse.timestamp}`;
}

module.exports = { serviceIdFor };
