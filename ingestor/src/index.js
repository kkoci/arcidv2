"use strict";
/**
 * index.js — the ingestion enclave's HTTP service. Same shape as
 * oracle/src/index.js: a small Express app, deployed the same way (Docker
 * container inside a real Phala TDX CVM — see Dockerfile /
 * docker-compose.phala.yml). Exposes the real ingestion+allocation
 * workload (ingestor/src/allocator.js) over one endpoint, plus health and
 * attestation routes mirroring the oracle's.
 */

const express = require("express");
const { ethers } = require("ethers");
const config = require("./config");
const { ingest } = require("./allocator");
const { signAllocation, wallet } = require("./signer");
const { getAttestation } = require("./attest");

const ARTIST_REGISTRY_ABI = [
  "function artistOf(bytes32 fingerprintHash) view returns (address)",
];
const TRAINING_POOL_ABI = [
  "function pools(uint256 poolId) view returns (address company, bytes32 corpusRoot, uint256 amount, bool distributed, bool withdrawn)",
];
const RIGHTS_CLAIM_BOND_ABI = [
  "function isLicensable(bytes32 fingerprintHash) view returns (bool)",
];

const app = express();
app.use(express.json({ limit: "2mb" })); // demo-scope corpora only — tens of tracks, not millions

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", ingestor: wallet.address });
});

app.get("/api/attest", async (req, res) => {
  try {
    const attestation = await getAttestation();
    res.json(attestation);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/ingest  { poolId, corpus: string[] }
 *
 * corpus is the AI company's claimed list of fingerprintHashes for this
 * pool's training run. Reads the pool's committed corpusRoot + escrowed
 * amount from TrainingPool on-chain, resolves each track's owner from
 * ArtistRegistry on-chain, runs the real integrity + licensing + equal-
 * split allocation logic (ingestor/src/allocator.js), and signs the
 * result with the TEE-registered ingestor wallet.
 */
app.post("/api/ingest", async (req, res) => {
  try {
    const { poolId, corpus } = req.body || {};
    if (poolId == null) return res.status(400).json({ error: "poolId is required" });
    if (!Array.isArray(corpus) || corpus.length === 0) {
      return res.status(400).json({ error: "corpus must be a non-empty array of fingerprintHash strings" });
    }
    if (!config.ARTIST_REGISTRY_ADDRESS || !config.TRAINING_POOL_ADDRESS) {
      return res.status(500).json({ error: "ARTIST_REGISTRY_ADDRESS / TRAINING_POOL_ADDRESS not configured" });
    }

    const provider = new ethers.JsonRpcProvider(config.ARC_RPC_URL);
    const registry = new ethers.Contract(config.ARTIST_REGISTRY_ADDRESS, ARTIST_REGISTRY_ABI, provider);
    const pool     = new ethers.Contract(config.TRAINING_POOL_ADDRESS, TRAINING_POOL_ABI, provider);

    const onChainPool = await pool.pools(poolId);
    if (onChainPool.company === ethers.ZeroAddress) {
      return res.status(404).json({ error: `poolId ${poolId} not found on-chain` });
    }

    // Rights-Claim Bonding gate (post-submission — see CHANGELOG.md) —
    // strictly opt-in via config, so the existing AcquisitionAgent demo
    // catalog (never claim-bonded) keeps working unchanged by default.
    let checkLicensable;
    if (config.RIGHTS_CLAIM_BOND_ADDRESS) {
      const rightsBond = new ethers.Contract(config.RIGHTS_CLAIM_BOND_ADDRESS, RIGHTS_CLAIM_BOND_ABI, provider);
      checkLicensable = (fp) => rightsBond.isLicensable(fp);
    }

    const result = await ingest({
      corpus,
      committedCorpusRoot: onChainPool.corpusRoot,
      poolAmount: onChainPool.amount,
      resolveArtist: (fp) => registry.artistOf(fp),
      checkLicensable,
    });

    const signature = await signAllocation(poolId, result.allocationRoot);

    res.json({
      poolId: String(poolId),
      corpusRoot: result.corpusRoot,
      allocationRoot: result.allocationRoot,
      signature,
      ingestor: wallet.address,
      allocations: result.allocations.map((a) => ({
        artist: a.artist,
        amount: a.amount.toString(),
        proof: a.proof,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message, type: e.name });
  }
});

if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log(`Ingestion enclave listening on :${config.PORT} (ingestor: ${wallet.address})`);
  });
}

module.exports = app;
