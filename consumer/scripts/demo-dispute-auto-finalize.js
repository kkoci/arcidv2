"use strict";
/**
 * demo-dispute-auto-finalize.js — Phase 6.4 (post-submission, arcid2 Phase
 * 6 — see CHANGELOG.md). Files an indictment, waits past its deadline with
 * no owner action, confirms finalizeExpiredDispute() executes the slash
 * automatically — the "optimistic" default-execute behavior.
 *
 * A REAL wall-clock wait, not Hardhat time-travel — the Hardhat-side
 * version of this exact scenario is already covered by
 * test/ArcIDDispute.test.js's "executes the slash automatically once the
 * deadline passes, callable by anyone" test (evm_increaseTime). This is
 * the live-testnet counterpart the original Phase 6.4 spec calls for.
 *
 * Calls finalizeExpiredDispute() with the CONSUMER's key, not the owner's
 * — deliberately, to concretely demonstrate it really is permissionless
 * rather than merely asserting that in a comment.
 */

const { ethers } = require("ethers");
const { getBond, withScaledChallengeParams, runConsumerCycle, sleep, DISPUTE_STATE } = require("./_disputeDemoLib");
const config = require("../src/config");

const LOW_THRESHOLD = 10_000n; // $0.01
const SHORT_WINDOW  = 30n;     // 30 real seconds
const WAIT_MARGIN_S = 15;      // extra margin past the deadline before finalizing

async function main() {
  console.log("\n=== demo:dispute-auto-finalize ===");
  console.log("Goal: an indictment left unresolved past its deadline auto-executes via");
  console.log("finalizeExpiredDispute() — called here by the CONSUMER wallet, not the owner,");
  console.log("to prove it is genuinely permissionless.\n");

  await withScaledChallengeParams({ threshold: LOW_THRESHOLD, window: SHORT_WINDOW }, async () => {
    const provider = config.getProvider();
    const bond = getBond(provider);

    const record = runConsumerCycle("bad-price");
    if (record.slash_route !== "dispute" || !record.dispute_id) {
      throw new Error(`Expected a dispute to be filed, got route="${record.slash_route}" dispute_id=${record.dispute_id}`);
    }
    const disputeId = record.dispute_id;

    const dBefore = await bond.disputes(disputeId);
    const bondBefore = await bond.bonds(config.ORACLE_WALLET_ADDRESS);
    console.log(`\n  Filed disputeId=${disputeId}, deadline=${new Date(Number(dBefore.challengeDeadline) * 1000).toISOString()}`);
    console.log(`  Oracle bond before: ${ethers.formatUnits(bondBefore.amount, 6)} USDC`);

    const waitSeconds = Number(SHORT_WINDOW) + WAIT_MARGIN_S;
    console.log(`  Waiting ${waitSeconds}s (real wall-clock wait) for the window to pass...`);
    await sleep(waitSeconds * 1000);

    const consumerSigner = new ethers.Wallet(config.CONSUMER_PRIVATE_KEY, provider);
    const tx = await getBond(consumerSigner).finalizeExpiredDispute(disputeId);
    const receipt = await tx.wait();

    const dAfter = await bond.disputes(disputeId);
    const bondAfter = await bond.bonds(config.ORACLE_WALLET_ADDRESS);

    console.log(`\n✓ finalizeExpiredDispute() mined → ${receipt.hash}`);
    console.log(`  state: ${DISPUTE_STATE[Number(dAfter.state)]} (was Indicted)`);
    console.log(`  Oracle bond: ${ethers.formatUnits(bondBefore.amount, 6)} -> ${ethers.formatUnits(bondAfter.amount, 6)} USDC`);

    if (Number(dAfter.state) !== 2) throw new Error(`Expected dispute state Resolved, got ${DISPUTE_STATE[Number(dAfter.state)]}`);
    if (bondAfter.amount >= bondBefore.amount) throw new Error("Expected the bond to shrink — auto-finalization should have executed a real slash");

    console.log(`\n✓ demo:dispute-auto-finalize PASSED — unresolved dispute correctly auto-executed after the deadline via a non-owner caller.\n`);
  });
}

main().catch((e) => {
  console.error("\n✗ DEMO FAILED:", e.message, "\n");
  process.exit(1);
});
