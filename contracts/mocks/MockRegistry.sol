// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArcIDRegistry} from "../interfaces/IArcIDRegistry.sol";

/// @notice Test-only registry. Call setVerified() to mark a signer as TEE-attested.
contract MockRegistry is IArcIDRegistry {
    mapping(address => bytes32) public agentIdBySigner;

    function setVerified(address signer, bytes32 agentId) external {
        agentIdBySigner[signer] = agentId;
    }

    function unsetVerified(address signer) external {
        delete agentIdBySigner[signer];
    }
}
