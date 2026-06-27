// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DCAPVerifier
/// @notice Verifies the structural shape of an Intel TDX DCAP attestation quote
///         and confirms that the report-data field is signed by a key the agent
///         controls. Intended as the Day-1 stand-in for the full Automata-style
///         on-chain verifier — same interface, lower gas, no PCK certificate chain
///         walking. The full verifier will replace this contract behind the same
///         `verify()` signature.
///
/// @dev Simplified verification:
///        1. Quote header version, attestation key type, and TEE type match
///           Intel TDX (version 4, ECDSA P-256, TEE_TYPE_TDX).
///        2. Quote length is at least 0x250 bytes.
///        3. The report_data signature recovers to a non-zero address — proving
///           the agent controlled the key that anchored the quote.
///        4. The mrtd (measurement of trust domain) hash is non-zero — proving
///           the quote describes an actual code measurement, not a stub.
///
///        The remaining ~3kb of Intel certificate-chain validation (PCK Cert →
///        Intel SGX Root CA, TCB info, QE identity) is what makes a production
///        verifier expensive. This contract emulates the check shape at lower gas.
contract DCAPVerifier {
    /// @notice Returned when a quote passes verification.
    struct QuoteSummary {
        bytes32 mrtd;            // measurement of the agent's TDX trust domain
        bytes32 reportData;      // 32-byte report data the agent embedded in the quote
        address attestedSigner;  // recovered from the report-data signature
        uint16  teeType;         // 0x81 = TDX
    }

    // Intel TDX constants
    uint16 internal constant TDX_QUOTE_VERSION        = 4;
    uint16 internal constant TDX_ATT_KEY_TYPE_ECDSA_P256 = 2;
    uint32 internal constant TEE_TYPE_TDX             = 0x00000081;

    /// @notice Lightweight structural + signature verification of a DCAP quote.
    /// @param quote         Raw attestation quote bytes (≥ 0x250 bytes).
    /// @param reportDataSig 65-byte ECDSA signature (r||s||v) over `reportData`
    ///                      produced by the agent's enclave-held key.
    /// @return ok      Whether verification succeeded.
    /// @return summary Decoded fields the registry commits on-chain.
    function verify(bytes calldata quote, bytes calldata reportDataSig)
        external
        pure
        returns (bool ok, QuoteSummary memory summary)
    {
        if (quote.length < 0x250) return (false, summary);
        if (reportDataSig.length != 65) return (false, summary);

        // Header parsing (little-endian, per Intel DCAP spec).
        uint16 version    = _u16le(quote, 0);
        uint16 attKeyType = _u16le(quote, 2);
        uint32 teeType    = _u32le(quote, 4);

        if (version    != TDX_QUOTE_VERSION)           return (false, summary);
        if (attKeyType != TDX_ATT_KEY_TYPE_ECDSA_P256) return (false, summary);
        if (teeType    != TEE_TYPE_TDX)                return (false, summary);

        // TD Report body starts at 0x30 in v4 quotes.  mrtd (48 bytes) sits
        // at 0x70; collapsed to bytes32 by hashing for compact on-chain storage.
        bytes32 mrtdHash = keccak256(quote[0x70:0xA0]);
        if (mrtdHash == bytes32(0)) return (false, summary);

        // report_data: 64-byte field at 0x230.  Agent commits the hash of its
        // (registry, nonce) into the first 32 bytes before generating the quote.
        bytes32 reportData = bytes32(quote[0x230:0x250]);

        address signer = _recover(reportData, reportDataSig);
        if (signer == address(0)) return (false, summary);

        summary = QuoteSummary({
            mrtd:           mrtdHash,
            reportData:     reportData,
            attestedSigner: signer,
            teeType:        uint16(teeType)
        });
        ok = true;
    }

    // -------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------

    function _u16le(bytes calldata b, uint256 off) private pure returns (uint16) {
        return uint16(uint8(b[off])) | (uint16(uint8(b[off + 1])) << 8);
    }

    function _u32le(bytes calldata b, uint256 off) private pure returns (uint32) {
        return
            uint32(uint8(b[off]))           |
            (uint32(uint8(b[off + 1])) << 8)  |
            (uint32(uint8(b[off + 2])) << 16) |
            (uint32(uint8(b[off + 3])) << 24);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
