import { useEffect, useState, useRef } from "react";
import AgentCard     from "./components/AgentCard.jsx";
import VerdictHistory from "./components/VerdictHistory.jsx";
import USYCBondCard  from "./components/USYCBondCard.jsx";
import GatewayPaymentCard from "./components/GatewayPaymentCard.jsx";
import GrantMetricsCard from "./components/GrantMetricsCard.jsx";

const POLL_MS = 5000;

export default function App() {
  const [stats,      setStats]      = useState(null);
  const [chainStats, setChainStats] = useState(null);
  const [verdicts,   setVerdicts]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [live,       setLive]       = useState(false);
  const [lastPoll,   setLastPoll]   = useState(null);
  const timerRef = useRef(null);

  async function poll() {
    try {
      const [sRes, vRes, cRes] = await Promise.all([
        fetch("/api/stats"), fetch("/api/verdicts"), fetch("/api/chain-stats"),
      ]);
      if (sRes.ok) setStats(await sRes.json());
      if (vRes.ok) setVerdicts((await vRes.json()).verdicts ?? []);
      if (cRes.ok) setChainStats(await cRes.json());
      setLive(true);
    } catch { setLive(false); }
    finally  { setLoading(false); setLastPoll(new Date()); }
  }

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  const sorted     = [...verdicts].reverse();
  const slashCount = chainStats?.summary?.totalSlashes  ?? 0;
  const tvlRaw     = chainStats?.summary?.tvlUsdc;
  const tvlDisplay = tvlRaw != null ? `$${(Number(tvlRaw)/1e6).toFixed(2)}` : "—";
  const agentCount = chainStats?.summary?.activeAgents  ?? "—";

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>

      {/* ── Header ── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 100,
        background: "rgba(13,11,36,.75)", backdropFilter: "blur(24px)",
        borderBottom: "1px solid rgba(255,255,255,.07)",
        padding: "0 28px",
        display: "flex", alignItems: "center", height: "56px", gap: "24px",
      }}>
        {/* Brand */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
          <div style={{
            width: "30px", height: "30px", borderRadius: "8px",
            background: "linear-gradient(135deg, #7c3aed, #c084fc)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 18px rgba(192,132,252,.55)",
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1.5L12.5 12H1.5L7 1.5Z" stroke="white" strokeWidth="1.6" strokeLinejoin="round"/>
              <circle cx="7" cy="8.5" r="1.2" fill="white"/>
            </svg>
          </div>
          <span style={{ fontSize: "16px", fontWeight: "900", letterSpacing: "-0.03em" }}>ArcID</span>
          <span style={{
            fontSize: "9px", padding: "2px 8px", borderRadius: "99px",
            background: "rgba(192,132,252,.15)", color: "#c084fc",
            border: "1px solid rgba(192,132,252,.3)", fontWeight: "700", letterSpacing: ".1em",
          }}>TESTNET</span>
        </div>

        {/* Inline stats — no hero needed, these ARE the stats */}
        <div style={{ display: "flex", gap: "2px", flex: 1, justifyContent: "center" }}>
          <HeaderStat loading={loading} value={agentCount}   label="bonded"          color="#c084fc"
            title="Agents currently holding an active USDC/USYC bond — the collateral that makes their reputation real money, not a score." />
          <HeaderStat loading={loading} value={tvlDisplay}   label="at risk"         color="#22d9e8" divider
            title="Total collateral currently posted across all bonded agents — this is what a confirmed breach draws from." />
          <HeaderStat loading={loading} value={slashCount}   label="slashed"
            color={slashCount > 0 ? "#fb7103" : "rgba(242,240,255,.25)"}
            highlight={slashCount > 0}
            divider
            title="Confirmed SLA breaches where the bond contract has automatically paid the injured party out of the provider's collateral." />
        </div>

        {/* Live dot */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <div style={{
            width: "7px", height: "7px", borderRadius: "50%",
            background: live ? "#4ade80" : "#fb7103",
            boxShadow: live ? "0 0 0 3px rgba(74,222,128,.2), 0 0 10px rgba(74,222,128,.4)" : "none",
            animation: live ? "pulse 2.5s infinite" : "none",
          }} />
          <span style={{ fontSize: "10px", color: "rgba(242,240,255,.3)" }}>
            {live ? lastPoll?.toLocaleTimeString() : "offline"}
          </span>
        </div>
      </header>

      {/* ── Headline strip — compact, no full hero ── */}
      <div style={{
        padding: "28px 28px 20px",
        borderBottom: "1px solid rgba(255,255,255,.05)",
      }}>
        <h1 style={{
          fontSize: "clamp(24px, 3.4vw, 38px)",
          fontWeight: "900",
          letterSpacing: "-0.03em",
          lineHeight: "1.15",
          color: "#f2f0ff",
          marginBottom: "8px",
        }}>
          The trust layer for agent-to-agent commerce.
        </h1>
        <p style={{ fontSize: "14px", fontWeight: "700", color: "#fb7103", textShadow: "0 0 24px rgba(251,113,3,.35)" }}>
          Cheat the SLA, lose the bond — automatically, on-chain, no appeals.
        </p>
      </div>

      <HowItWorks />

      {/* ── Main grid ── */}
      <div style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "1fr 370px",
        gap: "18px",
        padding: "18px 28px 32px",
        maxWidth: "1400px",
        width: "100%",
        margin: "0 auto",
        alignItems: "start",
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
    </div>
  );
}

function HeaderStat({ loading, value, label, color, divider, highlight, title }) {
  return (
    <div title={title} style={{
      display: "flex", alignItems: "baseline", gap: "5px",
      padding: "0 18px",
      borderLeft: divider ? "1px solid rgba(255,255,255,.07)" : "none",
      cursor: title ? "help" : "default",
    }}>
      <span style={{
        fontSize: "18px", fontWeight: "900", fontFamily: "'JetBrains Mono', monospace",
        color: loading ? "rgba(255,255,255,.1)" : color,
        textShadow: (highlight && !loading) ? `0 0 20px ${color}` : "none",
        transition: "color .4s, text-shadow .4s",
      }}>
        {loading ? "—" : value}
      </span>
      <span className="hint" style={{ fontSize: "10px", color: "rgba(242,240,255,.3)", fontWeight: "500", borderBottomColor: "rgba(242,240,255,.15)" }}>
        {label}
      </span>
    </div>
  );
}

// ── How it works — a cold visitor gets oriented before hitting live jargon
// (bond / TVL / slash / SLA) further down the page. Four numbered steps,
// matching the pattern trust/verification platforms (EigenLayer's slashing
// docs, Chainlink's Proof of Reserve) use: a short mechanical walkthrough
// ahead of any live data, not a marketing hero.
const HOW_IT_WORKS_STEPS = [
  {
    n: "01", color: "#c084fc", title: "Provider posts a bond",
    body: "The oracle locks real USDC/USYC collateral on-chain before it's allowed to sell a single call. This is capital at risk, not a reputation score.",
  },
  {
    n: "02", color: "#22d9e8", title: "Sells per-call via x402",
    body: "A buyer pays a fraction of a cent per request (x402 nanopayment) and gets back a signed response.",
  },
  {
    n: "03", color: "#22d9e8", title: "A second AI agent verifies",
    body: "The consumer agent checks the signature and freshness deterministically, then asks Claude whether the content itself looks genuine.",
  },
  {
    n: "04", color: "#fb7103", title: "Breach → bond slashes",
    body: "On a confirmed breach, the smart contract pays the injured party out of the provider's bond automatically — on-chain, no human review.",
  },
];

function HowItWorks() {
  return (
    <div style={{
      padding: "20px 28px",
      borderBottom: "1px solid rgba(255,255,255,.05)",
      maxWidth: "1400px", width: "100%", margin: "0 auto",
    }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "12px",
      }}>
        {HOW_IT_WORKS_STEPS.map((s) => (
          <div key={s.n} className="g" style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "7px" }}>
              <span className="mono" style={{ fontSize: "11px", fontWeight: "900", color: s.color }}>{s.n}</span>
              <span style={{ fontSize: "12.5px", fontWeight: "800", color: "#f2f0ff", letterSpacing: "-0.01em" }}>{s.title}</span>
            </div>
            <div style={{ fontSize: "11.5px", color: "rgba(242,240,255,.45)", lineHeight: "1.65" }}>
              {s.body}
            </div>
          </div>
        ))}
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
        fontSize: "10px", color: "rgba(242,240,255,.2)",
        letterSpacing: ".12em", textTransform: "uppercase", fontWeight: "600",
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
            ["Adjudicator", "Claude Sonnet 4.6", "#c084fc"],
            ["Consumer",    stats?.consumer ?? "0x8F43C6a0..."],
          ].map(([k, v, accent]) => (
            <div key={k} style={{
              display: "flex", justifyContent: "space-between",
              padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,.05)", fontSize: "10px",
            }}>
              <span style={{ color: "rgba(242,240,255,.3)" }}>{k}</span>
              <span className="mono" style={{ color: accent || "rgba(242,240,255,.7)", fontSize: "9px", maxWidth: "180px", textAlign: "right" }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
