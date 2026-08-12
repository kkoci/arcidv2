"use strict";
/**
 * _lib.js — Shared helpers for arcid2 CLI commands.
 *
 * Loaded by every script in scripts/cli/. Requires `npm run compile` to have
 * been run so that ABI artifacts exist under artifacts/contracts/.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// ---------------------------------------------------------------------------
// ABI loading
// ---------------------------------------------------------------------------

function loadABI(relPath) {
  const full = path.join(__dirname, "../../artifacts/contracts", relPath);
  if (!fs.existsSync(full)) {
    console.error(`\nABI not found: ${full}`);
    console.error("Run `npm run compile` first.\n");
    process.exit(1);
  }
  return require(full).abi;
}

const ArcIDRegistryV2ABI = loadABI("ArcIDRegistryV2.sol/ArcIDRegistryV2.json");
const ArcIDBondABI        = loadABI("ArcIDBond.sol/ArcIDBond.json");
const ConsumerSessionKeyGuardABI = loadABI("ConsumerSessionKeyGuard.sol/ConsumerSessionKeyGuard.json");
const ArtistRegistryABI     = loadABI("ArtistRegistry.sol/ArtistRegistry.json");
const TrainingPoolABI       = loadABI("TrainingPool.sol/TrainingPool.json");
const CompensationClaimABI  = loadABI("CompensationClaim.sol/CompensationClaim.json");
const RightsClaimBondABI    = loadABI("RightsClaimBond.sol/RightsClaimBond.json");

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// ---------------------------------------------------------------------------
// Arg parser  (--flag value  or  --flag  for booleans)
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const out  = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key  = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Private keys — .env only, NEVER a CLI argument
// ---------------------------------------------------------------------------
//
// See CLAUDE.md: "Never pass private keys as CLI arguments in any command."
// This was written after a real incident where a key passed via --key was
// echoed back twice — once by npm's own command-echo, and once by a raw
// error message (see the SigningKey note below) — both landing in a visible
// transcript. requireEnvKey() is now the ONLY sanctioned way a CLI script in
// this project obtains a private key.
//
// Root .env private-key variables by role (each script below uses exactly
// one, matching its actual on-chain permission requirement):
//   DEPLOYER_PRIVATE_KEY     — ArcIDBond/registry deployer & Ownable owner
//   AGENT_PRIVATE_KEY        — the wallet registering / posting a bond / checking its own gating
//   SLASHER_PRIVATE_KEY      — ArcIDBond.authorizedSlasher (slash.js, settle.js)
//   GUARD_OWNER_PRIVATE_KEY  — ConsumerSessionKeyGuard's Ownable owner (session-key.js grant/revoke)

/**
 * ethers.Wallet() tolerates a private key with or without the "0x" prefix,
 * but ethers.SigningKey() (used by signRawDigest() below, for DCAP quote
 * signing) does NOT — it throws on a bare 64-hex-char string, and that
 * error message embeds the raw (invalid) value it was given. Normalizing
 * here means every private key in this file is safe to pass to either API,
 * and a malformed value never has a reason to be echoed back out.
 */
function normalizePrivateKey(key) {
  if (typeof key !== "string") return key;
  return key.startsWith("0x") ? key : `0x${key}`;
}

/**
 * The only sanctioned way to obtain a private key in this project's CLI
 * scripts: read it from process.env (sourced from .env — see the dotenv
 * config() call at the top of this file), never from a CLI flag. Exits with
 * a clear, actionable message — and never prints the value, valid or not —
 * if the variable is unset.
 */
function requireEnvKey(varName) {
  const raw = process.env[varName];
  if (!raw) {
    console.error(`\nMissing required env var: ${varName}`);
    console.error(`Set it in .env (project root) — private keys are never passed as CLI arguments.\n`);
    process.exit(1);
  }
  return normalizePrivateKey(raw);
}

// ---------------------------------------------------------------------------
// Deployment loader
// ---------------------------------------------------------------------------

