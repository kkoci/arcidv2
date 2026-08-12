/**
 * deploy_rights_claim_bond.js — Deploy RightsClaimBond pointed at the
 * EXISTING ArtistRegistry and collateral token from the training-
 * compensation deployment (reused, not redeployed — same discipline as
 * every other deploy_*.js in this repo).
 *
 * disputeWindow is intentionally short here (2 minutes) — a demo-scale
 * value so a live run can actually wait it out, same "scaled for demo,
 * stated plainly" pattern CLAUDE.md already documents for
 * ArcIDBond.challengeThreshold. A real deployment would use something on
 * the order of days, tunable later via setDisputeWindow() without a
 * redeploy.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_rights_claim_bond.js --network arcTestnet
 *   npx hardhat run scripts/deploy_rights_claim_bond.js --network hardhat   # local sanity check
 */

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");

const DEMO_DISPUTE_WINDOW_SECONDS = 120;

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();

  console.log(`\n${"─".repeat(60)}`);
  console.log("RightsClaimBond deploy — Tier 1 rights-claim bonding");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  const deployFile = path.resolve(__dirname, `../deployments/${network.name}_training_compensation.json`);
  if (!fs.existsSync(deployFile)) {
    throw new Error(`Missing ${deployFile} — run deploy_training_compensation.js for this network first.`);
  }
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf8"));
  console.log(`Reusing existing ArtistRegistry: ${deploy.addresses.ArtistRegistry}`);
  console.log(`Reusing existing collateralToken: ${deploy.addresses.collateralToken}`);

  const RightsClaimBond = await ethers.getContractFactory("RightsClaimBond");
  const bond = await RightsClaimBond.deploy(
    deploy.addresses.collateralToken,
    deploy.addresses.ArtistRegistry,
    DEMO_DISPUTE_WINDOW_SECONDS
  );
  await bond.waitForDeployment();
  const bondAddress = await bond.getAddress();
  console.log(`✓ RightsClaimBond deployed → ${bondAddress}`);
  console.log(`  disputeWindow: ${DEMO_DISPUTE_WINDOW_SECONDS}s (demo-scale, see this script's own header comment)`);

  const out = {
    network: network.name,
    timestamp: Math.floor(Date.now() / 1000),
    addresses: {
      RightsClaimBond: bondAddress,
      ArtistRegistry: deploy.addresses.ArtistRegistry,
      collateralToken: deploy.addresses.collateralToken,
    },
    disputeWindowSeconds: DEMO_DISPUTE_WINDOW_SECONDS,
  };
  const outPath = path.resolve(__dirname, `../deployments/${network.name}_rights_claim_bond.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[saved] ${outPath}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
