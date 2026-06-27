/**
 * deploy_standalone.js — Deploy a fully self-contained ArcID v2 stack.
 *
 * Usage:
 *   npm run deploy:standalone        # Arc testnet
 *   npm run deploy:standalone:local  # local Hardhat (no .env required)
 *
 * What this does:
 *   1. Deploy DCAPVerifier (local) or use the live one at DCAP_VERIFIER_ADDRESS (testnet).
 *   2. Deploy ArcIDRegistryV2 pointing at the verifier.
 *   3. Build a structurally-valid TDX DCAP v4 prototype quote, embed the
 *      deployer's report_data, sign it with DEPLOYER_PRIVATE_KEY — no TEE
 *      infrastructure required for this format of quote; the on-chain verifier
 *      checks header structure + ecrecover, not the Intel cert chain.
 *   4. Call registerAgent(quote, sig) on-chain — deployer is now TEE-verified.
 *   5. Deploy MockUSDC (local) or use USDC_TOKEN_ADDRESS (testnet).
 *   6. Deploy ArcIDBond pointing at ArcIDRegistryV2.
 *   7. Approve + postBond(5 USDC) — succeeds because deployer is registered.
 *   8. Proof-of-gating: staticCall postBond from a random wallet → must revert.
 *   9. Write deployments/<network>_standalone.json.
 *
 * Required env vars (testnet):
 *   DEPLOYER_PRIVATE_KEY     funded Arc testnet wallet (also used for quote signing)
 *   USDC_TOKEN_ADDRESS       0x3600000000000000000000000000000000000000
 *   DCAP_VERIFIER_ADDRESS    0xBB2835fC4d189340a98084A50DD0B36b4Ff50Ca2
 *
 * Local Hardhat: all env vars are optional; MockUSDC + DCAPVerifier are deployed
 * automatically, and the well-known Hardhat account #0 key is used for signing.
 */

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");

const FIVE_USDC = 5_000_000n; // 5 USDC (6 decimals)

// Hardhat's well-known Account #0 private key — safe to use locally.
const HARDHAT_ACCOUNT_0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ---------------------------------------------------------------------------
// Quote generation helpers
// ---------------------------------------------------------------------------

/**
 * Build a structurally-valid Intel TDX DCAP v4 prototype quote.
 *
 * The on-chain DCAPVerifier checks:
 *   - header version == 4, att_key_type == 2 (ECDSA P-256), tee_type == 0x81
 *   - quote.length >= 0x250
 *   - keccak256(quote[0x70:0xA0]) != bytes32(0)   (mrtd non-zero)
 *   - ecrecover(quote[0x230:0x250], reportDataSig) == caller
 *
 * No Intel certificate chain is checked here — that is the full verifier's job.
 *
 * @param {string} agentAddress   Deployer address (lower-case hex).
 * @param {string} reportDataHex  32-byte hex string embedded at offset 0x230.
 * @returns {string} Hex-encoded 592-byte quote.
 */
function buildPrototypeQuote(agentAddress, reportDataHex) {
  const { ethers } = hre;
  const QUOTE_LEN = 0x250; // 592 bytes
  const buf = Buffer.alloc(QUOTE_LEN, 0);

  // Header (little-endian per Intel DCAP spec)
  buf.writeUInt16LE(4,          0); // version = 4
  buf.writeUInt16LE(2,          2); // att_key_type = ECDSA_P256
  buf.writeUInt32LE(0x00000081, 4); // tee_type = TDX

  // MRTD at 0x70–0xA0 (48 bytes): deterministic, non-zero.
  // keccak256 of a seed gives us 32 non-zero bytes; cycle for the full 48.
  const mrtdSeed = ethers.keccak256(
    ethers.toUtf8Bytes("arcidv2-prototype-mrtd:" + agentAddress.toLowerCase())
  );
  const mrtd = ethers.getBytes(mrtdSeed);
  for (let i = 0; i < 48; i++) buf[0x70 + i] = mrtd[i % 32];

  // report_data at 0x230–0x250 (32 bytes)
  const rd = ethers.getBytes(reportDataHex);
  for (let i = 0; i < 32; i++) buf[0x230 + i] = rd[i];

  return "0x" + buf.toString("hex");
}

