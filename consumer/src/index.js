/**
 * ArcID Consumer Agent — Phase 3
 *
 * Autonomous loop that:
 *   1. Pays $0.001 USDC for each oracle call via x402
 *   2. Verifies the oracle's signed response
 *   3. Passes response to Claude for LLM-reasoned adjudication
 *   4. Slashes the oracle on-chain on confirmed breach
 *   5. Logs every cycle to JSONL for traction reporting
 *
 * Usage:
 *   node src/index.js                     # normal loop (no faults)
 *   node src/index.js --fault stale       # trigger stale fault every cycle
 *   node src/index.js --fault null        # trigger null fault
 *   node src/index.js --fault bad-sig     # trigger bad-sig fault
 *   node src/index.js --cycles 5          # run exactly N cycles then exit
 *   node src/index.js --once              # single cycle then exit
 */

const fs     = require("fs");
const path   = require("path");
const config = require("./config");
const { fetchOraclePrice }      = require("./oracle");
const { verifyOracleSignature } = require("./verifier");
const { adjudicate }            = require("./adjudicator");
const { executeSlash }          = require("./slasher");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args       = process.argv.slice(2);
const faultMode  = argValue(args, "--fault");   // stale | null | bad-sig | null
const maxCycles  = argValue(args, "--cycles") ? parseInt(argValue(args, "--cycles"), 10) : null;
const runOnce    = args.includes("--once");

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logDir  = path.resolve(config.LOG_DIR);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logPath = path.join(logDir, `consumer_${Date.now()}.jsonl`);
const logStream = fs.createWriteStream(logPath, { flags: "a" });

