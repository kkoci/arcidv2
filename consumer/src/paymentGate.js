/**
 * paymentGate.js — Deterministic, non-LLM gate between the adjudicator's
 * verdict and any real fund movement (Phase 7, post-submission — see
 * CHANGELOG.md).
 *
 * Why: the verdict is produced by Claude reasoning over untrusted,
 * agent-supplied oracle response content. The adjudicator's tool schema
 * (adjudicator.js's deliver_verdict) has no payee or amount field today —
 * Claude cannot inject one — but that's safety by omission, true only until
 * someone changes the schema or wires a new field through. This gate makes
 * the guarantee explicit and enforced in code: it independently re-derives
 * the payee and amount from config (fixed at process start, never from
 * verdict.* or oracleResponse.* content) and throws/aborts on any mismatch,
 * regardless of what upstream code passes in.
 *
 * Two checkpoints, matching the two places value or state actually moves:
 *
 *   1. gateGatewayPayment() — wired as GatewayClient's onBeforePaymentCreation
 *      hook. Runs BEFORE the buyer signs any payment authorization,
 *      confirming the 402 response's payTo/amount — server-supplied, and
 *      thus untrusted the same way any service response content is —
 *      match the known oracle wallet and agreed price. Returning
 *      `{ abort: true, reason }` here stops GatewayClient.pay() from
 *      signing anything.
 *
 *   2. gateOnChainRecord() — called immediately before
 *      recordSettlement()/guardedRecordSettlement(), re-confirming the
 *      payee and amount about to be written on-chain. Throws (no soft
 *      "continue anyway" path) since this sits directly in front of a
 *      state-changing call.
 *
 * Both checks are cheap, synchronous, and have no LLM or network
 * involvement — they cannot be argued with by anything a model or a
 * counterparty's response says.
 */

const config = require("./config");

const PRICE_ATOMIC = BigInt(Math.round(parseFloat(config.PRICE_USDC) * 1e6));
const CAP_ATOMIC    = BigInt(Math.round(parseFloat(config.MAX_SETTLEMENT_USDC) * 1e6));

class PaymentGateError extends Error {}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * GatewayClient.onBeforePaymentCreation hook. See module docs.
 * @param {{selectedRequirements: {payTo: string, amount: string}}} context
 */
async function gateGatewayPayment({ selectedRequirements }) {
  const payTo  = selectedRequirements.payTo;
  const amount = BigInt(selectedRequirements.amount);

  if (!sameAddress(payTo, config.ORACLE_WALLET_ADDRESS)) {
    return {
      abort: true,
      reason: `payTo ${payTo} does not match the known oracle wallet ${config.ORACLE_WALLET_ADDRESS}`,
    };
  }
  if (amount !== PRICE_ATOMIC) {
    return {
      abort: true,
      reason: `amount ${amount} does not match the agreed price ${PRICE_ATOMIC} (${config.PRICE_USDC} USDC)`,
    };
  }
  if (amount > CAP_ATOMIC) {
    return {
      abort: true,
      reason: `amount ${amount} exceeds the hard per-call cap ${CAP_ATOMIC} (${config.MAX_SETTLEMENT_USDC} USDC)`,
    };
  }
  // no return -> proceed
}

/**
 * Synchronous pre-flight check before recordSettlement() / guardedRecordSettlement().
 * Throws PaymentGateError on any mismatch — callers must not swallow this
 * into the settled-payment success path.
 *
 * @param {object} params
 * @param {string} params.agent  The address about to be credited with the settlement (payee)
 * @param {bigint|string} params.amount  Atomic-unit amount about to be logged on-chain
 */
function gateOnChainRecord({ agent, amount }) {
  if (!sameAddress(agent, config.ORACLE_WALLET_ADDRESS)) {
    throw new PaymentGateError(
      `refusing settlement: agent ${agent} is not the known oracle wallet ${config.ORACLE_WALLET_ADDRESS}`
    );
  }

  const amountBig = BigInt(amount);
  if (amountBig !== PRICE_ATOMIC) {
    throw new PaymentGateError(
      `refusing settlement: amount ${amountBig} does not match the agreed price ${PRICE_ATOMIC} (${config.PRICE_USDC} USDC)`
    );
  }
  if (amountBig > CAP_ATOMIC) {
    throw new PaymentGateError(
      `refusing settlement: amount ${amountBig} exceeds the hard per-call cap ${CAP_ATOMIC} (${config.MAX_SETTLEMENT_USDC} USDC)`
    );
  }
}

module.exports = { gateGatewayPayment, gateOnChainRecord, PaymentGateError, PRICE_ATOMIC, CAP_ATOMIC };
