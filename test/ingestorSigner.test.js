/**
 * ingestorSigner.test.js — ingestor/src/signer.js sign/verify round trip.
 * Sets required env vars directly (a throwaway test wallet) rather than
 * relying on any .env file, so this test is deterministic regardless of
 * local ingestor/.env state.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// Freshly generated throwaway key — this test only needs a valid signing
// key, not a funded or well-known one (nothing here sends a transaction).
const throwaway = require("ethers").Wallet.createRandom();
process.env.INGESTOR_PRIVATE_KEY    = throwaway.privateKey;
process.env.INGESTOR_WALLET_ADDRESS = throwaway.address;

const { signAllocation, wallet } = require("../ingestor/src/signer");

describe("ingestor signer (ingestor/src/signer.js)", function () {
  it("signs an allocation and recovers to the ingestor wallet's own address", async function () {
    const poolId = 1n;
    const allocationRoot = ethers.keccak256(ethers.toUtf8Bytes("some-allocation-root"));

    const signature = await signAllocation(poolId, allocationRoot);

    const messageHash = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [poolId, allocationRoot]);
    const recovered = ethers.verifyMessage(ethers.getBytes(messageHash), signature);

    expect(recovered.toLowerCase()).to.equal(wallet.address.toLowerCase());
  });

  it("a signature for one poolId does not verify against a different poolId (no cross-pool replay)", async function () {
    const allocationRoot = ethers.keccak256(ethers.toUtf8Bytes("root-x"));
    const signature = await signAllocation(1n, allocationRoot);

    const wrongHash = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [2n, allocationRoot]);
    const recovered = ethers.verifyMessage(ethers.getBytes(wrongHash), signature);

    expect(recovered.toLowerCase()).to.not.equal(wallet.address.toLowerCase());
  });

  it("a signature for one allocationRoot does not verify against a tampered root", async function () {
    const poolId = 1n;
    const signature = await signAllocation(poolId, ethers.keccak256(ethers.toUtf8Bytes("root-a")));

    const wrongHash = ethers.solidityPackedKeccak256(
      ["uint256", "bytes32"], [poolId, ethers.keccak256(ethers.toUtf8Bytes("root-b"))]
    );
    const recovered = ethers.verifyMessage(ethers.getBytes(wrongHash), signature);

    expect(recovered.toLowerCase()).to.not.equal(wallet.address.toLowerCase());
  });
});
