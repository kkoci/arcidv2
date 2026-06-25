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
  PRICE_USDC:    process.env.PRICE_USDC    || "0.001",   // $0.001 per call
  ARC_NETWORK:   process.env.ARC_NETWORK   || "arc-testnet",
  FACILITATOR_URL: process.env.FACILITATOR_URL || "https://x402.org/facilitator",

  // SLA declared in every response — consumer agent checks against this
  MAX_AGE_SECONDS: parseInt(process.env.MAX_AGE_SECONDS || "30", 10),

  // DEV_MODE=true → accept any X-Payment header without verifying with Circle Gateway.
  // Set to false on Arc testnet where real USDC flows.
  DEV_MODE: process.env.DEV_MODE !== "false",

  // Admin token required to hit ?fault= (prevents demo spoiling in prod)
  FAULT_TOKEN: process.env.FAULT_TOKEN || "dev-fault-token",
};
