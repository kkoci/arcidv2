import { useRef } from "react";
import SealMark              from "./components/SealMark.jsx";
import TrainingCompensationCard from "./components/TrainingCompensationCard.jsx";

// User-journey framing, not a developer/contract-call flow — copy-only
// revision, same underlying mechanism as before (see CHANGELOG.md).
const STEPS = [
  { n: "01", title: "Artists opt in",           body: "Register your music and licensing terms." },
  { n: "02", title: "AI company funds the pool", body: "USDC is escrowed for the training dataset." },
  { n: "03", title: "Usage is verified privately", body: "A TEE verifies the committed corpus without exposing it." },
  { n: "04", title: "Artists get paid",         body: "Each artist claims their share onchain." },
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
      <section className="px-section" style={{ position: "relative", paddingTop: "72px", paddingBottom: "40px", borderBottom: "1px solid var(--hairline)", textAlign: "center", overflow: "hidden" }}>
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
            License music for AI training.{" "}
            <span style={{
              background: "var(--gradient)",
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
            }}>Pay artists automatically.</span>
          </h1>
          <p style={{ fontSize: "15.5px", fontWeight: "400", color: "var(--text-muted)", lineHeight: "1.65", maxWidth: "560px", margin: "0 auto 28px" }}>
            AI companies escrow USDC against a committed training corpus. A TEE-attested verifier
            privately calculates each artist's share, then Arc settles the payment onchain.
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

        {/* Two-sided framing — the primary pitch, concrete and stranger-
            testable, right below the headline before any mechanism detail. */}
        <div className="tryit-grid" style={{ maxWidth: "820px", margin: "36px auto 0", textAlign: "left" }}>
          <div className="g" style={{ padding: "16px 18px", borderLeft: "2px solid var(--accent)" }}>
            <div style={{ fontSize: "9.5px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--accent)", marginBottom: "8px" }}>
              For AI companies
            </div>
            <div style={{ fontSize: "12.5px", color: "var(--text-muted)", lineHeight: "1.6" }}>
              License training data without building your own rights, allocation and payment infrastructure.
            </div>
          </div>
          <div className="g" style={{ padding: "16px 18px", borderLeft: "2px solid var(--violet)" }}>
            <div style={{ fontSize: "9.5px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--violet)", marginBottom: "8px" }}>
              For artists
            </div>
            <div style={{ fontSize: "12.5px", color: "var(--text-muted)", lineHeight: "1.6" }}>
              Opt in once. Get a verifiable share whenever your work is licensed for training.
            </div>
          </div>
        </div>

        {/* Mechanism flow — the user journey, not a contract-call list */}
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
      <section ref={proofRef} className="px-section" style={{ paddingTop: "48px", paddingBottom: "40px" }}>
        <div className="section-container" style={{ margin: "0 auto 20px" }}>
          <div className="display" style={{ fontSize: "20px", fontWeight: "700", letterSpacing: "-0.01em", color: "var(--text)" }}>
            Private verification. Public settlement.
          </div>
          <div style={{ fontSize: "11.5px", color: "var(--text-muted)", marginTop: "3px", maxWidth: "640px" }}>
            The training corpus stays private. An attested enclave verifies dataset membership and
            computes each artist's allocation. Only the resulting allocation is published onchain —
            not the underlying music.
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

      {/* ── Secondary differentiation note — deliberately low-key, not
          competing with the hero's two-sided framing for attention. ── */}
      <section className="px-section" style={{ paddingTop: "8px", paddingBottom: "40px" }}>
        <div className="section-container" style={{
          maxWidth: "640px", textAlign: "center",
          fontSize: "11px", color: "var(--text-faint)", lineHeight: "1.7",
        }}>
          <span style={{ fontWeight: "600", color: "var(--text-muted)" }}>Why ArcID? </span>
          Existing licensing programs handle the relationship. ArcID handles the money and verification.
        </div>
      </section>

      <footer className="px-section" style={{ paddingTop: "24px", paddingBottom: "24px", borderTop: "1px solid var(--hairline)", textAlign: "center" }}>
        <span style={{ fontSize: "10.5px", color: "var(--text-faint)" }}>
          Built on Arc · Settled in USDC · Verified with TDX
        </span>
      </footer>
    </div>
  );
}
