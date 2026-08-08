import { useState } from "react";
import SealMark from "./SealMark.jsx";

const ARCSCAN     = "https://testnet.arcscan.app/tx/";
const ORACLE_ADDR = "0xe2f7a0e6d9865c7dc9b5d19dcc11cbcb4655c661";
const FAULT_MODES = [
  { mode: "stale",   hint: "Oracle returns a real, correctly-signed price — but timestamped over 30s old. Fails the freshness check." },
  { mode: "null",    hint: "Oracle returns no value at all — an empty response with a paid-for nothing." },
  { mode: "bad-sig", hint: "Oracle returns a price with a forged signature — fails cryptographic verification outright." },
];

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Oracle record — the flagship sealed card */}
      <div className="gh" style={{ overflow: "hidden" }}>

        {/* Identity row — the seal lives here */}
        <div style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--hairline)",
          display: "flex", alignItems: "center", gap: "12px",
          background: isSlashed ? "rgba(216,72,60,.06)" : "transparent",
          transition: "background .6s",
        }}>
          <SealMark state={isSlashed ? "broken" : "sealed"} size={30} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "600" }}>
              Price Oracle
            </div>
            <div className="mono" style={{ fontSize: "10px", color: "var(--paper-muted)", marginTop: "3px" }}>
              {fmt(stats?.oracle ?? ORACLE_ADDR)}
            </div>
          </div>
          <Pill status={oracle ? agentSt(oracle) : "no bond"} />
        </div>

        {/* Stats row */}
        <div style={{ display: "flex" }}>
          {[
            ["Bond",    fmtUsdc(oracle?.amount),                    isSlashed ? "var(--breach)" : "var(--paper)", "USDC/USYC collateral this oracle currently has locked on-chain — what a confirmed breach would draw from."],
            ["Calls",   stats?.totalCalls ?? 0,                     "var(--paper)",                               "Total paid /api/price requests served so far."],
            ["Slashes", chainStats?.summary?.totalSlashes ?? 0,     (chainStats?.summary?.totalSlashes ?? 0) > 0 ? "var(--breach)" : "var(--paper)", "Times this oracle's bond has been automatically seized after a confirmed breach."],
          ].map(([lbl, val, color, hint], i) => (
            <div key={lbl} title={hint} style={{
              flex: 1, padding: "11px 14px", cursor: "help",
              borderRight: i < 2 ? "1px solid var(--hairline)" : "none",
            }}>
              <div className="hint" style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>{lbl}</div>
              <div className="mono" style={{ fontSize: "15px", fontWeight: "600", color, marginTop: "3px" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Fault injection */}
        <div style={{ padding: "11px 15px", borderTop: "1px solid var(--hairline)" }}>
          <div className="hint" style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "600", marginBottom: "7px", display: "inline-block" }}
            title="Make the oracle misbehave on its next response, so you can watch the consumer agent catch it and break the seal in real time.">
            Inject fault → Claude detects → seal breaks
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
            {FAULT_MODES.map(({ mode, hint }) => (
              <button key={mode} title={hint} onClick={() => injectFault(mode)} disabled={busy} style={{
                padding: "4px 11px", fontSize: "10px",
                fontFamily: "'IBM Plex Mono', monospace", fontWeight: "600",
                borderRadius: "5px",
                background: activeFault === mode ? "rgba(216,72,60,.16)"     : "rgba(237,234,225,.05)",
                color:      activeFault === mode ? "var(--breach)"           : "var(--paper-muted)",
                border:     `1px solid ${activeFault === mode ? "rgba(216,72,60,.4)" : "var(--hairline-hi)"}`,
                transition: "all .15s",
              }}>
                {mode}
              </button>
            ))}
            <button onClick={resetFault} disabled={busy || !activeFault} style={{
              padding: "4px 10px", fontSize: "10px", borderRadius: "5px",
              background: "rgba(237,234,225,.03)", color: "var(--paper-faint)",
              border: "1px solid var(--hairline)",
            }}>
              reset
            </button>
            {msg && <span className="mono" style={{ fontSize: "9px", color: "var(--paper-muted)" }}>{msg}</span>}
          </div>
        </div>

        {/* CTA */}
        <div style={{ padding: "13px 15px", borderTop: "1px solid var(--hairline)" }}>
          <button
            onClick={trigger} disabled={triggering}
            title="Runs one full fault → verify → break-the-seal cycle end to end against the live contract, so you don't have to wait for the timer loop."
            style={{
              width: "100%", padding: "13px 18px",
              fontSize: "13px", fontWeight: "700", letterSpacing: "-.01em",
              borderRadius: "8px",
              background: triggering ? "rgba(237,234,225,.05)" : "var(--breach)",
              color: triggering ? "var(--paper-faint)" : "#EDEAE1",
              cursor: triggering ? "not-allowed" : "pointer",
              transition: "all .2s",
            }}
          >
            {triggering ? "Claude is adjudicating…" : "Oracle cheated. Break the seal. →"}
          </button>
          {!triggering && (
            <div style={{ fontSize: "10px", color: "var(--paper-faint)", textAlign: "center", marginTop: "7px" }}>
              Claude decides · USDC moves on-chain · live
            </div>
          )}
          {result && (
            <div style={{
              marginTop: "10px", padding: "11px 13px", borderRadius: "7px",
              background: "rgba(0,0,0,.25)",
              border: `1px solid ${result.verdict === "breach" ? "rgba(216,72,60,.3)" : "rgba(127,184,143,.25)"}`,
            }}>
              <div className="mono" style={{ fontSize: "13px", fontWeight: "700",
                color: result.verdict === "breach" ? "var(--breach)" : "var(--settle)" }}>
                {result.verdict?.toUpperCase()}
              </div>
              {result.slashTx && (
                <a href={`${ARCSCAN}${result.slashTx}`} target="_blank" rel="noreferrer"
                  className="mono" style={{ fontSize: "9px", color: "var(--seal)", textDecoration: "none", display: "block", marginTop: "4px" }}>
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
            padding: "9px 14px", borderBottom: "1px solid var(--hairline)",
            fontSize: "9px", color: "var(--paper-faint)",
            textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "600",
          }}>
            Registered agents ({agents.length})
          </div>
          {agents.map(a => {
            const st = agentSt(a);
            const isO = a.address.toLowerCase() === ORACLE_ADDR;
            return (
              <div key={a.address} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "9px 14px", borderBottom: "1px solid var(--hairline)",
                background: a.slashed ? "rgba(216,72,60,.04)" : "transparent",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <SealMark state={a.slashed ? "broken" : "sealed"} size={15} />
                  <span className="mono" style={{ fontSize: "10px", color: "var(--paper-muted)" }}>
                    {fmt(a.address)}{isO ? " · oracle" : ""}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="mono" style={{ fontSize: "11px", fontWeight: "600" }}>{fmtUsdc(a.amount)}</span>
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
  const { color, label, hint } = {
    active:   { color: "var(--settle)", label: "sealed",  hint: "Bond is posted and unslashed — this agent is currently allowed to sell service." },
    slashed:  { color: "var(--breach)", label: "broken",  hint: "This agent's bond has been paid out after a confirmed breach — it can re-bond to sell again." },
    "no bond":{ color: "var(--paper-faint)", label: "no bond", hint: "This wallet isn't TEE-registered or hasn't posted collateral yet — it can't sell service." },
  }[status] ?? { color: "var(--paper-faint)", label: "—", hint: undefined };

  return (
    <div title={hint} style={{
      padding: small ? "2px 8px" : "3px 10px",
      borderRadius: "4px", fontSize: "10px", fontWeight: "600",
      background: "transparent", color,
      border: `1px solid ${color}`,
      opacity: 0.85,
      whiteSpace: "nowrap", transition: "all .5s",
      cursor: hint ? "help" : "default",
    }}>
      {label}
    </div>
  );
}
