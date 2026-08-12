import { useState, useRef } from "react";
import SealMark from "./SealMark.jsx";

// The AcquisitionAgent server (acquisition/server.js) — a separate local
// process, not proxied through vite.config.js (which targets the oracle
// specifically). Direct fetch to its own port, same established pattern
// ProofOfExploitCard.jsx already uses for its own separate local server:
// the server sets its own permissive CORS headers for local dev.
const ACQ_SERVER = "http://localhost:3010";
const ARCSCAN = "https://testnet.arcscan.app/tx/";
const POLL_MS = 1800;

export default function AcquisitionForm() {
  const [brief, setBrief]   = useState("");
  const [budget, setBudget] = useState("3.00");
  const [job, setJob]       = useState(null);
  const [error, setError]   = useState("");
  const pollRef = useRef(null);

  const running = job && !["done", "error", "no_selection"].includes(job.status);

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  async function submit() {
    setError(""); setJob(null);
    if (!brief.trim()) { setError("Describe the training data you're looking for first."); return; }
    const budgetNum = Number(budget);
    if (!(budgetNum > 0)) { setError("Budget must be a positive number."); return; }

    try {
      const r = await fetch(`${ACQ_SERVER}/api/acquire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim(), budget: budgetNum }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || `Request failed (${r.status})`); return; }

      setJob({ jobId: data.jobId, status: "evaluating", evaluations: [] });
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const pr = await fetch(`${ACQ_SERVER}/api/acquire/${data.jobId}`);
          const pdata = await pr.json();
          setJob(pdata);
          if (["done", "error", "no_selection"].includes(pdata.status)) stopPolling();
        } catch { /* transient — next tick retries */ }
      }, POLL_MS);
    } catch (e) {
      setError(`AcquisitionAgent server isn't reachable — start it with \`npm run acquisition:server\` (port 3010). (${e.message})`);
    }
  }

  return (
    <div className="gh" style={{ overflow: "hidden" }}>
      {/* ── Identity row — this is the product surface, not a test harness ── */}
      <div style={{
        padding: "14px 16px", borderBottom: "1px solid var(--hairline)",
        display: "flex", alignItems: "center", gap: "12px",
      }}>
        <SealMark state="sealed" size={30} />
        <div style={{ flex: 1 }}>
          <div className="display" style={{ fontSize: "15px", fontWeight: "700", color: "var(--text)" }}>
            License Training Data
          </div>
          <div style={{ fontSize: "10.5px", color: "var(--text-faint)", marginTop: "2px" }}>
            Real AI judgment, real settlement — priced in USDC
          </div>
        </div>
        <span style={{
          fontSize: "9px", padding: "2px 8px", borderRadius: "4px",
          background: "var(--accent-soft)", color: "var(--accent)",
          fontWeight: "600", letterSpacing: ".1em", whiteSpace: "nowrap",
        }}>ARC TESTNET</span>
      </div>

      <div style={{ padding: "16px" }}>
        {/* ── Intake form ── */}
        <div style={{ marginBottom: "12px" }}>
          <label style={{ fontSize: "9.5px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", display: "block", marginBottom: "6px" }}>
            Describe the training data you're looking for
          </label>
          <textarea
            value={brief} onChange={(e) => setBrief(e.target.value)}
            disabled={running}
            placeholder='e.g. "energetic late-90s alt-rock, female vocals, no explicit lyrics"'
            rows={3}
            style={{
              width: "100%", padding: "10px 12px", borderRadius: "8px", fontSize: "12.5px",
              fontFamily: "'Inter', system-ui, sans-serif", resize: "vertical",
              background: "rgba(248,249,250,.04)", border: "1px solid var(--hairline-hi)", color: "var(--text)",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", marginBottom: "14px" }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: "9.5px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", display: "block", marginBottom: "6px" }}>
              Budget (USDC)
            </label>
            <input
              type="number" min="0.01" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)}
              disabled={running}
              className="mono"
              style={{
                width: "100%", padding: "9px 12px", borderRadius: "8px", fontSize: "13px",
                background: "rgba(248,249,250,.04)", border: "1px solid var(--hairline-hi)", color: "var(--text)",
              }}
            />
          </div>
          <button onClick={submit} disabled={running} style={{
            padding: "11px 20px", fontSize: "12.5px", fontWeight: "700",
            borderRadius: "10px", border: "none", whiteSpace: "nowrap",
            background: running ? "rgba(248,249,250,.06)" : "var(--gradient)",
            color: running ? "var(--text-faint)" : "#04050A",
            cursor: running ? "not-allowed" : "pointer",
            boxShadow: running ? "none" : "var(--shadow-sm)",
          }}>
            {running ? "Working…" : "License matching tracks"}
          </button>
        </div>

        {error && (
          <div style={{ padding: "10px 12px", borderRadius: "9px", background: "var(--breach-soft)", border: "1px solid rgba(248,113,113,.28)", fontSize: "11px", color: "var(--text)", marginBottom: "12px" }}>
            {error}
          </div>
        )}

        {job && <JobProgress job={job} />}
      </div>
    </div>
  );
}

function JobProgress({ job }) {
  const evaluating = job.status === "evaluating";
  const settling    = job.status === "settling";

  return (
    <div>
      {(evaluating || settling) && (
        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "10px" }}>
          {evaluating
            ? "Evaluating available tracks against your brief — a real Claude call per track, not a keyword filter."
            : "Settling on-chain — funding the pool, verifying, and paying artists. Real transactions take real time."}
        </div>
      )}

      {job.evaluations?.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px" }}>
          {job.evaluations.map((e) => (
            <div key={e.track.id} style={{
              padding: "9px 12px", borderRadius: "8px",
              background: e.fits ? "var(--settle-soft)" : "rgba(248,249,250,.03)",
              border: `1px solid ${e.fits ? "rgba(52,211,153,.25)" : "var(--hairline)"}`,
              fontSize: "11px",
            }}>
              <span style={{ fontWeight: "700", color: e.fits ? "var(--settle)" : "var(--text-faint)" }}>
                {e.fits ? "✓ " : "✗ "}{e.track.title}
              </span>
              <span style={{ color: "var(--text-faint)" }}> — {e.track.genre}/{e.track.era}/{e.track.mood}</span>
              <div style={{ color: "var(--text-muted)", marginTop: "3px", lineHeight: "1.5" }}>{e.reason}</div>
            </div>
          ))}
        </div>
      )}

      {job.status === "no_selection" && (
        <div style={{ padding: "12px 14px", borderRadius: "10px", background: "rgba(248,249,250,.03)", border: "1px solid var(--hairline)", fontSize: "11.5px", color: "var(--text-muted)" }}>
          No available track matched your brief within budget — nothing was licensed, nothing was charged.
        </div>
      )}

      {job.status === "error" && (
        <div style={{ padding: "12px 14px", borderRadius: "10px", background: "var(--breach-soft)", border: "1px solid rgba(248,113,113,.28)", fontSize: "11.5px", color: "var(--text)" }}>
          {job.error || "Something went wrong."}
        </div>
      )}

      {job.status === "done" && job.settlement && (
        <div style={{ padding: "14px 16px", borderRadius: "10px", background: "var(--settle-soft)", border: "1px solid rgba(52,211,153,.3)" }}>
          <div style={{ fontSize: "13px", fontWeight: "700", color: "var(--settle)", marginBottom: "8px" }}>
            ✓ Licensed and settled — ${job.settlement.poolAmountUsdc.toFixed(2)} paid for real
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "10px" }}>
            {job.selected.length} track{job.selected.length === 1 ? "" : "s"} licensed, {job.settlement.claims.length} artist{job.settlement.claims.length === 1 ? "" : "s"} paid. Here's what you licensed and who got paid — every link below is a real, independently verifiable Arc testnet transaction.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <a href={`${ARCSCAN}${job.settlement.submitAllocationTx}`} target="_blank" rel="noreferrer" className="mono"
              style={{ fontSize: "10px", color: "var(--settle)", textDecoration: "none" }}>
              Allocation submitted · {job.settlement.submitAllocationTx.slice(0, 10)}… ↗
            </a>
            {job.settlement.claims.map((c) => (
              <a key={c.tx} href={`${ARCSCAN}${c.tx}`} target="_blank" rel="noreferrer" className="mono"
                style={{ fontSize: "10px", color: "var(--settle)", textDecoration: "none" }}>
                Artist {c.artistKey} paid ${c.amountUsdc.toFixed(2)} · {c.tx.slice(0, 10)}… ↗
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
