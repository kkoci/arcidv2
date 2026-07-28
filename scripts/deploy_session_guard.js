/**
 * deploy_session_guard.js — Deploy ConsumerSessionKeyGuard (Phase 6, post-submission).
 *
 * Reads the existing standalone deployment (deployments/<network>_standalone.json)
 * for the ArcIDBond address, deploys the guard pointed at it, and saves
 * deployments/<network>_session_guard.json.
 *
 * By default this does NOT touch ArcIDBond.authorizedSlasher — the guard is
 * deployed inert so an existing running demo isn't disrupted mid-flight.
 * Set ACTIVATE_SESSION_GUARD=true to also call
 * ArcIDBond.setAuthorizedSlasher(guardAddress) in the same run, making the
 * guard (not the raw deployer/consumer EOA) the sole slash/settlement
 * authority from that point on.
 *
 * Usage:
 *   npm run deploy:session-guard:local
 *   npm run deploy:session-guard:arc
 *   ACTIVATE_SESSION_GUARD=true npm run deploy:session-guard:arc
 */

require("dotenv").config();
const { ethers, network } = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();

  const standaloneFile = path.resolve(__dirname, `../deployments/${network.name}_standalone.json`);
  if (!fs.existsSync(standaloneFile)) {
    throw new Error(
      `Missing ${standaloneFile} — run \`npm run deploy:standalone\` (or :local) first.`
    );
  }
  const standalone = JSON.parse(fs.readFileSync(standaloneFile, "utf8"));
  const bondAddress = standalone.addresses.ArcIDBond;

  console.log(`\n${"─".repeat(60)}`);
  console.log("ConsumerSessionKeyGuard — Phase 6 Deploy (post-submission)");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network:   ${network.name}`);
  console.log(`Deployer:  ${deployer.address}  (guard owner)`);
  console.log(`ArcIDBond: ${bondAddress}`);

  const Guard = await ethers.getContractFactory("ConsumerSessionKeyGuard");
  const guard = await Guard.deploy(bondAddress, deployer.address);
  const guardAddress = await guard.getAddress();
  console.log(`\n✓ ConsumerSessionKeyGuard deployed → ${guardAddress}`);

  let activated = false;
  if (process.env.ACTIVATE_SESSION_GUARD === "true") {
    const bond = await ethers.getContractAt("ArcIDBond", bondAddress);
    console.log(`\n→ ACTIVATE_SESSION_GUARD=true — calling setAuthorizedSlasher(${guardAddress})...`);
    const tx = await bond.setAuthorizedSlasher(guardAddress);
    await tx.wait();
    activated = true;
    console.log(`✓ ArcIDBond.authorizedSlasher is now the guard.`);
    console.log(`  The old CONSUMER_PRIVATE_KEY EOA no longer has direct slash/settlement authority.`);
    console.log(`  Next: npm run session:grant -- --owner-key <deployer-key> --session-key <consumer-key> --payout <consumer-address> --network ${network.name}`);
  } else {
    console.log(`\n  Guard deployed but NOT activated (ACTIVATE_SESSION_GUARD unset).`);
    console.log(`  ArcIDBond.authorizedSlasher is unchanged — existing consumer flow keeps working.`);
    console.log(`  To activate: ACTIVATE_SESSION_GUARD=true npm run deploy:session-guard:${network.name === "hardhat" ? "local" : network.name === "arcTestnet" ? "arc" : "node"}`);
    console.log(`  (or call bond.setAuthorizedSlasher(${guardAddress}) directly once ready)`);
  }

  const deployDir = path.resolve(__dirname, "..", "deployments");
  if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir);

  const out = {
    network:      network.name,
    deployedAt:   new Date().toISOString(),
    guardAddress,
    bondAddress,
    owner:        deployer.address,
    activated,
  };
  const outPath = path.join(deployDir, `${network.name}_session_guard.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[saved] ${outPath}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
