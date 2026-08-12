require("dotenv").config();

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

module.exports = {
  PORT: parseInt(process.env.PORT || "3002", 10),

  // Ingestion enclave identity — must be TEE-registered in ArcIDRegistry,
  // same gating class of proof CompensationClaim.sol will check via
  // IArcIDRegistry.agentIdBySigner(), mirroring ExploitBounty's verifier.
  INGESTOR_PRIVATE_KEY:    required("INGESTOR_PRIVATE_KEY"),
  INGESTOR_WALLET_ADDRESS: required("INGESTOR_WALLET_ADDRESS"),

  ARC_RPC_URL: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
  ARTIST_REGISTRY_ADDRESS: process.env.ARTIST_REGISTRY_ADDRESS || "",
  TRAINING_POOL_ADDRESS:   process.env.TRAINING_POOL_ADDRESS   || "",
  // Rights-Claim Bonding (post-submission — see CHANGELOG.md). Optional,
  // opt-in: unset by default so the existing live AcquisitionAgent
  // endpoint (whose demo catalog was never claim-bonded) keeps working
  // unchanged. Set this to require an Upheld bonded rights claim, not
  // just a bare ArtistRegistry entry, for every track in a corpus.
  RIGHTS_CLAIM_BOND_ADDRESS: process.env.RIGHTS_CLAIM_BOND_ADDRESS || "",

  // Phala Cloud TDX attestation — same USE_REAL_PHALA split as oracle/src/config.js.
  USE_REAL_PHALA: process.env.USE_REAL_PHALA === "true",
};
