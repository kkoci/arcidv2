"use strict";
/**
 * demo-dispute-owner-override.js — Phase 6.4 (post-submission, arcid2
 * Phase 6 — see CHANGELOG.md). Files an indictment, then uses Phase 6.3's
 * dispute:resolve CLI to REJECT it before the deadline — confirms no slash
 * occurs and the bond is untouched.
 *
 * KNOWN GAP, worked around here rather than silently papered over:
 * scripts/cli/dispute-resolve.js requires DEPLOYER_PRIVATE_KEY, which is
 * currently stale relative to actual on-chain ownership — root .env's
 * DEPLOYER_PRIVATE_KEY still resolves to the ORIGINAL deployer wallet, not
 * the wallet ownership was transferred to during Phase 6.4's redeploy
 * (0xA6622e...0085, which also happens to be CONSUMER_PRIVATE_KEY). Passed
 * as a spawn-time env override below — NOT written to any .env file, so
 * this doesn't silently duplicate a key at rest. See CHANGELOG.md.
 */

const { ethers } = require("ethers");
const path = require("path");
const { execFileSync } = require("child_process");
const { getBond, withScaledChallengeParams, runConsumerCycle, DISPUTE_STATE } = require("./_disputeDemoLib");
const config = require("../src/config");

const LOW_THRESHOLD = 10_000n; // $0.01
const DISPUTE_RESOLVE_CLI = path.join(__dirname, "..", "..", "scripts", "cli", "dispute-resolve.js");

async function main() {
  console.log("\n=== demo:dispute-owner-override ===");
  console.log("Goal: an indictment REJECTED by the interim owner via the dispute:resolve CLI");
  console.log("before its deadline must not slash — the bond must be left exactly as it was.\n");

  await withScaledChallengeParams({ threshold: LOW_THRESHOLD }, async () => {
    const provider = config.getProvider();
    const bond = getBond(provider);

    const record = runConsumerCycle("bad-price");
    if (record.slash_route !== "dispute" || !record.dispute_id) {
      throw new Error(`Expected a dispute to be filed, got route="${record.slash_route}" dispute_id=${record.dispute_id}`);
    }
    const disputeId = record.dispute_id;

    const bondBefore = await bond.bonds(config.ORACLE_WALLET_ADDRESS);
    console.log(`\n  Filed disputeId=${disputeId}. Oracle bond before: ${ethers.formatUnits(bondBefore.amount, 6)} USDC`);
    console.log(`\n  → npm run dispute:resolve -- --id ${disputeId} --reject --network arcTestnet`);

    execFileSync(
      "node",
      [DISPUTE_RESOLVE_CLI, "--id", String(disputeId), "--reject", "--network", "arcTestnet"],
      {
        cwd: path.dirname(DISPUTE_RESOLVE_CLI),
        input: "yes\n",
        env: { ...process.env, DEPLOYER_PRIVATE_KEY: config.CONSUMER_PRIVATE_KEY },
        stdio: ["pipe", "inherit", "inherit"],
      }
    );

    const dAfter = await bond.disputes(disputeId);
    const bondAfter = await bond.bonds(config.ORACLE_WALLET_ADDRESS);

    console.log(`\n✓ Verified independently on-chain:`);
    console.log(`  state: ${DISPUTE_STATE[Number(dAfter.state)]}`);
    console.log(`  Oracle bond: ${ethers.formatUnits(bondBefore.amount, 6)} -> ${ethers.formatUnits(bondAfter.amount, 6)} USDC (must be unchanged)`);

    if (Number(dAfter.state) !== 2) throw new Error(`Expected dispute state Resolved, got ${DISPUTE_STATE[Number(dAfter.state)]}`);
    if (bondAfter.amount !== bondBefore.amount) throw new Error("Bond amount changed — a rejection must never move funds");

    console.log(`\n✓ demo:dispute-owner-override PASSED — owner rejection correctly blocked the slash; bond untouched.\n`);
  });
}

main().catch((e) => {
  console.error("\n✗ DEMO FAILED:", e.message, "\n");
  process.exit(1);
});
