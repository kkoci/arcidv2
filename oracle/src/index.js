/**
 * ArcID Oracle Service — Phase 2 + Phase 4 API extensions
 *
 * Endpoints (no payment required):
 *   GET  /health              — status check
 *   GET  /api/stats           — traction counters (frontend traction strip)
 *   GET  /api/verdicts        — last 50 adjudication verdicts (frontend feed)
 *   POST /api/verdicts        — consumer agent pushes verdict after each cycle
 *   POST /admin/fault         — set server-side fault mode (Trigger Fault button)
 *   POST /admin/fault/reset   — clear fault mode (Reset button)
 *
 * Endpoints (x402 payment required):
 *   GET  /api/price           — signed price response; uses activeFaultMode if set
 *   GET  /api/price?fault=X   — override fault for this call only
 */

const express    = require("express");
const config     = require("./config");
const { signResponse } = require("./signer");
const { getChainStats, triggerCycle, getGatewayBalance } = require("./chain");
const { getAttestation } = require("./attest");

const app = express();
app.use(express.json());

// CORS — allow the Vite dev server (and any frontend origin) to call this API
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment, X-Fault-Token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let activeFaultMode = null; // server-side fault; overrides ?fault= if set

const stats = {
  totalCalls:      0,
  totalVolumeUSDC: 0,
  okCount:         0,
  breachCount:     0,
  uncertainCount:  0,
  slashCount:      0,
  activeBonds:     1, // start at 1 (the test bond from Phase 1 deploy)
};

const verdicts = []; // circular buffer — last 50
const MAX_VERDICTS = 50;
let lastConsumer = null;

// ---------------------------------------------------------------------------
// x402 middleware
// ---------------------------------------------------------------------------

function devX402Middleware(req, res, next) {
  if (!req.headers["x-payment"]) {
    return res.status(402).json({
      error:       "Payment Required",
      x402Version: 1,
      accepts: [
        {
          scheme:            "exact",
          network:           config.ARC_NETWORK,
          maxAmountRequired: "1000",
          resource:          `${req.protocol}://${req.get("host")}${req.path}`,
          description:       "ArcID Oracle — 1 price query",
          mimeType:          "application/json",
          payTo:             config.ORACLE_WALLET_ADDRESS,
          maxTimeoutSeconds: 300,
          asset:             "0x3600000000000000000000000000000000000000",
          extra: { name: "ArcID Oracle v2", version: "2.0.0" },
        },
      ],
    });
  }
  next();
}

// Circle Gateway Nanopayments — x402 wrapped with batched settlement.
// gatewayInstance is only set in production (DEV_MODE=false); used by
// /api/gateway-balance to read the seller's live Gateway balance.
let gatewayInstance = null;

function loadProdX402() {
  try {
    const { createGatewayMiddleware } = require("@circle-fin/x402-batching/server");
    gatewayInstance = createGatewayMiddleware({
      sellerAddress:  config.GATEWAY_SELLER_ADDRESS,
      facilitatorUrl: config.GATEWAY_FACILITATOR_URL,
      networks:       config.GATEWAY_NETWORK,
    });
    console.log(`[gateway] Circle Gateway Nanopayments active — seller=${config.GATEWAY_SELLER_ADDRESS} network=${config.GATEWAY_NETWORK}`);
    return gatewayInstance.require(`$${config.PRICE_USDC}`);
  } catch (e) {
    console.warn("[gateway] Circle Gateway unavailable — using dev middleware:", e.message);
    return devX402Middleware;
  }
}

const x402 = config.DEV_MODE ? devX402Middleware : loadProdX402();

if (config.DEV_MODE) {
  console.log("[x402] DEV_MODE=true — payment verification relaxed");
} else {
  console.log("[x402] Production mode — payments verified + settled via Circle Gateway");
}

// ---------------------------------------------------------------------------
// Fault guard
// ---------------------------------------------------------------------------

function isFaultAllowed(req) {
  return config.DEV_MODE || req.headers["x-fault-token"] === config.FAULT_TOKEN;
}

// ---------------------------------------------------------------------------
// Routes — no payment required
// ---------------------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status:      "ok",
    oracle:      config.ORACLE_WALLET_ADDRESS,
    network:     config.ARC_NETWORK,
    sla:         { max_age_seconds: config.MAX_AGE_SECONDS },
    dev_mode:    config.DEV_MODE,
    fault_mode:  activeFaultMode,
  });
});

app.get("/api/stats", (req, res) => {
  res.json({
    ...stats,
    oracle:     config.ORACLE_WALLET_ADDRESS,
    consumer:   lastConsumer,
    fault_mode: activeFaultMode,
    usyc: {
      token:      config.USYC_TOKEN_ADDRESS,
      teller:     config.TELLER_ADDRESS,
      bond:       config.USYC_BOND_ADDRESS  || null,
      usdc_bond:  config.USDC_BOND_ADDRESS  || null,
    },
  });
});

app.get("/api/verdicts", (req, res) => {
  // newest first — wrapped for frontend consumption
  res.json({ verdicts: [...verdicts].reverse() });
});

// TDX DCAP attestation quote for this oracle instance
// USE_REAL_PHALA=true  → real quote from Phala dstack (CVM only)
// USE_REAL_PHALA=false → prototype quote, self-signed (local dev)
app.get("/api/attest", async (req, res) => {
  try {
    const attestation = await getAttestation();
    res.json(attestation);
  } catch (e) {
    console.error("[attest]", e.message);
    res.status(500).json({ error: e.message, real_tdx: config.USE_REAL_PHALA });
  }
});

