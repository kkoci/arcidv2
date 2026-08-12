/**
 * signer.js — signs the ingestion enclave's computed allocationRoot with
 * its TEE-registered wallet. Same EIP-191 personal_sign pattern as
 * oracle/src/signer.js, so verification works identically in JS
 * (ethers.verifyMessage) and in Solidity (ECDSA.recover after prefixing).
 *
 * Message format binds the allocation to a specific pool, so a signed
 * allocationRoot can never be replayed against a different pool:
 *   keccak256(abi.encodePacked(uint256(poolId), bytes32(allocationRoot)))
 */

const { ethers } = require("ethers");
const config     = require("./config");

const wallet = new ethers.Wallet(config.INGESTOR_PRIVATE_KEY);

/**
 * @param {bigint|number} poolId
 * @param {string} allocationRoot 0x-prefixed bytes32
 * @returns {Promise<string>} 65-byte hex signature (0x-prefixed)
 */
async function signAllocation(poolId, allocationRoot) {
  const messageHash = ethers.solidityPackedKeccak256(
    ["uint256", "bytes32"],
    [BigInt(poolId), allocationRoot]
  );
  return wallet.signMessage(ethers.getBytes(messageHash));
}

module.exports = { signAllocation, wallet };
