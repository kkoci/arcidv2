/**
 * ConsumerSessionKeyGuard.test.js — Post-submission Phase 6 (session-key
 * wallet hardening). Covers: session grant/revoke, guarded slash/settlement,
 * amount cap, expiry, and that the underlying ArcIDBond's authorizedSlasher
 * is the guard, not the session key itself.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const FIVE_USDC   = 5_000_000n;   // 5 USDC (6 decimals)
const ONE_USDC    = 1_000_000n;
const HALF_USDC   = 500_000n;
const FAKE_AGENT_ID = ethers.keccak256(ethers.toUtf8Bytes("fake-agent"));
const VERDICT_HASH  = ethers.keccak256(ethers.toUtf8Bytes("verdict:ok"));
const ONE_HOUR = 3600;

describe("ConsumerSessionKeyGuard", function () {
  let bond, usdc, registry, guard;
  let owner, verifiedAgent, unverifiedAgent, payout, sessionKey, otherKey;

  beforeEach(async function () {
    [owner, verifiedAgent, unverifiedAgent, payout, sessionKey, otherKey] =
      await ethers.getSigners();

    const MockUSDC     = await ethers.getContractFactory("MockUSDC");
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    usdc     = await MockUSDC.deploy();
    registry = await MockRegistry.deploy();
    await registry.setVerified(verifiedAgent.address, FAKE_AGENT_ID);

    const ArcIDBond = await ethers.getContractFactory("ArcIDBond");
    bond = await ArcIDBond.deploy(await usdc.getAddress(), await registry.getAddress());

    await usdc.mint(verifiedAgent.address, 100_000_000n);
    await usdc.connect(verifiedAgent).approve(await bond.getAddress(), ethers.MaxUint256);
    await bond.connect(verifiedAgent).postBond(FIVE_USDC);

    const Guard = await ethers.getContractFactory("ConsumerSessionKeyGuard");
    guard = await Guard.deploy(await bond.getAddress(), owner.address);

    // Move slasher authority from the deployer EOA to the guard contract —
    // this is the step that actually takes an unbounded key out of the loop.
    await bond.setAuthorizedSlasher(await guard.getAddress());
  });

  // ---------------------------------------------------------------------------
  // construction
  // ---------------------------------------------------------------------------

  describe("construction", function () {
    it("sets bond and owner correctly", async function () {
      expect(await guard.bond()).to.equal(await bond.getAddress());
      expect(await guard.owner()).to.equal(owner.address);
    });

    it("has no active session by default", async function () {
      expect(await guard.hasActiveSession()).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // grantSessionKey / revokeSessionKey
  // ---------------------------------------------------------------------------

  describe("grantSessionKey", function () {
    it("sets sessionKey, payoutAddress, cap, and expiry", async function () {
      await guard.grantSessionKey(sessionKey.address, payout.address, ONE_USDC, ONE_HOUR);
      expect(await guard.sessionKey()).to.equal(sessionKey.address);
      expect(await guard.payoutAddress()).to.equal(payout.address);
      expect(await guard.maxAmountPerCall()).to.equal(ONE_USDC);
      expect(await guard.hasActiveSession()).to.be.true;
    });

    it("emits SessionKeyGranted", async function () {
      const tx = await guard.grantSessionKey(sessionKey.address, payout.address, ONE_USDC, ONE_HOUR);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx)
        .to.emit(guard, "SessionKeyGranted")
        .withArgs(sessionKey.address, payout.address, ONE_USDC, block.timestamp + ONE_HOUR);
    });

    it("reverts if called by a non-owner", async function () {
      await expect(
        guard.connect(verifiedAgent).grantSessionKey(sessionKey.address, payout.address, ONE_USDC, ONE_HOUR)
      ).to.be.revertedWithCustomError(guard, "OwnableUnauthorizedAccount");
    });

    it("overwrites a previous session", async function () {
      await guard.grantSessionKey(sessionKey.address, payout.address, ONE_USDC, ONE_HOUR);
      await guard.grantSessionKey(otherKey.address, payout.address, HALF_USDC, ONE_HOUR);
      expect(await guard.sessionKey()).to.equal(otherKey.address);
      expect(await guard.maxAmountPerCall()).to.equal(HALF_USDC);
    });
  });

  describe("revokeSessionKey", function () {
    beforeEach(async function () {
      await guard.grantSessionKey(sessionKey.address, payout.address, ONE_USDC, ONE_HOUR);
    });

    it("clears the session", async function () {
      await guard.revokeSessionKey();
      expect(await guard.sessionKey()).to.equal(ethers.ZeroAddress);
      expect(await guard.hasActiveSession()).to.be.false;
    });

    it("emits SessionKeyRevoked", async function () {
      await expect(guard.revokeSessionKey())
        .to.emit(guard, "SessionKeyRevoked")
        .withArgs(sessionKey.address);
    });

    it("reverts if called by a non-owner", async function () {
      await expect(
        guard.connect(sessionKey).revokeSessionKey()
      ).to.be.revertedWithCustomError(guard, "OwnableUnauthorizedAccount");
    });

    it("a revoked session key can no longer call guardedSlash", async function () {
      await guard.revokeSessionKey();
      await expect(
        guard.connect(sessionKey).guardedSlash(verifiedAgent.address, "breach")
      ).to.be.revertedWithCustomError(guard, "NoActiveSession");
    });
  });

  // ---------------------------------------------------------------------------
  // guardedSlash
  // ---------------------------------------------------------------------------

  describe("guardedSlash", function () {
    beforeEach(async function () {
      await guard.grantSessionKey(sessionKey.address, payout.address, ONE_USDC, ONE_HOUR);
    });

    it("transfers the bond to the fixed payoutAddress, not an attacker-chosen one", async function () {
      const before = await usdc.balanceOf(payout.address);
      await guard.connect(sessionKey).guardedSlash(verifiedAgent.address, "stale data");
      const after = await usdc.balanceOf(payout.address);
      expect(after - before).to.equal(FIVE_USDC);
    });

    it("emits GuardedSlash", async function () {
      await expect(guard.connect(sessionKey).guardedSlash(verifiedAgent.address, "stale data"))
        .to.emit(guard, "GuardedSlash")
        .withArgs(verifiedAgent.address, sessionKey.address, "stale data");
    });

    it("marks the underlying bond as slashed", async function () {
      await guard.connect(sessionKey).guardedSlash(verifiedAgent.address, "stale data");
      expect(await bond.isActiveBondedAgent(verifiedAgent.address)).to.be.false;
    });

    it("reverts NotSessionKey if called by any other address, including the guard owner", async function () {
      await expect(
        guard.connect(owner).guardedSlash(verifiedAgent.address, "stale data")
      ).to.be.revertedWithCustomError(guard, "NotSessionKey");
      await expect(
        guard.connect(otherKey).guardedSlash(verifiedAgent.address, "stale data")
      ).to.be.revertedWithCustomError(guard, "NotSessionKey");
    });

    it("reverts SessionExpired once the session lifetime has passed", async function () {
      await ethers.provider.send("evm_increaseTime", [ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");
      await expect(
        guard.connect(sessionKey).guardedSlash(verifiedAgent.address, "stale data")
      ).to.be.revertedWithCustomError(guard, "SessionExpired");
    });

    it("the session key has no direct authority on ArcIDBond — only the guard does", async function () {
      await expect(
        bond.connect(sessionKey).slash(verifiedAgent.address, payout.address, "stale data")
      ).to.be.revertedWithCustomError(bond, "NotAuthorizedSlasher");
    });
  });

  // ---------------------------------------------------------------------------
  // guardedRecordSettlement
  // ---------------------------------------------------------------------------

  describe("guardedRecordSettlement", function () {
    beforeEach(async function () {
      await guard.grantSessionKey(sessionKey.address, payout.address, ONE_USDC, ONE_HOUR);
    });

    it("logs a settlement within the cap", async function () {
      await expect(
        guard.connect(sessionKey).guardedRecordSettlement(verifiedAgent.address, HALF_USDC, VERDICT_HASH)
      )
        .to.emit(bond, "PaymentSettled")
        .withArgs(verifiedAgent.address, payout.address, HALF_USDC, VERDICT_HASH);
    });

    it("emits GuardedSettlement", async function () {
      await expect(
        guard.connect(sessionKey).guardedRecordSettlement(verifiedAgent.address, HALF_USDC, VERDICT_HASH)
      )
        .to.emit(guard, "GuardedSettlement")
        .withArgs(verifiedAgent.address, sessionKey.address, HALF_USDC, VERDICT_HASH);
    });

    it("reverts AmountExceedsCap if amount is over the per-call cap", async function () {
      await expect(
        guard.connect(sessionKey).guardedRecordSettlement(verifiedAgent.address, ONE_USDC + 1n, VERDICT_HASH)
      ).to.be.revertedWithCustomError(guard, "AmountExceedsCap");
    });

    it("allows an amount exactly at the cap", async function () {
      await expect(
        guard.connect(sessionKey).guardedRecordSettlement(verifiedAgent.address, ONE_USDC, VERDICT_HASH)
      ).to.not.be.reverted;
    });

    it("reverts NotSessionKey if called by a non-session address", async function () {
      await expect(
        guard.connect(otherKey).guardedRecordSettlement(verifiedAgent.address, HALF_USDC, VERDICT_HASH)
      ).to.be.revertedWithCustomError(guard, "NotSessionKey");
    });

    it("still respects ArcIDBond's own AlreadySlashed guard (mutual exclusion holds through the guard too)", async function () {
      await guard.connect(sessionKey).guardedSlash(verifiedAgent.address, "breach");
      await expect(
        guard.connect(sessionKey).guardedRecordSettlement(verifiedAgent.address, HALF_USDC, VERDICT_HASH)
      ).to.be.revertedWithCustomError(bond, "AlreadySlashed");
    });
  });
});
