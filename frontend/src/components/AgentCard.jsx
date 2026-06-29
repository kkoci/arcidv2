import { useState } from "react";

const ARCSCAN     = "https://testnet.arcscan.app/tx/";
const ORACLE_ADDR = "0xe2f7a0e6d9865c7dc9b5d19dcc11cbcb4655c661";
const FAULT_MODES = ["stale", "null", "bad-sig"];

const fmt     = a => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—";
const fmtUsdc = r => r != null ? `$${(Number(r)/1e6).toFixed(2)}` : "—";
const agentSt = a => a.active ? "active" : a.slashed ? "slashed" : "no bond";

export default function AgentCard({ stats, chainStats, onCycleComplete }) {
  const [activeFault, setFault]      = useState(null);
  const [busy,        setBusy]       = useState(false);
  const [msg,         setMsg]        = useState("");
  const [result,      setResult]     = useState(null);
  const [triggering,  setTriggering] = useState(false);

  const agents      = chainStats?.agents ?? [];
  const oracle      = agents.find(a => a.address.toLowerCase() === ORACLE_ADDR);
  const isSlashed   = oracle?.slashed === true;

  async function injectFault(mode) {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/admin/fault", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (r.ok) { setFault(mode); setMsg(`${mode} active`); }
      else setMsg("Failed");
    } catch { setMsg("Error"); }
    finally { setBusy(false); }
  }

  async function resetFault() {
    setBusy(true);
    try { await fetch("/admin/fault/reset", { method: "POST" }); setFault(null); setMsg(""); }
    catch {}
    finally { setBusy(false); }
  }

  async function trigger() {
    setTriggering(true); setResult(null); setMsg("");
    try {
      const r = await fetch("/admin/trigger-cycle", { method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await r.json();
      if (!r.ok) { setMsg(`Error: ${data.error}`); return; }
      setResult(data);
      if (onCycleComplete) setTimeout(onCycleComplete, 1200);
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setTriggering(false); }
  }

  const slashColor = "#fb7103";
  const liveColor  = "#22d9e8";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Oracle card */}
      <div className="gh" style={{ overflow: "hidden" }}>

        {/* Identity row */}
        <div style={{
          padding: "14px 16px",
          borderBottom: "1px solid rgba(255,255,255,.07)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: isSlashed
            ? "rgba(251,113,3,.09)"
            : "rgba(192,132,252,.06)",
          transition: "background .6s",
        }}>
          <div>
            <div style={{ fontSize: "9px", color: "rgba(242,240,255,.3)", textTransform: "uppercase", letterSpacing: ".12em", fontWeight: "600" }}>
              Price Oracle
            </div>
            <div className="mono" style={{ fontSize: "10px", color: liveColor, marginTop: "3px" }}>
              {fmt(stats?.oracle ?? ORACLE_ADDR)}
            </div>
          </div>
          <Pill status={oracle ? agentSt(oracle) : "no bond"} />
        </div>

        {/* Stats row */}
        <div style={{ display: "flex" }}>
          {[
            ["Bond",    fmtUsdc(oracle?.amount),                    isSlashed ? slashColor : liveColor],
            ["Calls",   stats?.totalCalls ?? 0,                     null],
            ["Slashes", chainStats?.summary?.totalSlashes ?? 0,     (chainStats?.summary?.totalSlashes ?? 0) > 0 ? slashColor : null],
          ].map(([lbl, val, color], i) => (
            <div key={lbl} style={{
              flex: 1, padding: "11px 14px",
              borderRight: i < 2 ? "1px solid rgba(255,255,255,.06)" : "none",
            }}>
              <div style={{ fontSize: "9px", color: "rgba(242,240,255,.25)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>{lbl}</div>
              <div className="mono" style={{ fontSize: "15px", fontWeight: "800", color: color || "#f2f0ff", marginTop: "3px" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Fault injection */}
        <div style={{ padding: "11px 15px", borderTop: "1px solid rgba(255,255,255,.06)" }}>
          <div style={{ fontSize: "9px", color: "rgba(242,240,255,.2)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "600", marginBottom: "7px" }}>
            Inject fault → Claude detects → slashes
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
            {FAULT_MODES.map(m => (
              <button key={m} onClick={() => injectFault(m)} disabled={busy} style={{
                padding: "4px 11px", fontSize: "10px",
                fontFamily: "'JetBrains Mono', monospace", fontWeight: "600",
                borderRadius: "6px",
                background: activeFault === m ? "rgba(251,113,3,.18)"            : "rgba(255,255,255,.06)",
                color:      activeFault === m ? slashColor                       : "rgba(242,240,255,.4)",
                border:     `1px solid ${activeFault === m ? "rgba(251,113,3,.4)" : "rgba(255,255,255,.1)"}`,
                transition: "all .15s",
              }}>
                {m}
              </button>
            ))}
            <button onClick={resetFault} disabled={busy || !activeFault} style={{
              padding: "4px 10px", fontSize: "10px", borderRadius: "6px",
              background: "rgba(255,255,255,.04)", color: "rgba(242,240,255,.2)",
              border: "1px solid rgba(255,255,255,.08)",
            }}>
              reset
            </button>
            {msg && <span className="mono" style={{ fontSize: "9px", color: "rgba(242,240,255,.4)" }}>{msg}</span>}
          </div>
        </div>

        {/* Big CTA */}
        <div style={{ padding: "13px 15px", borderTop: "1px solid rgba(255,255,255,.06)" }}>
          <button
            onClick={trigger} disabled={triggering}
            style={{
              width: "100%", padding: "14px 18px",
              fontSize: "13px", fontWeight: "900", letterSpacing: "-.01em",
              borderRadius: "10px",
              background: triggering
                ? "rgba(255,255,255,.05)"
                : `linear-gradient(135deg, ${slashColor} 0%, #e05f00 100%)`,
              color: triggering ? "rgba(242,240,255,.2)" : "#fff",
              boxShadow: triggering ? "none" : `0 6px 28px rgba(251,113,3,.45), inset 0 1px 0 rgba(255,255,255,.2)`,
              cursor: triggering ? "not-allowed" : "pointer",
              transition: "all .2s",
            }}
          >
            {triggering ? "Claude is adjudicating…" : "Oracle cheated. Slash it. →"}
          </button>
          {!triggering && (
            <div style={{ fontSize: "10px", color: "rgba(242,240,255,.18)", textAlign: "center", marginTop: "7px" }}>
              Claude decides · USDC moves on-chain · live
            </div>
          )}
          {result && (
            <div style={{
              marginTop: "10px", padding: "11px 13px", borderRadius: "8px",
              background: "rgba(0,0,0,.35)",
              border: `1px solid ${result.verdict === "breach" ? "rgba(251,113,3,.3)" : "rgba(34,217,232,.2)"}`,
            }}>
              <div className="mono" style={{ fontSize: "13px", fontWeight: "800",
                color: result.verdict === "breach" ? slashColor : liveColor }}>
                {result.verdict?.toUpperCase()}
              </div>
              {result.slashTx && (
                <a href={`${ARCSCAN}${result.slashTx}`} target="_blank" rel="noreferrer"
                  className="mono" style={{ fontSize: "9px", color: liveColor, textDecoration: "none", display: "block", marginTop: "4px" }}>
                  {result.slashTx.slice(0,26)}… ↗
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Agent registry */}
      {agents.length > 0 && (
        <div className="g" style={{ overflow: "hidden" }}>
          <div style={{
            padding: "9px 14px", borderBottom: "1px solid rgba(255,255,255,.06)",
            fontSize: "9px", color: "rgba(242,240,255,.25)",
            textTransform: "uppercase", letterSpacing: ".12em", fontWeight: "600",
          }}>
            Registered agents ({agents.length})
          </div>
          {agents.map(a => {
            const st = agentSt(a);
            const isO = a.address.toLowerCase() === ORACLE_ADDR;
            return (
              <div key={a.address} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "9px 14px", borderBottom: "1px solid rgba(255,255,255,.03)",
                background: a.slashed ? "rgba(251,113,3,.04)" : "transparent",
              }}>
                <span className="mono" style={{ fontSize: "10px", color: liveColor }}>
                  {fmt(a.address)}{isO ? " · oracle" : ""}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="mono" style={{ fontSize: "11px", fontWeight: "700" }}>{fmtUsdc(a.amount)}</span>
                  <Pill status={st} small />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Pill({ status, small }) {
  const { color, label } = {
    active:   { color: "#22d9e8", label: "● active"  },
    slashed:  { color: "#fb7103", label: "⚡ slashed" },
    "no bond":{ color: "rgba(242,240,255,.3)", label: "○ no bond" },
  }[status] ?? { color: "rgba(242,240,255,.3)", label: "○ —" };

  return (
    <div style={{
      padding: small ? "2px 8px" : "3px 10px",
      borderRadius: "99px", fontSize: "10px", fontWeight: "700",
      background: color + "18", color,
      border: `1px solid ${color}45`,
      whiteSpace: "nowrap", transition: "all .5s",
    }}>
      {label}
    </div>
  );
}
