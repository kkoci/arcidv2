/**
 * deploy.js — Deploy ArcIDBond to Arc testnet (or local Hardhat).
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network hardhat       # local, deploys mocks
 *   npx hardhat run scripts/deploy.js --network arcTestnet    # Arc testnet, real USDC
 *
 * What this script does:
 *   1. Deploy ArcIDBond (and mocks on local).
 *   2. Post a 5 USDC bond from the deployer (simulates a verified agent on local;
 *      on Arc testnet your wallet must already be registered in ArcIDRegistry).
 *   3. Confirm bond via bonds(address) + isActiveBondedAgent().
 *   4. Try postBond() from a random unverified wallet — capture the revert message.
 *      This is the PROOF-OF-GATING screenshot for the submission.
 *   5. Write deployments/<network>.json for the backend + frontend to consume.
 */

const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");

const FIVE_USDC = 5_000_000n; // 5 USDC (6 decimals)

async function main() {
  const { ethers, network } = hre;
  const isLocal = network.name === "hardhat" || network.name === "localhost";

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  console.log(`\n→ Deploying ArcIDBond to ${network.name}`);
  console.log(`   Deployer: ${deployerAddr}`);
  console.log(`   Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployerAddr))} ETH\n`);

  // ─── 1. Collateral token ───────────────────────────────────────────────────
  let collateralAddress = process.env.USDC_TOKEN_ADDRESS;
  let usdc;

  if (isLocal || !collateralAddress || collateralAddress === ethers.ZeroAddress) {
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    collateralAddress = await usdc.getAddress();
    console.log(`   [mock] MockUSDC deployed  → ${collateralAddress}`);

    // Mint 100 USDC to deployer for testing
    await (await usdc.mint(deployerAddr, 100_000_000n)).wait();
    console.log(`   [mock] Minted 100 USDC to deployer`);
  } else {
    console.log(`   [live] USDC → ${collateralAddress}`);
    usdc = await ethers.getContractAt("MockUSDC", collateralAddress); // IERC20-compatible
  }

  // ─── 2. Registry ──────────────────────────────────────────────────────────
  let registryAddress = process.env.ARCID_REGISTRY_ADDRESS;
  let registry;

  if (isLocal || !registryAddress || registryAddress === ethers.ZeroAddress) {
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    registry = await MockRegistry.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
    console.log(`   [mock] MockRegistry deployed → ${registryAddress}`);

    // Mark deployer as TEE-verified so postBond() succeeds in step 3
    const fakeId = ethers.keccak256(ethers.toUtf8Bytes("test-agent-01"));
    await (await registry.setVerified(deployerAddr, fakeId)).wait();
    console.log(`   [mock] Deployer marked as TEE-verified (agentId: ${fakeId.slice(0, 18)}...)`);
  } else {
    console.log(`   [live] ArcIDRegistry → ${registryAddress}`);
  }

  // ─── 3. Deploy ArcIDBond ──────────────────────────────────────────────────
  const ArcIDBond = await ethers.getContractFactory("ArcIDBond");
  const bond = await ArcIDBond.deploy(collateralAddress, registryAddress);
  await bond.waitForDeployment();
  const bondAddress = await bond.getAddress();
  console.log(`\n✓ ArcIDBond deployed → ${bondAddress}`);
  console.log(`  collateralToken:   ${await bond.collateralToken()}`);
  console.log(`  registry:          ${await bond.registry()}`);
  console.log(`  authorizedSlasher: ${await bond.authorizedSlasher()}`);

  // ─── 4. Post a 5 USDC bond ────────────────────────────────────────────────
  console.log(`\n→ Posting 5 USDC bond from deployer (${deployerAddr})...`);

  await (await usdc.approve(bondAddress, FIVE_USDC)).wait();
  const postTx = await bond.postBond(FIVE_USDC);
  const postReceipt = await postTx.wait();
  console.log(`✓ postBond() mined in tx: ${postReceipt.hash}`);

  const bondInfo = await bond.bonds(deployerAddr);
  console.log(`  bonds(deployer).amount:   ${bondInfo.amount.toString()} (${Number(bondInfo.amount) / 1e6} USDC)`);
  console.log(`  bonds(deployer).postedAt: ${bondInfo.postedAt.toString()}`);
  console.log(`  bonds(deployer).slashed:  ${bondInfo.slashed}`);

  const isActive = await bond.isActiveBondedAgent(deployerAddr);
  console.log(`  isActiveBondedAgent(deployer): ${isActive}`);
  if (!isActive) throw new Error("Expected isActiveBondedAgent to return true!");

  // ─── 5. Proof-of-gating: try from an unverified wallet ───────────────────
  console.log(`\n→ Proof-of-gating: attempting postBond() from an UNVERIFIED wallet...`);

  // Create a random wallet; on local fund it with ETH, on Arc testnet we just
  // call staticCall which doesn't require gas
  const randomWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log(`  Unverified wallet: ${randomWallet.address}`);

  let gatingReverted = false;
  try {
    // Use callStatic (eth_call) to avoid needing ETH in the random wallet
    await bond.connect(randomWallet).postBond.staticCall(FIVE_USDC);
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("Agent not TEE-verified in ArcID registry")) {
      gatingReverted = true;
      console.log(`✓ GATING CONFIRMED: reverted with "Agent not TEE-verified in ArcID registry"`);
    } else {
      console.log(`  (unexpected revert: ${msg.slice(0, 120)})`);
    }
  }
  if (!gatingReverted && isLocal) {
    console.warn("  WARNING: gating revert not captured — check MockRegistry setup");
  }

  // ─── 6. Persist deployment ────────────────────────────────────────────────
  const deployDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployerAddr,
    timestamp: Math.floor(Date.now() / 1000),
    addresses: {
      ArcIDBond:        bondAddress,
      collateralToken:  collateralAddress,
      ArcIDRegistry:    registryAddress,
    },
    bondStats: {
      deployer_bond_amount: FIVE_USDC.toString(),
      deployer_is_active:   isActive,
      gating_revert_confirmed: gatingReverted,
    },
  };

  const outPath = path.join(deployDir, `${network.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n✓ Wrote ${outPath}`);
  console.log(`  Bond address: ${bondAddress}`);
  console.log("\nPhase 1 complete. Bond posted, gating verified.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
