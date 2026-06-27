// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArcIDRegistry} from "./interfaces/IArcIDRegistry.sol";

/// @notice Minimal read-only interface for the on-chain DCAP verifier.
interface IDCAPVerifier {
    struct QuoteSummary {
        bytes32 mrtd;            // hashed TDX trust-domain measurement
        bytes32 reportData;      // 32-byte commitment the enclave embedded
        address attestedSigner;  // recovered from the report-data signature
        uint16  teeType;         // 0x81 = TDX
    }

    function verify(bytes calldata quote, bytes calldata reportDataSig)
        external
        pure
        returns (bool ok, QuoteSummary memory summary);
}

/// @title ArcIDRegistryV2
/// @notice Native TEE-agent registry for ArcID v2.
///
///         An agent registers by submitting a real Intel TDX DCAP attestation
///         quote together with a 65-byte signature over the quote's report_data
///         field. Both are verified on-chain by the deployed DCAPVerifier
///         contract. Registration reverts unless:
///           1. The quote is structurally valid (correct v4 TDX header, ≥ 0x250 bytes).
///           2. The mrtd (enclave measurement) is non-zero.
///           3. The report_data signature recovers to `msg.sender`.
///
///         On success the registry writes a deterministic `agentId`:
///           keccak256(abi.encode(mrtd, reportData, attestedSigner))
///
///         This mapping is what ArcIDBond.sol reads via the `IArcIDRegistry`
///         interface: `agentIdBySigner[wallet] != bytes32(0)` → TEE-verified.
///
/// @dev agentId derivation is identical to the original ArcIDRegistry so that
///      the same bond contract and downstream tooling work unchanged with either
///      registry. Agents may re-register with the same quote (idempotent — same
///      inputs produce the same agentId).
contract ArcIDRegistryV2 is IArcIDRegistry {

    IDCAPVerifier public immutable dcapVerifier;

    /// @inheritdoc IArcIDRegistry
    mapping(address => bytes32) public agentIdBySigner;

    event AgentRegistered(
        bytes32 indexed agentId,
        address indexed attestedSigner,
        bytes32         mrtd,
        bytes32         reportData
    );

    constructor(address _dcapVerifier) {
        dcapVerifier = IDCAPVerifier(_dcapVerifier);
    }

    /// @notice Register the caller as a TEE-verified agent.
    ///
    /// @param dcapQuote     Raw TDX DCAP attestation quote (≥ 0x250 bytes).
    ///                      The report_data field (bytes 0x230–0x250) must equal
    ///                      keccak256(abi.encodePacked(caller, nonce)) so the
    ///                      registration is caller-specific and non-replayable.
    /// @param reportDataSig 65-byte ECDSA signature (r||s||v) over the 32-byte
    ///                      report_data field, produced by the agent's private key.
    ///                      `ecrecover(reportData, sig)` must return `msg.sender`.
    function registerAgent(
        bytes calldata dcapQuote,
        bytes calldata reportDataSig
    ) external {
        (bool ok, IDCAPVerifier.QuoteSummary memory s) =
            dcapVerifier.verify(dcapQuote, reportDataSig);

        require(ok, "DCAP attestation failed");
        require(s.attestedSigner == msg.sender, "Quote signer must match caller");

        bytes32 id = keccak256(abi.encode(s.mrtd, s.reportData, s.attestedSigner));
        agentIdBySigner[msg.sender] = id;

        emit AgentRegistered(id, s.attestedSigner, s.mrtd, s.reportData);
    }
}
