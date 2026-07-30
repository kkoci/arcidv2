"use strict";
/**
 * slash.js — Slash a bonded agent's collateral.
 *
 * Usage:
 *   SLASHER_PRIVATE_KEY=... in .env, then:
 *   npm run bond:slash -- \
 *     --agent <agent-address> \
 *     --consumer <consumer-address> \
 *     --reason "<rationale text>" \
 *     --breach-class <hard|semantic> \
 *     [--network arcTestnet]
 *
 * The private key is read ONLY from the SLASHER_PRIVATE_KEY env var (.env)
 * — never accepted as a CLI argument. See CLAUDE.md's private-key rule.
 *
 * --breach-class is required, no default (tiered adjudication Phase 4/5 —
 * see CHANGELOG.md): "hard" = Tier 1 deterministic (mechanical failure —
 * signature/timestamp/schema), "semantic" = Tier 2 (LLM judgment). ArcIDBond
 * computes the actual slash amount internally from this classification —
 * this script never supplies or influences an amount.
 *
 * Caller must be the authorizedSlasher on ArcIDBond. The script warns but
 * does not block if the key doesn't match — the on-chain call will revert
 * and show the exact error.
 *
 * The --reason string goes on-chain in the AgentSlashed event, exactly as
 * the consumer agent would write it after adjudication (either tier).
 */

const { ethers } = require("ethers");
const {
  parseArgs,
  requireEnvKey,
  loadDeployment,
  getProvider,
  getContracts,
  formatUSDC,
} = require("./_lib");

const BREACH_CLASS = { hard: 1, semantic: 0 };

async function main() {
  const args = parseArgs();
  const key  = requireEnvKey("SLASHER_PRIVATE_KEY");

  const breachClassArg = args["breach-class"];
  if (!args.agent || !args.consumer || !args.reason || !breachClassArg) {
    console.error(
      "\nUsage: npm run bond:slash -- " +
        "--agent <addr> --consumer <addr> --reason \"<text>\" --breach-class <hard|semantic> " +
        "[--network arcTestnet]\n"
    );
    process.exit(1);
  }
  const breachClass = BREACH_CLASS[breachClassArg.toLowerCase()];
  if (breachClass === undefined) {
    console.error(`\n✗ --breach-class must be "hard" or "semantic", got "${breachClassArg}"\n`);
    process.exit(1);
  }

  const network  = args.network || "arcTestnet";
  const provider = getProvider(network);
  const wallet   = new ethers.Wallet(key, provider);
  const deploy   = loadDeployment(network);
  const { bond } = getContracts(deploy.addresses, wallet);

  console.log(`\n→ Slashing agent ${args.agent} on ${network}`);
  console.log(`  ArcIDBond:    ${deploy.addresses.ArcIDBond}`);
  console.log(`  Caller:       ${wallet.address}`);
  console.log(`  Consumer:     ${args.consumer}`);
  console.log(`  BreachClass:  ${breachClassArg} (${breachClass})`);
  console.log(`  Reason:       "${args.reason}"`);

  // Warn if caller is not the authorized slasher (the on-chain call will
  // revert with NotAuthorizedSlasher — this just surfaces it earlier).
  const slasher = await bond.authorizedSlasher();
  if (slasher.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(
      `\n  WARNING: authorizedSlasher is ${slasher}` +
        `\n           caller is           ${wallet.address}` +
        `\n           The transaction will revert on-chain.\n`
    );
  }

  // Pre-flight bond check
  const bondInfo = await bond.bonds(args.agent);
  if (bondInfo.postedAt === 0n) {
    console.error(`\n✗ No bond found for ${args.agent}\n`);
    process.exit(1);
  }
  if (bondInfo.slashed) {
    console.error(`\n✗ Bond for ${args.agent} is already slashed\n`);
    process.exit(1);
  }
  console.log(`  Bond remaining: ${formatUSDC(bondInfo.amount)}`);

  // Preview before sending — same on-chain formula slash() itself uses
  // (ArcIDBond.previewSlash(), Phase 4), so the actual transferred amount
  // is never a surprise.
  const [previewAmount, wouldEscalate] = await bond.previewSlash(args.agent, breachClass);
  console.log(`  Preview:        ${formatUSDC(previewAmount)}${wouldEscalate ? " (ESCALATES — full remaining bond + permanent blacklist)" : ""}`);

  const tx      = await bond.slash(args.agent, args.consumer, args.reason, breachClass);
  const receipt = await tx.wait();

  const slashedEvent = receipt.logs
    .map((l) => { try { return bond.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "AgentSlashed");
  const actualAmount = slashedEvent ? slashedEvent.args.amount : null;

  console.log(`\n✓ slash() mined → ${receipt.hash}`);
  console.log(
    `  ${actualAmount !== null ? formatUSDC(actualAmount) : "?"} transferred to consumer ${args.consumer}\n`
  );
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
