/**
 * verify_gating.js — Standalone proof-of-gating demo script.
 *
 * Run against a deployed ArcIDBond to show the revert message an unverified
 * wallet receives.  This is the screenshot/clip for the submission video.
 *
 * Usage:
 *   npx hardhat run scripts/verify_gating.js --network arcTestnet
 *   npx hardhat run scripts/verify_gating.js --network hardhat
 *
 * Reads the bond address from deployments/<network>.json (written by deploy.js).
 */

const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");

async function main() {
  const { ethers, network } = hre;

  const deploymentPath = path.resolve(
    __dirname, "..", "deployments", `${network.name}.json`
  );

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      `No deployment found at ${deploymentPath}. Run deploy.js first.`
    );
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const bondAddress = deployment.addresses.ArcIDBond;
  if (!bondAddress) throw new Error("ArcIDBond address missing from deployment file.");

  const bond = await ethers.getContractAt("ArcIDBond", bondAddress);

  console.log(`\n=== ArcIDBond Gating Verification ===`);
  console.log(`Network:    ${network.name}`);
  console.log(`Bond:       ${bondAddress}`);
  console.log(`Registry:   ${await bond.registry()}`);
  console.log(`Collateral: ${await bond.collateralToken()}`);

  // ─── Case 1: unverified random wallet ─────────────────────────────────────
  const unverified = ethers.Wallet.createRandom();
  console.log(`\n[1] Unverified wallet: ${unverified.address}`);
  console.log(`    → calling postBond(5_000_000)...`);

  try {
    await bond.connect(unverified.connect(ethers.provider)).postBond.staticCall(5_000_000n);
    console.log("    ✗ DID NOT REVERT — check registry setup!");
  } catch (err) {
    const snippet = (err.message || "").slice(0, 200);
    if (snippet.includes("Agent not TEE-verified in ArcID registry")) {
      console.log('    ✓ REVERTED: "Agent not TEE-verified in ArcID registry"');
    } else {
      console.log(`    REVERTED (unexpected): ${snippet}`);
    }
  }

  // ─── Case 2: verified agent (deployer) ────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  const isActive = await bond.isActiveBondedAgent(await deployer.getAddress());
  console.log(`\n[2] Verified deployer: ${await deployer.getAddress()}`);
  console.log(`    isActiveBondedAgent: ${isActive}`);

  const b = await bond.bonds(await deployer.getAddress());
  if (b.postedAt > 0n) {
    console.log(`    bond.amount:  ${b.amount.toString()} (${Number(b.amount) / 1e6} USDC)`);
    console.log(`    bond.slashed: ${b.slashed}`);
  } else {
    console.log(`    (no bond posted yet — run deploy.js to post the initial bond)`);
  }

  console.log(`\n=== Gating check complete ===\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
