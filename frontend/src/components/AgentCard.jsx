import { useState } from "react";

// Arcscan base URL for tx links
const ARCSCAN = "https://testnet.arcscan.app/tx/";
const ORACLE_ADDR = "0xe2f7a0e6d9865c7dc9b5d19dcc11cbcb4655c661";

const s = {
  // Main oracle card
  card:       { background: "#111118", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "20px", marginBottom: "12px" },
  header:     { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" },
  title:      { fontSize: "11px", color: "#6b6b8a", letterSpacing: "0.1em", textTransform: "uppercase" },
  address:    { fontSize: "11px", color: "#22d3ee", marginTop: "4px", wordBreak: "break-all" },

  badge: (status) => ({
    padding: "3px 10px", borderRadius: "99px", fontSize: "11px", fontWeight: "700", letterSpacing: "0.06em",
    background: status === "active"  ? "#22c55e20"
               : status === "slashed" ? "#ef444420"
               :                        "#6b6b8a20",
    color:      status === "active"  ? "#22c55e"
               : status === "slashed" ? "#ef4444"
               :                        "#6b6b8a",
    border: `1px solid ${
               status === "active"  ? "#22c55e40"
               : status === "slashed" ? "#ef444440"
               :                        "#6b6b8a40"}`,
    transition: "all 0.4s ease",
  }),

  meta:       { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "16px" },
  metaItem:   { background: "#0a0a0f", borderRadius: "6px", padding: "8px 12px" },
  metaLabel:  { fontSize: "10px", color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.1em" },
  metaValue:  { fontSize: "13px", marginTop: "2px" },

  faultLabel: { fontSize: "11px", color: "#6b6b8a", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.1em" },
  controls:   { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
  faultBtn:   (active) => ({
    background: active ? "#ef444430" : "#1e1e2e",
    color:      active ? "#ef4444"   : "#e2e2f0",
    border:     `1px solid ${active ? "#ef4444" : "#2e2e4e"}`,
    padding: "5px 12px", borderRadius: "4px", fontSize: "12px", cursor: "pointer",
  }),
  resetBtn:   { background: "#1e1e2e", color: "#6b6b8a", border: "1px solid #2e2e4e",
                padding: "5px 12px", borderRadius: "4px", fontSize: "12px", cursor: "pointer" },

  // Trigger-cycle button
  triggerBtn: (busy) => ({
    width: "100%", padding: "10px", borderRadius: "6px", fontSize: "12px", fontWeight: "700",
    cursor: busy ? "not-allowed" : "pointer",
    background: busy ? "#1e1e2e" : "#ef444420",
    color:      busy ? "#6b6b8a" : "#ef4444",
    border:     `1px solid ${busy ? "#2e2e4e" : "#ef444440"}`,
    marginTop: "12px", transition: "all 0.2s",
    letterSpacing: "0.06em",
  }),

  txLink:   { fontSize: "10px", color: "#22d3ee", wordBreak: "break-all", marginTop: "4px" },
  resultBox:{ background: "#0a0a0f", borderRadius: "6px", padding: "10px 12px", marginTop: "10px",
              fontSize: "11px", color: "#e2e2f0", lineHeight: "1.6" },
  resultLabel:{ color: "#6b6b8a", marginRight: "6px" },

  // Agent list rows
  agentList:  { display: "flex", flexDirection: "column", gap: "6px" },
  agentRow:   { background: "#111118", border: "1px solid #1e1e2e", borderRadius: "6px",
                padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" },
  agentAddr:  { fontSize: "11px", color: "#22d3ee", fontFamily: "monospace" },
  agentMeta:  { fontSize: "10px", color: "#6b6b8a", marginTop: "2px" },
  agentRight: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" },
  agentAmt:   { fontSize: "13px", fontWeight: "700", color: "#e2e2f0" },
};

const FAULT_MODES = ["stale", "null", "bad-sig"];

function fmt(addr) {
  return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "—";
}
function fmtUsdc(raw) {
  return raw ? `${(Number(raw) / 1e6).toFixed(2)} USDC` : "—";
}
function agentStatus(agent) {
  if (agent.active)   return "active";
  if (agent.slashed)  return "slashed";
  return "no bond";
}

export default function AgentCard({ stats, chainStats, onCycleComplete }) {
  const [activeFault,  setActiveFault]  = useState(null);
  const [busy,         setBusy]         = useState(false);
  const [msg,          setMsg]          = useState("");
  const [cycleResult,  setCycleResult]  = useState(null);
  const [triggering,   setTriggering]   = useState(false);

  const agents = chainStats?.agents ?? [];
  const oracleAgent = agents.find(a => a.address.toLowerCase() === ORACLE_ADDR);

  // ── Fault injection (sets oracle server-side fault mode) ───────────────────
  async function triggerFault(mode) {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/admin/fault", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (r.ok) { setActiveFault(mode); setMsg(`Fault "${mode}" active — consumer detects within ~12s`); }
      else setMsg("Failed to set fault mode");
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function resetFault() {
    setBusy(true);
    try {
      await fetch("/admin/fault/reset", { method: "POST" });
      setActiveFault(null); setMsg("Fault cleared — oracle back to healthy");
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setBusy(false); }
  }

  // ── Trigger cycle (full loop: re-bond → fault → Claude → slash) ───────────
  async function handleTriggerCycle() {
    setTriggering(true); setCycleResult(null); setMsg("");
    try {
      const r = await fetch("/admin/trigger-cycle", { method: "POST",
        headers: { "Content-Type": "application/json" } });
      const data = await r.json();
      if (!r.ok) { setMsg(`Error: ${data.error}`); return; }
      setCycleResult(data);
      if (onCycleComplete) setTimeout(onCycleComplete, 1000);
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setTriggering(false); }
  }

  return (
    <div>
      {/* Oracle agent card — primary, with trigger controls */}
      <div style={s.card}>
        <div style={s.header}>
          <div>
            <div style={s.title}>Oracle Agent</div>
            <div style={s.address}>{stats?.oracle ?? ORACLE_ADDR}</div>
          </div>
          <div style={s.badge(oracleAgent ? agentStatus(oracleAgent) : "no bond")}>
            {oracleAgent?.active   ? "● ACTIVE"
           : oracleAgent?.slashed  ? "⚡ SLASHED"
           :                         "○ NO BOND"}
          </div>
        </div>

        <div style={s.meta}>
          <MetaItem label="Bond"        value={oracleAgent ? fmtUsdc(oracleAgent.amount) : "—"}
                    color={oracleAgent?.slashed ? "#ef4444" : "#22d3ee"} />
          <MetaItem label="SLA"         value="30s max age" />
          <MetaItem label="Total calls" value={stats?.totalCalls ?? 0} />
          <MetaItem label="Slashes"     value={chainStats?.summary?.totalSlashes ?? stats?.slashCount ?? 0}
                    color={(chainStats?.summary?.totalSlashes ?? 0) > 0 ? "#ef4444" : undefined} />
        </div>

        {/* Fault injection */}
        <div style={s.faultLabel}>Trigger Fault (oracle responds badly)</div>
        <div style={s.controls}>
          {FAULT_MODES.map(m => (
            <button key={m} style={s.faultBtn(activeFault === m)}
                    onClick={() => triggerFault(m)} disabled={busy}>{m}</button>
          ))}
          <button style={s.resetBtn} onClick={resetFault} disabled={busy || !activeFault}>reset</button>
          {msg && <span style={{ fontSize: "11px", color: "#6b6b8a", marginLeft: "4px" }}>{msg}</span>}
        </div>

        {/* Trigger Demo button — full loop */}
        <button style={s.triggerBtn(triggering)} onClick={handleTriggerCycle} disabled={triggering}>
          {triggering ? "⏳  Running slash loop…" : "⚡  Trigger Demo Slash (full loop)"}
        </button>

        {cycleResult && (
          <div style={s.resultBox}>
            <div>
              <span style={s.resultLabel}>Verdict:</span>
              <span style={{ color: cycleResult.verdict === "breach" ? "#ef4444" : "#22c55e", fontWeight: "700" }}>
                {cycleResult.verdict?.toUpperCase()}
              </span>
            </div>
            {cycleResult.slashTx && (
              <div>
                <span style={s.resultLabel}>Slash tx:</span>
                <a href={ARCSCAN + cycleResult.slashTx} target="_blank" rel="noreferrer" style={s.txLink}>
                  {cycleResult.slashTx.slice(0, 20)}…
                </a>
              </div>
            )}
            <div style={{ marginTop: "6px", color: "#6b6b8a", fontSize: "10px" }}>
              {cycleResult.reason?.slice(0, 140)}…
            </div>
          </div>
        )}
      </div>

      {/* All registered agents — compact list */}
      {agents.length > 0 && (
        <div>
          <div style={{ fontSize: "10px", color: "#6b6b8a", textTransform: "uppercase",
                        letterSpacing: "0.1em", marginBottom: "8px" }}>
            All Registered Agents ({agents.length})
          </div>
          <div style={s.agentList}>
            {agents.map(agent => {
              const status = agentStatus(agent);
              const isOracle = agent.address.toLowerCase() === ORACLE_ADDR;
              return (
                <div key={agent.address} style={{
                  ...s.agentRow,
                  borderColor: isOracle ? "#22d3ee30" : "#1e1e2e",
                }}>
                  <div>
                    <div style={s.agentAddr}>{fmt(agent.address)}</div>
                    <div style={s.agentMeta}>{agent.agentId?.slice(0, 14)}…{isOracle ? " · oracle" : ""}</div>
                  </div>
                  <div style={s.agentRight}>
                    <div style={s.agentAmt}>{fmtUsdc(agent.amount)}</div>
                    <div style={s.badge(status)}>{
                      status === "active"   ? "● active"
                    : status === "slashed"  ? "⚡ slashed"
                    :                         "○ no bond"
                    }</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
