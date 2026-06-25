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

module.exports = { signResponse, wallet };
