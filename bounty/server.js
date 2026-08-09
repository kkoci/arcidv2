/**
 * bounty/server.js — HTTP submission entrypoint for the Proof-of-Exploit
 * harness, gated by an x402 anti-spam fee. Copy-adapted from the exact
 * `devX402Middleware` pattern already in `oracle/src/index.js` — same
 * shape, same 402 response, same "any non-empty X-Payment header is
 * accepted" dev-mode behavior. This is the discouragement mechanism the
 * scoping doc called for ("repeated spam submissions... made to cost a
 * small x402 fee") — NOT a new payment primitive invented for this
 * vertical.
 *
 * HONEST SCOPE NOTE: this is DEV_MODE only. The price-oracle vertical also
 * has a real Circle Gateway path (`loadProdX402()` in oracle/src/index.js)
 * for production; wiring that same real-settlement path here was cut for
 * time — this endpoint only ever runs the dev stub. Said plainly so it
 * doesn't read as done-by-omission.
 *
 * POST /submit — runs the harness (fresh-local-deploy exploit -> invariant
 * check -> sign -> real submitVerdict() on Arc testnet) and returns the
 * verdict + tx hash.
 *   body: { targetId: number, researcher: "0x...", mode?: "exploit"|"control" }
 *
 * Must run via `hardhat run` (not plain `node`) — same reason as
 * bounty/harness.js: the exploit itself needs a real local EVM, which only
 * Hardhat's own runtime provides.
 *
 * Usage:
 *   BOUNTY_VERIFIER_PRIVATE_KEY=... in .env, then:
 *   npx hardhat run bounty/server.js --network hardhat
 *   curl http://localhost:3002/submit  # -> 402
 *   curl -X POST http://localhost:3002/submit \
 *     -H "X-Payment: dev" -H "Content-Type: application/json" \
 *     -d '{"targetId":1,"researcher":"0x..."}'
 */

"use strict";
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express = require("express");
const { ethers } = require("ethers");
const { runExploit, submitOnChain, loadDeployment, requireEnvKey } = require("./harness");

const PORT = process.env.BOUNTY_SERVER_PORT || 3002;
const SUBMISSION_FEE_ATOMIC = "10000"; // $0.01 USDC (6 decimals) — anti-spam, not a real settlement in DEV_MODE

// ---------------------------------------------------------------------------
// Per-IP rate limit on /submit — security hardening pass (see CHANGELOG.md).
// The x402 "anti-spam fee" above is decorative in DEV_MODE (any non-empty
// X-Payment header passes, no real charge — stated honestly in this file's
// own module comment already) — it provides zero actual deterrent. Every
// /submit call is genuinely expensive server-side regardless of outcome: a
// fresh Hardhat deployment + a real reentrancy attack simulation, then a
// real Arc testnet transaction attempt. Independent from the payment
// circuit breaker elsewhere in this codebase (that one caps USDC spend;
// this caps request volume) — an attacker who never gets past this limit
// never triggers a payment path at all. In-memory fixed-window counter,
// same minimal-dependency style as oracle/index.js's checkCooldown() —
// resets on server restart, which is fine for a demo-scale deployment.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX      = parseInt(process.env.BOUNTY_RATE_LIMIT_MAX      || "5", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.BOUNTY_RATE_LIMIT_WINDOW_MS || String(60_000), 10);
const submitHitsByIp = new Map(); // ip -> { count, windowStart }

function checkSubmitRateLimit(req, res) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = submitHitsByIp.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    submitHitsByIp.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    res.status(429)
      .set("Retry-After", String(retryAfterSec))
      .json({ error: `Rate limit exceeded — max ${RATE_LIMIT_MAX} exploit runs per ${RATE_LIMIT_WINDOW_MS / 1000}s per IP. Retry in ${retryAfterSec}s.` });
    return false;
  }

  entry.count++;
  return true;
}

const app = express();
app.use(express.json());

