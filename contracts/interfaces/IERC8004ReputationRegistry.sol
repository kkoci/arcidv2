// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface to Arc's real, already-deployed ERC-8004
///         ReputationRegistry (Phase 8.1 research, post-submission — see
///         CHANGELOG.md). arcid2 does NOT deploy this contract — it's Arc's
///         own standard infrastructure, read/written via this interface only.
///         Signature taken directly from eips.ethereum.org/EIPS/eip-8004,
///         confirmed against the real deployed bytecode's `name()` call
///         (see CHANGELOG.md's Phase 8.1 entry) rather than assumed.
interface IERC8004ReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
