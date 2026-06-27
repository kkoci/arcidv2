"use strict";
/**
 * register.js — Register a new agent in ArcIDRegistryV2.
 *
 * Usage:
 *   npm run agent:register -- --key <private-key> [--network arcTestnet]
 *
 * Builds a fresh DCAP attestation quote for the given wallet and calls
 * ArcIDRegistryV2.registerAgent() on-chain. Idempotent: if the wallet is
 * already registered, prints the existing agentId and exits cleanly.
 */

const { ethers } = require("ethers");
const {
  parseArgs,
  loadDeployment,
  getProvider,
  getContracts,
  buildAttestation,
} = require("./_lib");

async function main() {
  const args = parseArgs();

  if (!args.key) {
    console.error(
      "\nUsage: npm run agent:register -- --key <private-key> [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(args.key, provider);
  const deploy   = loadDeployment(network);
  const { registry } = getContracts(deploy.addresses, wallet);

  console.log(`\n→ Registering ${wallet.address} on ${network}`);
  console.log(`  ArcIDRegistryV2: ${deploy.addresses.ArcIDRegistryV2}`);

  // Idempotency check
  const existing = await registry.agentIdBySigner(wallet.address);
  if (existing !== ethers.ZeroHash) {
    console.log(`\n  Already registered — nothing to do.`);
    console.log(`  agentId: ${existing}\n`);
    return;
  }

  console.log(`\n→ Building DCAP attestation quote for ${wallet.address}...`);
  const { dcapQuote, reportDataSig, reportData } = buildAttestation(
    wallet.address,
    args.key
  );
  console.log(`  reportData: ${reportData}`);

  const tx      = await registry.registerAgent(dcapQuote, reportDataSig);
  const receipt = await tx.wait();
  const agentId = await registry.agentIdBySigner(wallet.address);

  console.log(`\n✓ registerAgent() mined → ${receipt.hash}`);
  console.log(`  agentId:   ${agentId}`);
  console.log(`  tx block:  ${receipt.blockNumber}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
