"use strict";
/**
 * bounty-submit.js — CLI entrypoint for the Proof-of-Exploit harness.
 *
 * Standard scripts/cli/*.js flag conventions on the outside (--target-id,
 * --researcher, --mode — none of these are secrets, all fine as CLI args
 * per CLAUDE.md's rule, which is specifically about private keys). Under
 * the hood this shells out to `hardhat run bounty/harness.js --network
 * hardhat` — stated plainly, not hidden — because running the actual
 * exploit needs a real local EVM, which only Hardhat's own runtime
 * provides; every other scripts/cli/*.js tool talks to already-deployed
 * contracts via a plain ethers provider and has no such need. The
 * on-chain submitVerdict() call inside the harness still targets real Arc
 * testnet, via its own independent connection — see bounty/harness.js.
 *
 * This is the fallback demo path if the frontend card runs short on time —
 * output is deliberately readable standalone, not an afterthought.
 *
 * Usage:
 *   BOUNTY_VERIFIER_PRIVATE_KEY=... in .env (never a CLI argument), then:
 *   npm run bounty:submit -- --target-id 1 --researcher 0xYourAddress
 *   npm run bounty:submit -- --target-id 1 --researcher 0xYourAddress --mode control
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs() {
  const args = process.argv.slice(2);
  const out  = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key  = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

function requireEnvKey(name) {
  const raw = process.env[name];
  if (!raw) {
    console.error(`\nMissing required env var: ${name}`);
    console.error(`Set it in .env (project root) — private keys are never passed as CLI arguments.\n`);
    process.exit(1);
  }
  return raw;
}

function main() {
  const args = parseArgs();

  const targetId = args["target-id"];
  if (!targetId) {
    console.error("\nMissing required flag: --target-id\n");
    process.exit(1);
  }

  const researcher = args.researcher;
  if (!researcher) {
    console.error("\nMissing required flag: --researcher\n");
    process.exit(1);
  }

  const mode = args.mode || "exploit"; // "exploit" | "control"

  // Fail fast with the standard, clear error before spawning anything.
  requireEnvKey("BOUNTY_VERIFIER_PRIVATE_KEY");

  console.log(`\n→ Running Proof-of-Exploit harness (mode: ${mode})`);
  console.log(`  target-id:  ${targetId}`);
  console.log(`  researcher: ${researcher}`);
  console.log(`  (shelling out to \`hardhat run bounty/harness.js --network hardhat\` —`);
  console.log(`   the exploit needs a real local EVM, only Hardhat's runtime provides one;`);
  console.log(`   the on-chain submission itself still targets real Arc testnet.)\n`);

  const repoRoot = path.resolve(__dirname, "../..");

  // shell: true is required for npx resolution on Windows (spawnSync fails
  // with EINVAL trying to exec npx.cmd directly otherwise). Safe here since
  // every argv entry is a hardcoded constant, not user input — the
  // target-id/researcher/mode values are passed via `env`, never through
  // this argv array.
  const result = spawnSync(
    "npx",
    ["hardhat", "run", "bounty/harness.js", "--network", "hardhat"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        BOUNTY_TARGET_ID:  targetId,
        BOUNTY_RESEARCHER: researcher,
        BOUNTY_MODE:       mode,
      },
    }
  );

  process.exit(result.status ?? 1);
}

main();
