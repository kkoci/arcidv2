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
  main:    { flex: 1, display: "grid", gridTemplateColumns: "340px 1fr",
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
  const [stats,    setStats]    = useState(null);
  const [verdicts, setVerdicts] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [live,     setLive]     = useState(false);
  const [lastPoll, setLastPoll] = useState(null);
  const timerRef = useRef(null);

  async function poll() {
    try {
      const [sRes, vRes] = await Promise.all([
        fetch("/api/stats"),
        fetch("/api/verdicts"),
      ]);
      if (sRes.ok) setStats(await sRes.json());
      if (vRes.ok) setVerdicts((await vRes.json()).verdicts ?? []);
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

      {/* Traction strip */}
      <TractionStrip stats={stats ?? {}} loading={loading} />

      {/* Body */}
      <div style={s.main}>
        {/* Left column: oracle agent card + system info */}
        <div style={s.left}>
          <div>
            <div style={s.section}>Bonded Agent</div>
            <AgentCard stats={stats} />
          </div>

          <div>
            <div style={s.section}>System</div>
            <div style={s.infoBox}>
              <InfoRow k="Chain"    v="Arc testnet (421614)" />
              <InfoRow k="Protocol" v="x402 nanopayments" />
              <InfoRow k="Collateral" v="USDC ERC-20" />
              <InfoRow k="TEE gate" v="ArcIDRegistry" />
              <InfoRow k="Adjudicator" v="Claude Sonnet 4.6" />
              <InfoRow k="Slash type" v="DEV (simulated)" />
              <InfoRow k="Consumer" v={stats?.consumer ?? "—"} />
            </div>
          </div>

          {stats?.breachCount > 0 && (
            <div>
              <div style={s.section}>Breach summary</div>
              <div style={s.infoBox}>
                <InfoRow k="Breaches"   v={stats.breachCount}   />
                <InfoRow k="Uncertain"  v={stats.uncertainCount} />
                <InfoRow k="Slashes"    v={stats.slashCount}     />
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
      <span style={{ ...s.infoVal, fontSize: "10px", wordBreak: "break-all", maxWidth: "180px", textAlign: "right" }}>{v}</span>
    </div>
  );
}
