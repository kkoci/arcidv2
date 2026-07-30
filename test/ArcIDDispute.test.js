/**
 * ArcIDDispute.test.js — Optimistic challenge window (Phase 6, post-
 * submission — see CHANGELOG.md).
 *
 * Covers the interlocking on-chain partition this phase depends on:
 * exactly one of {slash(), fileIndictment()} must be callable for any given
 * (agent, breachClass) state, never both and never neither. Also covers
 * resolveDispute() approve/reject, permissionless finalizeExpiredDispute()
 * before/after the deadline, and the documented AlreadySlashed edge case.
 *
 * Default contract config makes the semantic cap (k*fee = $0.10 by default)
 * an absolute ceiling well under the $1.00 challengeThreshold — no semantic
 * slash can cross it without deliberately scaling serviceFee/feeMultiple/
 * bond size up first, exactly as Phase 6.4's demo commands have to. Tests
 * that need a threshold-crossing amount say so explicitly and reconfigure
 * via the owner setters, same pattern as ArcIDBondSlashClasses.test.js's
 * different bond sizes for different binding branches.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const BREACH_SEMANTIC = 0;
const BREACH_HARD     = 1;

const DISPUTE_NONE     = 0;
const DISPUTE_INDICTED = 1;
const DISPUTE_RESOLVED = 2;

const FIVE_USDC   = 5_000_000n;   // well under default $1.00 threshold when slashed
const FIVE_HUNDRED_USDC = 500_000_000n;
const RATIONALE_HASH = ethers.keccak256(ethers.toUtf8Bytes("sample claude rationale"));

describe("ArcIDBond — optimistic challenge window (Phase 6)", function () {
  let bond, usdc, registry;
  let owner, agentA, agentB, consumer, stranger;
  const FAKE_ID = (seed) => ethers.keccak256(ethers.toUtf8Bytes(seed));

  async function freshBondedAgent(agentSigner, amount, seed) {
    await registry.setVerified(agentSigner.address, FAKE_ID(seed));
    await usdc.mint(agentSigner.address, amount);
    await usdc.connect(agentSigner).approve(await bond.getAddress(), amount);
    await bond.connect(agentSigner).postBond(amount);
  }

  // Scales serviceFee/feeMultiple so k*fee = $100 (well above any bond-relative
  // cap used in these tests), so semantic amounts are always bondCap-bound —
  // the realistic "big loss" shape, matching Phase 6.4's documented demo-scaling note.
  async function scaleFeeSoBondCapBinds() {
    await bond.setServiceFee(1_000); // $0.001, unchanged
    await bond.setSlashParameters(100_000, 100, 1_000); // k=100,000 -> k*fee = $100
  }

  beforeEach(async function () {
    [owner, agentA, agentB, consumer, stranger] = await ethers.getSigners();

    const MockUSDC     = await ethers.getContractFactory("MockUSDC");
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    usdc     = await MockUSDC.deploy();
    registry = await MockRegistry.deploy();

    const ArcIDBond = await ethers.getContractFactory("ArcIDBond");
    bond = await ArcIDBond.deploy(await usdc.getAddress(), await registry.getAddress());
  });

  // ---------------------------------------------------------------------------
  // slash() threshold gate
  // ---------------------------------------------------------------------------

  describe("slash() threshold gate", function () {
    it("executes instantly when the semantic amount is at/below the default $1.00 threshold", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "under-threshold");
      // default config: amount = min($0.10, 1%*$5=$0.05) = $0.05, well under $1.00
      await expect(bond.slash(agentA.address, consumer.address, "small breach", BREACH_SEMANTIC))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, 50_000n, "small breach");
    });

    it("reverts ChallengeThresholdExceeded when the semantic amount exceeds the threshold", async function () {
      await scaleFeeSoBondCapBinds();
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "over-threshold");
      // amount = min($100, 1%*$500=$5.00) = $5.00 > $1.00 threshold
      await expect(
        bond.slash(agentA.address, consumer.address, "large breach", BREACH_SEMANTIC)
      ).to.be.revertedWithCustomError(bond, "ChallengeThresholdExceeded");
    });

    it("never gates Hard breaches, regardless of size", async function () {
      await scaleFeeSoBondCapBinds(); // irrelevant to Hard, but proves it truly doesn't matter
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "hard-never-gated");
      // hardCapBps=10% of $500 = $50, far above the $1.00 threshold, but Hard is never gated
      await expect(bond.slash(agentA.address, consumer.address, "hard breach", BREACH_HARD))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, 50_000_000n, "hard breach");
    });

    it("never gates an escalating semantic breach, even when the full-drain amount exceeds the threshold", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "escalation-never-gated");
      // Build up 4 semantic breaches (small, default config, well under threshold) to reach count=4
      for (let i = 0; i < 4; i++) {
        await bond.slash(agentA.address, consumer.address, `s${i}`, BREACH_SEMANTIC);
      }
      // 5th breach escalates (semanticEscalationThreshold=5) -> takes the full remaining bond,
      // which by now is well above $1.00, yet must NOT revert.
      const remaining = (await bond.bonds(agentA.address)).amount;
      expect(remaining).to.be.gt(1_000_000n);
      await expect(bond.slash(agentA.address, consumer.address, "escalating", BREACH_SEMANTIC))
        .to.emit(bond, "AgentEscalatedAndBlacklisted")
        .withArgs(agentA.address, remaining, BREACH_SEMANTIC);
    });
  });

  // ---------------------------------------------------------------------------
  // fileIndictment()
  // ---------------------------------------------------------------------------

  describe("fileIndictment()", function () {
    it("records a dispute and emits IndictmentFiled when the amount exceeds the threshold", async function () {
      await scaleFeeSoBondCapBinds();
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "file-ok");

      const tx = await bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(bond, "IndictmentFiled")
        .withArgs(1n, agentA.address, consumer.address, 5_000_000n, BigInt(block.timestamp) + 24n * 3600n, RATIONALE_HASH);

      const d = await bond.disputes(1);
      expect(d.consumer).to.equal(consumer.address);
      expect(d.provider).to.equal(agentA.address);
      expect(d.claimAmount).to.equal(5_000_000n);
      expect(d.state).to.equal(DISPUTE_INDICTED);
    });

    it("reverts NotAuthorizedSlasher for a non-slasher caller", async function () {
      await scaleFeeSoBondCapBinds();
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "file-unauth");
      await expect(
        bond.connect(stranger).fileIndictment(agentA.address, consumer.address, RATIONALE_HASH)
      ).to.be.revertedWithCustomError(bond, "NotAuthorizedSlasher");
    });

    it("reverts ChallengeThresholdNotExceeded when the amount is at/below the threshold", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "file-too-small");
      // default config -> $0.05, well under $1.00
      await expect(
        bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH)
      ).to.be.revertedWithCustomError(bond, "ChallengeThresholdNotExceeded");
    });

    it("reverts EscalatingBreachNotDisputable when this breach would escalate", async function () {
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "file-escalating");
      for (let i = 0; i < 4; i++) {
        await bond.slash(agentA.address, consumer.address, `s${i}`, BREACH_SEMANTIC);
      }
      // 5th would escalate -> must go through slash(), not fileIndictment(), regardless of amount
      await expect(
        bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH)
      ).to.be.revertedWithCustomError(bond, "EscalatingBreachNotDisputable");
    });

    it("reverts NoBondFound for an agent with no bond", async function () {
      await expect(
        bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH)
      ).to.be.revertedWithCustomError(bond, "NoBondFound");
    });

    it("reverts AlreadySlashed for a fully slashed agent", async function () {
      await freshBondedAgent(agentA, FIVE_USDC, "file-already-slashed");
      // hardCapBps=10% won't fully drain in one shot at this size w/o escalation; force escalation instead
      for (let i = 0; i < 3; i++) {
        await bond.slash(agentA.address, consumer.address, `h${i}`, BREACH_HARD);
      }
      await expect(
        bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH)
      ).to.be.revertedWithCustomError(bond, "AlreadySlashed");
    });

    it("increments nextDisputeId across multiple indictments", async function () {
      await scaleFeeSoBondCapBinds();
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "multi-1");
      await freshBondedAgent(agentB, FIVE_HUNDRED_USDC, "multi-2");

      await bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH);
      await bond.fileIndictment(agentB.address, consumer.address, RATIONALE_HASH);

      expect(await bond.nextDisputeId()).to.equal(2n);
      expect((await bond.disputes(1)).provider).to.equal(agentA.address);
      expect((await bond.disputes(2)).provider).to.equal(agentB.address);
    });

    it("does NOT mutate breachEpochs at indictment time", async function () {
      await scaleFeeSoBondCapBinds();
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "no-epoch-mutation");
      await bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH);
      const ep = await bond.breachEpochs(agentA.address);
      expect(ep.semanticCount).to.equal(0); // unchanged — only execution (resolve/finalize) counts
    });
  });

  // ---------------------------------------------------------------------------
  // resolveDispute()
  // ---------------------------------------------------------------------------

  describe("resolveDispute()", function () {
    async function fileOne() {
      await scaleFeeSoBondCapBinds();
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "resolve-setup");
      await bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH);
      return 1;
    }

    it("owner approval executes the slash, transfers funds, marks Resolved", async function () {
      const id = await fileOne();
      const before = await usdc.balanceOf(consumer.address);

      await expect(bond.resolveDispute(id, true))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, 5_000_000n, "[DISPUTE APPROVED] see rationaleHash on IndictmentFiled event")
        .and.to.emit(bond, "DisputeResolved")
        .withArgs(id, true, 5_000_000n, false);

      const after = await usdc.balanceOf(consumer.address);
      expect(after - before).to.equal(5_000_000n);
      expect((await bond.disputes(id)).state).to.equal(DISPUTE_RESOLVED);
    });

    it("owner rejection leaves the bond untouched, marks Resolved", async function () {
      const id = await fileOne();
      const bondBefore = (await bond.bonds(agentA.address)).amount;

      await expect(bond.resolveDispute(id, false))
        .to.emit(bond, "DisputeResolved")
        .withArgs(id, false, 0n, false);

      const bondAfter = (await bond.bonds(agentA.address)).amount;
      expect(bondAfter).to.equal(bondBefore);
      expect((await bond.disputes(id)).state).to.equal(DISPUTE_RESOLVED);
    });

    it("reverts for a non-owner caller", async function () {
      const id = await fileOne();
      await expect(bond.connect(agentA).resolveDispute(id, true))
        .to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });

    it("reverts DisputeNotIndicted for an unknown disputeId", async function () {
      await expect(bond.resolveDispute(999, true)).to.be.revertedWithCustomError(bond, "DisputeNotIndicted");
    });

    it("reverts DisputeNotIndicted if called twice on the same dispute", async function () {
      const id = await fileOne();
      await bond.resolveDispute(id, false);
      await expect(bond.resolveDispute(id, true)).to.be.revertedWithCustomError(bond, "DisputeNotIndicted");
    });

    it("recomputes the amount fresh at resolution time, not the stored claimAmount", async function () {
      const id = await fileOne(); // claimAmount = 5,000,000 (1% of $500)
      // An intervening Hard breach against the same agent shrinks the remaining bond
      // before resolution — recomputed amount must reflect the new remaining, not
      // the amount that was true when the indictment was filed.
      await bond.slash(agentA.address, consumer.address, "intervening hard breach", BREACH_HARD);
      const remainingBeforeResolve = (await bond.bonds(agentA.address)).amount; // $500 - $50 = $450

      const expectedAmount = (remainingBeforeResolve * 100n) / 10_000n; // 1% of $450 = $4.50
      expect(expectedAmount).to.not.equal(5_000_000n); // sanity: genuinely different from claimAmount

      await expect(bond.resolveDispute(id, true))
        .to.emit(bond, "AgentSlashed")
        .withArgs(agentA.address, consumer.address, expectedAmount, "[DISPUTE APPROVED] see rationaleHash on IndictmentFiled event");
    });

    it("reverts AlreadySlashed and leaves the dispute stuck Indicted if the bond was fully drained in the meantime (documented limitation)", async function () {
      const id = await fileOne();
      // Escalate the agent to full-drain + blacklist via 3 Hard breaches, independent of the pending dispute.
      for (let i = 0; i < 3; i++) {
        await bond.slash(agentA.address, consumer.address, `h${i}`, BREACH_HARD);
      }
      expect((await bond.bonds(agentA.address)).slashed).to.equal(true);

      await expect(bond.resolveDispute(id, true)).to.be.revertedWithCustomError(bond, "AlreadySlashed");
      // The revert must have rolled back the `state = Resolved` write too — still Indicted.
      expect((await bond.disputes(id)).state).to.equal(DISPUTE_INDICTED);
    });
  });

  // ---------------------------------------------------------------------------
  // finalizeExpiredDispute()
  // ---------------------------------------------------------------------------

  describe("finalizeExpiredDispute()", function () {
    async function fileOne() {
      await scaleFeeSoBondCapBinds();
      await freshBondedAgent(agentA, FIVE_HUNDRED_USDC, "finalize-setup");
      await bond.fileIndictment(agentA.address, consumer.address, RATIONALE_HASH);
      return 1;
    }

    it("reverts ChallengeWindowNotExpired before the deadline", async function () {
      const id = await fileOne();
      await expect(bond.finalizeExpiredDispute(id)).to.be.revertedWithCustomError(bond, "ChallengeWindowNotExpired");
    });

    it("executes the slash automatically once the deadline passes, callable by anyone", async function () {
      const id = await fileOne();
      await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
      await ethers.provider.send("evm_mine");

      const before = await usdc.balanceOf(consumer.address);
      // Called by `stranger`, not owner and not the authorizedSlasher — permissionless by design.
      await expect(bond.connect(stranger).finalizeExpiredDispute(id))
        .to.emit(bond, "DisputeResolved")
        .withArgs(id, true, 5_000_000n, true);

      const after = await usdc.balanceOf(consumer.address);
      expect(after - before).to.equal(5_000_000n);
      expect((await bond.disputes(id)).state).to.equal(DISPUTE_RESOLVED);
    });

    it("reverts DisputeNotIndicted if already resolved (owner beat the deadline)", async function () {
      const id = await fileOne();
      await bond.resolveDispute(id, false);
      await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
      await ethers.provider.send("evm_mine");
      await expect(bond.finalizeExpiredDispute(id)).to.be.revertedWithCustomError(bond, "DisputeNotIndicted");
    });
  });

  // ---------------------------------------------------------------------------
  // admin: setChallengeParameters
  // ---------------------------------------------------------------------------

  describe("admin: setChallengeParameters", function () {
    it("updates challengeThreshold and disputeWindow, emits event", async function () {
      await expect(bond.setChallengeParameters(2_000_000n, 3600))
        .to.emit(bond, "ChallengeParametersUpdated")
        .withArgs(2_000_000n, 3600);
      expect(await bond.challengeThreshold()).to.equal(2_000_000n);
      expect(await bond.disputeWindow()).to.equal(3600);
    });

    it("reverts InvalidDisputeWindow for a zero window", async function () {
      await expect(bond.setChallengeParameters(2_000_000n, 0))
        .to.be.revertedWithCustomError(bond, "InvalidDisputeWindow");
    });

    it("reverts for a non-owner caller", async function () {
      await expect(bond.connect(agentA).setChallengeParameters(2_000_000n, 3600))
        .to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });
  });
});
