import { useState } from "react";

const ARCSCAN = "https://testnet.arcscan.app/tx/";

function headline(v) {
  const c = v.checks ?? {};
  if (v.verdict === "breach") {
    if (c.signature_valid === false) return "Forged signature detected";
    if (c.timestamp_fresh === false) return "Stale response detected";
    if (c.value_present   === false) return "Null data — oracle delivered nothing";
    return "SLA breach confirmed";
  }
  if (v.verdict === "ok") return "Valid signed response — SLA met";
  return "Insufficient evidence";
}

/* Split Claude's reasoning into a bold lead + supporting body */
function splitReason(reason) {
  if (!reason) return { lead: null, body: null };
  const dot = reason.search(/[.!?]\s+/);
  if (dot === -1 || dot > 180) {
    return { lead: reason.slice(0, 120) + (reason.length > 120 ? "…" : ""), body: reason.length > 120 ? reason : null };
  }
  const boundary = dot + 1;
  return { lead: reason.slice(0, boundary).trim(), body: reason.slice(boundary).trim() || null };
}

export default function VerdictHistory({ verdicts }) {
  if (!verdicts.length) return <EmptyState />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "14px" }}>
        <div>
          <div style={{ fontSize: "18px", fontWeight: "900", letterSpacing: "-0.02em" }}>
            Adjudication Feed
          </div>
          <div style={{ fontSize: "11px", color: "rgba(242,240,255,.35)", marginTop: "3px" }}>
            Every verdict is on-chain · click any tx to verify
          </div>
        </div>
        <span className="mono" style={{ fontSize: "11px", color: "rgba(242,240,255,.2)" }}>
          {verdicts.length} total
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {verdicts.map((v, i) => <Card key={i} v={v} />)}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="g" style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: "72px 40px", textAlign: "center",
      minHeight: "360px",
    }}>
      <div style={{
        width: "64px", height: "64px", borderRadius: "50%",
        background: "rgba(251,113,3,.1)", border: "1px solid rgba(251,113,3,.25)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "26px", marginBottom: "18px",
        boxShadow: "0 0 28px rgba(251,113,3,.2)",
      }}>⚡</div>
      <div style={{ fontSize: "20px", fontWeight: "900", letterSpacing: "-0.02em", marginBottom: "10px" }}>
        No adjudications yet
      </div>
      <div style={{ fontSize: "13px", color: "rgba(242,240,255,.35)", lineHeight: "1.9", maxWidth: "300px" }}>
        Pick a fault mode, then hit{" "}
        <span style={{ color: "#fb7103", fontWeight: "700" }}>Oracle cheated. Slash it.</span>
        <br />Claude reads the evidence. On-chain in seconds.
      </div>
    </div>
  );
}

function Card({ v }) {
  const [expanded, setExpanded] = useState(false);
  const c        = v.checks ?? {};
  const isBreach = v.verdict === "breach";
  const ago      = v.received_at
    ? Math.round((Date.now() - new Date(v.received_at).getTime()) / 1000)
    : null;

  const { lead, body } = splitReason(v.reason);

  const accent = isBreach ? "#fb7103" : "#22d9e8";
  const dimBg  = isBreach ? "rgba(251,113,3,.08)"  : "rgba(34,217,232,.06)";
  const bdr    = isBreach ? "rgba(251,113,3,.25)"  : "rgba(34,217,232,.18)";
  const leadColor = isBreach ? "rgba(255,220,185,.95)" : "rgba(180,252,255,.95)";
  const bodyColor = isBreach ? "rgba(255,210,170,.7)"  : "rgba(160,245,255,.7)";

  return (
    <div className="g slide-in" style={{ overflow: "hidden", borderColor: bdr }}>
      {/* Accent line */}
      <div style={{ height: "2px", background: `linear-gradient(90deg, ${accent}, transparent 70%)` }} />

      {/* Header */}
      <div style={{
        padding: "14px 18px", background: dimBg,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: `1px solid ${bdr}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "17px", fontWeight: "900", color: accent, letterSpacing: "-0.02em" }}>
            {isBreach ? "⚡ BOND SLASHED" : "✓ SLA MET"}
          </span>
          {v.fault_mode && (
            <span className="mono" style={{
              fontSize: "9px", padding: "2px 8px", borderRadius: "99px",
              background: "rgba(251,191,36,.12)", color: "#fbbf24",
              border: "1px solid rgba(251,191,36,.25)", fontWeight: "600",
            }}>
              {v.fault_mode}
            </span>
          )}
        </div>
        <span className="mono" style={{ fontSize: "10px", color: "rgba(242,240,255,.2)" }}>
          {ago != null ? `${ago}s ago` : ""}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: "16px 18px" }}>
        {/* Event headline */}
        <div style={{ fontSize: "15px", fontWeight: "800", letterSpacing: "-0.01em", marginBottom: "14px", color: "#f2f0ff", lineHeight: "1.3" }}>
          {headline(v)}
        </div>

        {/* Claude reasoning block */}
        {lead && (
          <div style={{
            padding: "14px 16px", borderRadius: "8px",
            background: "rgba(0,0,0,.28)",
            borderLeft: `2px solid ${isBreach ? "#c084fc" : "#22d9e8"}`,
            marginBottom: "14px",
          }}>
            {/* Label */}
            <div style={{
              fontSize: "9px", fontWeight: "700", letterSpacing: ".1em",
              textTransform: "uppercase", marginBottom: "10px",
              color: isBreach ? "#c084fc" : "#22d9e8",
              display: "flex", alignItems: "center", gap: "6px",
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
              </svg>
              Claude Sonnet 4.6 · Finding
            </div>

            {/* Lead sentence — big and readable */}
            <div style={{ fontSize: "14px", fontWeight: "700", color: leadColor, lineHeight: "1.55", marginBottom: body ? "12px" : "0" }}>
              {lead}
            </div>

            {/* Body — expandable */}
            {body && (
              <>
                {expanded && (
                  <div style={{ fontSize: "12px", color: bodyColor, lineHeight: "1.85", marginBottom: "10px" }}>
                    {body}
                  </div>
                )}
                <button
                  onClick={() => setExpanded(x => !x)}
                  style={{
                    background: "none", border: "none", padding: "0",
                    fontSize: "10px", color: isBreach ? "#c084fc" : "#22d9e8",
                    cursor: "pointer", fontWeight: "600", letterSpacing: ".06em",
                    opacity: .8,
                  }}
                >
                  {expanded ? "▴ Hide reasoning" : "▾ Full reasoning"}
                </button>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {v.slash_tx && (
            <a href={`${ARCSCAN}${v.slash_tx}`} target="_blank" rel="noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                padding: "5px 12px", borderRadius: "6px",
                background: "rgba(251,113,3,.14)", border: "1px solid rgba(251,113,3,.3)",
                color: "#fb7103", fontSize: "10px", fontWeight: "700",
                fontFamily: "'JetBrains Mono', monospace", textDecoration: "none",
              }}
            >
              Bond seized · {v.slash_tx.slice(0, 10)}… ↗
            </a>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: "10px" }}>
            {[["ts", c.timestamp_fresh], ["val", c.value_present], ["sig", c.signature_valid]].map(([lbl, pass]) => (
              <span key={lbl} className="mono" style={{ fontSize: "10px", color: pass ? "#4ade80" : "#fb7103" }}>
                {pass ? "✓" : "✗"} {lbl}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
