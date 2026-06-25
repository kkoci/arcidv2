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

  // Phase 5 — USYC yield-bearing bond contract (optional; "" if not deployed yet)
  USYC_BOND_ADDRESS:  process.env.USYC_BOND_ADDRESS  || "",
  USDC_BOND_ADDRESS:  process.env.USDC_BOND_ADDRESS  || "",
  USYC_TOKEN_ADDRESS: process.env.USYC_TOKEN_ADDRESS || "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
  TELLER_ADDRESS:     process.env.TELLER_ADDRESS     || "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
};
