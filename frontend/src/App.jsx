import { useEffect, useState, useRef } from "react";
import SealMark          from "./components/SealMark.jsx";
import AgentCard          from "./components/AgentCard.jsx";
import VerdictHistory     from "./components/VerdictHistory.jsx";
import GatewayPaymentCard from "./components/GatewayPaymentCard.jsx";
import GrantMetricsCard   from "./components/GrantMetricsCard.jsx";
import USYCBondCard       from "./components/USYCBondCard.jsx";
import ProofOfExploitCard from "./components/ProofOfExploitCard.jsx";
import TrainingCompensationCard from "./components/TrainingCompensationCard.jsx";

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
  const timerRef    = useRef(null);
  const oracleRef   = useRef(null);
  const exploitRef  = useRef(null);
  const trainingRef = useRef(null);
  const triggerRef  = useRef(null);

  // Imperative, no extra state: scrolls the real trigger button (in
  // AgentCard) into view and gives it a brief pulse ring. Used by
  // VerdictHistory's empty state so its CTA "points at" the oracle panel's
  // actual button instead of duplicating trigger logic in a second place.
  function pointAtTrigger() {
    const el = triggerRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("cta-pulse");
    setTimeout(() => el.classList.remove("cta-pulse"), 1600);
  }

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
      <header className="px-section" style={{
        position: "sticky", top: 0, zIndex: 100,
        background: "rgba(250,249,247,.82)", backdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--hairline)",
        display: "flex", alignItems: "center", height: "58px", gap: "20px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <SealMark state="sealed" size={24} />
          <span className="display" style={{ fontSize: "17px", fontWeight: "700" }}>ArcID</span>
          <span style={{
            fontSize: "9px", padding: "2px 8px", borderRadius: "4px",
            background: "var(--accent-soft)", color: "var(--accent)",
            fontWeight: "600", letterSpacing: ".1em",
          }}>TESTNET</span>
        </div>
        <div style={{ flex: 1 }} />
        <div className="header-jumplinks">
          <button onClick={() => scrollTo(oracleRef)} style={{
            background: "none", border: "1px solid var(--hairline-hi)", color: "var(--text-muted)",
            padding: "6px 14px", fontSize: "11px", borderRadius: "8px",
          }}>01 · Data SLA</button>
          <button onClick={() => scrollTo(exploitRef)} style={{
            background: "none", border: "1px solid var(--hairline-hi)", color: "var(--text-muted)",
            padding: "6px 14px", fontSize: "11px", borderRadius: "8px",
          }}>02 · Exploit Bounty</button>
          <button onClick={() => scrollTo(trainingRef)} style={{
            background: "none", border: "1px solid var(--hairline-hi)", color: "var(--text-muted)",
            padding: "6px 14px", fontSize: "11px", borderRadius: "8px",
          }}>03 · Training Compensation</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "8px" }}>
          <div style={{
            width: "6px", height: "6px", borderRadius: "50%",
            background: live ? "var(--settle)" : "var(--breach)",
            animation: live ? "pulse 2.5s infinite" : "none",
          }} />
          <span className="mono" style={{ fontSize: "10px", color: "var(--text-faint)" }}>
            {live ? lastPoll?.toLocaleTimeString() : "offline"}
          </span>
        </div>
      </header>

      {/* ── HERO — the thesis, not a tab picker ── */}
      <section className="px-section" style={{ position: "relative", paddingTop: "64px", paddingBottom: "44px", borderBottom: "1px solid var(--hairline)", textAlign: "center", overflow: "hidden" }}>
        <div className="wash" />
        <div style={{ maxWidth: "760px", margin: "0 auto" }}>
          <div style={{
            fontSize: "10px", fontWeight: "700", letterSpacing: ".14em", textTransform: "uppercase",
            color: "var(--accent)", marginBottom: "18px",
          }}>
            Bonded verification protocol · Arc testnet
          </div>
          <h1 className="display" style={{
            fontSize: "clamp(30px, 7vw, 56px)", fontWeight: "800", letterSpacing: "-0.02em",
            lineHeight: "1.1", color: "var(--text)", marginBottom: "14px",
          }}>
            <span style={{
              background: "linear-gradient(90deg, #5B5BF0, #8B5CF6)",
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
            }}>ArcID:</span> machines pay too fast to police by hand.
          </h1>
          <p style={{ fontSize: "15.5px", fontWeight: "400", color: "var(--text-muted)", lineHeight: "1.65", maxWidth: "540px", margin: "0 auto 28px" }}>
            ArcID locks real USDC behind every service, verifies the outcome automatically, and settles
            or slashes on-chain — no reviews, no disputes, no humans in the loop.
          </p>
          <button onClick={() => scrollTo(oracleRef)} style={{
            background: "var(--accent)", color: "#fff",
            padding: "13px 26px", fontSize: "14px", fontWeight: "700",
            borderRadius: "10px", letterSpacing: "-.01em",
            boxShadow: "var(--shadow-md)",
          }}>
            Watch a live slash →
          </button>
        </div>

        {/* Mechanism flow */}
        <div className="mechanism-grid">
          {STEPS.map((s) => (
            <div key={s.n} className="g" style={{ padding: "16px 14px", textAlign: "left" }}>
              <div className="mono" style={{ fontSize: "11px", fontWeight: "700", color: "var(--accent)", marginBottom: "6px" }}>{s.n}</div>
              <div style={{ fontSize: "12.5px", fontWeight: "600", color: "var(--text)", marginBottom: "5px" }}>{s.title}</div>
              <div style={{ fontSize: "10.5px", color: "var(--text-faint)", lineHeight: "1.6" }}>{s.body}</div>
            </div>
          ))}
        </div>

        {/* Live counters */}
        <div className="stat-row" style={{ marginTop: "36px" }}>
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
                color: loading ? "rgba(23,23,26,.18)" : (label === "slashed" && slashCount > 0) ? "var(--breach)" : "var(--text)",
              }}>
                {loading ? "—" : val}
              </div>
              <div style={{ fontSize: "9px", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: ".08em", marginTop: "3px" }}>{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── LIVE APPLICATIONS — proof points, not products to pick between ── */}
      <section className="px-section" style={{ paddingTop: "40px", paddingBottom: "12px", textAlign: "center" }}>
        <div className="display" style={{ fontSize: "13px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)" }}>
          Live applications on Arc testnet
        </div>
        <p style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: "6px" }}>
          Same protocol, two different claims being enforced
        </p>
      </section>

      {/* ── App 1: Data SLA ──
          Top row: Adjudication Feed | Price Oracle panel (the core
          interaction — the panel drives the feed). Supporting cards
          (Grant Metrics / Gateway / USYC) get their OWN balanced row
          below, full section width, instead of stacking endlessly in a
          side column that runs longer than the feed next to it. ── */}
      <section ref={oracleRef} className="px-section" style={{ paddingTop: "20px", paddingBottom: "48px", borderBottom: "1px solid var(--hairline)" }}>
        <AppHeader n="01" title="Data SLA Bond" desc="An oracle stakes collateral, sells price data per-call, and Claude checks whether it kept its promise — freshness, presence, a genuine signature." />
        <div className="section-container">
          <div className="sla-top-grid">
            <VerdictHistory verdicts={sorted} chainStats={chainStats} onPointAtTrigger={pointAtTrigger} />
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <AgentCard stats={stats} chainStats={chainStats} onCycleComplete={poll} triggerRef={triggerRef} />
              <TechDetails stats={stats} />
            </div>
          </div>
          <div className="supporting-grid">
            <GrantMetricsCard stats={stats} chainStats={chainStats} />
            <GatewayPaymentCard />
            <USYCBondCard usyc={stats?.usyc} />
          </div>
        </div>
      </section>

      {/* ── App 2: Proof of Exploit — same shared container width as
          the SLA section above, so the two align edge-to-edge. ── */}
      <section ref={exploitRef} className="px-section" style={{ paddingTop: "40px", paddingBottom: "56px" }}>
        <AppHeader n="02" title="Proof-of-Exploit Bounty" desc="A researcher submits an exploit. It runs against a forked target — the invariant either breaks or it doesn't. No judgment call, no LLM in the payout path." />
        <div className="section-container">
          <div style={{
            fontSize: "10.5px", color: "var(--text-faint)", background: "var(--accent-soft)",
            border: "1px solid var(--hairline)", borderRadius: "10px", padding: "10px 14px", marginBottom: "16px",
          }}>
            <b style={{ color: "var(--text-muted)" }}>Scope, stated plainly:</b> this prototype covers one
            registered exploit class (reentrancy) against one demo contract — proving the settlement
            pipeline works end to end, not a general-purpose auditor yet.
          </div>
          <ProofOfExploitCard />
        </div>
      </section>

      {/* ── App 3: Licensed AI Training Compensation Rail — same shared
          container width as the two sections above. ── */}
      <section ref={trainingRef} className="px-section" style={{ paddingTop: "40px", paddingBottom: "56px", borderTop: "1px solid var(--hairline)" }}>
        <AppHeader n="03" title="Licensed AI Training Compensation Rail" desc="An AI company commits a Merkle root over its training corpus and escrows USDC. A TEE-attested enclave verifies the corpus and artist licensing, computes a payout, and signs it. Artists claim their exact share with a real Merkle proof." />
        <div className="section-container">
          <div style={{
            fontSize: "10.5px", color: "var(--text-faint)", background: "var(--accent-soft)",
            border: "1px solid var(--hairline)", borderRadius: "10px", padding: "10px 14px", marginBottom: "16px",
          }}>
            <b style={{ color: "var(--text-muted)" }}>Scope, stated plainly:</b> demo-scale corpus (a
            handful of tracks, not millions), fingerprint hashes rather than real audio fingerprinting,
            and an equal-split payout rule rather than usage-weighted — proving the settlement pipeline
            works end to end, real funds, real Merkle proofs, real on-chain checks.
          </div>
          <TrainingCompensationCard />
        </div>
      </section>

      <footer className="px-section" style={{ paddingTop: "24px", paddingBottom: "24px", borderTop: "1px solid var(--hairline)", textAlign: "center" }}>
        <span style={{ fontSize: "10.5px", color: "var(--text-faint)" }}>
          Built for Encode × Arc × Circle — Programmable Money Hackathon
        </span>
      </footer>
    </div>
  );
}

