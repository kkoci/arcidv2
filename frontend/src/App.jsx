import { useEffect, useState, useRef } from "react";
import TractionStrip  from "./components/TractionStrip.jsx";
import AgentCard      from "./components/AgentCard.jsx";
import VerdictHistory  from "./components/VerdictHistory.jsx";
import USYCBondCard   from "./components/USYCBondCard.jsx";

const POLL_MS = 5000;

const s = {
  app:     { minHeight: "100vh", display: "flex", flexDirection: "column" },
  topbar:  {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 24px", borderBottom: "1px solid #1e1e2e",
    background: "rgba(13, 17, 23, 0.9)",
    backdropFilter: "blur(12px)",
    position: "sticky", top: 0, zIndex: 100,
  },
  logoWrap: { display: "flex", alignItems: "center", gap: "10px" },
  logoMark: {
    width: "26px", height: "26px", borderRadius: "5px",
    background: "linear-gradient(135deg, #4f46e5, #6366f1)",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  logo:    { fontSize: "13px", fontWeight: "700", letterSpacing: "-0.01em", color: "#e2e8f0" },
  logoSep: { color: "#2d2d4e", fontSize: "16px", fontWeight: "300" },
  logoSub: { fontSize: "11px", color: "#6b6b8a" },
  pulse:   (live) => ({
    width: "7px", height: "7px", borderRadius: "50%",
    background: live ? "#34d399" : "#ef4444",
    boxShadow: live ? "0 0 0 3px rgba(52,211,153,0.25)" : "none",
    display: "inline-block", marginRight: "6px",
    animation: live ? "pulse 2s ease-in-out infinite" : "none",
  }),
  liveTag: { fontSize: "11px", color: "#6b6b8a", display: "flex", alignItems: "center" },
  main:    {
    flex: 1, display: "grid", gridTemplateColumns: "360px 1fr",
    gap: "16px", padding: "16px 24px",
    maxWidth: "1400px", width: "100%", margin: "0 auto",
  },
  left:    { display: "flex", flexDirection: "column", gap: "16px" },
  section: {
    fontSize: "10px", color: "#6b6b8a", textTransform: "uppercase",
    letterSpacing: "0.1em", marginBottom: "8px", fontWeight: "600",
  },
  infoBox: { background: "#111118", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "16px" },
  infoRow: {
    display: "flex", justifyContent: "space-between", padding: "6px 0",
    borderBottom: "1px solid #0d1117", fontSize: "11px",
  },
  infoKey: { color: "#6b6b8a" },
  infoVal: { color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", fontSize: "10px" },
};

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
        fetch("/api/stats"),
        fetch("/api/verdicts"),
        fetch("/api/chain-stats"),
      ]);
      if (sRes.ok) setStats(await sRes.json());
      if (vRes.ok) setVerdicts((await vRes.json()).verdicts ?? []);
      if (cRes.ok) setChainStats(await cRes.json());
      setLive(true);
    } catch {
      setLive(false);
    } finally {
      setLoading(false);
      setLastPoll(new Date());
    }
  }

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  const sorted = [...verdicts].reverse();

  return (
    <div style={s.app}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      {/* Top bar */}
      <div style={s.topbar}>
        <div style={s.logoWrap}>
          <div style={s.logoMark}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 11L7 3L11 11" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4.5 8.5H9.5" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </div>
          <span style={s.logo}>ArcID</span>
          <span style={s.logoSep}>·</span>
          <span style={s.logoSub}>reputation you post as collateral, not a score you ask to be trusted</span>
        </div>
        <div style={s.liveTag}>
          <span style={s.pulse(live)} />
          {live
            ? `live · refreshes ${POLL_MS / 1000}s${lastPoll ? ` · ${lastPoll.toLocaleTimeString()}` : ""}`
            : "disconnected"}
        </div>
      </div>

      {/* Traction strip */}
      <TractionStrip stats={stats ?? {}} chainStats={chainStats} loading={loading} />

      {/* Body */}
      <div style={s.main}>
        {/* Left column */}
        <div style={s.left}>
          <div>
            <div style={s.section}>Registered Agents (on-chain)</div>
            <AgentCard stats={stats} chainStats={chainStats} onCycleComplete={poll} />
          </div>

          <div>
            <div style={s.section}>System</div>
            <div style={s.infoBox}>
              <InfoRow k="Chain"       v="Arc testnet (5042002)" />
              <InfoRow k="Protocol"    v="x402 nanopayments" />
              <InfoRow k="Collateral"  v="USDC / USYC" />
              <InfoRow k="Registry"    v="ArcIDRegistryV2 + DCAP" />
              <InfoRow k="Adjudicator" v="Claude Sonnet 4.6" highlight />
              <InfoRow k="Slash type"  v="On-chain (real USDC)" />
              <InfoRow k="Consumer"    v={stats?.consumer ?? "0x8F43C6a0..."} />
            </div>
          </div>

          {chainStats?.summary?.totalSlashes > 0 && (
            <div>
              <div style={s.section}>Chain summary</div>
              <div style={s.infoBox}>
                <InfoRow k="Total agents"  v={chainStats.summary.totalAgents} />
                <InfoRow k="Active bonds"  v={chainStats.summary.activeAgents} />
                <InfoRow k="Total slashes" v={chainStats.summary.totalSlashes} red />
              </div>
            </div>
          )}

          <div>
            <div style={s.section}>Phase 5 — Yield-Bearing Bond</div>
            <USYCBondCard usyc={stats?.usyc} />
          </div>
        </div>

        {/* Right column */}
        <div>
          <div style={s.section}>Adjudication feed</div>
          <VerdictHistory verdicts={sorted} />
        </div>
      </div>
    </div>
  );
}

function InfoRow({ k, v, highlight, red }) {
  return (
    <div style={s.infoRow}>
      <span style={s.infoKey}>{k}</span>
      <span style={{
        ...s.infoVal,
        color: highlight ? "#8b5cf6" : red ? "#ef4444" : "#e2e8f0",
        wordBreak: "break-all", maxWidth: "200px", textAlign: "right",
      }}>{v}</span>
    </div>
  );
}
