/**
 * verifier.js — Verify oracle response signatures.
 *
 * Oracle signs: keccak256(abi.encodePacked(string(value), uint256(timestamp)))
 * using EIP-191 personal_sign (signMessage).
 *
 * We recover the signer with ethers.verifyMessage and compare against the
 * known oracle wallet address registered in ArcIDRegistry.
 */

const { ethers } = require("ethers");

/**
 * @param {string|null} value
 * @param {number}      timestamp   Unix seconds
 * @param {string}      oracle      Oracle's registered wallet address
 * @param {string|null} signature   0x-prefixed hex
 * @returns {{ valid: boolean, recovered: string|null, error: string|null }}
 */
function verifyOracleSignature(value, timestamp, oracle, signature) {
  if (!signature) {
    return { valid: false, recovered: null, error: "signature is null" };
  }

  try {
    const messageHash = ethers.solidityPackedKeccak256(
      ["string", "uint256"],
      [String(value ?? ""), BigInt(timestamp)]
    );
    const recovered = ethers.verifyMessage(ethers.getBytes(messageHash), signature);
    const valid = recovered.toLowerCase() === oracle.toLowerCase();
    return {
      valid,
      recovered,
      error: valid ? null : `recovered ${recovered} ≠ oracle ${oracle}`,
    };
  } catch (err) {
    return { valid: false, recovered: null, error: `verify threw: ${err.message}` };
  }
}

module.exports = { verifyOracleSignature };
