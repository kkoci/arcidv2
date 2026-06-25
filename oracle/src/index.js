/**
 * ArcID Oracle Service — Phase 2
 *
 * A nanopayment-gated price feed owned by a TEE-attested bonded agent.
 * Every response is signed with the oracle's registered wallet so a wrong
 * answer is cryptographically attributable to a specific verified agent.
 *
 * Endpoints:
 *   GET /health          — always 200, no payment required
 *   GET /api/price       — 402 → pay $0.001 via x402 → signed price response
 *
 * Fault modes (for demo / Phase 3 testing):
 *   GET /api/price?fault=stale    — valid sig, but timestamp 90s stale
 *   GET /api/price?fault=null     — null value, null signature
 *   GET /api/price?fault=bad-sig  — valid value + timestamp, corrupted signature
 *
 * Fault requires either DEV_MODE=true OR the X-Fault-Token header matching FAULT_TOKEN.
 */

const express    = require("express");
const config     = require("./config");
const { signResponse } = require("./signer");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// x402 middleware setup
// ---------------------------------------------------------------------------

/**
 * Dev-mode x402 middleware.
 * Returns 402 with the payment schema if no X-Payment header is present.
 * Accepts any X-Payment value without verifying the on-chain payment —
 * so local testing works without real USDC.
 */
function devX402Middleware(req, res, next) {
  if (!req.headers["x-payment"]) {
    return res.status(402).json({
      error:   "Payment Required",
      x402Version: 1,
      accepts: [
        {
          scheme:              "exact",
          network:             config.ARC_NETWORK,
          maxAmountRequired:   "1000",             // 0.001 USDC in 6-decimal units
          resource:            `${req.protocol}://${req.get("host")}${req.path}`,
          description:         "ArcID Oracle — 1 price query",
          mimeType:            "application/json",
          payTo:               config.ORACLE_WALLET_ADDRESS,
          maxTimeoutSeconds:   300,
          asset:               "0x3600000000000000000000000000000000000000", // Arc USDC
          extra: {
            name:    "ArcID Oracle v2",
            version: "2.0.0",
          },
        },
      ],
    });
  }
  next();
}

/**
 * Production x402 middleware — verifies payment via Circle's facilitator.
 * Loaded only when DEV_MODE=false. Falls back to devX402Middleware if
 * x402-express is not installed.
 */
function loadProdX402() {
  try {
    const { paymentMiddleware } = require("x402-express");
    return paymentMiddleware(
      config.PRICE_USDC,
      config.ORACLE_WALLET_ADDRESS,
      {
        network:        config.ARC_NETWORK,
        facilitatorUrl: config.FACILITATOR_URL,
      }
    );
  } catch (e) {
    console.warn("[x402] x402-express not available — falling back to dev middleware:", e.message);
    return devX402Middleware;
  }
}

const x402 = config.DEV_MODE ? devX402Middleware : loadProdX402();

if (config.DEV_MODE) {
  console.log("[x402] DEV_MODE=true — payment verification is relaxed (any X-Payment header accepted)");
} else {
  console.log("[x402] Production mode — payments verified via Circle Gateway");
}

// ---------------------------------------------------------------------------
// Fault-mode guard
// Faults are allowed in DEV_MODE or when X-Fault-Token matches FAULT_TOKEN.
// ---------------------------------------------------------------------------

function isFaultAllowed(req) {
  if (config.DEV_MODE) return true;
  return req.headers["x-fault-token"] === config.FAULT_TOKEN;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    oracle:  config.ORACLE_WALLET_ADDRESS,
    network: config.ARC_NETWORK,
    sla:     { max_age_seconds: config.MAX_AGE_SECONDS },
    dev_mode: config.DEV_MODE,
  });
});

app.get("/api/price", x402, async (req, res) => {
  const faultMode = req.query.fault;   // stale | null | bad-sig

  if (faultMode && !isFaultAllowed(req)) {
    return res.status(403).json({ error: "Fault mode requires X-Fault-Token header" });
  }

  const now = Math.floor(Date.now() / 1000);

  // --- Build the value and timestamp ---
  let value     = generatePrice();   // mock ETH/USD price
  let timestamp = now;
  let signature;

  if (faultMode === "stale") {
    // Timestamp 90s in the past — 3× over the 30s SLA.
    // Signature is VALID over the stale data: provider is live and signing,
    // but deliberately serving old data. Phase 3 verdict: slashable breach.
    timestamp = now - 90;
    signature = await signResponse(value, timestamp);

  } else if (faultMode === "null") {
    // Value and signature are both null — completely malformed response.
    // Phase 3 verdict: ambiguous — could be a crash/bug, may want to check
    // if recurring before slashing.
    value     = null;
    signature = null;

  } else if (faultMode === "bad-sig") {
    // Valid value + current timestamp, but signature is corrupted random bytes.
    // Recovery will return a random address ≠ oracle wallet.
    // Phase 3 verdict: provider cannot prove authorship → slashable breach.
    signature = "0x" + "ab".repeat(32) + "cd".repeat(32) + "01";

  } else {
    // Normal: fresh value, current timestamp, valid signature.
    signature = await signResponse(value, timestamp);
  }

  const response = {
    value,
    timestamp,
    oracle:    config.ORACLE_WALLET_ADDRESS,
    signature,
    sla: {
      max_age_seconds: config.MAX_AGE_SECONDS,
    },
  };

  // Include fault marker in dev mode for easier debugging
  if (config.DEV_MODE && faultMode) {
    response._fault = faultMode;
  }

  res.json(response);
});

// ---------------------------------------------------------------------------
// Mock price generator — deterministic enough for demos, slightly variable
// for realism. In production this would call a real price feed.
// ---------------------------------------------------------------------------

function generatePrice() {
  const base  = 3_450.00;
  const jitter = (Math.random() - 0.5) * 20;  // ±$10
  return (base + jitter).toFixed(2);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(config.PORT, () => {
  console.log(`\nArcID Oracle running on port ${config.PORT}`);
  console.log(`  Oracle wallet: ${config.ORACLE_WALLET_ADDRESS}`);
  console.log(`  Network:       ${config.ARC_NETWORK}`);
  console.log(`  Price/call:    $${config.PRICE_USDC} USDC`);
  console.log(`  SLA:           ${config.MAX_AGE_SECONDS}s max age`);
  console.log(`\n  Endpoints:`);
  console.log(`    GET /health`);
  console.log(`    GET /api/price          (requires X-Payment header)`);
  console.log(`    GET /api/price?fault=stale    (90s stale timestamp)`);
  console.log(`    GET /api/price?fault=null     (null value + signature)`);
  console.log(`    GET /api/price?fault=bad-sig  (corrupted signature)\n`);
});

module.exports = app;
