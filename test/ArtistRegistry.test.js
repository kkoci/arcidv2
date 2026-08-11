/**
 * ArtistRegistry.test.js — Licensed AI Training Compensation Rail, artist
 * registration layer.
 *
 * Covers: successful registration + event + storage, zero-fingerprint
 * rejection, duplicate-fingerprint rejection (including by the original
 * registrant), one artist owning multiple distinct fingerprints, and the
 * two view helpers.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const FP_1 = ethers.keccak256(ethers.toUtf8Bytes("track-1-fingerprint"));
const FP_2 = ethers.keccak256(ethers.toUtf8Bytes("track-2-fingerprint"));
const RIGHTS_HASH = ethers.keccak256(ethers.toUtf8Bytes("rights-metadata-v1"));
const OTHER_RIGHTS_HASH = ethers.keccak256(ethers.toUtf8Bytes("rights-metadata-v2"));

describe("ArtistRegistry", function () {
  let registry;
  let artist, otherArtist;

  beforeEach(async function () {
    [, artist, otherArtist] = await ethers.getSigners();
    const ArtistRegistry = await ethers.getContractFactory("ArtistRegistry");
    registry = await ArtistRegistry.deploy();
  });

  describe("registerTrack", function () {
    it("registers a track, stores the artist + rights hash, and emits TrackRegistered", async function () {
      await expect(registry.connect(artist).registerTrack(FP_1, RIGHTS_HASH))
        .to.emit(registry, "TrackRegistered")
        .withArgs(FP_1, artist.address, RIGHTS_HASH);

      const track = await registry.tracks(FP_1);
      expect(track.artist).to.equal(artist.address);
      expect(track.rightsMetadataHash).to.equal(RIGHTS_HASH);
    });

    it("reverts on a zero fingerprint", async function () {
      await expect(registry.connect(artist).registerTrack(ethers.ZeroHash, RIGHTS_HASH))
        .to.be.revertedWithCustomError(registry, "ZeroFingerprint");
    });

    it("reverts on a duplicate fingerprint from a different artist", async function () {
      await registry.connect(artist).registerTrack(FP_1, RIGHTS_HASH);
      await expect(registry.connect(otherArtist).registerTrack(FP_1, OTHER_RIGHTS_HASH))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("reverts on a duplicate fingerprint from the same artist (no silent re-register)", async function () {
      await registry.connect(artist).registerTrack(FP_1, RIGHTS_HASH);
      await expect(registry.connect(artist).registerTrack(FP_1, RIGHTS_HASH))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("allows one artist to register multiple distinct fingerprints", async function () {
      await registry.connect(artist).registerTrack(FP_1, RIGHTS_HASH);
      await registry.connect(artist).registerTrack(FP_2, OTHER_RIGHTS_HASH);

      expect(await registry.artistOf(FP_1)).to.equal(artist.address);
      expect(await registry.artistOf(FP_2)).to.equal(artist.address);
    });
  });

  describe("views", function () {
    it("isRegistered / artistOf reflect unregistered vs. registered state", async function () {
      expect(await registry.isRegistered(FP_1)).to.equal(false);
      expect(await registry.artistOf(FP_1)).to.equal(ethers.ZeroAddress);

      await registry.connect(artist).registerTrack(FP_1, RIGHTS_HASH);

      expect(await registry.isRegistered(FP_1)).to.equal(true);
      expect(await registry.artistOf(FP_1)).to.equal(artist.address);
    });
  });
});
