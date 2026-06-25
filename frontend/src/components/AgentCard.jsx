import { useState } from "react";

const FAULT_MODES = ["stale", "null", "bad-sig"];

const s = {
  card:       { background: "#111118", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "20px", marginBottom: "16px" },
  header:     { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" },
  title:      { fontSize: "11px", color: "#6b6b8a", letterSpacing: "0.1em", textTransform: "uppercase" },
  address:    { fontSize: "12px", color: "#22d3ee", marginTop: "4px", wordBreak: "break-all" },
  badge:      (slashed) => ({
    padding: "3px 10px", borderRadius: "99px", fontSize: "11px", fontWeight: "700", letterSpacing: "0.08em",
    background: slashed ? "#ef444420" : "#22c55e20",
    color:      slashed ? "#ef4444"   : "#22c55e",
    border:     `1px solid ${slashed ? "#ef444440" : "#22c55e40"}`,
    transition: "all 0.4s ease",
  }),
  meta:       { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" },
  metaItem:   { background: "#0a0a0f", borderRadius: "6px", padding: "10px 14px" },
  metaLabel:  { fontSize: "10px", color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.1em" },
  metaValue:  { fontSize: "14px", marginTop: "2px" },
  controls:   { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  faultBtn:   (active) => ({
    background: active ? "#ef444430" : "#1e1e2e",
    color:      active ? "#ef4444"   : "#e2e2f0",
    border:     `1px solid ${active ? "#ef4444" : "#2e2e4e"}`,
    padding: "6px 14px", borderRadius: "4px",
  }),
  resetBtn:   { background: "#1e1e2e", color: "#6b6b8a", border: "1px solid #2e2e4e" },
  status:     { fontSize: "11px", color: "#6b6b8a", marginLeft: "auto" },
};

export default function AgentCard({ stats }) {
  const [activeFault, setActiveFault] = useState(stats?.fault_mode ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // Derive slashed state from breach count
  const isSlashed = (stats?.slashCount ?? 0) > 0;

  async function triggerFault(mode) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/admin/fault", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode }),
      });
      if (r.ok) {
        setActiveFault(mode);
        setMsg(`Fault "${mode}" active — consumer will detect within ~12s`);
      } else {
        setMsg("Failed to set fault mode");
      }
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function resetFault() {
    setBusy(true);
    try {
      await fetch("/admin/fault/reset", { method: "POST" });
      setActiveFault(null);
      setMsg("Fault cleared — oracle back to healthy");
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.card}>
      <div style={s.header}>
        <div>
          <div style={s.title}>Oracle Agent</div>
          <div style={s.address}>{stats?.oracle ?? "0x…"}</div>
        </div>
        <div style={s.badge(isSlashed)}>{isSlashed ? "⚡ SLASHED" : "● ACTIVE"}</div>
      </div>

      <div style={s.meta}>
        <MetaItem label="Collateral"    value="5.0000 USDC"        color="#22d3ee" />
        <MetaItem label="SLA"           value="30s max age"         />
        <MetaItem label="Total calls"   value={stats?.totalCalls ?? 0} />
        <MetaItem label="Slash events"  value={stats?.slashCount ?? 0} color={isSlashed ? "#ef4444" : undefined} />
      </div>

      <div style={{ fontSize: "11px", color: "#6b6b8a", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.1em" }}>
        Trigger Fault
      </div>
      <div style={s.controls}>
        {FAULT_MODES.map((m) => (
          <button
            key={m}
            style={s.faultBtn(activeFault === m)}
            onClick={() => triggerFault(m)}
            disabled={busy}
          >
            {m}
          </button>
        ))}
        <button style={s.resetBtn} onClick={resetFault} disabled={busy || !activeFault}>
          reset
        </button>
        {msg && <span style={s.status}>{msg}</span>}
      </div>
    </div>
  );
}

function MetaItem({ label, value, color }) {
  return (
    <div style={s.metaItem}>
      <div style={s.metaLabel}>{label}</div>
      <div style={{ ...s.metaValue, color: color || "#e2e2f0" }}>{value}</div>
    </div>
  );
}