function loadDeployment(network = "arcTestnet") {
  const p = path.join(
    __dirname,
    `../../deployments/${network}_standalone.json`
  );
  if (!fs.existsSync(p)) {
    console.error(`\nDeployment not found: ${p}`);
    console.error(
      `Run \`npm run deploy:standalone\` (or \`deploy:standalone:local\` for Hardhat) first.\n`
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadSessionGuardDeployment(network = "arcTestnet") {
  const p = path.join(
    __dirname,
    `../../deployments/${network}_session_guard.json`
  );
  if (!fs.existsSync(p)) {
    console.error(`\nSession guard deployment not found: ${p}`);
    console.error(
      `Run \`npm run deploy:session-guard:arc\` (or \`:local\` for Hardhat) first.\n`
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadTrainingCompensationDeployment(network = "arcTestnet") {
  const p = path.join(
    __dirname,
    `../../deployments/${network}_training_compensation.json`
  );
  if (!fs.existsSync(p)) {
    console.error(`\nTraining Compensation deployment not found: ${p}`);
    console.error(
      `Run \`npx hardhat run scripts/deploy_training_compensation.js --network ${network}\` first.\n`
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadRightsClaimBondDeployment(network = "arcTestnet") {
  const p = path.join(
    __dirname,
    `../../deployments/${network}_rights_claim_bond.json`
  );
  if (!fs.existsSync(p)) {
    console.error(`\nRightsClaimBond deployment not found: ${p}`);
    console.error(
      `Run \`npx hardhat run scripts/deploy_rights_claim_bond.js --network ${network}\` first.\n`
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

// Arc testnet chain ID — see CLAUDE.md ("verified via eth_chainId against the
// live RPC — this is Circle's own Arc Testnet network, not Arbitrum
// Sepolia's 421614"). Pinning it as a static network (below) skips ethers'
// automatic eth_chainId probe on every single call — on a rate-limited
// public RPC this isn't just an optimization, it materially reduces how
// often these CLI tools hit "request limit reached" at all.
const ARC_TESTNET_CHAIN_ID = 5042002;

function getProvider(network = "arcTestnet") {
  if (network === "hardhat" || network === "localhost") {
    return new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  }
  const url =
    process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
  return new ethers.JsonRpcProvider(
    url,
    { chainId: ARC_TESTNET_CHAIN_ID, name: "arcTestnet" },
    { staticNetwork: true }
  );
}

// ---------------------------------------------------------------------------
// Contract instances
// ---------------------------------------------------------------------------

function getContracts(addresses, providerOrSigner) {
  return {
    registry: new ethers.Contract(
      addresses.ArcIDRegistryV2,
      ArcIDRegistryV2ABI,
      providerOrSigner
    ),
    bond: new ethers.Contract(
      addresses.ArcIDBond,
      ArcIDBondABI,
      providerOrSigner
    ),
    usdc: new ethers.Contract(
      addresses.collateralToken,
      ERC20_ABI,
      providerOrSigner
    ),
  };
}

function getGuardContract(guardAddress, providerOrSigner) {
  return new ethers.Contract(guardAddress, ConsumerSessionKeyGuardABI, providerOrSigner);
}

function getTrainingCompensationContracts(addresses, providerOrSigner) {
  return {
    artistRegistry: new ethers.Contract(addresses.ArtistRegistry, ArtistRegistryABI, providerOrSigner),
    pool:           new ethers.Contract(addresses.TrainingPool, TrainingPoolABI, providerOrSigner),
    claimContract:  new ethers.Contract(addresses.CompensationClaim, CompensationClaimABI, providerOrSigner),
    usdc:           new ethers.Contract(addresses.collateralToken, ERC20_ABI, providerOrSigner),
  };
}

// ---------------------------------------------------------------------------
// DCAP quote helpers  (identical logic to deploy_standalone.js)
// ---------------------------------------------------------------------------

const QUOTE_LEN = 0x250; // 592 bytes

function buildPrototypeQuote(agentAddress, reportDataHex) {
  const buf = Buffer.alloc(QUOTE_LEN, 0);

  buf.writeUInt16LE(4,          0); // version = 4
  buf.writeUInt16LE(2,          2); // att_key_type = ECDSA_P256
  buf.writeUInt32LE(0x00000081, 4); // tee_type = TDX

  const mrtdSeed = ethers.keccak256(
    ethers.toUtf8Bytes(
      "arcidv2-prototype-mrtd:" + agentAddress.toLowerCase()
    )
  );
  const mrtd = ethers.getBytes(mrtdSeed);
  for (let i = 0; i < 48; i++) buf[0x70 + i] = mrtd[i % 32];

  const rd = ethers.getBytes(reportDataHex);
  for (let i = 0; i < 32; i++) buf[0x230 + i] = rd[i];

  return "0x" + buf.toString("hex");
}

function signRawDigest(privateKey, reportData) {
  const signingKey = new ethers.SigningKey(normalizePrivateKey(privateKey));
  const sig = signingKey.sign(ethers.getBytes(reportData));
  return ethers.concat([
    ethers.zeroPadValue(sig.r, 32),
    ethers.zeroPadValue(sig.s, 32),
    Uint8Array.from([sig.v]),
  ]);
}

/**
 * Build a fresh attestation for a wallet.
 * report_data = keccak256(agentAddress || nonce)  — unique per wallet + seed.
 */
function buildAttestation(agentAddress, privateKey, nonceSeed = "arcidv2-genesis-bond") {
  const nonce = ethers.keccak256(ethers.toUtf8Bytes(nonceSeed));
  const reportData = ethers.keccak256(
    ethers.solidityPacked(["address", "bytes32"], [agentAddress, nonce])
  );
  return {
    dcapQuote:     buildPrototypeQuote(agentAddress, reportData),
    reportDataSig: signRawDigest(privateKey, reportData),
    reportData,
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatUSDC(amount) {
  return (Number(amount) / 1e6).toFixed(2) + " USDC";
}

function formatTimestamp(ts) {
  if (!ts || ts === 0n) return "—";
  return (
    new Date(Number(ts) * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " UTC"
  );
}

// ---------------------------------------------------------------------------

module.exports = {
  parseArgs,
  requireEnvKey,
  normalizePrivateKey,
  loadDeployment,
  loadSessionGuardDeployment,
  loadTrainingCompensationDeployment,
  loadRightsClaimBondDeployment,
  getProvider,
  getContracts,
  getGuardContract,
  getTrainingCompensationContracts,
  buildAttestation,
  buildPrototypeQuote,
  signRawDigest,
  formatUSDC,
  formatTimestamp,
  ArcIDRegistryV2ABI,
  ArcIDBondABI,
  ConsumerSessionKeyGuardABI,
  ArtistRegistryABI,
  TrainingPoolABI,
  CompensationClaimABI,
  RightsClaimBondABI,
  ERC20_ABI,
};
