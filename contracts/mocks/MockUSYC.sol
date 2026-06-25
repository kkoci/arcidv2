// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSYC
/// @notice Test-only yield-bearing collateral token. Models USYC (Hashnote) as a
///         share-price token: each USYC unit is worth `sharePrice` micro-USDC.
///         Call simulateYield(bps) to advance the price and demonstrate that bonded
///         collateral appreciates while at stake — "capital at risk that isn't idle."
///
/// @dev    Real USYC on Arc testnet: 0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C (8 decimals)
///         Real Teller (mint/redeem):  0x9fdF14c5B14173D74C08Af27AebFf39240dC105A
contract MockUSYC is ERC20 {

    /// @dev USDC value per 1 full USYC, denominated in USDC units (6 decimals).
    ///      Initial value 1_000_000 = $1.00. Increases on every simulateYield call.
    uint256 public sharePrice;

    event YieldAccrued(uint256 bps, uint256 newSharePrice);

    constructor() ERC20("Mock USYC", "USYC") {
        sharePrice = 1_000_000; // $1.00 per USYC at launch
    }

    /// @dev USYC uses 8 decimals on mainnet and Arc testnet.
    function decimals() public pure override returns (uint8) { return 8; }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Simulate yield accrual by increasing the share price.
    /// @param bps  Basis points of yield — e.g. 50 = 0.5%. Use 490 for ~4.9% APY.
    function simulateYield(uint256 bps) external {
        sharePrice = sharePrice + (sharePrice * bps) / 10_000;
        emit YieldAccrued(bps, sharePrice);
    }

    /// @notice Returns the USDC value (6 decimals) of `usycAmount` USYC (8 decimals).
    ///         Example: 5e8 USYC * sharePrice 1_005_000 / 1e8 = 5_025_000 = $5.025
    function valueInUsdc(uint256 usycAmount) external view returns (uint256) {
        return (usycAmount * sharePrice) / 1e8;
    }
}
