"use strict";
/**
 * merkle.js — OpenZeppelin-compatible Merkle tree builder + proof generator.
 *
 * Matches @openzeppelin/contracts/utils/cryptography/MerkleProof.sol exactly:
 *   - pairs combined via sorted-pair keccak256(bytes.concat(a,b)) (a<b as uint256,
 *     same comparison Solidity's `<` performs on bytes32)
 *   - an unpaired node at an odd-length level is promoted unchanged to the
 *     next level (no self-pairing / no duplication)
 *   - leaves are double-hashed — keccak256(keccak256(abi.encode(...))) —
 *     before entering the tree, the standard second-preimage-resistant
 *     convention OpenZeppelin's own @openzeppelin/merkle-tree library uses,
 *     so a leaf can never be replayed as a forged internal node
 *
 * Hand-rolled rather than pulling in @openzeppelin/merkle-tree as a new
 * dependency, specifically so it can be verified byte-for-byte against the
 * actual on-chain MerkleProof.sol already vendored in this repo
 * (@openzeppelin/contracts) — see test/merkle.test.js, which proves every
 * proof this module generates is accepted by the real on-chain verifier,
 * not just self-consistent with this file's own logic.
 */

const { ethers } = require("ethers");

function hashLeaf(types, values) {
  const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(types, values));
  return ethers.keccak256(inner);
}

function hashPair(a, b) {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

/**
 * @param {string[]} leaves 0x-prefixed bytes32 leaf hashes (already run through hashLeaf)
 * @returns {{root: string, layers: string[][]}}
 */
function buildTree(leaves) {
  if (leaves.length === 0) throw new Error("buildTree: empty leaf set");
  let layer = [...leaves];
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) next.push(hashPair(layer[i], layer[i + 1]));
      else next.push(layer[i]); // odd one out promoted unchanged, not duplicated
    }
    layer = next;
    layers.push(layer);
  }
  return { root: layer[0], layers };
}

/**
 * @param {{layers:string[][]}} tree
 * @param {number} leafIndex index into the original leaf array (tree.layers[0])
 * @returns {string[]} sibling hashes from leaf to root, in order
 */
function getProof(tree, leafIndex) {
  const proof = [];
  let index = leafIndex;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;
    if (siblingIndex < layer.length) proof.push(layer[siblingIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

/** JS-side mirror of MerkleProof.processProof + root comparison — for local sanity checks only; the real proof is test/merkle.test.js's on-chain assertion. */
function verifyProof(root, leaf, proof) {
  let computed = leaf;
  for (const p of proof) computed = hashPair(computed, p);
  return computed.toLowerCase() === root.toLowerCase();
}

module.exports = { hashLeaf, hashPair, buildTree, getProof, verifyProof };
