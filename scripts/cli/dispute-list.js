"use strict";
/**
 * dispute-list.js — List disputes on ArcIDBond (Phase 6.3, post-submission
 * — see CHANGELOG.md).
 *
 * Usage:
 *   npm run dispute:list [-- --network arcTestnet] [-- --all]
 *
 * Reads nextDisputeId and loops disputes(1..nextDisputeId) directly — no
 * event-log pagination needed, since disputeId is a simple incrementing
 * counter and disputes() is a public mapping getter (unlike list-agents.js,
 * which has to paginate AgentRegistered events).
 *
 * By default shows only open (Indicted) disputes — the ones that actually
 * need the interim resolver's attention. --all also shows Resolved ones.
 *
 * For each dispute, tries to find the original Claude rationale + evidence
 * from the consumer agent's own per-cycle logs (see _disputeLookup.js) —
 * the on-chain record only ever stores rationaleHash, never the full text.
 *
 * Read-only — no private key required.
 */

const {
  parseArgs,
  loadDeployment,
  getProvider,
  getContracts,
  formatUSDC,
  formatTimestamp,
} = require("./_lib");
const { findOffChainRecord, DISPUTE_STATE } = require("./_disputeLookup");

async function main() {
  const args    = parseArgs();
  const network = args.network || "arcTestnet";
  const showAll = !!args.all;

  const provider = getProvider(network);
  const deploy   = loadDeployment(network);
  const { bond } = getContracts(deploy.addresses, provider);

  const total = await bond.nextDisputeId();

  console.log(`\n→ Disputes on ${network}`);
  console.log(`  ArcIDBond:    ${deploy.addresses.ArcIDBond}`);
  console.log(`  Total filed:  ${total}${showAll ? "" : "  (showing open only — pass --all for resolved too)"}\n`);

  if (total === 0n) {
    console.log("  No disputes filed yet.\n");
    return;
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  let shown = 0;

  for (let id = 1n; id <= total; id++) {
    const d = await bond.disputes(id);
    const state = DISPUTE_STATE[Number(d.state)];
    if (!showAll && state !== "Indicted") continue;
    shown++;

    const isOpen = state === "Indicted";
    const deadlinePassed = nowSeconds >= d.challengeDeadline;

    console.log(`  ── Dispute #${id} ${isOpen ? "🟡 OPEN" : "⚪ RESOLVED"} ${"─".repeat(40)}`);
    console.log(`     Provider:      ${d.provider}`);
    console.log(`     Consumer:      ${d.consumer}`);
    console.log(
      `     Claim amount:  ${formatUSDC(d.claimAmount)}` +
      `  (at indictment time — resolveDispute()/finalizeExpiredDispute() recompute fresh, this may not be what actually transfers)`
    );
    console.log(
      `     Deadline:      ${formatTimestamp(d.challengeDeadline)}` +
      (isOpen ? (deadlinePassed ? "  ⏰ PASSED — eligible for finalizeExpiredDispute()" : "  (window still open)") : "")
    );
    console.log(`     RationaleHash: ${d.rationaleHash}`);

    const offChain = findOffChainRecord(id);
    if (offChain) {
      console.log(`     Rationale:     ${offChain.reason}`);
      if (Array.isArray(offChain.evidence) && offChain.evidence.length > 0) {
        for (const e of offChain.evidence) {
          console.log(`       [${e.category}] ${e.claim}`);
        }
      }
    } else {
      console.log(`     Rationale:     (not found in local consumer/logs/*.jsonl — verify independently against the hash above)`);
    }
    console.log();
  }

  if (shown === 0) {
    console.log(`  No ${showAll ? "" : "open "}disputes.\n`);
  }
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
