// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface to the two ArcIDBond calls a consumer agent's
///         authorizedSlasher key is trusted to make. Used by
///         ConsumerSessionKeyGuard so it doesn't need ArcIDBond's full ABI.
interface IArcIDBondSlash {
    function slash(address agent, address consumer, string calldata reason) external;

    function recordSettlement(
        address agent,
        address consumer,
        uint256 amount,
        bytes32 verdictHash
    ) external;
}