/**
 * Sign `reportData` as a raw 32-byte digest (no EIP-191 prefix) so that
 * `ecrecover(reportData, sig)` returns the signer address.  This is what
 * DCAPVerifier._recover() expects.
 *
 * @param {string} privateKey   Hex private key.
 * @param {string} reportData   32-byte hex digest.
 * @returns {string} 65-byte hex signature (r||s||v).
 */
function signRawDigest(privateKey, reportData) {
  const { ethers } = hre;
  const signingKey = new ethers.SigningKey(privateKey);
  const sig = signingKey.sign(ethers.getBytes(reportData));
  return ethers.concat([
    ethers.zeroPadValue(sig.r, 32),
    ethers.zeroPadValue(sig.s, 32),
    Uint8Array.from([sig.v]),
  ]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { ethers, network } = hre;
  const isLocal =
    network.name === "hardhat" || network.name === "localhost";

  // On local Hardhat: use the funded default signer for transactions (Hardhat
  // spins up 20 accounts regardless of DEPLOYER_PRIVATE_KEY in .env).
  // The well-known Account #0 private key is used separately for quote signing.
  //
  // On testnet: DEPLOYER_PRIVATE_KEY is required for both.
  let deployer;
  let quoteSignerKey;

  if (isLocal) {
    [deployer] = await ethers.getSigners();
    quoteSignerKey = HARDHAT_ACCOUNT_0_KEY; // same address as Hardhat Account #0
  } else {
    if (!process.env.DEPLOYER_PRIVATE_KEY) {
      throw new Error("DEPLOYER_PRIVATE_KEY must be set for testnet deploy.");
    }
    quoteSignerKey = process.env.DEPLOYER_PRIVATE_KEY;
    deployer = new ethers.Wallet(quoteSignerKey, ethers.provider);
  }

  const deployerAddr = await deployer.getAddress();

  console.log(`\n→ Deploying self-contained ArcID v2 stack to ${network.name}`);
  console.log(`   Deployer: ${deployerAddr}`);
  console.log(
    `   Balance:  ${ethers.formatEther(
      await ethers.provider.getBalance(deployerAddr)
    )} ETH\n`
  );

  // ── 1. DCAPVerifier ────────────────────────────────────────────────────────
  let verifierAddress = process.env.DCAP_VERIFIER_ADDRESS;

  if (isLocal || !verifierAddress) {
    const DCAPVerifier = await ethers.getContractFactory("DCAPVerifier", deployer);
    const verifier = await DCAPVerifier.deploy();
    await verifier.waitForDeployment();
    verifierAddress = await verifier.getAddress();
    console.log(`✓ [local] DCAPVerifier deployed → ${verifierAddress}`);
  } else {
    console.log(`  [live]  DCAPVerifier          → ${verifierAddress}`);
  }

  // ── 2. ArcIDRegistryV2 ─────────────────────────────────────────────────────
  const Registry = await ethers.getContractFactory("ArcIDRegistryV2", deployer);
  const registry = await Registry.deploy(verifierAddress);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`✓ ArcIDRegistryV2 deployed → ${registryAddress}`);

  // ── 3. Build prototype DCAP quote and sign it ──────────────────────────────
  // report_data = keccak256(deployer || nonce)  — caller-specific, non-replayable
  const nonce = ethers.keccak256(
    ethers.toUtf8Bytes("arcidv2-genesis-bond")
  );
  const reportData = ethers.keccak256(
    ethers.solidityPacked(["address", "bytes32"], [deployerAddr, nonce])
  );
  const dcapQuote   = buildPrototypeQuote(deployerAddr, reportData);
  const reportDataSig = signRawDigest(quoteSignerKey, reportData);

  console.log(`\n→ Registering deployer via DCAP attestation...`);
  console.log(`  reportData:  ${reportData}`);

  // ── 4. registerAgent on-chain ──────────────────────────────────────────────
  const regTx = await registry.registerAgent(dcapQuote, reportDataSig);
  const regReceipt = await regTx.wait();
  const deployBlock = regReceipt.blockNumber; // used by agent:list as query start
  const agentId = await registry.agentIdBySigner(deployerAddr);

  console.log(`✓ registerAgent() mined → ${regReceipt.hash}`);
  console.log(`  agentId: ${agentId}`);
  if (agentId === ethers.ZeroHash) throw new Error("Registration failed — agentId is zero");

  // ── 5. Collateral token ────────────────────────────────────────────────────
  let collateralAddress = process.env.USDC_TOKEN_ADDRESS;
  let usdc;

  if (isLocal || !collateralAddress) {
    const MockUSDC = await ethers.getContractFactory("MockUSDC", deployer);
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    collateralAddress = await usdc.getAddress();
    console.log(`\n✓ [local] MockUSDC deployed  → ${collateralAddress}`);
    await (await usdc.mint(deployerAddr, 100_000_000n)).wait();
    console.log(`  Minted 100 USDC to deployer`);
  } else {
    console.log(`\n  [live]  USDC                → ${collateralAddress}`);
    usdc = await ethers.getContractAt("IERC20", collateralAddress, deployer);
  }

  // ── 6. ArcIDBond ──────────────────────────────────────────────────────────
  const ArcIDBond = await ethers.getContractFactory("ArcIDBond", deployer);
  const bond = await ArcIDBond.deploy(collateralAddress, registryAddress);
  await bond.waitForDeployment();
  const bondAddress = await bond.getAddress();

  console.log(`\n✓ ArcIDBond deployed       → ${bondAddress}`);
  console.log(`  collateralToken:   ${await bond.collateralToken()}`);
  console.log(`  registry:          ${await bond.registry()}`);
  console.log(`  authorizedSlasher: ${await bond.authorizedSlasher()}`);

  // ── 7. Post 5 USDC bond ────────────────────────────────────────────────────
  console.log(`\n→ Posting 5 USDC bond from deployer...`);
  await (await usdc.connect(deployer).approve(bondAddress, FIVE_USDC)).wait();
  const postTx = await bond.postBond(FIVE_USDC);
  const postReceipt = await postTx.wait();

  console.log(`✓ postBond() mined → ${postReceipt.hash}`);
  const bondInfo = await bond.bonds(deployerAddr);
  console.log(
    `  amount: ${bondInfo.amount} (${Number(bondInfo.amount) / 1e6} USDC)`
  );
  console.log(`  isActiveBondedAgent: ${await bond.isActiveBondedAgent(deployerAddr)}`);

  // ── 8. Proof-of-gating ────────────────────────────────────────────────────
  console.log(`\n→ Proof-of-gating: postBond() from an UNVERIFIED wallet...`);
  const randomWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log(`  Unverified wallet: ${randomWallet.address}`);

  let gatingConfirmed = false;
  try {
    await bond
      .connect(randomWallet)
      .postBond.staticCall(FIVE_USDC);
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("Agent not TEE-verified in ArcID registry")) {
      gatingConfirmed = true;
      console.log(
        `✓ GATING CONFIRMED: "Agent not TEE-verified in ArcID registry"`
      );
    } else {
      console.log(`  (unexpected revert: ${msg.slice(0, 200)})`);
    }
  }

  // ── 9. Persist deployment ─────────────────────────────────────────────────
  const deployDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployerAddr,
    timestamp: Math.floor(Date.now() / 1000),
    deployBlock,
    addresses: {
      DCAPVerifier:     verifierAddress,
      ArcIDRegistryV2:  registryAddress,
      ArcIDBond:        bondAddress,
      collateralToken:  collateralAddress,
    },
    registeredAgent: {
      address: deployerAddr,
      agentId: agentId,
    },
    bondStats: {
      amount:                  FIVE_USDC.toString(),
      is_active:               await bond.isActiveBondedAgent(deployerAddr),
      gating_revert_confirmed: gatingConfirmed,
    },
  };

  const outPath = path.join(
    deployDir,
    `${network.name}_standalone.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`\n✓ Saved → ${outPath}`);
  console.log(`\nStack summary:`);
  console.log(`  DCAPVerifier:    ${verifierAddress}`);
  console.log(`  ArcIDRegistryV2: ${registryAddress}`);
  console.log(`  ArcIDBond:       ${bondAddress}`);
  console.log(`  USDC:            ${collateralAddress}`);
  console.log(`\nArcID v2 self-contained stack ready.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
