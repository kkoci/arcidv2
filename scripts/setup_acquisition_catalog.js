/**
 * setup_acquisition_catalog.js — one-time (idempotent), persistent setup
 * for the AcquisitionAgent's live HTTP endpoint (acquisition/server.js).
 *
 * demo-acquisition.js (the CLI) generates fresh wallets and re-registers
 * the whole catalog on every single run — fine for a one-off demo, wrong
 * for a live endpoint real customers hit repeatedly: redoing artist
 * registration and wallet funding on every HTTP request would make each
 * request slower, costlier, and strictly less reliable than it needs to
 * be. This script does that setup ONCE against the EXISTING
 * ArtistRegistry/TrainingPool/CompensationClaim deployment (reused, not
 * redeployed) and persists the result so every live request only does
 * the part that actually varies: judge the brief, fund a pool, settle.
 *
 * Fingerprint hashes here are STABLE (keccak256(trackId), no per-run
 * timestamp) — unlike demo-acquisition.js's fresh-every-run hashes,
 * because this catalog is meant to be registered exactly once and then
 * referenced by every future request.
 *
 * Usage:
 *   npx hardhat run scripts/setup_acquisition_catalog.js --network arcTestnet
 *   npx hardhat run scripts/setup_acquisition_catalog.js --network hardhat   # local sanity check
 */

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");
const { TRACKS } = require("../acquisition/src/catalog");

const ARTIST_GAS_FUND  = "0.02";
const COMPANY_GAS_FUND = "0.05";
const COMPANY_USDC_FUND = 10_000_000n; // 10 USDC — enough for many live requests at $1/track (deployer's real testnet balance is finite)
const ACQ_ENV_PATH = path.resolve(__dirname, "..", "acquisition", ".env");

function upsertEnvVar(filePath, name, value) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(content)) content = content.replace(re, line);
  else content = content.replace(/\n?$/, "\n") + line + "\n";
  fs.writeFileSync(filePath, content);
}

async function getOrCreateWallet(envVarPrefix, provider, deployer, gasFund) {
  const keyVar = `${envVarPrefix}_PRIVATE_KEY`;
  let key = process.env[keyVar];
  let wallet;
  if (key) {
    wallet = new (require("ethers").Wallet)(key, provider);
    console.log(`  Reusing ${envVarPrefix}: ${wallet.address}`);
  } else {
    const fresh = require("ethers").Wallet.createRandom();
    wallet = fresh.connect(provider);
    key = fresh.privateKey;
    upsertEnvVar(ACQ_ENV_PATH, keyVar, key);
    upsertEnvVar(ACQ_ENV_PATH, `${envVarPrefix}_ADDRESS`, wallet.address);
    console.log(`  Generated ${envVarPrefix}: ${wallet.address} (key saved to acquisition/.env)`);
  }
  const balance = await provider.getBalance(wallet.address);
  if (balance < require("ethers").parseEther(gasFund) / 2n) {
    const tx = await deployer.sendTransaction({ to: wallet.address, value: require("ethers").parseEther(gasFund) });
    await tx.wait();
    console.log(`    funded with ${gasFund} ETH gas`);
  }
  return wallet;
}

async function main() {
  const { ethers, network } = hre;
  const isLocal = network.name === "hardhat" || network.name === "localhost";
  const [deployer] = await ethers.getSigners();

  console.log(`\n${"─".repeat(60)}`);
  console.log("AcquisitionAgent catalog setup — persistent, idempotent");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network: ${network.name}`);

  const deployFile = path.resolve(__dirname, `../deployments/${network.name}_training_compensation.json`);
  if (!fs.existsSync(deployFile)) {
    throw new Error(`Missing ${deployFile} — run deploy_training_compensation.js for this network first.`);
  }
  const deploy = JSON.parse(fs.readFileSync(deployFile, "utf8"));
  console.log(`Reusing existing ArtistRegistry: ${deploy.addresses.ArtistRegistry}`);
  console.log(`Reusing existing TrainingPool:    ${deploy.addresses.TrainingPool}`);
  console.log(`Reusing existing CompensationClaim: ${deploy.addresses.CompensationClaim}`);

  const artistRegistry = await ethers.getContractAt("ArtistRegistry", deploy.addresses.ArtistRegistry);

  console.log(`\n→ Company + artist wallets (generate-or-reuse from acquisition/.env)...`);
  const company = await getOrCreateWallet("ACQ_COMPANY", ethers.provider, deployer, COMPANY_GAS_FUND);

  const artistKeys = [...new Set(TRACKS.map((t) => t.artistKey))];
  const artistWallets = {};
  for (const key of artistKeys) {
    artistWallets[key] = await getOrCreateWallet(`ACQ_ARTIST_${key}`, ethers.provider, deployer, ARTIST_GAS_FUND);
  }

  console.log(`\n→ Funding company with USDC for pool creation...`);
  if (isLocal) {
    const MockUSDC_ABI = ["function mint(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"];
    const mockUsdc = new ethers.Contract(deploy.addresses.collateralToken, MockUSDC_ABI, deployer);
    const bal = await mockUsdc.balanceOf(company.address);
    if (bal < COMPANY_USDC_FUND) await (await mockUsdc.mint(company.address, COMPANY_USDC_FUND)).wait();
    console.log(`  [local] company USDC balance: ${Number(await mockUsdc.balanceOf(company.address)) / 1e6}`);
  } else {
    const ERC20_ABI = ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
    const usdc = new ethers.Contract(deploy.addresses.collateralToken, ERC20_ABI, deployer);
    const companyBal = await usdc.balanceOf(company.address);
    if (companyBal < COMPANY_USDC_FUND) {
      const deployerBal = await usdc.balanceOf(deployer.address);
      const need = COMPANY_USDC_FUND - companyBal;
      if (deployerBal < need) throw new Error(`Deployer has insufficient USDC: have ${Number(deployerBal) / 1e6}, need ${Number(need) / 1e6} more for the company wallet.`);
      await (await usdc.connect(deployer).transfer(company.address, need)).wait();
      console.log(`  Transferred ${Number(need) / 1e6} USDC from deployer to company`);
    } else {
      console.log(`  Company already funded: ${Number(companyBal) / 1e6} USDC`);
    }
  }

  console.log(`\n→ Registering ${TRACKS.length} catalog tracks (idempotent — skips already-registered)...`);
  const rightsHash = ethers.keccak256(ethers.toUtf8Bytes("acquisition-catalog-rights-v1"));
  const fpByTrackId = {};
  for (const track of TRACKS) {
    const fp = ethers.keccak256(ethers.toUtf8Bytes(track.id)); // stable — no timestamp
    fpByTrackId[track.id] = fp;
    const already = await artistRegistry.isRegistered(fp);
    if (already) {
      console.log(`  = ${track.id.padEnd(20)} already registered`);
      continue;
    }
    const wallet = artistWallets[track.artistKey];
    const tx = await artistRegistry.connect(wallet).registerTrack(fp, rightsHash);
    await tx.wait();
    console.log(`  + ${track.id.padEnd(20)} registered by artist ${track.artistKey}`);
  }

  const out = {
    network: network.name,
    timestamp: Math.floor(Date.now() / 1000),
    trainingCompensationDeployment: deployFile,
    company: { address: company.address },
    artists: Object.fromEntries(artistKeys.map((k) => [k, { address: artistWallets[k].address }])),
    fingerprintByTrackId: fpByTrackId,
  };
  const outPath = path.resolve(__dirname, `../deployments/${network.name}_acquisition_catalog.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[saved] ${outPath}`);
  console.log(`[saved] acquisition/.env (wallet keys, never printed to stdout)`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
