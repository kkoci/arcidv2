/**
 * deploy_bond_v2.js — Redeploy ArcIDBond alone (tiered-adjudication Phase 4's
 * proportional-slashing contract), pointed at the EXISTING, already-verified
 * ArcIDRegistryV2 and the EXISTING USDC token. Does NOT touch the identity
 * layer — no new registry, no new DCAPVerifier (CLAUDE.md forbids
 * redeploying those). Does NOT auto-post a bond — deploy, .env update, and
 * re-bonding are kept as three distinct, separately-confirmed steps per the
 * user's explicit staged rollout.
 *
 * The registry address is READ FROM deployments/arcTestnet_standalone.json,
 * never from the root .env's ARCID_REGISTRY_ADDRESS — that env var points at
 * a different, older registry deployment and would silently gate out both
 * currently-registered agents if used here.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_bond_v2.js --network arcTestnet
 *   npx hardhat run scripts/deploy_bond_v2.js --network hardhat   # local sanity check
 */

const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");

const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";

async function main() {
  const { ethers, network } = hre;
  const isLocal = network.name === "hardhat" || network.name === "localhost";

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  console.log(`\n${"─".repeat(60)}`);
  console.log("ArcIDBond redeploy — tiered-adjudication Phase 4 (post-submission)");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployerAddr}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployerAddr))} ETH`);

  let collateralAddress, registryAddress;

  if (isLocal) {
    const MockUSDC     = await ethers.getContractFactory("MockUSDC");
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    const usdc     = await MockUSDC.deploy();
    const registry = await MockRegistry.deploy();
    collateralAddress = await usdc.getAddress();
    registryAddress   = await registry.getAddress();
    await registry.setVerified(deployerAddr, ethers.id("local-sanity-check"));
    console.log(`\n[local] MockUSDC:     ${collateralAddress}`);
    console.log(`[local] MockRegistry: ${registryAddress}`);
  } else {
    const standaloneFile = path.resolve(__dirname, `../deployments/${network.name}_standalone.json`);
    if (!fs.existsSync(standaloneFile)) {
      throw new Error(`Missing ${standaloneFile} — cannot determine the existing, verified ArcIDRegistryV2 address.`);
    }
    const standalone = JSON.parse(fs.readFileSync(standaloneFile, "utf8"));
    registryAddress   = standalone.addresses.ArcIDRegistryV2;
    collateralAddress = USDC_ARC_TESTNET;
    console.log(`\n[live] ArcIDRegistryV2 (existing, unmodified): ${registryAddress}`);
    console.log(`[live] USDC (existing):                        ${collateralAddress}`);
  }

  console.log(`\n→ Deploying ArcIDBond(collateralToken, registry)...`);
  const ArcIDBond = await ethers.getContractFactory("ArcIDBond");
  const bond = await ArcIDBond.deploy(collateralAddress, registryAddress);
  await bond.waitForDeployment();
  const bondAddress = await bond.getAddress();

  console.log(`\n✓ ArcIDBond deployed → ${bondAddress}`);
  console.log(`  collateralToken:   ${await bond.collateralToken()}`);
  console.log(`  registry:          ${await bond.registry()}`);
  console.log(`  authorizedSlasher: ${await bond.authorizedSlasher()}`);
  console.log(`  semanticCapBps:    ${await bond.semanticCapBps()}`);
  console.log(`  hardCapBps:        ${await bond.hardCapBps()}`);
  console.log(`  serviceFeeAtomic:  ${await bond.serviceFeeAtomic()}`);

  const deployDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployerAddr,
    timestamp: Math.floor(Date.now() / 1000),
    note: "ArcIDBond only — tiered-adjudication Phase 4 (proportional slashing). Registry and USDC unchanged from the existing standalone deployment.",
    addresses: {
      ArcIDBond:       bondAddress,
      ArcIDRegistryV2: registryAddress,
      collateralToken: collateralAddress,
    },
  };

  const outPath = path.join(deployDir, `${network.name}_bond_v2.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[saved] ${outPath}`);
  console.log(`\nNext steps (do NOT auto-run — separate, confirmed steps):`);
  console.log(`  1. Update BOND_CONTRACT_ADDRESS in consumer/.env and oracle/.env to ${bondAddress}`);
  console.log(`  2. Re-bond each active agent: npm run bond:post -- --key <agent-key> --network ${network.name}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
