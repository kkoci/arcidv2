/**
 * deploy_erc8004_adapter.js — Phase 8.2 (post-submission — see CHANGELOG.md).
 *
 * Deploys ERC8004ReputationAdapter, pointed at Arc's real, already-deployed
 * ERC-8004 ReputationRegistry (confirmed live via eth_getCode + a working
 * name() call on the sibling IdentityRegistry — see CHANGELOG.md's Phase 8.1
 * entry) and the existing ArcIDBond deployment address (read from
 * deployments/<network>_standalone.json, same convention as
 * deploy_bond_v2.js — never hardcoded, never from the stale root .env var).
 *
 * Does NOT call ArcIDBond.setReputationAdapter() — that's a separate,
 * explicit owner action (see scripts/cli's admin tooling), kept distinct so
 * deploying the adapter and actually wiring it into the live bond contract
 * stay two separately-confirmed steps, same staged-rollout discipline as
 * deploy_bond_v2.js.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_erc8004_adapter.js --network arcTestnet
 *   npx hardhat run scripts/deploy_erc8004_adapter.js --network hardhat   # local sanity check
 */

const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");

const REPUTATION_REGISTRY_ARC_TESTNET = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

async function main() {
  const { ethers, network } = hre;
  const isLocal = network.name === "hardhat" || network.name === "localhost";

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  console.log(`\n${"─".repeat(60)}`);
  console.log("ERC8004ReputationAdapter deploy — Phase 8.2 (post-submission)");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployerAddr}`);

  let reputationRegistryAddress, bondAddress;

  if (isLocal) {
    const MockReputationRegistry = await ethers.getContractFactory("MockReputationRegistry");
    const mockRegistry = await MockReputationRegistry.deploy();
    reputationRegistryAddress = await mockRegistry.getAddress();
    bondAddress = deployerAddr; // no real bond needed for a local sanity check
    console.log(`\n[local] MockReputationRegistry: ${reputationRegistryAddress}`);
    console.log(`[local] bondContract (placeholder = deployer): ${bondAddress}`);
  } else {
    reputationRegistryAddress = REPUTATION_REGISTRY_ARC_TESTNET;

    const standaloneFile = path.resolve(__dirname, `../deployments/${network.name}_standalone.json`);
    const bondV2File     = path.resolve(__dirname, `../deployments/${network.name}_bond_v2.json`);
    let source;
    if (fs.existsSync(bondV2File)) {
      bondAddress = JSON.parse(fs.readFileSync(bondV2File, "utf8")).addresses.ArcIDBond;
      source = bondV2File;
    } else if (fs.existsSync(standaloneFile)) {
      bondAddress = JSON.parse(fs.readFileSync(standaloneFile, "utf8")).addresses.ArcIDBond;
      source = standaloneFile;
    } else {
      throw new Error(`No existing ArcIDBond deployment found (checked ${bondV2File} and ${standaloneFile}).`);
    }
    console.log(`\n[live] ERC-8004 ReputationRegistry (Arc's, not ours): ${reputationRegistryAddress}`);
    console.log(`[live] ArcIDBond (from ${path.basename(source)}):       ${bondAddress}`);
  }

  console.log(`\n→ Deploying ERC8004ReputationAdapter(reputationRegistry, bondContract)...`);
  const Adapter = await ethers.getContractFactory("ERC8004ReputationAdapter");
  const adapter = await Adapter.deploy(reputationRegistryAddress, bondAddress);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();

  console.log(`\n✓ ERC8004ReputationAdapter deployed → ${adapterAddress}`);
  console.log(`  reputationRegistry: ${await adapter.reputationRegistry()}`);
  console.log(`  bondContract:       ${await adapter.bondContract()}`);

  const deployDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployerAddr,
    timestamp: Math.floor(Date.now() / 1000),
    note: "ERC8004ReputationAdapter — Phase 8.2 (post-submission). Not yet wired into ArcIDBond (setReputationAdapter not called here — separate confirmed step). agentId8004 mappings not yet set (see scripts/cli/register-8004-identity.js + set-8004-agent-id.js).",
    addresses: {
      ERC8004ReputationAdapter: adapterAddress,
      ReputationRegistry:       reputationRegistryAddress,
      ArcIDBond:                bondAddress,
    },
  };

  const outPath = path.join(deployDir, `${network.name}_erc8004_adapter.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[saved] ${outPath}`);
  console.log(`\nNext steps (do NOT auto-run — separate, confirmed steps):`);
  console.log(`  1. Register real 8004 identities: npm run bond:register-identity -- --role oracle|consumer`);
  console.log(`  2. Set agentId mappings: node scripts/cli/set-8004-agent-id.js --wallet <addr> --agent-id <id>`);
  console.log(`  3. Wire into the live bond (owner-only, separate decision): bond.setReputationAdapter(${adapterAddress})`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
