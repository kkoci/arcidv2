"use strict";
/**
 * dispute-resolve.js — Resolve a pending dispute as the interim owner
 * resolver (Phase 6.3, post-submission — see CHANGELOG.md).
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=... in .env (the contract's Ownable owner — see
 *   CLAUDE.md's private-key rule: never a CLI argument), then:
 *   npm run dispute:resolve -- --id <disputeId> --approve|--reject [--network arcTestnet]
 *
 * Prints the full stored dispute state AND, if found locally, the original
 * Claude rationale + evidence (see _disputeLookup.js) BEFORE asking for
 * interactive confirmation — the interim "manual review" this phase's
 * design doc calls for is meant to be an actual review of the evidence,
 * not a rubber stamp on a bare disputeId. Aborts on anything other than a
 * typed "yes" — no --yes/--force flag to skip it, deliberately, since the
 * whole point of this tool is that a human looks at the evidence first.
 *
 * resolveDispute() is owner-only on-chain; this script warns but does not
 * block if the key doesn't match — the on-chain call will revert and show
 * the exact error, same posture as slash.js.
 *
 * On approval, previews the amount via previewSlash() first — same
 * pre-flight pattern slash.js uses — so the operator sees the actual
 * on-chain formula's output (and whether it would gracefully void, see
 * ArcIDBond.sol's _executeSlashOrVoid()) before confirming, not just the
 * stale claimAmount captured at indictment time.
 */

const readline = require("readline");
const { ethers } = require("ethers");
const {
  parseArgs,
  requireEnvKey,
  loadDeployment,
  getProvider,
  getContracts,
  formatUSDC,
  formatTimestamp,
} = require("./_lib");
const { findOffChainRecord, DISPUTE_STATE } = require("./_disputeLookup");

const BREACH_CLASS_SEMANTIC = 0; // disputes are semantic-only by construction — see fileIndictment()

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const args = parseArgs();
  const key  = requireEnvKey("DEPLOYER_PRIVATE_KEY");

  const disputeId = args.id;
  const approve = args.approve === true;
  const reject  = args.reject === true;
  if (!disputeId || (!approve && !reject) || (approve && reject)) {
    console.error(
      "\nUsage: npm run dispute:resolve -- --id <disputeId> --approve|--reject [--network arcTestnet]\n"
    );
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(key, provider);
  const deploy   = loadDeployment(network);
  const { bond } = getContracts(deploy.addresses, wallet);

  const owner = await bond.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(
      `\n  WARNING: contract owner is ${owner}` +
        `\n           caller is       ${wallet.address}` +
        `\n           The transaction will revert on-chain.\n`
    );
  }

  const d = await bond.disputes(disputeId);
  const state = DISPUTE_STATE[Number(d.state)];
  if (state !== "Indicted") {
    console.error(`\n✗ Dispute #${disputeId} is not open (state: ${state})\n`);
    process.exit(1);
  }

  console.log(`\n→ Dispute #${disputeId} on ${network}`);
  console.log(`  ArcIDBond:     ${deploy.addresses.ArcIDBond}`);
  console.log(`  Provider:      ${d.provider}`);
  console.log(`  Consumer:      ${d.consumer}`);
  console.log(
    `  Claim amount:  ${formatUSDC(d.claimAmount)}` +
    `  (at indictment time — resolveDispute() recomputes fresh, see preview below)`
  );
  console.log(`  Deadline:      ${formatTimestamp(d.challengeDeadline)}`);
  console.log(`  RationaleHash: ${d.rationaleHash}`);

  const offChain = findOffChainRecord(disputeId);
  if (offChain) {
    console.log(`\n  Rationale (from consumer/logs/*.jsonl):`);
    console.log(`  ${offChain.reason}`);
    if (Array.isArray(offChain.evidence) && offChain.evidence.length > 0) {
      console.log(`  Evidence:`);
      for (const e of offChain.evidence) console.log(`    [${e.category}] ${e.claim}`);
    }
  } else {
    console.log(`\n  ⚠ Rationale not found in local consumer/logs/*.jsonl.`);
    console.log(`    Proceeding without the underlying evidence visible locally — verify the`);
    console.log(`    rationaleHash above against your own record of this interaction before approving.`);
  }

  if (approve) {
    const [amount, wouldEscalate] = await bond.previewSlash(d.provider, BREACH_CLASS_SEMANTIC);
    console.log(`\n  Preview if approved: ${formatUSDC(amount)}${wouldEscalate ? " (ESCALATES — full remaining bond + permanent blacklist)" : ""}`);
    if (amount === 0n) {
      console.log(`  (0 means the agent's bond was already fully slashed by an unrelated event —`);
      console.log(`   this will gracefully void the dispute, not revert. See ArcIDBond.sol's`);
      console.log(`   _executeSlashOrVoid() / CHANGELOG.md's Phase 6.1 stuck-dispute-gap entry.)`);
    }
  }

  const answer = await ask(`\n  ${approve ? "APPROVE" : "REJECT"} dispute #${disputeId}? Type "yes" to confirm: `);
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("\n  Aborted — no on-chain action taken.\n");
    return;
  }

  const tx      = await bond.resolveDispute(disputeId, approve);
  const receipt = await tx.wait();

  const resolvedEvent = receipt.logs
    .map((l) => { try { return bond.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "DisputeResolved");

  console.log(`\n✓ resolveDispute() mined → ${receipt.hash}`);
  if (resolvedEvent) {
    console.log(`  approved:          ${resolvedEvent.args.approved}`);
    console.log(`  amountTransferred: ${formatUSDC(resolvedEvent.args.amountTransferred)}`);
  }
  console.log();
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
