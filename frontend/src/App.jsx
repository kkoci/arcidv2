import { useEffect, useState, useRef } from "react";
import AgentCard     from "./components/AgentCard.jsx";
import VerdictHistory from "./components/VerdictHistory.jsx";
import USYCBondCard  from "./components/USYCBondCard.jsx";

const POLL_MS = 5000;

export default function App() {
  const [stats,      setStats]      = useState(null);
  const [chainStats, setChainStats] = useState(null);
  const [verdicts,   setVerdicts]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [live,       setLive]       = useState(false);
  const [lastPoll,   setLastPoll]   = useState(null);
  const [showSystem, setShowSystem] = useState(false);
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
  const slashCount = chainStats?.summary?.totalSlashes ?? 0;
  const tvlRaw     = chainStats?.summary?.tvlUsdc;
  const tvlDisplay = tvlRaw != null ? `$${(Number(tvlRaw) / 1e6).toFixed(2)}` : null;
  const agents     = chainStats?.summary?.activeAgents ?? 0;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}} @keyframes glow{0%,100%{box-shadow:0 0 20px rgba(239,68,68,.3)}50%{box-shadow:0 0 40px rgba(239,68,68,.6)}}`}</style>

      {/* Topbar */}
      <nav style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 32px", borderBottom: "1px solid #1a1b2e",
        background: "rgba(8,9,26,0.9)", backdropFilter: "blur(20px)",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: "28px", height: "28px", borderRadius: "6px",
            background: "linear-gradient(135deg, #4f46e5, #818cf8)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 16px rgba(99,102,241,0.4)",
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 11L7 3L11 11" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4.5 8.5H9.5" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </div>
          <span style={{ fontSize: "15px", fontWeight: "800", color: "#e8eaf6", letterSpacing: "-0.02em" }}>ArcID</span>
          <span style={{
            fontSize: "10px", padding: "2px 8px", borderRadius: "99px",
            background: "rgba(99,102,241,0.15)", color: "#818cf8",
            border: "1px solid rgba(99,102,241,0.3)", fontWeight: "600", letterSpacing: "0.06em",
          }}>TESTNET</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#5c5f7a" }}>
          <div style={{
            width: "7px", height: "7px", borderRadius: "50%",
            background: live ? "#34d399" : "#ef4444",
            boxShadow: live ? "0 0 0 3px rgba(52,211,153,0.2)" : "none",
            animation: live ? "pulse 2s ease-in-out infinite" : "none",
          }} />
          {live ? `live · ${lastPoll?.toLocaleTimeString() ?? ""}` : "disconnected"}
        </div>
      </nav>

      {/* Hero */}
      <div style={{
        padding: "64px 32px 56px",
        borderBottom: "1px solid #1a1b2e",
        background: "linear-gradient(180deg, rgba(99,102,241,0.07) 0%, transparent 100%)",
        textAlign: "center",
      }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: "8px",
          padding: "5px 14px", borderRadius: "99px", marginBottom: "24px",
          background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
          fontSize: "11px", fontWeight: "700", color: "#ef4444", letterSpacing: "0.06em",
        }}>
          ⚡ BONDED AGENT REPUTATION ON ARC
        </div>

        <h1 style={{
          fontSize: "clamp(36px, 5vw, 64px)",
          fontWeight: "900", lineHeight: "1.05",
          letterSpacing: "-0.03em", color: "#e8eaf6",
          marginBottom: "16px",
        }}>
          If an AI agent cheats,<br />
          <span style={{
            background: "linear-gradient(90deg, #ef4444, #f87171)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>
            it loses its deposit.
          </span>
        </h1>

        <p style={{ fontSize: "16px", color: "#5c5f7a", marginBottom: "40px", fontWeight: "500" }}>
          Automatically. On-chain. Claude adjudicates. No humans. No appeals.
        </p>

        {/* Live damage counters */}
        <div style={{ display: "flex", justifyContent: "center", gap: "32px", flexWrap: "wrap" }}>
          <Counter value={agents}       label="Agents bonded"     color="#818cf8" loading={loading} />
          <Counter value={tvlDisplay}   label="USDC at stake"     color="#22d3ee" loading={loading} />
          <Counter value={slashCount}   label="Cheaters slashed"  color={slashCount > 0 ? "#ef4444" : "#5c5f7a"} loading={loading} big={slashCount > 0} />
        </div>
      </div>

      {/* Body */}
      <div style={{
        flex: 1, display: "grid",
        gridTemplateColumns: "1fr 360px",
        gap: "24px", padding: "24px 32px",
        maxWidth: "1400px", width: "100%", margin: "0 auto",
        alignItems: "start",
      }}>
        {/* Left — verdict timeline */}
        <VerdictHistory verdicts={sorted} />

        {/* Right — controls */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <AgentCard stats={stats} chainStats={chainStats} onCycleComplete={poll} />
          <USYCBondCard usyc={stats?.usyc} />

          <button
            onClick={() => setShowSystem(v => !v)}
            style={{
              background: "none", border: "none", padding: "4px 0",
              fontSize: "10px", color: "#3a3c52", cursor: "pointer",
              textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: "600",
              textAlign: "left",
            }}
          >
            {showSystem ? "▾" : "▸"} Technical details
          </button>

          {showSystem && (
            <div style={{ background: "#0d0f1f", border: "1px solid #1a1b2e", borderRadius: "8px", padding: "14px" }}>
              {[
                ["Chain",       "Arc testnet (5042002)"],
                ["Protocol",    "x402 nanopayments"],
                ["Collateral",  "USDC / USYC"],
                ["Registry",    "ArcIDRegistryV2 + DCAP"],
                ["Adjudicator", "Claude Sonnet 4.6", "#818cf8"],
                ["Slash type",  "On-chain (real USDC)"],
                ["Consumer",    stats?.consumer ?? "0x8F43C6a0..."],
              ].map(([k, v, accent]) => (
                <div key={k} style={{
                  display: "flex", justifyContent: "space-between",
                  padding: "5px 0", borderBottom: "1px solid #08091a", fontSize: "11px",
                }}>
                  <span style={{ color: "#5c5f7a" }}>{k}</span>
                  <span style={{ color: accent || "#e8eaf6", fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", wordBreak: "break-all", maxWidth: "180px", textAlign: "right" }}>{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Counter({ value, label, color, loading, big }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{
        fontSize: big ? "52px" : "36px",
        fontWeight: "900",
        fontFamily: "'JetBrains Mono', monospace",
        color: loading ? "#1a1b2e" : color,
        lineHeight: 1,
        marginBottom: "6px",
        transition: "color 0.4s",
        textShadow: big ? `0 0 40px ${color}60` : "none",
        animation: big ? "glow 2s ease-in-out infinite" : "none",
      }}>
        {loading ? "—" : (value ?? "—")}
      </div>
      <div style={{ fontSize: "11px", color: "#5c5f7a", fontWeight: "500" }}>{label}</div>
    </div>
  );
}
