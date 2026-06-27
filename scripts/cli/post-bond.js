"use strict";
/**
 * post-bond.js — Post a USDC bond to ArcIDBond.
 *
 * Usage:
 *   npm run bond:post -- --key <private-key> [--amount 5.0] [--network arcTestnet]
 *
 * --amount is in whole USDC (e.g. 5.0 = 5 USDC = 5_000_000 atomic units).
 * Requires the wallet to already be registered in ArcIDRegistryV2.
 */

const { ethers } = require("ethers");
const {
  parseArgs,
  loadDeployment,
  getProvider,
  getContracts,
  formatUSDC,
  formatTimestamp,
} = require("./_lib");

async function main() {
  const args = parseArgs();

  if (!args.key) {
    console.error(
      "\nUsage: npm run bond:post -- --key <private-key> [--amount 5.0] [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network    = args.network || "arcTestnet";
  const amountUsdc = parseFloat(args.amount ?? "5.0");
  const amountAtom = BigInt(Math.round(amountUsdc * 1e6));

  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(args.key, provider);
  const deploy   = loadDeployment(network);
  const { registry, bond, usdc } = getContracts(deploy.addresses, wallet);

  console.log(
    `\n→ Posting ${amountUsdc} USDC bond from ${wallet.address} on ${network}`
  );
  console.log(`  ArcIDBond:        ${deploy.addresses.ArcIDBond}`);
  console.log(`  collateralToken:  ${deploy.addresses.collateralToken}`);

  // Must be registered
  const agentId = await registry.agentIdBySigner(wallet.address);
  if (agentId === ethers.ZeroHash) {
    console.error(
      `\n✗ Wallet is not registered in ArcIDRegistryV2.` +
      `\n  Run: npm run agent:register -- --key ${args.key} --network ${network}\n`
    );
    process.exit(1);
  }
  console.log(`  agentId: ${agentId} ✓`);

  // Check for existing active bond
  const existing = await bond.bonds(wallet.address);
  if (existing.postedAt !== 0n && !existing.slashed) {
    console.log(
      `\n  Active bond already posted: ${formatUSDC(existing.amount)}` +
      ` (since ${formatTimestamp(existing.postedAt)})`
    );
    console.log(`  Use \`npm run bond:slash\` to slash it first, or choose a different wallet.\n`);
    return;
  }

  // Balance check
  const bal = await usdc.balanceOf(wallet.address);
  if (bal < amountAtom) {
    console.error(
      `\n✗ Insufficient USDC balance: have ${formatUSDC(bal)}, need ${formatUSDC(amountAtom)}\n`
    );
    process.exit(1);
  }

  // Approve
  console.log(`\n→ Approving ${amountUsdc} USDC...`);
  const approveTx = await usdc.approve(deploy.addresses.ArcIDBond, amountAtom);
  await approveTx.wait();
  console.log(`  Approved.`);

  // Post bond
  console.log(`→ Calling postBond(${amountAtom})...`);
  const tx      = await bond.postBond(amountAtom);
  const receipt = await tx.wait();
  const info    = await bond.bonds(wallet.address);

  console.log(`\n✓ postBond() mined → ${receipt.hash}`);
  console.log(`  amount:    ${formatUSDC(info.amount)}`);
  console.log(`  posted at: ${formatTimestamp(info.postedAt)}`);
  console.log(`  active:    ${await bond.isActiveBondedAgent(wallet.address)}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
