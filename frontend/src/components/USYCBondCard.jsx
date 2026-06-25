const s = {
  card:      { background: "#111118", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "20px" },
  header:    { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" },
  title:     { fontSize: "11px", color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.1em" },
  badgeWrap: { display: "flex", gap: "6px" },
  badge:     (c) => ({
    padding: "3px 10px", borderRadius: "99px", fontSize: "11px", fontWeight: "700",
    background: c + "20", color: c, border: `1px solid ${c}40`,
  }),
  grid:      { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "16px" },
  cell:      { background: "#0a0a0f", borderRadius: "6px", padding: "10px 12px" },
  cellLabel: { fontSize: "10px", color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.08em" },
  cellVal:   { fontSize: "13px", marginTop: "3px" },
  addr:      { fontSize: "10px", color: "#a855f7", wordBreak: "break-all", marginTop: "4px", fontFamily: "monospace" },
  narrative: {
    background: "#0d0d1a", border: "1px solid #2e2040", borderRadius: "6px",
    padding: "12px 14px", fontSize: "11px", color: "#c4b5fd", lineHeight: "1.7",
  },
  narrativeTitle: { fontWeight: "700", color: "#a855f7", marginBottom: "4px" },
  pill:      { display: "inline-block", fontSize: "10px", padding: "2px 8px", borderRadius: "99px",
               background: "#a855f720", color: "#a855f7", border: "1px solid #a855f740", marginRight: "4px" },
  link:      { color: "#a855f7", textDecoration: "none", fontSize: "10px" },
};

export default function USYCBondCard({ usyc }) {
  const bondAddr  = usyc?.bond   ?? null;
  const tokenAddr = usyc?.token  ?? "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C";
  const teller    = usyc?.teller ?? "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A";
  const deployed  = !!bondAddr;

  return (
    <div style={s.card}>
      <div style={s.header}>
        <div style={s.title}>USYC Bond · Phase 5</div>
        <div style={s.badgeWrap}>
          <span style={s.badge("#a855f7")}>yield-bearing</span>
          <span style={s.badge(deployed ? "#22c55e" : "#f59e0b")}>
            {deployed ? "● deployed" : "⏳ allowlist pending"}
          </span>
        </div>
      </div>

      <div style={s.grid}>
        <Cell label="Collateral token" val="USYC" sub={shorten(tokenAddr)} color="#a855f7" />
        <Cell label="Teller"           val="Hashnote" sub={shorten(teller)} />
        <Cell label="APY (est.)"       val="~4.9%"    sub="T-bill backed"   color="#22c55e" />
        <Cell label="Bond contract"    val={deployed ? "deployed" : "pending allowlist"}
              sub={deployed ? shorten(bondAddr) : "deploy:usyc:arc"} color={deployed ? "#22c55e" : "#f59e0b"} />
      </div>

      {deployed && (
        <div style={{ marginBottom: "12px" }}>
          <div style={s.cellLabel}>Contract address</div>
          <div style={s.addr}>{bondAddr}</div>
        </div>
      )}

      <div style={s.narrative}>
        <div style={s.narrativeTitle}>The Circle Differentiator</div>
        <span style={s.pill}>USYC</span>
        <span style={s.pill}>x402</span>
        <span style={s.pill}>TEE-gated</span>
        <div style={{ marginTop: "8px" }}>
          Agents post <strong>yield-bearing</strong> USYC as bond collateral instead of idle USDC.
          The bond earns T-bill returns (~4.9% APY) while it sits at stake.
          On a confirmed SLA breach, the consumer receives USYC — worth <em>more</em> than
          face value at slash time. <strong>Capital at risk that isn't idle capital.</strong>
        </div>
        <div style={{ marginTop: "8px", color: "#6b6b8a" }}>
          Mint USYC via Teller: <code style={{ color: "#a855f7" }}>npm run mint:usyc:arc</code>
          {" · "}
          USYC allowlist required from Circle.
        </div>
      </div>
    </div>
  );
}

function Cell({ label, val, sub, color }) {
  return (
    <div style={s.cell}>
      <div style={s.cellLabel}>{label}</div>
      <div style={{ ...s.cellVal, color: color || "#e2e2f0" }}>{val}</div>
      {sub && <div style={{ fontSize: "9px", color: "#6b6b8a", marginTop: "2px", fontFamily: "monospace" }}>{sub}</div>}
    </div>
  );
}

function shorten(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
