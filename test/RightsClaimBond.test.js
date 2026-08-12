/**
 * RightsClaimBond.test.js — Tier 1 rights-claim bonding: self-assert +
 * bond + dispute window, with a genuinely two-sided challenge (unlike
 * ArcIDBond's single-sided indictment pattern).
 *
 * Covers: claim filing (real ArtistRegistry integration, not a mock),
 * the unchallenged-pass path, the challenge-and-resolve path in both
 * directions (claimant wins / challenger wins), bond accounting for
 * each outcome, and admin config.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const TEN_USDC = 10_000_000n;
const CLAIM_HASH = ethers.keccak256(ethers.toUtf8Bytes("I own 100% of this recording's AI-training rights"));
const COUNTER_CLAIM_HASH = ethers.keccak256(ethers.toUtf8Bytes("This is my recording, not theirs"));
const ONE_DAY = 24 * 60 * 60;

describe("RightsClaimBond", function () {
  let bond, usdc, artistRegistry;
  let owner, artist, otherArtist, challenger, stranger;
  let fp; // the one registered fingerprintHash used across most tests

  beforeEach(async function () {
    [owner, artist, otherArtist, challenger, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const ArtistRegistry = await ethers.getContractFactory("ArtistRegistry");
    artistRegistry = await ArtistRegistry.deploy();

    const RightsClaimBond = await ethers.getContractFactory("RightsClaimBond");
    bond = await RightsClaimBond.deploy(await usdc.getAddress(), await artistRegistry.getAddress(), ONE_DAY);

    fp = ethers.keccak256(ethers.toUtf8Bytes("track-1"));
    const rightsHash = ethers.keccak256(ethers.toUtf8Bytes("rights-v1"));
    await artistRegistry.connect(artist).registerTrack(fp, rightsHash);

    await usdc.mint(artist.address, 100_000_000n);
    await usdc.connect(artist).approve(await bond.getAddress(), ethers.MaxUint256);
    await usdc.mint(challenger.address, 100_000_000n);
    await usdc.connect(challenger).approve(await bond.getAddress(), ethers.MaxUint256);
  });

  // ---------------------------------------------------------------------------
  // construction
  // ---------------------------------------------------------------------------

  describe("construction", function () {
    it("sets collateralToken, artistRegistry, owner, disputeWindow", async function () {
      expect(await bond.collateralToken()).to.equal(await usdc.getAddress());
      expect(await bond.artistRegistry()).to.equal(await artistRegistry.getAddress());
      expect(await bond.owner()).to.equal(owner.address);
      expect(await bond.disputeWindow()).to.equal(ONE_DAY);
    });

    it("reverts on a zero-address collateralToken or registry", async function () {
      const Factory = await ethers.getContractFactory("RightsClaimBond");
      await expect(Factory.deploy(ethers.ZeroAddress, await artistRegistry.getAddress(), ONE_DAY))
        .to.be.revertedWithCustomError(Factory, "ZeroAddress");
      await expect(Factory.deploy(await usdc.getAddress(), ethers.ZeroAddress, ONE_DAY))
        .to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });

    it("reverts on a zero dispute window", async function () {
      const Factory = await ethers.getContractFactory("RightsClaimBond");
      await expect(Factory.deploy(await usdc.getAddress(), await artistRegistry.getAddress(), 0))
        .to.be.revertedWithCustomError(Factory, "InvalidDisputeWindow");
    });
  });

  // ---------------------------------------------------------------------------
  // fileClaim
  // ---------------------------------------------------------------------------

  describe("fileClaim", function () {
    it("transfers the bond in, stores the claim, and emits ClaimFiled", async function () {
      const before = await usdc.balanceOf(await bond.getAddress());
      const tx = await bond.connect(artist).fileClaim(fp, CLAIM_HASH, TEN_USDC);
      await expect(tx).to.emit(bond, "ClaimFiled");

      expect(await usdc.balanceOf(await bond.getAddress())).to.equal(before + TEN_USDC);

      const c = await bond.claims(fp);
      expect(c.claimant).to.equal(artist.address);
      expect(c.claimHash).to.equal(CLAIM_HASH);
      expect(c.claimantBond).to.equal(TEN_USDC);
      expect(c.state).to.equal(1n); // Pending
    });

    it("reverts on a zero bond amount", async function () {
      await expect(bond.connect(artist).fileClaim(fp, CLAIM_HASH, 0))
        .to.be.revertedWithCustomError(bond, "ZeroAmount");
    });

    it("reverts if the caller isn't the registered artist of the fingerprint", async function () {
      await expect(bond.connect(otherArtist).fileClaim(fp, CLAIM_HASH, TEN_USDC))
        .to.be.revertedWithCustomError(bond, "NotTrackArtist");
    });

    it("reverts for a fingerprint that was never registered at all", async function () {
      const unregisteredFp = ethers.keccak256(ethers.toUtf8Bytes("never-registered"));
      await expect(bond.connect(artist).fileClaim(unregisteredFp, CLAIM_HASH, TEN_USDC))
        .to.be.revertedWithCustomError(bond, "NotTrackArtist");
    });

    it("reverts a second claim filing for the same fingerprint", async function () {
      await bond.connect(artist).fileClaim(fp, CLAIM_HASH, TEN_USDC);
      await expect(bond.connect(artist).fileClaim(fp, CLAIM_HASH, TEN_USDC))
        .to.be.revertedWithCustomError(bond, "ClaimAlreadyExists");
    });
  });

  // ---------------------------------------------------------------------------
  // challengeClaim
  // ---------------------------------------------------------------------------

  describe("challengeClaim", function () {
    beforeEach(async function () {
      await bond.connect(artist).fileClaim(fp, CLAIM_HASH, TEN_USDC);
    });

    it("transfers the challenger's bond in, updates state, and emits ClaimChallenged", async function () {
      const before = await usdc.balanceOf(await bond.getAddress());
      await expect(bond.connect(challenger).challengeClaim(fp, COUNTER_CLAIM_HASH, TEN_USDC))
        .to.emit(bond, "ClaimChallenged")
        .withArgs(fp, challenger.address, COUNTER_CLAIM_HASH, TEN_USDC);

      expect(await usdc.balanceOf(await bond.getAddress())).to.equal(before + TEN_USDC);

      const c = await bond.claims(fp);
      expect(c.challenger).to.equal(challenger.address);
      expect(c.challengerBond).to.equal(TEN_USDC);
      expect(c.state).to.equal(2n); // Challenged
    });

    it("reverts on a bond amount that doesn't match the claimant's", async function () {
      await expect(bond.connect(challenger).challengeClaim(fp, COUNTER_CLAIM_HASH, TEN_USDC / 2n))
        .to.be.revertedWithCustomError(bond, "BondMismatch");
    });

    it("reverts a second challenge against an already-challenged claim", async function () {
      await bond.connect(challenger).challengeClaim(fp, COUNTER_CLAIM_HASH, TEN_USDC);
      await expect(bond.connect(stranger).challengeClaim(fp, COUNTER_CLAIM_HASH, TEN_USDC))
        .to.be.revertedWithCustomError(bond, "ClaimNotPending");
    });

    it("reverts a challenge filed after the window has closed", async function () {
      await ethers.provider.send("evm_increaseTime", [ONE_DAY + 1]);
      await ethers.provider.send("evm_mine");
      await expect(bond.connect(challenger).challengeClaim(fp, COUNTER_CLAIM_HASH, TEN_USDC))
        .to.be.revertedWithCustomError(bond, "WindowExpired");
    });

    it("reverts a challenge against a fingerprint with no filed claim", async function () {
      const otherFp = ethers.keccak256(ethers.toUtf8Bytes("never-claimed"));
      await expect(bond.connect(challenger).challengeClaim(otherFp, COUNTER_CLAIM_HASH, TEN_USDC))
        .to.be.revertedWithCustomError(bond, "ClaimNotPending");
    });
  });

  // ---------------------------------------------------------------------------
  // finalizeUnchallenged — the "nobody objected" path
  // ---------------------------------------------------------------------------

  describe("finalizeUnchallenged", function () {
    beforeEach(async function () {
      await bond.connect(artist).fileClaim(fp, CLAIM_HASH, TEN_USDC);
    });

    it("reverts before the window closes", async function () {
      await expect(bond.connect(stranger).finalizeUnchallenged(fp))
        .to.be.revertedWithCustomError(bond, "WindowNotExpired");
    });

    it("is permissionless, upholds the claim, and makes the track licensable once the window passes", async function () {
      await ethers.provider.send("evm_increaseTime", [ONE_DAY + 1]);
      await ethers.provider.send("evm_mine");

      await expect(bond.connect(stranger).finalizeUnchallenged(fp))
        .to.emit(bond, "ClaimUpheldUnchallenged")
        .withArgs(fp);

      expect(await bond.isLicensable(fp)).to.equal(true);
      const c = await bond.claims(fp);
      expect(c.state).to.equal(3n); // Upheld
    });

    it("reverts if the claim was actually challenged before the window closed", async function () {
      await bond.connect(challenger).challengeClaim(fp, COUNTER_CLAIM_HASH, TEN_USDC);
      await ethers.provider.send("evm_increaseTime", [ONE_DAY + 1]);
      await ethers.provider.send("evm_mine");
      await expect(bond.connect(stranger).finalizeUnchallenged(fp))
        .to.be.revertedWithCustomError(bond, "ClaimNotPending");
    });
  });

  // ---------------------------------------------------------------------------
  // resolveChallenge — the genuinely two-sided path, both directions
  // ---------------------------------------------------------------------------

  describe("resolveChallenge", function () {
    beforeEach(async function () {
      await bond.connect(artist).fileClaim(fp, CLAIM_HASH, TEN_USDC);
      await bond.connect(challenger).challengeClaim(fp, COUNTER_CLAIM_HASH, TEN_USDC);
    });

    it("claimant wins: challenger's bond moves to the claimant, claim Upheld, track licensable", async function () {
      const claimantBefore = await usdc.balanceOf(artist.address);

      await expect(bond.connect(owner).resolveChallenge(fp, true))
        .to.emit(bond, "ChallengeResolved")
        .withArgs(fp, true, artist.address, challenger.address);

      expect(await usdc.balanceOf(artist.address)).to.equal(claimantBefore + TEN_USDC); // challenger's bond only
      expect(await bond.isLicensable(fp)).to.equal(true);
      const c = await bond.claims(fp);
      expect(c.state).to.equal(3n); // Upheld
    });

    it("challenger wins: BOTH bonds move to the challenger, claim Overturned, track NOT licensable", async function () {
      const challengerBefore = await usdc.balanceOf(challenger.address);

      await expect(bond.connect(owner).resolveChallenge(fp, false))
        .to.emit(bond, "ChallengeResolved")
        .withArgs(fp, false, artist.address, challenger.address);

      expect(await usdc.balanceOf(challenger.address)).to.equal(challengerBefore + TEN_USDC * 2n);
      expect(await bond.isLicensable(fp)).to.equal(false);
      const c = await bond.claims(fp);
      expect(c.state).to.equal(4n); // Overturned
    });

    it("reverts for a non-owner caller", async function () {
      await expect(bond.connect(stranger).resolveChallenge(fp, true))
        .to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });

    it("reverts a second resolution of the same challenge", async function () {
      await bond.connect(owner).resolveChallenge(fp, true);
      await expect(bond.connect(owner).resolveChallenge(fp, true))
        .to.be.revertedWithCustomError(bond, "ClaimNotChallenged");
    });

    it("reverts resolveChallenge on a claim that was never challenged (still Pending)", async function () {
      const fp2 = ethers.keccak256(ethers.toUtf8Bytes("track-2"));
      await artistRegistry.connect(artist).registerTrack(fp2, ethers.keccak256(ethers.toUtf8Bytes("rights-v1-b")));
      await bond.connect(artist).fileClaim(fp2, CLAIM_HASH, TEN_USDC);
      await expect(bond.connect(owner).resolveChallenge(fp2, true))
        .to.be.revertedWithCustomError(bond, "ClaimNotChallenged");
    });
  });

  // ---------------------------------------------------------------------------
  // isLicensable
  // ---------------------------------------------------------------------------

  describe("isLicensable", function () {
    it("false for a fingerprint with no claim at all", async function () {
      expect(await bond.isLicensable(fp)).to.equal(false);
    });

    it("false while a claim is Pending or Challenged", async function () {
      await bond.connect(artist).fileClaim(fp, CLAIM_HASH, TEN_USDC);
      expect(await bond.isLicensable(fp)).to.equal(false);
      await bond.connect(challenger).challengeClaim(fp, COUNTER_CLAIM_HASH, TEN_USDC);
      expect(await bond.isLicensable(fp)).to.equal(false);
    });
  });

  // ---------------------------------------------------------------------------
  // admin
  // ---------------------------------------------------------------------------

  describe("setDisputeWindow", function () {
    it("updates the window and emits DisputeWindowUpdated", async function () {
      await expect(bond.connect(owner).setDisputeWindow(3600))
        .to.emit(bond, "DisputeWindowUpdated")
        .withArgs(3600);
      expect(await bond.disputeWindow()).to.equal(3600);
    });

    it("reverts for a non-owner caller", async function () {
      await expect(bond.connect(stranger).setDisputeWindow(3600))
        .to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });

    it("reverts on a zero window", async function () {
      await expect(bond.connect(owner).setDisputeWindow(0))
        .to.be.revertedWithCustomError(bond, "InvalidDisputeWindow");
    });
  });
});
