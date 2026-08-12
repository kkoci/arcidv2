#!/usr/bin/env node
"use strict";
/**
 * demo-acquisition.js — the real judgment layer, end to end: an
 * AcquisitionAgent evaluates a creative brief against a demo track
 * catalog with a real Claude call per track (acquisition/src/agent.js),
 * selects a subset within budget, and hands that selection off — as
 * plain data, a corpus of fingerprint hashes — to the EXACT SAME
 * deterministic settlement machinery demo-training-compensation.js
 * already uses: fund pool -> real ingestion enclave -> submit allocation
 * -> artists claim. The agent has no authority over any of that; it only
 * decides which tracks go into the corpus commitment before the pool is
 * even created.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=...  in .env (funds the demo wallets)
 *   INGESTOR_PRIVATE_KEY=...  in .env (must match CompensationClaim's authorizedIngestor)
 *   ANTHROPIC_API_KEY=...     in .env (the agent's real judgment calls)
 *   npm run demo:acquisition -- --brief "energetic late-90s alt-rock, female vocals, no explicit lyrics"
 *   npm run demo:acquisition -- --brief "moody instrumental synthwave for a night drive" --budget 2.0
 *
 * Requires the ingestion enclave running locally (npm start in ingestor/),
 * same requirement demo-training-compensation.js already has.
 */

const { ethers } = require("ethers");
const {
  parseArgs, requireEnvKey, getProvider,
  loadTrainingCompensationDeployment, getTrainingCompensationContracts,
} = require("./_lib");
const { selectTracks } = require("../../acquisition/src/agent");
const { TRACKS } = require("../../acquisition/src/catalog");
const { settleSelection } = require("../../acquisition/src/settle");

const GAS_FUND = "0.01"; // native ETH per demo wallet

