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
 *
 * Phase 6 (post-submission — see CHANGELOG.md): when config.SESSION_GUARD_ADDRESS
 * is set, the on-chain audit call routes through
 * ConsumerSessionKeyGuard.guardedRecordSettlement() instead of ArcIDBond
 * directly — same amount-cap/expiry/fixed-payout protections slasher.js gets.
 *
 * Phase 7 (post-submission — see CHANGELOG.md): every payee/amount pair that
 * reaches a real fund movement or on-chain write passes through
 * paymentGate.js first — a deterministic, non-LLM check independent of
 * anything the verdict or the oracle response claims.
 *
 * Phase 8 (post-submission — see CHANGELOG.md): per-call caps (Phase 6/7)
 * don't catch a consumer stuck in a retry/re-adjudication loop firing many
 * small, individually-legitimate payments — each one passes its own cap
 * check, but the total drains the budget. Before any settlement (real or
 * simulated), checkCircuitBreaker() sums this same ledger's spend over
 * rolling 1-minute/1-hour windows; if adding this call would cross either
 * threshold, it trips a persisted breaker flag in the ledger and refuses —
 * every subsequent call stays refused until a manual
 * `npm run breaker:resume` (in consumer/). No auto-recovery.
 *
 * Phase 9 (post-submission — see CHANGELOG.md): every exit path below —
 * settled, gated, circuit-breaker-blocked, payment-failed, on-chain-write-
 * failed, or deduped — writes one attributableRecord via auditTrail.js, so
 * "what happened to this clean verdict's payment" has a single, uniformly-
 * shaped answer regardless of which path it took.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const config = require("./config");
const { gateGatewayPayment, gateOnChainRecord, PaymentGateError, PRICE_ATOMIC } = require("./paymentGate");
const { writeAuditRecord } = require("./auditTrail");
const { serviceIdFor } = require("./serviceId");

const LEDGER_PATH      = path.join(path.resolve(config.LOG_DIR), "settlement_ledger.json");
const FAILURE_LOG_PATH = path.join(path.resolve(config.LOG_DIR), "settlement_failures.jsonl");
const ALERT_LOG_PATH   = path.join(path.resolve(config.LOG_DIR), "circuit_breaker_alerts.jsonl");

// Reserved ledger key for circuit-breaker state — namespaced with a leading
// underscore so it can never collide with a `serviceId:verdictHash` dedupe key.
const BREAKER_KEY = "_circuitBreaker";
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS   = 60 * ONE_MINUTE_MS;

const MAX_PER_MINUTE_ATOMIC = BigInt(Math.round(parseFloat(config.MAX_SPEND_PER_MINUTE_USDC) * 1e6));
const MAX_PER_HOUR_ATOMIC   = BigInt(Math.round(parseFloat(config.MAX_SPEND_PER_HOUR_USDC) * 1e6));

const BOND_ABI = [
  "function recordSettlement(address agent, address consumer, uint256 amount, bytes32 verdictHash) external",
];

const GUARD_ABI = [
  "function guardedRecordSettlement(address agent, uint256 amount, bytes32 verdictHash) external",
];

function getBondContract(signerOrProvider) {
  return new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ABI, signerOrProvider);
}

