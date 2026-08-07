/**
 * bounty/harness.js — Proof-of-Exploit harness.
 *
 * Runs the exploit against a FRESH LOCAL DEPLOYMENT of VulnerableVault (see
 * contracts/vulnerable/) — NOT a fork of the target's live on-chain state.
 * Forking Arc testnet's live RPC was explicitly cut for time (see README's
 * Proof-of-Exploit section); this is that documented, deliberate interim,
 * not a silent downgrade.
 *
 * The exploit-and-invariant-check loop is ported unchanged from
 * spike/proof-of-exploit/, where it was already proven end to end (both
 * directions: catches the real bug, clears the patched negative control).
 * This file adds the real registered wallet + real on-chain
 * ExploitBounty.submitVerdict() call on top of that proven loop.
 *
 * Trust boundary (same pattern as the price-oracle vertical's
 * price-signing / LLM adjudication — see README's "Trust Boundary" section):
 * nothing here runs inside a TEE. The verifier wallet's TEE-residency was
 * proven ONCE, separately, at registration time (scripts/deploy_exploit_bounty.js,
 * same DCAP-attestation flow the price-oracle wallet used) — trust in this
 * verdict is transitive from that registration, not from this process
 * re-entering an enclave per submission.
 *
 * Two independent network contexts in this one process, deliberately not
 * conflated:
 *   - `hre.ethers` (bound to whatever --network the outer `hardhat run`
 *     invocation used) — ALWAYS `hardhat` here, regardless of where the
 *     verdict lands. This is the disposable local network the exploit
 *     itself runs against.
 *   - A separate, independent `hre.ethers.JsonRpcProvider` pointed at Arc
 *     testnet — used only for the final submitVerdict() call. It is not
 *     hre.ethers.provider and does not care what --network was passed.
 *
 * Usage (from repo root):
 *   BOUNTY_TARGET_ID=1 BOUNTY_RESEARCHER=0x... \
 *     npx hardhat run bounty/harness.js --network hardhat
 *
 *   # Negative control — runs against VulnerableVaultFixed instead; the
 *   # invariant should NOT trigger, so no payout should occur:
 *   BOUNTY_TARGET_ID=1 BOUNTY_RESEARCHER=0x... BOUNTY_MODE=control \
 *     npx hardhat run bounty/harness.js --network hardhat
 *
 * Required env (.env, project root):
 *   BOUNTY_VERIFIER_PRIVATE_KEY   the registered, TEE-attested verifier wallet
 *                                 (provisioned by scripts/deploy_exploit_bounty.js) —
 *                                 read from .env only, never a CLI argument,
 *                                 same rule as everywhere else in this repo.
 *   BOUNTY_TARGET_ID              which registered target to submit against
 *   BOUNTY_RESEARCHER             payout address if the exploit is confirmed
 *   BOUNTY_MODE                   "exploit" (default) | "control"
 */

"use strict";
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");

const ARC_TESTNET_CHAIN_ID = 5042002;

// Must match whatever invariantId scripts/cli/bounty-register-target.js used
// when registering the target — a mismatch is rejected on-chain
// (InvariantMismatch), not just silently ignored.
const INVARIANT_LABEL = "reentrancy-drain-v1";

const BOUNTY_ABI = [
  "function submitVerdict(uint256 targetId, address researcher, bool exploitConfirmed, bytes32 invariantId, bytes32 evidenceHash, string calldata rationale) external",
  "function targets(uint256) view returns (address owner, address targetContract, bytes32 invariantId, uint256 bountyAmount, bool claimed, bool withdrawn)",
];

