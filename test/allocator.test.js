/**
 * allocator.test.js — ingestor/src/allocator.js, the actual ingestion +
 * allocation logic. Includes a real integration test that deploys
 * ArtistRegistry + TrainingPool via Hardhat, registers real artists, and
 * runs ingest() with `resolveArtist` reading the real deployed contract —
 * not a mocked function — proving the pipeline works against actual chain
 * state, not just isolated unit logic.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");
const {
  ingest, corpusLeaf, allocationLeaf, CorpusMismatchError, UnlicensedTrackError,
} = require("../ingestor/src/allocator");
const { buildTree } = require("../ingestor/src/merkle");

const FP = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));
const RIGHTS_HASH = ethers.keccak256(ethers.toUtf8Bytes("rights-metadata-v1"));

describe("allocator (ingestor/src/allocator.js)", function () {
  describe("unit — isolated logic, mocked resolveArtist", function () {
    it("splits a pool equally per track and aggregates multi-track artists", async function () {
      const [, artistA, artistB] = await ethers.getSigners();
      const corpus = [FP("t1"), FP("t2"), FP("t3")]; // t1,t2 -> A, t3 -> B
      const ownerByFp = { [FP("t1")]: artistA.address, [FP("t2")]: artistA.address, [FP("t3")]: artistB.address };
      const { root: committedCorpusRoot } = buildTree(corpus.map(corpusLeaf));

      const result = await ingest({
        corpus,
        committedCorpusRoot,
        poolAmount: 9_000_000n, // 9 USDC / 3 tracks = 3 USDC/track, no remainder
        resolveArtist: async (fp) => ownerByFp[fp],
      });

      expect(result.allocations).to.have.lengthOf(2);
      const a = result.allocations.find((x) => x.artist === artistA.address);
      const b = result.allocations.find((x) => x.artist === artistB.address);
      expect(a.amount).to.equal(6_000_000n); // 2 tracks x 3 USDC
      expect(b.amount).to.equal(3_000_000n); // 1 track x 3 USDC
    });

    it("distributes the remainder to the first tracks in corpus order, losing no dust", async function () {
      const [, artistA, artistB, artistC] = await ethers.getSigners();
      const corpus = [FP("t1"), FP("t2"), FP("t3")];
      const ownerByFp = { [FP("t1")]: artistA.address, [FP("t2")]: artistB.address, [FP("t3")]: artistC.address };
      const { root: committedCorpusRoot } = buildTree(corpus.map(corpusLeaf));

      const poolAmount = 10n; // 10 / 3 = 3 remainder 1 -> track 0 gets +1
      const result = await ingest({
        corpus, committedCorpusRoot, poolAmount,
        resolveArtist: async (fp) => ownerByFp[fp],
      });

      const total = result.allocations.reduce((s, a) => s + a.amount, 0n);
      expect(total).to.equal(poolAmount);
      const a = result.allocations.find((x) => x.artist === artistA.address);
      expect(a.amount).to.equal(4n); // 3 + 1 remainder
    });

    it("rejects a corpus that doesn't match the committed root", async function () {
      const [, artistA] = await ethers.getSigners();
      await expect(
        ingest({
          corpus: [FP("t1")],
          committedCorpusRoot: ethers.keccak256(ethers.toUtf8Bytes("some-other-root")),
          poolAmount: 100n,
          resolveArtist: async () => artistA.address,
        })
      ).to.be.rejectedWith(CorpusMismatchError);
    });

    it("rejects a corpus containing an unlicensed (unregistered) track", async function () {
      const corpus = [FP("t1")];
      const { root: committedCorpusRoot } = buildTree(corpus.map(corpusLeaf));
      await expect(
        ingest({
          corpus, committedCorpusRoot, poolAmount: 100n,
          resolveArtist: async () => ethers.ZeroAddress,
        })
      ).to.be.rejectedWith(UnlicensedTrackError);
    });

    it("every returned proof verifies against the returned allocationRoot", async function () {
      const [, artistA, artistB] = await ethers.getSigners();
      const corpus = [FP("t1"), FP("t2")];
      const ownerByFp = { [FP("t1")]: artistA.address, [FP("t2")]: artistB.address };
      const { root: committedCorpusRoot } = buildTree(corpus.map(corpusLeaf));

      const result = await ingest({
        corpus, committedCorpusRoot, poolAmount: 100n,
        resolveArtist: async (fp) => ownerByFp[fp],
      });

      const { verifyProof } = require("../ingestor/src/merkle");
      for (const a of result.allocations) {
        expect(verifyProof(result.allocationRoot, a.leaf, a.proof)).to.equal(true);
      }
    });
  });

  describe("integration — real ArtistRegistry + TrainingPool, real chain reads", function () {
    it("ingests a real corpus committed on-chain, resolving artists via a live contract call", async function () {
      const [owner, company, artistA, artistB] = await ethers.getSigners();

      const ArtistRegistry = await ethers.getContractFactory("ArtistRegistry");
      const registry = await ArtistRegistry.deploy();

      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();

      const TrainingPool = await ethers.getContractFactory("TrainingPool");
      const pool = await TrainingPool.deploy(await usdc.getAddress());

      // Two artists register three real tracks.
      const fpA1 = FP("real-track-a1");
      const fpA2 = FP("real-track-a2");
      const fpB1 = FP("real-track-b1");
      await registry.connect(artistA).registerTrack(fpA1, RIGHTS_HASH);
      await registry.connect(artistA).registerTrack(fpA2, RIGHTS_HASH);
      await registry.connect(artistB).registerTrack(fpB1, RIGHTS_HASH);

      // Company commits a corpus root over exactly these three tracks and funds the pool.
      const corpus = [fpA1, fpA2, fpB1];
      const { root: corpusRoot } = buildTree(corpus.map(corpusLeaf));
      const poolAmount = 30_000_000n; // 30 USDC / 3 tracks = 10 USDC/track

      await usdc.mint(company.address, poolAmount);
      await usdc.connect(company).approve(await pool.getAddress(), poolAmount);
      await pool.connect(company).createPool(corpusRoot, poolAmount);

      // Read the pool back from chain exactly as the real ingestion service would.
      const onChainPool = await pool.pools(1n);
      expect(onChainPool.corpusRoot).to.equal(corpusRoot);

      const result = await ingest({
        corpus,
        committedCorpusRoot: onChainPool.corpusRoot,
        poolAmount: onChainPool.amount,
        resolveArtist: (fp) => registry.artistOf(fp), // real on-chain call, not a mock
      });

      const a = result.allocations.find((x) => x.artist === artistA.address);
      const b = result.allocations.find((x) => x.artist === artistB.address);
      expect(a.amount).to.equal(20_000_000n); // 2 tracks
      expect(b.amount).to.equal(10_000_000n); // 1 track
      expect(a.amount + b.amount).to.equal(poolAmount);
    });

    it("rejects ingestion when the AI company's claimed corpus omits a committed track (integrity check catches it)", async function () {
      const [, company, artistA] = await ethers.getSigners();

      const ArtistRegistry = await ethers.getContractFactory("ArtistRegistry");
      const registry = await ArtistRegistry.deploy();
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdc = await MockUSDC.deploy();
      const TrainingPool = await ethers.getContractFactory("TrainingPool");
      const pool = await TrainingPool.deploy(await usdc.getAddress());

      const fp1 = FP("committed-1");
      const fp2 = FP("committed-2");
      await registry.connect(artistA).registerTrack(fp1, RIGHTS_HASH);
      await registry.connect(artistA).registerTrack(fp2, RIGHTS_HASH);

      const realCorpus = [fp1, fp2];
      const { root: corpusRoot } = buildTree(realCorpus.map(corpusLeaf));
      await usdc.mint(company.address, 100n);
      await usdc.connect(company).approve(await pool.getAddress(), 100n);
      await pool.connect(company).createPool(corpusRoot, 100n);
      const onChainPool = await pool.pools(1n);

      // Attempt to ingest a DIFFERENT (smaller) corpus than what was committed.
      const claimedCorpus = [fp1];
      await expect(
        ingest({
          corpus: claimedCorpus,
          committedCorpusRoot: onChainPool.corpusRoot,
          poolAmount: onChainPool.amount,
          resolveArtist: (fp) => registry.artistOf(fp),
        })
      ).to.be.rejectedWith(CorpusMismatchError);
    });
  });
});