function getGuardContract(signerOrProvider) {
  return new ethers.Contract(config.SESSION_GUARD_ADDRESS, GUARD_ABI, signerOrProvider);
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

function logAlert(record) {
  fs.mkdirSync(path.dirname(ALERT_LOG_PATH), { recursive: true });
  fs.appendFileSync(ALERT_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

// Sums settled amounts (real or simulated — both represent real spend
// intent) recorded in `ledger` within the last `windowMs`. Skips the
// reserved breaker-state entry.
function rollingSpend(ledger, windowMs, now = Date.now()) {
  let total = 0n;
  for (const [key, entry] of Object.entries(ledger)) {
    if (key === BREAKER_KEY) continue;
    if (!entry || entry.amount == null) continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at) || now - at > windowMs) continue;
    total += BigInt(entry.amount);
  }
  return total;
}

// Pre-check: would adding `incomingAmount` push rolling spend over either
// window's cap? If the breaker is already tripped, refuse immediately
// without recomputing. Otherwise trips (and persists) on first crossing.
function checkCircuitBreaker(ledger, incomingAmount) {
  const existing = ledger[BREAKER_KEY];
  if (existing && existing.tripped) {
    return { tripped: true, reason: existing.reason, trippedAt: existing.trippedAt, alreadyTripped: true };
  }

  const now = Date.now();
  const projectedPerMinute = rollingSpend(ledger, ONE_MINUTE_MS, now) + incomingAmount;
  const projectedPerHour   = rollingSpend(ledger, ONE_HOUR_MS,   now) + incomingAmount;

  let reason = null;
  if (projectedPerMinute > MAX_PER_MINUTE_ATOMIC) {
    reason = `projected 1-minute spend ${projectedPerMinute} exceeds cap ${MAX_PER_MINUTE_ATOMIC} (${config.MAX_SPEND_PER_MINUTE_USDC} USDC)`;
  } else if (projectedPerHour > MAX_PER_HOUR_ATOMIC) {
    reason = `projected 1-hour spend ${projectedPerHour} exceeds cap ${MAX_PER_HOUR_ATOMIC} (${config.MAX_SPEND_PER_HOUR_USDC} USDC)`;
  }

  if (!reason) return { tripped: false };

  const trippedAt = new Date().toISOString();
  ledger[BREAKER_KEY] = { tripped: true, reason, trippedAt };
  saveLedger(ledger);
  logAlert({ event: "circuit-breaker-tripped", reason, trippedAt });
  return { tripped: true, reason, trippedAt };
}

/**
 * Current breaker status + rolling spend, without side effects.
 */
function getCircuitBreakerStatus() {
  const ledger = loadLedger();
  const breaker = ledger[BREAKER_KEY] || { tripped: false };
  const now = Date.now();
  return {
    tripped:          !!breaker.tripped,
    detail:           breaker,
    spendLastMinute:  rollingSpend(ledger, ONE_MINUTE_MS, now).toString(),
    spendLastHour:    rollingSpend(ledger, ONE_HOUR_MS, now).toString(),
    capPerMinute:     MAX_PER_MINUTE_ATOMIC.toString(),
    capPerHour:       MAX_PER_HOUR_ATOMIC.toString(),
  };
}

/**
 * Manually clear a tripped breaker. There is no automatic path to this —
 * by design, per Phase 8: a human has to look and decide it's safe to
 * continue.
 */
function resumeCircuitBreaker(reason = "manual resume") {
  const ledger = loadLedger();
  const prior = ledger[BREAKER_KEY];
  if (!prior || !prior.tripped) {
    return { resumed: false, message: "circuit breaker was not tripped" };
  }
  const resumedAt = new Date().toISOString();
  ledger[BREAKER_KEY] = { tripped: false, resumedAt, resumeReason: reason, priorTrip: prior };
  saveLedger(ledger);
  logAlert({ event: "circuit-breaker-resumed", resumedAt, resumeReason: reason, priorTrip: prior });
  return { resumed: true, priorTrip: prior };
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

  if (config.SESSION_GUARD_ADDRESS) {
    const guard   = getGuardContract(signer);
    const tx      = await guard.guardedRecordSettlement(agent, amount, hash);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  const bond    = getBondContract(signer);
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
 * @returns {Promise<{settled:boolean, simulated?:boolean, txHash?:string|null, onChainTx?:string|null, amount?:string|null, skipped?:string, error?:string, circuitBreakerTripped?:boolean, reason?:string}>}
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
    const prior = ledger[dedupeKey];
    await writeAuditRecord({
      agent: config.ORACLE_WALLET_ADDRESS, payee: config.CONSUMER_WALLET_ADDRESS,
      verdictHash: hash, serviceId, amount: prior.amount, txHash: prior.txHash, onChainTx: prior.onChainTx,
      simulated: prior.simulated, outcome: "deduped", reason: "already settled for this service interaction",
    });
    return { settled: false, skipped: "already settled for this service interaction", ...prior };
  }

  const breakerCheck = checkCircuitBreaker(ledger, PRICE_ATOMIC);
  if (breakerCheck.tripped) {
    console.error(`\n  🛑 CIRCUIT BREAKER TRIPPED — settlement halted.`);
    console.error(`     ${breakerCheck.reason || "(previously tripped)"}`);
    console.error(`     Resume manually: npm run breaker:resume (in consumer/)\n`);
    const reason = breakerCheck.reason ?? "circuit breaker is tripped";
    await writeAuditRecord({
      agent: config.ORACLE_WALLET_ADDRESS, payee: config.CONSUMER_WALLET_ADDRESS,
      verdictHash: hash, serviceId, outcome: "circuit_breaker", reason,
    });
    return { settled: false, circuitBreakerTripped: true, reason };
  }

  if (config.DEV_MODE) {
    console.log(`  [settlement] DEV_MODE — simulated settlement`);
    console.log(`  [settlement] service: ${serviceId.slice(0, 24)}...`);
    // Notional amount, not moved — lets the circuit breaker's rolling spend
    // math be exercised (and demoed) without a funded testnet wallet.
    const result = { settled: true, simulated: true, txHash: null, onChainTx: null, amount: PRICE_ATOMIC.toString() };
    ledger[dedupeKey] = { ...result, at: new Date().toISOString() };
    saveLedger(ledger);
    await writeAuditRecord({
      agent: config.ORACLE_WALLET_ADDRESS, payee: config.CONSUMER_WALLET_ADDRESS,
      verdictHash: hash, serviceId, amount: result.amount, simulated: true,
      outcome: "settled", reason: "DEV_MODE simulated settlement",
    });
    return result;
  }

  let amount, transaction;
  try {
    const { GatewayClient } = require("@circle-fin/x402-batching/client");
    const client = new GatewayClient({ chain: "arcTestnet", privateKey: config.CONSUMER_PRIVATE_KEY })
      .onBeforePaymentCreation(gateGatewayPayment);

    const priceUrl = `${config.ORACLE_URL}/api/price`;
    ({ amount, transaction } = await client.pay(priceUrl));
  } catch (err) {
    const gated = err instanceof PaymentGateError;
    const stage = gated ? "payment-gate" : "gateway-payment";
    logFailure({ serviceId, verdictHash: hash, stage, error: err.message });
    await writeAuditRecord({
      agent: config.ORACLE_WALLET_ADDRESS, payee: config.CONSUMER_WALLET_ADDRESS,
      verdictHash: hash, serviceId, outcome: gated ? "gated" : "payment_failed", reason: err.message,
    });
    return { settled: false, error: err.message };
  }

  // Payment already moved funds — a failure here is an audit-log gap, not a
  // failed settlement, so it's logged distinctly rather than flipping
  // `settled` back to false. A payment-gate rejection at this step means the
  // amount actually paid diverged from the agreed price somewhere between
  // payment and this call — refuse the on-chain write and flag it loudly.
  let onChainTx = null;
  let onChainOutcome = "settled";
  let onChainReason = null;
  try {
    gateOnChainRecord({ agent: config.ORACLE_WALLET_ADDRESS, amount: amount ?? 0n });
    onChainTx = await recordSettlementOnChain({
      agent:    config.ORACLE_WALLET_ADDRESS,
      consumer: config.CONSUMER_WALLET_ADDRESS,
      amount:   amount ?? 0n,
      hash,
    });
  } catch (err) {
    const gated = err instanceof PaymentGateError;
    const stage = gated ? "payment-gate" : "on-chain-audit";
    logFailure({ serviceId, verdictHash: hash, stage, gatewayTx: transaction, error: err.message });
    onChainOutcome = gated ? "gated" : "onchain_failed";
    onChainReason  = err.message;
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
  await writeAuditRecord({
    agent: config.ORACLE_WALLET_ADDRESS, payee: config.CONSUMER_WALLET_ADDRESS,
    verdictHash: hash, serviceId, amount: result.amount, txHash: result.txHash, onChainTx: result.onChainTx,
    simulated: false, outcome: onChainOutcome,
    reason: onChainReason ?? "Gateway payment settled + on-chain audit record written",
  });
  return result;
}

module.exports = { executeSettlement, getCircuitBreakerStatus, resumeCircuitBreaker };
