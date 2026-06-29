const s = {
  card: {
    background: "#111118",
    border: "1px solid #1e1e2e",
    borderLeft: "2px solid #8b5cf6",
    borderRadius: "8px",
    padding: "20px",
  },
  header: {
    display: "flex", alignItems: "flex-start",
    justifyContent: "space-between", marginBottom: "14px", gap: "10px",
  },
  title: {
    fontSize: "11px", color: "#6b6b8a",
    textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: "600",
  },
  badgeWrap: { display: "flex", gap: "6px", flexShrink: 0 },
  badge: (c) => ({
    padding: "3px 10px", borderRadius: "99px", fontSize: "11px", fontWeight: "700",
    background: c + "18", color: c, border: `1px solid ${c}40`,
  }),

  lede: {
    fontSize: "13px", fontWeight: "700", color: "#e2e8f0",
    marginBottom: "6px", lineHeight: "1.4",
  },
  ledeSub: {
    fontSize: "11px", color: "#6b6b8a", marginBottom: "14px", lineHeight: "1.6",
  },

  narrative: {
    background: "rgba(139, 92, 246, 0.06)",
    border: "1px solid rgba(139, 92, 246, 0.18)",
    borderRadius: "6px",
    padding: "14px 16px",
    marginBottom: "14px",
  },
  narrativeTitle: {
    fontWeight: "700", color: "#8b5cf6",
    marginBottom: "8px", fontSize: "11px",
    textTransform: "uppercase", letterSpacing: "0.06em",
  },
  narrativeBody: {
    fontSize: "11px", color: "#c4b5fd", lineHeight: "1.75",
  },
  pill: {
    display: "inline-block", fontSize: "10px", padding: "2px 8px",
    borderRadius: "99px", background: "#8b5cf618",
    color: "#8b5cf6", border: "1px solid #8b5cf640",
    marginRight: "4px", marginBottom: "8px",
  },

  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "14px" },
  cell: { background: "#0d1117", borderRadius: "6px", padding: "10px 12px" },
  cellLabel: {
    fontSize: "10px", color: "#6b6b8a",
    textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: "600",
  },
  cellVal: { fontSize: "13px", marginTop: "3px", fontFamily: "'JetBrains Mono', monospace" },
  cellSub: { fontSize: "9px", color: "#6b6b8a", marginTop: "2px", fontFamily: "'JetBrains Mono', monospace" },

  addr: {
    fontSize: "10px", color: "#8b5cf6", wordBreak: "break-all",
    marginTop: "4px", fontFamily: "'JetBrains Mono', monospace",
  },
  cmdRow: {
    display: "flex", alignItems: "center", gap: "8px",
    padding: "8px 12px", background: "#0d1117",
    borderRadius: "6px", border: "1px solid #1e1e2e",
  },
  cmdLabel: {
    fontSize: "10px", color: "#6b6b8a", fontWeight: "600",
    textTransform: "uppercase", letterSpacing: "0.08em",
  },
  cmdCode: {
    fontSize: "11px", color: "#8b5cf6",
    fontFamily: "'JetBrains Mono', monospace",
  },
};

function shorten(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function USYCBondCard({ usyc }) {
  const bondAddr  = usyc?.bond   ?? null;
  const tokenAddr = usyc?.token  ?? "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C";
  const teller    = usyc?.teller ?? "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A";
  const deployed  = !!bondAddr;

  return (
    <div style={s.card}>
      <div style={s.header}>
        <div style={s.title}>Yield-bearing collateral · Circle USDC → USYC</div>
        <div style={s.badgeWrap}>
          <span style={s.badge(deployed ? "#34d399" : "#f59e0b")}>
            {deployed ? "● deployed" : "⏳ allowlist pending"}
          </span>
        </div>
      </div>

      {/* Lead with the concept, not the number */}
      <div style={s.lede}>Collateral that earns T-bill returns while locked at stake.</div>
      <div style={s.ledeSub}>
        Circle USDC → Hashnote Teller → USYC → posted as bond. On breach, consumer
        receives USYC worth more than the original deposit.
      </div>

      <div style={s.narrative}>
        <div style={s.narrativeTitle}>The Circle Differentiator</div>
        <div style={{ marginBottom: "8px" }}>
          <span style={s.pill}>USYC</span>
          <span style={s.pill}>x402</span>
          <span style={s.pill}>TEE-gated</span>
          <span style={s.pill}>Circle USDC</span>
        </div>
        <div style={s.narrativeBody}>
          Agents post <strong style={{ color: "#e2e8f0" }}>yield-bearing USYC</strong> as bond
          collateral instead of idle USDC. The bond earns T-bill returns (~4.9% APY) while it
          sits at stake. On a confirmed SLA breach, the consumer receives USYC —{" "}
          <em style={{ color: "#e2e8f0" }}>worth more than face value</em> at slash time.{" "}
          <strong style={{ color: "#e2e8f0" }}>Capital at risk that isn't idle capital.</strong>
        </div>
      </div>

      <div style={s.grid}>
        <Cell label="Collateral" val="USYC"    sub={shorten(tokenAddr)} color="#8b5cf6" />
        <Cell label="Teller"     val="Hashnote" sub={shorten(teller)} />
        <Cell label="Yield"      val="~4.9%"   sub="T-bill backed"    color="#34d399" />
        <Cell
          label="Bond contract"
          val={deployed ? "deployed" : "pending"}
          sub={deployed ? shorten(bondAddr) : "deploy:usyc:arc"}
          color={deployed ? "#34d399" : "#f59e0b"}
        />
      </div>

      {deployed && (
        <div style={{ marginBottom: "12px" }}>
          <div style={s.cellLabel}>Contract address</div>
          <div style={s.addr}>{bondAddr}</div>
        </div>
      )}

      <div style={s.cmdRow}>
        <span style={s.cmdLabel}>mint</span>
        <code style={s.cmdCode}>npm run mint:usyc:arc</code>
      </div>
    </div>
  );
}

function Cell({ label, val, sub, color }) {
  return (
    <div style={s.cell}>
      <div style={s.cellLabel}>{label}</div>
      <div style={{ ...s.cellVal, color: color || "#e2e8f0" }}>{val}</div>
      {sub && <div style={s.cellSub}>{sub}</div>}
    </div>
  );
}
