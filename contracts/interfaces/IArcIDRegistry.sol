// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal read interface to the live ArcIDRegistry.
///         Only the fields ArcIDBond needs: look up whether a signer wallet
///         belongs to a TEE-attested agent.
///
/// @dev The registry records agentId = keccak256(mrtd, reportData, attestedSigner).
///      agentIdBySigner[addr] == bytes32(0)  →  addr is NOT registered / verified.
///      agentIdBySigner[addr] != bytes32(0)  →  addr passed DCAP verification.
interface IArcIDRegistry {
    /// @return agentId bytes32(0) if addr is unregistered; non-zero otherwise.
    function agentIdBySigner(address signer) external view returns (bytes32 agentId);
}
