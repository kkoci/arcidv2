/**
 * ArcID Oracle Service — Phase 2 + Phase 4 API extensions
 *
 * Endpoints (no payment required):
 *   GET  /health              — status check
 *   GET  /api/stats           — traction counters (frontend traction strip)
 *   GET  /api/verdicts        — last 50 adjudication verdicts (frontend feed)
 *   POST /api/verdicts        — consumer agent pushes verdict after each cycle
 *   GET  /api/verdict/:verdictHash — single verdict record, ERC-8004 feedbackURI target (Phase 8.2)
 *   POST /admin/fault         — set server-side fault mode (Trigger Fault button)
 *   POST /admin/fault/reset   — clear fault mode (Reset button)
 *
 * Endpoints (x402 payment required):
 *   GET  /api/price           — signed price response; uses activeFaultMode if set
 *   GET  /api/price?fault=X   — override fault for this call only
 *
 * Endpoints (paid via ERC-8183 job escrow instead of x402 — Phase 8.3):
 *   POST /api/premium-analysis        — generate + sign + cache a premium analysis for a jobId
 *   GET  /api/premium-analysis/:jobId — fetch the cached payload (evaluator's feedbackURI-equivalent)
 */

const express    = require("express");
const config     = require("./config");
const { signResponse, signPremiumAnalysis } = require("./signer");
const { getChainStats, triggerCycle, getGatewayBalance, payForPriceViaGateway, isRegisteredAgent } = require("./chain");
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
  // Grant-readiness metrics (Phase 8.5, post-submission — see CHANGELOG.md).
  // Tallied from each verdict's own `tier` field, already attached by the
  // consumer's tiered adjudicator (Phase 1/2 of the tiered-adjudication
  // doc) — this is a count of an existing signal, not a new one.
  deterministicVerdicts: 0,
  semanticVerdicts:      0,
};

const verdicts = []; // circular buffer — last 50
const MAX_VERDICTS = 50;
let lastConsumer = null;

// ---------------------------------------------------------------------------
// x402 middleware
// ---------------------------------------------------------------------------

