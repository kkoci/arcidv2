/**
 * deploy_training_compensation.js — Deploy the Licensed AI Training
 * Compensation Rail vertical (ArtistRegistry, TrainingPool,
 * CompensationClaim), pointed at the EXISTING, already-verified
 * ArcIDRegistryV2 and the EXISTING USDC token — same "don't touch the
 * identity layer" discipline as deploy_bond_v2.js / deploy_exploit_bounty.js.
 * Registry address is read from deployments/<network>_standalone.json,
 * never from a stale env var.
 *
 * Also provisions a DEDICATED ingestor wallet for this vertical (separate
 * from the oracle/consumer/bounty-verifier wallets — avoids nonce
 * contention with any other running vertical):
 *   1. Generate a fresh wallet (or reuse one already at
 *      INGESTOR_PRIVATE_KEY in .env, if set — idempotent re-run).
 *   2. On testnet: fund it with a small amount of native gas.
 *   3. Register it in the EXISTING ArcIDRegistryV2 (same DCAP-prototype-
 *      quote flow deploy_standalone.js / deploy_exploit_bounty.js already use).
 *   4. Wire CompensationClaim.setAuthorizedIngestor(ingestor) — the EOA
 *      that submits allocations — AND TrainingPool.setAuthorizedDistributor
 *      (the CompensationClaim CONTRACT address, not the ingestor EOA —
 *      submitAllocation() calls trainingPool.distributeToClaimContract()
 *      as CompensationClaim itself, so that's the caller TrainingPool
 *      needs to trust).
 *
 * The generated private key is written directly to .env (INGESTOR_*) and
 * never printed to stdout — same rule as every other scripts/deploy_*.js.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_training_compensation.js --network arcTestnet
 *   npx hardhat run scripts/deploy_training_compensation.js --network hardhat   # local sanity check
 */

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");
const { buildAttestation } = require("./cli/_lib");

const USDC_ARC_TESTNET  = "0x3600000000000000000000000000000000000000";
const INGESTOR_GAS_FUND = "0.01"; // native ETH, just enough for register + a few submitAllocation txs
const ENV_PATH = path.resolve(__dirname, "..", ".env");

function upsertEnvVar(name, value) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.replace(/\n?$/, "\n") + line + "\n";
  }
  fs.writeFileSync(ENV_PATH, content);
}

