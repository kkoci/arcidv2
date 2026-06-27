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
 */

const {
  parseArgs,
  loadDeployment,
  getProvider,
  getContracts,
  formatUSDC,
} = require("./_lib");

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

  // Paginate in 9 000-block chunks to respect RPC eth_getLogs limits.
  const CHUNK = 9_000;
  const latest = await provider.getBlockNumber();
  const filter  = registry.filters.AgentRegistered();
  const events  = [];
  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end  = Math.min(start + CHUNK - 1, latest);
    const logs = await registry.queryFilter(filter, start, end);
    events.push(...logs);
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
