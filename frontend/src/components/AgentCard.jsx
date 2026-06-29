import { useState } from "react";

const ARCSCAN     = "https://testnet.arcscan.app/tx/";
const ORACLE_ADDR = "0xe2f7a0e6d9865c7dc9b5d19dcc11cbcb4655c661";
const FAULT_MODES = ["stale", "null", "bad-sig"];

function fmt(addr)    { return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "—"; }
function fmtUsdc(raw) { return raw  ? `${(Number(raw) / 1e6).toFixed(2)} USDC` : "—"; }
function agentStatus(a) {
  if (a.active)  return "active";
  if (a.slashed) return "slashed";
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
      if (r.ok) { setActiveFault(mode); setMsg(`"${mode}" active`); }
      else setMsg("Failed");
    } catch { setMsg("Error"); }
    finally { setBusy(false); }
  }

  async function resetFault() {
    setBusy(true);
    try {
      await fetch("/admin/fault/reset", { method: "POST" });
      setActiveFault(null); setMsg("");
    } catch {}
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
      if (onCycleComplete) setTimeout(onCycleComplete, 1200);
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setTriggering(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>

      {/* Main CTA card */}
      <div style={{
        background: "#0d0f1f",
        border: "1px solid #1a1b2e",
        borderRadius: "10px",
        overflow: "hidden",
      }}>
        {/* Oracle identity */}
        <div style={{
          padding: "14px 16px",
          borderBottom: "1px solid #1a1b2e",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: isSlashed ? "rgba(239,68,68,0.07)" : "transparent",
          transition: "background 0.5s",
        }}>
          <div>
            <div style={{ fontSize: "10px", color: "#5c5f7a", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: "600" }}>Price Oracle</div>
            <div style={{ fontSize: "10px", color: "#22d3ee", fontFamily: "'JetBrains Mono', monospace", marginTop: "3px" }}>
              {fmt(stats?.oracle ?? ORACLE_ADDR)}
            </div>
          </div>
          <StatusBadge status={oracleAgent ? agentStatus(oracleAgent) : "no bond"} />
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", borderBottom: "1px solid #1a1b2e" }}>
          {[
            ["Bond",    fmtUsdc(oracleAgent?.amount), isSlashed ? "#ef4444" : "#22d3ee"],
            ["Calls",   stats?.totalCalls ?? 0, null],
            ["Slashes", chainStats?.summary?.totalSlashes ?? 0, (chainStats?.summary?.totalSlashes ?? 0) > 0 ? "#ef4444" : null],
          ].map(([label, value, color]) => (
            <div key={label} style={{ flex: 1, padding: "10px 14px", borderRight: "1px solid #1a1b2e" }}>
              <div style={{ fontSize: "9px", color: "#5c5f7a", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: "600" }}>{label}</div>
              <div style={{ fontSize: "13px", fontWeight: "700", color: color || "#e8eaf6", fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Fault injection */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #1a1b2e" }}>
          <div style={{ fontSize: "9px", color: "#3a3c52", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: "600", marginBottom: "7px" }}>
            Force a fault → Claude detects → slashes
          </div>
          <div style={{ display: "flex", gap: "5px", alignItems: "center", flexWrap: "wrap" }}>
            {FAULT_MODES.map(m => (
              <button key={m} onClick={() => triggerFault(m)} disabled={busy}
                style={{
                  padding: "4px 10px", fontSize: "10px", borderRadius: "4px",
                  fontFamily: "'JetBrains Mono', monospace",
                  background: activeFault === m ? "rgba(239,68,68,0.2)" : "#08091a",
                  color:      activeFault === m ? "#ef4444" : "#5c5f7a",
                  border:     `1px solid ${activeFault === m ? "rgba(239,68,68,0.4)" : "#1a1b2e"}`,
                }}>
                {m}
              </button>
            ))}
            <button onClick={resetFault} disabled={busy || !activeFault}
              style={{ padding: "4px 8px", fontSize: "10px", borderRadius: "4px", background: "#08091a", color: "#3a3c52", border: "1px solid #1a1b2e" }}>
              reset
            </button>
            {msg && <span style={{ fontSize: "9px", color: "#5c5f7a" }}>{msg}</span>}
          </div>
        </div>

        {/* Trigger button */}
        <div style={{ padding: "14px 16px" }}>
          <button
            onClick={handleTriggerCycle}
            disabled={triggering}
            style={{
              width: "100%", padding: "14px",
              fontSize: "13px", fontWeight: "800", letterSpacing: "0.01em",
              borderRadius: "8px", border: "none",
              background: triggering ? "#1a1b2e" : "linear-gradient(90deg, #ef4444, #dc2626)",
              color: triggering ? "#5c5f7a" : "#fff",
              boxShadow: triggering ? "none" : "0 4px 24px rgba(239,68,68,0.4)",
              cursor: triggering ? "not-allowed" : "pointer",
              transition: "all 0.2s",
            }}
          >
            {triggering ? "Claude is reading the evidence…" : "Oracle cheated. Slash it. →"}
          </button>
          {!triggering && (
            <div style={{ fontSize: "10px", color: "#3a3c52", textAlign: "center", marginTop: "7px" }}>
              Claude adjudicates · bond transfers on-chain · live
            </div>
          )}
          {cycleResult && (
            <div style={{ marginTop: "10px", padding: "10px 12px", background: "#08091a", borderRadius: "6px", border: "1px solid #1a1b2e" }}>
              <div style={{ fontWeight: "700", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", color: cycleResult.verdict === "breach" ? "#ef4444" : "#34d399" }}>
                {cycleResult.verdict?.toUpperCase()}
              </div>
              {cycleResult.slashTx && (
                <a href={`${ARCSCAN}${cycleResult.slashTx}`} target="_blank" rel="noreferrer"
                  style={{ fontSize: "10px", color: "#22d3ee", fontFamily: "'JetBrains Mono', monospace", textDecoration: "none", display: "block", marginTop: "4px" }}>
                  {cycleResult.slashTx.slice(0, 24)}… ↗
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Registered agents */}
      {agents.length > 0 && (
        <div style={{ background: "#0d0f1f", border: "1px solid #1a1b2e", borderRadius: "10px", overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid #1a1b2e", fontSize: "9px", color: "#3a3c52", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: "600" }}>
            All Registered Agents ({agents.length})
          </div>
          {agents.map(agent => {
            const status   = agentStatus(agent);
            const isOracle = agent.address.toLowerCase() === ORACLE_ADDR;
            return (
              <div key={agent.address} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 14px", borderBottom: "1px solid #08091a",
                background: agent.slashed ? "rgba(239,68,68,0.04)" : "transparent",
              }}>
                <div>
                  <div style={{ fontSize: "10px", color: "#22d3ee", fontFamily: "'JetBrains Mono', monospace" }}>
                    {fmt(agent.address)}{isOracle ? " · oracle" : ""}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "11px", fontWeight: "700", color: "#e8eaf6", fontFamily: "'JetBrains Mono', monospace" }}>
                    {fmtUsdc(agent.amount)}
                  </span>
                  <StatusBadge status={status} small />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, small }) {
  const color = status === "active" ? "#34d399" : status === "slashed" ? "#ef4444" : "#5c5f7a";
  const label = status === "active" ? "● active" : status === "slashed" ? "⚡ slashed" : "○ no bond";
  return (
    <div style={{
      padding: small ? "2px 8px" : "3px 10px",
      borderRadius: "99px", fontSize: "10px", fontWeight: "700",
      background: color + "18", color, border: `1px solid ${color}40`,
      whiteSpace: "nowrap", transition: "all 0.4s",
    }}>
      {label}
    </div>
  );
}
