// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Test-only. OZ's MerkleProof.verify() is internal — this exposes it
///         externally so ingestor/src/merkle.js's JS-side tree builder can be
///         proven to produce proofs the REAL on-chain library accepts, not
///         just proofs that are self-consistent with its own JS reimplementation
///         of the pairing rule. See test/merkle.test.js.
contract MerkleProofTestHelper {
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) external pure returns (bool) {
        return MerkleProof.verify(proof, root, leaf);
    }
}
