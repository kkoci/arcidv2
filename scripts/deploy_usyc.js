/**
 * deploy_usyc.js — Deploy ArcIDBond with USYC yield-bearing collateral (Phase 5)
 *
 * On local/hardhat: deploys MockUSYC + MockRegistry + ArcIDBond, simulates yield,
 *   posts a bond, and prints the yield narrative.
 *
 * On Arc testnet: deploys ArcIDBond pointing at the real USYC token and
 *   ArcIDRegistry.  Attempts to post a bond via the Teller (mint USDC→USYC).
 *   If the wallet isn't allowlisted for USYC, the contract is still deployed and
 *   verified — "deployed, awaiting allowlist" is a stronger exit than a hand-wave.
 *
 * Usage:
 *   npm run deploy:usyc:local
 *   npm run deploy:usyc:arc
 */

require("dotenv").config();
const { ethers, network } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Arc testnet addresses
// ---------------------------------------------------------------------------

const ARC = {
  USDC:        "0x3600000000000000000000000000000000000000",
  USYC:        "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
  TELLER:      "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
  REGISTRY:    process.env.ARC_REGISTRY_ADDRESS || "0x0000000000000000000000000000000000000000",
};

const USYC_BOND_AMOUNT = ethers.parseUnits("5", 8); // 5 USYC (8 decimals)
const USDC_DEPOSIT     = ethers.parseUnits("5", 6); // 5 USDC to mint USYC

// ---------------------------------------------------------------------------
// Minimal ABIs
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

const TELLER_ABI = [
  "function deposit(address depositAsset, uint256 depositAmount, uint256 minimumMint) returns (uint256 shares)",
  "function sharePrice() view returns (uint256)",
];

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const isArcTestnet = network.name === "arcTestnet";
  const [deployer]   = await ethers.getSigners();

  console.log(`\n${"─".repeat(60)}`);
  console.log("ArcIDBond (USYC) — Phase 5 Deploy");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  let collateralToken, registry, usycAddress;

  if (isArcTestnet) {
    // ── Arc testnet — use real contracts ──────────────────────────────────────
    console.log("\n[live] Using real USYC + ArcIDRegistry on Arc testnet");
    usycAddress      = ARC.USYC;
    const registryAddress = ARC.REGISTRY;

    if (registryAddress === "0x0000000000000000000000000000000000000000") {
      throw new Error("Set ARC_REGISTRY_ADDRESS in .env before deploying to Arc testnet");
    }

    collateralToken = ARC.USYC;
    registry        = registryAddress;
  } else {
    // ── Local Hardhat — deploy mocks ──────────────────────────────────────────
    console.log("\n[local] Deploying MockUSYC + MockRegistry");

    const MockUSYC     = await ethers.getContractFactory("MockUSYC");
    const MockRegistry = await ethers.getContractFactory("MockRegistry");

    const mockUSYC     = await MockUSYC.deploy();
    const mockRegistry = await MockRegistry.deploy();

    console.log(`  MockUSYC:     ${await mockUSYC.getAddress()}`);
    console.log(`  MockRegistry: ${await mockRegistry.getAddress()}`);

    // Verify the deployer so they can postBond in the local demo
    await mockRegistry.setVerified(deployer.address, ethers.id("deployer-usyc-agent"));
    console.log(`  Deployer TEE-verified in MockRegistry`);

    collateralToken = await mockUSYC.getAddress();
    registry        = await mockRegistry.getAddress();
    usycAddress     = await mockUSYC.getAddress();
  }

  // ── Deploy ArcIDBond with USYC collateral ────────────────────────────────────
  console.log("\n[deploy] ArcIDBond (collateral=USYC)...");
  const ArcIDBond  = await ethers.getContractFactory("ArcIDBond");
  const bond       = await ArcIDBond.deploy(collateralToken, registry);
  const bondAddr   = await bond.getAddress();
  console.log(`  ArcIDBond (USYC): ${bondAddr}`);

  // ── Mint USYC and post bond ─────────────────────────────────────────────────
  if (!isArcTestnet) {
    await localBondDemo(deployer, usycAddress, bondAddr);
  } else {
    await arcBondAttempt(deployer, bondAddr);
  }

  // ── Save deployment ──────────────────────────────────────────────────────────
  const deployFile = path.resolve(__dirname, `../deployments/${network.name}_usyc.json`);
  const deployDir  = path.dirname(deployFile);
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });

  const output = {
    network:      network.name,
    deployedAt:   new Date().toISOString(),
    arcIDBondUSYC: bondAddr,
    collateral:   "USYC",
    usycToken:    isArcTestnet ? ARC.USYC : usycAddress,
    teller:       isArcTestnet ? ARC.TELLER : null,
  };

  fs.writeFileSync(deployFile, JSON.stringify(output, null, 2));
  console.log(`\n[saved] ${deployFile}`);
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Local demo — simulates the full yield narrative
// ---------------------------------------------------------------------------

