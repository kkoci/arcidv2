"use strict";
/**
 * server.js — the live HTTP surface for the AcquisitionAgent. This is
 * the actual product endpoint an AI company hits to license training
 * data — not a demo wrapper around something else. It wraps
 * src/agent.js (the real judgment) and src/settle.js (the real,
 * unmodified settlement handoff) behind HTTP, the same "wrap what
 * already exists" pattern bounty/server.js already established for the
 * Proof-of-Exploit vertical.
 *
 * ASYNC job + poll, not a single long synchronous request — decided
 * after timing a real run against real Arc testnet during this build:
 * 6 real Claude calls plus somewhere around 6-10 real on-chain
 * transactions (pool funding, ingestion, allocation submission, N
 * artist claims) lands in the 30-60+ second range on a public testnet
 * RPC, with real variance run to run. A single HTTP request held open
 * that long is fragile (proxy/browser timeouts, no partial progress if
 * it drops) and gives strictly worse UX than it needs to: the sync
 * alternative would show nothing until everything finishes, where async
 * lets the frontend show each track's real reasoning as it actually
 * lands — which the spec asked for anyway ("show ... reasoning as it
 * becomes available"). In-memory job store — demo-scale, resets on
 * restart, same convention as oracle/src/index.js's rate-limit map and
 * cooldown state elsewhere in this repo.
 *
 * POST /api/acquire   { brief, budget }  -> 202 { jobId }
 * GET  /api/acquire/:jobId               -> current job state (poll this)
 * GET  /health
 *
 * Usage:
 *   Requires acquisition/.env (from scripts/setup_acquisition_catalog.js)
 *   and root .env's INGESTOR_PRIVATE_KEY / ANTHROPIC_API_KEY / ARC_RPC_URL.
 *   node acquisition/server.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
require("dotenv").config({ path: require("path").join(__dirname, ".env"), override: false });

const express  = require("express");
const crypto   = require("crypto");
const { ethers } = require("ethers");
const { selectTracks } = require("./src/agent");
const { settleSelection } = require("./src/settle");
const { TRACKS } = require("./src/catalog");

const PORT = process.env.ACQUISITION_SERVER_PORT || 3010;
const NETWORK = process.env.ACQUISITION_NETWORK || "arcTestnet";
const INGESTOR_URL = process.env.INGESTOR_URL || "http://localhost:3006";
const PRICE_PER_TRACK = parseFloat(process.env.PRICE_PER_TRACK || "1.0");
const ARC_TESTNET_CHAIN_ID = 5042002;

// ---------------------------------------------------------------------------
// Per-IP rate limit — this endpoint costs real Claude API money (6 calls
// per hit) and spends real testnet USDC/gas from a wallet with a finite
// balance, same category of concern as bounty/server.js's own rate
// limiter on /submit. In-memory fixed-window counter, same shape.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX       = parseInt(process.env.ACQ_RATE_LIMIT_MAX       || "3", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.ACQ_RATE_LIMIT_WINDOW_MS || String(10 * 60_000), 10);
const hitsByIp = new Map();

function checkRateLimit(req, res) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = hitsByIp.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    hitsByIp.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    res.status(429).set("Retry-After", String(retryAfterSec)).json({
      error: `Rate limit exceeded — max ${RATE_LIMIT_MAX} licensing requests per ${RATE_LIMIT_WINDOW_MS / 60000}min per IP. Retry in ${retryAfterSec}s.`,
    });
    return false;
  }
  entry.count++;
  return true;
}

// ---------------------------------------------------------------------------
// Wallets + contracts — loaded once at startup, reused across requests.
// ---------------------------------------------------------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. Run scripts/setup_acquisition_catalog.js first.`);
  return v.startsWith("0x") ? v : `0x${v}`;
}

const deployPath = require("path").join(__dirname, "..", "deployments", `${NETWORK}_training_compensation.json`);
const catalogPath = require("path").join(__dirname, "..", "deployments", `${NETWORK}_acquisition_catalog.json`);
const deploy = require(deployPath);
const catalogState = require(catalogPath);

const provider = NETWORK === "hardhat" || NETWORK === "localhost"
  ? new ethers.JsonRpcProvider("http://127.0.0.1:8545")
  : new ethers.JsonRpcProvider(process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
      { chainId: ARC_TESTNET_CHAIN_ID, name: "arcTestnet" }, { staticNetwork: true });

const company  = new ethers.Wallet(requireEnv("ACQ_COMPANY_PRIVATE_KEY"), provider);
const ingestor = new ethers.Wallet(requireEnv("INGESTOR_PRIVATE_KEY"), provider);
const artistWalletByKey = {};
for (const key of Object.keys(catalogState.artists)) {
  artistWalletByKey[key] = new ethers.Wallet(requireEnv(`ACQ_ARTIST_${key}_PRIVATE_KEY`), provider);
}

const POOL_ABI = [
  "function nextPoolId() view returns (uint256)",
  "function createPool(bytes32,uint256) returns (uint256)",
];
const CLAIM_ABI = [
  "function submitAllocation(uint256,bytes32)",
  "function claim(uint256,uint256,bytes32[])",
];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const pool          = new ethers.Contract(deploy.addresses.TrainingPool, POOL_ABI, provider);
const claimContract = new ethers.Contract(deploy.addresses.CompensationClaim, CLAIM_ABI, provider);
const usdc           = new ethers.Contract(deploy.addresses.collateralToken, ERC20_ABI, provider);

// ---------------------------------------------------------------------------
// Job store
// ---------------------------------------------------------------------------
const jobs = new Map(); // jobId -> job state

function newJob(brief, budget) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    jobId, brief, budget, pricePerTrack: PRICE_PER_TRACK,
    status: "evaluating", // evaluating -> settling -> done | error | no_selection
    evaluations: [],
    selected: null,
    settlement: null,
    error: null,
    createdAt: Date.now(),
  });
  return jobId;
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  try {
    const result = await selectTracks({
      brief: job.brief, budget: job.budget, pricePerTrack: job.pricePerTrack, catalog: TRACKS,
      evaluateFn: async (brief, track) => {
        const { evaluateFit } = require("./src/agent");
        const evalResult = await evaluateFit(brief, track);
        job.evaluations.push({ track: { id: track.id, title: track.title, genre: track.genre, era: track.era, mood: track.mood, vocals: track.vocals, explicit: track.explicit, artistKey: track.artistKey }, ...evalResult });
        return evalResult;
      },
    });

    job.selected = result.selected.map((t) => t.id);
    job.totalCost = result.totalCost;

    if (result.selected.length === 0) {
      job.status = "no_selection";
      return;
    }

    job.status = "settling";
    const settled = await settleSelection({
      selected: result.selected,
      fpByTrackId: catalogState.fingerprintByTrackId,
      pricePerTrack: job.pricePerTrack,
      company, ingestor, artistWalletByKey,
      usdc, pool, claimContract, ingestorUrl: INGESTOR_URL,
      onStep: (event, data) => { job.lastStep = { event, data, at: Date.now() }; },
    });

    job.settlement = settled;
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = e.message;
    console.error(`[acquire ${jobId}]`, e);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", network: NETWORK, company: company.address, artists: Object.keys(artistWalletByKey) });
});

app.post("/api/acquire", (req, res) => {
  if (!checkRateLimit(req, res)) return; // already responded

  const { brief, budget } = req.body || {};
  if (!brief || typeof brief !== "string" || !brief.trim()) {
    return res.status(400).json({ error: "brief is required" });
  }
  const budgetNum = Number(budget);
  if (!(budgetNum > 0)) {
    return res.status(400).json({ error: "budget must be a positive number" });
  }

  const jobId = newJob(brief.trim(), budgetNum);
  runJob(jobId); // fire-and-forget — client polls GET /api/acquire/:jobId
  res.status(202).json({ jobId });
});

app.get("/api/acquire/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "unknown jobId" });
  res.json(job);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nAcquisitionAgent server — real judgment, real settlement`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Network: ${NETWORK}`);
    console.log(`  Company: ${company.address}`);
    console.log(`  POST /api/acquire   { brief, budget }`);
    console.log(`  GET  /api/acquire/:jobId`);
    console.log(`  GET  /health\n`);
  });
}

module.exports = app;
