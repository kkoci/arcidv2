import { useEffect, useState, useRef } from "react";
import TractionStrip  from "./components/TractionStrip.jsx";
import AgentCard      from "./components/AgentCard.jsx";
import VerdictHistory  from "./components/VerdictHistory.jsx";
import USYCBondCard   from "./components/USYCBondCard.jsx";

const POLL_MS = 5000;

const s = {
  app:     { minHeight: "100vh", display: "flex", flexDirection: "column" },
  topbar:  { display: "flex", alignItems: "center", justifyContent: "space-between",
             padding: "12px 24px", borderBottom: "1px solid #1e1e2e" },
  logo:    { fontSize: "13px", fontWeight: "700", letterSpacing: "0.08em", color: "#e2e2f0" },
  logoSub: { fontSize: "10px", color: "#6b6b8a", marginLeft: "8px" },
  pulse:   (live) => ({ width: "8px", height: "8px", borderRadius: "50%",
             background: live ? "#22c55e" : "#ef4444",
             boxShadow:  live ? "0 0 0 3px #22c55e30" : "none",
             display: "inline-block", marginRight: "6px" }),
  liveTag: { fontSize: "10px", color: "#6b6b8a" },
  main:    { flex: 1, display: "grid", gridTemplateColumns: "360px 1fr",
             gap: "16px", padding: "16px 24px", maxWidth: "1400px", width: "100%", margin: "0 auto" },
  left:    { display: "flex", flexDirection: "column", gap: "16px" },
  section: { fontSize: "10px", color: "#6b6b8a", textTransform: "uppercase",
             letterSpacing: "0.1em", marginBottom: "8px" },
  infoBox: { background: "#111118", border: "1px solid #1e1e2e", borderRadius: "8px", padding: "16px" },
  infoRow: { display: "flex", justifyContent: "space-between", padding: "6px 0",
             borderBottom: "1px solid #0a0a0f", fontSize: "11px" },
  infoKey: { color: "#6b6b8a" },
  infoVal: { color: "#e2e2f0" },
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
      {/* Top bar */}
      <div style={s.topbar}>
        <div>
          <span style={s.logo}>ArcID</span>
          <span style={s.logoSub}>bonded agent reputation · Arc testnet</span>
        </div>
        <div style={s.liveTag}>
          <span style={s.pulse(live)} />
          {live ? `live · refreshes ${POLL_MS / 1000}s` : "disconnected"}
          {lastPoll && ` · ${lastPoll.toLocaleTimeString()}`}
        </div>
      </div>

      {/* Traction strip — chain data where available, oracle counters as fallback */}
      <TractionStrip stats={stats ?? {}} chainStats={chainStats} loading={loading} />

      {/* Body */}
      <div style={s.main}>
        {/* Left column */}
        <div style={s.left}>
          <div>
            <div style={s.section}>Registered Agents (on-chain)</div>
            <AgentCard
              stats={stats}
              chainStats={chainStats}
              onCycleComplete={poll}
            />
          </div>

          <div>
            <div style={s.section}>System</div>
            <div style={s.infoBox}>
              <InfoRow k="Chain"       v="Arc testnet (5042002)" />
              <InfoRow k="Protocol"    v="x402 nanopayments" />
              <InfoRow k="Collateral"  v="USDC (native token)" />
              <InfoRow k="Registry"    v="ArcIDRegistryV2 + DCAP" />
              <InfoRow k="Adjudicator" v="Claude Sonnet 4.6" />
              <InfoRow k="Slash type"  v="On-chain (real USDC)" />
              <InfoRow k="Consumer"    v={stats?.consumer ?? "0x8F43C6a0..."} />
            </div>
          </div>

          {chainStats?.summary?.totalSlashes > 0 && (
            <div>
              <div style={s.section}>Chain summary</div>
              <div style={s.infoBox}>
                <InfoRow k="Total agents"   v={chainStats.summary.totalAgents}   />
                <InfoRow k="Active bonds"   v={chainStats.summary.activeAgents}  />
                <InfoRow k="Total slashes"  v={chainStats.summary.totalSlashes}  />
              </div>
            </div>
          )}

          <div>
            <div style={s.section}>Phase 5 — Yield-Bearing Bond</div>
            <USYCBondCard usyc={stats?.usyc} />
          </div>
        </div>

        {/* Right column: verdict feed */}
        <div>
          <div style={s.section}>Adjudication feed</div>
          <VerdictHistory verdicts={sorted} />
        </div>
      </div>
    </div>
  );
}

function InfoRow({ k, v }) {
  return (
    <div style={s.infoRow}>
      <span style={s.infoKey}>{k}</span>
      <span style={{ ...s.infoVal, fontSize: "10px", wordBreak: "break-all", maxWidth: "200px", textAlign: "right" }}>{v}</span>
    </div>
  );
}
