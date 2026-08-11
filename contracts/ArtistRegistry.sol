// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArtistRegistry
/// @notice Licensed AI Training Compensation Rail — artist-facing registry.
///         An artist registers a track by its fingerprint hash (precomputed
///         off-chain — real audio fingerprinting is out of scope for this
///         vertical, see CHANGELOG.md) plus a rights-metadata hash (a
///         placeholder commitment, not encoded legal terms). No TEE-gating
///         here: the trust claim this vertical makes is about the
///         INGESTION ENCLAVE's identity (see CompensationClaim.sol), not
///         the artist's — there's no reason a musician registering their
///         own track needs to prove anything beyond owning the wallet that
///         calls this function. Same permissionless-registration shape as
///         ExploitBounty.registerTarget().
///
/// @dev Deliberately minimal — a fingerprintHash -> owner mapping and
///      nothing else. No funds move here, so no ReentrancyGuard; no
///      owner-gated admin function exists, so no Ownable. Downstream, the
///      ingestion enclave (CompensationClaim's authorizedIngestor) checks
///      each track in a committed training corpus against this registry
///      to confirm it's licensed before including it in a payout
///      allocation.
contract ArtistRegistry {
    // -------------------------------------------------------------------------
    // storage
    // -------------------------------------------------------------------------

    struct Track {
        address artist;             // registered owner — receives compensation
        bytes32 rightsMetadataHash; // placeholder commitment, not encoded terms
    }

    /// @notice fingerprintHash -> registered track. artist == address(0) means unregistered.
    mapping(bytes32 => Track) public tracks;

    // -------------------------------------------------------------------------
    // events
    // -------------------------------------------------------------------------

    event TrackRegistered(bytes32 indexed fingerprintHash, address indexed artist, bytes32 rightsMetadataHash);

    // -------------------------------------------------------------------------
    // errors
    // -------------------------------------------------------------------------

    error ZeroFingerprint();
    error AlreadyRegistered();

    // -------------------------------------------------------------------------
    // registration
    // -------------------------------------------------------------------------

    /// @notice Register a track. Anyone can call this for any fingerprint
    ///         they claim to own — same trust model as ExploitBounty's
    ///         registerTarget(): permissionless, first-registration-wins.
    ///         Real-world rights-dispute handling (someone registering a
    ///         fingerprint they don't actually own) is out of scope for
    ///         this demo-scope vertical, same as it would be for any
    ///         first-come registry without an off-chain verification step.
    function registerTrack(bytes32 fingerprintHash, bytes32 rightsMetadataHash) external {
        if (fingerprintHash == bytes32(0)) revert ZeroFingerprint();
        if (tracks[fingerprintHash].artist != address(0)) revert AlreadyRegistered();

        tracks[fingerprintHash] = Track({ artist: msg.sender, rightsMetadataHash: rightsMetadataHash });

        emit TrackRegistered(fingerprintHash, msg.sender, rightsMetadataHash);
    }

    // -------------------------------------------------------------------------
    // views
    // -------------------------------------------------------------------------

    function isRegistered(bytes32 fingerprintHash) external view returns (bool) {
        return tracks[fingerprintHash].artist != address(0);
    }

    function artistOf(bytes32 fingerprintHash) external view returns (address) {
        return tracks[fingerprintHash].artist;
    }
}
