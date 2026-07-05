"use strict";
/**
 * chain.js — On-chain reader + trigger-cycle logic for /api/chain-stats
 * and /admin/trigger-cycle.
 *
 * Reads ArcIDBond + ArcIDRegistryV2 events and bond state.
 * Implements the full slash loop: re-bond oracle if needed → generate
 * bad-sig response → LLM adjudication → on-chain slash → recharge oracle.
 */

const { ethers }   = require("ethers");
const Anthropic    = require("@anthropic-ai/sdk");
const config       = require("./config");

// ── ABIs ─────────────────────────────────────────────────────────────────────

const BOND_ABI = [
  "function bonds(address) view returns (uint256 amount, uint64 postedAt, bool slashed)",
  "function isActiveBondedAgent(address) view returns (bool)",
  "function postBond(uint256 amount) external",
  "function slash(address agent, address consumer, string calldata reason) external",
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

function getProvider() {
  return new ethers.JsonRpcProvider(config.ARC_RPC_URL);
}

function getBondContract(signerOrProvider) {
  return new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ABI, signerOrProvider);
}

function getRegistryContract(provider) {
  return new ethers.Contract(config.REGISTRY_ADDRESS, REGISTRY_ABI, provider);
}

// ── Paginated log query ────────────────────────────────────────────────────────

const CHUNK = 9_000;
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

async function paginatedLogs(contract, filter, fromBlock, latest) {
  const events = [];
  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end  = Math.min(start + CHUNK - 1, latest);
    const logs = await withBackoff(() => contract.queryFilter(filter, start, end));
    events.push(...logs);
  }
  return events;
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
  const regEvents = await paginatedLogs(registry, registry.filters.AgentRegistered(), from, latest);
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
  const slashEvents = await paginatedLogs(bond, bond.filters.AgentSlashed(), from, latest);

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

// ── LLM adjudicator (ported from consumer/src/adjudicator.js) ────────────────

const VERDICT_TOOL = {
  name: "deliver_verdict",
  description: "Deliver the final adjudication verdict on whether the oracle provider met their SLA.",
  input_schema: {
    type: "object",
    properties: {
      verdict:      { type: "string", enum: ["ok", "breach", "uncertain"] },
      reason:       { type: "string" },
      should_slash: { type: "boolean" },
      checks: {
        type: "object",
        properties: {
          timestamp_fresh: { type: "boolean" },
          value_present:   { type: "boolean" },
          signature_valid: { type: "boolean" },
        },
        required: ["timestamp_fresh", "value_present", "signature_valid"],
      },
    },
    required: ["verdict", "reason", "should_slash", "checks"],
  },
};

const SYSTEM_PROMPT = `You are an autonomous adjudication agent for the ArcID bonded reputation system.
Evaluate whether a bonded oracle provider met its SLA for a paid query.
SLA: (1) timestamp within max_age_seconds, (2) non-null parseable value, (3) ECDSA signature recovers to oracle wallet.
Return ok/breach/uncertain with written rationale. Breach rationale goes on-chain in AgentSlashed event.`;

async function adjudicate({ value, timestamp, signature, ageSeconds, sigValid, sigError }) {
  if (!config.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set in oracle/.env");
  const client = new Anthropic.default({ apiKey: config.ANTHROPIC_API_KEY });

  const fresh    = ageSeconds <= config.MAX_AGE_SECONDS;
  const present  = value !== null && value !== undefined && value !== "";

  const msg = await client.messages.create({
    model:      config.MODEL,
    max_tokens: 1024,
    system:     SYSTEM_PROMPT,
    tools:      [VERDICT_TOOL],
    tool_choice:{ type: "tool", name: "deliver_verdict" },
    messages:   [{ role: "user", content:
      `Oracle response: value=${JSON.stringify(value)}, timestamp=${timestamp} (${ageSeconds}s ago), ` +
      `signature=${signature ? signature.slice(0,20)+"..." : "NULL"}. ` +
      `SLA max_age=${config.MAX_AGE_SECONDS}s. ` +
      `Checks: timestamp_fresh=${fresh}, value_present=${present}, signature_valid=${sigValid}` +
      (sigError ? ` (error: ${sigError})` : "") + `. Deliver verdict.`,
    }],
  });

  const tool = msg.content.find(b => b.type === "tool_use");
  if (!tool) throw new Error("Adjudicator did not call deliver_verdict");
  return tool.input;
}

// ── Trigger cycle: re-bond → fault → adjudicate → slash → recharge ─────────────

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

  // ── 4. LLM adjudication ───────────────────────────────────────────────────
  log.push("Calling Claude adjudicator...");
  const verdict = await adjudicate({
    value, timestamp, signature, ageSeconds,
    sigValid: sigResult.valid, sigError: sigResult.error,
  });
  log.push(`Verdict: ${verdict.verdict} — ${verdict.reason.slice(0, 80)}...`);

  // ── 5. Slash on breach ────────────────────────────────────────────────────
  let slashTx = null;
  if (verdict.verdict === "breach" && verdict.should_slash) {
    const rebondInfo = await bond.bonds(config.ORACLE_WALLET_ADDRESS);
    const slashBond  = getBondContract(consumerWallet);
    const tx = await slashBond.slash(
      config.ORACLE_WALLET_ADDRESS,
      config.CONSUMER_WALLET_ADDRESS,
      verdict.reason
    );
    const r  = await tx.wait();
    slashTx  = r.hash;
    log.push(`Slash tx: ${slashTx} — ${Number(rebondInfo.amount)/1e6} USDC → consumer`);

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

module.exports = { getChainStats, triggerCycle, getGatewayBalance };
