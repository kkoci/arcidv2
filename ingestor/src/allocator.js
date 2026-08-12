"use strict";
/**
 * allocator.js — the actual ingestion + compensation-allocation logic.
 * This is the enclave's real workload: given a demo training corpus, prove
 * it matches what was committed on-chain, confirm every track is licensed,
 * split the pool equally per track, aggregate per artist, and build the
 * second Merkle tree the artists will later claim against.
 *
 * Up to three independent checks, deliberately not conflated:
 *   1. INTEGRITY — the corpus actually matches TrainingPool's committed
 *      corpusRoot. Without this, the enclave could be fed any corpus at
 *      claim time regardless of what was committed before training.
 *   2. LICENSING — every track in the corpus resolves to a registered
 *      artist in ArtistRegistry. Without this, an AI company could commit
 *      a root over unlicensed tracks and still trigger a payout.
 *   3. RIGHTS-CLAIM STANDING (optional, post-submission — see
 *      CHANGELOG.md's Rights-Claim Bonding entry) — if a `checkLicensable`
 *      callback is provided, every track must also have an Upheld bonded
 *      rights claim on RightsClaimBond, not just a bare ArtistRegistry
 *      entry. Deliberately optional and backward-compatible: callers that
 *      don't pass this (e.g. the AcquisitionAgent catalog, whose demo
 *      tracks were never claim-bonded) keep working exactly as before —
 *      this is an additive trust tier, not a retroactive requirement.
 */

const { ethers } = require("ethers");
const { hashLeaf, buildTree, getProof } = require("./merkle");

function corpusLeaf(fingerprintHash) {
  return hashLeaf(["bytes32"], [fingerprintHash]);
}

function allocationLeaf(artist, amount) {
  return hashLeaf(["address", "uint256"], [artist, amount]);
}

class CorpusMismatchError extends Error {
  constructor(recomputed, committed) {
    super(`CorpusMismatch: recomputed root ${recomputed} != committed root ${committed}`);
    this.name = "CorpusMismatchError";
    this.recomputed = recomputed;
    this.committed = committed;
  }
}

class UnlicensedTrackError extends Error {
  constructor(fingerprintHash) {
    super(`UnlicensedTrack: fingerprint ${fingerprintHash} is not registered in ArtistRegistry`);
    this.name = "UnlicensedTrackError";
    this.fingerprintHash = fingerprintHash;
  }
}

class UnbondedRightsClaimError extends Error {
  constructor(fingerprintHash) {
    super(`UnbondedRightsClaim: fingerprint ${fingerprintHash} has no Upheld bonded rights claim on RightsClaimBond`);
    this.name = "UnbondedRightsClaimError";
    this.fingerprintHash = fingerprintHash;
  }
}

/**
 * @param {object} params
 * @param {string[]} params.corpus fingerprintHash[] (bytes32 hex) the company claims to train on
 * @param {string} params.committedCorpusRoot TrainingPool.pools(poolId).corpusRoot, on-chain
 * @param {bigint} params.poolAmount TrainingPool.pools(poolId).amount, on-chain (atomic units)
 * @param {(fingerprintHash: string) => Promise<string>} params.resolveArtist
 *        ArtistRegistry.artistOf(fingerprintHash) — returns ethers.ZeroAddress if unregistered
 * @param {(fingerprintHash: string) => Promise<boolean>} [params.checkLicensable]
 *        RightsClaimBond.isLicensable(fingerprintHash) — optional; omit entirely to skip
 *        this check (see the module-level doc comment on why that's the safe default)
 * @returns {Promise<{
 *   allocationRoot: string,
 *   corpusRoot: string,
 *   allocations: {artist: string, amount: bigint, leaf: string, proof: string[]}[]
 * }>}
 */
async function ingest({ corpus, committedCorpusRoot, poolAmount, resolveArtist, checkLicensable }) {
  if (!corpus || corpus.length === 0) throw new Error("ingest: empty corpus");
  if (poolAmount <= 0n) throw new Error("ingest: poolAmount must be > 0");

  // 1. Integrity check.
  const corpusLeaves = corpus.map(corpusLeaf);
  const { root: recomputedCorpusRoot } = buildTree(corpusLeaves);
  if (recomputedCorpusRoot.toLowerCase() !== committedCorpusRoot.toLowerCase()) {
    throw new CorpusMismatchError(recomputedCorpusRoot, committedCorpusRoot);
  }

  // 2. Licensing check — resolve every track before allocating anything.
  const artistPerTrack = [];
  for (const fp of corpus) {
    const artist = await resolveArtist(fp);
    if (artist === ethers.ZeroAddress) throw new UnlicensedTrackError(fp);
    artistPerTrack.push(artist);
  }

  // 2b. Rights-claim standing — only when the caller opted in (see doc comment above).
  if (checkLicensable) {
    for (const fp of corpus) {
      const licensable = await checkLicensable(fp);
      if (!licensable) throw new UnbondedRightsClaimError(fp);
    }
  }

  // 3. Equal-split per track. Integer division leaves a remainder smaller
  //    than the track count — handed to the first `remainder` tracks in
  //    corpus order so the full poolAmount is always accounted for exactly,
  //    never leaving dust unallocated.
  const n = BigInt(corpus.length);
  const base = poolAmount / n;
  const remainder = poolAmount % n;
  const perTrackAmount = corpus.map((_, i) => base + (BigInt(i) < remainder ? 1n : 0n));

  // 4. Aggregate per artist — one with multiple tracks in the corpus gets
  //    the sum of their per-track shares, not multiple separate leaves.
  const totals = new Map();
  const order = []; // first-seen order, for deterministic leaf/tree ordering
  for (let i = 0; i < corpus.length; i++) {
    const artist = artistPerTrack[i];
    if (!totals.has(artist)) { totals.set(artist, 0n); order.push(artist); }
    totals.set(artist, totals.get(artist) + perTrackAmount[i]);
  }

  const artists = order;
  const amounts = artists.map((a) => totals.get(a));
  const leaves  = artists.map((a, i) => allocationLeaf(a, amounts[i]));
  const tree    = buildTree(leaves);

  const totalAllocated = amounts.reduce((s, a) => s + a, 0n);
  if (totalAllocated !== poolAmount) {
    // Should be unreachable given the remainder handling above — a hard
    // internal-consistency check, not a user-facing validation.
    throw new Error(`ingest: internal accounting error, allocated ${totalAllocated} != pool ${poolAmount}`);
  }

  const allocations = artists.map((artist, i) => ({
    artist,
    amount: amounts[i],
    leaf: leaves[i],
    proof: getProof(tree, i),
  }));

  return { allocationRoot: tree.root, corpusRoot: recomputedCorpusRoot, allocations };
}

module.exports = { ingest, corpusLeaf, allocationLeaf, CorpusMismatchError, UnlicensedTrackError, UnbondedRightsClaimError };
