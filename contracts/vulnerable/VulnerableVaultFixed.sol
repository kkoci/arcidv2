// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VulnerableVaultFixed
/// @notice The negative control for the Proof-of-Exploit demo — identical to
///         `VulnerableVault` except balances are zeroed BEFORE the external
///         call (correct checks-effects-interactions order). Kept as a real,
///         checked-in contract (not just a spike artifact) so the harness
///         can demonstrably clear a patched target, not only flag a broken
///         one — proving the invariant check isn't hardcoded to always
///         return "breach".
contract VulnerableVaultFixed {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "no balance");

        balances[msg.sender] = 0; // effects BEFORE interaction — the fix

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function totalBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
