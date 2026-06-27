"use strict";
/**
 * gating-check.js — Proof-of-gating: verify that an unregistered wallet
 * cannot post a bond.
 *
 * Usage:
 *   npm run gating:check -- --key <private-key> [--network arcTestnet]
 *
 * If the wallet IS registered: reports its agentId and notes that postBond()
 * would succeed.
 *
 * If the wallet is NOT registered: attempts postBond() via eth_call
 * (staticCall — no gas cost) and confirms the gating revert message.
 */

const { ethers } = require("ethers");
const {
  parseArgs,
  loadDeployment,
  getProvider,
  getContracts,
} = require("./_lib");

const FIVE_USDC = 5_000_000n;

async function main() {
  const args = parseArgs();

  if (!args.key) {
    console.error(
      "\nUsage: npm run gating:check -- --key <private-key> [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(args.key, provider);
  const deploy   = loadDeployment(network);
  const { registry, bond } = getContracts(deploy.addresses, wallet);

  console.log(`\n→ Gating check for ${wallet.address} on ${network}`);
  console.log(`  ArcIDRegistryV2: ${deploy.addresses.ArcIDRegistryV2}`);
  console.log(`  ArcIDBond:       ${deploy.addresses.ArcIDBond}`);

  const agentId = await registry.agentIdBySigner(wallet.address);

  if (agentId !== ethers.ZeroHash) {
    console.log(`\n  Wallet IS registered.`);
    console.log(`  agentId: ${agentId}`);
    console.log(`  postBond() would SUCCEED for this wallet.`);
    console.log(
      `\n  To post a bond:  npm run bond:post -- --key ${args.key} --network ${network}\n`
    );
    return;
  }

  console.log(`\n  Wallet is NOT registered — confirming gating revert via staticCall...`);

  try {
    await bond.postBond.staticCall(FIVE_USDC);
    // If we reach here, gating is broken
    console.error(
      "\n  ✗ UNEXPECTED: staticCall did not revert — gating is not working!\n"
    );
    process.exit(1);
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("Agent not TEE-verified in ArcID registry")) {
      console.log(`\n  ✓ GATING CONFIRMED`);
      console.log(`    Revert: "Agent not TEE-verified in ArcID registry"`);
      console.log(
        `\n    To register:  npm run agent:register -- --key ${args.key} --network ${network}\n`
      );
    } else {
      // Unexpected revert message — surface it
      console.log(`\n  Reverted with unexpected message:`);
      console.log(`    ${msg.slice(0, 200)}\n`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
