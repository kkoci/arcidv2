require("dotenv").config();
const { ethers } = require("ethers");

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

// Shared provider factory — pins a static network on Arc testnet so ethers
// skips its automatic eth_chainId probe on every call. Without this, each of
// slasher.js/settlement.js/deterministicVerifier.js/auditTrail.js re-probing
// independently was enough extra RPC traffic to trip Arc testnet's rate
// limit on its own (see CLAUDE.md's RPC rate-limit note; the same fix was
// already applied in scripts/cli/_lib.js and oracle/src/chain.js).
const ARC_TESTNET_CHAIN_ID = 5042002;
function getProvider(rpcUrl) {
  const url = rpcUrl || process.env.ARC_RPC_URL || "http://127.0.0.1:8545";
  const isLocal = url.includes("127.0.0.1") || url.includes("localhost");
  if (isLocal) return new ethers.JsonRpcProvider(url);
  return new ethers.JsonRpcProvider(
    url,
    { chainId: ARC_TESTNET_CHAIN_ID, name: "arcTestnet" },
    { staticNetwork: true }
  );
}

module.exports = {
  getProvider,
  // Oracle
  ORACLE_URL:            process.env.ORACLE_URL            || "http://localhost:3001",
  ORACLE_WALLET_ADDRESS: required("ORACLE_WALLET_ADDRESS"), // known oracle wallet — verify sigs against this

  // Consumer identity
  CONSUMER_PRIVATE_KEY:    required("CONSUMER_PRIVATE_KEY"),
  CONSUMER_WALLET_ADDRESS: required("CONSUMER_WALLET_ADDRESS"),

  // Bond contract
  BOND_CONTRACT_ADDRESS: required("BOND_CONTRACT_ADDRESS"),
  ARC_RPC_URL:           process.env.ARC_RPC_URL || "http://127.0.0.1:8545",

  // Session-key wallet hardening (Phase 6, post-submission — see CHANGELOG.md).
  // When set, CONSUMER_PRIVATE_KEY is treated as a bounded session key and
  // slash()/recordSettlement() calls route through this guard contract
  // instead of hitting ArcIDBond directly. Unset: unchanged pre-Phase-6
  // behavior (CONSUMER_PRIVATE_KEY calls ArcIDBond directly as authorizedSlasher).
  SESSION_GUARD_ADDRESS: process.env.SESSION_GUARD_ADDRESS || "",

  // Deterministic payment gate (Phase 7, post-submission — see CHANGELOG.md).
  // PRICE_USDC is the agreed per-call oracle price (must match oracle/.env's
  // own PRICE_USDC — paymentGate.js rejects any Gateway payment that doesn't
  // equal this exactly). MAX_SETTLEMENT_USDC is a hard per-call ceiling,
  // independent of and in addition to any ConsumerSessionKeyGuard cap.
  PRICE_USDC:          process.env.PRICE_USDC          || "0.001",
  MAX_SETTLEMENT_USDC: process.env.MAX_SETTLEMENT_USDC || "0.01",

  // Spend-velocity circuit breaker (Phase 8, post-submission — see CHANGELOG.md).
  // Rolling per-minute/per-hour spend caps computed from the settlement
  // ledger. Crossing either halts further settlement calls until a manual
  // `npm run breaker:resume` (in consumer/) — no auto-recovery.
  MAX_SPEND_PER_MINUTE_USDC: process.env.MAX_SPEND_PER_MINUTE_USDC || "0.05",
  MAX_SPEND_PER_HOUR_USDC:   process.env.MAX_SPEND_PER_HOUR_USDC   || "1.0",

  // Attributable audit trail (Phase 9, post-submission — see CHANGELOG.md).
  // Optional. When set, auditTrail.js resolves the oracle wallet's real
  // on-chain agentId from ArcIDRegistryV2 (free view call) and includes it
  // in every settlement_audit.jsonl record. Unset: audit records still get
  // written, just without the agentId field populated.
  REGISTRY_ADDRESS: process.env.REGISTRY_ADDRESS || "",

  // LLM
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
  MODEL:             process.env.MODEL || "claude-sonnet-4-6",

  // Loop
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || "12000", 10), // 12s default

  // DEV_MODE: skip real on-chain slash + use dev x402 payment
  DEV_MODE: process.env.DEV_MODE !== "false",

  // Logging
  LOG_DIR: process.env.LOG_DIR || "logs",
};
