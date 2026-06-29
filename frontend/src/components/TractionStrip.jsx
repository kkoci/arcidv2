const s = {
  strip: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: "1px",
    background: "#1e1e2e",
    borderBottom: "1px solid #1e1e2e",
  },
  cell: {
    background: "#111118",
    padding: "16px 20px",
    transition: "background 0.2s",
  },
  label: {
    color: "#6b6b8a",
    fontSize: "10px",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    marginBottom: "6px",
    fontWeight: "600",
  },
  value: {
    fontSize: "22px",
    fontWeight: "700",
    color: "#e2e8f0",
    fontFamily: "'JetBrains Mono', monospace",
    lineHeight: 1,
  },
  sub: {
    fontSize: "10px",
    marginTop: "4px",
  },
};

export default function TractionStrip({ stats, chainStats, loading }) {
  if (loading) {
    return (
      <div style={{ ...s.cell, textAlign: "center", color: "#6b6b8a", gridColumn: "1/-1" }}>
        connecting…
      </div>
    );
  }

  const activeAgents = chainStats?.summary?.activeAgents ?? stats.activeBonds ?? "—";
  const tvlRaw       = chainStats?.summary?.tvlUsdc;
  const tvlDisplay   = tvlRaw != null ? `$${(Number(tvlRaw) / 1e6).toFixed(2)}` : "—";
  const slashCount   = chainStats?.summary?.totalSlashes ?? stats.slashCount ?? 0;

  return (
    <div style={s.strip}>
      <Stat label="Skin in the game"  value={activeAgents} sub="bonded agents on Arc" />
      <Stat label="USDC at stake"     value={tvlDisplay}   sub="collateral locked"       color="#22d3ee" />
      <Stat label="Paid queries"      value={stats.totalCalls ?? 0} sub="x402 nanopayments" />
      <Stat label="SLAs upheld"       value={stats.okCount ?? 0}    sub="clean adjudications" color="#34d399" />
      <Stat
        label="Cheaters caught"
        value={slashCount}
        sub="bonds seized on-chain"
        color={slashCount > 0 ? "#ef4444" : "#6b6b8a"}
        borderLeft={slashCount > 0 ? "2px solid #ef4444" : "2px solid transparent"}
        highlight={slashCount > 0}
      />
    </div>
  );
}

function Stat({ label, value, sub, color, borderLeft, highlight }) {
  return (
    <div style={{ ...s.cell, borderLeft: borderLeft || "2px solid transparent" }}>
      <div style={{ ...s.label, color: highlight ? "#ef4444" : "#6b6b8a" }}>{label}</div>
      <div style={{ ...s.value, color: color || "#e2e8f0", fontSize: highlight ? "26px" : "22px" }}>{value}</div>
      <div style={{ ...s.sub, color: color ? `${color}99` : "#6b6b8a" }}>{sub}</div>
    </div>
  );
}
