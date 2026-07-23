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
 * After the off-chain Gateway payment settles, this also calls
 * ArcIDBond.recordSettlement() on-chain — the "no breach" counterpart to
 * slasher.js's slash() call, giving the clean path the same event-log
 * auditability the breach path already has. Because recordSettlement()
 * reverts once the agent's bond is slashed (and slash() can't be re-applied
 * to an agent that was already paid out for the same interaction, since
 * bonds are single-use per postBond()), the two outcomes are mutually
 * exclusive on-chain, not just by convention in this file's if/else.
 *
 * In DEV_MODE=true: logs a simulated settlement without moving funds or
 * sending a tx (no RPC needed locally), mirroring slasher.js's dev-mode
 * pattern. In production: sends a real Gateway payment + on-chain audit tx
 * to Arc testnet.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const config = require("./config");

const LEDGER_PATH      = path.join(path.resolve(config.LOG_DIR), "settlement_ledger.json");
const FAILURE_LOG_PATH = path.join(path.resolve(config.LOG_DIR), "settlement_failures.jsonl");

const BOND_ABI = [
  "function recordSettlement(address agent, address consumer, uint256 amount, bytes32 verdictHash) external",
];

function getBondContract(signerOrProvider) {
  return new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ABI, signerOrProvider);
}

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
// to that. Returned as a 0x-prefixed 32-byte hex string so it doubles as the
// bytes32 argument to ArcIDBond.recordSettlement().
function verdictHash(verdict) {
  return "0x" + crypto
    .createHash("sha256")
    .update(JSON.stringify({ verdict: verdict.verdict, should_slash: verdict.should_slash }))
    .digest("hex");
}

function logFailure(record) {
  fs.mkdirSync(path.dirname(FAILURE_LOG_PATH), { recursive: true });
  // Payment failure is a distinct failure class from an SLA breach — logged
  // to its own file so it can never be mistaken for (or corrupt) the slash
  // audit trail.
  fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

async function recordSettlementOnChain({ agent, consumer, amount, hash }) {
  const provider = new ethers.JsonRpcProvider(config.ARC_RPC_URL);
  const signer   = new ethers.Wallet(config.CONSUMER_PRIVATE_KEY, provider);
  const bond     = getBondContract(signer);

  const tx      = await bond.recordSettlement(agent, consumer, amount, hash);
  const receipt = await tx.wait();
  return receipt.hash;
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
 * @returns {Promise<{settled:boolean, simulated?:boolean, txHash?:string|null, onChainTx?:string|null, amount?:string|null, skipped?:string, error?:string}>}
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
    const result = { settled: true, simulated: true, txHash: null, onChainTx: null, amount: null };
    ledger[dedupeKey] = { ...result, at: new Date().toISOString() };
    saveLedger(ledger);
    return result;
  }

  let amount, transaction;
  try {
    const { GatewayClient } = require("@circle-fin/x402-batching/client");
    const client = new GatewayClient({ chain: "arcTestnet", privateKey: config.CONSUMER_PRIVATE_KEY });

    const priceUrl = `${config.ORACLE_URL}/api/price`;
    ({ amount, transaction } = await client.pay(priceUrl));
  } catch (err) {
    logFailure({ serviceId, verdictHash: hash, stage: "gateway-payment", error: err.message });
    return { settled: false, error: err.message };
  }

  // Payment already moved funds — a failure here is an audit-log gap, not a
  // failed settlement, so it's logged distinctly rather than flipping
  // `settled` back to false.
  let onChainTx = null;
  try {
    onChainTx = await recordSettlementOnChain({
      agent:    config.ORACLE_WALLET_ADDRESS,
      consumer: config.CONSUMER_WALLET_ADDRESS,
      amount:   amount ?? 0n,
      hash,
    });
  } catch (err) {
    logFailure({ serviceId, verdictHash: hash, stage: "on-chain-audit", gatewayTx: transaction, error: err.message });
  }

  const result = {
    settled:   true,
    simulated: false,
    txHash:    transaction,
    onChainTx,
    amount:    amount != null ? String(amount) : null,
  };
  ledger[dedupeKey] = { ...result, at: new Date().toISOString() };
  saveLedger(ledger);
  return result;
}

module.exports = { executeSettlement };
