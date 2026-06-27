"use strict";
/**
 * slash.js — Slash a bonded agent's collateral.
 *
 * Usage:
 *   npm run bond:slash -- \
 *     --key <private-key> \
 *     --agent <agent-address> \
 *     --consumer <consumer-address> \
 *     --reason "<rationale text>" \
 *     [--network arcTestnet]
 *
 * Caller must be the authorizedSlasher on ArcIDBond. The script warns but
 * does not block if the key doesn't match — the on-chain call will revert
 * and show the exact error.
 *
 * The --reason string goes on-chain in the AgentSlashed event, exactly as
 * the consumer agent would write it after LLM adjudication.
 */

const { ethers } = require("ethers");
const {
  parseArgs,
  loadDeployment,
  getProvider,
  getContracts,
  formatUSDC,
} = require("./_lib");

async function main() {
  const args = parseArgs();

  if (!args.key || !args.agent || !args.consumer || !args.reason) {
    console.error(
      "\nUsage: npm run bond:slash -- " +
        "--key <pk> --agent <addr> --consumer <addr> --reason \"<text>\" " +
        "[--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(args.key, provider);
  const deploy   = loadDeployment(network);
  const { bond } = getContracts(deploy.addresses, wallet);

  console.log(`\n→ Slashing agent ${args.agent} on ${network}`);
  console.log(`  ArcIDBond:   ${deploy.addresses.ArcIDBond}`);
  console.log(`  Caller:      ${wallet.address}`);
  console.log(`  Consumer:    ${args.consumer}`);
  console.log(`  Reason:      "${args.reason}"`);

  // Warn if caller is not the authorized slasher (the on-chain call will
  // revert with NotAuthorizedSlasher — this just surfaces it earlier).
  const slasher = await bond.authorizedSlasher();
  if (slasher.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(
      `\n  WARNING: authorizedSlasher is ${slasher}` +
        `\n           caller is           ${wallet.address}` +
        `\n           The transaction will revert on-chain.\n`
    );
  }

  // Pre-flight bond check
  const bondInfo = await bond.bonds(args.agent);
  if (bondInfo.postedAt === 0n) {
    console.error(`\n✗ No bond found for ${args.agent}\n`);
    process.exit(1);
  }
  if (bondInfo.slashed) {
    console.error(`\n✗ Bond for ${args.agent} is already slashed\n`);
    process.exit(1);
  }
  console.log(`  Bond amount: ${formatUSDC(bondInfo.amount)}`);

  const tx      = await bond.slash(args.agent, args.consumer, args.reason);
  const receipt = await tx.wait();

  console.log(`\n✓ slash() mined → ${receipt.hash}`);
  console.log(
    `  ${formatUSDC(bondInfo.amount)} transferred to consumer ${args.consumer}\n`
  );
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
