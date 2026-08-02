#!/usr/bin/env node
"use strict";
/**
 * demo-erc8183-job.js — Phase 8.3 (post-submission — see CHANGELOG.md).
 *
 * One live, concrete ERC-8183 job cycle: a genuinely separate, higher-value
 * "premium oracle analysis" service ($0.05 default — 50x the existing
 * $0.001 price feed), sold through Arc's real job/escrow/evaluator contract
 * (AgenticCommerce, proxy at 0x0747EEf0706327138c69792bF28Cd525089e4583 on
 * Arc Testnet) instead of x402/Nanopayments. The existing price feed is
 * completely untouched — one real payment per mechanism, matched to the
 * transaction's actual value, never two payments for the same call.
 *
 * Composition, not duplication: this script owns none of the escrow/settle
 * logic — that's AgenticCommerce's job. It owns the TRUST DECISION
 * underneath it: the evaluator step (played by the consumer wallet) checks
 * arcid2's existing bond/verdict state — isActiveBondedAgent(), signature
 * validity, timestamp freshness, deliverable-hash integrity — to decide
 * complete() (release escrow) or reject() (refund) and, on a confirmed hard
 * breach specifically, ALSO calls arcid2's existing ArcIDBond.slash() — a
 * SEPARATE pool of funds (the oracle's bond collateral) reacting to the
 * same breach, not a second payment for the same job.
 *
 * Roles (both wallets controlled by this project, same as every other demo
 * command in this repo — not a real third-party oracle):
 *   - provider   = oracle wallet   (oracle/.env's ORACLE_PRIVATE_KEY)
 *   - client     = consumer wallet (consumer/.env's CONSUMER_PRIVATE_KEY) — creates + funds the job
 *   - evaluator  = consumer wallet (same address) — arcid2's own adjudicator plays both roles,
 *                  same as the existing x402/Gateway flow already does
 *
 * Usage:
 *   npm run demo:premium-job                 # clean path — expect complete()
 *   npm run demo:premium-job -- --fault bad-sig   # reject() + bond.slash() composition path
 *
 * Requires the oracle running locally (npm start in oracle/) — this script
 * HTTP-fetches the actual analysis payload from it, same as
 * demo:hard-breach/demo:semantic-breach already do for the price feed.
 */

const path = require("path");
const { ethers } = require("ethers");
const { parseArgs, getProvider, normalizePrivateKey } = require("./_lib");

const AGENTIC_COMMERCE_ADDRESS = "0x0747EEf0706327138c69792bF28Cd525089e4583"; // Arc Testnet, real, not ours
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

const AGENTIC_COMMERCE_ABI = [
  "function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook) external returns (uint256)",
  "function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external",
  "function fund(uint256 jobId, bytes calldata optParams) external",
  "function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external",
  "function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external",
  "function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external",
  "function getJob(uint256 jobId) external view returns (tuple(uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook))",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
  "event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)",
  "event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)",
  "event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)",
  "event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount)",
  "event Refunded(uint256 indexed jobId, address indexed client, uint256 amount)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const BOND_ABI = [
  "function slash(address agent, address consumer, string calldata reason, uint8 breachClass) external",
  "function isActiveBondedAgent(address agent) external view returns (bool)",
  "event AgentSlashed(address indexed agent, address indexed consumer, uint256 amount, string reason)",
];

const JOB_STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const MAX_ANALYSIS_AGE_SECONDS = 60; // generous — this is a scripted demo, not a live SLA

function findEvent(iface, receipt, name) {
  return receipt.logs
    .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === name);
}

