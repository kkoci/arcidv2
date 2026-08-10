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

export default function AgentCard({ stats, chainStats, onCycleComplete, triggerRef }) {
  const [activeFault, setFault]      = useState(null);
  const [busy,        setBusy]       = useState(false);
  const [msg,         setMsg]        = useState("");
  const [result,      setResult]     = useState(null);
  const [triggering,  setTriggering] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  // Synchronous, one-shot, no background loop required: this single request
  // forces the fault, checks it, and slashes on-chain, all server-side,
  // returning the result (including a real tx hash) in this same response.
  // Same underlying mechanism the CLI's `npm run demo:hard-breach` (in
  // consumer/) uses independently — two callers, one real trigger each.
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
          background: isSlashed ? "var(--breach-soft)" : "transparent",
          transition: "background .6s",
        }}>
          <SealMark state={isSlashed ? "broken" : "sealed"} size={30} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "9px", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "600" }}>
              Price Oracle
            </div>
            <div className="mono" style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "3px" }}>
              {fmt(stats?.oracle ?? ORACLE_ADDR)}
            </div>
          </div>
          <Pill status={oracle ? agentSt(oracle) : "no bond"} />
        </div>

        {/* Stats row */}
        <div style={{ display: "flex" }}>
          {[
            ["Bond",          fmtUsdc(oracle?.amount),                    isSlashed ? "var(--breach)" : "var(--text)", "USDC/USYC collateral this oracle currently has locked on-chain — what a confirmed breach would draw from."],
            ["Calls",         stats?.totalCalls ?? 0,                     "var(--text)",                               "Total paid /api/price requests served so far, this session."],
            ["Slashes (all-time)", chainStats?.summary?.totalSlashes ?? 0, (chainStats?.summary?.totalSlashes ?? 0) > 0 ? "var(--breach)" : "var(--text)", "Read directly from on-chain AgentSlashed events — every confirmed breach ever recorded against this bond contract, not just this session. The Adjudication Feed below only shows verdicts from the current oracle session, so these two counts are expected to differ."],
          ].map(([lbl, val, color, hint], i) => (
            <div key={lbl} title={hint} style={{
              flex: 1, padding: "11px 14px", cursor: "help",
              borderRight: i < 2 ? "1px solid var(--hairline)" : "none",
            }}>
              <div className="hint" style={{ fontSize: "9px", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>{lbl}</div>
              <div className="mono" style={{ fontSize: "15px", fontWeight: "600", color, marginTop: "3px" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* PRIMARY CTA — the one obvious demo action. No fault-mode picker:
            bad-sig is hardcoded server-side because it's deterministic and
            needs no Anthropic key, so this always works the same way. */}
        <div style={{ padding: "13px 15px", borderTop: "1px solid var(--hairline)" }}>
          <button
            ref={triggerRef}
            onClick={trigger} disabled={triggering}
            title="Runs the entire fault → verify → slash cycle in one request, synchronously, against the live contract — no background process needs to be running."
            style={{
              width: "100%", padding: "13px 18px",
              fontSize: "13px", fontWeight: "700", letterSpacing: "-.01em",
              borderRadius: "10px",
              background: triggering ? "rgba(20,20,25,.05)" : "var(--breach)",
              color: triggering ? "var(--text-faint)" : "#fff",
              cursor: triggering ? "not-allowed" : "pointer",
              boxShadow: triggering ? "none" : "var(--shadow-sm)",
              transition: "all .2s",
            }}
          >
            {triggering ? "Slashing on-chain…" : "Trigger a live slash →"}
          </button>
          {!triggering && (
            <div style={{ fontSize: "10px", color: "var(--text-faint)", textAlign: "center", marginTop: "7px" }}>
              One click · real tx · a few seconds
            </div>
          )}
          {msg && !result && (
            <div style={{ fontSize: "10px", color: "var(--breach)", textAlign: "center", marginTop: "6px" }}>{msg}</div>
          )}
          {result && (
            <div style={{
              marginTop: "10px", padding: "11px 13px", borderRadius: "10px",
              background: result.verdict === "breach" ? "var(--breach-soft)" : "var(--settle-soft)",
              border: `1px solid ${result.verdict === "breach" ? "rgba(229,72,77,.3)" : "rgba(18,161,80,.25)"}`,
            }}>
              <div className="mono" style={{ fontSize: "13px", fontWeight: "700",
                color: result.verdict === "breach" ? "var(--breach)" : "var(--settle)" }}>
                {result.verdict?.toUpperCase()}
              </div>
              {result.slashTx && (
                <a href={`${ARCSCAN}${result.slashTx}`} target="_blank" rel="noreferrer"
                  className="mono" style={{ fontSize: "9px", color: "var(--accent)", textDecoration: "none", display: "block", marginTop: "4px" }}>
                  {result.slashTx.slice(0,26)}… ↗
                </a>
              )}
            </div>
          )}
        </div>

        {/* Advanced — manual per-mode fault injection, for the real timer
            loop (consumer && npm start), NOT the primary demo path above.
            Collapsed by default so it doesn't compete with the one-click
            trigger for attention. */}
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <button onClick={() => setAdvancedOpen(v => !v)} style={{
            width: "100%", background: "none", border: "none", textAlign: "left",
            padding: "9px 15px", fontSize: "9px", color: "var(--text-faint)",
            letterSpacing: ".1em", textTransform: "uppercase", fontWeight: "600",
          }}>
            {advancedOpen ? "▾" : "▸"} Advanced — manual fault injection
          </button>
          {advancedOpen && (
            <div style={{ padding: "0 15px 13px" }}>
              <div className="hint" style={{ fontSize: "9px", color: "var(--text-faint)", marginBottom: "7px", display: "inline-block" }}
                title="Sets a flag the oracle returns on its NEXT real /api/price call — for use with the actual consumer timer loop, not a one-shot trigger like the button above.">
                Sets a fault flag for the next real oracle call (needs the consumer loop running)
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                {FAULT_MODES.map(({ mode, hint }) => (
                  <button key={mode} title={hint} onClick={() => injectFault(mode)} disabled={busy} style={{
                    padding: "4px 11px", fontSize: "10px",
                    fontFamily: "'IBM Plex Mono', monospace", fontWeight: "600",
                    borderRadius: "6px",
                    background: activeFault === mode ? "var(--breach-soft)"      : "rgba(20,20,25,.04)",
                    color:      activeFault === mode ? "var(--breach)"           : "var(--text-muted)",
                    border:     `1px solid ${activeFault === mode ? "rgba(229,72,77,.4)" : "var(--hairline-hi)"}`,
                    transition: "all .15s",
                  }}>
                    {mode}
                  </button>
                ))}
                <button onClick={resetFault} disabled={busy || !activeFault} style={{
                  padding: "4px 10px", fontSize: "10px", borderRadius: "6px",
                  background: "rgba(20,20,25,.03)", color: "var(--text-faint)",
                  border: "1px solid var(--hairline)",
                }}>
                  reset
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Agent registry */}
      {agents.length > 0 && (
        <div className="g" style={{ overflow: "hidden" }}>
          <div style={{
            padding: "9px 14px", borderBottom: "1px solid var(--hairline)",
            fontSize: "9px", color: "var(--text-faint)",
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
                background: a.slashed ? "var(--breach-soft)" : "transparent",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <SealMark state={a.slashed ? "broken" : "sealed"} size={15} />
                  <span className="mono" style={{ fontSize: "10px", color: "var(--text-muted)" }}>
                    {fmt(a.address)}{isO ? " · oracle" : ""}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="mono" style={{ fontSize: "11px", fontWeight: "600", color: "var(--text)" }}>{fmtUsdc(a.amount)}</span>
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
  const { bg, color, label, hint } = {
    active:   { bg: "var(--settle-soft)", color: "var(--settle)",    label: "sealed",  hint: "Bond is posted and unslashed — this agent is currently allowed to sell service." },
    slashed:  { bg: "var(--breach-soft)", color: "var(--breach)",    label: "broken",  hint: "This agent's bond has been paid out after a confirmed breach — it can re-bond to sell again." },
    "no bond":{ bg: "rgba(20,20,25,.04)", color: "var(--text-faint)", label: "no bond", hint: "This wallet isn't TEE-registered or hasn't posted collateral yet — it can't sell service." },
  }[status] ?? { bg: "rgba(20,20,25,.04)", color: "var(--text-faint)", label: "—", hint: undefined };

  return (
    <div title={hint} style={{
      padding: small ? "2px 8px" : "3px 10px",
      borderRadius: "6px", fontSize: "10px", fontWeight: "600",
      background: bg, color,
      whiteSpace: "nowrap", transition: "all .5s",
      cursor: hint ? "help" : "default",
    }}>
      {label}
    </div>
  );
}
