/**
 * ERC8004ReputationAdapter.test.js — Phase 8.2 (post-submission — see
 * CHANGELOG.md): dual-write of slash/settlement outcomes into Arc's real
 * ERC-8004 ReputationRegistry.
 *
 * Two layers covered separately:
 *   1. The adapter contract standalone — value-scale math, agentId
 *      registration/skip behavior, and its own try/catch around the
 *      external registry call.
 *   2. ArcIDBond integration — the critical invariant that a misbehaving
 *      adapter (or the registry it wraps) can NEVER block a real
 *      slash/settlement, proven against both failure layers independently.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const BREACH_SEMANTIC = 0;
const BREACH_HARD     = 1;
const FIVE_USDC   = 5_000_000n;
const HUNDRED_USDC = 100_000_000n;
const AGENT_ID_1 = 1;
const EVIDENCE_HASH = ethers.keccak256(ethers.toUtf8Bytes("sample evidence"));

describe("ERC8004ReputationAdapter (standalone)", function () {
  let adapter, mockRegistry;
  let owner, bondSigner, agent, stranger;

  beforeEach(async function () {
    [owner, bondSigner, agent, stranger] = await ethers.getSigners();

    const MockReputationRegistry = await ethers.getContractFactory("MockReputationRegistry");
    mockRegistry = await MockReputationRegistry.deploy();

    const Adapter = await ethers.getContractFactory("ERC8004ReputationAdapter");
    adapter = await Adapter.deploy(await mockRegistry.getAddress(), bondSigner.address);
  });

  describe("construction", function () {
    it("sets reputationRegistry and bondContract correctly", async function () {
      expect(await adapter.reputationRegistry()).to.equal(await mockRegistry.getAddress());
      expect(await adapter.bondContract()).to.equal(bondSigner.address);
    });
  });

  describe("admin setters", function () {
    it("setAgentId sets the mapping and emits AgentIdSet", async function () {
      await expect(adapter.setAgentId(agent.address, AGENT_ID_1))
        .to.emit(adapter, "AgentIdSet").withArgs(agent.address, AGENT_ID_1);
      expect(await adapter.agentId8004(agent.address)).to.equal(AGENT_ID_1);
    });

    it("setAgentId reverts for a non-owner caller", async function () {
      await expect(adapter.connect(stranger).setAgentId(agent.address, AGENT_ID_1))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("setBondContract updates bondContract and emits BondContractUpdated", async function () {
      await expect(adapter.setBondContract(stranger.address))
        .to.emit(adapter, "BondContractUpdated").withArgs(bondSigner.address, stranger.address);
      expect(await adapter.bondContract()).to.equal(stranger.address);
    });

    it("setVerdictBaseURI updates verdictBaseURI and emits VerdictBaseURIUpdated", async function () {
      await expect(adapter.setVerdictBaseURI("http://localhost:3001/api/verdict/"))
        .to.emit(adapter, "VerdictBaseURIUpdated").withArgs("", "http://localhost:3001/api/verdict/");
      expect(await adapter.verdictBaseURI()).to.equal("http://localhost:3001/api/verdict/");
    });
  });

  describe("onlyBond", function () {
    it("reportSlash reverts NotBondContract for a caller that isn't bondContract", async function () {
      await expect(
        adapter.connect(stranger).reportSlash(agent.address, 10n, 100n, false, EVIDENCE_HASH)
      ).to.be.revertedWithCustomError(adapter, "NotBondContract");
    });

    it("reportSettlement reverts NotBondContract for a caller that isn't bondContract", async function () {
      await expect(
        adapter.connect(stranger).reportSettlement(agent.address, EVIDENCE_HASH)
      ).to.be.revertedWithCustomError(adapter, "NotBondContract");
    });
  });

  describe("reportSlash", function () {
    it("skips cleanly (no registry call) when the agent has no registered agentId", async function () {
      await expect(
        adapter.connect(bondSigner).reportSlash(agent.address, 10n, 100n, false, EVIDENCE_HASH)
      ).to.emit(adapter, "ReputationSkipped");
      expect(await mockRegistry.callCount()).to.equal(0n);
    });

    it("computes value as the negative percentage of bond slashed, and forwards tags/hash correctly", async function () {
      await adapter.setAgentId(agent.address, AGENT_ID_1);
      await adapter.setVerdictBaseURI("http://localhost:3001/api/verdict/");

      await expect(
        adapter.connect(bondSigner).reportSlash(agent.address, 10n, 100n, false, EVIDENCE_HASH)
      ).to.emit(adapter, "ReputationReported").withArgs(agent.address, AGENT_ID_1, -10n, true);

      expect(await mockRegistry.lastAgentId()).to.equal(AGENT_ID_1);
      expect(await mockRegistry.lastValue()).to.equal(-10n);
      expect(await mockRegistry.lastValueDecimals()).to.equal(0);
      expect(await mockRegistry.lastTag1()).to.equal("arcid2");
      expect(await mockRegistry.lastTag2()).to.equal("semantic");
      expect(await mockRegistry.lastFeedbackHash()).to.equal(EVIDENCE_HASH);
      expect(await mockRegistry.lastFeedbackURI()).to.equal(
        "http://localhost:3001/api/verdict/" + EVIDENCE_HASH
      );
    });

    it("tags Hard breaches distinctly from Semantic", async function () {
      await adapter.setAgentId(agent.address, AGENT_ID_1);
      await adapter.connect(bondSigner).reportSlash(agent.address, 10n, 100n, true, EVIDENCE_HASH);
      expect(await mockRegistry.lastTag2()).to.equal("hard");
    });

    it("a full-drain slash (amountSlashed == bondBeforeSlash) computes value = -100", async function () {
      await adapter.setAgentId(agent.address, AGENT_ID_1);
      await adapter.connect(bondSigner).reportSlash(agent.address, 100n, 100n, true, EVIDENCE_HASH);
      expect(await mockRegistry.lastValue()).to.equal(-100n);
    });

    it("guards the bondBeforeSlash == 0 edge case to value = -100 rather than dividing by zero", async function () {
      await adapter.setAgentId(agent.address, AGENT_ID_1);
      await expect(
        adapter.connect(bondSigner).reportSlash(agent.address, 0n, 0n, false, EVIDENCE_HASH)
      ).to.emit(adapter, "ReputationReported").withArgs(agent.address, AGENT_ID_1, -100n, true);
    });

    it("catches a reverting registry and emits ReputationWriteFailed instead of reverting", async function () {
      await adapter.setAgentId(agent.address, AGENT_ID_1);
      await mockRegistry.setShouldRevert(true);

      await expect(
        adapter.connect(bondSigner).reportSlash(agent.address, 10n, 100n, false, EVIDENCE_HASH)
      ).to.emit(adapter, "ReputationWriteFailed");
      // The call itself did not revert — that's the point being tested.
    });
  });

  describe("reportSettlement", function () {
    it("skips cleanly when the agent has no registered agentId", async function () {
      await expect(
        adapter.connect(bondSigner).reportSettlement(agent.address, EVIDENCE_HASH)
      ).to.emit(adapter, "ReputationSkipped");
      expect(await mockRegistry.callCount()).to.equal(0n);
    });

    it("reports value = 100 and tag2 = settlement, reusing verdictHash as feedbackHash", async function () {
      await adapter.setAgentId(agent.address, AGENT_ID_1);

      await expect(
        adapter.connect(bondSigner).reportSettlement(agent.address, EVIDENCE_HASH)
      ).to.emit(adapter, "ReputationReported").withArgs(agent.address, AGENT_ID_1, 100n, false);

      expect(await mockRegistry.lastValue()).to.equal(100n);
      expect(await mockRegistry.lastTag2()).to.equal("settlement");
      expect(await mockRegistry.lastFeedbackHash()).to.equal(EVIDENCE_HASH);
    });

    it("catches a reverting registry and emits ReputationWriteFailed instead of reverting", async function () {
      await adapter.setAgentId(agent.address, AGENT_ID_1);
      await mockRegistry.setShouldRevert(true);

      await expect(
        adapter.connect(bondSigner).reportSettlement(agent.address, EVIDENCE_HASH)
      ).to.emit(adapter, "ReputationWriteFailed");
    });
  });
});

describe("ArcIDBond — ERC-8004 reputation dual-write integration (Phase 8.2)", function () {
  let bond, usdc, registry, adapter, mockRegistry, badAdapter;
  let owner, agentA, consumer;
  const FAKE_ID = ethers.keccak256(ethers.toUtf8Bytes("agentA"));

  beforeEach(async function () {
    [owner, agentA, consumer] = await ethers.getSigners();

    const MockUSDC     = await ethers.getContractFactory("MockUSDC");
    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    usdc     = await MockUSDC.deploy();
    registry = await MockRegistry.deploy();
    await registry.setVerified(agentA.address, FAKE_ID);

    const ArcIDBond = await ethers.getContractFactory("ArcIDBond");
    bond = await ArcIDBond.deploy(await usdc.getAddress(), await registry.getAddress());
    await bond.setEscalationThresholds(1, 1); // one call = full drain, matches other suites' convention

    await usdc.mint(agentA.address, HUNDRED_USDC);
    await usdc.connect(agentA).approve(await bond.getAddress(), ethers.MaxUint256);
    await bond.connect(agentA).postBond(FIVE_USDC);

    const MockReputationRegistry = await ethers.getContractFactory("MockReputationRegistry");
    mockRegistry = await MockReputationRegistry.deploy();

    const Adapter = await ethers.getContractFactory("ERC8004ReputationAdapter");
    adapter = await Adapter.deploy(await mockRegistry.getAddress(), await bond.getAddress());
    await adapter.setAgentId(agentA.address, AGENT_ID_1);

    const MockBadReputationAdapter = await ethers.getContractFactory("MockBadReputationAdapter");
    badAdapter = await MockBadReputationAdapter.deploy();
  });

  describe("setReputationAdapter", function () {
    it("defaults to the zero address", async function () {
      expect(await bond.reputationAdapter()).to.equal(ethers.ZeroAddress);
    });

    it("owner can set it, emits ReputationAdapterUpdated", async function () {
      await expect(bond.setReputationAdapter(await adapter.getAddress()))
        .to.emit(bond, "ReputationAdapterUpdated")
        .withArgs(ethers.ZeroAddress, await adapter.getAddress());
      expect(await bond.reputationAdapter()).to.equal(await adapter.getAddress());
    });

    it("reverts for a non-owner caller", async function () {
      await expect(bond.connect(agentA).setReputationAdapter(await adapter.getAddress()))
        .to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });
  });

  describe("slash() dual-write", function () {
    it("with no adapter set, slash() behaves exactly as before (unaffected)", async function () {
      await expect(bond.slash(agentA.address, consumer.address, "hard breach", BREACH_HARD))
        .to.emit(bond, "AgentSlashed");
      // No adapter deployed into this call at all — nothing further to assert,
      // the existing 131-test suite already covers unset-adapter behavior in
      // full; this is just an explicit sanity check in this new file too.
    });

    it("with an adapter set and the agent registered, dual-writes to the mock registry with the correct percentage value", async function () {
      await bond.setReputationAdapter(await adapter.getAddress());

      const tx = await bond.slash(agentA.address, consumer.address, "hard breach", BREACH_HARD);
      await tx.wait();

      // Escalation thresholds are 1 -> this single Hard call fully drains the
      // $5 bond -> amountSlashed == bondBeforeSlash -> value should be -100.
      expect(await mockRegistry.callCount()).to.equal(1n);
      expect(await mockRegistry.lastValue()).to.equal(-100n);
      expect(await mockRegistry.lastTag2()).to.equal("hard");
      expect(await mockRegistry.lastFeedbackHash()).to.equal(ethers.keccak256(ethers.toUtf8Bytes("hard breach")));
    });

    it("slash() still succeeds and transfers funds even when the registry underneath the adapter reverts", async function () {
      await bond.setReputationAdapter(await adapter.getAddress());
      await mockRegistry.setShouldRevert(true);

      const before = await usdc.balanceOf(consumer.address);
      await expect(bond.slash(agentA.address, consumer.address, "hard breach", BREACH_HARD))
        .to.emit(bond, "AgentSlashed");
      const after = await usdc.balanceOf(consumer.address);

      expect(after).to.be.greaterThan(before); // the slash's real fund transfer still happened
    });

    it("slash() still succeeds even when the adapter contract itself always reverts (not just its inner registry call)", async function () {
      await bond.setReputationAdapter(await badAdapter.getAddress());

      const before = await usdc.balanceOf(consumer.address);
      await expect(bond.slash(agentA.address, consumer.address, "hard breach", BREACH_HARD))
        .to.emit(bond, "AgentSlashed");
      const after = await usdc.balanceOf(consumer.address);

      expect(after).to.be.greaterThan(before);
    });
  });

  describe("recordSettlement() dual-write", function () {
    it("dual-writes value = 100 to the mock registry, reusing verdictHash as feedbackHash", async function () {
      await bond.setReputationAdapter(await adapter.getAddress());
      const vHash = ethers.keccak256(ethers.toUtf8Bytes("clean verdict"));

      await bond.setAuthorizedSlasher(owner.address);
      await expect(bond.recordSettlement(agentA.address, consumer.address, 1_000n, vHash))
        .to.emit(bond, "PaymentSettled");

      expect(await mockRegistry.callCount()).to.equal(1n);
      expect(await mockRegistry.lastValue()).to.equal(100n);
      expect(await mockRegistry.lastTag2()).to.equal("settlement");
      expect(await mockRegistry.lastFeedbackHash()).to.equal(vHash);
    });

    it("recordSettlement() still succeeds even when the adapter always reverts", async function () {
      await bond.setReputationAdapter(await badAdapter.getAddress());
      const vHash = ethers.keccak256(ethers.toUtf8Bytes("clean verdict 2"));

      await expect(bond.recordSettlement(agentA.address, consumer.address, 1_000n, vHash))
        .to.emit(bond, "PaymentSettled");
    });
  });

  describe("dispute-path dual-write (resolveDispute / finalizeExpiredDispute)", function () {
    const RATIONALE_HASH = ethers.keccak256(ethers.toUtf8Bytes("dispute rationale"));
    const FIVE_HUNDRED_USDC = 500_000_000n;
    let agentB;

    beforeEach(async function () {
      [, , , , agentB] = await ethers.getSigners();
      await bond.setReputationAdapter(await adapter.getAddress());
      await adapter.setAgentId(agentB.address, 2);

      // Fresh agent + bond sized so a semantic breach exceeds the default
      // $1.00 challengeThreshold without escalating (mirrors
      // ArcIDDispute.test.js's own scaleFeeSoBondCapBinds/freshBondedAgent
      // convention: k*fee = $100, well above bondCap, so bondCap binds).
      await bond.setEscalationThresholds(1, 100); // semantic won't escalate on the 1st breach
      await bond.setSlashParameters(100_000, 100, 1_000); // k=100,000 -> k*fee = $100
      await registry.setVerified(agentB.address, ethers.keccak256(ethers.toUtf8Bytes("agentB")));
      await usdc.mint(agentB.address, FIVE_HUNDRED_USDC);
      await usdc.connect(agentB).approve(await bond.getAddress(), FIVE_HUNDRED_USDC);
      await bond.connect(agentB).postBond(FIVE_HUNDRED_USDC);
    });

    it("resolveDispute(approved=true) reports the stored rationaleHash, not a hash of the placeholder reason string", async function () {
      await bond.fileIndictment(agentB.address, consumer.address, RATIONALE_HASH);
      await bond.resolveDispute(1, true);

      expect(await mockRegistry.callCount()).to.equal(1n);
      expect(await mockRegistry.lastFeedbackHash()).to.equal(RATIONALE_HASH);
      expect(await mockRegistry.lastFeedbackHash()).to.not.equal(
        ethers.keccak256(ethers.toUtf8Bytes("[DISPUTE APPROVED] see rationaleHash on IndictmentFiled event"))
      );
    });

    it("finalizeExpiredDispute() also reports the stored rationaleHash", async function () {
      // setChallengeParameters must happen BEFORE fileIndictment() — the
      // dispute's challengeDeadline is computed at indictment time from
      // whatever disputeWindow is active then, not retroactively shortened.
      await bond.setChallengeParameters(await bond.challengeThreshold(), 1); // 1-second window
      await bond.fileIndictment(agentB.address, consumer.address, RATIONALE_HASH);
      await ethers.provider.send("evm_increaseTime", [2]);
      await ethers.provider.send("evm_mine", []);

      await bond.finalizeExpiredDispute(1);

      expect(await mockRegistry.callCount()).to.equal(1n);
      expect(await mockRegistry.lastFeedbackHash()).to.equal(RATIONALE_HASH);
    });
  });
});