async function main() {
  const args = parseArgs();
  const faultMode = args.fault || null;
  const network = args.network || "arcTestnet";

  // Load both .env files explicitly — this script plays both the oracle
  // (provider) and consumer (client/evaluator) roles, same dual-load
  // pattern as register-8004-identity.js.
  require("dotenv").config({ path: path.join(__dirname, "../../oracle/.env") });
  const oracleKey = normalizePrivateKey(process.env.ORACLE_PRIVATE_KEY);
  const oracleWalletAddress = process.env.ORACLE_WALLET_ADDRESS;
  const premiumPriceUsdc = process.env.PREMIUM_PRICE_USDC || "0.05";
  const oracleUrl = "http://localhost:3001";

  require("dotenv").config({ path: path.join(__dirname, "../../consumer/.env"), override: true });
  const consumerKey = normalizePrivateKey(process.env.CONSUMER_PRIVATE_KEY);
  const consumerWalletAddress = process.env.CONSUMER_WALLET_ADDRESS;
  const bondAddress = process.env.BOND_CONTRACT_ADDRESS;

  const provider = getProvider(network);
  const oracleSigner   = new ethers.Wallet(oracleKey, provider);
  const consumerSigner = new ethers.Wallet(consumerKey, provider);

  const jobAsProvider = new ethers.Contract(AGENTIC_COMMERCE_ADDRESS, AGENTIC_COMMERCE_ABI, oracleSigner);
  const jobAsClient   = new ethers.Contract(AGENTIC_COMMERCE_ADDRESS, AGENTIC_COMMERCE_ABI, consumerSigner);
  const usdcAsClient  = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, consumerSigner);
  const bond          = new ethers.Contract(bondAddress, BOND_ABI, consumerSigner);
  const iface         = new ethers.Interface(AGENTIC_COMMERCE_ABI);

  const budgetAtomic = BigInt(Math.round(parseFloat(premiumPriceUsdc) * 1e6));

  console.log(`\n${"─".repeat(70)}`);
  console.log("ERC-8183 premium job flow — Phase 8.3 (post-submission)");
  console.log(`${"─".repeat(70)}`);
  console.log(`Provider (oracle):    ${oracleWalletAddress}`);
  console.log(`Client/Evaluator:     ${consumerWalletAddress}`);
  console.log(`Budget:               $${premiumPriceUsdc} USDC (${budgetAtomic} atomic)`);
  console.log(`Fault mode:           ${faultMode || "none (clean path)"}`);

  // ── 1. createJob() — client (consumer) ──────────────────────────────────
  const expiredAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour — well past the 5-minute minimum
  console.log(`\n[1/8] createJob(provider, evaluator=self, expiredAt, description, hook=0x0)...`);
  let tx = await jobAsClient.createJob(
    oracleWalletAddress, consumerWalletAddress, expiredAt,
    "arcid2 premium oracle analysis", ethers.ZeroAddress
  );
  let receipt = await tx.wait();
  const created = findEvent(iface, receipt, "JobCreated");
  if (!created) throw new Error("JobCreated event not found — createJob may have failed silently");
  const jobId = created.args.jobId;
  console.log(`      jobId = ${jobId}  (tx: ${receipt.hash})`);

  // ── 2. setBudget() — provider (oracle) ──────────────────────────────────
  console.log(`\n[2/8] setBudget(${jobId}, ${budgetAtomic}, "0x")...`);
  tx = await jobAsProvider.setBudget(jobId, budgetAtomic, "0x");
  await tx.wait();
  console.log(`      done`);

  // ── 3. approve + fund() — client (consumer) ─────────────────────────────
  console.log(`\n[3/8] Approving USDC + fund()...`);
  const allowance = await usdcAsClient.allowance(consumerWalletAddress, AGENTIC_COMMERCE_ADDRESS);
  if (allowance < budgetAtomic) {
    tx = await usdcAsClient.approve(AGENTIC_COMMERCE_ADDRESS, budgetAtomic);
    await tx.wait();
    console.log(`      approved ${budgetAtomic} USDC`);
  }
  tx = await jobAsClient.fund(jobId, "0x");
  receipt = await tx.wait();
  console.log(`      funded — tx: ${receipt.hash}`);

  // ── 4. Oracle generates + signs the premium analysis ────────────────────
  console.log(`\n[4/8] Oracle generating + signing premium analysis (live HTTP call to ${oracleUrl})...`);
  const genRes = await fetch(`${oracleUrl}/api/premium-analysis`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: jobId.toString(), fault: faultMode }),
  });
  if (!genRes.ok) throw new Error(`Oracle /api/premium-analysis failed: ${genRes.status} ${await genRes.text()}`);
  const { deliverableHash } = await genRes.json();
  console.log(`      deliverableHash = ${deliverableHash}`);

  // ── 5. submit() — provider (oracle) ─────────────────────────────────────
  console.log(`\n[5/8] submit(${jobId}, deliverableHash, "0x")...`);
  tx = await jobAsProvider.submit(jobId, deliverableHash, "0x");
  receipt = await tx.wait();
  console.log(`      submitted — tx: ${receipt.hash}`);

  // ── 6. Evaluator (consumer) fetches + verifies ──────────────────────────
  console.log(`\n[6/8] Evaluator fetching delivered analysis + running arcid2's own checks...`);
  const fetchRes = await fetch(`${oracleUrl}/api/premium-analysis/${jobId}`);
  const payload = await fetchRes.json();
  console.log(`      payload: value=${payload.value} trend=${payload.trend} sma=${payload.sma} volatilityBps=${payload.volatilityBps}`);

  const recomputedHash = ethers.solidityPackedKeccak256(
    ["string", "uint256", "string", "string", "uint256"],
    [String(payload.value), BigInt(payload.timestamp), payload.trend, String(payload.sma), BigInt(payload.volatilityBps)]
  );
  const hashMatches = recomputedHash === deliverableHash;

  let sigValid = false, recoveredSigner = null;
  try {
    recoveredSigner = ethers.verifyMessage(ethers.getBytes(recomputedHash), payload.signature);
    sigValid = recoveredSigner.toLowerCase() === oracleWalletAddress.toLowerCase();
  } catch (err) { recoveredSigner = `verify threw: ${err.message}`; }

  const ageSeconds = Math.floor(Date.now() / 1000) - payload.timestamp;
  const isFresh = ageSeconds <= MAX_ANALYSIS_AGE_SECONDS;

  const bondActive = await bond.isActiveBondedAgent(oracleWalletAddress);

  console.log(`      hash matches on-chain deliverable: ${hashMatches}`);
  console.log(`      signature valid (recovered ${recoveredSigner}): ${sigValid}`);
  console.log(`      age fresh (${ageSeconds}s): ${isFresh}`);
  console.log(`      oracle bond active: ${bondActive}`);

  const accept = hashMatches && sigValid && isFresh && bondActive;
  // A bad signature or hash mismatch is a HARD (deterministic, mechanical)
  // breach — same classification the real consumer flow already uses for
  // sig-invalid/schema failures — not a judgment call, so it's the one that
  // also triggers arcid2's existing slash path below.
  const isHardBreach = !hashMatches || !sigValid;

  // ── 7. complete() or reject() — evaluator (consumer) ────────────────────
  const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(
    accept
      ? "arcid2 evaluator: signature valid, hash matches, fresh, oracle bond active — accepted"
      : `arcid2 evaluator: rejected — hashMatches=${hashMatches} sigValid=${sigValid} fresh=${isFresh} bondActive=${bondActive}`
  ));

  if (accept) {
    console.log(`\n[7/8] ACCEPT — complete(${jobId}, reasonHash, "0x")...`);
    tx = await jobAsClient.complete(jobId, reasonHash, "0x");
    receipt = await tx.wait();
    const released = findEvent(iface, receipt, "PaymentReleased");
    const evalFee  = findEvent(iface, receipt, "EvaluatorFeePaid");
    console.log(`      completed — tx: ${receipt.hash}`);
    if (released) console.log(`      PaymentReleased: ${released.args.amount} to provider`);
    if (evalFee)  console.log(`      EvaluatorFeePaid: ${evalFee.args.amount} to evaluator`);
  } else {
    console.log(`\n[7/8] REJECT — reject(${jobId}, reasonHash, "0x")...`);
    tx = await jobAsClient.reject(jobId, reasonHash, "0x");
    receipt = await tx.wait();
    const refunded = findEvent(iface, receipt, "Refunded");
    console.log(`      rejected — tx: ${receipt.hash}`);
    if (refunded) console.log(`      Refunded: ${refunded.args.amount} to client`);

    if (isHardBreach) {
      console.log(`\n      Hard breach confirmed — ALSO triggering arcid2's existing bond.slash()`);
      console.log(`      (a SEPARATE pool of funds — the oracle's bond collateral — reacting to`);
      console.log(`       this breach, not a second payment for this same job)`);
      const slashTx = await bond.slash(oracleWalletAddress, consumerWalletAddress,
        `ERC-8183 premium job #${jobId}: ${reasonHash}`, 1 /* BreachClass.Hard */);
      const slashReceipt = await slashTx.wait();
      const slashed = findEvent(new ethers.Interface(BOND_ABI), slashReceipt, "AgentSlashed");
      console.log(`      slash tx: ${slashReceipt.hash}`);
      if (slashed) console.log(`      AgentSlashed: ${slashed.args.amount} transferred to consumer`);
    } else {
      console.log(`\n      Not a hard breach (freshness or bond-active failure only) — no slash triggered.`);
    }
  }

  // ── 8. Final state ───────────────────────────────────────────────────────
  const finalJob = await jobAsClient.getJob(jobId);
  console.log(`\n[8/8] Final job status: ${JOB_STATUS[Number(finalJob.status)]}`);
  console.log(`${"─".repeat(70)}\n`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
