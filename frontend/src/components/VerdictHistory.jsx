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
  const c        = v.checks ?? {};
  const isBreach = v.verdict === "breach";
  const ago      = v.received_at
    ? Math.round((Date.now() - new Date(v.received_at).getTime()) / 1000)
    : null;

  const accent = isBreach ? "#fb7103" : "#22d9e8";
  const dimBg  = isBreach ? "rgba(251,113,3,.08)"  : "rgba(34,217,232,.06)";
  const bdr    = isBreach ? "rgba(251,113,3,.25)"  : "rgba(34,217,232,.18)";
  const txt    = isBreach ? "rgba(255,220,190,.85)" : "rgba(180,250,255,.85)";

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
        <div style={{ fontSize: "14px", fontWeight: "700", marginBottom: "12px", color: "#f2f0ff" }}>
          {headline(v)}
        </div>

        {v.reason && (
          <div style={{
            padding: "12px 14px", borderRadius: "8px",
            background: "rgba(0,0,0,.25)",
            borderLeft: `2px solid ${isBreach ? "#c084fc" : "#22d9e8"}`,
            marginBottom: "14px",
          }}>
            <div style={{
              fontSize: "9px", fontWeight: "700", letterSpacing: ".1em",
              textTransform: "uppercase", marginBottom: "8px",
              color: isBreach ? "#c084fc" : "#22d9e8",
            }}>
              Claude Sonnet 4.6 · Reasoning
            </div>
            <div style={{ fontSize: "12px", lineHeight: "1.85", color: txt }}>
              {v.reason}
            </div>
          </div>
        )}

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
              Bond seized · {v.slash_tx.slice(0,10)}… ↗
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
