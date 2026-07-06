require("dotenv").config();

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

module.exports = {
  PORT: parseInt(process.env.PORT || "3000", 10),

  // Oracle agent identity — must be TEE-registered in ArcIDRegistry
  ORACLE_PRIVATE_KEY:    required("ORACLE_PRIVATE_KEY"),
  ORACLE_WALLET_ADDRESS: required("ORACLE_WALLET_ADDRESS"),

  // x402 payment config
  PRICE_USDC:    process.env.PRICE_USDC    || "0.001",
  ARC_NETWORK:   process.env.ARC_NETWORK   || "arc-testnet",
  FACILITATOR_URL: process.env.FACILITATOR_URL || "https://x402.org/facilitator",

  // Circle Gateway Nanopayments — wraps /api/price in production (DEV_MODE=false).
  // Network is CAIP-2 for Arc Testnet (chain id 5042002 — confirmed via eth_chainId
  // against ARC_RPC_URL; this is Circle's own "Arc Testnet" in Gateway's supported-networks
  // list, not Arbitrum Sepolia's 421614).
  GATEWAY_FACILITATOR_URL: process.env.GATEWAY_FACILITATOR_URL || "https://gateway-api-testnet.circle.com",
  GATEWAY_NETWORK:         process.env.GATEWAY_NETWORK         || "eip155:5042002",
  // Gateway's CCTP domain id for Arc Testnet (used by the /v1/balances API — distinct from the CAIP-2 network id above).
  GATEWAY_DOMAIN:          parseInt(process.env.GATEWAY_DOMAIN || "26", 10),
  // Seller wallet that receives Gateway payments — defaults to the oracle's own wallet.
  GATEWAY_SELLER_ADDRESS:  process.env.GATEWAY_SELLER_ADDRESS  || process.env.ORACLE_WALLET_ADDRESS,

  // SLA declared in every response — consumer agent checks against this
  MAX_AGE_SECONDS: parseInt(process.env.MAX_AGE_SECONDS || "30", 10),

  DEV_MODE: process.env.DEV_MODE !== "false",
  FAULT_TOKEN: process.env.FAULT_TOKEN || "dev-fault-token",

  // Phase 5 — USYC yield-bearing bond contract
  USYC_BOND_ADDRESS:  process.env.USYC_BOND_ADDRESS  || "",
  USDC_BOND_ADDRESS:  process.env.USDC_BOND_ADDRESS  || "",
  USYC_TOKEN_ADDRESS: process.env.USYC_TOKEN_ADDRESS || "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
  TELLER_ADDRESS:     process.env.TELLER_ADDRESS     || "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",

  // On-chain config — chain-stats + trigger-cycle
  ARC_RPC_URL:            process.env.ARC_RPC_URL            || "https://rpc.testnet.arc.network",
  BOND_CONTRACT_ADDRESS:  process.env.BOND_CONTRACT_ADDRESS  || "",
  REGISTRY_ADDRESS:       process.env.REGISTRY_ADDRESS       || "",
  DEPLOY_BLOCK:           parseInt(process.env.DEPLOY_BLOCK  || "0", 10),
  CONSUMER_PRIVATE_KEY:   process.env.CONSUMER_PRIVATE_KEY   || "",
  CONSUMER_WALLET_ADDRESS:process.env.CONSUMER_WALLET_ADDRESS|| "",
  ANTHROPIC_API_KEY:      process.env.ANTHROPIC_API_KEY      || "",
  MODEL:                  process.env.MODEL                  || "claude-sonnet-4-6",

  // Phala Cloud TDX attestation (Phase 7)
  // USE_REAL_PHALA=true  → connect to the dstack guest agent's Unix socket via
  //                        @phala/dstack-sdk (inside CVM only; socket must be volume-mounted)
  // USE_REAL_PHALA=false → return structurally-valid prototype quote (local dev default)
  USE_REAL_PHALA:  process.env.USE_REAL_PHALA === "true",
};
