// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004ReputationAdapter} from "../interfaces/IERC8004ReputationAdapter.sol";

/// @notice Test-only adapter that always reverts. Used to prove ArcIDBond's
///         own try/catch around the call INTO the adapter (not just the
///         adapter's internal try/catch around the registry call) actually
///         holds — a slash/settlement must succeed even if the adapter
///         contract itself is broken, not just if the external registry is.
contract MockBadReputationAdapter is IERC8004ReputationAdapter {
    function reportSlash(address, uint256, uint256, bool, bytes32) external pure override {
        revert("MockBadReputationAdapter: always reverts");
    }

    function reportSettlement(address, bytes32) external pure override {
        revert("MockBadReputationAdapter: always reverts");
    }
}
