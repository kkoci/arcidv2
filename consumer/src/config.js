require("dotenv").config();

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

module.exports = {
  // Oracle
  ORACLE_URL:            process.env.ORACLE_URL            || "http://localhost:3001",
  ORACLE_WALLET_ADDRESS: required("ORACLE_WALLET_ADDRESS"), // known oracle wallet — verify sigs against this

  // Consumer identity
  CONSUMER_PRIVATE_KEY:    required("CONSUMER_PRIVATE_KEY"),
  CONSUMER_WALLET_ADDRESS: required("CONSUMER_WALLET_ADDRESS"),

  // Bond contract
  BOND_CONTRACT_ADDRESS: required("BOND_CONTRACT_ADDRESS"),
  ARC_RPC_URL:           process.env.ARC_RPC_URL || "http://127.0.0.1:8545",

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
