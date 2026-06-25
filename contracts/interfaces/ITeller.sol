// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITeller
/// @notice Minimal interface for the Hashnote USYC Teller on Arc testnet.
///         Call deposit() to exchange USDC for USYC. Call redeem() to go back.
///
///         Arc testnet Teller: 0x9fdF14c5B14173D74C08Af27AebFf39240dC105A
///
///         Flow to mint USYC:
///           1. IERC20(USDC).approve(tellerAddress, usdcAmount)
///           2. shares = teller.deposit(USDC, usdcAmount, 0)
///           → shares is the amount of USYC received
///
///         Flow to redeem USYC for USDC:
///           1. IERC20(USYC).approve(tellerAddress, usycAmount)
///           2. assets = teller.redeem(USDC, usycAmount, 0)
///           → assets is the amount of USDC received (includes accrued yield)
interface ITeller {

    /// @notice Deposit `depositAmount` of `depositAsset` (e.g. USDC) and receive USYC shares.
    /// @param depositAsset    ERC-20 address to deposit (USDC).
    /// @param depositAmount   Amount to deposit (USDC, 6 decimals).
    /// @param minimumMint     Minimum USYC shares to accept — pass 0 to skip slippage check.
    /// @return shares         USYC received (8 decimals).
    function deposit(
        address depositAsset,
        uint256 depositAmount,
        uint256 minimumMint
    ) external returns (uint256 shares);

    /// @notice Redeem `shares` USYC and receive `redeemAsset` (e.g. USDC) back.
    /// @param redeemAsset     ERC-20 address to receive (USDC).
    /// @param shares          USYC to redeem (8 decimals).
    /// @param minimumAssets   Minimum USDC to accept — pass 0 to skip slippage check.
    /// @return assets         USDC received (includes yield accrued since deposit).
    function redeem(
        address redeemAsset,
        uint256 shares,
        uint256 minimumAssets
    ) external returns (uint256 assets);

    /// @notice Current USYC share price relative to USDC (18-decimal fixed point).
    function sharePrice() external view returns (uint256);
}
