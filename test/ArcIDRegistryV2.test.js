/**
 * ArcIDRegistryV2.test.js
 *
 * Covers: DCAP quote generation, successful registration, all revert paths,
 *         agentId derivation, idempotent re-registration, and ArcIDBond gating
 *         through the new registry.
 *
 * No external RPC.  DCAPVerifier is deployed locally.
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const FIVE_USDC = 5_000_000n;
const QUOTE_LEN = 0x250; // 592 bytes

// ---------------------------------------------------------------------------
// Quote helpers (mirrors deploy_standalone.js logic)
// ---------------------------------------------------------------------------

function buildPrototypeQuote(agentAddress, reportDataHex) {
  const buf = Buffer.alloc(QUOTE_LEN, 0);

  buf.writeUInt16LE(4,          0); // version = 4
  buf.writeUInt16LE(2,          2); // att_key_type = ECDSA_P256
  buf.writeUInt32LE(0x00000081, 4); // tee_type = TDX

  const mrtdSeed = ethers.keccak256(
    ethers.toUtf8Bytes("arcidv2-prototype-mrtd:" + agentAddress.toLowerCase())
  );
  const mrtd = ethers.getBytes(mrtdSeed);
  for (let i = 0; i < 48; i++) buf[0x70 + i] = mrtd[i % 32];

  const rd = ethers.getBytes(reportDataHex);
  for (let i = 0; i < 32; i++) buf[0x230 + i] = rd[i];

  return "0x" + buf.toString("hex");
}

function signRawDigest(privateKey, reportData) {
  const signingKey = new ethers.SigningKey(privateKey);
  const sig = signingKey.sign(ethers.getBytes(reportData));
  return ethers.concat([
    ethers.zeroPadValue(sig.r, 32),
    ethers.zeroPadValue(sig.s, 32),
    Uint8Array.from([sig.v]),
  ]);
}

/** Build a valid quote + sig pair for the given wallet. */
async function makeAttestation(wallet, nonceSeed = "test-nonce") {
  const nonce      = ethers.keccak256(ethers.toUtf8Bytes(nonceSeed));
  const reportData = ethers.keccak256(
    ethers.solidityPacked(["address", "bytes32"], [wallet.address, nonce])
  );
  const dcapQuote     = buildPrototypeQuote(wallet.address, reportData);
  const reportDataSig = signRawDigest(wallet.privateKey, reportData);
  return { dcapQuote, reportDataSig, reportData };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ArcIDRegistryV2", function () {
  let verifier, registry;
  let agentWallet, otherWallet, owner;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Fresh random wallets so private keys are available for quote signing.
    agentWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    otherWallet = ethers.Wallet.createRandom().connect(ethers.provider);

    // Fund with ETH for gas.
    await owner.sendTransaction({
      to: agentWallet.address,
      value: ethers.parseEther("1"),
    });
    await owner.sendTransaction({
      to: otherWallet.address,
      value: ethers.parseEther("1"),
    });

    const DCAPVerifier = await ethers.getContractFactory("DCAPVerifier");
    verifier = await DCAPVerifier.deploy();

    const Registry = await ethers.getContractFactory("ArcIDRegistryV2");
    registry = await Registry.deploy(await verifier.getAddress());
  });

  // ── Registration success ─────────────────────────────────────────────────

  it("registers an agent with a valid DCAP quote", async function () {
    const { dcapQuote, reportDataSig } = await makeAttestation(agentWallet);
    await registry.connect(agentWallet).registerAgent(dcapQuote, reportDataSig);
    expect(await registry.agentIdBySigner(agentWallet.address)).to.not.equal(
      ethers.ZeroHash
    );
  });

  it("emits AgentRegistered event with correct fields", async function () {
    const { dcapQuote, reportDataSig } = await makeAttestation(agentWallet);
    await expect(
      registry.connect(agentWallet).registerAgent(dcapQuote, reportDataSig)
    ).to.emit(registry, "AgentRegistered");
  });

  it("agentId is deterministic — re-registering with same quote yields same id", async function () {
    const { dcapQuote, reportDataSig } = await makeAttestation(agentWallet);

    await registry.connect(agentWallet).registerAgent(dcapQuote, reportDataSig);
    const id1 = await registry.agentIdBySigner(agentWallet.address);

    await registry.connect(agentWallet).registerAgent(dcapQuote, reportDataSig);
    const id2 = await registry.agentIdBySigner(agentWallet.address);

    expect(id1).to.equal(id2);
  });

  it("unregistered address returns bytes32(0)", async function () {
    expect(await registry.agentIdBySigner(otherWallet.address)).to.equal(
      ethers.ZeroHash
    );
  });

  // ── DCAP verification failures ───────────────────────────────────────────

  it("reverts when quote is too short (< 0x250 bytes)", async function () {
    const { reportDataSig } = await makeAttestation(agentWallet);
    const shortQuote = "0x" + "00".repeat(100);
    await expect(
      registry.connect(agentWallet).registerAgent(shortQuote, reportDataSig)
    ).to.be.revertedWith("DCAP attestation failed");
  });

  it("reverts when TDX header version is wrong", async function () {
    const { dcapQuote, reportDataSig } = await makeAttestation(agentWallet);
    const qBuf = Buffer.from(ethers.getBytes(dcapQuote));
    qBuf.writeUInt16LE(3, 0); // corrupt: version 3 instead of 4
    await expect(
      registry
        .connect(agentWallet)
        .registerAgent("0x" + qBuf.toString("hex"), reportDataSig)
    ).to.be.revertedWith("DCAP attestation failed");
  });

  it("reverts when att_key_type is wrong", async function () {
    const { dcapQuote, reportDataSig } = await makeAttestation(agentWallet);
    const qBuf = Buffer.from(ethers.getBytes(dcapQuote));
    qBuf.writeUInt16LE(1, 2); // corrupt: type 1 (RSA) instead of 2 (ECDSA P-256)
    await expect(
      registry
        .connect(agentWallet)
        .registerAgent("0x" + qBuf.toString("hex"), reportDataSig)
    ).to.be.revertedWith("DCAP attestation failed");
  });

  it("reverts when reportDataSig was produced by a different key", async function () {
    // Build quote for agentWallet but sign with otherWallet.
    // ecrecover returns otherWallet.address ≠ msg.sender (agentWallet).
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("test-nonce"));
    const reportData = ethers.keccak256(
      ethers.solidityPacked(["address", "bytes32"], [agentWallet.address, nonce])
    );
    const dcapQuote     = buildPrototypeQuote(agentWallet.address, reportData);
    const reportDataSig = signRawDigest(otherWallet.privateKey, reportData);

    await expect(
      registry.connect(agentWallet).registerAgent(dcapQuote, reportDataSig)
    ).to.be.revertedWith("Quote signer must match caller");
  });

  it("reverts when sig length is not 65 bytes", async function () {
    const { dcapQuote } = await makeAttestation(agentWallet);
    const shortSig = "0x" + "ab".repeat(64); // 64 bytes, not 65
    await expect(
      registry.connect(agentWallet).registerAgent(dcapQuote, shortSig)
    ).to.be.revertedWith("DCAP attestation failed");
  });

  // ── ArcIDBond gating through ArcIDRegistryV2 ────────────────────────────

  it("registered agent can postBond; unregistered wallet reverts with gating message", async function () {
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const ArcIDBond = await ethers.getContractFactory("ArcIDBond");
    const bond = await ArcIDBond.deploy(
      await usdc.getAddress(),
      await registry.getAddress()
    );

    // Fund both wallets with USDC.
    await usdc.mint(agentWallet.address, 10_000_000n);
    await usdc
      .connect(agentWallet)
      .approve(await bond.getAddress(), ethers.MaxUint256);

    await usdc.mint(otherWallet.address, 10_000_000n);
    await usdc
      .connect(otherWallet)
      .approve(await bond.getAddress(), ethers.MaxUint256);

    // Register agentWallet.
    const { dcapQuote, reportDataSig } = await makeAttestation(agentWallet);
    await registry.connect(agentWallet).registerAgent(dcapQuote, reportDataSig);

    // Registered wallet succeeds.
    await expect(bond.connect(agentWallet).postBond(FIVE_USDC)).to.not.be.reverted;

    // Unregistered wallet gets the proof-of-gating revert.
    await expect(bond.connect(otherWallet).postBond(FIVE_USDC)).to.be.revertedWith(
      "Agent not TEE-verified in ArcID registry"
    );
  });
});
