/**
 * ArcIDBond.test.js — Full Phase 1 test suite
 *
 * Covers: TEE-gating, postBond, slash, withdrawBond, isActiveBondedAgent,
 *         setAuthorizedSlasher, event emission, and the proof-of-gating revert.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const FIVE_USDC   = 5_000_000n;   // 5 USDC (6 decimals)
const ONE_USDC    = 1_000_000n;
const FAKE_AGENT_ID = ethers.keccak256(ethers.toUtf8Bytes("fake-agent"));

describe("ArcIDBond", function () {
  let bond, usdc, registry;
  let owner, verifiedAgent, unverifiedAgent, consumer, otherSlasher;

  beforeEach(async function () {
    [owner, verifiedAgent, unverifiedAgent, consumer, otherSlasher] =
      await ethers.getSigners();

    // Deploy mocks
    const MockUSDC     = await ethers.getContractFactory("MockUSDC");
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    usdc     = await MockUSDC.deploy();
    registry = await MockRegistry.deploy();

    // Mark verifiedAgent as TEE-attested
    await registry.setVerified(verifiedAgent.address, FAKE_AGENT_ID);

    // Deploy ArcIDBond
    const ArcIDBond = await ethers.getContractFactory("ArcIDBond");
    bond = await ArcIDBond.deploy(
      await usdc.getAddress(),
      await registry.getAddress()
    );

    // Fund verifiedAgent with USDC and approve bond contract
    await usdc.mint(verifiedAgent.address, 100_000_000n); // 100 USDC
    await usdc.connect(verifiedAgent).approve(await bond.getAddress(), ethers.MaxUint256);

    // Fund consumer for withdraw tests
    await usdc.mint(consumer.address, 100_000_000n);
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe("construction", function () {
    it("sets collateralToken, registry, and authorizedSlasher correctly", async function () {
      expect(await bond.collateralToken()).to.equal(await usdc.getAddress());
      expect(await bond.registry()).to.equal(await registry.getAddress());
      expect(await bond.authorizedSlasher()).to.equal(owner.address);
    });
  });

  // ---------------------------------------------------------------------------
  // postBond
  // ---------------------------------------------------------------------------

  describe("postBond", function () {
    it("succeeds for a TEE-verified agent", async function () {
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);

      const b = await bond.bonds(verifiedAgent.address);
      expect(b.amount).to.equal(FIVE_USDC);
      expect(b.slashed).to.be.false;
      expect(b.postedAt).to.be.gt(0n);
    });

    it("emits BondPosted with correct args", async function () {
      await expect(bond.connect(verifiedAgent).postBond(FIVE_USDC))
        .to.emit(bond, "BondPosted")
        .withArgs(verifiedAgent.address, FIVE_USDC, await usdc.getAddress());
    });

    it("transfers USDC from agent to contract", async function () {
      const before = await usdc.balanceOf(await bond.getAddress());
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);
      const after  = await usdc.balanceOf(await bond.getAddress());
      expect(after - before).to.equal(FIVE_USDC);
    });

    // ---- PROOF OF GATING (the moat screenshot) ----
    it("reverts for an unverified wallet with the exact gating message", async function () {
      // unverifiedAgent has no entry in the registry
      await expect(
        bond.connect(unverifiedAgent).postBond(FIVE_USDC)
      ).to.be.revertedWith("Agent not TEE-verified in ArcID registry");
    });

    it("reverts with ZeroAmount if amount is 0", async function () {
      await expect(
        bond.connect(verifiedAgent).postBond(0n)
      ).to.be.revertedWithCustomError(bond, "ZeroAmount");
    });

    it("reverts with BondAlreadyActive if an active bond exists", async function () {
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);
      await expect(
        bond.connect(verifiedAgent).postBond(ONE_USDC)
      ).to.be.revertedWithCustomError(bond, "BondAlreadyActive");
    });

    it("allows re-bonding after a slash", async function () {
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);

      // Slash
      await bond.slash(verifiedAgent.address, consumer.address, "stale data");

      // Re-fund and re-approve
      await usdc.mint(verifiedAgent.address, FIVE_USDC);
      await usdc.connect(verifiedAgent).approve(await bond.getAddress(), FIVE_USDC);

      // Should succeed
      await expect(bond.connect(verifiedAgent).postBond(FIVE_USDC)).to.not.be.reverted;
    });
  });

  // ---------------------------------------------------------------------------
  // slash
  // ---------------------------------------------------------------------------

  describe("slash", function () {
    beforeEach(async function () {
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);
    });

    it("transfers the full bond to the consumer", async function () {
      const before = await usdc.balanceOf(consumer.address);
      await bond.slash(verifiedAgent.address, consumer.address, "stale data");
      const after  = await usdc.balanceOf(consumer.address);
      expect(after - before).to.equal(FIVE_USDC);
    });

    it("marks the bond as slashed", async function () {
      await bond.slash(verifiedAgent.address, consumer.address, "stale data");
      const b = await bond.bonds(verifiedAgent.address);
      expect(b.slashed).to.be.true;
    });

    it("emits AgentSlashed with the LLM rationale string", async function () {
      const reason = "timestamp 47s stale vs 30s SLA — provider live but serving stale data";
      await expect(bond.slash(verifiedAgent.address, consumer.address, reason))
        .to.emit(bond, "AgentSlashed")
        .withArgs(verifiedAgent.address, consumer.address, FIVE_USDC, reason);
    });

    it("reverts if caller is not the authorized slasher", async function () {
      await expect(
        bond.connect(otherSlasher).slash(verifiedAgent.address, consumer.address, "breach")
      ).to.be.revertedWithCustomError(bond, "NotAuthorizedSlasher");
    });

    it("reverts with NoBondFound for an unknown agent", async function () {
      await expect(
        bond.slash(unverifiedAgent.address, consumer.address, "breach")
      ).to.be.revertedWithCustomError(bond, "NoBondFound");
    });

    it("reverts with AlreadySlashed on double-slash", async function () {
      await bond.slash(verifiedAgent.address, consumer.address, "breach");
      await expect(
        bond.slash(verifiedAgent.address, consumer.address, "breach again")
      ).to.be.revertedWithCustomError(bond, "AlreadySlashed");
    });

    it("isActiveBondedAgent returns false after slash", async function () {
      await bond.slash(verifiedAgent.address, consumer.address, "breach");
      expect(await bond.isActiveBondedAgent(verifiedAgent.address)).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // withdrawBond
  // ---------------------------------------------------------------------------

  describe("withdrawBond", function () {
    beforeEach(async function () {
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);
    });

    it("returns the full bond to the agent", async function () {
      const before = await usdc.balanceOf(verifiedAgent.address);
      await bond.connect(verifiedAgent).withdrawBond();
      const after  = await usdc.balanceOf(verifiedAgent.address);
      expect(after - before).to.equal(FIVE_USDC);
    });

    it("emits BondWithdrawn", async function () {
      await expect(bond.connect(verifiedAgent).withdrawBond())
        .to.emit(bond, "BondWithdrawn")
        .withArgs(verifiedAgent.address, FIVE_USDC);
    });

    it("deletes the bond record", async function () {
      await bond.connect(verifiedAgent).withdrawBond();
      const b = await bond.bonds(verifiedAgent.address);
      expect(b.postedAt).to.equal(0n);
    });

    it("reverts with NoBondFound if no bond exists", async function () {
      await expect(
        bond.connect(unverifiedAgent).withdrawBond()
      ).to.be.revertedWithCustomError(bond, "NoBondFound");
    });

    it("reverts with AlreadySlashed if the bond was slashed", async function () {
      await bond.slash(verifiedAgent.address, consumer.address, "breach");
      await expect(
        bond.connect(verifiedAgent).withdrawBond()
      ).to.be.revertedWithCustomError(bond, "AlreadySlashed");
    });
  });

  // ---------------------------------------------------------------------------
  // isActiveBondedAgent
  // ---------------------------------------------------------------------------

  describe("isActiveBondedAgent", function () {
    it("returns false for an agent with no bond", async function () {
      expect(await bond.isActiveBondedAgent(verifiedAgent.address)).to.be.false;
    });

    it("returns true for an agent with an active bond", async function () {
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);
      expect(await bond.isActiveBondedAgent(verifiedAgent.address)).to.be.true;
    });

    it("returns false after withdrawal", async function () {
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);
      await bond.connect(verifiedAgent).withdrawBond();
      expect(await bond.isActiveBondedAgent(verifiedAgent.address)).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // setAuthorizedSlasher
  // ---------------------------------------------------------------------------

  describe("setAuthorizedSlasher", function () {
    it("allows owner to rotate the slasher", async function () {
      await bond.setAuthorizedSlasher(otherSlasher.address);
      expect(await bond.authorizedSlasher()).to.equal(otherSlasher.address);
    });

    it("emits SlasherUpdated", async function () {
      await expect(bond.setAuthorizedSlasher(otherSlasher.address))
        .to.emit(bond, "SlasherUpdated")
        .withArgs(owner.address, otherSlasher.address);
    });

    it("reverts if called by a non-owner", async function () {
      await expect(
        bond.connect(verifiedAgent).setAuthorizedSlasher(otherSlasher.address)
      ).to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });

    it("new slasher can slash; old slasher cannot", async function () {
      await bond.connect(verifiedAgent).postBond(FIVE_USDC);
      await bond.setAuthorizedSlasher(otherSlasher.address);

      await expect(
        bond.slash(verifiedAgent.address, consumer.address, "breach")
      ).to.be.revertedWithCustomError(bond, "NotAuthorizedSlasher");

      await expect(
        bond.connect(otherSlasher).slash(verifiedAgent.address, consumer.address, "breach")
      ).to.not.be.reverted;
    });
  });
});
