const VERDICT_COLOR = { ok: "#22c55e", breach: "#ef4444", uncertain: "#f59e0b" };
const VERDICT_ICON  = { ok: "✓", breach: "✗", uncertain: "?" };

const s = {
  wrap:     { background: "#111118", border: "1px solid #1e1e2e", borderRadius: "8px", overflow: "hidden" },
  header:   { padding: "14px 20px", borderBottom: "1px solid #1e1e2e", display: "flex", justifyContent: "space-between", alignItems: "center" },
  title:    { fontSize: "11px", color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.1em" },
  count:    { fontSize: "11px", color: "#6b6b8a" },
  empty:    { padding: "32px", textAlign: "center", color: "#6b6b8a" },
  row:      { borderBottom: "1px solid #1e1e2e", padding: "14px 20px", transition: "background 0.2s" },
  top:      { display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "6px" },
  badge:    (v) => ({
    fontSize: "11px", fontWeight: "700", padding: "2px 8px", borderRadius: "99px",
    background: VERDICT_COLOR[v] + "20",
    color:      VERDICT_COLOR[v],
    border:     `1px solid ${VERDICT_COLOR[v]}40`,
  }),
  cycle:    { fontSize: "11px", color: "#6b6b8a" },
  checks:   { display: "flex", gap: "8px", marginBottom: "6px" },
  check:    (pass) => ({ fontSize: "10px", color: pass ? "#22c55e" : "#ef4444" }),
  reason:   { fontSize: "11px", color: "#9898b8", lineHeight: "1.6", maxHeight: "72px", overflow: "hidden" },
  meta:     { display: "flex", gap: "16px", marginTop: "6px" },
  metaTxt:  { fontSize: "10px", color: "#6b6b8a" },
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

  return (
    <div style={s.row}>
      <div style={s.top}>
        <span style={s.badge(v.verdict)}>
          {VERDICT_ICON[v.verdict]} {v.verdict?.toUpperCase()}
        </span>
        <span style={s.cycle}>Cycle #{v.cycle}</span>
        {v.fault_mode && <span style={{ fontSize: "10px", color: "#f59e0b" }}>fault:{v.fault_mode}</span>}
        <span style={{ ...s.cycle, marginLeft: "auto" }}>{ago != null ? `${ago}s ago` : ""}</span>
      </div>

      <div style={s.checks}>
        <Check label="timestamp_fresh" pass={c.timestamp_fresh} />
        <Check label="value_present"   pass={c.value_present}   />
        <Check label="signature_valid" pass={c.signature_valid} />
      </div>

      <div style={s.reason}>{v.reason ?? "—"}</div>

      <div style={s.meta}>
        {v.oracle_value  != null && <span style={s.metaTxt}>value={v.oracle_value}</span>}
        {v.oracle_age_s  != null && <span style={s.metaTxt}>age={v.oracle_age_s}s</span>}
        {v.payment_usdc  != null && <span style={s.metaTxt}>paid=${v.payment_usdc}</span>}
        {v.slash_tx && <span style={{ ...s.metaTxt, color: "#ef4444" }}>tx:{v.slash_tx.slice(0,10)}…</span>}
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