async function main() {
  const args = parseArgs();
  const brief = args.brief;
  if (!brief) {
    console.error(`\nMissing required flag: --brief "..."\n`);
    process.exit(1);
  }
  const network        = args.network || "arcTestnet";
  const ingestorUrl     = args["ingestor-url"] || "http://localhost:3002";
  const budget          = parseFloat(args.budget ?? "3.0");
  const pricePerTrack   = parseFloat(args["price-per-track"] ?? "1.0");

  const deployerKey = requireEnvKey("DEPLOYER_PRIVATE_KEY");
  const ingestorKey = requireEnvKey("INGESTOR_PRIVATE_KEY");
  requireEnvKey("ANTHROPIC_API_KEY"); // the agent's own judgment calls need this

  const provider = getProvider(network);
  const deployer = new ethers.Wallet(deployerKey, provider);
  const ingestor = new ethers.Wallet(ingestorKey, provider);
  const isLocal  = network === "hardhat" || network === "localhost";

  const deploy = loadTrainingCompensationDeployment(network);
  const { artistRegistry, pool, claimContract, usdc } =
    getTrainingCompensationContracts(deploy.addresses, provider);

  console.log(`\n${"─".repeat(60)}`);
  console.log("AcquisitionAgent demo — real judgment, then real settlement");
  console.log(`${"─".repeat(60)}`);
  console.log(`Brief:  "${brief}"`);
  console.log(`Budget: $${budget.toFixed(2)} @ $${pricePerTrack.toFixed(2)}/track`);
  console.log(`Network: ${network}`);

  // ── 1. Fresh demo wallets — one per artist key in the catalog, plus company ──
  const artistKeys = [...new Set(TRACKS.map((t) => t.artistKey))]; // ["A","B","C"]
  const company = ethers.Wallet.createRandom().connect(provider);
  const artistWallets = {};
  for (const key of artistKeys) artistWallets[key] = ethers.Wallet.createRandom().connect(provider);

  console.log(`\n→ Funding ${1 + artistKeys.length} demo wallets with ${GAS_FUND} ETH gas each...`);
  let deployerNonce = await provider.getTransactionCount(deployer.address, "pending");
  for (const w of [company, ...Object.values(artistWallets)]) {
    const tx = await deployer.sendTransaction({ to: w.address, value: ethers.parseEther(GAS_FUND), nonce: deployerNonce++ });
    await tx.wait();
  }
  console.log(`✓ Funded — company + artists: ${artistKeys.join(", ")}`);

  // ── 2. Register the FULL catalog — every artist opts in ahead of time,
  //      independent of which tracks any one buyer ends up selecting. ──
  console.log(`\n→ Registering ${TRACKS.length} catalog tracks across ${artistKeys.length} artists...`);
  const rightsHash = ethers.keccak256(ethers.toUtf8Bytes("demo-rights-v1"));
  const fpByTrackId = {};
  const nonceByArtist = {};
  for (const key of artistKeys) {
    nonceByArtist[key] = await provider.getTransactionCount(artistWallets[key].address, "pending");
  }
  for (const track of TRACKS) {
    const fp = ethers.keccak256(ethers.toUtf8Bytes(`${track.id}:${Date.now()}:${Math.random()}`));
    fpByTrackId[track.id] = fp;
    const wallet = artistWallets[track.artistKey];
    const tx = await artistRegistry.connect(wallet).registerTrack(fp, rightsHash, { nonce: nonceByArtist[track.artistKey]++ });
    await tx.wait();
  }
  console.log(`✓ Registered:`);
  for (const t of TRACKS) console.log(`  ${t.id.padEnd(20)} artist ${t.artistKey}  ${t.genre}/${t.era}/${t.mood}/${t.vocals}${t.explicit ? " [explicit]" : ""}`);

  // ── 3. The real judgment call — one Claude call per candidate track ──
  console.log(`\n→ AcquisitionAgent evaluating ${TRACKS.length} candidates against the brief (real Claude calls)...`);
  const result = await selectTracks({ brief, budget, pricePerTrack, catalog: TRACKS });

  console.log(`\nEvaluations:`);
  for (const e of result.evaluations) {
    console.log(`  ${e.fits ? "✓ FIT    " : "✗ no fit "} ${e.track.id.padEnd(20)} ${e.reason}`);
  }
  console.log(`\nSelected (${result.selected.length}, $${result.totalCost.toFixed(2)} of $${budget.toFixed(2)} budget):`);
  for (const t of result.selected) console.log(`  ${t.id} (artist ${t.artistKey})`);

  if (result.selected.length === 0) {
    console.log(`\nNo tracks selected — nothing to settle. Try a different brief or budget.\n`);
    return;
  }

  // ── 4. Hand off to the EXISTING, unmodified settlement machinery — the
  //      agent's job ends here. settleSelection() is the exact same
  //      function acquisition/server.js uses — one implementation, not
  //      two copies. ──
  const poolAmount = BigInt(Math.round(result.totalCost * 1e6));
  if (isLocal) {
    const MockUSDC_ABI = ["function mint(address to, uint256 amount) returns (bool)"];
    const mockUsdc = new ethers.Contract(deploy.addresses.collateralToken, MockUSDC_ABI, deployer);
    await (await mockUsdc.mint(company.address, poolAmount)).wait();
  } else {
    const deployerBal = await usdc.balanceOf(deployer.address);
    if (deployerBal < poolAmount) {
      console.error(`\n✗ Deployer has insufficient USDC: have ${Number(deployerBal) / 1e6}, need ${result.totalCost}.\n`);
      process.exit(1);
    }
    await (await usdc.connect(deployer).transfer(company.address, poolAmount)).wait();
  }

  const settled = await settleSelection({
    selected: result.selected,
    fpByTrackId,
    pricePerTrack,
    company,
    ingestor,
    artistWalletByKey: artistWallets,
    usdc, pool, claimContract, ingestorUrl,
    onStep: (event, data) => console.log(`  · ${event} ${JSON.stringify(data)}`),
  });

  console.log(`\n✓ Pool #${settled.poolId} created — $${settled.poolAmountUsdc.toFixed(2)} escrowed over the agent's own selection, corpusRoot ${settled.corpusRoot}`);
  console.log(`✓ Ingested — allocationRoot: ${settled.allocationRoot}`);
  console.log(`✓ submitAllocation() mined → ${settled.submitAllocationTx}`);
  console.log(`\n→ Winning artists claimed:`);
  for (const c of settled.claims) console.log(`  ✓ artist ${c.artistKey} claimed $${c.amountUsdc.toFixed(2)} — tx ${c.tx}`);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Real judgment, real settlement — pool #${settled.poolId}, $${settled.poolAmountUsdc.toFixed(2)} paid for tracks the agent actually chose.`);
  console.log(`${"─".repeat(60)}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.stack || e.message || e) + "\n");
  process.exit(1);
});
