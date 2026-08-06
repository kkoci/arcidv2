/**
 * oracle.js — x402-aware oracle client.
 *
 * Flow:
 *   DEV_MODE=true:  GET /api/price → 402 → retry with a dev-stub X-Payment
 *                   header (oracle's devX402Middleware accepts any non-empty
 *                   value, no real funds move).
 *   DEV_MODE=false: pay via Circle Gateway (GatewayClient.pay() — same client
 *                   used by settlement.js/oracle chain.js's
 *                   payForPriceViaGateway()) and let it handle the full
 *                   402/PAYMENT-REQUIRED/Payment-Signature handshake.
 *
 * NOTE: which branch runs is decided ONLY by this consumer's own DEV_MODE —
 * not by whether the oracle URL happens to be localhost. A local oracle can
 * (and must, for this branch to work) also run DEV_MODE=false — its
 * /api/price route then serves the real Circle Gateway middleware
 * (see oracle/src/index.js's loadProdX402()), which speaks a completely
 * different protocol (PAYMENT-REQUIRED header + Payment-Signature) than the
 * dev stub's X-Payment header. The two are mutually unintelligible, so both
 * sides must agree on DEV_MODE together, even for local testing.
 *
 * Throws on non-200/402 status codes, network errors, or a failed Gateway payment.
 */

const config = require("./config");

const PAYMENT_AMOUNT_USDC = parseFloat(config.PRICE_USDC);

/**
 * Fetch a signed price from the oracle, paying via x402.
 * @returns {{ response: object, paymentAmount: number }}
 */
async function fetchOraclePrice(faultMode = null) {
  const url = faultMode
    ? `${config.ORACLE_URL}/api/price?fault=${faultMode}`
    : `${config.ORACLE_URL}/api/price`;

  return config.DEV_MODE ? fetchDevMode(url) : fetchViaGateway(url);
}

async function fetchDevMode(url) {
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

  await res.json(); // 402 payment-options body — unused by the dev stub

  const paymentHeader = JSON.stringify({
    scheme:  "exact",
    network: "dev",
    payload: "dev-payment-" + Date.now(),
    payer:   config.CONSUMER_WALLET_ADDRESS,
  });

  const paidRes = await fetch(url, { headers: { "X-Payment": paymentHeader } });
  if (!paidRes.ok) {
    const body = await paidRes.text();
    throw new Error(`Oracle rejected payment (${paidRes.status}): ${body}`);
  }

  const body = await paidRes.json();
  return { response: body, paymentAmount: PAYMENT_AMOUNT_USDC };
}

// Real Circle Gateway Nanopayment — moves real testnet USDC from
// CONSUMER_WALLET_ADDRESS to the oracle's Gateway seller address. Requires
// the consumer's Gateway balance to already be funded/deposited (see
// oracle/src/chain.js's payForPriceViaGateway() for the deposit-if-needed
// pattern — not duplicated here to avoid silently moving funds on every
// cycle; fund/deposit once, ahead of time, instead).
async function fetchViaGateway(url) {
  const { GatewayClient } = require("@circle-fin/x402-batching/client");
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: config.CONSUMER_PRIVATE_KEY });

  let data, amount;
  try {
    ({ data, amount } = await client.pay(url));
  } catch (err) {
    throw new Error(`Gateway payment for oracle fetch failed: ${err.message}`);
  }

  return { response: data, paymentAmount: amount != null ? Number(amount) / 1e6 : 0 };
}

module.exports = { fetchOraclePrice };
