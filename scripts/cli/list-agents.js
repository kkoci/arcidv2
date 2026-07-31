"use strict";
/**
 * list-agents.js — List all registered agents and their bond status.
 *
 * Usage:
 *   npm run agent:list [-- --network arcTestnet] [-- --from-block <n>]
 *
 * Queries AgentRegistered events from ArcIDRegistryV2 starting from the
 * block saved in deployments/<network>_standalone.json (or 0 if absent).
 * Override with --from-block if the RPC limits query range.
 *
 * Read-only — no private key required.
 *
 * This is a rare, manually-invoked tool, not something polled routinely —
 * unlike oracle/src/chain.js's getChainStats() (see CHANGELOG.md's arcid2
 * Phase 6.4 entry), it does NOT need incremental scan caching; a full scan
 * on each manual run is fine. It DOES need the chunk size to actually fit
 * the RPC's per-call eth_getLogs limit (ARC_LOG_CHUNK_SIZE, same env var
 * chain.js reads — Alchemy's free tier caps this at 10) and basic retry so
 * one transient failure partway through a many-chunk scan doesn't abort the
 * whole command with zero results.
 */

const {
  parseArgs,
  loadDeployment,
  getProvider,
  getContracts,
  formatUSDC,
} = require("./_lib");

const CHUNK = parseInt(process.env.ARC_LOG_CHUNK_SIZE || "10", 10);
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same shape as chain.js's withBackoff() — kept as a small self-contained
// copy rather than a shared import, since scripts/cli/ and oracle/ are
// separate packages with no existing cross-import relationship.
async function withBackoff(fn) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt > MAX_RETRIES) throw e;
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(`  [retry] chunk query failed (attempt ${attempt}/${MAX_RETRIES}): ${e.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function main() {
  const args    = parseArgs();
  const network = args.network || "arcTestnet";
  const deploy  = loadDeployment(network);

  const fromBlock = args["from-block"]
    ? parseInt(args["from-block"], 10)
    : deploy.deployBlock ?? 0;

  const provider = getProvider(network);
  const { registry, bond } = getContracts(deploy.addresses, provider);

  console.log(`\n→ Listing agents on ${network} (from block ${fromBlock})`);
  console.log(`  ArcIDRegistryV2: ${deploy.addresses.ArcIDRegistryV2}`);

  const latest = await withBackoff(() => provider.getBlockNumber());
  const filter  = registry.filters.AgentRegistered();
  const events  = [];
  const totalChunks = Math.max(1, Math.ceil((latest - fromBlock + 1) / CHUNK));
  let chunkNum = 0;
  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end  = Math.min(start + CHUNK - 1, latest);
    chunkNum++;
    if (chunkNum === 1 || chunkNum % 50 === 0 || chunkNum === totalChunks) {
      console.log(`  scanning chunk ${chunkNum}/${totalChunks} (blocks ${start}-${end})...`);
    }
    const logs = await withBackoff(() => registry.queryFilter(filter, start, end));
    events.push(...logs);
    if (end < latest) await sleep(200); // pacing between successful calls — see chain.js's identical reasoning
  }

  if (events.length === 0) {
    console.log("\n  No agents registered yet.\n");
    return;
  }

  const COL = { n: 4, addr: 44, id: 22, bonded: 8, amount: 12 };
  const line = (n, addr, id, bonded, amount) =>
    `  ${n.padEnd(COL.n)}  ${addr.padEnd(COL.addr)}  ${id.padEnd(COL.id)}  ${bonded.padEnd(COL.bonded)}  ${amount}`;

  console.log("\n" + line("#", "Address", "AgentId (prefix)", "Bonded", "Amount"));
  console.log(
    "  " +
      "─".repeat(COL.n) +
      "  " +
      "─".repeat(COL.addr) +
      "  " +
      "─".repeat(COL.id) +
      "  " +
      "─".repeat(COL.bonded) +
      "  " +
      "─".repeat(COL.amount)
  );

  for (let i = 0; i < events.length; i++) {
    const ev       = events[i];
    const address  = ev.args.attestedSigner;
    const agentId  = ev.args.agentId;
    const bondInfo = await bond.bonds(address);
    const isActive = await bond.isActiveBondedAgent(address);

    const bonded = isActive
      ? "yes ✓"
      : bondInfo.slashed
      ? "slashed"
      : "no";
    const amount =
      bondInfo.postedAt !== 0n ? formatUSDC(bondInfo.amount) : "—";

    console.log(
      line(
        String(i + 1),
        address,
        agentId.slice(0, 18) + "...",
        bonded,
        amount
      )
    );
  }

  console.log(`\n  Total: ${events.length} agent${events.length !== 1 ? "s" : ""}\n`);
}

main().catch((e) => {
  console.error("\n" + (e.message || e) + "\n");
  process.exit(1);
});
