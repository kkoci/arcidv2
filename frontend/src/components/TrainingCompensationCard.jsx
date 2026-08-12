import { useState } from "react";
import SealMark from "./SealMark.jsx";

// Real, live-verified Arc testnet addresses from this vertical's Phase 7
// run (see CHANGELOG.md's "Licensed AI Training Compensation Rail" entry)
// — hardcoded the same way ProofOfExploitCard hardcodes EXPLOIT_BOUNTY_ADDRESS.
const ARCSCAN = "https://testnet.arcscan.app/tx/";
const ADDRESSES = {
  ArtistRegistry:     "0x6D4A2C82b3aEb6eFFca6dffd8cfA2008601359CA",
  TrainingPool:        "0x2d187b0209881b9dfd2ef1448aa55Cd82326fa50",
  CompensationClaim:   "0x33Df2A7b8642cbC68455231dB9833f5Aa1d3BFa5",
};

// Real transactions from this vertical's own live Arc testnet run — the
// evidence behind the money-flow visual above, kept as detail someone can
// open, not the first thing they see.
const PROOF_RECORDS = [
  {
    title: "Attested allocation submitted",
    body: "The real ingestion enclave verified a 3-track corpus against its on-chain commitment and against ArtistRegistry licensing, computed an equal-split allocation, and submitted it — pulling the pool's 3 USDC in from TrainingPool in the same transaction.",
    tx: "0xb7d306bc012dae9ddf6c90ae2010550376fee152d0dd66c678798f0592c4b9a5",
  },
  {
    title: "Artist A claimed — 2 tracks",
    body: "A real Merkle proof, verified on-chain against the attested allocation root. 2.00 USDC — the exact amount for 2 of the corpus's 3 tracks — paid for real.",
    tx: "0x0206f880dba17136c5c70023f2a17df856fff80ca4c08da9fd14eadb500d570b",
  },
  {
    title: "Artist B claimed — 1 track",
    body: "The same allocation root, a different leaf, a different proof. 1.00 USDC paid — confirmed both by the on-chain Claimed event and by decoding the transaction's own internal transfer log directly.",
    tx: "0x5bc4629f8129fffcd65a41c5a97a4f6635406fc7f7b0e4fcf74c287e4cfdf2ef",
  },
];

const fmt = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export default function TrainingCompensationCard() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <MoneyFlow />
      <VerifyDetail />
    </div>
  );
}

// ── The centerpiece — a real money-flow sequence, not a documentation
// list. Vertical by default (not just at mobile widths) so it degrades
// identically at any viewport, matching the "↓" sequence in the spec. ──
function MoneyFlow() {
  const Arrow = () => (
    <div style={{ textAlign: "center", color: "var(--text-faint)", fontSize: "16px", lineHeight: "1", margin: "2px 0" }} aria-hidden="true">↓</div>
  );

  return (
    <div className="gh" style={{ padding: "28px 20px", overflow: "hidden" }}>
      <div style={{ maxWidth: "440px", margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "stretch" }}>

        <div className="g" style={{ padding: "14px 18px", textAlign: "center" }}>
          <div className="mono" style={{ fontSize: "19px", fontWeight: "700", color: "var(--text)" }}>$3.00 USDC</div>
          <div style={{ fontSize: "10.5px", color: "var(--text-faint)", marginTop: "3px" }}>Training pool · 3 tracks licensed</div>
        </div>

        <Arrow />

        <div className="g" style={{ padding: "12px 18px", textAlign: "center", borderColor: "var(--violet-soft)", background: "rgba(var(--violet-rgb),.06)" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <SealMark state="sealed" size={16} />
            <span style={{ fontSize: "12px", fontWeight: "600", color: "var(--text)" }}>TEE verifies allocation</span>
          </div>
        </div>

        <Arrow />

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", justifyContent: "center" }}>
          <div className="g" style={{ padding: "12px 18px", textAlign: "center", flex: "1 1 160px" }}>
            <div className="mono" style={{ fontSize: "16px", fontWeight: "700", color: "var(--settle)" }}>+$2.00 USDC</div>
            <div style={{ fontSize: "10px", color: "var(--text-faint)", marginTop: "2px" }}>Artist A</div>
          </div>
          <div className="g" style={{ padding: "12px 18px", textAlign: "center", flex: "1 1 160px" }}>
            <div className="mono" style={{ fontSize: "16px", fontWeight: "700", color: "var(--settle)" }}>+$1.00 USDC</div>
            <div style={{ fontSize: "10px", color: "var(--text-faint)", marginTop: "2px" }}>Artist B</div>
          </div>
        </div>

        <Arrow />

        <div style={{
          textAlign: "center", padding: "10px 18px", borderRadius: "10px",
          background: "var(--settle-soft)", border: "1px solid rgba(52,211,153,.3)",
        }}>
          <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--settle)" }}>✓ Settled on Arc</span>
        </div>
      </div>

      <div style={{ textAlign: "center", fontSize: "11.5px", color: "var(--text-muted)", marginTop: "20px", lineHeight: "1.6" }}>
        This isn't a simulation. These allocations were generated and settled on Arc testnet.
      </div>
    </div>
  );
}

// ── Everything below is real evidence and the CLI reproduction path —
// kept, but opened deliberately rather than competing with MoneyFlow
// above for first attention. Same disclosure pattern this repo already
// uses elsewhere (VerdictHistory's "▾ Full reasoning", the old
// TechDetails toggle). ──
function VerifyDetail() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} style={{
        background: "none", border: "1px solid var(--hairline-hi)", color: "var(--text-muted)",
        padding: "8px 14px", fontSize: "11px", borderRadius: "8px", fontWeight: "600",
      }}>
        {open ? "▾" : "▸"} Verify the transactions
      </button>
      {open && (
        <div style={{ marginTop: "14px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <ProofFeed />
          <RunItCard />
        </div>
      )}
    </div>
  );
}

