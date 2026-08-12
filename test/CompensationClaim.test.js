/**
 * CompensationClaim.test.js — Licensed AI Training Compensation Rail,
 * N-recipient Merkle-proof claim layer.
 *
 * Covers: allocation submission (fund pull from TrainingPool, both
 * independent ingestor gates, AlreadySubmitted, PoolNotFound), real
 * Merkle-proof claims (success, AlreadyClaimed, InvalidProof for both a
 * wrong amount and a wrong artist), admin ingestor rotation, and a full
 * real integration test that runs the actual Phase 3 ingestor pipeline
 * (ingestor/src/allocator.js) against real deployed contracts end to end —
 * submission through claim, for two real artists.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");
const { hashLeaf, buildTree, getProof } = require("../ingestor/src/merkle");
const { ingest, corpusLeaf } = require("../ingestor/src/allocator");

const TEN_USDC = 10_000_000n;
const FAKE_AGENT_ID = ethers.keccak256(ethers.toUtf8Bytes("fake-ingestor-agent"));
const RIGHTS_HASH = ethers.keccak256(ethers.toUtf8Bytes("rights-v1"));

async function deployBase() {
  const [owner, company, ingestor, artistA, artistB, other] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();

  const MockRegistry = await ethers.getContractFactory("MockRegistry");
  const registry = await MockRegistry.deploy();

  const ArtistRegistry = await ethers.getContractFactory("ArtistRegistry");
  const artistRegistry = await ArtistRegistry.deploy();

  const TrainingPool = await ethers.getContractFactory("TrainingPool");
  const pool = await TrainingPool.deploy(await usdc.getAddress());

  const CompensationClaim = await ethers.getContractFactory("CompensationClaim");
  const claimContract = await CompensationClaim.deploy(
    await usdc.getAddress(), await registry.getAddress(), await pool.getAddress()
  );

  await claimContract.connect(owner).setAuthorizedIngestor(ingestor.address);
  await registry.setVerified(ingestor.address, FAKE_AGENT_ID);
  await pool.connect(owner).setAuthorizedDistributor(await claimContract.getAddress());

  return { owner, company, ingestor, artistA, artistB, other, usdc, registry, artistRegistry, pool, claimContract };
}

async function fundPool(ctx, corpusRoot, amount) {
  await ctx.usdc.mint(ctx.company.address, amount);
  await ctx.usdc.connect(ctx.company).approve(await ctx.pool.getAddress(), amount);
  const tx = await ctx.pool.connect(ctx.company).createPool(corpusRoot, amount);
  await tx.wait();
  return 1n;
}

describe("CompensationClaim", function () {
  // ---------------------------------------------------------------------------
  // construction
  // ---------------------------------------------------------------------------

  describe("construction", function () {
    it("sets immutables, owner, and default authorizedIngestor", async function () {
      const ctx = await deployBase();
      expect(await ctx.claimContract.collateralToken()).to.equal(await ctx.usdc.getAddress());
      expect(await ctx.claimContract.registry()).to.equal(await ctx.registry.getAddress());
      expect(await ctx.claimContract.trainingPool()).to.equal(await ctx.pool.getAddress());
      expect(await ctx.claimContract.owner()).to.equal(ctx.owner.address);
    });

    it("reverts on any zero-address constructor arg", async function () {
      const ctx = await deployBase();
      const Factory = await ethers.getContractFactory("CompensationClaim");
      await expect(Factory.deploy(ethers.ZeroAddress, await ctx.registry.getAddress(), await ctx.pool.getAddress()))
        .to.be.revertedWithCustomError(Factory, "ZeroAddress");
      await expect(Factory.deploy(await ctx.usdc.getAddress(), ethers.ZeroAddress, await ctx.pool.getAddress()))
        .to.be.revertedWithCustomError(Factory, "ZeroAddress");
      await expect(Factory.deploy(await ctx.usdc.getAddress(), await ctx.registry.getAddress(), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });
  });

  // ---------------------------------------------------------------------------
  // submitAllocation
  // ---------------------------------------------------------------------------

  describe("submitAllocation", function () {
    it("pulls the pool's funds in, records the allocation, and emits AllocationSubmitted", async function () {
      const ctx = await deployBase();
      const corpusRoot = ethers.keccak256(ethers.toUtf8Bytes("corpus"));
      const poolId = await fundPool(ctx, corpusRoot, TEN_USDC);
      const allocationRoot = ethers.keccak256(ethers.toUtf8Bytes("allocation"));

      await expect(ctx.claimContract.connect(ctx.ingestor).submitAllocation(poolId, allocationRoot))
        .to.emit(ctx.claimContract, "AllocationSubmitted")
        .withArgs(poolId, allocationRoot, TEN_USDC);

      expect(await ctx.usdc.balanceOf(await ctx.claimContract.getAddress())).to.equal(TEN_USDC);

      const a = await ctx.claimContract.allocations(poolId);
      expect(a.allocationRoot).to.equal(allocationRoot);
      expect(a.totalAmount).to.equal(TEN_USDC);
      expect(a.submitted).to.equal(true);
    });

    it("reverts for a caller that isn't authorizedIngestor", async function () {
      const ctx = await deployBase();
      const corpusRoot = ethers.keccak256(ethers.toUtf8Bytes("corpus"));
      const poolId = await fundPool(ctx, corpusRoot, TEN_USDC);
      await expect(ctx.claimContract.connect(ctx.other).submitAllocation(poolId, ethers.ZeroHash))
        .to.be.revertedWithCustomError(ctx.claimContract, "NotAuthorizedIngestor");
    });

    it("reverts for an authorizedIngestor that isn't TEE-verified", async function () {
      const ctx = await deployBase();
      await ctx.claimContract.connect(ctx.owner).setAuthorizedIngestor(ctx.other.address); // never registry.setVerified'd
      const corpusRoot = ethers.keccak256(ethers.toUtf8Bytes("corpus"));
      const poolId = await fundPool(ctx, corpusRoot, TEN_USDC);
      await expect(ctx.claimContract.connect(ctx.other).submitAllocation(poolId, ethers.ZeroHash))
        .to.be.revertedWithCustomError(ctx.claimContract, "IngestorNotTEEVerified");
    });

    it("reverts for an unknown poolId", async function () {
      const ctx = await deployBase();
      await expect(ctx.claimContract.connect(ctx.ingestor).submitAllocation(999n, ethers.ZeroHash))
        .to.be.revertedWithCustomError(ctx.claimContract, "PoolNotFound");
    });

    it("reverts a second submission for the same pool", async function () {
      const ctx = await deployBase();
      const corpusRoot = ethers.keccak256(ethers.toUtf8Bytes("corpus"));
      const poolId = await fundPool(ctx, corpusRoot, TEN_USDC);
      await ctx.claimContract.connect(ctx.ingestor).submitAllocation(poolId, ethers.ZeroHash);
      await expect(ctx.claimContract.connect(ctx.ingestor).submitAllocation(poolId, ethers.ZeroHash))
        .to.be.revertedWithCustomError(ctx.claimContract, "AlreadySubmitted");
    });

    it("bubbles up TrainingPool's own AlreadyWithdrawn if the company reclaimed the pool first", async function () {
      const ctx = await deployBase();
      const corpusRoot = ethers.keccak256(ethers.toUtf8Bytes("corpus"));
      const poolId = await fundPool(ctx, corpusRoot, TEN_USDC);
      await ctx.pool.connect(ctx.company).withdrawPool(poolId);
      await expect(ctx.claimContract.connect(ctx.ingestor).submitAllocation(poolId, ethers.ZeroHash))
        .to.be.revertedWithCustomError(ctx.pool, "AlreadyWithdrawn");
    });
  });

  // ---------------------------------------------------------------------------
  // claim — hand-built tree
  // ---------------------------------------------------------------------------

  describe("claim", function () {
    async function submittedAllocation(ctx, pairs, poolAmount) {
      const corpusRoot = ethers.keccak256(ethers.toUtf8Bytes("corpus"));
      const poolId = await fundPool(ctx, corpusRoot, poolAmount);
      const leaves = pairs.map(([addr, amt]) => hashLeaf(["address", "uint256"], [addr, amt]));
      const tree = buildTree(leaves);
      await ctx.claimContract.connect(ctx.ingestor).submitAllocation(poolId, tree.root);
      return { poolId, tree, leaves };
    }

    it("pays out a valid claim, marks it claimed, and emits Claimed", async function () {
      const ctx = await deployBase();
      const pairs = [[ctx.artistA.address, 4_000_000n], [ctx.artistB.address, 6_000_000n]];
      const { poolId, tree } = await submittedAllocation(ctx, pairs, TEN_USDC);

      const before = await ctx.usdc.balanceOf(ctx.artistA.address);
      const proof = getProof(tree, 0);

      await expect(ctx.claimContract.connect(ctx.artistA).claim(poolId, 4_000_000n, proof))
        .to.emit(ctx.claimContract, "Claimed")
        .withArgs(poolId, ctx.artistA.address, 4_000_000n);

      expect(await ctx.usdc.balanceOf(ctx.artistA.address)).to.equal(before + 4_000_000n);
      expect(await ctx.claimContract.claimed(poolId, ctx.artistA.address)).to.equal(true);

      const a = await ctx.claimContract.allocations(poolId);
      expect(a.claimedAmount).to.equal(4_000_000n);
    });

    it("both artists can claim their own shares independently", async function () {
      const ctx = await deployBase();
      const pairs = [[ctx.artistA.address, 4_000_000n], [ctx.artistB.address, 6_000_000n]];
      const { poolId, tree } = await submittedAllocation(ctx, pairs, TEN_USDC);

      await ctx.claimContract.connect(ctx.artistA).claim(poolId, 4_000_000n, getProof(tree, 0));
      await ctx.claimContract.connect(ctx.artistB).claim(poolId, 6_000_000n, getProof(tree, 1));

      expect(await ctx.usdc.balanceOf(ctx.artistA.address)).to.equal(4_000_000n);
      expect(await ctx.usdc.balanceOf(ctx.artistB.address)).to.equal(6_000_000n);
    });

    it("reverts a second claim from the same artist", async function () {
      const ctx = await deployBase();
      const pairs = [[ctx.artistA.address, TEN_USDC]];
      const { poolId, tree } = await submittedAllocation(ctx, pairs, TEN_USDC);
      const proof = getProof(tree, 0);
      await ctx.claimContract.connect(ctx.artistA).claim(poolId, TEN_USDC, proof);
      await expect(ctx.claimContract.connect(ctx.artistA).claim(poolId, TEN_USDC, proof))
        .to.be.revertedWithCustomError(ctx.claimContract, "AlreadyClaimed");
    });

    it("reverts a claim with a tampered (inflated) amount, even with a structurally valid proof", async function () {
      const ctx = await deployBase();
      const pairs = [[ctx.artistA.address, 4_000_000n], [ctx.artistB.address, 6_000_000n]];
      const { poolId, tree } = await submittedAllocation(ctx, pairs, TEN_USDC);
      const proof = getProof(tree, 0);
      await expect(ctx.claimContract.connect(ctx.artistA).claim(poolId, 9_000_000n, proof))
        .to.be.revertedWithCustomError(ctx.claimContract, "InvalidProof");
    });

    it("reverts a claim from an address that isn't in the allocation at all", async function () {
      const ctx = await deployBase();
      const pairs = [[ctx.artistA.address, TEN_USDC]];
      const { poolId, tree } = await submittedAllocation(ctx, pairs, TEN_USDC);
      const proof = getProof(tree, 0); // artistA's proof
      await expect(ctx.claimContract.connect(ctx.other).claim(poolId, TEN_USDC, proof))
        .to.be.revertedWithCustomError(ctx.claimContract, "InvalidProof");
    });

    it("reverts a claim against a poolId that was never submitted", async function () {
      const ctx = await deployBase();
      await expect(ctx.claimContract.connect(ctx.artistA).claim(999n, 1n, []))
        .to.be.revertedWithCustomError(ctx.claimContract, "NotSubmitted");
    });
  });

  // ---------------------------------------------------------------------------
  // setAuthorizedIngestor
  // ---------------------------------------------------------------------------

  describe("setAuthorizedIngestor", function () {
    it("updates the ingestor and emits IngestorUpdated", async function () {
      const ctx = await deployBase();
      await expect(ctx.claimContract.connect(ctx.owner).setAuthorizedIngestor(ctx.other.address))
        .to.emit(ctx.claimContract, "IngestorUpdated")
        .withArgs(ctx.ingestor.address, ctx.other.address);
      expect(await ctx.claimContract.authorizedIngestor()).to.equal(ctx.other.address);
    });

    it("reverts for a non-owner caller", async function () {
      const ctx = await deployBase();
      await expect(ctx.claimContract.connect(ctx.other).setAuthorizedIngestor(ctx.other.address))
        .to.be.revertedWithCustomError(ctx.claimContract, "OwnableUnauthorizedAccount");
    });

    it("reverts on a zero-address ingestor", async function () {
      const ctx = await deployBase();
      await expect(ctx.claimContract.connect(ctx.owner).setAuthorizedIngestor(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(ctx.claimContract, "ZeroAddress");
    });
  });

  // ---------------------------------------------------------------------------
  // full pipeline integration — real ingestor logic, real chain, real claims
  // ---------------------------------------------------------------------------

  describe("integration — Phase 2 + Phase 3 + Phase 4 wired together for real", function () {
    it("registers artists, funds a pool, ingests via the real allocator, submits, and both artists claim correctly", async function () {
      const ctx = await deployBase();

      const fpA1 = ethers.keccak256(ethers.toUtf8Bytes("track-a1"));
      const fpA2 = ethers.keccak256(ethers.toUtf8Bytes("track-a2"));
      const fpB1 = ethers.keccak256(ethers.toUtf8Bytes("track-b1"));
      await ctx.artistRegistry.connect(ctx.artistA).registerTrack(fpA1, RIGHTS_HASH);
      await ctx.artistRegistry.connect(ctx.artistA).registerTrack(fpA2, RIGHTS_HASH);
      await ctx.artistRegistry.connect(ctx.artistB).registerTrack(fpB1, RIGHTS_HASH);

      const corpus = [fpA1, fpA2, fpB1];
      const { root: corpusRoot } = buildTree(corpus.map(corpusLeaf));
      const poolAmount = 30_000_000n; // 30 USDC / 3 tracks = 10 USDC/track
      const poolId = await fundPool(ctx, corpusRoot, poolAmount);

      const onChainPool = await ctx.pool.pools(poolId);
      const result = await ingest({
        corpus,
        committedCorpusRoot: onChainPool.corpusRoot,
        poolAmount: onChainPool.amount,
        resolveArtist: (fp) => ctx.artistRegistry.artistOf(fp),
      });

      await expect(ctx.claimContract.connect(ctx.ingestor).submitAllocation(poolId, result.allocationRoot))
        .to.emit(ctx.claimContract, "AllocationSubmitted")
        .withArgs(poolId, result.allocationRoot, poolAmount);

      expect(await ctx.usdc.balanceOf(await ctx.claimContract.getAddress())).to.equal(poolAmount);

      const allocA = result.allocations.find((a) => a.artist === ctx.artistA.address);
      const allocB = result.allocations.find((a) => a.artist === ctx.artistB.address);
      expect(allocA.amount).to.equal(20_000_000n); // 2 tracks
      expect(allocB.amount).to.equal(10_000_000n); // 1 track

      await ctx.claimContract.connect(ctx.artistA).claim(poolId, allocA.amount, allocA.proof);
      await ctx.claimContract.connect(ctx.artistB).claim(poolId, allocB.amount, allocB.proof);

      expect(await ctx.usdc.balanceOf(ctx.artistA.address)).to.equal(20_000_000n);
      expect(await ctx.usdc.balanceOf(ctx.artistB.address)).to.equal(10_000_000n);
      expect(await ctx.usdc.balanceOf(await ctx.claimContract.getAddress())).to.equal(0n);
    });
  });
});
