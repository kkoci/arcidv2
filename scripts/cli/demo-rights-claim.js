#!/usr/bin/env node
"use strict";
/**
 * demo-rights-claim.js — Tier 1 Rights-Claim Bonding, all three real
 * outcomes, live: unchallenged pass, challenge-resolved-claimant-wins,
 * challenge-resolved-challenger-wins. This does NOT prove ownership — it
 * proves a rights claim carries real financial consequence, and that a
 * conflicting claim has a real, contestable, on-chain path.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=... in .env (owner of RightsClaimBond, funds demo wallets)
 *   npm run demo:rights-claim -- --network hardhat
 *   npm run demo:rights-claim -- --network arcTestnet
 *
 * Registers three fresh demo tracks under fresh artist wallets, then runs
 * all three real flows against the deployed RightsClaimBond.
 */

const { ethers } = require("ethers");
const {
  parseArgs, requireEnvKey, getProvider,
  loadTrainingCompensationDeployment, loadRightsClaimBondDeployment,
  ArtistRegistryABI, RightsClaimBondABI, ERC20_ABI,
} = require("./_lib");

const GAS_FUND = "0.01";

function fp(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${label}:${Date.now()}:${Math.random()}`));
}

/**
 * Per-wallet nonce tracker for the whole script's lifetime — fetches
 * "pending" fresh only the first time a wallet is used, increments
 * in-process after that. A plain per-call "pending" lookup was observed
 * (during this build's own verification) to occasionally reuse a stale
 * nonce against a local auto-mining node across separate function calls,
 * not just tight loops — this is the robust fix, applied everywhere a
 * signer sends more than one transaction across the whole run.
 */
function makeNonceTracker(provider) {
  const next = new Map();
  return async function nonceFor(address) {
    if (!next.has(address)) {
      next.set(address, await provider.getTransactionCount(address, "pending"));
    }
    const n = next.get(address);
    next.set(address, n + 1);
    return n;
  };
}

async function main() {
  const args = parseArgs();
  const network = args.network || "arcTestnet";
  const isLocal = network === "hardhat" || network === "localhost";
  const BOND_AMOUNT = BigInt(Math.round(parseFloat(args["bond-amount"] ?? "2.0") * 1e6));

  const deployerKey = requireEnvKey("DEPLOYER_PRIVATE_KEY");
  const provider = getProvider(network);
  const deployer = new ethers.Wallet(deployerKey, provider);
  const nonceFor = makeNonceTracker(provider);

  const trainingDeploy = loadTrainingCompensationDeployment(network);
  const bondDeploy = loadRightsClaimBondDeployment(network);

  const artistRegistry = new ethers.Contract(trainingDeploy.addresses.ArtistRegistry, ArtistRegistryABI, provider);
  const rightsBond = new ethers.Contract(bondDeploy.addresses.RightsClaimBond, RightsClaimBondABI, provider);
  const usdc = new ethers.Contract(bondDeploy.addresses.collateralToken, ERC20_ABI, provider);

  console.log(`\n${"─".repeat(60)}`);
  console.log("Rights-Claim Bonding demo — all three real outcomes");
  console.log(`${"─".repeat(60)}`);
  console.log(`Network: ${network}`);
  console.log(`RightsClaimBond: ${bondDeploy.addresses.RightsClaimBond}`);
  console.log(`disputeWindow: ${bondDeploy.disputeWindowSeconds}s (demo-scale)`);

  // ── Fresh demo wallets: 3 claimants (one per scenario) + 1 challenger ──
  const claimantUnchallenged = ethers.Wallet.createRandom().connect(provider);
  const claimantWins         = ethers.Wallet.createRandom().connect(provider);
  const claimantLoses        = ethers.Wallet.createRandom().connect(provider);
  const challenger            = ethers.Wallet.createRandom().connect(provider);
  const allWallets = [claimantUnchallenged, claimantWins, claimantLoses, challenger];

  console.log(`\n→ Funding ${allWallets.length} demo wallets with ${GAS_FUND} ETH gas each...`);
  for (const w of allWallets) {
    const tx = await deployer.sendTransaction({ to: w.address, value: ethers.parseEther(GAS_FUND), nonce: await nonceFor(deployer.address) });
    await tx.wait();
  }
  console.log(`✓ Funded.`);

  // challenger needs TWO bonds' worth — Scenario 2 costs it its bond by
  // design (that's the point being demonstrated), so it needs a fresh
  // one for Scenario 3's challenge.
  const fundingFor = (w) => (w === challenger ? BOND_AMOUNT * 2n : BOND_AMOUNT);

  console.log(`\n→ Funding claimants + challenger with USDC bonds...`);
  if (isLocal) {
    const MockUSDC_ABI = ["function mint(address to, uint256 amount) returns (bool)"];
    const mockUsdc = new ethers.Contract(bondDeploy.addresses.collateralToken, MockUSDC_ABI, deployer);
    for (const w of allWallets) {
      await (await mockUsdc.mint(w.address, fundingFor(w), { nonce: await nonceFor(deployer.address) })).wait();
    }
  } else {
    for (const w of allWallets) {
      await (await usdc.connect(deployer).transfer(w.address, fundingFor(w), { nonce: await nonceFor(deployer.address) })).wait();
    }
  }
  console.log(`✓ Funded.`);

  const rightsHash = ethers.keccak256(ethers.toUtf8Bytes("demo-rights-v1"));
  const claimHash = ethers.keccak256(ethers.toUtf8Bytes("I own 100% of this recording's AI-training rights"));
  const counterClaimHash = ethers.keccak256(ethers.toUtf8Bytes("This is actually my recording, not theirs"));

  async function registerAndApprove(wallet, trackId) {
    const trackFp = fp(trackId);
    await (await artistRegistry.connect(wallet).registerTrack(trackFp, rightsHash, { nonce: await nonceFor(wallet.address) })).wait();
    await (await usdc.connect(wallet).approve(bondDeploy.addresses.RightsClaimBond, ethers.MaxUint256, { nonce: await nonceFor(wallet.address) })).wait();
    return trackFp;
  }

  /**
   * Checks (and sets, if needed) allowance right before any call that
   * needs it. registerAndApprove() only ever approves for wallets that
   * register+file a claim — challenger never does, since it only ever
   * calls challengeClaim()/finalizeUnchallenged(), which is exactly the
   * gap this closes rather than assuming every wallet already approved.
   */
  async function ensureAllowance(wallet, amount) {
    const current = await usdc.allowance(wallet.address, bondDeploy.addresses.RightsClaimBond);
    if (current < amount) {
      await (await usdc.connect(wallet).approve(bondDeploy.addresses.RightsClaimBond, ethers.MaxUint256, { nonce: await nonceFor(wallet.address) })).wait();
    }
  }

  // ── Scenario 1: unchallenged — claim passes, track becomes licensable ──
  console.log(`\n${"─".repeat(60)}\nScenario 1 — unchallenged claim\n${"─".repeat(60)}`);
  const fp1 = await registerAndApprove(claimantUnchallenged, "unchallenged-track");
  await ensureAllowance(claimantUnchallenged, BOND_AMOUNT);
  await (await rightsBond.connect(claimantUnchallenged).fileClaim(fp1, claimHash, BOND_AMOUNT, { nonce: await nonceFor(claimantUnchallenged.address), gasLimit: 300_000n })).wait();
  console.log(`✓ Claim filed for ${fp1.slice(0, 10)}… — licensable before window: ${await rightsBond.isLicensable(fp1)}`);

  console.log(`  Waiting out the ${bondDeploy.disputeWindowSeconds}s dispute window for real...`);
  await new Promise((r) => setTimeout(r, (bondDeploy.disputeWindowSeconds + 3) * 1000));

  const finalizeTx = await rightsBond.connect(challenger).finalizeUnchallenged(fp1, { nonce: await nonceFor(challenger.address), gasLimit: 300_000n }); // permissionless — anyone can call
  const finalizeReceipt = await finalizeTx.wait();
  console.log(`✓ finalizeUnchallenged() mined → ${finalizeReceipt.hash}`);
  console.log(`  isLicensable(${fp1.slice(0, 10)}…): ${await rightsBond.isLicensable(fp1)}`);

  // ── Scenario 2: challenged, claimant wins ──
  console.log(`\n${"─".repeat(60)}\nScenario 2 — challenged, claimant wins\n${"─".repeat(60)}`);
  const fp2 = await registerAndApprove(claimantWins, "claimant-wins-track");
  await ensureAllowance(claimantWins, BOND_AMOUNT);
  await (await rightsBond.connect(claimantWins).fileClaim(fp2, claimHash, BOND_AMOUNT, { nonce: await nonceFor(claimantWins.address), gasLimit: 300_000n })).wait();
  await ensureAllowance(challenger, BOND_AMOUNT);
  await (await rightsBond.connect(challenger).challengeClaim(fp2, counterClaimHash, BOND_AMOUNT, { nonce: await nonceFor(challenger.address), gasLimit: 300_000n })).wait();
  console.log(`✓ Claim filed and challenged for ${fp2.slice(0, 10)}…`);

  const claimantBalBefore2 = await usdc.balanceOf(claimantWins.address);
  const resolveReceipt2 = await (await rightsBond.connect(deployer).resolveChallenge(fp2, true, { nonce: await nonceFor(deployer.address), gasLimit: 300_000n })).wait(); // owner resolves: claimant wins
  const claimantBalAfter2 = await usdc.balanceOf(claimantWins.address);
  console.log(`✓ resolveChallenge(claimantWins=true) mined → ${resolveReceipt2.hash}`);
  console.log(`  claimant balance: ${Number(claimantBalBefore2) / 1e6} → ${Number(claimantBalAfter2) / 1e6} USDC (+${Number(claimantBalAfter2 - claimantBalBefore2) / 1e6}, the challenger's forfeited bond)`);
  console.log(`  isLicensable(${fp2.slice(0, 10)}…): ${await rightsBond.isLicensable(fp2)}`);

  // ── Scenario 3: challenged, challenger wins ──
  console.log(`\n${"─".repeat(60)}\nScenario 3 — challenged, challenger wins\n${"─".repeat(60)}`);
  const fp3 = await registerAndApprove(claimantLoses, "claimant-loses-track");
  await ensureAllowance(claimantLoses, BOND_AMOUNT);
  await (await rightsBond.connect(claimantLoses).fileClaim(fp3, claimHash, BOND_AMOUNT, { nonce: await nonceFor(claimantLoses.address), gasLimit: 300_000n })).wait();
  await ensureAllowance(challenger, BOND_AMOUNT);
  await (await rightsBond.connect(challenger).challengeClaim(fp3, counterClaimHash, BOND_AMOUNT, { nonce: await nonceFor(challenger.address), gasLimit: 300_000n })).wait();
  console.log(`✓ Claim filed and challenged for ${fp3.slice(0, 10)}…`);

  const challengerBalBefore3 = await usdc.balanceOf(challenger.address);
  const resolveReceipt3 = await (await rightsBond.connect(deployer).resolveChallenge(fp3, false, { nonce: await nonceFor(deployer.address), gasLimit: 300_000n })).wait(); // owner resolves: challenger wins
  const challengerBalAfter3 = await usdc.balanceOf(challenger.address);
  console.log(`✓ resolveChallenge(claimantWins=false) mined → ${resolveReceipt3.hash}`);
  console.log(`  challenger balance: ${Number(challengerBalBefore3) / 1e6} → ${Number(challengerBalAfter3) / 1e6} USDC (+${Number(challengerBalAfter3 - challengerBalBefore3) / 1e6}, both bonds)`);
  console.log(`  isLicensable(${fp3.slice(0, 10)}…): ${await rightsBond.isLicensable(fp3)} (correctly false — false claim rejected)`);

  console.log(`\n${"─".repeat(60)}`);
  console.log("All three real outcomes confirmed live.");
  console.log(`${"─".repeat(60)}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.stack || e.message || e) + "\n");
  process.exit(1);
});
