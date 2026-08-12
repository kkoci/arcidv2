#!/usr/bin/env node
"use strict";
/**
 * demo-training-compensation.js — Licensed AI Training Compensation Rail,
 * the primary demo path: register → deposit → ingest → claim, one real
 * cycle end to end against whichever network is targeted.
 *
 * Same "shells out to a real off-chain worker over HTTP" shape as the rest
 * of this repo's demo scripts (demo-erc8183-job.js fetches from the
 * oracle; this one POSTs to the real ingestion enclave from Phase 3) —
 * NOT bounty-submit.js's spawnSync-a-fresh-Hardhat-EVM shape, because the
 * ingestor is a real standalone service with its own process, not
 * something that needs a throwaway local chain spun up per call.
 *
 * Two demo artists (2 tracks + 1 track), one AI company, one pool — three
 * fresh throwaway wallets generated per run, funded with a little native
 * gas from DEPLOYER_PRIVATE_KEY. On testnet, the company also needs real
 * USDC, transferred from the deployer's own balance (real USDC isn't
 * mintable) — on local/hardhat it's minted directly via MockUSDC's free
 * mint.
 *
 * Requires the ingestion enclave running locally (npm start in
 * ingestor/), same requirement demo-erc8183-job.js already has for the
 * oracle — this script HTTP-fetches the real ingest result, it does not
 * reimplement the allocation logic inline.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=...  in .env (funds the demo wallets)
 *   INGESTOR_PRIVATE_KEY=...  in .env (same key ingestor/.env uses — must
 *                              match CompensationClaim's authorizedIngestor)
 *   npm run demo:training-compensation
 *   npm run demo:training-compensation -- --network hardhat --pool-amount 3.0
 */

const { ethers } = require("ethers");
const {
  parseArgs, requireEnvKey, getProvider,
  loadTrainingCompensationDeployment, getTrainingCompensationContracts,
} = require("./_lib");
const { buildTree } = require("../../ingestor/src/merkle");
const { corpusLeaf } = require("../../ingestor/src/allocator");

const GAS_FUND = "0.01"; // native ETH per demo wallet — enough for a couple of txs each

function fp(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label + ":" + Date.now()));
}

