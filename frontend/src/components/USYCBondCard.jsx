const ARCSCAN = "https://testnet.arcscan.app/address/";

export default function USYCBondCard({ usyc }) {
  const addr     = usyc?.address;
  const deployed = !!addr;
  const apy      = usyc?.apy != null ? `${(Number(usyc.apy)/100).toFixed(2)}%` : "~4.9%";

  return (
    <div className="g" style={{ overflow: "hidden" }}>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
          <div>
            <div style={{ fontSize: "12px", fontWeight: "700", letterSpacing: "-.01em" }}>USYC Yield Bonds</div>
            <div style={{ fontSize: "10px", color: "var(--paper-faint)", marginTop: "2px" }}>
              USDC → USYC via Hashnote · earns while sealed
            </div>
          </div>
          <span style={{
            fontSize: "9px", padding: "3px 10px", borderRadius: "4px",
            background: deployed ? "rgba(127,184,143,.1)"  : "rgba(237,234,225,.04)",
            color:      deployed ? "var(--settle)"          : "var(--paper-faint)",
            border:     `1px solid ${deployed ? "rgba(127,184,143,.28)" : "var(--hairline)"}`,
            fontWeight: "600", letterSpacing: ".08em", whiteSpace: "nowrap",
          }}>
            {deployed ? "DEPLOYED" : "PENDING"}
          </span>
        </div>

        <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
          <div style={{ flex: 1, padding: "9px 12px", borderRadius: "6px", background: "rgba(0,0,0,.18)" }}>
            <div style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>APY</div>
            <div className="mono" style={{ fontSize: "18px", fontWeight: "700", color: "var(--seal)", marginTop: "2px" }}>{apy}</div>
          </div>
          <div style={{ flex: 1, padding: "9px 12px", borderRadius: "6px", background: "rgba(0,0,0,.18)" }}>
            <div style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>Backed by</div>
            <div style={{ fontSize: "12px", fontWeight: "600", color: "var(--paper)", marginTop: "3px" }}>T-bills</div>
          </div>
        </div>

        <div style={{ fontSize: "11px", color: "var(--paper-muted)", lineHeight: "1.7", marginBottom: deployed ? "12px" : "0" }}>
          Agents post yield-bearing USYC as collateral.
          On breach, consumer receives USYC{" "}
          <span style={{ color: "var(--seal)", fontWeight: "600" }}>worth more than original deposit.</span>
        </div>

        {deployed && (
          <a href={`${ARCSCAN}${addr}`} target="_blank" rel="noreferrer"
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "7px 10px", borderRadius: "6px",
              background: "rgba(192,138,62,.08)", border: "1px solid rgba(192,138,62,.22)",
              textDecoration: "none",
            }}
          >
            <span className="mono" style={{ fontSize: "9px", color: "var(--seal)" }}>
              {addr.slice(0,14)}…{addr.slice(-6)}
            </span>
            <span style={{ color: "var(--seal)", fontSize: "11px" }}>↗</span>
          </a>
        )}
      </div>
    </div>
  );
}
