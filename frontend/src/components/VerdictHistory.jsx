const ARCSCAN = "https://testnet.arcscan.app/tx/";

const VERDICT_COLOR = { ok: "#34d399", breach: "#ef4444", uncertain: "#f59e0b" };

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
  empty:  { padding: "48px", textAlign: "center", color: "#6b6b8a", fontSize: "12px" },
  row:    { borderBottom: "1px solid #1e1e2e", padding: "18px 20px" },

  headline: (isBreach) => ({
    fontSize: "13px",
    fontWeight: "700",
    color: isBreach ? "#ef4444" : "#34d399",
    marginBottom: "14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "12px",
  }),
  headlineText: { lineHeight: "1.4" },
  age: { fontSize: "10px", color: "#454b63", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, paddingTop: "2px" },

  claudeBlock: (isBreach) => ({
    background: isBreach ? "rgba(139, 92, 246, 0.06)" : "rgba(52, 211, 153, 0.04)",
    border: isBreach ? "1px solid rgba(139, 92, 246, 0.2)" : "1px solid rgba(52, 211, 153, 0.15)",
    borderLeft: isBreach ? "2px solid #8b5cf6" : "2px solid #34d399",
    borderRadius: "6px",
    padding: "14px 16px",
    marginBottom: "14px",
  }),
  claudeLabel: (isBreach) => ({
    fontSize: "10px",
    fontWeight: "700",
    color: isBreach ? "#8b5cf6" : "#34d399",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    marginBottom: "8px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  }),
  claudeText: (isBreach) => ({
    fontSize: "12px",
    color: isBreach ? "#c4b5fd" : "#a7f3d0",
    lineHeight: "1.8",
    fontFamily: "'Inter', system-ui, sans-serif",
  }),

  footer: { display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" },
  checks: { display: "flex", gap: "10px" },
  check:  (pass) => ({
    fontSize: "10px",
    color: pass ? "#34d399" : "#ef4444",
    fontFamily: "'JetBrains Mono', monospace",
  }),
  metaTxt: { fontSize: "10px", color: "#6b6b8a", fontFamily: "'JetBrains Mono', monospace" },
  txLink:  {
    fontSize: "11px",
    color: "#22d3ee",
    fontFamily: "'JetBrains Mono', monospace",
    textDecoration: "none",
    fontWeight: "600",
    display: "flex", alignItems: "center", gap: "4px",
  },
};

function verdictHeadline(v) {
  if (v.verdict === "breach") {
    const c = v.checks ?? {};
    if (c.signature_valid === false) return "Bond slashed — oracle submitted an invalid signature";
    if (c.timestamp_fresh === false) return "Bond slashed — oracle response was stale";
    if (c.value_present   === false) return "Bond slashed — oracle returned null data";
    return "Bond slashed — SLA breach confirmed";
  }
  if (v.verdict === "ok") return "SLA met — oracle delivered a valid signed response";
  return "Verdict uncertain — insufficient evidence to slash";
}

export default function VerdictHistory({ verdicts }) {
  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>Adjudication History</span>
        <span style={s.count}>{verdicts.length} verdicts</span>
      </div>

      {verdicts.length === 0 ? (
        <div style={s.empty}>
          No adjudications yet.<br />
          <span style={{ fontSize: "11px", marginTop: "8px", display: "block" }}>
            Click "Oracle cheated. Slash it." to run the full loop.
          </span>
        </div>
      ) : (
        verdicts.map((v, i) => <VerdictRow key={i} v={v} />)
      )}
    </div>
  );
}

function VerdictRow({ v }) {
  const c        = v.checks ?? {};
  const isBreach = v.verdict === "breach";
  const ago      = v.received_at
    ? Math.round((Date.now() - new Date(v.received_at).getTime()) / 1000)
    : null;

  return (
    <div style={{
      ...s.row,
      borderLeft: isBreach ? "3px solid #ef4444" : "3px solid #34d399",
      background: isBreach
        ? "linear-gradient(90deg, rgba(239,68,68,0.04) 0%, transparent 50%)"
        : "linear-gradient(90deg, rgba(52,211,153,0.03) 0%, transparent 50%)",
    }}>
      {/* Plain-English headline */}
      <div style={s.headline(isBreach)}>
        <span style={s.headlineText}>{verdictHeadline(v)}</span>
        {ago != null && <span style={s.age}>{ago}s ago</span>}
      </div>

      {/* Claude reasoning — full text, no truncation */}
      {v.reason && (
        <div style={s.claudeBlock(isBreach)}>
          <div style={s.claudeLabel(isBreach)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M8 12l2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Claude Sonnet 4.6 · Adjudicator Reasoning
          </div>
          <div style={s.claudeText(isBreach)}>{v.reason}</div>
        </div>
      )}

      {/* Footer: TX link + checks + metadata */}
      <div style={s.footer}>
        {v.slash_tx && (
          <a href={`${ARCSCAN}${v.slash_tx}`} target="_blank" rel="noreferrer" style={s.txLink}>
            Bond seized → {v.slash_tx.slice(0, 12)}… ↗
          </a>
        )}
        <div style={s.checks}>
          <Check label="ts"  pass={c.timestamp_fresh} />
          <Check label="val" pass={c.value_present}   />
          <Check label="sig" pass={c.signature_valid} />
        </div>
        {v.fault_mode && <span style={{ ...s.metaTxt, color: "#f59e0b" }}>fault:{v.fault_mode}</span>}
        {v.payment_usdc != null && <span style={s.metaTxt}>paid=${v.payment_usdc}</span>}
        {v.slash_simulated && <span style={{ ...s.metaTxt, color: "#f59e0b" }}>[dev-slash]</span>}
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
