"use strict";
/**
 * _disputeDemoLib.js — Shared helpers for the three Phase 6.4 dispute demo
 * commands (post-submission, arcid2 Phase 6 — see CHANGELOG.md).
 *
 * All three demos need the same three things: an owner-capable signer (to
 * temporarily scale challengeThreshold/disputeWindow for the demo, then
 * restore them), a way to trigger a real semantic breach through the actual
 * consumer code path (not a reimplementation), and a minimal ABI subset.
 */

const fs   = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const config = require("../src/config");

const CONSUMER_DIR = path.join(__dirname, "..");
const LOG_DIR       = path.join(CONSUMER_DIR, "logs");

const BOND_ABI = [
  "function challengeThreshold() view returns (uint256)",
  "function disputeWindow() view returns (uint64)",
  "function setChallengeParameters(uint256 _challengeThreshold, uint64 _disputeWindow) external",
  "function disputes(uint256) view returns (address consumer, address provider, uint256 claimAmount, uint256 challengeDeadline, bytes32 rationaleHash, uint8 state)",
  "function nextDisputeId() view returns (uint256)",
  "function bonds(address) view returns (uint256 amount, uint64 postedAt, bool slashed)",
  "function owner() view returns (address)",
  "function finalizeExpiredDispute(uint256 disputeId) external",
];

const DISPUTE_STATE = ["None", "Indicted", "Resolved"];

function getBond(signerOrProvider) {
  return new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ABI, signerOrProvider);
}

/**
 * consumer/.env's CONSUMER_PRIVATE_KEY happens to currently BE the
 * contract's owner — both roles landed on the same wallet
 * (0xA6622e...0085) during Phase 6.4's redeploy ownership-transfer step
 * (see CHANGELOG.md). Reused here rather than requiring a separate key.
 * This is a coincidence of the current deployment's role assignment, not
 * a structural guarantee — if the owner is ever rotated away from the
 * consumer wallet, these demos' owner-gated calls will start reverting
 * and will need a dedicated key, same as scripts/cli/dispute-resolve.js's
 * DEPLOYER_PRIVATE_KEY (which is ALSO currently stale relative to actual
 * on-chain ownership, for the same underlying reason — see
 * demo-dispute-owner-override.js for how that specific case is handled).
 */
function getOwnerSigner() {
  return new ethers.Wallet(config.CONSUMER_PRIVATE_KEY, config.getProvider());
}

/**
 * Runs `fn` with challengeThreshold/disputeWindow temporarily set to
 * `threshold`/`window` (only the ones actually passed), always restoring
 * to whatever was ACTUALLY on-chain before this call — never a hardcoded
 * assumption of the production default — regardless of whether `fn`
 * succeeds or throws. This is what makes each demo safe to run
 * independently and repeatedly, in any order, without needing to know or
 * assume another demo's parameter state.
 */
async function withScaledChallengeParams({ threshold, window } = {}, fn) {
  const bond = getBond(getOwnerSigner());
  const originalThreshold = await bond.challengeThreshold();
  const originalWindow    = await bond.disputeWindow();

  const targetThreshold = threshold !== undefined ? BigInt(threshold) : originalThreshold;
  const targetWindow    = window    !== undefined ? BigInt(window)    : originalWindow;
  const needsChange = targetThreshold !== originalThreshold || targetWindow !== originalWindow;

  if (needsChange) {
    console.log(`  [demo-scaling] setChallengeParameters(${targetThreshold}, ${targetWindow}) — was (${originalThreshold}, ${originalWindow})`);
    const tx = await bond.setChallengeParameters(targetThreshold, targetWindow);
    await tx.wait();
  }

  try {
    return await fn();
  } finally {
    if (needsChange) {
      console.log(`  [demo-scaling] restoring setChallengeParameters(${originalThreshold}, ${originalWindow})`);
      const tx = await bond.setChallengeParameters(originalThreshold, originalWindow);
      await tx.wait();
    }
  }
}

/**
 * Runs one real consumer cycle by spawning the actual production entry
 * point (`node src/index.js --fault <mode> --once`) — not a
 * reimplementation of the routing/gating logic — and returns the resulting
 * per-cycle record by reading back the log file it wrote. This is what
 * makes these demos genuine live verification of the real code path,
 * matching demo:hard-breach/demo:semantic-breach's existing pattern of
 * being thin aliases over the same entry point.
 */
function runConsumerCycle(faultMode) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const before = new Set(fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl")));

  execFileSync("node", ["src/index.js", "--fault", faultMode, "--once"], {
    cwd: CONSUMER_DIR,
    stdio: "inherit",
  });

  const after = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl"));
  const newFile = after.find((f) => !before.has(f));
  if (!newFile) throw new Error("Could not find the new consumer log file this cycle should have written");

  const lines = fs.readFileSync(path.join(LOG_DIR, newFile), "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error(`Log file ${newFile} was created but has no records`);
  return JSON.parse(lines[lines.length - 1]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  BOND_ABI,
  DISPUTE_STATE,
  getBond,
  getOwnerSigner,
  withScaledChallengeParams,
  runConsumerCycle,
  sleep,
};
