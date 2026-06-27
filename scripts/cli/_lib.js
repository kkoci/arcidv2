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

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function getProvider(network = "arcTestnet") {
  if (network === "hardhat" || network === "localhost") {
    return new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  }
  const url =
    process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
  return new ethers.JsonRpcProvider(url);
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
  const signingKey = new ethers.SigningKey(privateKey);
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
  loadDeployment,
  getProvider,
  getContracts,
  buildAttestation,
  buildPrototypeQuote,
  signRawDigest,
  formatUSDC,
  formatTimestamp,
  ArcIDRegistryV2ABI,
  ArcIDBondABI,
  ERC20_ABI,
};
