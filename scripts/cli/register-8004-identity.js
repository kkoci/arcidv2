#!/usr/bin/env node
"use strict";
/**
 * register-8004-identity.js — Phase 8.2 (post-submission — see CHANGELOG.md).
 *
 * Registers arcid2's oracle or consumer wallet in Arc's real, already-
 * deployed ERC-8004 IdentityRegistry (0x8004A818BFB912233c491871b3d84c89A494BD9e
 * on Arc Testnet — confirmed live via eth_getCode + a working name() call,
 * see CHANGELOG.md's Phase 8.1 entry). This is a ONE-TIME step per wallet —
 * re-running it registers a SECOND, separate agentId for the same wallet
 * (the registry has no "already registered" check of its own), so this
 * script refuses to run if the wallet already has a cached agentId in
 * deployments/arcTestnet_erc8004_identities.json, unless --force is passed.
 *
 * Usage:
 *   node scripts/cli/register-8004-identity.js --role oracle
 *   node scripts/cli/register-8004-identity.js --role consumer
 *
 * Private key is read from oracle/.env's ORACLE_PRIVATE_KEY or
 * consumer/.env's CONSUMER_PRIVATE_KEY — never a CLI argument (see
 * CLAUDE.md's private-key rule).
 */

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { parseArgs, getProvider, normalizePrivateKey } = require("./_lib");

const IDENTITY_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const IDENTITY_REGISTRY_ABI = [
  "function register(string agentURI) external returns (uint256 agentId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const ROLES = {
  oracle: {
    envPath: path.join(__dirname, "../../oracle/.env"),
    keyVar: "ORACLE_PRIVATE_KEY",
    metadataURI: "arcid2:oracle:price-feed", // no hosted JSON yet — a plain
                                              // identifying string, honest
                                              // about not having a resolvable
                                              // agentURI document today
  },
  consumer: {
    envPath: path.join(__dirname, "../../consumer/.env"),
    keyVar: "CONSUMER_PRIVATE_KEY",
    metadataURI: "arcid2:consumer:adjudicator",
  },
};

const CACHE_PATH = path.join(__dirname, "../../deployments/arcTestnet_erc8004_identities.json");

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

async function main() {
  const args = parseArgs();
  const role = args.role;
  if (!ROLES[role]) {
    console.error(`\n--role must be "oracle" or "consumer". Got: ${role}\n`);
    process.exit(1);
  }

  const { envPath, keyVar, metadataURI } = ROLES[role];
  require("dotenv").config({ path: envPath });

  const rawKey = process.env[keyVar];
  if (!rawKey) {
    console.error(`\nMissing ${keyVar} in ${envPath}\n`);
    process.exit(1);
  }
  const privateKey = normalizePrivateKey(rawKey);

  const cache = loadCache();
  if (cache[role] && !args.force) {
    console.log(`\n${role} already registered: agentId=${cache[role].agentId} (wallet ${cache[role].wallet})`);
    console.log(`Pass --force to register a second, separate agentId for the same wallet.\n`);
    return;
  }

  const provider = getProvider("arcTestnet");
  const signer   = new ethers.Wallet(privateKey, provider);
  const registry = new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_REGISTRY_ABI, signer);

  console.log(`\nRegistering ${role} wallet ${signer.address} in ERC-8004 IdentityRegistry...`);
  console.log(`  agentURI: ${metadataURI}`);

  const tx = await registry.register(metadataURI);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();

  const transferEvent = receipt.logs
    .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "Transfer" && e.args.from === ethers.ZeroAddress);

  if (!transferEvent) {
    console.error("\nRegistration tx confirmed but no Transfer(from=0x0) event found — cannot recover agentId.\n");
    process.exit(1);
  }

  const agentId = transferEvent.args.tokenId.toString();
  console.log(`  agentId: ${agentId}`);

  cache[role] = { wallet: signer.address, agentId, txHash: receipt.hash, registeredAt: new Date().toISOString() };
  saveCache(cache);
  console.log(`\nSaved to ${CACHE_PATH}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