async function localBondDemo(deployer, usycAddr, bondAddr) {
  const mockUSYC = await ethers.getContractAt("MockUSYC", usycAddr);
  const bond     = await ethers.getContractAt("ArcIDBond", bondAddr);

  // Mint USYC to deployer
  await mockUSYC.mint(deployer.address, USYC_BOND_AMOUNT);
  await mockUSYC.connect(deployer).approve(bondAddr, USYC_BOND_AMOUNT);

  console.log("\n[demo] Posting 5 USYC bond...");
  await bond.connect(deployer).postBond(USYC_BOND_AMOUNT);

  const isActive = await bond.isActiveBondedAgent(deployer.address);
  console.log(`  isActiveBondedAgent: ${isActive}`);

  const { amount } = await bond.bonds(deployer.address);
  const valueBefore = await mockUSYC.valueInUsdc(amount);
  console.log(`  Bond face value at stake: $${ethers.formatUnits(valueBefore, 6)} USDC`);

  // Simulate 490 bps (~4.9% APY) yield — like real USYC T-bill returns
  console.log("\n[demo] Simulating 490 bps (~4.9% APY) yield accrual on staked USYC...");
  await mockUSYC.simulateYield(490);

  const valueAfter = await mockUSYC.valueInUsdc(amount);
  const yieldEarned = valueAfter - valueBefore;
  console.log(`  Bond value after yield:   $${ethers.formatUnits(valueAfter, 6)} USDC`);
  console.log(`  Yield earned while staked: +$${ethers.formatUnits(yieldEarned, 6)} USDC`);
  console.log(`\n  Narrative: bond earns T-bill yield while at stake —`);
  console.log(`  capital at risk that isn't idle capital.`);
}

// ---------------------------------------------------------------------------
// Arc testnet attempt — handle allowlist gracefully
// ---------------------------------------------------------------------------

async function arcBondAttempt(deployer, bondAddr) {
  const usyc   = new ethers.Contract(ARC.USYC,   ERC20_ABI,  deployer);
  const usdc   = new ethers.Contract(ARC.USDC,   ERC20_ABI,  deployer);
  const teller = new ethers.Contract(ARC.TELLER, TELLER_ABI, deployer);

  const usycBalance = await usyc.balanceOf(deployer.address);
  const usdcBalance = await usdc.balanceOf(deployer.address);

  console.log(`\n[balances] USDC: ${ethers.formatUnits(usdcBalance, 6)} | USYC: ${ethers.formatUnits(usycBalance, 8)}`);

  if (usycBalance >= USYC_BOND_AMOUNT) {
    // Already have USYC — post bond directly
    console.log("[bond] Sufficient USYC balance — posting bond...");
    const bond = await ethers.getContractAt("ArcIDBond", bondAddr);
    await usyc.approve(bondAddr, USYC_BOND_AMOUNT);
    await bond.postBond(USYC_BOND_AMOUNT);
    console.log(`  Bond posted. isActiveBondedAgent: ${await bond.isActiveBondedAgent(deployer.address)}`);

  } else if (usdcBalance >= USDC_DEPOSIT) {
    // Have USDC — try to mint USYC via Teller
    console.log("[teller] Attempting USDC → USYC via Teller (requires allowlist)...");
    try {
      await usdc.approve(ARC.TELLER, USDC_DEPOSIT);
      const usycMinted = await teller.deposit(ARC.USDC, USDC_DEPOSIT, 0);
      console.log(`  Minted ${ethers.formatUnits(usycMinted, 8)} USYC from 5 USDC`);

      const bond = await ethers.getContractAt("ArcIDBond", bondAddr);
      await usyc.approve(bondAddr, USYC_BOND_AMOUNT);
      await bond.postBond(USYC_BOND_AMOUNT);
      console.log(`  Bond posted. isActiveBondedAgent: ${await bond.isActiveBondedAgent(deployer.address)}`);
    } catch (err) {
      console.log(`\n  ⚠  Teller deposit failed — wallet likely not USYC-allowlisted yet.`);
      console.log(`     Error: ${err.message.split("\n")[0]}`);
      console.log(`\n  ✅ ArcIDBond (USYC) is deployed at ${bondAddr}`);
      console.log(`     Judges can inspect the contract code and TEE-gating at this address.`);
      console.log(`     Bond will be posted once the Circle allowlist arrives.`);
      console.log(`     Track allowlist: Circle Support ticket for USYC on Arc testnet.`);
    }
  } else {
    console.log("\n  ⚠  Insufficient USDC balance to mint USYC. Fund the wallet via faucet.circle.com");
    console.log(`  ✅ ArcIDBond (USYC) is still deployed at ${bondAddr}`);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