function AppHeader({ n, title, desc }) {
  return (
    <div className="section-container" style={{ margin: "0 auto 20px", display: "flex", alignItems: "baseline", gap: "14px" }}>
      <span className="mono" style={{ fontSize: "13px", fontWeight: "700", color: "var(--accent)" }}>{n}</span>
      <div>
        <div className="display" style={{ fontSize: "20px", fontWeight: "700", letterSpacing: "-0.01em", color: "var(--text)" }}>{title}</div>
        <div style={{ fontSize: "11.5px", color: "var(--text-muted)", marginTop: "3px", maxWidth: "640px" }}>{desc}</div>
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
        fontSize: "10px", color: "var(--text-faint)",
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
            ["Adjudicator", "Claude Sonnet 4.6", "var(--accent)"],
            ["Consumer",    stats?.consumer ?? "0x8F43C6a0..."],
          ].map(([k, v, accent]) => (
            <div key={k} style={{
              display: "flex", justifyContent: "space-between",
              padding: "5px 0", borderBottom: "1px solid var(--hairline)", fontSize: "10px",
            }}>
              <span style={{ color: "var(--text-faint)" }}>{k}</span>
              <span className="mono" style={{ color: accent || "var(--text-muted)", fontSize: "9px", maxWidth: "180px", textAlign: "right", overflowWrap: "break-word" }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