async function main() {
  const { ethers, network } = hre;
  const isLocal = network.name === "hardhat" || network.name === "localhost";

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  console.log(`\n${"─".repeat(60)}`);
  console.log("Licensed AI Training Compensation Rail — deploy");
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

  console.log(`\n→ Deploying ArtistRegistry()...`);
  const ArtistRegistry = await ethers.getContractFactory("ArtistRegistry");
  const artistRegistry = await ArtistRegistry.deploy();
  await artistRegistry.waitForDeployment();
  const artistRegistryAddress = await artistRegistry.getAddress();
  console.log(`✓ ArtistRegistry deployed → ${artistRegistryAddress}`);

  console.log(`\n→ Deploying TrainingPool(collateralToken)...`);
  const TrainingPool = await ethers.getContractFactory("TrainingPool");
  const pool = await TrainingPool.deploy(collateralAddress);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`✓ TrainingPool deployed → ${poolAddress}`);

  console.log(`\n→ Deploying CompensationClaim(collateralToken, registry, trainingPool)...`);
  const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
  const claimContract = await CompensationClaim.deploy(collateralAddress, registryAddress, poolAddress);
  await claimContract.waitForDeployment();
  const claimAddress = await claimContract.getAddress();
  console.log(`✓ CompensationClaim deployed → ${claimAddress}`);

  // ── Ingestor wallet: generate-or-reuse, fund, register, wire ──────────────
  let ingestorWallet;
  if (isLocal) {
    // Local sanity check — reuse one of Hardhat's own funded signers so no
    // funding step or real registration flow is needed to smoke-test wiring.
    const signers = await ethers.getSigners();
    ingestorWallet = signers[1];
    console.log(`\n[local] Using Hardhat signer #1 as ingestor: ${ingestorWallet.address}`);

    const registry = await ethers.getContractAt("MockRegistry", registryAddress);
    await (await registry.setVerified(ingestorWallet.address, ethers.id("local-training-ingestor"))).wait();
    console.log(`[local] Ingestor registered as TEE-verified.`);
  } else {
    let key = process.env.INGESTOR_PRIVATE_KEY;
    let reused = false;
    if (key) {
      reused = true;
      ingestorWallet = new ethers.Wallet(key, ethers.provider);
      console.log(`\n→ Reusing existing INGESTOR_PRIVATE_KEY: ${ingestorWallet.address}`);
    } else {
      const fresh = ethers.Wallet.createRandom();
      ingestorWallet = fresh.connect(ethers.provider);
      key = fresh.privateKey;
      console.log(`\n→ Generated a fresh ingestor wallet: ${ingestorWallet.address}`);
      console.log(`  (private key written to .env as INGESTOR_PRIVATE_KEY — not printed here)`);
    }

    const registry = await ethers.getContractAt("ArcIDRegistryV2", registryAddress);
    const existingAgentId = await registry.agentIdBySigner(ingestorWallet.address);

    if (existingAgentId !== ethers.ZeroHash) {
      console.log(`  Already registered — agentId: ${existingAgentId}`);
    } else {
      const ingestorBalance = await ethers.provider.getBalance(ingestorWallet.address);
      if (ingestorBalance < ethers.parseEther(INGESTOR_GAS_FUND) / 2n) {
        console.log(`  → Funding ingestor with ${INGESTOR_GAS_FUND} ETH for gas...`);
        const fundTx = await deployer.sendTransaction({
          to: ingestorWallet.address,
          value: ethers.parseEther(INGESTOR_GAS_FUND),
        });
        await fundTx.wait();
        console.log(`  ✓ Funded — tx: ${fundTx.hash}`);
      }

      console.log(`  → Building DCAP attestation quote...`);
      const { dcapQuote, reportDataSig, reportData } = buildAttestation(
        ingestorWallet.address,
        key,
        "arcidv2-training-ingestor"
      );
      console.log(`    reportData: ${reportData}`);

      const regTx = await registry.connect(ingestorWallet).registerAgent(dcapQuote, reportDataSig);
      const regReceipt = await regTx.wait();
      const agentId = await registry.agentIdBySigner(ingestorWallet.address);
      console.log(`  ✓ registerAgent() mined → ${regReceipt.hash}`);
      console.log(`    agentId: ${agentId}`);
      if (agentId === ethers.ZeroHash) throw new Error("Ingestor registration failed — agentId is zero");
    }

    if (!reused) {
      upsertEnvVar("INGESTOR_PRIVATE_KEY", key);
      upsertEnvVar("INGESTOR_WALLET_ADDRESS", ingestorWallet.address);
      console.log(`\n[saved] INGESTOR_PRIVATE_KEY + INGESTOR_WALLET_ADDRESS written to .env`);
    }
  }

  console.log(`\n→ Wiring CompensationClaim.setAuthorizedIngestor(${ingestorWallet.address})...`);
  await (await claimContract.connect(deployer).setAuthorizedIngestor(ingestorWallet.address)).wait();
  console.log(`✓ setAuthorizedIngestor() mined`);

  console.log(`\n→ Wiring TrainingPool.setAuthorizedDistributor(${claimAddress}) — the CompensationClaim CONTRACT, not the ingestor EOA...`);
  await (await pool.connect(deployer).setAuthorizedDistributor(claimAddress)).wait();
  console.log(`✓ setAuthorizedDistributor() mined`);

  console.log(`\nDeployed state:`);
  console.log(`  ArtistRegistry:              ${artistRegistryAddress}`);
  console.log(`  TrainingPool:                ${poolAddress}`);
  console.log(`    authorizedDistributor:      ${await pool.authorizedDistributor()}`);
  console.log(`  CompensationClaim:           ${claimAddress}`);
  console.log(`    authorizedIngestor:         ${await claimContract.authorizedIngestor()}`);
  console.log(`  Ingestor wallet:             ${ingestorWallet.address}`);

  const deployDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployerAddr,
    timestamp: Math.floor(Date.now() / 1000),
    addresses: {
      ArtistRegistry:     artistRegistryAddress,
      TrainingPool:        poolAddress,
      CompensationClaim:   claimAddress,
      ArcIDRegistryV2:     registryAddress,
      collateralToken:     collateralAddress,
    },
    ingestor: {
      address: ingestorWallet.address,
    },
  };

  const outPath = path.join(deployDir, `${network.name}_training_compensation.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[saved] ${outPath}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
