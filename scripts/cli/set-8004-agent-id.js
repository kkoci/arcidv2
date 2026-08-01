#!/usr/bin/env node
"use strict";
/**
 * set-8004-agent-id.js — Phase 8.2 (post-submission — see CHANGELOG.md).
 *
 * Owner-only: maps a wallet address to its real ERC-8004 agentId on the
 * deployed ERC8004ReputationAdapter (see deploy_erc8004_adapter.js). Run
 * register-8004-identity.js first to actually obtain the agentId.
 *
 * Usage:
 *   node scripts/cli/set-8004-agent-id.js --wallet 0x... --agent-id 3 --network arcTestnet
 *
 * DEPLOYER_PRIVATE_KEY (root .env) — must equal the adapter's Ownable owner.
 */

const path = require("path");
const { ethers } = require("ethers");
const { parseArgs, requireEnvKey, getProvider } = require("./_lib");

const ADAPTER_ABI = [
  "function setAgentId(address wallet, uint256 agentId) external",
  "function agentId8004(address) external view returns (uint256)",
  "function owner() external view returns (address)",
];

async function main() {
  const args = parseArgs();
  const network = args.network || "arcTestnet";
  if (!args.wallet || args["agent-id"] === undefined) {
    console.error("\nUsage: node scripts/cli/set-8004-agent-id.js --wallet 0x... --agent-id <n> [--network arcTestnet]\n");
    process.exit(1);
  }

  const deployFile = path.join(__dirname, `../../deployments/${network}_erc8004_adapter.json`);
  const fs = require("fs");
  if (!fs.existsSync(deployFile)) {
    console.error(`\nMissing ${deployFile} — run deploy_erc8004_adapter.js first.\n`);
    process.exit(1);
  }
  const adapterAddress = JSON.parse(fs.readFileSync(deployFile, "utf8")).addresses.ERC8004ReputationAdapter;

  const privateKey = requireEnvKey("DEPLOYER_PRIVATE_KEY");
  const provider = getProvider(network);
  const signer   = new ethers.Wallet(privateKey, provider);
  const adapter  = new ethers.Contract(adapterAddress, ADAPTER_ABI, signer);

  console.log(`\nAdapter:  ${adapterAddress}`);
  console.log(`Wallet:   ${args.wallet}`);
  console.log(`AgentId:  ${args["agent-id"]}`);

  const tx = await adapter.setAgentId(args.wallet, args["agent-id"]);
  console.log(`  tx: ${tx.hash}`);
  await tx.wait();

  const confirmed = await adapter.agentId8004(args.wallet);
  console.log(`\n✓ Confirmed on-chain: agentId8004(${args.wallet}) = ${confirmed}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
