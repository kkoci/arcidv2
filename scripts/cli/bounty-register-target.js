"use strict";
/**
 * bounty-register-target.js — Register a bounty target on the deployed
 * ExploitBounty contract.
 *
 * Deploys a REAL VulnerableVault instance on-chain as the reference target
 * (so it's a real, inspectable address on the explorer) — this is purely a
 * reference/display target; the harness's actual invariant check runs
 * against its own FRESH LOCAL deployment of the same bytecode, not this
 * live one (see bounty/harness.js's own doc comment for why forking this
 * live instance's state was cut for time). If you already have a target
 * contract address, pass --target-contract to skip the deploy.
 *
 * Usage:
 *   TARGET_OWNER_PRIVATE_KEY=... in .env (never a CLI argument), then:
 *   npm run bounty:register-target -- --bounty 2.0 [--target-contract 0x...] [--network arcTestnet]
 *
 * Plain `node`, no Hardhat runtime — matches every other scripts/cli/*.js
 * tool's convention. Loads the VulnerableVault artifact directly (needs
 * `npm run compile` to have been run first).
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function parseArgs() {
  const args = process.argv.slice(2);
  const out  = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key  = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

function requireEnvKey(name) {
  const raw = process.env[name];
  if (!raw) {
    console.error(`\nMissing required env var: ${name}`);
    console.error(`Set it in .env (project root) — private keys are never passed as CLI arguments.\n`);
    process.exit(1);
  }
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

const ARC_TESTNET_CHAIN_ID = 5042002;

function getProvider(network) {
  if (network === "hardhat" || network === "localhost") {
    return new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  }
  const url = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
  return new ethers.JsonRpcProvider(url, { chainId: ARC_TESTNET_CHAIN_ID, name: "arcTestnet" }, { staticNetwork: true });
}

function loadArtifact(relPath) {
  const full = path.join(__dirname, "../../artifacts/contracts", relPath);
  if (!fs.existsSync(full)) {
    console.error(`\nArtifact not found: ${full}`);
    console.error("Run `npm run compile` first.\n");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function loadBountyDeployment(network) {
  const p = path.join(__dirname, `../../deployments/${network}_exploit_bounty.json`);
  if (!fs.existsSync(p)) {
    console.error(`\nExploitBounty deployment not found: ${p}`);
    console.error(`Run \`npx hardhat run scripts/deploy_exploit_bounty.js --network ${network}\` first.\n`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

const BOUNTY_ABI = [
  "function registerTarget(address targetContract, bytes32 invariantId, uint256 bountyAmount) external returns (uint256)",
  "event TargetRegistered(uint256 indexed targetId, address indexed owner, address indexed targetContract, bytes32 invariantId, uint256 bountyAmount)",
];

// Must match bounty/harness.js's INVARIANT_LABEL exactly — a mismatch is
// rejected on-chain (InvariantMismatch) when the harness later submits.
const INVARIANT_LABEL = "reentrancy-drain-v1";

async function main() {
  const args    = parseArgs();
  const network = args.network || "arcTestnet";
  const key     = requireEnvKey("TARGET_OWNER_PRIVATE_KEY");

  const bountyUsdc = parseFloat(args.bounty || "2.0");
  const bountyAtomic = BigInt(Math.round(bountyUsdc * 1e6));

  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(key, provider);
  const deployment = loadBountyDeployment(network);

  console.log(`\n→ Registering a bounty target on ${network}`);
  console.log(`  ExploitBounty: ${deployment.addresses.ExploitBounty}`);
  console.log(`  Owner:         ${wallet.address}`);
  console.log(`  Bounty:        ${bountyUsdc} USDC`);

  let targetContract = args["target-contract"];
  if (!targetContract) {
    console.log(`\n→ No --target-contract given — deploying a real VulnerableVault as the reference target...`);
    const artifact = loadArtifact("vulnerable/VulnerableVault.sol/VulnerableVault.json");
    const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const vault    = await factory.deploy();
    await vault.waitForDeployment();
    targetContract = await vault.getAddress();
    console.log(`✓ VulnerableVault deployed → ${targetContract}`);
  }

  const usdc = new ethers.Contract(deployment.addresses.collateralToken, ERC20_ABI, wallet);
  console.log(`\n→ Approving ${bountyUsdc} USDC...`);
  const approveTx = await usdc.approve(deployment.addresses.ExploitBounty, bountyAtomic);
  await approveTx.wait();
  console.log(`✓ approve() mined → ${approveTx.hash}`);

  const bounty = new ethers.Contract(deployment.addresses.ExploitBounty, BOUNTY_ABI, wallet);
  const invariantId = ethers.id(INVARIANT_LABEL);

  console.log(`\n→ Calling registerTarget(${targetContract}, ${invariantId}, ${bountyAtomic})...`);
  const tx = await bounty.registerTarget(targetContract, invariantId, bountyAtomic);
  const receipt = await tx.wait();

  const event = receipt.logs
    .map((l) => { try { return bounty.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "TargetRegistered");
  const targetId = event ? event.args.targetId : null;

  console.log(`\n✓ registerTarget() mined → ${receipt.hash}`);
  console.log(`  targetId:       ${targetId}`);
  console.log(`  targetContract: ${targetContract}`);
  console.log(`  invariantId:    ${invariantId} ("${INVARIANT_LABEL}")`);
  console.log(`  bountyAmount:   ${bountyUsdc} USDC\n`);
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
