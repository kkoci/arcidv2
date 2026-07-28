// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IArcIDBondSlash} from "./interfaces/IArcIDBondSlash.sol";

/// @title ConsumerSessionKeyGuard
/// @notice Post-submission hardening (see CHANGELOG.md, Phase 6). Scopes the
///         consumer agent's on-chain authority over ArcIDBond to a bounded,
///         revocable, time-limited session key, instead of the consumer's
///         master wallet holding unbounded slash/settlement authority
///         directly.
///
///         Deploy this contract, call
///         `ArcIDBond.setAuthorizedSlasher(address(guard))`, then
///         `grantSessionKey()` and load the SESSION key (not the owner key)
///         into the running consumer agent's `CONSUMER_PRIVATE_KEY`. The
///         owner key stays offline, held by whoever operates the agent.
///
///         If the session key leaks, the blast radius is capped:
///           - target contract: this guard only calls ArcIDBond, never an
///             arbitrary address the caller supplies
///           - payout address: fixed at grant time; the session key cannot
///             redirect slash/settlement proceeds anywhere else (closes the
///             "steal a bonded agent's entire collateral to an attacker
///             wallet" hole a raw authorizedSlasher EOA has, since
///             ArcIDBond.slash() takes an arbitrary `consumer` address)
///           - amount: recordSettlement()'s logged amount is capped
///           - token: implicit — ArcIDBond's collateralToken is fixed at
///             its own construction, so there's nothing to cap here
///           - time: the session expires; no auto-renewal
///
/// SCOPE: this hardens the on-chain call surface only (slash() and
///        recordSettlement()). Circle Gateway payments are authorized
///        off-chain via EIP-712 signatures relayed through Circle's API —
///        a different authority model this contract does not cover. Noted
///        as follow-up work in CHANGELOG.md.
contract ConsumerSessionKeyGuard is Ownable {
    IArcIDBondSlash public immutable bond;

    address public sessionKey;
    address public payoutAddress;    // fixed consumer/treasury address — never attacker-suppliable
    uint256 public maxAmountPerCall; // cap on recordSettlement()'s logged amount, atomic units
    uint64  public expiry;           // unix timestamp; 0 = no active session

    event SessionKeyGranted(
        address indexed sessionKey,
        address indexed payoutAddress,
        uint256 maxAmountPerCall,
        uint64  expiry
    );
    event SessionKeyRevoked(address indexed sessionKey);
    event GuardedSlash(address indexed agent, address indexed sessionKey, string reason);
    event GuardedSettlement(address indexed agent, address indexed sessionKey, uint256 amount, bytes32 verdictHash);

    error NotSessionKey();
    error NoActiveSession();
    error SessionExpired();
    error AmountExceedsCap();

    constructor(address _bond, address _owner) Ownable(_owner) {
        bond = IArcIDBondSlash(_bond);
    }

    modifier onlySessionKey() {
        if (sessionKey == address(0)) revert NoActiveSession();
        if (msg.sender != sessionKey) revert NotSessionKey();
        if (block.timestamp > expiry) revert SessionExpired();
        _;
    }

    /// @notice Grant a new bounded session key. Overwrites any existing session.
    /// @param _sessionKey       Hot wallet address the running consumer agent uses.
    /// @param _payoutAddress    Fixed address slash()/recordSettlement() proceeds go to.
    /// @param _maxAmountPerCall Cap on recordSettlement()'s amount, in the bond token's atomic units.
    /// @param _expiresInSeconds Session lifetime from now.
    function grantSessionKey(
        address _sessionKey,
        address _payoutAddress,
        uint256 _maxAmountPerCall,
        uint64  _expiresInSeconds
    ) external onlyOwner {
        sessionKey       = _sessionKey;
        payoutAddress    = _payoutAddress;
        maxAmountPerCall = _maxAmountPerCall;
        expiry           = uint64(block.timestamp) + _expiresInSeconds;

        emit SessionKeyGranted(_sessionKey, _payoutAddress, _maxAmountPerCall, expiry);
    }

    /// @notice Immediately revoke the active session key (e.g. on suspected leak).
    function revokeSessionKey() external onlyOwner {
        emit SessionKeyRevoked(sessionKey);
        sessionKey = address(0);
        expiry = 0;
    }

    /// @notice Slash via the guard. `consumer` is always `payoutAddress` —
    ///         the session key cannot redirect proceeds anywhere else.
    function guardedSlash(address agent, string calldata reason) external onlySessionKey {
        bond.slash(agent, payoutAddress, reason);
        emit GuardedSlash(agent, msg.sender, reason);
    }

    /// @notice Record a settlement via the guard. Amount capped, payout fixed.
    function guardedRecordSettlement(
        address agent,
        uint256 amount,
        bytes32 verdictHash
    ) external onlySessionKey {
        if (amount > maxAmountPerCall) revert AmountExceedsCap();
        bond.recordSettlement(agent, payoutAddress, amount, verdictHash);
        emit GuardedSettlement(agent, msg.sender, amount, verdictHash);
    }

    /// @notice True if the current session key is set and not expired.
    function hasActiveSession() external view returns (bool) {
        return sessionKey != address(0) && block.timestamp <= expiry;
    }
}
