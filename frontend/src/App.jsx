import { useEffect, useState, useRef } from "react";
import SealMark          from "./components/SealMark.jsx";
import AgentCard          from "./components/AgentCard.jsx";
import VerdictHistory     from "./components/VerdictHistory.jsx";
import GatewayPaymentCard from "./components/GatewayPaymentCard.jsx";
import GrantMetricsCard   from "./components/GrantMetricsCard.jsx";
import USYCBondCard       from "./components/USYCBondCard.jsx";
import ProofOfExploitCard from "./components/ProofOfExploitCard.jsx";

const POLL_MS = 5000;

// Unified mechanism flow — one narrative at the top instead of a duplicate
// 4-step explainer per product below (the "unify the story, not the code"
// call from the unification brainstorm).
const STEPS = [
  { n: "01", title: "Post collateral",       body: "Real USDC/USYC locked before any claim can be made." },
  { n: "02", title: "TEE proves identity",   body: "Intel TDX attests the exact code that will judge the outcome." },
  { n: "03", title: "Outcome is verified",   body: "Deterministic where possible; Claude only where a judgment call is unavoidable." },
  { n: "04", title: "Settled automatically", body: "Slash, pay, or release — on-chain, no human review." },
];

export default function App() {
  const [stats,      setStats]      = useState(null);
  const [chainStats, setChainStats] = useState(null);
  const [verdicts,   setVerdicts]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [live,       setLive]       = useState(false);
  const [lastPoll,   setLastPoll]   = useState(null);
  const timerRef   = useRef(null);
  const oracleRef  = useRef(null);
  const exploitRef = useRef(null);

  // Kept on the fixed 5s interval — both are always fast (in-memory on the
  // oracle process, no RPC round-trip).
  async function poll() {
    try {
      const [sRes, vRes] = await Promise.all([fetch("/api/stats"), fetch("/api/verdicts")]);
      if (sRes.ok) setStats(await sRes.json());
      if (vRes.ok) setVerdicts((await vRes.json()).verdicts ?? []);
      setLive(true);
    } catch { setLive(false); }
    finally { setLoading(false); setLastPoll(new Date()); }
  }

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  // Chain-stats polled on its own self-rescheduling loop, separate from the
  // fixed interval above. Its first call can be a slow historical on-chain
  // log scan (see oracle/src/chain.js — rate-limited RPC, chunked
  // eth_getLogs) that can take far longer than POLL_MS; a fixed setInterval
  // would fire a new overlapping request every 5s on top of the one still
  // pending. This waits for each fetch to settle before scheduling the
  // next, so it never piles up, and it no longer blocks stats/verdicts from
  // showing up while it's still working through a slow first scan.
  useEffect(() => {
    let cancelled = false;
    let timeoutId;

    async function pollChainStats() {
      try {
        const r = await fetch("/api/chain-stats");
        if (!cancelled && r.ok) setChainStats(await r.json());
      } catch { /* keep retrying on the next tick */ }
      if (!cancelled) timeoutId = setTimeout(pollChainStats, POLL_MS);
    }

    pollChainStats();
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, []);

  const sorted     = [...verdicts].reverse();
  const slashCount = chainStats?.summary?.totalSlashes ?? 0;
  const tvlRaw     = chainStats?.summary?.tvlUsdc;
  const tvlDisplay = tvlRaw != null ? `$${(Number(tvlRaw)/1e6).toFixed(2)}` : "—";
  const agentCount = chainStats?.summary?.activeAgents ?? "—";

  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div style={{ minHeight: "100vh" }}>

      {/* ── Header — brand + jump-nav, not a product picker ── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 100,
        background: "rgba(10,12,16,.9)", backdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--hairline)",
        padding: "0 28px", display: "flex", alignItems: "center", height: "58px", gap: "20px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <SealMark state="sealed" size={24} />
          <span className="display" style={{ fontSize: "17px", fontWeight: "700" }}>ArcID</span>
          <span style={{
            fontSize: "9px", padding: "2px 8px", borderRadius: "3px",
            background: "rgba(192,138,62,.12)", color: "var(--seal)",
            border: "1px solid rgba(192,138,62,.3)", fontWeight: "600", letterSpacing: ".1em",
          }}>TESTNET</span>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => scrollTo(oracleRef)} style={{
          background: "none", border: "1px solid var(--hairline-hi)", color: "var(--paper-muted)",
          padding: "6px 14px", fontSize: "11px", borderRadius: "6px",
        }}>01 · Data SLA</button>
        <button onClick={() => scrollTo(exploitRef)} style={{
          background: "none", border: "1px solid var(--hairline-hi)", color: "var(--paper-muted)",
          padding: "6px 14px", fontSize: "11px", borderRadius: "6px",
        }}>02 · Exploit Bounty</button>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "8px" }}>
          <div style={{
            width: "6px", height: "6px", borderRadius: "50%",
            background: live ? "var(--settle)" : "var(--breach)",
            animation: live ? "pulse 2.5s infinite" : "none",
          }} />
          <span className="mono" style={{ fontSize: "10px", color: "var(--paper-faint)" }}>
            {live ? lastPoll?.toLocaleTimeString() : "offline"}
          </span>
        </div>
      </header>

      {/* ── HERO — the thesis, not a tab picker ── */}
      <section style={{ padding: "56px 28px 40px", borderBottom: "1px solid var(--hairline)", textAlign: "center" }}>
        <div style={{ maxWidth: "760px", margin: "0 auto" }}>
          <div style={{
            fontSize: "10px", fontWeight: "700", letterSpacing: ".14em", textTransform: "uppercase",
            color: "var(--seal)", marginBottom: "16px",
          }}>
            Bonded verification protocol · Arc testnet
          </div>
          <h1 className="display" style={{
            fontSize: "clamp(30px, 4.2vw, 48px)", fontWeight: "700", letterSpacing: "-0.015em",
            lineHeight: "1.12", color: "var(--paper)", marginBottom: "18px",
          }}>
            Machine-to-machine payments happen too fast to review by hand.<br />
            <span style={{ color: "var(--seal)" }}>ArcID bonds collateral and settles automatically.</span>
          </h1>
          <p style={{ fontSize: "15px", color: "var(--paper-muted)", lineHeight: "1.7", maxWidth: "560px", margin: "0 auto" }}>
            Real USDC collateral behind hardware-attested identity, paid over x402 nanopayments —
            deterministic checks where possible, an AI adjudicator only where judgment is genuinely required.
          </p>
        </div>

        {/* Mechanism flow */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "10px", maxWidth: "900px", margin: "40px auto 0",
        }}>
          {STEPS.map((s) => (
            <div key={s.n} className="g" style={{ padding: "16px 14px", textAlign: "left" }}>
              <div className="mono" style={{ fontSize: "11px", fontWeight: "700", color: "var(--seal)", marginBottom: "6px" }}>{s.n}</div>
              <div style={{ fontSize: "12.5px", fontWeight: "600", color: "var(--paper)", marginBottom: "5px" }}>{s.title}</div>
              <div style={{ fontSize: "10.5px", color: "var(--paper-faint)", lineHeight: "1.6" }}>{s.body}</div>
            </div>
          ))}
        </div>

        {/* Live counters */}
        <div style={{ display: "flex", justifyContent: "center", gap: "0", marginTop: "36px" }}>
          {[
            ["bonded",     agentCount,  "Agents currently holding an active USDC/USYC bond — the collateral that makes their reputation real money, not a score."],
            ["under seal", tvlDisplay,  "Total collateral currently posted across all bonded agents — this is what a confirmed breach draws from."],
            ["slashed",    slashCount,  "Confirmed breaches where the bond contract has automatically paid the injured party out of the provider's collateral."],
          ].map(([label, val, hint], i) => (
            <div key={label} title={hint} style={{
              padding: "0 22px", borderLeft: i > 0 ? "1px solid var(--hairline)" : "none",
              textAlign: "center", cursor: "help",
            }}>
              <div className="mono" style={{
                fontSize: "20px", fontWeight: "700",
                color: loading ? "rgba(237,234,225,.15)" : (label === "slashed" && slashCount > 0) ? "var(--breach)" : "var(--paper)",
              }}>
                {loading ? "—" : val}
              </div>
              <div style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", marginTop: "3px" }}>{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── LIVE APPLICATIONS — proof points, not products to pick between ── */}
      <section style={{ padding: "40px 28px 12px", textAlign: "center" }}>
        <div className="display" style={{ fontSize: "13px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--paper-faint)" }}>
          Live applications on Arc testnet
        </div>
        <p style={{ fontSize: "12px", color: "var(--paper-faint)", marginTop: "6px" }}>
          Same protocol, two different claims being enforced
        </p>
      </section>

      {/* ── App 1: Data SLA ── */}
      <section ref={oracleRef} style={{ padding: "20px 28px 48px", borderBottom: "1px solid var(--hairline)" }}>
        <AppHeader n="01" title="Data SLA Bond" desc="An oracle stakes collateral, sells price data per-call, and Claude checks whether it kept its promise — freshness, presence, a genuine signature." />
        <div style={{
          maxWidth: "1400px", margin: "0 auto", display: "grid",
          gridTemplateColumns: "1fr 370px", gap: "16px", alignItems: "start",
        }}>
          <VerdictHistory verdicts={sorted} />
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <AgentCard stats={stats} chainStats={chainStats} onCycleComplete={poll} />
            <GrantMetricsCard stats={stats} chainStats={chainStats} />
            <GatewayPaymentCard />
            <USYCBondCard usyc={stats?.usyc} />
            <TechDetails stats={stats} />
          </div>
        </div>
      </section>

      {/* ── App 2: Proof of Exploit ── */}
      <section ref={exploitRef} style={{ padding: "40px 28px 56px" }}>
        <AppHeader n="02" title="Proof-of-Exploit Bounty" desc="A researcher submits an exploit. It runs against a forked target — the invariant either breaks or it doesn't. No judgment call, no LLM in the payout path." />
        <div style={{ maxWidth: "680px", margin: "0 auto" }}>
          <div style={{
            fontSize: "10.5px", color: "var(--paper-faint)", background: "rgba(0,0,0,.18)",
            border: "1px solid var(--hairline)", borderRadius: "7px", padding: "10px 14px", marginBottom: "16px",
          }}>
            <b style={{ color: "var(--paper-muted)" }}>Scope, stated plainly:</b> this prototype covers one
            registered exploit class (reentrancy) against one demo contract — proving the settlement
            pipeline works end to end, not a general-purpose auditor yet.
          </div>
          <ProofOfExploitCard />
        </div>
      </section>

      <footer style={{ padding: "24px 28px", borderTop: "1px solid var(--hairline)", textAlign: "center" }}>
        <span style={{ fontSize: "10.5px", color: "var(--paper-faint)" }}>
          Built for Encode × Arc × Circle — Programmable Money Hackathon
        </span>
      </footer>
    </div>
  );
}

function AppHeader({ n, title, desc }) {
  return (
    <div style={{ maxWidth: "1400px", margin: "0 auto 20px", display: "flex", alignItems: "baseline", gap: "14px" }}>
      <span className="mono" style={{ fontSize: "13px", fontWeight: "700", color: "var(--seal)" }}>{n}</span>
      <div>
        <div className="display" style={{ fontSize: "20px", fontWeight: "700", letterSpacing: "-0.01em" }}>{title}</div>
        <div style={{ fontSize: "11.5px", color: "var(--paper-muted)", marginTop: "3px", maxWidth: "640px" }}>{desc}</div>
      </div>
    </div>
  );
}

function TechDetails({ stats }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(v => !v)} style={{
        background: "none", border: "none", padding: "4px 0",
        fontSize: "10px", color: "var(--paper-faint)",
        letterSpacing: ".1em", textTransform: "uppercase", fontWeight: "500",
      }}>
        {open ? "▾" : "▸"} Technical details
      </button>
      {open && (
        <div className="g" style={{ marginTop: "8px", padding: "14px" }}>
          {[
            ["Chain",       "Arc testnet (5042002)"],
            ["Protocol",    "x402 nanopayments"],
            ["Collateral",  "USDC / USYC"],
            ["Registry",    "ArcIDRegistryV2 + DCAP"],
            ["Adjudicator", "Claude Sonnet 4.6", "var(--seal)"],
            ["Consumer",    stats?.consumer ?? "0x8F43C6a0..."],
          ].map(([k, v, accent]) => (
            <div key={k} style={{
              display: "flex", justifyContent: "space-between",
              padding: "5px 0", borderBottom: "1px solid var(--hairline)", fontSize: "10px",
            }}>
              <span style={{ color: "var(--paper-faint)" }}>{k}</span>
              <span className="mono" style={{ color: accent || "var(--paper-muted)", fontSize: "9px", maxWidth: "180px", textAlign: "right" }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
