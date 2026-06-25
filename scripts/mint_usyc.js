/**
 * mint_usyc.js — Mint USYC from USDC via the Arc testnet Teller
 *
 * Flow:
 *   1. Check USDC balance
 *   2. approve(TELLER, amount)
 *   3. teller.deposit(USDC, amount, 0) → receive USYC
 *   4. Print before/after balances and USYC share price
 *
 * Usage:
 *   npm run mint:usyc              # mints 5 USDC worth of USYC
 *   MINT_USDC=10 npm run mint:usyc # specify amount
 *
 * Requirement: wallet must be USYC-allowlisted by Circle.
 *              Request allowlist at: https://circle.com/en/usyc
 */

require("dotenv").config();
const { ethers, network } = require("hardhat");

const ADDRESSES = {
  USDC:   "0x3600000000000000000000000000000000000000",
  USYC:   "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
  TELLER: "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const TELLER_ABI = [
  "function deposit(address depositAsset, uint256 depositAmount, uint256 minimumMint) returns (uint256 shares)",
  "function sharePrice() view returns (uint256)",
];

async function main() {
  if (network.name !== "arcTestnet") {
    throw new Error("This script targets Arc testnet only. Use: npm run mint:usyc:arc");
  }

  const [signer]  = await ethers.getSigners();
  const mintUSDC  = process.env.MINT_USDC ? parseFloat(process.env.MINT_USDC) : 5;
  const mintAmount = ethers.parseUnits(String(mintUSDC), 6);

  console.log(`\n${"─".repeat(60)}`);
  console.log("ArcID USYC Mint via Teller");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network:  ${network.name}`);
  console.log(`Wallet:   ${signer.address}`);
  console.log(`Minting:  ${mintUSDC} USDC → USYC`);

  const usdc   = new ethers.Contract(ADDRESSES.USDC,   ERC20_ABI,  signer);
  const usyc   = new ethers.Contract(ADDRESSES.USYC,   ERC20_ABI,  signer);
  const teller = new ethers.Contract(ADDRESSES.TELLER, TELLER_ABI, signer);

  const usdcBefore = await usdc.balanceOf(signer.address);
  const usycBefore = await usyc.balanceOf(signer.address);

  console.log(`\nBalances before:`);
  console.log(`  USDC: ${ethers.formatUnits(usdcBefore, 6)}`);
  console.log(`  USYC: ${ethers.formatUnits(usycBefore, 8)}`);

  if (usdcBefore < mintAmount) {
    console.error(`\n✗ Insufficient USDC. Have ${ethers.formatUnits(usdcBefore, 6)}, need ${mintUSDC}`);
    console.error(`  Fund via: faucet.circle.com → select Arc Testnet`);
    process.exitCode = 1;
    return;
  }

  let sharePrice;
  try {
    sharePrice = await teller.sharePrice();
    console.log(`\nUSYC share price: $${ethers.formatUnits(sharePrice, 18)} per USYC`);
  } catch {
    sharePrice = null;
  }

  console.log(`\n[1/2] Approving Teller to spend ${mintUSDC} USDC...`);
  const approveTx = await usdc.approve(ADDRESSES.TELLER, mintAmount);
  await approveTx.wait();
  console.log(`  Approved. tx: ${approveTx.hash}`);

  console.log(`[2/2] Calling teller.deposit(USDC, ${mintUSDC}, 0)...`);
  console.log(`  Note: this will revert if wallet is not USYC-allowlisted.`);

  try {
    const depositTx = await teller.deposit(ADDRESSES.USDC, mintAmount, 0);
    const receipt   = await depositTx.wait();
    console.log(`  Deposit confirmed. tx: ${depositTx.hash}`);

    const usdcAfter = await usdc.balanceOf(signer.address);
    const usycAfter = await usyc.balanceOf(signer.address);
    const usycGained = usycAfter - usycBefore;

    console.log(`\nBalances after:`);
    console.log(`  USDC: ${ethers.formatUnits(usdcAfter, 6)}  (−${mintUSDC})`);
    console.log(`  USYC: ${ethers.formatUnits(usycAfter, 8)}  (+${ethers.formatUnits(usycGained, 8)})`);
    console.log(`\n✅ USYC minted. Ready to post a yield-bearing bond:`);
    console.log(`   npm run deploy:usyc:arc`);

  } catch (err) {
    console.error(`\n✗ Teller deposit failed.`);
    const msg = err.message || "";
    if (msg.includes("allowlist") || msg.includes("entitlement") || msg.includes("not authorized")) {
      console.error(`  Cause: wallet not on USYC allowlist.`);
      console.error(`  Request access: https://circle.com/en/usyc`);
    } else {
      console.error(`  Raw error: ${msg.split("\n")[0]}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
