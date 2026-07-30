// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface to the ArcIDBond calls a consumer agent's
///         authorizedSlasher key is trusted to make. Used by
///         ConsumerSessionKeyGuard so it doesn't need ArcIDBond's full ABI.
///         ArcIDBond formally implements this interface (`is IArcIDBondSlash`
///         in ArcIDBond.sol) so the compiler enforces the two signatures
///         never drift apart, rather than relying on them staying in sync
///         by convention.
interface IArcIDBondSlash {
    /// @notice Breach classification (tiered-adjudication, Phase 4 —
    ///         post-submission, see CHANGELOG.md). `Semantic` = Tier 2 (LLM
    ///         judgment, capped and fee-relative); `Hard` = Tier 1
    ///         (deterministic mechanical failure — signature/timestamp/
    ///         schema — capped higher). ArcIDBond computes the slash amount
    ///         from this classification internally; callers never supply
    ///         an amount.
    enum BreachClass { Semantic, Hard }

    function slash(
        address agent,
        address consumer,
        string calldata reason,
        BreachClass breachClass
    ) external;

    function recordSettlement(
        address agent,
        address consumer,
        uint256 amount,
        bytes32 verdictHash
    ) external;
}
