/**
 * signer.js — Signs oracle responses with the provider's registered wallet.
 *
 * Message format (ABI-compatible with Solidity):
 *   keccak256(abi.encodePacked(string(value), uint256(timestamp)))
 *
 * Consumer agent verifies with:
 *   const hash = ethers.solidityPackedKeccak256(["string","uint256"], [value, timestamp])
 *   const recovered = ethers.verifyMessage(ethers.getBytes(hash), signature)
 *   valid = recovered.toLowerCase() === oracle.toLowerCase()
 *
 * Using EIP-191 personal_sign prefix (signMessage) so verification works both
 * in JS (ethers.verifyMessage) and in Solidity (ECDSA.recover after prefixing).
 */

const { ethers } = require("ethers");
const config     = require("./config");

const wallet = new ethers.Wallet(config.ORACLE_PRIVATE_KEY);

/**
 * @param {string|null} value   The oracle value as a string (or null for fault mode).
 * @param {number}      timestamp  Unix seconds.
 * @returns {Promise<string>} 65-byte hex signature (0x-prefixed).
 */
async function signResponse(value, timestamp) {
  const messageHash = ethers.solidityPackedKeccak256(
    ["string", "uint256"],
    [String(value ?? ""), BigInt(timestamp)]
  );
  return wallet.signMessage(ethers.getBytes(messageHash));
}

/**
 * Phase 8.3 (post-submission — see CHANGELOG.md): signs the richer "premium
 * oracle analysis" payload sold through the ERC-8183 job flow (a genuinely
 * separate, higher-priced service tier — NOT the same $0.001 price feed
 * signed above). Message hash doubles as the ERC-8183 `deliverable` bytes32
 * submitted on-chain via submit() — the evaluator independently recomputes
 * this same hash from the fetched payload and compares against the
 * JobSubmitted event, the same "hash the evidence, verify no tampering"
 * pattern this project uses everywhere else (verdictHash, rationaleHash).
 *
 * @param {{value:string, timestamp:number, trend:string, sma:string, volatilityBps:number}} p
 * @returns {Promise<{signature:string, deliverableHash:string}>}
 */
async function signPremiumAnalysis(p) {
  const deliverableHash = ethers.solidityPackedKeccak256(
    ["string", "uint256", "string", "string", "uint256"],
    [String(p.value), BigInt(p.timestamp), p.trend, String(p.sma), BigInt(p.volatilityBps)]
  );
  const signature = await wallet.signMessage(ethers.getBytes(deliverableHash));
  return { signature, deliverableHash };
}

module.exports = { signResponse, signPremiumAnalysis, wallet };
