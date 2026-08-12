/**
 * merkle.test.js — ingestor/src/merkle.js correctness, verified against the
 * REAL on-chain OpenZeppelin MerkleProof.sol (via MerkleProofTestHelper),
 * not just self-consistency with this module's own JS logic. This is the
 * proof that off-chain-generated allocation proofs will actually be
 * accepted by CompensationClaim.sol's on-chain verification.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");
const { hashLeaf, buildTree, getProof, verifyProof } = require("../ingestor/src/merkle");

describe("merkle (ingestor/src/merkle.js)", function () {
  let helper;

  before(async function () {
    const Helper = await ethers.getContractFactory("MerkleProofTestHelper");
    helper = await Helper.deploy();
  });

  function artistLeaves(pairs) {
    return pairs.map(([artist, amount]) => hashLeaf(["address", "uint256"], [artist, amount]));
  }

  it("every leaf's proof verifies on-chain against the real OZ MerkleProof.verify() — even-count tree", async function () {
    const signers = await ethers.getSigners();
    const pairs = [
      [signers[1].address, 100n],
      [signers[2].address, 200n],
      [signers[3].address, 300n],
      [signers[4].address, 400n],
    ];
    const leaves = artistLeaves(pairs);
    const tree = buildTree(leaves);

    for (let i = 0; i < leaves.length; i++) {
      const proof = getProof(tree, i);
      expect(verifyProof(tree.root, leaves[i], proof), `JS verify failed for leaf ${i}`).to.equal(true);
      expect(await helper.verify(proof, tree.root, leaves[i]), `on-chain verify failed for leaf ${i}`).to.equal(true);
    }
  });

  it("every leaf's proof verifies on-chain — odd-count tree (unpaired-node promotion path)", async function () {
    const signers = await ethers.getSigners();
    const pairs = [
      [signers[1].address, 111n],
      [signers[2].address, 222n],
      [signers[3].address, 333n],
    ];
    const leaves = artistLeaves(pairs);
    const tree = buildTree(leaves);

    for (let i = 0; i < leaves.length; i++) {
      const proof = getProof(tree, i);
      expect(await helper.verify(proof, tree.root, leaves[i])).to.equal(true);
    }
  });

  it("single-leaf tree: root equals the leaf itself, empty proof verifies", async function () {
    const signers = await ethers.getSigners();
    const leaves = artistLeaves([[signers[1].address, 999n]]);
    const tree = buildTree(leaves);
    expect(tree.root).to.equal(leaves[0]);
    expect(await helper.verify([], tree.root, leaves[0])).to.equal(true);
  });

  it("rejects a proof against a leaf that isn't in the tree", async function () {
    const signers = await ethers.getSigners();
    const leaves = artistLeaves([
      [signers[1].address, 1n],
      [signers[2].address, 2n],
    ]);
    const tree = buildTree(leaves);
    const forgedLeaf = hashLeaf(["address", "uint256"], [signers[9].address, 9999n]);
    const proof = getProof(tree, 0);
    expect(verifyProof(tree.root, forgedLeaf, proof)).to.equal(false);
    expect(await helper.verify(proof, tree.root, forgedLeaf)).to.equal(false);
  });

  it("rejects a tampered amount even with a structurally valid-looking proof", async function () {
    const signers = await ethers.getSigners();
    const leaves = artistLeaves([
      [signers[1].address, 100n],
      [signers[2].address, 200n],
    ]);
    const tree = buildTree(leaves);
    const tamperedLeaf = hashLeaf(["address", "uint256"], [signers[1].address, 100000n]); // inflated amount
    const proof = getProof(tree, 0);
    expect(await helper.verify(proof, tree.root, tamperedLeaf)).to.equal(false);
  });

  it("hashLeaf double-hashes (prevents an internal node from being replayed as a leaf)", function () {
    const single = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [ethers.ZeroAddress, 0n])
    );
    const leaf = hashLeaf(["address", "uint256"], [ethers.ZeroAddress, 0n]);
    expect(leaf).to.not.equal(single);
    expect(leaf).to.equal(ethers.keccak256(single));
  });
});