// Circle Gateway seller balance — live unified USDC balance for the demo UI
app.get("/api/gateway-balance", async (req, res) => {
  try {
    const balance = await getGatewayBalance();
    res.json({
      seller:  config.GATEWAY_SELLER_ADDRESS,
      network: config.GATEWAY_NETWORK,
      price:   config.PRICE_USDC,
      balance,
    });
  } catch (e) {
    console.error("[gateway-balance]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Live on-chain agent + bond data (paginated, cached 5s)
app.get("/api/chain-stats", async (req, res) => {
  try {
    const data = await getChainStats();
    if (!data) return res.status(503).json({ error: "Chain config not set" });
    res.json(data);
  } catch (e) {
    console.error("[chain-stats]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Consumer agent pushes a verdict after each cycle
app.post("/api/verdicts", (req, res) => {
  const v = req.body;
  if (!v || !v.verdict) return res.status(400).json({ error: "verdict field required" });

  verdicts.push({ ...v, received_at: new Date().toISOString() });
  if (verdicts.length > MAX_VERDICTS) verdicts.shift();
  if (v.consumer) lastConsumer = v.consumer;

  // Update stats from the verdict
  if (v.verdict === "ok")        stats.okCount++;
  if (v.verdict === "breach")    { stats.breachCount++; stats.slashCount++; }
  if (v.verdict === "uncertain") stats.uncertainCount++;
  if (v.payment_usdc)            stats.totalVolumeUSDC = +(stats.totalVolumeUSDC + v.payment_usdc).toFixed(6);

  res.json({ ok: true });
});

// Admin: set fault mode (Trigger Fault button)
app.post("/admin/fault", (req, res) => {
  if (!isFaultAllowed(req)) return res.status(403).json({ error: "Requires X-Fault-Token" });
  const { mode } = req.body;
  if (!["stale", "null", "bad-sig"].includes(mode)) {
    return res.status(400).json({ error: "mode must be stale | null | bad-sig" });
  }
  activeFaultMode = mode;
  console.log(`[fault] Fault mode set: ${activeFaultMode}`);
  res.json({ ok: true, fault_mode: activeFaultMode });
});

// Trigger the full slash loop: re-bond → bad-sig → Claude → on-chain slash → recharge
app.post("/admin/trigger-cycle", async (req, res) => {
  if (!isFaultAllowed(req)) return res.status(403).json({ error: "Requires X-Fault-Token" });
  console.log("[trigger-cycle] Starting slash demo loop...");
  try {
    const result = await triggerCycle();
    if (result.slashTx) {
      stats.slashCount++;
      stats.breachCount++;
      verdicts.push({
        verdict:    result.verdict,
        reason:     result.reason,
        slash_tx:   result.slashTx,
        fault_mode: "bad-sig",
        triggered:  true,
        received_at: new Date().toISOString(),
      });
      if (verdicts.length > MAX_VERDICTS) verdicts.shift();
    }
    console.log("[trigger-cycle] Done:", result.slashTx ?? "no slash");
    res.json(result);
  } catch (e) {
    console.error("[trigger-cycle]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: clear fault mode (Reset button)
app.post("/admin/fault/reset", (req, res) => {
  if (!isFaultAllowed(req)) return res.status(403).json({ error: "Requires X-Fault-Token" });
  activeFaultMode = null;
  console.log("[fault] Fault mode cleared");
  res.json({ ok: true, fault_mode: null });
});

// ---------------------------------------------------------------------------
// Routes — x402 payment required
// ---------------------------------------------------------------------------

app.get("/api/price", x402, async (req, res) => {
  // ?fault= param overrides server-side fault for one call
  const faultMode = req.query.fault || activeFaultMode;

  if (faultMode && !isFaultAllowed(req)) {
    return res.status(403).json({ error: "Fault mode requires X-Fault-Token header" });
  }

  stats.totalCalls++;
  stats.totalVolumeUSDC = +(stats.totalVolumeUSDC + parseFloat(config.PRICE_USDC)).toFixed(6);

  const now   = Math.floor(Date.now() / 1000);
  let value     = generatePrice();
  let timestamp = now;
  let signature;

  if (faultMode === "stale") {
    timestamp = now - 90;
    signature = await signResponse(value, timestamp);
  } else if (faultMode === "null") {
    value     = null;
    signature = null;
  } else if (faultMode === "bad-sig") {
    signature = "0x" + "ab".repeat(32) + "cd".repeat(32) + "01";
  } else {
    signature = await signResponse(value, timestamp);
  }

  const response = {
    value,
    timestamp,
    oracle:    config.ORACLE_WALLET_ADDRESS,
    signature,
    sla: { max_age_seconds: config.MAX_AGE_SECONDS },
  };

  if (config.DEV_MODE && faultMode) response._fault = faultMode;

  res.json(response);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generatePrice() {
  const base   = 3_450.00;
  const jitter = (Math.random() - 0.5) * 20;
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
  console.log(`    GET  /health`);
  console.log(`    GET  /api/stats`);
  console.log(`    GET  /api/verdicts`);
  console.log(`    POST /api/verdicts          (consumer pushes verdicts)`);
  console.log(`    POST /admin/fault           (set fault mode)`);
  console.log(`    POST /admin/fault/reset     (clear fault mode)`);
  console.log(`    GET  /api/attest            (TDX DCAP quote — real if USE_REAL_PHALA=true)`);
  console.log(`    GET  /api/chain-stats       (on-chain bond + agent state)`);
  console.log(`    GET  /api/gateway-balance   (Circle Gateway seller USDC balance)`);
  console.log(`    GET  /api/price             (x402-gated — Circle Gateway in prod)\n`);
  console.log(`  Attestation: USE_REAL_PHALA=${config.USE_REAL_PHALA} PHALA_ENDPOINT=${config.PHALA_ENDPOINT}`);
});

module.exports = app;
