"use strict";
/**
 * breaker.js — Inspect or manually resume the settlement spend-velocity
 * circuit breaker (Phase 8, post-submission — see CHANGELOG.md).
 *
 * The breaker trips itself (settlement.js's checkCircuitBreaker()) — there
 * is deliberately no code path that clears it automatically. Resuming is a
 * human decision: read why it tripped, decide the spend was legitimate or
 * the runaway loop is fixed, then run this.
 *
 * Usage (from consumer/):
 *   npm run breaker:status
 *   npm run breaker:resume -- --reason "confirmed legitimate traffic spike"
 */

const { getCircuitBreakerStatus, resumeCircuitBreaker } = require("../src/settlement");

function fmtUsdc(atomicStr) {
  return (Number(atomicStr) / 1e6).toFixed(6) + " USDC";
}

function printStatus() {
  const status = getCircuitBreakerStatus();
  console.log(`\nCircuit breaker: ${status.tripped ? "🛑 TRIPPED" : "✓ clear"}`);
  if (status.tripped) {
    console.log(`  reason:     ${status.detail.reason}`);
    console.log(`  trippedAt:  ${status.detail.trippedAt}`);
  }
  console.log(`  spend (last 1m): ${fmtUsdc(status.spendLastMinute)}  (cap ${fmtUsdc(status.capPerMinute)})`);
  console.log(`  spend (last 1h): ${fmtUsdc(status.spendLastHour)}  (cap ${fmtUsdc(status.capPerHour)})\n`);
  return status;
}

function main() {
  const args = process.argv.slice(2);
  const action = args.includes("--resume") ? "resume" : "status";
  const reasonIdx = args.indexOf("--reason");
  const reason = reasonIdx !== -1 && args[reasonIdx + 1] ? args[reasonIdx + 1] : "manual resume";

  if (action === "status") {
    printStatus();
    return;
  }

  const status = printStatus();
  if (!status.tripped) {
    console.log("Nothing to resume — breaker is not tripped.\n");
    return;
  }

  const result = resumeCircuitBreaker(reason);
  console.log(`✓ Resumed. reason: "${reason}"`);
  console.log(`  Prior trip: ${result.priorTrip.reason} (at ${result.priorTrip.trippedAt})\n`);
}

main();