function loadDeployment(network) {
  const p = path.resolve(__dirname, "..", "deployments", `${network}_exploit_bounty.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${p} — run \`npx hardhat run scripts/deploy_exploit_bounty.js --network ${network}\` first.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function requireEnvKey(name) {
  const raw = process.env[name];
  if (!raw) {
    console.error(`\nMissing required env var: ${name}`);
    console.error(`Set it in .env (project root) — private keys are never passed as CLI arguments.\n`);
    process.exit(1);
  }
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

// ---------------------------------------------------------------------------
// Step 1 — run the exploit against a fresh local deployment. Unchanged logic
// from spike/proof-of-exploit/run.js, already proven there.
// ---------------------------------------------------------------------------
async function runExploit(vaultContractName) {
  const { ethers } = hre;

  const [deployer, victim1, victim2, victim3] = await ethers.getSigners();

  const Vault = await ethers.getContractFactory(vaultContractName);
  const vault = await Vault.deploy();
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  const depositAmt = ethers.parseEther("1.0");
  for (const victim of [victim1, victim2, victim3]) {
    await (await vault.connect(victim).deposit({ value: depositAmt })).wait();
  }

  const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
  const attacker = await Attacker.deploy(vaultAddress);
  await attacker.waitForDeployment();
  const attackerAddress = await attacker.getAddress();

  const attackerDeposit = ethers.parseEther("1.0");
  try {
    await (await attacker.connect(deployer).attack({ value: attackerDeposit })).wait();
  } catch {
    // A genuinely non-vulnerable target reverting the whole attack tx also
    // correctly means "no breach" — see ReentrancyAttacker.sol's own comment.
  }

  const attackerBalanceAfter = await ethers.provider.getBalance(attackerAddress);
  const breach = attackerBalanceAfter > attackerDeposit;

  return {
    vaultContract: vaultContractName,
    vaultAddress,
    attackerAddress,
    attackerDepositWei: attackerDeposit.toString(),
    attackerBalanceAfterWei: attackerBalanceAfter.toString(),
    breach,
    reason: breach
      ? `Attacker contract ended with ${ethers.formatEther(attackerBalanceAfter)} ETH after depositing only ${ethers.formatEther(attackerDeposit)} ETH -- reentrancy drain confirmed against a fresh local deployment of ${vaultContractName}.`
      : `Attacker contract ended with ${ethers.formatEther(attackerBalanceAfter)} ETH, at or below its ${ethers.formatEther(attackerDeposit)} ETH deposit -- no drain, invariant holds for ${vaultContractName}.`,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — sign + submit the verdict on Arc testnet, via an independent
// provider/wallet (not hre.ethers.provider, which stays bound to the local
// --network hardhat used for the exploit above).
// ---------------------------------------------------------------------------
async function submitOnChain({ targetId, researcher, exploitConfirmed, reason, verifierKey, deployment }) {
  const { ethers } = hre;
  const invariantId = ethers.id(INVARIANT_LABEL);

  const arcProvider = new ethers.JsonRpcProvider(
    process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
    { chainId: ARC_TESTNET_CHAIN_ID, name: "arcTestnet" },
    { staticNetwork: true }
  );
  const verifierWallet = new ethers.Wallet(verifierKey, arcProvider);
  const bounty = new ethers.Contract(deployment.addresses.ExploitBounty, BOUNTY_ABI, verifierWallet);

  const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(reason));

  console.log(`\n→ Submitting verdict on Arc testnet...`);
  console.log(`  ExploitBounty: ${deployment.addresses.ExploitBounty}`);
  console.log(`  Verifier:      ${verifierWallet.address}`);
  console.log(`  targetId:      ${targetId}`);
  console.log(`  researcher:    ${researcher}`);
  console.log(`  confirmed:     ${exploitConfirmed}`);

  const tx = await bounty.submitVerdict(targetId, researcher, exploitConfirmed, invariantId, evidenceHash, reason);
  const receipt = await tx.wait();

  console.log(`✓ submitVerdict() mined → ${receipt.hash}`);
  return receipt.hash;
}

// ---------------------------------------------------------------------------
async function main() {
  const network = "arcTestnet";

  const targetId = process.env.BOUNTY_TARGET_ID;
  if (!targetId) throw new Error("Set BOUNTY_TARGET_ID (env) to the registered target's id.");

  const researcher = process.env.BOUNTY_RESEARCHER;
  if (!researcher) throw new Error("Set BOUNTY_RESEARCHER (env) to the researcher payout address.");

  const mode = process.env.BOUNTY_MODE || "exploit"; // "exploit" | "control"
  const verifierKey = requireEnvKey("BOUNTY_VERIFIER_PRIVATE_KEY");
  const deployment  = loadDeployment(network);

  console.log(`Proof-of-Exploit harness — mode: ${mode}`);

  const t0 = Date.now();
  const vaultContract = mode === "control" ? "VulnerableVaultFixed" : "VulnerableVault";
  const result = await runExploit(vaultContract);
  const tExploit = Date.now();

  console.log(`\n${JSON.stringify(result, null, 2)}`);
  console.log(`Exploit phase: ${tExploit - t0}ms`);

  const txHash = await submitOnChain({
    targetId,
    researcher,
    exploitConfirmed: result.breach,
    reason: result.reason,
    verifierKey,
    deployment,
  });

  console.log(`\nTotal harness time: ${Date.now() - t0}ms`);
  console.log(`Arc testnet tx: https://testnet.arcscan.app/tx/${txHash}`);
}

// Only auto-run when invoked directly (`hardhat run bounty/harness.js`) —
// bounty/server.js requires runExploit/submitOnChain directly instead, so
// it doesn't shell out to a second process per HTTP request.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { runExploit, submitOnChain, loadDeployment, requireEnvKey, INVARIANT_LABEL };
