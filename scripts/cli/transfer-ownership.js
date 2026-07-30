"use strict";
/**
 * transfer-ownership.js — Transfer ArcIDBond's Ownable ownership.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=... in .env (the CURRENT owner), then:
 *   npm run bond:transfer-ownership -- --new-owner <address> [--network arcTestnet]
 *
 * The private key is read ONLY from the DEPLOYER_PRIVATE_KEY env var (.env)
 * — never accepted as a CLI argument. See CLAUDE.md's private-key rule.
 *
 * ArcIDBond uses plain OpenZeppelin Ownable (not Ownable2Step) — this is a
 * single-step, immediate transfer. Double-check --new-owner before running;
 * there is no accept-step safety net.
 */

const { ethers } = require("ethers");
const {
  parseArgs,
  requireEnvKey,
  loadDeployment,
  getProvider,
  getContracts,
} = require("./_lib");

async function main() {
  const args = parseArgs();
  const key  = requireEnvKey("DEPLOYER_PRIVATE_KEY");

  if (!args["new-owner"]) {
    console.error(
      "\nUsage: npm run bond:transfer-ownership -- --new-owner <address> [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(key, provider);
  const deploy   = loadDeployment(network);
  const { bond } = getContracts(deploy.addresses, wallet);

  console.log(`\n→ Transferring ArcIDBond ownership on ${network}`);
  console.log(`  ArcIDBond: ${deploy.addresses.ArcIDBond}`);
  console.log(`  Caller:    ${wallet.address}`);

  const currentOwner = await bond.owner();
  if (currentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(
      `\n  WARNING: current owner is ${currentOwner}` +
        `\n           caller is       ${wallet.address}` +
        `\n           The transaction will revert on-chain.\n`
    );
  }
  console.log(`  Current owner: ${currentOwner}`);
  console.log(`  New owner:     ${args["new-owner"]}`);

  const tx      = await bond.transferOwnership(args["new-owner"]);
  const receipt = await tx.wait();
  const updated = await bond.owner();

  console.log(`\n✓ transferOwnership() mined → ${receipt.hash}`);
  console.log(`  owner() is now: ${updated}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
