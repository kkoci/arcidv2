/**
 * erc8004.js — Off-chain, EOA-direct write to Arc's real ERC-8004
 * ReputationRegistry (Phase 8.2, post-submission — see CHANGELOG.md).
 *
 * WHY THIS EXISTS INSTEAD OF AN ON-CHAIN DUAL-WRITE: ArcIDBond gained a
 * reputationAdapter hook (contracts/ERC8004ReputationAdapter.sol) that would
 * call ReputationRegistry.giveFeedback() in the SAME transaction as a
 * slash/settlement — the originally-intended design, "dual-write, not a
 * separate opinion." Live-verified against Arc's real, already-deployed
 * ReputationRegistry (0x8004B663056A597Dffe9eCcC1965A193B7388713) and found
 * it rejects contract-relayed calls: a direct EOA call to giveFeedback()
 * succeeds and produces a real, externally-readable feedback entry; the
 * IDENTICAL call routed through a contract (ArcIDBond -> adapter ->
 * registry) reverts. Neither the EIP text nor Arc's tutorial documents this
 * — confirmed empirically (see CHANGELOG.md's Phase 8.2 entry for the full
 * evidence chain), not assumed. So: the on-chain adapter stays deployed and
 * wired (harmless — every call try/catches into a silent no-op today,
 * forward-looking if Arc ever relaxes this), and THIS file is what actually
 * produces real feedback entries — the consumer's own EOA (the same key
 * that already calls slash()/recordSettlement()) sends a second, separate
 * transaction directly to the real registry right after the first confirms.
 *
 * ATOMICITY TRADE-OFF, stated plainly: this is now two separate
 * transactions, not one. They CAN diverge — the slash/settlement can
 * succeed while this second write fails, or the process can crash in
 * between. That's a real regression from the on-chain design's original
 * goal. What this file does about it: every attempt writes a durable
 * "pending" ledger entry BEFORE sending the tx (so a crash between the two
 * steps leaves a detectable trace, not silence), updates it to
 * "confirmed"/"failed" afterward, and a startup check
 * (checkForOrphanedWrites()) surfaces any entry still stuck "pending" from
 * a prior crashed run. A failed or orphaned write is logged loudly to its
 * own channel (erc8004_failures.jsonl) — visible and traceable, matching
 * this project's existing failure-isolation convention (slash_failures,
 * settlement_failures, deterministic_breaches — each failure class gets its
 * own log, never silently merged).
 *
 * Value scale, agentId-skip behavior, and tag conventions are identical to
 * ERC8004ReputationAdapter.sol's Solidity math — see that contract's own
 * docstring for the reasoning. Kept in sync by hand (two different
 * languages, no shared source) — if the on-chain scale ever changes, this
 * file needs the same change made deliberately, not assumed to follow.
 */

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("./config");

const REPUTATION_REGISTRY_ARC_TESTNET = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const REGISTRY_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external",
];

const LEDGER_PATH      = path.join(path.resolve(config.LOG_DIR), "erc8004_ledger.json");
const FAILURE_LOG_PATH = path.join(path.resolve(config.LOG_DIR), "erc8004_failures.jsonl");

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function logFailure(record) {
  try {
    fs.mkdirSync(path.dirname(FAILURE_LOG_PATH), { recursive: true });
    fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
  } catch (err) {
    console.error(`  [erc8004] WARNING: failed to write failure log: ${err.message}`);
  }
}

/**
 * Startup check (Phase 8.2's reconciliation safeguard): scan the ledger for
 * any entry still marked "pending" — meaning a prior run wrote the
 * before-the-tx marker and then crashed (or was killed) before recording an
 * outcome. Marks each as "orphaned" (a distinct terminal state from
 * "failed" — we genuinely don't know if the tx landed, and don't guess) and
 * logs it loudly. Call once, at process start, before the main loop begins.
 */
