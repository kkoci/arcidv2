import { useRef } from "react";
import SealMark              from "./components/SealMark.jsx";
import TrainingCompensationCard from "./components/TrainingCompensationCard.jsx";

// This vertical's own mechanism — artist → corpus commitment → enclave
// verification → claim. Replaces the old bond/slash 4-step flow, which
// described a different product (removed from this page — see CHANGELOG.md
// / README's "Also proven on this protocol" section for the earlier
// verticals, still live on-chain, just no longer the front door).
const STEPS = [
  { n: "01", title: "Artist registers",  body: "A track's fingerprint hash + rights commitment, on-chain." },
  { n: "02", title: "Corpus committed",  body: "AI company escrows USDC, commits a Merkle root over its training set." },
  { n: "03", title: "Enclave verifies",  body: "TEE-attested ingestion checks licensing + integrity, computes the split." },
  { n: "04", title: "Artists claim",     body: "Real USDC, a real Merkle proof — no human review." },
];

// Real numbers from this vertical's own live Arc testnet run (see
// CHANGELOG.md's "Licensed AI Training Compensation Rail" entry) —
// hardcoded facts, not a live poll. This page no longer talks to the
// price-oracle backend the old stat-row polled every 5s.
const PROVEN_STATS = [
  ["artists paid",     "2",     "Independent artists who have already claimed a real payout from this contract on Arc testnet."],
  ["usdc distributed", "$3.00", "Real USDC paid out — proportional to each artist's share of the training corpus."],
  ["tracks licensed",  "3",     "Demo tracks registered and verified against a committed training-corpus Merkle root."],
];

export default function App() {
  const proofRef = useRef(null);
  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div style={{ minHeight: "100vh" }}>

      {/* ── Header — brand only. One product, nothing to pick between. ── */}
      <header className="px-section" style={{
        position: "sticky", top: 0, zIndex: 100,
        background: "rgba(9,10,15,.82)", backdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--hairline)",
        display: "flex", alignItems: "center", height: "58px", gap: "12px",
      }}>
        <SealMark state="sealed" size={24} />
        <span className="display" style={{ fontSize: "17px", fontWeight: "700" }}>ArcID</span>
        <span className="header-subtitle">Training Compensation Rail</span>
        <div style={{ flex: 1 }} />
        <span style={{
          fontSize: "9px", padding: "2px 8px", borderRadius: "4px",
          background: "var(--accent-soft)", color: "var(--accent)",
          fontWeight: "600", letterSpacing: ".1em",
        }}>ARC TESTNET</span>
      </header>

      {/* ── HERO — this product's own thesis, not a platform pitch. ── */}
      <section className="px-section" style={{ position: "relative", paddingTop: "72px", paddingBottom: "48px", borderBottom: "1px solid var(--hairline)", textAlign: "center", overflow: "hidden" }}>
        <div className="wash" />
        <div style={{ maxWidth: "760px", margin: "0 auto" }}>
          <div style={{
            fontSize: "10px", fontWeight: "700", letterSpacing: ".14em", textTransform: "uppercase",
            color: "var(--accent)", marginBottom: "18px",
          }}>
            Licensed AI training data · Arc testnet
          </div>
          <h1 className="display" style={{
            fontSize: "clamp(30px, 7vw, 54px)", fontWeight: "800", letterSpacing: "-0.02em",
            lineHeight: "1.14", color: "var(--text)", marginBottom: "16px",
          }}>
            Pay independent artists{" "}
            <span style={{
              background: "var(--gradient)",
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
            }}>automatically</span> when AI trains on their music.
          </h1>
          <p style={{ fontSize: "15.5px", fontWeight: "400", color: "var(--text-muted)", lineHeight: "1.65", maxWidth: "560px", margin: "0 auto 28px" }}>
            An AI company commits a Merkle root over its training corpus and escrows USDC. A TEE-attested
            enclave verifies licensing and integrity, computes each artist's share, and signs it. Artists
            claim their exact payout on-chain — provably, without the corpus ever becoming public.
          </p>
          <button onClick={() => scrollTo(proofRef)} style={{
            background: "var(--gradient)", color: "#04050A",
            padding: "13px 26px", fontSize: "14px", fontWeight: "700",
            borderRadius: "10px", letterSpacing: "-.01em", border: "none",
            boxShadow: "var(--shadow-md)",
          }}>
            See a real payout →
          </button>
        </div>

        {/* Mechanism flow — this product's actual steps */}
        <div className="mechanism-grid">
          {STEPS.map((s) => (
            <div key={s.n} className="g" style={{ padding: "16px 14px", textAlign: "left" }}>
              <div className="mono" style={{ fontSize: "11px", fontWeight: "700", color: "var(--accent)", marginBottom: "6px" }}>{s.n}</div>
              <div style={{ fontSize: "12.5px", fontWeight: "600", color: "var(--text)", marginBottom: "5px" }}>{s.title}</div>
              <div style={{ fontSize: "10.5px", color: "var(--text-faint)", lineHeight: "1.6" }}>{s.body}</div>
            </div>
          ))}
        </div>

        {/* Real, already-proven numbers — not a live poll (see CHANGELOG.md) */}
        <div className="stat-row" style={{ marginTop: "36px" }}>
          {PROVEN_STATS.map(([label, val, hint], i) => (
            <div key={label} title={hint} style={{
              padding: "0 22px", borderLeft: i > 0 ? "1px solid var(--hairline)" : "none",
              textAlign: "center", cursor: "help",
            }}>
              <div className="mono" style={{ fontSize: "20px", fontWeight: "700", color: "var(--text)" }}>
                {val}
              </div>
              <div style={{ fontSize: "9px", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: ".08em", marginTop: "3px" }}>{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── The product itself — the only section on the page. ── */}
      <section ref={proofRef} className="px-section" style={{ paddingTop: "48px", paddingBottom: "56px" }}>
        <div className="section-container" style={{ margin: "0 auto 20px" }}>
          <div className="display" style={{ fontSize: "20px", fontWeight: "700", letterSpacing: "-0.01em", color: "var(--text)" }}>
            How it's enforced
          </div>
          <div style={{ fontSize: "11.5px", color: "var(--text-muted)", marginTop: "3px", maxWidth: "640px" }}>
            A TEE-attested enclave — not a promise — verifies the corpus and licensing before any payout is computed.
          </div>
        </div>
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
