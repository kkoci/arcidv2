const ARCSCAN = "https://testnet.arcscan.app/tx/";

function verdictHeadline(v) {
  if (v.verdict === "breach") {
    const c = v.checks ?? {};
    if (c.signature_valid === false) return "Oracle submitted a forged signature";
    if (c.timestamp_fresh === false) return "Oracle response was stale";
    if (c.value_present   === false) return "Oracle returned null data";
    return "SLA breach confirmed";
  }
  if (v.verdict === "ok") return "Oracle delivered a valid signed response";
  return "Insufficient evidence";
}

export default function VerdictHistory({ verdicts }) {
  if (verdicts.length === 0) {
    return (
      <div style={{
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        padding: "80px 40px", textAlign: "center",
        border: "1px dashed #1a1b2e", borderRadius: "12px",
        minHeight: "400px",
      }}>
        <div style={{
          fontSize: "48px", marginBottom: "20px",
          filter: "grayscale(0.3)",
        }}>⚡</div>
        <div style={{ fontSize: "20px", fontWeight: "800", color: "#e8eaf6", marginBottom: "10px", letterSpacing: "-0.01em" }}>
          No adjudications yet
        </div>
        <div style={{ fontSize: "13px", color: "#5c5f7a", lineHeight: "1.8", maxWidth: "340px" }}>
          Click <span style={{ color: "#ef4444", fontWeight: "700" }}>"Oracle cheated. Slash it."</span> on the right.<br />
          Claude will read the evidence, decide the verdict,<br />
          and slash the bond on-chain in real time.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "20px" }}>
        <div>
          <div style={{ fontSize: "18px", fontWeight: "800", color: "#e8eaf6", letterSpacing: "-0.01em" }}>
            Adjudication Feed
          </div>
          <div style={{ fontSize: "11px", color: "#5c5f7a", marginTop: "3px" }}>
            Every verdict is on-chain. Click any transaction to verify.
          </div>
        </div>
        <div style={{ fontSize: "11px", color: "#5c5f7a", fontFamily: "'JetBrains Mono', monospace" }}>
          {verdicts.length} verdicts
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {verdicts.map((v, i) => <VerdictCard key={i} v={v} />)}
      </div>
    </div>
  );
}

function VerdictCard({ v }) {
  const c        = v.checks ?? {};
  const isBreach = v.verdict === "breach";
  const ago      = v.received_at
    ? Math.round((Date.now() - new Date(v.received_at).getTime()) / 1000)
    : null;

  return (
    <div style={{
      borderRadius: "10px",
      overflow: "hidden",
      border: isBreach ? "1px solid rgba(239,68,68,0.2)" : "1px solid rgba(52,211,153,0.15)",
    }}>
      {/* Colored header band */}
      <div style={{
        padding: "14px 20px",
        background: isBreach
          ? "linear-gradient(90deg, rgba(239,68,68,0.2) 0%, rgba(239,68,68,0.05) 100%)"
          : "linear-gradient(90deg, rgba(52,211,153,0.12) 0%, rgba(52,211,153,0.03) 100%)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: isBreach ? "1px solid rgba(239,68,68,0.15)" : "1px solid rgba(52,211,153,0.1)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{
            fontSize: "18px", fontWeight: "900", letterSpacing: "-0.01em",
            color: isBreach ? "#ef4444" : "#34d399",
          }}>
            {isBreach ? "⚡ BOND SLASHED" : "✓ SLA MET"}
          </span>
          {v.fault_mode && (
            <span style={{
              fontSize: "10px", padding: "2px 8px", borderRadius: "99px",
              background: "rgba(245,158,11,0.15)", color: "#f59e0b",
              border: "1px solid rgba(245,158,11,0.3)", fontFamily: "'JetBrains Mono', monospace",
            }}>
              fault:{v.fault_mode}
            </span>
          )}
        </div>
        <span style={{ fontSize: "11px", color: "#3a3c52", fontFamily: "'JetBrains Mono', monospace" }}>
          {ago != null ? `${ago}s ago` : ""}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: "18px 20px", background: "#0d0f1f" }}>
        {/* Sub-headline */}
        <div style={{ fontSize: "14px", fontWeight: "700", color: "#e8eaf6", marginBottom: "16px", lineHeight: "1.4" }}>
          {verdictHeadline(v)}
        </div>

        {/* Claude reasoning */}
        {v.reason && (
          <div style={{
            borderLeft: `2px solid ${isBreach ? "#818cf8" : "#34d399"}`,
            paddingLeft: "16px",
            marginBottom: "16px",
          }}>
            <div style={{
              fontSize: "10px", fontWeight: "700", letterSpacing: "0.08em",
              textTransform: "uppercase", color: isBreach ? "#818cf8" : "#34d399",
              marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px",
            }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/>
                <path d="M8 12l2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Claude Sonnet 4.6 · Adjudicator Reasoning
            </div>
            <div style={{
              fontSize: "12px", lineHeight: "1.85",
              color: isBreach ? "#c4b5fd" : "#a7f3d0",
            }}>
              {v.reason}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", paddingTop: "12px", borderTop: "1px solid #1a1b2e" }}>
          {v.slash_tx && (
            <a
              href={`${ARCSCAN}${v.slash_tx}`}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                padding: "6px 14px", borderRadius: "6px",
                background: "rgba(239,68,68,0.15)",
                border: "1px solid rgba(239,68,68,0.3)",
                color: "#ef4444", fontSize: "11px", fontWeight: "700",
                fontFamily: "'JetBrains Mono', monospace", textDecoration: "none",
              }}
            >
              Bond seized · {v.slash_tx.slice(0, 10)}… ↗
            </a>
          )}
          <div style={{ display: "flex", gap: "10px" }}>
            {[["ts", c.timestamp_fresh], ["val", c.value_present], ["sig", c.signature_valid]].map(([label, pass]) => (
              <span key={label} style={{
                fontSize: "11px", fontFamily: "'JetBrains Mono', monospace",
                color: pass ? "#34d399" : "#ef4444",
              }}>
                {pass ? "✓" : "✗"} {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
