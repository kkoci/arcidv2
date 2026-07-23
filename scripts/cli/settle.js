"use strict";
/**
 * settle.js — Record an off-chain Gateway settlement against a bonded agent.
 *
 * Usage:
 *   npm run bond:settle -- \
 *     --key <slasher-private-key> \
 *     --agent <agent-address> \
 *     --consumer <consumer-address> \
 *     [--amount 0.001] \
 *     [--verdict-hash 0x...] \
 *     [--network arcTestnet]
 *
 * Caller must be the authorizedSlasher on ArcIDBond — same key the consumer
 * agent uses to call slash(). This does NOT move funds: the Circle Gateway
 * payment already happened (via the consumer agent's settlement.js, or
 * manually); this call only writes the on-chain PaymentSettled audit record,
 * the "no breach" counterpart to `npm run bond:slash`.
 *
 * --amount is in whole USDC (e.g. 0.001 = the standard nanopayment price).
 * --verdict-hash defaults to a fresh keccak256 nonce if omitted, so this can
 * be run standalone for a demo without a real adjudication record — pass the
 * consumer agent's actual verdict hash to tie this to a real cycle.
 */

const { ethers } = require("ethers");
const {
  parseArgs,
  loadDeployment,
  getProvider,
  getContracts,
} = require("./_lib");

async function main() {
  const args = parseArgs();

  if (!args.key || !args.agent || !args.consumer) {
    console.error(
      "\nUsage: npm run bond:settle -- " +
        "--key <pk> --agent <addr> --consumer <addr> " +
        "[--amount 0.001] [--verdict-hash 0x...] [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network    = args.network || "arcTestnet";
  const amountUsdc = parseFloat(args.amount ?? "0.001");
  const amountAtom = BigInt(Math.round(amountUsdc * 1e6));
  const verdictHash =
    args["verdict-hash"] ||
    ethers.keccak256(ethers.toUtf8Bytes(`manual-settlement:${Date.now()}`));

  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(args.key, provider);
  const deploy   = loadDeployment(network);
  const { bond } = getContracts(deploy.addresses, wallet);

  console.log(`\n→ Recording settlement for agent ${args.agent} on ${network}`);
  console.log(`  ArcIDBond:    ${deploy.addresses.ArcIDBond}`);
  console.log(`  Caller:       ${wallet.address}`);
  console.log(`  Consumer:     ${args.consumer}`);
  console.log(`  Amount:       ${amountUsdc.toFixed(6)} USDC`); // nanopayment-scale — formatUSDC's 2dp rounds this to 0.00
  console.log(`  VerdictHash:  ${verdictHash}`);

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

  // Pre-flight bond check — same requirements recordSettlement() enforces
  // on-chain, surfaced here with a friendlier message.
  const bondInfo = await bond.bonds(args.agent);
  if (bondInfo.postedAt === 0n) {
    console.error(`\n✗ No bond found for ${args.agent}\n`);
    process.exit(1);
  }
  if (bondInfo.slashed) {
    console.error(`\n✗ Bond for ${args.agent} was already slashed — cannot settle a payment against it\n`);
    process.exit(1);
  }

  const tx      = await bond.recordSettlement(args.agent, args.consumer, amountAtom, verdictHash);
  const receipt = await tx.wait();

  console.log(`\n✓ recordSettlement() mined → ${receipt.hash}`);
  console.log(`  ${amountUsdc.toFixed(6)} USDC settlement logged for agent ${args.agent}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
