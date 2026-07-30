"use strict";
/**
 * set-authorized-slasher.js — Rotate ArcIDBond.authorizedSlasher.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=... in .env (the contract's Ownable owner), then:
 *   npm run bond:set-slasher -- --new-slasher <address> [--network arcTestnet]
 *
 * The private key is read ONLY from the DEPLOYER_PRIVATE_KEY env var (.env)
 * — never accepted as a CLI argument. See CLAUDE.md's private-key rule.
 * DEPLOYER_PRIVATE_KEY is the existing, correct variable for this role:
 * ArcIDBond's constructor sets both `owner` and `authorizedSlasher` to the
 * deploying wallet, and this script requires `owner` (onlyOwner), not
 * `authorizedSlasher` itself — rotating the slasher is exactly what this
 * call is for.
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

  if (!args["new-slasher"]) {
    console.error(
      "\nUsage: npm run bond:set-slasher -- --new-slasher <address> [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(key, provider);
  const deploy   = loadDeployment(network);
  const { bond } = getContracts(deploy.addresses, wallet);

  console.log(`\n→ Rotating authorizedSlasher on ${network}`);
  console.log(`  ArcIDBond: ${deploy.addresses.ArcIDBond}`);
  console.log(`  Caller:    ${wallet.address}`);

  const owner = await bond.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(
      `\n  WARNING: contract owner is ${owner}` +
        `\n           caller is        ${wallet.address}` +
        `\n           The transaction will revert on-chain.\n`
    );
  }

  const current = await bond.authorizedSlasher();
  console.log(`  Current authorizedSlasher: ${current}`);
  console.log(`  New authorizedSlasher:     ${args["new-slasher"]}`);

  const tx      = await bond.setAuthorizedSlasher(args["new-slasher"]);
  const receipt = await tx.wait();
  const updated = await bond.authorizedSlasher();

  console.log(`\n✓ setAuthorizedSlasher() mined → ${receipt.hash}`);
  console.log(`  authorizedSlasher is now: ${updated}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
