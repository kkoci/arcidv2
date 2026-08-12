/**
 * TrainingPool.test.js — Licensed AI Training Compensation Rail, pool
 * escrow + corpus-commitment layer.
 *
 * Covers: pool creation + fund transfer + corpus-root commitment,
 * distribution to a claim contract (the payout-critical path), the
 * distributed/withdrawn mutual exclusion in both directions, company-only
 * withdrawal, and admin distributor rotation.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const TEN_USDC  = 10_000_000n;  // 10 USDC (6 decimals)
const FIVE_USDC = 5_000_000n;
const CORPUS_ROOT = ethers.keccak256(ethers.toUtf8Bytes("demo-corpus-merkle-root-v1"));
const OTHER_CORPUS_ROOT = ethers.keccak256(ethers.toUtf8Bytes("demo-corpus-merkle-root-v2"));

describe("TrainingPool", function () {
  let pool, usdc;
  let owner, company, distributor, claimContract, other;

  beforeEach(async function () {
    [owner, company, distributor, claimContract, other] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const TrainingPool = await ethers.getContractFactory("TrainingPool");
    pool = await TrainingPool.deploy(await usdc.getAddress());

    await pool.connect(owner).setAuthorizedDistributor(distributor.address);

    await usdc.mint(company.address, 100_000_000n);
    await usdc.connect(company).approve(await pool.getAddress(), ethers.MaxUint256);
  });

  async function createPool(amount = TEN_USDC, corpusRoot = CORPUS_ROOT) {
    const tx = await pool.connect(company).createPool(corpusRoot, amount);
    await tx.wait();
    return 1n; // first poolId in a fresh beforeEach
  }

  // ---------------------------------------------------------------------------
  // construction
  // ---------------------------------------------------------------------------

  describe("construction", function () {
    it("sets collateralToken, owner, and default authorizedDistributor", async function () {
      const fresh = await (await ethers.getContractFactory("TrainingPool"))
        .deploy(await usdc.getAddress());
      expect(await fresh.collateralToken()).to.equal(await usdc.getAddress());
      expect(await fresh.owner()).to.equal(owner.address);
      expect(await fresh.authorizedDistributor()).to.equal(owner.address);
    });

    it("reverts on a zero-address collateralToken", async function () {
      const Factory = await ethers.getContractFactory("TrainingPool");
      await expect(Factory.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });
  });

  // ---------------------------------------------------------------------------
  // createPool
  // ---------------------------------------------------------------------------

  describe("createPool", function () {
    it("transfers USDC in, stores the pool, and emits PoolCreated", async function () {
      const before = await usdc.balanceOf(await pool.getAddress());

      await expect(pool.connect(company).createPool(CORPUS_ROOT, TEN_USDC))
        .to.emit(pool, "PoolCreated")
        .withArgs(1n, company.address, CORPUS_ROOT, TEN_USDC);

      expect(await usdc.balanceOf(await pool.getAddress())).to.equal(before + TEN_USDC);

      const p = await pool.pools(1n);
      expect(p.company).to.equal(company.address);
      expect(p.corpusRoot).to.equal(CORPUS_ROOT);
      expect(p.amount).to.equal(TEN_USDC);
      expect(p.distributed).to.equal(false);
      expect(p.withdrawn).to.equal(false);
    });

    it("increments poolId across multiple pools", async function () {
      await createPool();
      await pool.connect(company).createPool(OTHER_CORPUS_ROOT, FIVE_USDC);
      const p2 = await pool.pools(2n);
      expect(p2.corpusRoot).to.equal(OTHER_CORPUS_ROOT);
    });

    it("reverts on a zero amount", async function () {
      await expect(pool.connect(company).createPool(CORPUS_ROOT, 0))
        .to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("reverts on a zero corpus root", async function () {
      await expect(pool.connect(company).createPool(ethers.ZeroHash, TEN_USDC))
        .to.be.revertedWithCustomError(pool, "ZeroCorpusRoot");
    });
  });

  // ---------------------------------------------------------------------------
  // distributeToClaimContract
  // ---------------------------------------------------------------------------

  describe("distributeToClaimContract", function () {
    it("pays the full pool amount to the claim contract, zeroes the pool, and emits PoolDistributed", async function () {
      const poolId = await createPool();

      await expect(pool.connect(distributor).distributeToClaimContract(poolId, claimContract.address))
        .to.emit(pool, "PoolDistributed")
        .withArgs(poolId, claimContract.address, TEN_USDC);

      expect(await usdc.balanceOf(claimContract.address)).to.equal(TEN_USDC);

      const p = await pool.pools(poolId);
      expect(p.amount).to.equal(0n);
      expect(p.distributed).to.equal(true);
    });

    it("reverts for a caller that isn't authorizedDistributor", async function () {
      const poolId = await createPool();
      await expect(pool.connect(other).distributeToClaimContract(poolId, claimContract.address))
        .to.be.revertedWithCustomError(pool, "NotAuthorizedDistributor");
    });

    it("reverts on a zero-address claim contract", async function () {
      const poolId = await createPool();
      await expect(pool.connect(distributor).distributeToClaimContract(poolId, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("reverts for an unknown poolId", async function () {
      await expect(pool.connect(distributor).distributeToClaimContract(999n, claimContract.address))
        .to.be.revertedWithCustomError(pool, "PoolNotFound");
    });

    it("reverts on a second distribution of the same pool", async function () {
      const poolId = await createPool();
      await pool.connect(distributor).distributeToClaimContract(poolId, claimContract.address);
      await expect(pool.connect(distributor).distributeToClaimContract(poolId, claimContract.address))
        .to.be.revertedWithCustomError(pool, "AlreadyDistributed");
    });

    it("reverts distribution of a pool the company already withdrew", async function () {
      const poolId = await createPool();
      await pool.connect(company).withdrawPool(poolId);
      await expect(pool.connect(distributor).distributeToClaimContract(poolId, claimContract.address))
        .to.be.revertedWithCustomError(pool, "AlreadyWithdrawn");
    });
  });

  // ---------------------------------------------------------------------------
  // withdrawPool
  // ---------------------------------------------------------------------------

  describe("withdrawPool", function () {
    it("returns the full amount to the company and emits PoolWithdrawn", async function () {
      const poolId = await createPool();
      const before = await usdc.balanceOf(company.address);

      await expect(pool.connect(company).withdrawPool(poolId))
        .to.emit(pool, "PoolWithdrawn")
        .withArgs(poolId, company.address, TEN_USDC);

      expect(await usdc.balanceOf(company.address)).to.equal(before + TEN_USDC);

      const p = await pool.pools(poolId);
      expect(p.amount).to.equal(0n);
      expect(p.withdrawn).to.equal(true);
    });

    it("reverts for a caller that isn't the pool's company", async function () {
      const poolId = await createPool();
      await expect(pool.connect(other).withdrawPool(poolId))
        .to.be.revertedWithCustomError(pool, "NotPoolCompany");
    });

    it("reverts for an unknown poolId", async function () {
      await expect(pool.connect(company).withdrawPool(999n))
        .to.be.revertedWithCustomError(pool, "PoolNotFound");
    });

    it("reverts a second withdrawal of the same pool", async function () {
      const poolId = await createPool();
      await pool.connect(company).withdrawPool(poolId);
      await expect(pool.connect(company).withdrawPool(poolId))
        .to.be.revertedWithCustomError(pool, "AlreadyWithdrawn");
    });

    it("reverts withdrawal of a pool that was already distributed", async function () {
      const poolId = await createPool();
      await pool.connect(distributor).distributeToClaimContract(poolId, claimContract.address);
      await expect(pool.connect(company).withdrawPool(poolId))
        .to.be.revertedWithCustomError(pool, "AlreadyDistributed");
    });
  });

  // ---------------------------------------------------------------------------
  // setAuthorizedDistributor
  // ---------------------------------------------------------------------------

  describe("setAuthorizedDistributor", function () {
    it("updates the distributor and emits DistributorUpdated", async function () {
      await expect(pool.connect(owner).setAuthorizedDistributor(other.address))
        .to.emit(pool, "DistributorUpdated")
        .withArgs(distributor.address, other.address);
      expect(await pool.authorizedDistributor()).to.equal(other.address);
    });

    it("reverts for a non-owner caller", async function () {
      await expect(pool.connect(other).setAuthorizedDistributor(other.address))
        .to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("reverts on a zero-address distributor", async function () {
      await expect(pool.connect(owner).setAuthorizedDistributor(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("the new distributor can distribute, the old one no longer can", async function () {
      const poolId = await createPool();
      await pool.connect(owner).setAuthorizedDistributor(other.address);

      await expect(pool.connect(distributor).distributeToClaimContract(poolId, claimContract.address))
        .to.be.revertedWithCustomError(pool, "NotAuthorizedDistributor");

      await expect(pool.connect(other).distributeToClaimContract(poolId, claimContract.address))
        .to.emit(pool, "PoolDistributed");
    });
  });
});