function checkForOrphanedWrites() {
  const ledger = loadLedger();
  let orphanCount = 0;

  for (const [verdictHash, entry] of Object.entries(ledger)) {
    if (entry.status !== "pending") continue;
    orphanCount++;
    entry.status = "orphaned";
    entry.orphanedAt = new Date().toISOString();
    logFailure({
      verdictHash, agentWallet: entry.agentWallet, agentId: entry.agentId,
      stage: "orphaned-on-startup",
      error: "Prior run wrote this pending entry and never recorded an outcome — process likely crashed or was killed mid-write. Whether the on-chain tx actually landed is unknown; check manually against the registry.",
    });
  }

  if (orphanCount > 0) {
    saveLedger(ledger);
    console.warn(`  [erc8004] WARNING: ${orphanCount} orphaned reputation write(s) found from a prior run — see ${FAILURE_LOG_PATH}`);
  }

  return orphanCount;
}

/**
 * Report one outcome to Arc's real ERC-8004 ReputationRegistry, direct from
 * the consumer's own EOA. Never throws — a failure here must never affect
 * the caller's own success/failure state (the slash/settlement already
 * happened on-chain by the time this is called).
 *
 * @param {object} params
 * @param {string} params.agentWallet   The oracle wallet being rated.
 * @param {boolean} params.wasSlash     true = slash outcome, false = clean settlement.
 * @param {bigint|null} [params.amountSlashed]   Required if wasSlash.
 * @param {bigint|null} [params.bondBeforeSlash] Required if wasSlash.
 * @param {boolean} [params.isHard]     BreachClass.Hard vs Semantic — tag2 only.
 * @param {string} params.evidenceHash  bytes32 hex — same hash written on-chain
 *                                      for this event (keccak256(reason) for an
 *                                      instant slash, the dispute's rationaleHash,
 *                                      or settlement.js's verdictHash()).
 * @returns {Promise<{written: boolean, txHash: string|null, skipped: string|null, error: string|null}>}
 */
async function reportToERC8004({ agentWallet, wasSlash, amountSlashed, bondBeforeSlash, isHard, evidenceHash }) {
  if (!config.ORACLE_AGENT_ID_8004) {
    return { written: false, txHash: null, skipped: "ORACLE_AGENT_ID_8004 not set", error: null };
  }
  if (!evidenceHash) {
    return { written: false, txHash: null, skipped: "no evidenceHash available for this outcome", error: null };
  }

  const ledger = loadLedger();
  const existing = ledger[evidenceHash];
  if (existing && existing.status === "confirmed") {
    return { written: false, txHash: existing.txHash, skipped: "already confirmed for this verdictHash", error: null };
  }

  const agentId = config.ORACLE_AGENT_ID_8004;
  const value = wasSlash
    ? (bondBeforeSlash === 0n ? -100n : -(amountSlashed * 100n / bondBeforeSlash))
    : 100n;
  const tag2 = wasSlash ? (isHard ? "hard" : "semantic") : "settlement";
  const feedbackURI = `${config.ORACLE_URL}/api/verdict/${evidenceHash}`;

  // Written BEFORE the tx is sent — this is the crash-safety tripwire. If the
  // process dies right after this line, checkForOrphanedWrites() will catch
  // it on next startup instead of the divergence going unnoticed forever.
  ledger[evidenceHash] = {
    status: "pending", agentWallet, agentId, value: value.toString(), tag2,
    attemptedAt: new Date().toISOString(), txHash: null,
  };
  saveLedger(ledger);

  try {
    const provider = config.getProvider();
    const signer   = new ethers.Wallet(config.CONSUMER_PRIVATE_KEY, provider);
    const registry = new ethers.Contract(REPUTATION_REGISTRY_ARC_TESTNET, REGISTRY_ABI, signer);

    const tx = await registry.giveFeedback(
      agentId, value, 0, "arcid2", tag2, "arcid2:ArcIDBond", feedbackURI, evidenceHash
    );
    const receipt = await tx.wait();

    ledger[evidenceHash].status = "confirmed";
    ledger[evidenceHash].txHash = receipt.hash;
    ledger[evidenceHash].confirmedAt = new Date().toISOString();
    saveLedger(ledger);

    return { written: true, txHash: receipt.hash, skipped: null, error: null };
  } catch (err) {
    ledger[evidenceHash].status = "failed";
    ledger[evidenceHash].error  = err.message;
    saveLedger(ledger);
    logFailure({ verdictHash: evidenceHash, agentWallet, agentId, stage: "giveFeedback", error: err.message });

    return { written: false, txHash: null, skipped: null, error: err.message };
  }
}

module.exports = { reportToERC8004, checkForOrphanedWrites };
