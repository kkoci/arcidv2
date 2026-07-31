"use strict";
/**
 * chain.js — On-chain reader + trigger-cycle logic for /api/chain-stats
 * and /admin/trigger-cycle.
 *
 * Reads ArcIDBond + ArcIDRegistryV2 events and bond state.
 * Implements the full slash loop: re-bond oracle if needed → generate
 * bad-sig response → Tier 1 deterministic verdict → on-chain slash →
 * recharge oracle.
 *
 * Tiered adjudication, Phase 5 (post-submission — see CHANGELOG.md):
 * triggerCycle() used to run its own separate LLM adjudicator (ported once
 * from consumer/src/adjudicator.js and never kept in sync with Phases 1-2's
 * tiering) over a hardcoded bad-sig fault. bad-sig is a mechanically-
 * checkable signature failure — the real consumer flow never invokes
 * Claude for it (see deterministicVerifier.js), and leaving the LLM call
 * here while also passing BreachClass.Hard to slash() would have written a
 * contradiction on-chain: a Claude-authored reason string paired with a
 * classification that claims no judgment was involved. Removed the local
 * LLM adjudicator entirely — this endpoint now matches real behavior, one
 * fewer Claude call per trigger as a direct consequence, not a separate
 * optimization.
 */

const { ethers }   = require("ethers");
const config       = require("./config");

// BreachClass enum values — must match IArcIDBondSlash.sol exactly
// (Semantic = 0, Hard = 1).
const BREACH_CLASS_HARD = 1;

// ── ABIs ─────────────────────────────────────────────────────────────────────

const BOND_ABI = [
  "function bonds(address) view returns (uint256 amount, uint64 postedAt, bool slashed)",
  "function isActiveBondedAgent(address) view returns (bool)",
  "function postBond(uint256 amount) external",
  "function slash(address agent, address consumer, string calldata reason, uint8 breachClass) external",
  "function authorizedSlasher() view returns (address)",
  "event AgentSlashed(address indexed agent, address indexed consumer, uint256 amount, string reason)",
];

const REGISTRY_ABI = [
  "function agentIdBySigner(address) view returns (bytes32)",
  "event AgentRegistered(bytes32 indexed agentId, address indexed attestedSigner, bytes32 mrtd, bytes32 reportData)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// ── Providers / contracts ─────────────────────────────────────────────────────

// Pinning a static network skips ethers' automatic eth_chainId probe on
// every call — on a rate-limited public RPC this measurably reduces how
// often "request limit reached" gets hit at all (see scripts/cli/_lib.js
// for the same fix, added after repeatedly hitting this during Phase 5
// deploy/wiring work — see CHANGELOG.md). Only pinned for the real Arc
// testnet URL — a local/hardhat ARC_RPC_URL keeps auto-detection so this
// doesn't silently break local dev against a different chain ID.
function getProvider() {
  const isLocal = config.ARC_RPC_URL.includes("127.0.0.1") || config.ARC_RPC_URL.includes("localhost");
  if (isLocal) return new ethers.JsonRpcProvider(config.ARC_RPC_URL);
  return new ethers.JsonRpcProvider(
    config.ARC_RPC_URL,
    { chainId: 5042002, name: "arcTestnet" },
    { staticNetwork: true }
  );
}

function getBondContract(signerOrProvider) {
  return new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ABI, signerOrProvider);
}

function getRegistryContract(provider) {
  return new ethers.Contract(config.REGISTRY_ADDRESS, REGISTRY_ABI, provider);
}

