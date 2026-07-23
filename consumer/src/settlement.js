/**
 * settlement.js — Real Gateway settlement fired from the consumer agent's
 * post-verdict handler, on a clean (non-breach) verdict only.
 *
 * Reuses the exact GatewayClient.pay() integration already proven in
 * oracle/src/chain.js's payForPriceViaGateway() — same buyer wallet
 * (CONSUMER_PRIVATE_KEY), same target route (/api/price). This module only
 * decides WHEN to call it: after adjudication confirms clean delivery, not
 * before — the oracle/TEE side never triggers its own payment.
 *
 * In DEV_MODE=true: logs a simulated settlement without moving funds (no
 * Gateway account needed locally), mirroring slasher.js's dev-mode pattern.
 * In production:    sends a real Gateway payment to Arc testnet.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const config = require("./config");

const LEDGER_PATH      = path.join(path.resolve(config.LOG_DIR), "settlement_ledger.json");
const FAILURE_LOG_PATH = path.join(path.resolve(config.LOG_DIR), "settlement_failures.jsonl");

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

// Identifies the exact service interaction being paid for — the oracle's own
// signature over (value, timestamp). Stable across a retried verdict-handler
// invocation for the same response, distinct across any two different
// oracle responses.
function serviceIdFor(oracleResponse) {
  return oracleResponse.signature || `${oracleResponse.value}:${oracleResponse.timestamp}`;
}

// Hashes only the verdict OUTCOME (verdict + should_slash), not the LLM's
// free-text rationale — wording can vary between calls even when the
// underlying judgment is identical, and the dedupe key must not be sensitive
// to that.
function verdictHash(verdict) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ verdict: verdict.verdict, should_slash: verdict.should_slash }))
    .digest("hex")
    .slice(0, 16);
}

function logFailure(record) {
  fs.mkdirSync(path.dirname(FAILURE_LOG_PATH), { recursive: true });
  // Payment failure is a distinct failure class from an SLA breach — logged
  // to its own file so it can never be mistaken for (or corrupt) the slash
  // audit trail.
  fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

/**
 * Execute Gateway settlement for a clean verdict.
 *
 * No-op for anything other than verdict.verdict === "ok" — settlement is the
 * reward path for confirmed delivery, never a default action.
 *
 * @param {object} params
 * @param {object} params.oracleResponse  The raw oracle response this verdict was adjudicated over
 * @param {object} params.verdict         The adjudicator's verdict object
 * @returns {Promise<{settled:boolean, simulated?:boolean, txHash?:string|null, amount?:string|null, skipped?:string, error?:string}>}
 */
async function executeSettlement({ oracleResponse, verdict }) {
  if (verdict.verdict !== "ok") {
    return { settled: false, skipped: "verdict not clean" };
  }

  const serviceId = serviceIdFor(oracleResponse);
  const hash      = verdictHash(verdict);
  const dedupeKey = `${serviceId}:${hash}`;

  const ledger = loadLedger();
  if (ledger[dedupeKey]) {
    return { settled: false, skipped: "already settled for this service interaction", ...ledger[dedupeKey] };
  }

  if (config.DEV_MODE) {
    console.log(`  [settlement] DEV_MODE — simulated settlement`);
    console.log(`  [settlement] service: ${serviceId.slice(0, 24)}...`);
    const result = { settled: true, simulated: true, txHash: null, amount: null };
    ledger[dedupeKey] = { ...result, at: new Date().toISOString() };
    saveLedger(ledger);
    return result;
  }

  try {
    const { GatewayClient } = require("@circle-fin/x402-batching/client");
    const client = new GatewayClient({ chain: "arcTestnet", privateKey: config.CONSUMER_PRIVATE_KEY });

    const priceUrl = `${config.ORACLE_URL}/api/price`;
    const { amount, transaction } = await client.pay(priceUrl);

    const result = {
      settled:   true,
      simulated: false,
      txHash:    transaction,
      amount:    amount != null ? String(amount) : null,
    };
    ledger[dedupeKey] = { ...result, at: new Date().toISOString() };
    saveLedger(ledger);
    return result;
  } catch (err) {
    logFailure({ serviceId, verdictHash: hash, error: err.message });
    return { settled: false, error: err.message };
  }
}

module.exports = { executeSettlement };
