/**
 * oracle.js — x402-aware oracle client.
 *
 * Flow:
 *   1. GET /api/price → 402 with payment options
 *   2. In DEV_MODE: send any X-Payment header value (oracle accepts it).
 *      In production: pay via Circle Gateway and include the receipt.
 *   3. GET /api/price with X-Payment → 200 with {value, timestamp, oracle, signature, sla}
 *
 * Throws on non-200/402 status codes or network errors.
 */

const config = require("./config");

const PAYMENT_AMOUNT_USDC = 0.001; // $0.001 per call

/**
 * Fetch a signed price from the oracle, paying via x402.
 * @returns {{ response: object, paymentAmount: number }}
 */
async function fetchOraclePrice(faultMode = null) {
  const url = faultMode
    ? `${config.ORACLE_URL}/api/price?fault=${faultMode}`
    : `${config.ORACLE_URL}/api/price`;

  // --- First attempt: expect 402 ---
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Oracle unreachable at ${url}: ${err.message}`);
  }

  if (res.status === 200) {
    // Already paid (shouldn't happen on first call, but handle gracefully)
    const body = await res.json();
    return { response: body, paymentAmount: 0 };
  }

  if (res.status !== 402) {
    throw new Error(`Oracle returned unexpected status ${res.status}`);
  }

  // Parse payment requirements from 402 body
  const paymentOptions = await res.json();

  // --- Pay and retry ---
  const paymentHeader = await buildPaymentHeader(paymentOptions);

  const paidRes = await fetch(url, {
    headers: { "X-Payment": paymentHeader },
  });

  if (!paidRes.ok) {
    const body = await paidRes.text();
    throw new Error(`Oracle rejected payment (${paidRes.status}): ${body}`);
  }

  const body = await paidRes.json();
  return { response: body, paymentAmount: PAYMENT_AMOUNT_USDC };
}

/**
 * Build the X-Payment header value.
 * DEV_MODE: a dev-only stub accepted by the oracle's dev middleware.
 * Production: would call Circle Gateway and return the signed receipt.
 */
async function buildPaymentHeader(paymentOptions) {
  if (config.DEV_MODE) {
    // Dev stub — oracle accepts any non-empty X-Payment in DEV_MODE=true
    return JSON.stringify({
      scheme: "exact",
      network: config.ORACLE_URL.includes("localhost") ? "dev" : "arc-testnet",
      payload: "dev-payment-" + Date.now(),
      payer: config.CONSUMER_WALLET_ADDRESS,
    });
  }

  // Production: implement Circle Gateway payment here.
  // The payment options include the asset, amount, and payTo address.
  // This is where x402-fetch would normally handle everything automatically.
  throw new Error(
    "Production x402 payment not implemented — set DEV_MODE=true for local testing " +
    "or integrate x402-fetch with Circle Gateway for Arc testnet."
  );
}

module.exports = { fetchOraclePrice };
