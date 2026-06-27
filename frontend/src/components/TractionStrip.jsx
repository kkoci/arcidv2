const s = {
  strip:  { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "1px", background: "#1e1e2e", borderBottom: "1px solid #1e1e2e" },
  cell:   { background: "#111118", padding: "16px 20px" },
  label:  { color: "#6b6b8a", fontSize: "10px", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "6px" },
  value:  { fontSize: "22px", fontWeight: "700", color: "#e2e2f0" },
  sub:    { fontSize: "10px", color: "#6b6b8a", marginTop: "2px" },
};

export default function TractionStrip({ stats, chainStats, loading }) {
  if (loading) return <div style={{ ...s.cell, textAlign: "center", color: "#6b6b8a" }}>connecting…</div>;

  // Prefer on-chain data from chainStats; fall back to oracle in-memory stats
  const activeAgents = chainStats?.summary?.activeAgents ?? stats.activeBonds ?? "—";
  const tvlRaw       = chainStats?.summary?.tvlUsdc;
  const tvlDisplay   = tvlRaw != null
    ? `$${(Number(tvlRaw) / 1e6).toFixed(2)}`
    : "—";
  const slashCount   = chainStats?.summary?.totalSlashes ?? stats.slashCount ?? 0;

  return (
    <div style={s.strip}>
      <Stat label="Bonded Agents"   value={activeAgents}                   sub="TEE-verified on Arc" />
      <Stat label="Bond TVL"        value={tvlDisplay}                     sub="USDC in ArcIDBond"   color="#22d3ee" />
      <Stat label="Total Calls"     value={stats.totalCalls ?? 0}          sub="x402 nanopayments" />
      <Stat label="OK Verdicts"     value={stats.okCount ?? 0}             sub="adjudicator restrained" color="#22c55e" />
      <Stat label="Slash Events"    value={slashCount}                     sub="bonds seized on-chain"
            color={slashCount > 0 ? "#ef4444" : undefined} />
    </div>
  );
}

function Stat({ label, value, sub, color }) {
  return (
    <div style={s.cell}>
      <div style={s.label}>{label}</div>
      <div style={{ ...s.value, color: color || "#e2e2f0" }}>{value}</div>
      <div style={s.sub}>{sub}</div>
    </div>
  );
}
