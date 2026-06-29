import { useState } from "react";

const ARCSCAN     = "https://testnet.arcscan.app/tx/";
const ORACLE_ADDR = "0xe2f7a0e6d9865c7dc9b5d19dcc11cbcb4655c661";
const FAULT_MODES = ["stale", "null", "bad-sig"];

const s = {
  card: (slashed) => ({
    background: slashed ? "rgba(239,68,68,0.05)" : "#111118",
    border: slashed ? "1px solid rgba(239,68,68,0.3)" : "1px solid #1e1e2e",
    borderRadius: "8px",
    padding: "20px",
    marginBottom: "12px",
    transition: "background 0.5s, border-color 0.5s",
  }),
  header: {
    display: "flex", alignItems: "flex-start",
    justifyContent: "space-between", marginBottom: "14px",
  },
  title:   { fontSize: "10px", color: "#6b6b8a", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: "600" },
  address: {
    fontSize: "11px", color: "#22d3ee", marginTop: "4px",
    wordBreak: "break-all", fontFamily: "'JetBrains Mono', monospace",
  },

  badge: (status) => ({
    padding: "3px 10px", borderRadius: "99px", fontSize: "11px",
    fontWeight: "700", letterSpacing: "0.06em", flexShrink: 0,
    background: status === "active"  ? "#34d39918"
               : status === "slashed" ? "#ef444430"
               :                        "#6b6b8a18",
    color:      status === "active"  ? "#34d399"
               : status === "slashed" ? "#ef4444"
               :                        "#6b6b8a",
    border: `1px solid ${
               status === "active"  ? "#34d39940"
               : status === "slashed" ? "#ef444460"
               :                        "#6b6b8a40"}`,
    transition: "all 0.4s ease",
  }),

  meta:      { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "16px" },
  metaItem:  { background: "#0d1117", borderRadius: "6px", padding: "8px 12px" },
  metaLabel: { fontSize: "10px", color: "#6b6b8a", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: "600" },
  metaValue: { fontSize: "13px", marginTop: "3px", fontFamily: "'JetBrains Mono', monospace" },

  faultSection: { marginBottom: "12px" },
  faultLabel: {
    fontSize: "10px", color: "#6b6b8a", marginBottom: "4px",
    textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: "600",
  },
  faultSub: { fontSize: "10px", color: "#454b63", marginBottom: "8px", lineHeight: "1.5" },
  controls: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
  faultBtn: (active) => ({
    background: active ? "#ef444425" : "#1e1e2e",
    color:      active ? "#ef4444"   : "#9898b8",
    border:     `1px solid ${active ? "#ef444450" : "#2e2e4e"}`,
    padding: "4px 12px", borderRadius: "4px", fontSize: "11px",
    fontFamily: "'JetBrains Mono', monospace", cursor: "pointer",
    transition: "all 0.15s",
  }),
  resetBtn: {
    background: "#1e1e2e", color: "#6b6b8a",
    border: "1px solid #2e2e4e",
    padding: "4px 12px", borderRadius: "4px",
    fontSize: "11px", cursor: "pointer",
  },

  triggerBtn: (busy) => ({
    width: "100%", padding: "12px", borderRadius: "6px",
    fontSize: "13px", fontWeight: "700", letterSpacing: "0.02em",
    cursor: busy ? "not-allowed" : "pointer",
    background: busy ? "#1e1e2e" : "#ef4444",
    color:      busy ? "#6b6b8a" : "#ffffff",
    border:     `1px solid ${busy ? "#2e2e4e" : "#ef4444"}`,
    marginTop: "4px", transition: "all 0.2s",
    boxShadow: busy ? "none" : "0 0 24px rgba(239,68,68,0.3)",
  }),
  triggerSub: {
    fontSize: "10px", color: "#6b6b8a", textAlign: "center",
    marginTop: "6px", lineHeight: "1.5",
  },

  resultBox: {
    background: "#0d1117", borderRadius: "6px",
    padding: "12px 14px", marginTop: "12px",
    fontSize: "11px", color: "#e2e8f0", lineHeight: "1.6",
    border: "1px solid #1e1e2e",
  },
  resultLabel: { color: "#6b6b8a", marginRight: "6px" },
  txLink: {
    fontSize: "10px", color: "#22d3ee", wordBreak: "break-all",
    marginTop: "4px", fontFamily: "'JetBrains Mono', monospace",
    textDecoration: "none", fontWeight: "600",
  },

  agentList: { display: "flex", flexDirection: "column", gap: "6px" },
  agentRow:  {
    background: "#111118", border: "1px solid #1e1e2e",
    borderRadius: "6px", padding: "10px 14px",
    display: "flex", alignItems: "center", justifyContent: "space-between",
  },
  agentAddr: { fontSize: "11px", color: "#22d3ee", fontFamily: "'JetBrains Mono', monospace" },
  agentMeta: { fontSize: "10px", color: "#6b6b8a", marginTop: "2px" },
  agentRight:{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" },
  agentAmt:  { fontSize: "12px", fontWeight: "700", color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace" },
};

function fmt(addr)    { return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "—"; }
function fmtUsdc(raw) { return raw  ? `${(Number(raw) / 1e6).toFixed(2)} USDC` : "—"; }
function agentStatus(agent) {
  if (agent.active)  return "active";
  if (agent.slashed) return "slashed";
  return "no bond";
}

export default function AgentCard({ stats, chainStats, onCycleComplete }) {
  const [activeFault, setActiveFault] = useState(null);
  const [busy,        setBusy]        = useState(false);
  const [msg,         setMsg]         = useState("");
  const [cycleResult, setCycleResult] = useState(null);
  const [triggering,  setTriggering]  = useState(false);

  const agents      = chainStats?.agents ?? [];
  const oracleAgent = agents.find(a => a.address.toLowerCase() === ORACLE_ADDR);
  const isSlashed   = oracleAgent?.slashed === true;

  async function triggerFault(mode) {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/admin/fault", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (r.ok) { setActiveFault(mode); setMsg(`"${mode}" fault active — breach within ~12s`); }
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

  async function handleTriggerCycle() {
    setTriggering(true); setCycleResult(null); setMsg("");
    try {
      const r = await fetch("/admin/trigger-cycle", {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      const data = await r.json();
      if (!r.ok) { setMsg(`Error: ${data.error}`); return; }
      setCycleResult(data);
      if (onCycleComplete) setTimeout(onCycleComplete, 1000);
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setTriggering(false); }
  }

  return (
    <div>
      {/* Oracle agent card */}
      <div style={s.card(isSlashed)}>
        <div style={s.header}>
          <div>
            <div style={s.title}>Price Oracle</div>
            <div style={s.address}>{stats?.oracle ?? ORACLE_ADDR}</div>
          </div>
          <div style={s.badge(oracleAgent ? agentStatus(oracleAgent) : "no bond")}>
            {oracleAgent?.active  ? "● ACTIVE"
           : oracleAgent?.slashed ? "⚡ SLASHED"
           :                        "○ NO BOND"}
          </div>
        </div>

        <div style={s.meta}>
          <MetaItem
            label="Bond"
            value={oracleAgent ? fmtUsdc(oracleAgent.amount) : "—"}
            color={isSlashed ? "#ef4444" : "#22d3ee"}
          />
          <MetaItem label="SLA"         value="30s max age" />
          <MetaItem label="Total calls" value={stats?.totalCalls ?? 0} />
          <MetaItem
            label="Slashes"
            value={chainStats?.summary?.totalSlashes ?? stats?.slashCount ?? 0}
            color={(chainStats?.summary?.totalSlashes ?? 0) > 0 ? "#ef4444" : undefined}
          />
        </div>

        {/* Fault injection */}
        <div style={s.faultSection}>
          <div style={s.faultLabel}>Force a fault to trigger adjudication</div>
          <div style={s.faultSub}>The consumer agent detects the fault and calls Claude within seconds.</div>
          <div style={s.controls}>
            {FAULT_MODES.map(m => (
              <button key={m} style={s.faultBtn(activeFault === m)}
                      onClick={() => triggerFault(m)} disabled={busy}>{m}</button>
            ))}
            <button style={s.resetBtn} onClick={resetFault} disabled={busy || !activeFault}>reset</button>
          </div>
          {msg && <div style={{ fontSize: "10px", color: "#6b6b8a", marginTop: "6px" }}>{msg}</div>}
        </div>

        {/* Trigger button */}
        <button style={s.triggerBtn(triggering)} onClick={handleTriggerCycle} disabled={triggering}>
          {triggering ? "Claude is reading the evidence…" : "Oracle cheated. Slash it. →"}
        </button>
        {!triggering && (
          <div style={s.triggerSub}>
            Claude will adjudicate. Bond transfers on-chain. Watch it happen.
          </div>
        )}

        {cycleResult && (
          <div style={s.resultBox}>
            <div>
              <span style={s.resultLabel}>Verdict:</span>
              <span style={{
                color: cycleResult.verdict === "breach" ? "#ef4444" : "#34d399",
                fontWeight: "700", fontFamily: "'JetBrains Mono', monospace",
              }}>
                {cycleResult.verdict?.toUpperCase()}
              </span>
            </div>
            {cycleResult.slashTx && (
              <div style={{ marginTop: "6px" }}>
                <span style={s.resultLabel}>Seized →</span>
                <a href={`${ARCSCAN}${cycleResult.slashTx}`} target="_blank"
                   rel="noreferrer" style={s.txLink}>
                  {cycleResult.slashTx.slice(0, 20)}… ↗
                </a>
              </div>
            )}
            {cycleResult.reason && (
              <div style={{ marginTop: "8px", color: "#9898b8", fontSize: "10px", lineHeight: "1.6" }}>
                {cycleResult.reason.slice(0, 160)}…
              </div>
            )}
          </div>
        )}
      </div>

      {/* All registered agents */}
      {agents.length > 0 && (
        <div>
          <div style={{
            fontSize: "10px", color: "#6b6b8a", textTransform: "uppercase",
            letterSpacing: "0.1em", marginBottom: "8px", fontWeight: "600",
          }}>
            All Registered Agents ({agents.length})
          </div>
          <div style={s.agentList}>
            {agents.map(agent => {
              const status   = agentStatus(agent);
              const isOracle = agent.address.toLowerCase() === ORACLE_ADDR;
              return (
                <div key={agent.address} style={{
                  ...s.agentRow,
                  borderColor: isOracle ? "#22d3ee30" : "#1e1e2e",
                  background: agent.slashed ? "rgba(239,68,68,0.04)" : "#111118",
                }}>
                  <div>
                    <div style={s.agentAddr}>{fmt(agent.address)}</div>
                    <div style={s.agentMeta}>
                      {agent.agentId?.slice(0, 16)}{isOracle ? " · oracle" : ""}
                    </div>
                  </div>
                  <div style={s.agentRight}>
                    <div style={s.agentAmt}>{fmtUsdc(agent.amount)}</div>
                    <div style={s.badge(status)}>
                      {status === "active"  ? "● active"
                     : status === "slashed" ? "⚡ slashed"
                     :                        "○ no bond"}
                    </div>
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
      <div style={{ ...s.metaValue, color: color || "#e2e8f0" }}>{value}</div>
    </div>
  );
}