// ── Paginated log query ────────────────────────────────────────────────────────
//
// Incremental scanning (post-submission — see CHANGELOG.md's arcid2 Phase 6.4
// entry). getChainStats() used to call this with the SAME fromBlock
// (DEPLOY_BLOCK) on every single call, re-scanning the entire historical
// range from scratch — routinely, every 5 seconds, since the frontend polls
// /api/chain-stats on a 5s interval and getChainStats()'s own cache TTL is
// also 5s. That was always wasteful (the original ~629 chunks at
// CHUNK=9,000, redone every 5s the dashboard was open) — it just stayed
// tolerable enough against the old unauthenticated public RPC not to be
// noticed. Alchemy's free-tier 10-block eth_getLogs cap turned that same
// waste into ~565,855 chunks per scan, which made it actively non-functional
// rather than merely wasteful. The real fix is this: remember the last
// block successfully scanned per event filter, and only scan what's new
// since then. This is the correct fix regardless of RPC provider or plan
// tier — reducing CHUNK size or upgrading the plan only changes how
// expensive the (now one-time, not routine) cold-start scan is.
const chunkLogCache = new Map(); // cacheKey -> { events: [], lastScannedBlock: number }

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wraps a QuickNode/RPC call with exponential backoff so a rate-limited
// response (or transient network error) doesn't turn into a retry storm.
async function withBackoff(fn) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > MAX_RETRIES) throw e;
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(`[chain] RPC call failed (attempt ${attempt}/${MAX_RETRIES}): ${e.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * Incrementally paginated + cached log query. `cacheKey` identifies the
 * (contract, filter) pair across calls — this process only ever tracks one
 * bond + one registry, so a fixed string per call site is sufficient. Only
 * scans blocks after whatever was already scanned for that key; returns the
 * full accumulated event list either way.
 */
async function paginatedLogs(cacheKey, contract, filter, fromBlock, latest) {
  let entry = chunkLogCache.get(cacheKey);
  if (!entry) {
    entry = { events: [], lastScannedBlock: fromBlock - 1 };
    chunkLogCache.set(cacheKey, entry);
  }

  const scanFrom = entry.lastScannedBlock + 1;
  if (scanFrom > latest) return entry.events; // nothing new since the last scan

  const chunkSize = config.ARC_LOG_CHUNK_SIZE;
  for (let start = scanFrom; start <= latest; start += chunkSize) {
    const end  = Math.min(start + chunkSize - 1, latest);
    const logs = await withBackoff(() => contract.queryFilter(filter, start, end));
    entry.events.push(...logs);
    entry.lastScannedBlock = end;
    // Pacing between successive SUCCESSFUL calls — withBackoff() only
    // delays after a failure; without this, a large chunk count (e.g. a
    // cold-start scan on a low per-call block-range cap) fires back-to-back
    // with no pacing at all and trips the provider's requests-per-second
    // cap even when each individual call would otherwise succeed.
    if (end < latest) await sleep(config.ARC_LOG_CALL_DELAY_MS);
  }

  return entry.events;
}

// ── Chain stats (cached 5s) ────────────────────────────────────────────────────

let chainStatsCache = null;
let chainStatsCachedAt = 0;
const CACHE_TTL_MS = 5_000;

async function getChainStats({ force = false } = {}) {
  if (!config.BOND_CONTRACT_ADDRESS || !config.REGISTRY_ADDRESS) return null;

  const now = Date.now();
  if (!force && chainStatsCache && now - chainStatsCachedAt < CACHE_TTL_MS) {
    return chainStatsCache;
  }

  const provider = getProvider();
  const bond     = getBondContract(provider);
  const registry = getRegistryContract(provider);
  const latest   = await withBackoff(() => provider.getBlockNumber());
  const from     = config.DEPLOY_BLOCK || 0;

  // Registered agents
  const regEvents = await paginatedLogs("registry:AgentRegistered", registry, registry.filters.AgentRegistered(), from, latest);
  const agentMap  = {};
  for (const ev of regEvents) {
    agentMap[ev.args.attestedSigner.toLowerCase()] = ev.args.agentId;
  }

  // Bond state per agent
  const agents = [];
  let tvlRaw = 0n;
  let activeCount = 0;

  for (const [address, agentId] of Object.entries(agentMap)) {
    const info     = await withBackoff(() => bond.bonds(address));
    const isActive = await withBackoff(() => bond.isActiveBondedAgent(address));
    if (isActive) { tvlRaw += info.amount; activeCount++; }
    agents.push({
      address,
      agentId,
      amount:   info.amount.toString(),
      postedAt: Number(info.postedAt),
      slashed:  info.slashed,
      active:   isActive,
    });
  }

  // Slash count
  const slashEvents = await paginatedLogs("bond:AgentSlashed", bond, bond.filters.AgentSlashed(), from, latest);

  chainStatsCache = {
    agents,
    summary: {
      totalAgents:  agents.length,
      activeAgents: activeCount,
      tvlUsdc:      tvlRaw.toString(),
      totalSlashes: slashEvents.length,
    },
    updatedAt: Math.floor(Date.now() / 1000),
  };
  chainStatsCachedAt = now;
  return chainStatsCache;
}

// ── Circle Gateway seller balance (unified USDC balance API) ──────────────────

async function getGatewayBalance() {
  if (!config.GATEWAY_SELLER_ADDRESS) return null;

  const res = await fetch(`${config.GATEWAY_FACILITATOR_URL}/v1/balances`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token:   "USDC",
      sources: [{ domain: config.GATEWAY_DOMAIN, depositor: config.GATEWAY_SELLER_ADDRESS }],
    }),
  });
  if (!res.ok) throw new Error(`Gateway balance check failed: HTTP ${res.status}`);

  const data = await res.json();
  return data.balances?.[0] ?? null;
}

// Demo buyer buffer — deposited once into Gateway so repeated demo-pay clicks
// don't each incur an on-chain deposit; only tops up when it runs low.
const DEMO_BUYER_TOPUP_USDC = "0.05";

// Pays for one /api/price call via Circle Gateway, using the consumer wallet
// as the buyer. Used by /admin/demo-pay to make the Gateway integration
// visible in the demo UI (before/after seller balance).
async function payForPriceViaGateway() {
  if (!config.CONSUMER_PRIVATE_KEY) throw new Error("CONSUMER_PRIVATE_KEY not configured");

  const { GatewayClient } = require("@circle-fin/x402-batching/client");
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: config.CONSUMER_PRIVATE_KEY });

  const sellerBefore = await getGatewayBalance();

  const price = Number(config.PRICE_USDC);
  const buyerBalances = await client.getBalances();
  const available = Number(buyerBalances.gateway?.formattedAvailable ?? 0);
  if (available < price) {
    await client.deposit(DEMO_BUYER_TOPUP_USDC);
  }

  const priceUrl = `http://127.0.0.1:${config.PORT}/api/price`;
  const { data, amount } = await client.pay(priceUrl);

  const sellerAfter = await getGatewayBalance();

  return {
    price:    config.PRICE_USDC,
    paidAtomic: amount != null ? String(amount) : null,
    priceResponse: data,
    seller: {
      before: sellerBefore ?? { balance: "0", pendingBatch: "0" },
      after:  sellerAfter  ?? { balance: "0", pendingBatch: "0" },
    },
  };
}

