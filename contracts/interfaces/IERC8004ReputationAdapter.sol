// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface ArcIDBond calls into for the ERC-8004 reputation
///         dual-write (Phase 8.2, post-submission — see CHANGELOG.md).
///         ArcIDBond only ever calls these two functions, always wrapped in
///         try/catch at the call site — this interface's implementer
///         (ERC8004ReputationAdapter) is trusted to never need ArcIDBond to
///         retry or handle partial failure. See the "Critical Invariants"
///         section of CLAUDE.md: this dual-write must never be able to block
///         a slash or settlement.
interface IERC8004ReputationAdapter {
    /// @param agent           The bonded agent being reported on.
    /// @param amountSlashed   Amount actually transferred by this slash.
    /// @param bondBeforeSlash Remaining bond balance immediately before this
    ///                        slash — used to derive a percentage-of-bond
    ///                        severity score, not an arbitrary separate scale.
    /// @param isHard          true for BreachClass.Hard, false for Semantic —
    ///                        a primitive bool rather than importing
    ///                        IArcIDBondSlash's enum, so this interface stays
    ///                        decoupled from ArcIDBond's own type.
    /// @param evidenceHash    keccak256 of the on-chain reason string (direct
    ///                        slash()) or the dispute's stored rationaleHash
    ///                        (resolved/finalized dispute) — whichever
    ///                        evidentiary hash this specific call path
    ///                        actually has, never invented.
    function reportSlash(
        address agent,
        uint256 amountSlashed,
        uint256 bondBeforeSlash,
        bool isHard,
        bytes32 evidenceHash
    ) external;

    /// @param agent       The bonded agent whose clean verdict is being reported.
    /// @param verdictHash Same bytes32 already passed to recordSettlement() —
    ///                    reused directly, not re-derived.
    function reportSettlement(address agent, bytes32 verdictHash) external;
}
