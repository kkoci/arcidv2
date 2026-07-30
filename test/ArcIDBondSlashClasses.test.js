/**
 * ArcIDBondSlashClasses.test.js — Proportional breach-class slashing with
 * epoch escalation (tiered-adjudication doc, Phase 4 — post-submission,
 * see CHANGELOG.md).
 *
 * Covers exactly the plan reviewed and approved before this file was
 * written: cap boundaries (semantic + hard), epoch escalation, the
 * can't-exceed-cap invariant, and the new events. Uses the real numbers
 * pulled from the live testnet setup at review time — $5.00 USDC bond,
 * $0.001 USDC oracle fee — not arbitrary round numbers, so the "tie
 * boundary" and "which term binds" cases are grounded in what the actual
 * deployed system looks like.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const BREACH_SEMANTIC = 0;
const BREACH_HARD     = 1;

const FIVE_USDC  = 5_000_000n;    // $5.00 — the real bond size on testnet at review time
const TEN_USDC   = 10_000_000n;   // exact semantic tie-boundary bond (see below)
const FIVE_HUNDRED_USDC = 500_000_000n; // large bond where k*fee binds instead of the bps cap
const SERVICE_FEE_ATOMIC = 1_000n; // $0.001 USDC @ 6 decimals — the real oracle fee at review time

// Defaults shipped in the contract: k=100, semanticCapBps=100 (1%), hardCapBps=1000 (10%),
// hardEscalationThreshold=3, semanticEscalationThreshold=5.

describe("ArcIDBond — proportional breach-class slashing (tiered-adjudication Phase 4)", function () {
  let bond, usdc, registry;
  let owner, agentA, agentB, agentC, consumer;
  const FAKE_ID = (seed) => ethers.keccak256(ethers.toUtf8Bytes(seed));

  async function freshBondedAgent(agentSigner, amount, seed) {
    await registry.setVerified(agentSigner.address, FAKE_ID(seed));
    await usdc.mint(agentSigner.address, amount);
    await usdc.connect(agentSigner).approve(await bond.getAddress(), amount);
    await bond.connect(agentSigner).postBond(amount);
  }

  beforeEach(async function () {
    [owner, agentA, agentB, agentC, consumer] = await ethers.getSigners();

    const MockUSDC     = await ethers.getContractFactory("MockUSDC");
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    usdc     = await MockUSDC.deploy();
    registry = await MockRegistry.deploy();

    const ArcIDBond = await ethers.getContractFactory("ArcIDBond");
    bond = await ArcIDBond.deploy(await usdc.getAddress(), await registry.getAddress());
  });

  // ---------------------------------------------------------------------------
  // cap boundaries — semantic breach class
  // ---------------------------------------------------------------------------

  describe("cap boundaries — semantic breach class", function () {
    it("slashes exactly capBps% of bond when k*fee exceeds the bond-relative cap ($5 bond)", async function () {
      // k*fee = 100 * 1000 = 100,000 ($0.10); bondCap = 5,000,000 * 100/10000 = 50,000 ($0.05)
      // bondCap is smaller -> binds
      await freshBondedAgent(agentA, FIVE_USDC, "semantic-bind-bondcap");
      const before = await usdc.balanceOf(consumer.address);
      await expect(bond.slash(agentA.address, consumer.address, "semantic breach", BREACH_SEMANTIC))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, 50_000n, "semantic breach");
      const after = await usdc.balanceOf(consumer.address);
      expect(after - before).to.equal(50_000n);
    });

    it("slashes exactly k*fee when it's smaller than the bond-relative cap ($500 bond)", async function () {
      // bondCap = 500,000,000 * 100/10000 = 5,000,000 ($5.00); k*fee = 100,000 ($0.10)
      // k*fee is smaller -> binds
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "semantic-bind-fee");
      await expect(bond.slash(agentA.address, consumer.address, "semantic breach", BREACH_SEMANTIC))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, 100_000n, "semantic breach");
    });

    it("handles the exact tie boundary (k*fee == bondCap) without revert or rounding surprise", async function () {
      // $10 bond: bondCap = 10,000,000 * 100/10000 = 100,000 ($0.10) == k*fee (100,000). Exact tie.
      await freshBondedAgent(agentA, TEN_USDC, "semantic-tie");
      await expect(bond.slash(agentA.address, consumer.address, "tie", BREACH_SEMANTIC))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, 100_000n, "tie");
    });
  });

  // ---------------------------------------------------------------------------
  // cap boundaries — hard breach class
  // ---------------------------------------------------------------------------

  describe("cap boundaries — hard breach class", function () {
    it("slashes exactly hardCapBps=1000 (10%) of bond, independent of the configured fee", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "hard-cap");
      // Retune the fee to something absurd — hard breach amount must not move.
      await bond.setServiceFee(999_999_999n);
      await expect(bond.slash(agentA.address, consumer.address, "hard breach", BREACH_HARD))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, 500_000n, "hard breach"); // 5,000,000 * 1000/10000
    });

    it("hard-breach cap is always >= semantic cap for the same bond, given hardCapBps > semanticCapBps", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "hard-vs-semantic-a");
      await freshBondedAgent(agentB, FIVE_USDC, "hard-vs-semantic-b");
      const [semanticAmount] = await bond.previewSlash(agentA.address, BREACH_SEMANTIC);
      const [hardAmount]     = await bond.previewSlash(agentB.address, BREACH_HARD);
      expect(hardAmount).to.be.gte(semanticAmount);
    });
  });

  // ---------------------------------------------------------------------------
  // cap boundaries — general invariant
  // ---------------------------------------------------------------------------

  describe("cap boundaries — general invariant", function () {
    it("slash amount is never zero for a nonzero bond, even when bps math would round to 0", async function () {
      // 50 atomic units: semanticCapBps 100/10000 of 50 = 0 by integer floor.
      // Must floor to 1, not silently produce a free (zero-cost) breach.
      await freshBondedAgent(agentA, 50n, "dust-bond");
      const [amount] = await bond.previewSlash(agentA.address, BREACH_SEMANTIC);
      expect(amount).to.equal(1n);
      await expect(bond.slash(agentA.address, consumer.address, "dust breach", BREACH_SEMANTIC))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, 1n, "dust breach");
    });

    it("a single incident below the escalation threshold never drains more than its class's capBps share", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "below-cap-a"); // k*fee binds, well under bps share
      await freshBondedAgent(agentB, FIVE_USDC, "below-cap-b");         // bps share binds
      const bpsShareA = (FIVE_HUNDRED_USDC * 100n) / 10_000n;
      const bpsShareB = (FIVE_USDC * 100n) / 10_000n;
      const [amountA] = await bond.previewSlash(agentA.address, BREACH_SEMANTIC);
      const [amountB] = await bond.previewSlash(agentB.address, BREACH_SEMANTIC);
      expect(amountA).to.be.lte(bpsShareA);
      expect(amountB).to.be.lte(bpsShareB);
    });
  });

  // ---------------------------------------------------------------------------
  // epoch escalation
  // ---------------------------------------------------------------------------

  describe("epoch escalation", function () {
    it("tracks hard and semantic breach counts per agent, independently, within one epoch", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "epoch-independent"); // large bond, won't deplete
      await bond.slash(agentA.address, consumer.address, "h1", BREACH_HARD);
      await bond.slash(agentA.address, consumer.address, "s1", BREACH_SEMANTIC);
      await bond.slash(agentA.address, consumer.address, "h2", BREACH_HARD);
      await bond.slash(agentA.address, consumer.address, "s2", BREACH_SEMANTIC);

      const ep = await bond.breachEpochs(agentA.address);
      expect(ep.hardCount).to.equal(2);
      expect(ep.semanticCount).to.equal(2);
    });

    it("resets breach counts once the 24h epoch rolls over", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "epoch-reset");
      await bond.slash(agentA.address, consumer.address, "h1", BREACH_HARD);
      let ep = await bond.breachEpochs(agentA.address);
      expect(ep.hardCount).to.equal(1);

      await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
      await ethers.provider.send("evm_mine");

      await bond.slash(agentA.address, consumer.address, "h2", BREACH_HARD);
      ep = await bond.breachEpochs(agentA.address);
      expect(ep.hardCount).to.equal(1); // reset, not 2 — the new epoch's first breach
    });

    it("does NOT escalate below the threshold (2 of 3 hard breaches stay capped)", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "below-threshold");
      await bond.slash(agentA.address, consumer.address, "h1", BREACH_HARD);
      await bond.slash(agentA.address, consumer.address, "h2", BREACH_HARD);

      expect(await bond.isActiveBondedAgent(agentA.address)).to.be.true;
      expect(await bond.blacklisted(agentA.address)).to.be.false;
    });

    it("escalates to full-drain exactly at the threshold-crossing incident (3rd hard breach)", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "escalate-hard");

      await bond.slash(agentA.address, consumer.address, "h1", BREACH_HARD); // -10%
      await bond.slash(agentA.address, consumer.address, "h2", BREACH_HARD); // -10% of remainder

      const remainingBeforeEscalation = (await bond.bonds(agentA.address)).amount;
      expect(remainingBeforeEscalation).to.be.lt(FIVE_HUNDRED_USDC); // confirms prior slashes really reduced it

      await expect(bond.slash(agentA.address, consumer.address, "h3 — escalates", BREACH_HARD))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, remainingBeforeEscalation, "h3 — escalates")
        .and.to.emit(bond, "AgentEscalatedAndBlacklisted")
        .withArgs(agentA.address, remainingBeforeEscalation, BREACH_HARD);

      const info = await bond.bonds(agentA.address);
      expect(info.amount).to.equal(0n);
      expect(info.slashed).to.be.true;
      expect(await bond.blacklisted(agentA.address)).to.be.true;
      expect(await bond.isActiveBondedAgent(agentA.address)).to.be.false;
    });

    it("full-drain takes the REMAINING bond after prior partial slashes, not the original bond size", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "escalate-remaining");
      await bond.slash(agentA.address, consumer.address, "h1", BREACH_HARD);
      await bond.slash(agentA.address, consumer.address, "h2", BREACH_HARD);
      const remaining = (await bond.bonds(agentA.address)).amount;

      const before = await usdc.balanceOf(consumer.address);
      await bond.slash(agentA.address, consumer.address, "h3", BREACH_HARD);
      const after = await usdc.balanceOf(consumer.address);

      expect(after - before).to.equal(remaining);
      expect(after - before).to.be.lt(FIVE_HUNDRED_USDC); // sanity: nowhere near the original size
    });

    it("escalation permanently blocks postBond() again (blacklist), even with fresh funds", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "blacklist-block");
      await bond.setEscalationThresholds(1, 1); // force escalation on the first call, for a fast test
      await bond.slash(agentA.address, consumer.address, "escalate now", BREACH_HARD);

      await usdc.mint(agentA.address, FIVE_USDC);
      await usdc.connect(agentA).approve(await bond.getAddress(), FIVE_USDC);
      await expect(
        bond.connect(agentA).postBond(FIVE_USDC)
      ).to.be.revertedWithCustomError(bond, "AgentBlacklisted");
    });

    it("positive case: re-bonding IS allowed after a bond fully depletes via a NON-escalated partial slash", async function () {
      // Distinguishes "bond closed because it hit exactly zero via ordinary
      // proportional slashing" from "bond closed because it escalated" —
      // only the latter blacklists. Configuring hardCapBps=100% with a high
      // threshold isolates the former cleanly: one non-escalated hard slash
      // takes the entire remaining bond (100% of it) without ever crossing
      // the escalation count.
      await bond.setSlashParameters(100, 100, 10_000); // hardCapBps = 10000 = 100%
      await bond.setEscalationThresholds(100, 100);    // effectively unreachable in this test
      await freshBondedAgent(agentA, FIVE_USDC, "depletion-no-escalation");

      await bond.slash(agentA.address, consumer.address, "full depletion, not escalation", BREACH_HARD);

      const info = await bond.bonds(agentA.address);
      expect(info.amount).to.equal(0n);
      expect(info.slashed).to.be.true;
      expect(await bond.blacklisted(agentA.address)).to.be.false; // NOT blacklisted — no escalation occurred

      await usdc.mint(agentA.address, FIVE_USDC);
      await usdc.connect(agentA).approve(await bond.getAddress(), FIVE_USDC);
      await expect(bond.connect(agentA).postBond(FIVE_USDC)).to.not.be.reverted;
    });
  });

  // ---------------------------------------------------------------------------
  // can't-exceed-cap invariant — security-critical
  // ---------------------------------------------------------------------------

  describe("can't-exceed-cap invariant", function () {
    it("slash() has no amount parameter in its signature — the ABI itself has nowhere to put one", function () {
      const fn = bond.interface.getFunction("slash");
      const paramNames = fn.inputs.map((i) => i.name);
      expect(paramNames).to.deep.equal(["agent", "consumer", "reason", "breachClass"]);
      expect(paramNames).to.not.include("amount");
    });

    it("previewSlash() matches the amount slash() actually transfers, for both classes", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "preview-match-semantic");
      await freshBondedAgent(agentB, FIVE_USDC, "preview-match-hard");

      const [previewSemantic] = await bond.previewSlash(agentA.address, BREACH_SEMANTIC);
      const before = await usdc.balanceOf(consumer.address);
      await bond.slash(agentA.address, consumer.address, "x", BREACH_SEMANTIC);
      const actualSemantic = (await usdc.balanceOf(consumer.address)) - before;
      expect(actualSemantic).to.equal(previewSemantic);

      const [previewHard] = await bond.previewSlash(agentB.address, BREACH_HARD);
      const before2 = await usdc.balanceOf(consumer.address);
      await bond.slash(agentB.address, consumer.address, "y", BREACH_HARD);
      const actualHard = (await usdc.balanceOf(consumer.address)) - before2;
      expect(actualHard).to.equal(previewHard);
    });

    it("the guard's own maxAmountPerCall never bounds slash amounts — that cap only ever applied to recordSettlement", async function () {
      const Guard = await ethers.getContractFactory("ConsumerSessionKeyGuard");
      const guard = await Guard.deploy(await bond.getAddress(), owner.address);
      await bond.setAuthorizedSlasher(await guard.getAddress());

      const [, , , sessionKey] = await ethers.getSigners();
      // maxAmountPerCall = 1 atomic unit — far below what the schedule will
      // actually produce (500,000 for a hard breach on a $5 bond).
      await guard.grantSessionKey(sessionKey.address, consumer.address, 1n, 3600);

      await freshBondedAgent(agentA, FIVE_USDC, "guard-cap-irrelevant");
      const before = await usdc.balanceOf(consumer.address);
      await guard.connect(sessionKey).guardedSlash(agentA.address, "breach", BREACH_HARD);
      const after = await usdc.balanceOf(consumer.address);

      expect(after - before).to.equal(500_000n); // full schedule amount, not capped at 1
      expect(after - before).to.be.gt(1n);
    });

    it("parametrized sweep: amount is always <= capBps * bond, never negative, for a range of bond sizes and both classes", async function () {
      const sizes = [50n, 1_000n, FIVE_USDC, FIVE_HUNDRED_USDC, 999_999_999_999n];
      const agents = (await ethers.getSigners()).slice(5, 5 + sizes.length);

      for (let i = 0; i < sizes.length; i++) {
        await freshBondedAgent(agents[i], sizes[i], `sweep-${i}`);
        for (const cls of [BREACH_SEMANTIC, BREACH_HARD]) {
          const [amount] = await bond.previewSlash(agents[i].address, cls);
          const capBps = cls === BREACH_HARD ? 1000n : 100n;
          const cap = (sizes[i] * capBps) / 10_000n;
          const flooredCap = cap === 0n ? 1n : cap; // the never-zero floor also applies to the cap comparison
          expect(amount).to.be.gte(0n);
          expect(amount).to.be.lte(sizes[i]); // can never exceed what's actually left, regardless of formula
          expect(amount).to.be.lte(flooredCap > sizes[i] ? sizes[i] : flooredCap);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------

  describe("events", function () {
    it("BreachClassified carries breachClass, amount, epoch count, and escalated=false for a capped slash", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "event-capped");
      await expect(bond.slash(agentA.address, consumer.address, "x", BREACH_HARD))
        .to.emit(bond, "BreachClassified")
        .withArgs(agentA.address, BREACH_HARD, 500_000n, 1, false);
    });

    it("BreachClassified carries escalated=true and AgentEscalatedAndBlacklisted fires on the escalating slash", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "event-escalated");
      await bond.setEscalationThresholds(1, 1);
      await expect(bond.slash(agentA.address, consumer.address, "x", BREACH_HARD))
        .to.emit(bond, "BreachClassified")
        .withArgs(agentA.address, BREACH_HARD, FIVE_USDC, 1, true)
        .and.to.emit(bond, "AgentEscalatedAndBlacklisted")
        .withArgs(agentA.address, FIVE_USDC, BREACH_HARD);
    });

    it("AgentEscalatedAndBlacklisted is NOT emitted on a non-escalating slash", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "event-no-escalation");
      await expect(bond.slash(agentA.address, consumer.address, "x", BREACH_HARD))
        .to.not.emit(bond, "AgentEscalatedAndBlacklisted");
    });
  });

  // ---------------------------------------------------------------------------
  // admin — schedule configuration
  // ---------------------------------------------------------------------------

  describe("admin: setSlashParameters / setServiceFee / setEscalationThresholds", function () {
    it("reverts InvalidBps if semanticCapBps or hardCapBps exceed 10000 (100%)", async function () {
      await expect(bond.setSlashParameters(100, 10_001, 100)).to.be.revertedWithCustomError(bond, "InvalidBps");
      await expect(bond.setSlashParameters(100, 100, 10_001)).to.be.revertedWithCustomError(bond, "InvalidBps");
    });

    it("reverts InvalidThreshold if either escalation threshold is 0", async function () {
      await expect(bond.setEscalationThresholds(0, 5)).to.be.revertedWithCustomError(bond, "InvalidThreshold");
      await expect(bond.setEscalationThresholds(3, 0)).to.be.revertedWithCustomError(bond, "InvalidThreshold");
    });

    it("emits SlashParametersUpdated / ServiceFeeUpdated / EscalationThresholdsUpdated", async function () {
      await expect(bond.setSlashParameters(200, 150, 2000))
        .to.emit(bond, "SlashParametersUpdated").withArgs(200, 150, 2000);
      await expect(bond.setServiceFee(2_000))
        .to.emit(bond, "ServiceFeeUpdated").withArgs(2_000);
      await expect(bond.setEscalationThresholds(4, 6))
        .to.emit(bond, "EscalationThresholdsUpdated").withArgs(4, 6);
    });

    it("reverts for a non-owner on all three setters", async function () {
      await expect(bond.connect(agentA).setSlashParameters(100, 100, 100))
        .to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
      await expect(bond.connect(agentA).setServiceFee(1))
        .to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
      await expect(bond.connect(agentA).setEscalationThresholds(1, 1))
        .to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });
  });
});