// Marketplace gating (Phase 8.5, post-submission — see CHANGELOG.md):
// "an agent marketplace that refuses unbonded agents" — arcid2 has no
// consumer-side BOND concept (only providers post collateral), so this
// resolves to the identity check that already IS the moat elsewhere in this
// project: is the caller a TEE-attested agent in ArcIDRegistryV2 at all?
// Opt-in, default OFF (REQUIRE_REGISTERED_CALLER unset/false) — deliberately
// NOT unconditional. Turning this on would refuse any outside agent that
// pays but isn't itself TEE-registered, which would directly cut against
// the traction goal (real outside callers) this project's own grant-
// readiness assessment flags as the actual decisive weakness. Real,
// functioning, and demoable on demand (flip the env var) without risking
// the live open-marketplace behavior other traction-relevant callers use.
//
// PRODUCTION-MODE GAP, stated rather than silently unhandled: this only
// gates the DEV_MODE path below. The real Gateway path (loadProdX402(),
// createGatewayMiddleware().require()) settles payment and calls the route
// handler as one automatic block — by the time this file's own code runs,
// payment has already cleared. Gating the caller BEFORE settlement in
// production would need dropping to the manual BatchFacilitatorClient.verify()/
// .settle() pattern (confirmed equivalent to the convenience wrapper in
// Phase 7.3's CHANGELOG entry) so the payer can be inspected first — not
// built this pass.
async function devX402Middleware(req, res, next) {
  const paymentHeader = req.headers["x-payment"];
  if (!paymentHeader) {
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

  if (config.REQUIRE_REGISTERED_CALLER) {
    // Fails closed: an unparsable header or missing payer field can't prove
    // the caller's identity, so it's treated the same as unregistered.
    let payer = null;
    try { payer = JSON.parse(paymentHeader).payer ?? null; } catch { /* payer stays null */ }

    if (!(await isRegisteredAgent(payer))) {
      return res.status(403).json({
        error:  "Unregistered caller",
        detail: "This service only serves TEE-attested agents registered in ArcIDRegistry — refuses unbonded/unregistered callers, not just unpaid ones.",
      });
    }
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
// Cost circuit breaker — bounds worst case if FAULT_TOKEN ever leaks or is
// guessed. /admin/trigger-cycle does a real on-chain slash tx (no LLM call
// — see the route's own comment, tiered-adjudication Phase 5 removed that
// entirely); /admin/demo-pay moves real (if trivial) USDC. A shared
// cooldown caps how often either can fire, independent of the token check
// above.
// ---------------------------------------------------------------------------

// 5 minutes — deliberately longer than a full trigger-cycle (re-bond + slash +
// recharge, each waiting on testnet confirmation) so back-to-back calls can't
// each individually clear the window before the prior one even finishes.
const EXPENSIVE_COOLDOWN_MS = 5 * 60_000;
let lastExpensiveCallAt = 0;

function checkCooldown(res) {
  const elapsed = Date.now() - lastExpensiveCallAt;
  if (elapsed < EXPENSIVE_COOLDOWN_MS) {
    res.status(429).json({ error: `Cooldown active — retry in ${Math.ceil((EXPENSIVE_COOLDOWN_MS - elapsed) / 1000)}s` });
    return false;
  }
  lastExpensiveCallAt = Date.now();
  return true;
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

// ERC-8004 reputation dual-write's feedbackURI target (Phase 8.2, post-
// submission — see CHANGELOG.md). Serves the structured verdict record
// already in the (last-50, in-memory) verdicts buffer, keyed by the same
// verdictHash field consumer/src/index.js now attaches to every record
// before POSTing it here — the same value ArcIDBond's dual-write passes to
// ReputationRegistry.giveFeedback() as feedbackHash.
//
// HONEST LIMITATION, not hidden: verdictHash is not guaranteed unique per
// individual verdict occurrence. For a clean settlement it's a hash of
// {verdict, should_slash} only (see consumer/src/settlement.js's own
// verdictHash() — deliberately outcome-only, not rationale-wording-
// sensitive), so every "ok" verdict with the same should_slash value shares
// one hash. For a slash it's keccak256(reason) — unique per distinct
// rationale text, but two slashes with byte-identical reason text (e.g. the
// dispute paths' fixed placeholder strings) would collide too. This route
// returns the MOST RECENT matching record in the buffer, not a guaranteed
// 1:1 lookup — an honest property of the underlying hash scheme, not a bug
// introduced here.
app.get("/api/verdict/:verdictHash", (req, res) => {
  const { verdictHash } = req.params;
  const match = [...verdicts].reverse().find((v) => v.verdictHash === verdictHash);
  if (!match) {
    return res.status(404).json({ error: "No verdict found for this hash in the current in-memory buffer (last 50)." });
  }
  res.json(match);
});

// ── ERC-8183 premium job flow (Phase 8.3, post-submission — see
// CHANGELOG.md) ──────────────────────────────────────────────────────────
//
// A genuinely separate, higher-value service tier — "premium oracle
// analysis" ($0.05 default, 50x the $0.001 price feed) — sold through
// Arc's real ERC-8183 job/escrow/evaluator contract instead of x402/
// Nanopayments. One real payment per mechanism: this is NOT charged
// alongside the existing /api/price call, and does not touch it.
//
// Cached in-memory by jobId (small map, not a rolling buffer — a demo-scale
// number of concurrent jobs) so the payload generated for submit()'s
// deliverable hash is the EXACT same payload later served to the
// evaluator, not regenerated (prices/trend are randomized per call).
const premiumAnalyses = {};

function generatePremiumAnalysis() {
  // Small synthetic rolling window (this call only — not persisted across
  // calls) to derive trend/sma/volatility. Demo-scale, not a real
  // analytics engine — reuses the exact same generatePrice() the base
  // price feed already uses, just sampled a few times.
  const WINDOW = 5;
  const samples = Array.from({ length: WINDOW }, () => parseFloat(generatePrice()));
  const value = samples[samples.length - 1];
  const sma = samples.reduce((a, b) => a + b, 0) / samples.length;
  const trend = value > samples[0] ? "up" : value < samples[0] ? "down" : "flat";
  const variance = samples.reduce((acc, s) => acc + (s - sma) ** 2, 0) / samples.length;
  const volatilityBps = Math.round((Math.sqrt(variance) / sma) * 10_000);

  return {
    value: value.toFixed(2),
    timestamp: Math.floor(Date.now() / 1000),
    trend,
    sma: sma.toFixed(2),
    volatilityBps,
  };
}

// Generates, signs, and caches a premium analysis for a job. Called by
// whoever is acting as the job's provider (see scripts/cli/demo-erc8183-
// job.js) right before submit()-ing the deliverable hash on-chain.
app.post("/api/premium-analysis", async (req, res) => {
  const { jobId, fault } = req.body || {};
  if (jobId === undefined) return res.status(400).json({ error: "jobId required" });

  let analysis = generatePremiumAnalysis();

  // Demo-only fault injection (mirrors /api/price?fault=), so the
  // reject()+slash composition path is demoable on command, same as
  // demo:hard-breach/demo:semantic-breach.
  let signature, deliverableHash;
  if (fault === "bad-sig") {
    ({ deliverableHash } = await signPremiumAnalysis(analysis));
    signature = "0x" + "ab".repeat(32) + "cd".repeat(32) + "01"; // structurally valid, wrong signer
  } else {
    ({ signature, deliverableHash } = await signPremiumAnalysis(analysis));
  }

  const payload = { ...analysis, oracle: config.ORACLE_WALLET_ADDRESS, signature };
  premiumAnalyses[jobId] = payload;

  res.json({ payload, deliverableHash });
});

app.get("/api/premium-analysis/:jobId", (req, res) => {
  const payload = premiumAnalyses[req.params.jobId];
  if (!payload) {
    return res.status(404).json({ error: "No premium analysis generated for this jobId yet — call POST /api/premium-analysis first." });
  }
  res.json(payload);
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
  if (v.tier === "deterministic") stats.deterministicVerdicts++;
  else if (v.tier === "semantic") stats.semanticVerdicts++;

  res.json({ ok: true });
});

// Admin: set fault mode (Trigger Fault button)
app.post("/admin/fault", (req, res) => {
  if (!isFaultAllowed(req)) return res.status(403).json({ error: "Requires X-Fault-Token" });
  const { mode } = req.body;
  if (!["stale", "null", "bad-sig", "bad-price"].includes(mode)) {
    return res.status(400).json({ error: "mode must be stale | null | bad-sig | bad-price" });
  }
  activeFaultMode = mode;
  console.log(`[fault] Fault mode set: ${activeFaultMode}`);
  res.json({ ok: true, fault_mode: activeFaultMode });
});

// Trigger the full slash loop: re-bond → bad-sig → Tier 1 deterministic
// verdict → on-chain slash → recharge. No LLM call — bad-sig is a
// mechanically-checkable signature failure, decided the same way the real
// consumer flow decides it (see deterministicVerifier.js). This endpoint's
// own separate LLM adjudicator was removed entirely during tiered-
// adjudication Phase 5 (see CHANGELOG.md) — not just re-gated.
app.post("/admin/trigger-cycle", async (req, res) => {
  if (!isFaultAllowed(req)) return res.status(403).json({ error: "Requires X-Fault-Token" });
  if (!checkCooldown(res)) return;
  console.log("[trigger-cycle] Starting slash demo loop...");
  try {
    const result = await triggerCycle();
    if (result.slashTx) {
      stats.slashCount++;
      stats.breachCount++;
      stats.deterministicVerdicts++; // bad-sig is always Tier 1 — see this route's own module comment
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

// Demo-only: pay for one real /api/price call via Circle Gateway (separate from
// the bad-sig trigger-cycle above — this exercises the actual Gateway payment
// path, not the fault/slash loop, so it can run alongside it without interfering).
app.post("/admin/demo-pay", async (req, res) => {
  if (!isFaultAllowed(req)) return res.status(403).json({ error: "Requires X-Fault-Token" });
  if (config.DEV_MODE) {
    return res.status(400).json({ error: "Circle Gateway demo requires DEV_MODE=false (real facilitator)" });
  }
  if (!checkCooldown(res)) return;
  try {
    const result = await payForPriceViaGateway();
    res.json(result);
  } catch (e) {
    console.error("[demo-pay]", e.message);
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
  } else if (faultMode === "bad-price") {
    // Tiered adjudication Phase 5 demo fault (post-submission — see
    // CHANGELOG.md): a validly-signed, fresh, well-formed response whose
    // VALUE is semantically implausible — a sentinel-looking number no real
    // market price would ever be. Passes every Tier 1 mechanical check
    // (signature/timestamp/schema all fine); only Tier 2 (Claude, reasoning
    // about plausibility) can catch it. This is what demo:semantic-breach
    // exercises — the counterpart to bad-sig's Tier 1 hard-breach demo.
    value = "99999999.99";
    signature = await signResponse(value, timestamp);
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
  console.log(`    GET  /api/verdict/:verdictHash (ERC-8004 feedbackURI target)`);
  console.log(`    POST /api/verdicts          (consumer pushes verdicts)`);
  console.log(`    POST /admin/fault           (set fault mode)`);
  console.log(`    POST /admin/fault/reset     (clear fault mode)`);
  console.log(`    POST /admin/demo-pay        (pay for one /api/price call via Circle Gateway)`);
  console.log(`    GET  /api/attest            (TDX DCAP quote — real if USE_REAL_PHALA=true)`);
  console.log(`    GET  /api/chain-stats       (on-chain bond + agent state)`);
  console.log(`    GET  /api/gateway-balance   (Circle Gateway seller USDC balance)`);
  console.log(`    GET  /api/price             (x402-gated — Circle Gateway in prod)`);
  console.log(`    POST /api/premium-analysis  (ERC-8183 job flow — $${config.PREMIUM_PRICE_USDC} tier, not x402)`);
  console.log(`    GET  /api/premium-analysis/:jobId\n`);
  console.log(`  Attestation: USE_REAL_PHALA=${config.USE_REAL_PHALA}${config.USE_REAL_PHALA ? " (dstack Unix socket, auto-probed by @phala/dstack-sdk)" : ""}`);
});

module.exports = app;