// CORS — allow the Vite dev server (frontend/, port 5174) to call this
// directly. Not proxied through frontend/vite.config.js (left untouched —
// see CHANGELOG.md); same permissive-for-local-dev pattern oracle/src/index.js
// already uses for its own CORS middleware.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// x402 middleware — copy-adapted from oracle/src/index.js's devX402Middleware.
// Same shape: no X-Payment header -> 402 with signed-looking payment
// requirements; any non-empty header -> accepted. Dev-only, stated above.
// ---------------------------------------------------------------------------
function devX402Middleware(req, res, next) {
  const paymentHeader = req.headers["x-payment"];
  if (!paymentHeader) {
    return res.status(402).json({
      error:       "Payment Required",
      x402Version: 1,
      accepts: [
        {
          scheme:            "exact",
          network:           "dev",
          maxAmountRequired: SUBMISSION_FEE_ATOMIC,
          resource:          `${req.protocol}://${req.get("host")}${req.path}`,
          description:       "Proof-of-Exploit submission — anti-spam fee",
          mimeType:          "application/json",
          payTo:             process.env.BOUNTY_VERIFIER_ADDRESS || "0x0000000000000000000000000000000000000000",
          maxTimeoutSeconds: 300,
          asset:             "0x3600000000000000000000000000000000000000",
          extra: { name: "ArcID Proof-of-Exploit", version: "1.0.0" },
        },
      ],
    });
  }
  next();
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", dev_mode: true, note: "DEV_MODE only — no real Gateway settlement wired for this vertical" });
});

app.post("/submit", (req, res, next) => {
  // Rate limit runs before x402/payment gating and before anything else —
  // cheapest possible check first, so a spammer never even reaches the
  // (decorative, in DEV_MODE) payment step, let alone the real exploit run.
  if (!checkSubmitRateLimit(req, res)) return; // checkSubmitRateLimit already sent the 429
  next();
}, devX402Middleware, async (req, res) => {
  const { targetId, researcher, mode } = req.body || {};
  if (targetId === undefined || !researcher) {
    return res.status(400).json({ error: "targetId and researcher are required" });
  }

  // Validate the address is well-formed BEFORE running anything expensive.
  // Previously this only checked truthiness — a malformed researcher value
  // would still trigger a full fresh-Hardhat-deploy + reentrancy-attack
  // simulation and only fail at the very last step (on-chain submitVerdict()
  // encoding), wasting exactly the CPU/gas cost the rate limit above exists
  // to bound. ethers.isAddress() also accepts non-checksummed lowercase/
  // uppercase input (same leniency ethers.Contract calls have downstream),
  // it isn't stricter than what would eventually run — it just fails fast.
  if (!ethers.isAddress(researcher)) {
    return res.status(400).json({ error: `researcher must be a valid Ethereum address, got: ${String(researcher).slice(0, 100)}` });
  }

  let verifierKey, deployment;
  try {
    verifierKey = requireEnvKeySafe("BOUNTY_VERIFIER_PRIVATE_KEY");
    deployment  = loadDeployment("arcTestnet");
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const vaultContract = mode === "control" ? "VulnerableVaultFixed" : "VulnerableVault";
    const result = await runExploit(vaultContract);

    const txHash = await submitOnChain({
      targetId,
      researcher,
      exploitConfirmed: result.breach,
      reason: result.reason,
      verifierKey,
      deployment,
    });

    res.json({ ...result, txHash, explorerUrl: `https://testnet.arcscan.app/tx/${txHash}` });
  } catch (err) {
    console.error("[submit]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// requireEnvKey() in harness.js calls process.exit(1) on a missing var —
// fine for a one-shot CLI script, wrong for a running server (would kill
// the whole process on one bad request). Same check, HTTP-appropriate
// failure instead.
function requireEnvKeySafe(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing required env var: ${name} (set it in .env, never a request parameter)`);
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nProof-of-Exploit harness server — DEV_MODE only`);
    console.log(`  Port: ${PORT}`);
    console.log(`  POST /submit  (x402-gated, $0.01 anti-spam fee, dev stub)`);
    console.log(`  GET  /health\n`);
  });
}

module.exports = app;
