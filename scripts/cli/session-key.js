"use strict";
/**
 * session-key.js — Grant or revoke the consumer agent's session key on
 * ConsumerSessionKeyGuard (Phase 6, post-submission — see CHANGELOG.md).
 *
 * Usage:
 *   npm run session:grant -- \
 *     --owner-key <guard-owner-private-key> \
 *     --session-key <hot-wallet-address> \
 *     --payout <fixed-payout-address> \
 *     [--max-amount 0.01] \
 *     [--expires-in 3600] \
 *     [--network arcTestnet]
 *
 *   npm run session:revoke -- \
 *     --owner-key <guard-owner-private-key> \
 *     [--network arcTestnet]
 *
 * `--owner-key` is the guard's owner — kept offline by whoever operates the
 * agent, never loaded into the running consumer process. `--session-key` is
 * the hot wallet the running consumer agent actually uses (loaded as
 * CONSUMER_PRIVATE_KEY there) — it can only call guardedSlash() /
 * guardedRecordSettlement() on the guard, capped and time-limited, never
 * ArcIDBond directly.
 *
 * --max-amount is in whole USDC (e.g. 0.01 = the cap on a single
 * recordSettlement() call). --expires-in is in seconds (default: 3600 = 1 hour).
 */

const { ethers } = require("ethers");
const {
  parseArgs,
  loadSessionGuardDeployment,
  getProvider,
  getGuardContract,
} = require("./_lib");

async function main() {
  const args = parseArgs();
  const action = args.action || (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null);

  if (!args["owner-key"]) {
    console.error(
      "\nUsage:" +
        "\n  npm run session:grant -- --owner-key <pk> --session-key <addr> --payout <addr> " +
        "[--max-amount 0.01] [--expires-in 3600] [--network arcTestnet]" +
        "\n  npm run session:revoke -- --owner-key <pk> [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(args["owner-key"], provider);
  const deploy   = loadSessionGuardDeployment(network);
  const guard    = getGuardContract(deploy.guardAddress, wallet);

  console.log(`\nConsumerSessionKeyGuard: ${deploy.guardAddress}`);
  console.log(`ArcIDBond:               ${deploy.bondAddress}`);
  console.log(`Caller:                  ${wallet.address}`);

  const owner = await guard.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(
      `\n  WARNING: guard owner is ${owner}` +
        `\n           caller is      ${wallet.address}` +
        `\n           The transaction will revert on-chain.\n`
    );
  }

  if (action === "revoke") {
    console.log(`\n→ Revoking active session key...`);
    const tx = await guard.revokeSessionKey();
    const receipt = await tx.wait();
    console.log(`\n✓ revokeSessionKey() mined → ${receipt.hash}\n`);
    return;
  }

  // Default action: grant
  if (!args["session-key"] || !args.payout) {
    console.error(
      "\nUsage: npm run session:grant -- --owner-key <pk> --session-key <addr> --payout <addr> " +
        "[--max-amount 0.01] [--expires-in 3600] [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const maxAmountUsdc = parseFloat(args["max-amount"] ?? "0.01");
  const maxAmountAtom = BigInt(Math.round(maxAmountUsdc * 1e6));
  const expiresIn     = parseInt(args["expires-in"] ?? "3600", 10);

  console.log(`\n→ Granting session key ${args["session-key"]}`);
  console.log(`  Payout address:  ${args.payout}`);
  console.log(`  Max per call:    ${maxAmountUsdc} USDC`);
  console.log(`  Expires in:      ${expiresIn}s`);

  const tx = await guard.grantSessionKey(
    args["session-key"],
    args.payout,
    maxAmountAtom,
    expiresIn
  );
  const receipt = await tx.wait();
  const expiry  = await guard.expiry();

  console.log(`\n✓ grantSessionKey() mined → ${receipt.hash}`);
  console.log(`  expires at (unix): ${expiry}`);
  console.log(
    `\n  Load ${args["session-key"]}'s private key as CONSUMER_PRIVATE_KEY in the` +
      `\n  running consumer agent's .env. The owner key used here should NOT be.\n`
  );
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
