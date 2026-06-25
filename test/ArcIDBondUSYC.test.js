/**
 * ArcIDBond — USYC yield-bearing collateral (Phase 5)
 *
 * Demonstrates the core Circle differentiator:
 *   "Reputation collateral earns T-bill yield while staked —
 *    capital at risk that isn't idle capital."
 *
 * Uses MockUSYC (8 decimals) with share-price yield simulation.
 * No external RPC required — all tests run on Hardhat's in-memory network.
 */

const { expect }  = require("chai");
const { ethers }  = require("hardhat");

const parseUSYC = (n) => ethers.parseUnits(String(n), 8); // 8-decimal
const parseUSDC = (n) => ethers.parseUnits(String(n), 6); // 6-decimal

describe("ArcIDBond — USYC yield-bearing collateral (Phase 5)", function () {

  let bond, mockUSYC, mockRegistry;
  let owner, agent, consumer, slasher, agent2;

  const BOND_AMOUNT = parseUSYC("5"); // 5 USYC

  beforeEach(async () => {
    [owner, agent, consumer, slasher, agent2] = await ethers.getSigners();

    const MockUSYC     = await ethers.getContractFactory("MockUSYC");
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    const ArcIDBond    = await ethers.getContractFactory("ArcIDBond");

    mockUSYC     = await MockUSYC.deploy();
    mockRegistry = await MockRegistry.deploy();

    // Deploy ArcIDBond with USYC as collateral — same contract, different token
    bond = await ArcIDBond.deploy(
      await mockUSYC.getAddress(),
      await mockRegistry.getAddress()
    );

    await mockRegistry.setVerified(agent.address, ethers.id("agent-usyc-001"));
    await mockRegistry.setVerified(agent2.address, ethers.id("agent-usyc-002"));

    await mockUSYC.mint(agent.address, BOND_AMOUNT);
    await mockUSYC.connect(agent).approve(await bond.getAddress(), BOND_AMOUNT);

    await bond.setAuthorizedSlasher(slasher.address);
  });

  // ---------------------------------------------------------------------------
  // Basic functionality — same ArcIDBond contract, just a different token
  // ---------------------------------------------------------------------------

  describe("basic USYC bond", () => {

    it("accepts USYC as collateral (8-decimal, same contract as USDC)", async () => {
      await bond.connect(agent).postBond(BOND_AMOUNT);
      expect(await bond.isActiveBondedAgent(agent.address)).to.be.true;
      expect(await mockUSYC.balanceOf(await bond.getAddress())).to.equal(BOND_AMOUNT);
    });

    it("emits BondPosted with the USYC token address", async () => {
      await expect(bond.connect(agent).postBond(BOND_AMOUNT))
        .to.emit(bond, "BondPosted")
        .withArgs(agent.address, BOND_AMOUNT, await mockUSYC.getAddress());
    });

    it("bond face value is $5.00 USDC at deposit time (sharePrice = $1.00)", async () => {
      await bond.connect(agent).postBond(BOND_AMOUNT);
      const { amount } = await bond.bonds(agent.address);
      const usdcValue = await mockUSYC.valueInUsdc(amount);
      expect(usdcValue).to.equal(parseUSDC("5.0")); // $5.00
    });

    it("TEE-gating applies equally to USYC bonds", async () => {
      const [, , , , , unverified] = await ethers.getSigners();
      await mockUSYC.mint(unverified.address, BOND_AMOUNT);
      await mockUSYC.connect(unverified).approve(await bond.getAddress(), BOND_AMOUNT);
      await expect(bond.connect(unverified).postBond(BOND_AMOUNT))
        .to.be.revertedWith("Agent not TEE-verified in ArcID registry");
    });

  });

  // ---------------------------------------------------------------------------
  // Yield accrual — the core Circle differentiator
  // ---------------------------------------------------------------------------

  describe("yield-bearing collateral — capital at risk that isn't idle", () => {

    it("bond value increases as USYC share price accrues yield", async () => {
      await bond.connect(agent).postBond(BOND_AMOUNT);
      const { amount } = await bond.bonds(agent.address);

      const valueBefore = await mockUSYC.valueInUsdc(amount);

      // 50 basis points (0.5%) yield accrual — as USYC earns T-bill returns
      await mockUSYC.simulateYield(50);

      const valueAfter = await mockUSYC.valueInUsdc(amount);

      expect(valueAfter).to.be.gt(valueBefore);
      // 5 USYC * $1.005 = $5.025
      expect(valueAfter).to.equal(parseUSDC("5.025"));
    });

    it("491 bps (~4.9% APY) yields the correct appreciated bond value", async () => {
      await bond.connect(agent).postBond(BOND_AMOUNT);
      const { amount } = await bond.bonds(agent.address);

      // Simulate one year of ~4.9% APY in one shot
      await mockUSYC.simulateYield(490);

      const valueAfter = await mockUSYC.valueInUsdc(amount);
      // 5 USYC * $1.049 = $5.245  (5e8 * 1_049_000 / 1e8 = 5_245_000)
      expect(valueAfter).to.be.gt(parseUSDC("5.2"));
      expect(valueAfter).to.be.lt(parseUSDC("5.3"));
    });

    it("USYC share price is monotonically increasing after multiple yield events", async () => {
      const p0 = await mockUSYC.sharePrice();
      await mockUSYC.simulateYield(25);
      const p1 = await mockUSYC.sharePrice();
      await mockUSYC.simulateYield(25);
      const p2 = await mockUSYC.sharePrice();

      expect(p1).to.be.gt(p0);
      expect(p2).to.be.gt(p1);
    });

    it("emits YieldAccrued event with correct new share price", async () => {
      await expect(mockUSYC.simulateYield(100))
        .to.emit(mockUSYC, "YieldAccrued")
        .withArgs(100, 1_010_000); // 1% yield: $1.00 → $1.01
    });

  });

  // ---------------------------------------------------------------------------
  // Slash — consumer receives yield-bearing collateral
  // ---------------------------------------------------------------------------

  describe("slash transfers appreciated USYC to consumer", () => {

    it("consumer receives the full USYC amount (USYC units, not USDC)", async () => {
      await bond.connect(agent).postBond(BOND_AMOUNT);
      await mockUSYC.simulateYield(50); // 0.5% yield while bonded

      await bond.connect(slasher).slash(
        agent.address,
        consumer.address,
        "SLA breach — oracle served data 3× past the 30s freshness SLA"
      );

      expect(await mockUSYC.balanceOf(consumer.address)).to.equal(BOND_AMOUNT);
    });

    it("consumer's USYC is worth more than the original $5.00 bond face value", async () => {
      await bond.connect(agent).postBond(BOND_AMOUNT);
      await mockUSYC.simulateYield(200); // 2% yield while bonded

      await bond.connect(slasher).slash(
        agent.address,
        consumer.address,
        "bad-sig: oracle signature does not recover to registered wallet"
      );

      const consumerUSYC     = await mockUSYC.balanceOf(consumer.address);
      const consumerUsdcValue = await mockUSYC.valueInUsdc(consumerUSYC);

      // Consumer received USYC that has appreciated — more than face value
      expect(consumerUsdcValue).to.be.gt(parseUSDC("5.0"));
      // 5 USYC * $1.02 = $5.10
      expect(consumerUsdcValue).to.equal(parseUSDC("5.10"));
    });

    it("slashed agent has zero active bond; can re-bond after slash", async () => {
      await bond.connect(agent).postBond(BOND_AMOUNT);
      await bond.connect(slasher).slash(agent.address, consumer.address, "breach");

      expect(await bond.isActiveBondedAgent(agent.address)).to.be.false;

      // Agent can re-bond after losing their collateral
      await mockUSYC.mint(agent.address, BOND_AMOUNT);
      await mockUSYC.connect(agent).approve(await bond.getAddress(), BOND_AMOUNT);
      await bond.connect(agent).postBond(BOND_AMOUNT);
      expect(await bond.isActiveBondedAgent(agent.address)).to.be.true;
    });

  });

  // ---------------------------------------------------------------------------
  // Withdrawal — agent exits with appreciated collateral
  // ---------------------------------------------------------------------------

  describe("voluntary withdrawal — agent keeps accrued yield", () => {

    it("agent receives USYC back on withdrawal (yield value is captured on Teller redeem)", async () => {
      await bond.connect(agent).postBond(BOND_AMOUNT);
      await mockUSYC.simulateYield(100); // 1% yield while staked

      const balBefore = await mockUSYC.balanceOf(agent.address);
      await bond.connect(agent).withdrawBond();
      const balAfter = await mockUSYC.balanceOf(agent.address);

      // Agent gets back the same USYC units — but each is worth more in USDC
      // They can redeem via Teller for more USDC than they deposited
      expect(balAfter - balBefore).to.equal(BOND_AMOUNT);

      const withdrawnUsdcValue = await mockUSYC.valueInUsdc(BOND_AMOUNT);
      // 5 USYC * $1.01 = $5.05 — earned $0.05 while staked
      expect(withdrawnUsdcValue).to.equal(parseUSDC("5.05"));
    });

  });

  // ---------------------------------------------------------------------------
  // Multi-agent — multiple USYC bonds at once
  // ---------------------------------------------------------------------------

  describe("multiple bonded agents", () => {

    it("two USYC bonds coexist; yield accrues on both", async () => {
      // Agent 1 bonds
      await mockUSYC.mint(agent.address, BOND_AMOUNT);
      await mockUSYC.connect(agent).approve(await bond.getAddress(), BOND_AMOUNT * 2n);
      await bond.connect(agent).postBond(BOND_AMOUNT);

      // Agent 2 bonds
      await mockUSYC.mint(agent2.address, BOND_AMOUNT);
      await mockUSYC.connect(agent2).approve(await bond.getAddress(), BOND_AMOUNT);
      await bond.connect(agent2).postBond(BOND_AMOUNT);

      expect(await bond.isActiveBondedAgent(agent.address)).to.be.true;
      expect(await bond.isActiveBondedAgent(agent2.address)).to.be.true;

      // Total TVL: 10 USYC
      expect(await mockUSYC.balanceOf(await bond.getAddress())).to.equal(BOND_AMOUNT * 2n);

      // 50 bps yield on 10 USYC = $0.05 total value gain
      await mockUSYC.simulateYield(50);
      const { amount: a1 } = await bond.bonds(agent.address);
      const { amount: a2 } = await bond.bonds(agent2.address);
      expect(await mockUSYC.valueInUsdc(a1 + a2)).to.equal(parseUSDC("10.05"));
    });

  });

});
