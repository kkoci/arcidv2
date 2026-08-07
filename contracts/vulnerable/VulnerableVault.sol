// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VulnerableVault
/// @notice Deliberately vulnerable target contract for the Proof-of-Exploit
///         vertical's demo — a classic checks-effects-interactions
///         violation. `withdraw()` sends ETH before zeroing the caller's
///         tracked balance, so a reentrant call during that external call
///         still sees the un-zeroed balance and can withdraw again.
///
///         This is the "known exploit class against a known target" the
///         Proof-of-Exploit harness runs against a fresh local deployment
///         of this exact bytecode — see `contracts/ExploitBounty.sol` and
///         `bounty/harness.js`. Ported from `spike/proof-of-exploit/` where
///         the exploit loop was first proven end to end.
///
/// @dev Intentionally simple and ETH-based (not the ERC-20/USDC collateral
///      the rest of arcid2 uses) — a plain ERC-20 `transfer()` has no
///      callback hook, so it can't reproduce this exploit class at all.
///      This contract exists purely as a fixed, checked-in vulnerability
///      fixture, not as anything resembling production vault code.
contract VulnerableVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "no balance");

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");

        balances[msg.sender] = 0; // effects AFTER interaction — the bug
    }

    function totalBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
