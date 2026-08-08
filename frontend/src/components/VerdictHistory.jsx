import { useState } from "react";
import SealMark from "./SealMark.jsx";

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
          <div className="display" style={{ fontSize: "18px", fontWeight: "600", letterSpacing: "-0.01em" }}>
            Adjudication Feed
          </div>
          <div style={{ fontSize: "11px", color: "var(--paper-faint)", marginTop: "3px" }}>
            Every verdict is on-chain · click any tx to verify
          </div>
        </div>
        <span className="mono" style={{ fontSize: "11px", color: "var(--paper-faint)" }}>
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
      <SealMark state="sealed" size={48} />
      <div className="display" style={{ fontSize: "19px", fontWeight: "600", letterSpacing: "-0.01em", marginTop: "18px", marginBottom: "10px" }}>
        Nothing has broken the seal yet
      </div>
      <div style={{ fontSize: "13px", color: "var(--paper-muted)", lineHeight: "1.9", maxWidth: "300px" }}>
        Pick a fault mode, then hit{" "}
        <span style={{ color: "var(--breach)", fontWeight: "600" }}>Oracle cheated. Break the seal.</span>
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

  const accent = isBreach ? "var(--breach)" : "var(--settle)";
  const dimBg  = isBreach ? "rgba(216,72,60,.06)"  : "rgba(127,184,143,.05)";
  const bdr    = isBreach ? "rgba(216,72,60,.28)"  : "rgba(127,184,143,.2)";

  return (
    <div className="g slide-in" style={{ overflow: "hidden", borderColor: bdr }}>
      {/* Header */}
      <div style={{
        padding: "13px 18px", background: dimBg,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: `1px solid ${bdr}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
          <SealMark state={isBreach ? "broken" : "sealed"} size={17} />
          <span
            title={isBreach
              ? "The consumer agent confirmed a breach and the bond contract automatically paid out the provider's collateral — no human approved this."
              : "The consumer agent verified this response met the SLA — signature valid, fresh, and (for Claude-reviewed calls) semantically genuine."}
            style={{ fontSize: "15px", fontWeight: "700", color: accent, letterSpacing: "-0.01em", cursor: "help" }}
          >
            {isBreach ? "BOND SLASHED" : "SLA MET"}
          </span>
          {v.fault_mode && (
            <span className="mono" style={{
              fontSize: "9px", padding: "2px 8px", borderRadius: "4px",
              background: "rgba(201,169,74,.12)", color: "var(--amber)",
              border: "1px solid rgba(201,169,74,.28)", fontWeight: "600",
            }}>
              {v.fault_mode}
            </span>
          )}
        </div>
        <span className="mono" style={{ fontSize: "10px", color: "var(--paper-faint)" }}>
          {ago != null ? `${ago}s ago` : ""}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: "16px 18px" }}>
        <div style={{ fontSize: "15px", fontWeight: "600", letterSpacing: "-0.01em", marginBottom: "14px", color: "var(--paper)", lineHeight: "1.3" }}>
          {headline(v)}
        </div>

        {/* Claude reasoning block */}
        {lead && (
          <div style={{
            padding: "14px 16px", borderRadius: "7px",
            background: "rgba(0,0,0,.22)",
            borderLeft: `2px solid var(--seal)`,
            marginBottom: "14px",
          }}>
            <div style={{
              fontSize: "9px", fontWeight: "600", letterSpacing: ".1em",
              textTransform: "uppercase", marginBottom: "10px",
              color: "var(--seal)",
              display: "flex", alignItems: "center", gap: "6px",
            }}>
              Claude Sonnet 4.6 · Finding
            </div>

            <div style={{ fontSize: "14px", fontWeight: "500", color: "var(--paper)", lineHeight: "1.55", marginBottom: body ? "12px" : "0" }}>
              {lead}
            </div>

            {body && (
              <>
                {expanded && (
                  <div style={{ fontSize: "12px", color: "var(--paper-muted)", lineHeight: "1.85", marginBottom: "10px" }}>
                    {body}
                  </div>
                )}
                <button
                  onClick={() => setExpanded(x => !x)}
                  style={{
                    background: "none", border: "none", padding: "0",
                    fontSize: "10px", color: "var(--seal)",
                    cursor: "pointer", fontWeight: "600", letterSpacing: ".06em",
                    opacity: .85,
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
                padding: "5px 12px", borderRadius: "5px",
                background: "rgba(216,72,60,.12)", border: "1px solid rgba(216,72,60,.28)",
                color: "var(--breach)", fontSize: "10px", fontWeight: "600",
                fontFamily: "'IBM Plex Mono', monospace", textDecoration: "none",
              }}
            >
              Bond seized · {v.slash_tx.slice(0, 10)}… ↗
            </a>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: "10px" }}>
            {[
              ["ts",  c.timestamp_fresh,   "Timestamp freshness — was this response younger than the 30s SLA when it was checked?"],
              ["val", c.value_present,     "Value present — did the oracle actually return a price, instead of empty/null data?"],
              ["sig", c.signature_valid,   "Signature validity — was this response cryptographically signed by the registered oracle wallet?"],
            ].map(([lbl, pass, hint]) => (
              <span key={lbl} title={hint} className="mono" style={{ fontSize: "10px", color: pass ? "var(--settle)" : "var(--breach)", cursor: "help" }}>
                {pass ? "✓" : "✗"} {lbl}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