async function main() {
  const args = parseArgs();
  const network      = args.network || "arcTestnet";
  const ingestorUrl  = args["ingestor-url"] || "http://localhost:3002";
  const poolAmountUsdc = parseFloat(args["pool-amount"] ?? "3.0");
  const poolAmount   = BigInt(Math.round(poolAmountUsdc * 1e6));

  const deployerKey  = requireEnvKey("DEPLOYER_PRIVATE_KEY");
  const ingestorKey  = requireEnvKey("INGESTOR_PRIVATE_KEY");

  const provider = getProvider(network);
  const deployer = new ethers.Wallet(deployerKey, provider);
  const ingestor = new ethers.Wallet(ingestorKey, provider);
  const isLocal  = network === "hardhat" || network === "localhost";

  const deploy = loadTrainingCompensationDeployment(network);
  const { artistRegistry, pool, claimContract, usdc } =
    getTrainingCompensationContracts(deploy.addresses, provider);

  console.log(`\n${"─".repeat(60)}`);
  console.log("Licensed AI Training Compensation Rail — demo cycle");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network:  ${network}`);
  console.log(`ArtistRegistry:    ${deploy.addresses.ArtistRegistry}`);
  console.log(`TrainingPool:      ${deploy.addresses.TrainingPool}`);
  console.log(`CompensationClaim: ${deploy.addresses.CompensationClaim}`);
  console.log(`Ingestor:          ${ingestor.address}`);

  // ── 1. Fresh demo wallets: one company, two artists ────────────────────────
  const company = ethers.Wallet.createRandom().connect(provider);
  const artistA = ethers.Wallet.createRandom().connect(provider);
  const artistB = ethers.Wallet.createRandom().connect(provider);
  console.log(`\n→ Generated demo wallets`);
  console.log(`  company: ${company.address}`);
  console.log(`  artistA: ${artistA.address}`);
  console.log(`  artistB: ${artistB.address}`);

  console.log(`\n→ Funding demo wallets with ${GAS_FUND} ETH gas each...`);
  // Explicit, self-incrementing nonce for this tight sequential-send loop —
  // relying on the provider's "pending" nonce lookup per call was observed
  // to occasionally reuse a nonce against a local auto-mining node (a real
  // gotcha hit while verifying this script, not a hypothetical one).
  let nonce = await provider.getTransactionCount(deployer.address, "pending");
  for (const w of [company, artistA, artistB]) {
    const tx = await deployer.sendTransaction({ to: w.address, value: ethers.parseEther(GAS_FUND), nonce: nonce++ });
    await tx.wait();
  }
  console.log(`✓ Funded.`);

  // ── 2. Register tracks — artistA has two, artistB has one ──────────────────
  const rightsHash = ethers.keccak256(ethers.toUtf8Bytes("demo-rights-v1"));
  const fpA1 = fp("song-a1");
  const fpA2 = fp("song-a2");
  const fpB1 = fp("song-b1");

  console.log(`\n→ Registering 3 demo tracks (2 for artistA, 1 for artistB)...`);
  // artistA sends two sequential transactions — same explicit-nonce
  // discipline as the funding loop above, same reason (see that comment).
  let artistANonce = await provider.getTransactionCount(artistA.address, "pending");
  await (await artistRegistry.connect(artistA).registerTrack(fpA1, rightsHash, { nonce: artistANonce++ })).wait();
  await (await artistRegistry.connect(artistA).registerTrack(fpA2, rightsHash, { nonce: artistANonce++ })).wait();
  await (await artistRegistry.connect(artistB).registerTrack(fpB1, rightsHash)).wait();
  console.log(`✓ Registered.`);

  // ── 3. AI company commits the corpus root and funds the pool ───────────────
  const corpus = [fpA1, fpA2, fpB1];
  const { root: corpusRoot } = buildTree(corpus.map(corpusLeaf));

  if (isLocal) {
    const MockUSDC_ABI = ["function mint(address to, uint256 amount) returns (bool)"];
    const mockUsdc = new ethers.Contract(deploy.addresses.collateralToken, MockUSDC_ABI, deployer);
    await (await mockUsdc.mint(company.address, poolAmount)).wait();
    console.log(`\n→ [local] Minted ${poolAmountUsdc} USDC to company.`);
  } else {
    const deployerBal = await usdc.balanceOf(deployer.address);
    if (deployerBal < poolAmount) {
      console.error(
        `\n✗ Deployer has insufficient USDC: have ${Number(deployerBal) / 1e6}, need ${poolAmountUsdc}.` +
        `\n  Fund DEPLOYER_PRIVATE_KEY's wallet with testnet USDC (faucet.circle.com) and retry.\n`
      );
      process.exit(1);
    }
    await (await usdc.connect(deployer).transfer(company.address, poolAmount)).wait();
    console.log(`\n→ Transferred ${poolAmountUsdc} USDC from deployer to company.`);
  }

  const poolId = await pool.nextPoolId(); // createPool below will assign exactly this id
  // Same explicit-nonce discipline as above — company sends two sequential
  // transactions (approve, then createPool).
  let companyNonce = await provider.getTransactionCount(company.address, "pending");
  await (await usdc.connect(company).approve(deploy.addresses.TrainingPool, poolAmount, { nonce: companyNonce++ })).wait();
  await (await pool.connect(company).createPool(corpusRoot, poolAmount, { nonce: companyNonce++ })).wait();
  console.log(`✓ Pool #${poolId} created — ${poolAmountUsdc} USDC escrowed, corpusRoot ${corpusRoot}`);

  // ── 4. Real ingestion — HTTP call to the actual enclave service ────────────
  console.log(`\n→ Calling ingestion enclave at ${ingestorUrl}/api/ingest ...`);
  let ingestResp;
  try {
    const r = await fetch(`${ingestorUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolId: poolId.toString(), corpus }),
    });
    ingestResp = await r.json();
    if (!r.ok) throw new Error(ingestResp.error || `HTTP ${r.status}`);
  } catch (e) {
    console.error(
      `\n✗ Ingestion call failed: ${e.message}` +
      `\n  Is the ingestion enclave running? (cd ingestor && npm start)\n`
    );
    process.exit(1);
  }
  console.log(`✓ Ingested — allocationRoot: ${ingestResp.allocationRoot}`);
  for (const a of ingestResp.allocations) {
    console.log(`  ${a.artist}  →  ${(Number(a.amount) / 1e6).toFixed(2)} USDC`);
  }

  // ── 5. Ingestor submits the attested allocation on-chain ───────────────────
  console.log(`\n→ Submitting allocation on-chain (as the ingestor)...`);
  const submitTx = await claimContract.connect(ingestor).submitAllocation(poolId, ingestResp.allocationRoot);
  const submitReceipt = await submitTx.wait();
  console.log(`✓ submitAllocation() mined → ${submitReceipt.hash}`);

  // ── 6. Each artist claims their real, on-chain-verified share ──────────────
  const walletByAddress = {
    [artistA.address.toLowerCase()]: artistA,
    [artistB.address.toLowerCase()]: artistB,
  };

  console.log(`\n→ Artists claiming their shares...`);
  for (const a of ingestResp.allocations) {
    const wallet = walletByAddress[a.artist.toLowerCase()];
    if (!wallet) { console.log(`  (skipping unknown address ${a.artist})`); continue; }
    const tx = await claimContract.connect(wallet).claim(poolId, BigInt(a.amount), a.proof);
    await tx.wait();
    const bal = await usdc.balanceOf(wallet.address);
    console.log(`  ✓ ${wallet.address === artistA.address ? "artistA" : "artistB"} claimed — balance now ${(Number(bal) / 1e6).toFixed(2)} USDC`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Demo cycle complete — pool #${poolId}, ${poolAmountUsdc} USDC paid out for real.`);
  console.log(`${"─".repeat(60)}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.stack || e.message || e) + "\n");
  process.exit(1);
});
