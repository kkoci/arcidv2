"use strict";
/**
 * demo-large-semantic-breach.js — Phase 6.4 (post-submission, arcid2 Phase
 * 6 — see CHANGELOG.md). Proves a semantic breach whose amount exceeds
 * challengeThreshold routes to fileIndictment() instead of executing an
 * instant slash().
 *
 * Demo-scaling, documented honestly per the original Phase 6.4 spec: the
 * real oracle bond ($5.00) and real slash economics (1% semanticCapBps,
 * $0.001 service fee) only ever produce a ~$0.05 semantic slash — nowhere
 * near the $1.00 default threshold. Rather than inflate the bond size or
 * the slash-amount formula itself (which would misrepresent the real
 * economics), this demo temporarily LOWERS challengeThreshold to $0.01 —
 * the one parameter whose entire purpose is "what counts as large enough
 * to dispute" — runs the real breach, then restores the threshold back to
 * whatever it was. See _disputeDemoLib.js's withScaledChallengeParams().
 */

const { ethers } = require("ethers");
const { getBond, withScaledChallengeParams, runConsumerCycle, DISPUTE_STATE } = require("./_disputeDemoLib");
const config = require("../src/config");

const LOW_THRESHOLD = 10_000n; // $0.01 — below the oracle's current ~$0.05 semantic amount

async function main() {
  console.log("\n=== demo:large-semantic-breach ===");
  console.log("Goal: a semantic breach whose amount exceeds challengeThreshold must route to");
  console.log("fileIndictment() (held pending dispute), not slash() (instant execution).\n");

  await withScaledChallengeParams({ threshold: LOW_THRESHOLD }, async () => {
    const record = runConsumerCycle("bad-price");

    if (record.slash_route !== "dispute") {
      throw new Error(`Expected route="dispute", got "${record.slash_route}" — did not cross the (lowered) threshold as expected`);
    }
    if (!record.dispute_id) {
      throw new Error("route=dispute but no dispute_id was captured — the indictment may not have actually landed");
    }

    // Independent on-chain verification — never trust the script's own log record alone.
    const bond = getBond(config.getProvider());
    const d = await bond.disputes(record.dispute_id);

    console.log(`\n✓ Verified independently on-chain:`);
    console.log(`  disputeId:     ${record.dispute_id}`);
    console.log(`  state:         ${DISPUTE_STATE[Number(d.state)]}`);
    console.log(`  claimAmount:   ${ethers.formatUnits(d.claimAmount, 6)} USDC`);
    console.log(`  rationaleHash: ${d.rationaleHash}`);

    if (Number(d.state) !== 1) throw new Error(`Expected dispute state Indicted, got ${DISPUTE_STATE[Number(d.state)]}`);

    console.log(`\n✓ demo:large-semantic-breach PASSED.`);
    console.log(`  disputeId ${record.dispute_id} is left open — resolve it with:`);
    console.log(`  npm run dispute:resolve -- --id ${record.dispute_id} --approve|--reject --network arcTestnet\n`);
  });
}

main().catch((e) => {
  console.error("\n✗ DEMO FAILED:", e.message, "\n");
  process.exit(1);
});