// ── What already happened, real — the detailed, per-transaction record. ──
function ProofFeed() {
  return (
    <div>
      <div style={{ marginBottom: "12px" }}>
        <div style={{ fontSize: "11px", color: "var(--text-faint)" }}>
          One real pool, one real allocation, two real claims · click any tx to verify
        </div>
      </div>
      <div className="proof-grid-3">
        {PROOF_RECORDS.map((r) => (
          <div key={r.tx} className="g" style={{ overflow: "hidden", borderColor: "rgba(52,211,153,.28)" }}>
            <div style={{
              padding: "13px 16px",
              background: "var(--settle-soft)",
              display: "flex", alignItems: "center", gap: "9px",
              borderBottom: "1px solid rgba(52,211,153,.28)",
            }}>
              <SealMark state="sealed" size={16} />
              <span style={{ fontSize: "13px", fontWeight: "700", color: "var(--settle)", letterSpacing: "-0.01em" }}>
                {r.title}
              </span>
            </div>
            <div style={{ padding: "13px 16px" }}>
              <div style={{ fontSize: "11.5px", color: "var(--text-muted)", lineHeight: "1.7", marginBottom: "10px" }}>
                {r.body}
              </div>
              <a href={`${ARCSCAN}${r.tx}`} target="_blank" rel="noreferrer"
                className="mono"
                style={{
                  display: "inline-flex", alignItems: "center", gap: "6px",
                  padding: "5px 12px", borderRadius: "6px",
                  background: "var(--settle-soft)",
                  border: "1px solid rgba(52,211,153,.3)",
                  color: "var(--settle)", fontSize: "10px", fontWeight: "600",
                  textDecoration: "none",
                }}
              >
                View the transaction · {r.tx.slice(0, 10)}… ↗
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── How to run a fresh cycle — CLI is the confirmed primary demo path for
// this vertical (register → deposit → ingest → claim needs a running
// ingestion enclave process + several funded wallets, not a single
// stateless request a browser button can fire) — stated plainly rather
// than wiring a button that doesn't actually do the real thing. ──
function RunItCard() {
  return (
    <div className="g" style={{ overflow: "hidden" }}>
      <div style={{
        padding: "14px 16px", borderBottom: "1px solid var(--hairline)",
        display: "flex", alignItems: "center", gap: "12px",
      }}>
        <SealMark state="sealed" size={26} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "9px", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "600" }}>
            Run a fresh cycle
          </div>
          <div
            className="mono" title="The real Merkle-proof claim contract — artists claim their exact share here."
            style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "3px", cursor: "help", borderBottom: "1px dotted var(--text-faint)", display: "inline-block" }}
          >
            CompensationClaim · {fmt(ADDRESSES.CompensationClaim)}
          </div>
        </div>
      </div>

      <div style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: "11.5px", color: "var(--text-muted)", lineHeight: "1.7", marginBottom: "14px" }}>
          The full cycle — register two demo artists, fund a pool, call the real ingestion enclave,
          submit the attested allocation, and claim — needs a running enclave process and several
          funded wallets, not a single request a browser button can fire. Run it for real from the CLI:
        </div>
        <div className="mono" style={{
          padding: "12px 14px", borderRadius: "10px",
          background: "rgba(248,249,250,.04)", border: "1px solid var(--hairline-hi)",
          fontSize: "11px", color: "var(--text)", lineHeight: "1.9", overflowX: "auto",
        }}>
          <div style={{ color: "var(--text-faint)" }}># one terminal</div>
          <div>cd ingestor && npm start</div>
          <div style={{ color: "var(--text-faint)", marginTop: "6px" }}># another terminal</div>
          <div>npm run demo:training-compensation</div>
        </div>

        <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {Object.entries(ADDRESSES).map(([name, addr]) => (
            <div key={name} style={{
              display: "flex", justifyContent: "space-between",
              padding: "6px 0", borderBottom: "1px solid var(--hairline)", fontSize: "10.5px",
            }}>
              <span style={{ color: "var(--text-faint)" }}>{name}</span>
              <a href={`https://testnet.arcscan.app/address/${addr}`} target="_blank" rel="noreferrer"
                className="mono" style={{ color: "var(--accent)", fontSize: "10px", textDecoration: "none" }}>
                {fmt(addr)} ↗
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
