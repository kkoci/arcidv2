const ARCSCAN = "https://testnet.arcscan.app/tx/";

const VERDICT_COLOR = { ok: "#34d399", breach: "#ef4444", uncertain: "#f59e0b" };
const VERDICT_ICON  = { ok: "✓", breach: "✗", uncertain: "?" };

const s = {
  wrap: {
    background: "#111118",
    border: "1px solid #1e1e2e",
    borderRadius: "8px",
    overflow: "hidden",
  },
  header: {
    padding: "14px 20px",
    borderBottom: "1px solid #1e1e2e",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title:  { fontSize: "11px", color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: "600" },
  count:  { fontSize: "11px", color: "#6b6b8a", fontFamily: "'JetBrains Mono', monospace" },
  empty:  { padding: "40px", textAlign: "center", color: "#6b6b8a", fontSize: "12px" },
  row:    { borderBottom: "1px solid #1e1e2e", padding: "16px 20px" },

  top:    { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" },
  badge:  (v) => ({
    fontSize: "11px", fontWeight: "700", padding: "3px 10px", borderRadius: "99px",
    background: VERDICT_COLOR[v] + "18",
    color: VERDICT_COLOR[v],
    border: `1px solid ${VERDICT_COLOR[v]}40`,
    letterSpacing: "0.05em",
  }),
  cycle:  { fontSize: "11px", color: "#6b6b8a", fontFamily: "'JetBrains Mono', monospace" },
  fault:  { fontSize: "10px", color: "#f59e0b", fontFamily: "'JetBrains Mono', monospace" },
  age:    { fontSize: "10px", color: "#454b63", fontFamily: "'JetBrains Mono', monospace", marginLeft: "auto" },

  checks: { display: "flex", gap: "12px", marginBottom: "12px", flexWrap: "wrap" },
  check:  (pass) => ({
    fontSize: "11px",
    color: pass ? "#34d399" : "#ef4444",
    fontFamily: "'JetBrains Mono', monospace",
    display: "flex", alignItems: "center", gap: "4px",
  }),

  claudeBlock: {
    background: "rgba(139, 92, 246, 0.06)",
    border: "1px solid rgba(139, 92, 246, 0.2)",
    borderLeft: "2px solid #8b5cf6",
    borderRadius: "6px",
    padding: "12px 14px",
    marginBottom: "12px",
  },
  claudeBlockOk: {
    background: "rgba(52, 211, 153, 0.04)",
    border: "1px solid rgba(52, 211, 153, 0.15)",
    borderLeft: "2px solid #34d399",
    borderRadius: "6px",
    padding: "12px 14px",
    marginBottom: "12px",
  },
  claudeLabel: {
    fontSize: "10px",
    fontWeight: "700",
    color: "#8b5cf6",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    marginBottom: "6px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  claudeLabelOk: {
    fontSize: "10px",
    fontWeight: "700",
    color: "#34d399",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    marginBottom: "6px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  claudeText: {
    fontSize: "11px",
    color: "#c4b5fd",
    lineHeight: "1.75",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  claudeTextOk: {
    fontSize: "11px",
    color: "#a7f3d0",
    lineHeight: "1.75",
    fontFamily: "'Inter', system-ui, sans-serif",
  },

  meta:    { display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" },
  metaTxt: { fontSize: "10px", color: "#6b6b8a", fontFamily: "'JetBrains Mono', monospace" },
  txLink:  {
    fontSize: "10px",
    color: "#22d3ee",
    fontFamily: "'JetBrains Mono', monospace",
    textDecoration: "none",
    display: "flex", alignItems: "center", gap: "3px",
  },
};

export default function VerdictHistory({ verdicts }) {
  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>Adjudication History</span>
        <span style={s.count}>{verdicts.length} verdicts</span>
      </div>

      {verdicts.length === 0 ? (
        <div style={s.empty}>Waiting for consumer agent cycles…</div>
      ) : (
        verdicts.map((v, i) => <VerdictRow key={i} v={v} />)
      )}
    </div>
  );
}

function VerdictRow({ v }) {
  const c = v.checks ?? {};
  const ago = v.received_at
    ? Math.round((Date.now() - new Date(v.received_at).getTime()) / 1000)
    : null;
  const isBreach = v.verdict === "breach";

  return (
    <div style={{
      ...s.row,
      borderLeft: isBreach ? "3px solid #ef4444" : "3px solid #34d399",
      background: isBreach
        ? "linear-gradient(90deg, rgba(239,68,68,0.04) 0%, transparent 40%)"
        : "linear-gradient(90deg, rgba(52,211,153,0.03) 0%, transparent 40%)",
    }}>
      <div style={s.top}>
        <span style={s.badge(v.verdict)}>
          {VERDICT_ICON[v.verdict]} {v.verdict?.toUpperCase()}
        </span>
        <span style={s.cycle}>Cycle #{v.cycle}</span>
        {v.fault_mode && (
          <span style={s.fault}>fault:{v.fault_mode}</span>
        )}
        {ago != null && <span style={s.age}>{ago}s ago</span>}
      </div>

      <div style={s.checks}>
        <Check label="timestamp_fresh" pass={c.timestamp_fresh} />
        <Check label="value_present"   pass={c.value_present}   />
        <Check label="signature_valid" pass={c.signature_valid} />
      </div>

      {v.reason && (
        <div style={isBreach ? s.claudeBlock : s.claudeBlockOk}>
          <div style={isBreach ? s.claudeLabel : s.claudeLabelOk}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M8 12l2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Claude Sonnet 4.6 · Adjudicator Reasoning
          </div>
          <div style={isBreach ? s.claudeText : s.claudeTextOk}>
            {v.reason}
          </div>
        </div>
      )}

      <div style={s.meta}>
        {v.oracle_value != null && (
          <span style={s.metaTxt}>value={v.oracle_value}</span>
        )}
        {v.oracle_age_s != null && (
          <span style={s.metaTxt}>age={v.oracle_age_s}s</span>
        )}
        {v.payment_usdc != null && (
          <span style={s.metaTxt}>paid=${v.payment_usdc}</span>
        )}
        {v.slash_tx && (
          <a
            href={`${ARCSCAN}${v.slash_tx}`}
            target="_blank"
            rel="noreferrer"
            style={s.txLink}
          >
            tx: {v.slash_tx.slice(0, 10)}… ↗
          </a>
        )}
        {v.slash_simulated && (
          <span style={{ ...s.metaTxt, color: "#f59e0b" }}>[dev-slash]</span>
        )}
      </div>
    </div>
  );
}

function Check({ label, pass }) {
  return (
    <span style={s.check(pass)}>
      {pass ? "✓" : "✗"} {label}
    </span>
  );
}