// ── Signature verification (same logic as consumer/src/verifier.js) ────────────

function verifySignature(value, timestamp, expectedOracle, signature) {
  if (!signature) return { valid: false, error: "signature is null" };
  const messageHash = ethers.solidityPackedKeccak256(
    ["string", "uint256"],
    [String(value ?? ""), BigInt(timestamp)]
  );
  try {
    const recovered = ethers.verifyMessage(ethers.getBytes(messageHash), signature);
    return {
      valid: recovered.toLowerCase() === expectedOracle.toLowerCase(),
      recovered,
    };
  } catch (e) {
    return { valid: false, error: e.message, recovered: null };
  }
}

// ── Trigger cycle: re-bond → fault → Tier 1 verdict → slash → recharge ────────

async function triggerCycle() {
  if (!config.CONSUMER_PRIVATE_KEY || !config.BOND_CONTRACT_ADDRESS) {
    throw new Error("CONSUMER_PRIVATE_KEY / BOND_CONTRACT_ADDRESS not configured");
  }

  const provider     = getProvider();
  const oracleWallet = new ethers.Wallet(config.ORACLE_PRIVATE_KEY, provider);
  const consumerWallet = new ethers.Wallet(config.CONSUMER_PRIVATE_KEY, provider);

  const bond = getBondContract(oracleWallet);
  const usdc = new ethers.Contract(
    "0x3600000000000000000000000000000000000000", ERC20_ABI, oracleWallet
  );

  const log = [];

  // ── 1. Re-bond oracle if needed ──────────────────────────────────────────
  const info     = await bond.bonds(config.ORACLE_WALLET_ADDRESS);
  const isActive = await bond.isActiveBondedAgent(config.ORACLE_WALLET_ADDRESS);

  if (!isActive) {
    const bal = await usdc.balanceOf(config.ORACLE_WALLET_ADDRESS);
    const gasReserve = 20_000n; // keep 0.02 USDC for gas
    const rebondAmt  = bal > gasReserve ? bal - gasReserve : 0n;
    if (rebondAmt === 0n) throw new Error("Oracle wallet has no USDC to re-bond");

    log.push(`Re-bonding ${Number(rebondAmt)/1e6} USDC for oracle...`);
    const appTx  = await usdc.approve(config.BOND_CONTRACT_ADDRESS, rebondAmt);
    await appTx.wait();
    const bondTx = await bond.connect(oracleWallet).postBond(rebondAmt);
    const bondR  = await bondTx.wait();
    log.push(`Re-bond tx: ${bondR.hash}`);
  }

  // ── 2. Generate bad-sig oracle response ──────────────────────────────────
  const value     = (3_450 + (Math.random() - 0.5) * 20).toFixed(2);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = "0x" + "ab".repeat(32) + "cd".repeat(32) + "01"; // bad-sig

  log.push(`Fault response: value=${value}, ts=${timestamp}, bad-sig`);

  // ── 3. Verify (will fail) ─────────────────────────────────────────────────
  const ageSeconds = 0;
  const sigResult  = verifySignature(value, timestamp, config.ORACLE_WALLET_ADDRESS, signature);
  log.push(`Sig valid: ${sigResult.valid}, error: ${sigResult.error}`);

  // ── 4. Tier 1 deterministic verdict — no LLM call ─────────────────────────
  // bad-sig is a mechanically-checkable signature failure (tiered
  // adjudication Phase 1 — see CHANGELOG.md); the real consumer flow never
  // invokes Claude for this class of fault, and this demo endpoint matches
  // that now: same reasoning deterministicVerifier.js applies, same
  // SIG_INVALID code, zero Claude calls, zero LLM cost for this trigger.
  log.push("Evaluating Tier 1 (deterministic) — no LLM call for a bad-sig fault");
  const reason = `[SIG_INVALID] ${sigResult.error || "signature does not recover to the registered oracle wallet"}`;
  const verdict = {
    verdict: "breach",
    reason,
    should_slash: true,
    tier: "deterministic",
    code: "SIG_INVALID",
  };
  log.push(`Verdict: breach (Tier 1, deterministic) — ${reason.slice(0, 80)}...`);

  // ── 5. Slash on breach ────────────────────────────────────────────────────
  let slashTx = null;
  if (verdict.verdict === "breach" && verdict.should_slash) {
    const slashBond  = getBondContract(consumerWallet);
    const tx = await slashBond.slash(
      config.ORACLE_WALLET_ADDRESS,
      config.CONSUMER_WALLET_ADDRESS,
      verdict.reason,
      BREACH_CLASS_HARD
    );
    const r  = await tx.wait();
    slashTx  = r.hash;

    // Proportional slashing (tiered adjudication Phase 4 — see CHANGELOG.md):
    // the transferred amount is no longer always the full bond. Read the
    // actual amount from AgentSlashed rather than assuming it — the
    // pre-slash bond total is no longer the right number to log.
    const slashedEvent = r.logs
      .map((l) => { try { return slashBond.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "AgentSlashed");
    const slashedAmount = slashedEvent ? Number(slashedEvent.args.amount) / 1e6 : null;
    log.push(`Slash tx: ${slashTx} — ${slashedAmount ?? "?"} USDC → consumer (breachClass=Hard)`);

    // ── 6. Recharge oracle (1 USDC from consumer) to enable next cycle ──────
    const rechargeAmt = 1_000_000n; // 1 USDC
    const consumerBal = await new ethers.Contract(
      "0x3600000000000000000000000000000000000000", ERC20_ABI, consumerWallet
    ).balanceOf(config.CONSUMER_WALLET_ADDRESS);

    if (consumerBal >= rechargeAmt) {
      const rechargeTx = await new ethers.Contract(
        "0x3600000000000000000000000000000000000000", ERC20_ABI, consumerWallet
      ).transfer(config.ORACLE_WALLET_ADDRESS, rechargeAmt);
      const rr = await rechargeTx.wait();
      log.push(`Recharged oracle with 1 USDC: ${rr.hash}`);
    }
  }

  // Bust the chain-stats cache so next poll reflects the slash
  chainStatsCachedAt = 0;

  return { verdict: verdict.verdict, reason: verdict.reason, slashTx, log };
}

module.exports = { getChainStats, triggerCycle, getGatewayBalance, payForPriceViaGateway };
