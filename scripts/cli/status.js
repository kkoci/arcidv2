"use strict";
/**
 * status.js — Check registration and bond status for a wallet address.
 *
 * Usage:
 *   npm run agent:status -- --address <wallet-address> [--network arcTestnet]
 *
 * Read-only — no private key required.
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

  if (!args.address) {
    console.error(
      "\nUsage: npm run agent:status -- --address <wallet-address> [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const address  = args.address;
  const provider = getProvider(network);
  const deploy   = loadDeployment(network);
  const { registry, bond } = getContracts(deploy.addresses, provider);

  console.log(`\n→ Status for ${address} on ${network}`);

  const agentId  = await registry.agentIdBySigner(address);
  const bondInfo = await bond.bonds(address);
  const isActive = await bond.isActiveBondedAgent(address);

  // Registry
  const registered = agentId !== ethers.ZeroHash;
  console.log(`\n  Registry  ${deploy.addresses.ArcIDRegistryV2}`);
  console.log(`  registered:  ${registered ? "yes ✓" : "no ✗"}`);
  if (registered) {
    console.log(`  agentId:     ${agentId}`);
  }

  // Bond
  console.log(`\n  Bond      ${deploy.addresses.ArcIDBond}`);
  if (bondInfo.postedAt === 0n) {
    console.log(`  status:      no bond posted`);
  } else {
    const status = isActive
      ? "active ✓"
      : bondInfo.slashed
      ? "slashed ✗"
      : "withdrawn";
    console.log(`  status:      ${status}`);
    console.log(`  amount:      ${formatUSDC(bondInfo.amount)}`);
    console.log(`  posted at:   ${formatTimestamp(bondInfo.postedAt)}`);
  }
  console.log();
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