function logCycle(record) {
  logStream.write(JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";

function color(str, c) { return `${c}${str}${RESET}`; }

function printBanner() {
  console.log(`\n${BOLD}ArcID Consumer Agent — Phase 3${RESET}`);
  console.log(`${DIM}Oracle:   ${config.ORACLE_URL}${RESET}`);
  console.log(`${DIM}Oracle wallet: ${config.ORACLE_WALLET_ADDRESS}${RESET}`);
  console.log(`${DIM}Consumer: ${config.CONSUMER_WALLET_ADDRESS}${RESET}`);
  console.log(`${DIM}Bond:     ${config.BOND_CONTRACT_ADDRESS}${RESET}`);
  console.log(`${DIM}Interval: ${config.POLL_INTERVAL_MS / 1000}s | DEV_MODE: ${config.DEV_MODE}${RESET}`);
  if (faultMode) console.log(`${YELLOW}Fault mode: ${faultMode} (every cycle)${RESET}`);
  console.log(`${DIM}Log: ${logPath}${RESET}\n`);
}

function printCycleHeader(n) {
  const ts = new Date().toISOString();
  console.log(`${BOLD}── Cycle #${n} · ${ts} ──────────────────────────────${RESET}`);
}

function printVerdict(verdict) {
  const icon =
    verdict.verdict === "ok"        ? color("✓ OK",        GREEN)  :
    verdict.verdict === "breach"    ? color("✗ BREACH",    RED)    :
                                      color("? UNCERTAIN", YELLOW);
  console.log(`\n  Verdict: ${BOLD}${icon}${RESET}`);
  console.log(`  ${DIM}${verdict.reason}${RESET}`);
  if (verdict.checks) {
    const c = verdict.checks;
    const fmt = (b) => b ? color("✓", GREEN) : color("✗", RED);
    console.log(`  Checks: timestamp_fresh=${fmt(c.timestamp_fresh)}  value_present=${fmt(c.value_present)}  signature_valid=${fmt(c.signature_valid)}`);
  }
}

// ---------------------------------------------------------------------------
// Single cycle
// ---------------------------------------------------------------------------

async function runCycle(cycleNumber) {
  printCycleHeader(cycleNumber);

  const cycleStart = Date.now();
  let record = {
    cycle:       cycleNumber,
    started_at:  new Date().toISOString(),
    fault_mode:  faultMode,
  };

  // ── 1. Fetch oracle response ──────────────────────────────────────────────
  let oracleResponse, paymentAmount;
  try {
    const result = await fetchOraclePrice(faultMode);
    oracleResponse = result.response;
    paymentAmount  = result.paymentAmount;
    console.log(`  Oracle: value=${color(oracleResponse.value, CYAN)}  ts=${oracleResponse.timestamp}  paid=$${paymentAmount}`);
  } catch (err) {
    console.log(`  ${color("Oracle unreachable:", RED)} ${err.message}`);
    record = { ...record, error: err.message, verdict: "uncertain", reason: `Oracle fetch failed: ${err.message}` };
    logCycle(record);
    return record;
  }

  // ── 2. Verify signature ───────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - oracleResponse.timestamp;
  const sigResult = verifyOracleSignature(
    oracleResponse.value,
    oracleResponse.timestamp,
    config.ORACLE_WALLET_ADDRESS,
    oracleResponse.signature
  );

  console.log(`  Age: ${color(`${ageSeconds}s`, ageSeconds > 30 ? RED : GREEN)}  ` +
    `SigValid: ${color(String(sigResult.valid), sigResult.valid ? GREEN : RED)}` +
    (sigResult.error ? `  (${sigResult.error})` : ""));

  // ── 3. LLM adjudication ──────────────────────────────────────────────────
  console.log(`  ${DIM}Adjudicating via ${config.MODEL}...${RESET}`);
  let verdict;
  try {
    verdict = await adjudicate({
      response:      oracleResponse,
      sigValid:      sigResult.valid,
      sigError:      sigResult.error,
      sigRecovered:  sigResult.recovered,
      ageSeconds,
      cycleNumber,
    });
  } catch (err) {
    console.log(`  ${color("Adjudication failed:", RED)} ${err.message}`);
    record = { ...record, error: err.message, verdict: "uncertain", reason: `LLM call failed: ${err.message}` };
    logCycle(record);
    return record;
  }

  printVerdict(verdict);

  // ── 4. Slash on breach ───────────────────────────────────────────────────
  let slashResult = null;
  if (verdict.verdict === "breach" && verdict.should_slash) {
    console.log(`\n  ${RED}${BOLD}→ Slashing oracle...${RESET}`);
    try {
      slashResult = await executeSlash(
        config.ORACLE_WALLET_ADDRESS,
        config.CONSUMER_WALLET_ADDRESS,
        verdict.reason
      );
      if (slashResult.simulated) {
        console.log(`  ${YELLOW}[DEV] Slash simulated (set DEV_MODE=false to slash on-chain)${RESET}`);
      } else if (slashResult.txHash) {
        console.log(`  ${RED}${BOLD}✗ SLASHED — tx: ${slashResult.txHash}${RESET}`);
      }
    } catch (err) {
      console.log(`  ${color("Slash failed:", RED)} ${err.message}`);
    }
  }

  // ── 5. Log + push to oracle API ──────────────────────────────────────────
  const duration = Date.now() - cycleStart;
  record = {
    ...record,
    consumer:        config.CONSUMER_WALLET_ADDRESS,
    oracle_value:    oracleResponse.value,
    oracle_ts:       oracleResponse.timestamp,
    oracle_age_s:    ageSeconds,
    sig_valid:       sigResult.valid,
    sig_error:       sigResult.error,
    payment_usdc:    paymentAmount,
    verdict:         verdict.verdict,
    should_slash:    verdict.should_slash,
    reason:          verdict.reason,
    checks:          verdict.checks,
    slash_tx:        slashResult?.txHash ?? null,
    slash_simulated: slashResult?.simulated ?? false,
    duration_ms:     duration,
  };
  logCycle(record);

  // Push verdict to oracle API so frontend can display it in real-time
  try {
    await fetch(`${config.ORACLE_URL}/api/verdicts`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(record),
    });
  } catch { /* oracle may not be running — non-fatal */ }

  console.log(`  ${DIM}(${duration}ms)${RESET}`);
  return record;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  printBanner();

  let cycleNumber = 1;
  let totalPayments = 0;
  let slashCount    = 0;
  let okCount       = 0;

  while (true) {
    const record = await runCycle(cycleNumber);

    if (record.payment_usdc) totalPayments += record.payment_usdc;
    if (record.verdict === "breach") slashCount++;
    if (record.verdict === "ok")     okCount++;

    cycleNumber++;

    if (runOnce || (maxCycles && cycleNumber > maxCycles)) {
      console.log(`\n${BOLD}── Session Summary ─────────────────────────────────${RESET}`);
      console.log(`  Cycles:       ${cycleNumber - 1}`);
      console.log(`  OK verdicts:  ${color(okCount, GREEN)}`);
      console.log(`  Slashes:      ${color(slashCount, slashCount > 0 ? RED : DIM)}`);
      console.log(`  Total paid:   $${totalPayments.toFixed(4)} USDC`);
      console.log(`  Log:          ${logPath}\n`);
      process.exit(0);
    }

    await sleep(config.POLL_INTERVAL_MS);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
