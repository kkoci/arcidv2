// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004ReputationRegistry} from "../interfaces/IERC8004ReputationRegistry.sol";

/// @notice Test-only stand-in for Arc's real ERC-8004 ReputationRegistry.
///         Records the last giveFeedback() call's args for assertion, and
///         can be toggled to revert on demand so tests can prove
///         ERC8004ReputationAdapter's try/catch actually degrades gracefully
///         rather than propagating the failure.
contract MockReputationRegistry is IERC8004ReputationRegistry {
    bool public shouldRevert;
    uint256 public callCount;

    uint256 public lastAgentId;
    int128  public lastValue;
    uint8   public lastValueDecimals;
    string  public lastTag1;
    string  public lastTag2;
    string  public lastEndpoint;
    string  public lastFeedbackURI;
    bytes32 public lastFeedbackHash;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external override {
        if (shouldRevert) revert("MockReputationRegistry: forced revert");

        callCount++;
        lastAgentId = agentId;
        lastValue = value;
        lastValueDecimals = valueDecimals;
        lastTag1 = tag1;
        lastTag2 = tag2;
        lastEndpoint = endpoint;
        lastFeedbackURI = feedbackURI;
        lastFeedbackHash = feedbackHash;
    }
}
