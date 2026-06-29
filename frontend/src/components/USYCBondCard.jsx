const ARCSCAN   = "https://testnet.arcscan.app/address/";
const USYC_ADDR = "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C";

export default function USYCBondCard({ usyc }) {
  const addr     = usyc?.address;
  const deployed = !!addr;
  const apy      = usyc?.apy != null ? `${(Number(usyc.apy)/100).toFixed(2)}%` : "~4.9%";

  return (
    <div className="g" style={{ overflow: "hidden" }}>
      <div style={{ height: "2px", background: "linear-gradient(90deg, #7c3aed, #c084fc, transparent)" }} />
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
          <div>
            <div style={{ fontSize: "12px", fontWeight: "800", letterSpacing: "-.01em" }}>USYC Yield Bonds</div>
            <div style={{ fontSize: "10px", color: "rgba(242,240,255,.35)", marginTop: "2px" }}>
              USDC → USYC via Hashnote · earns while bonded
            </div>
          </div>
          <span style={{
            fontSize: "9px", padding: "3px 10px", borderRadius: "99px",
            background: deployed ? "rgba(74,222,128,.12)"  : "rgba(255,255,255,.05)",
            color:      deployed ? "#4ade80"               : "rgba(242,240,255,.2)",
            border:     `1px solid ${deployed ? "rgba(74,222,128,.3)" : "rgba(255,255,255,.08)"}`,
            fontWeight: "700", letterSpacing: ".08em", whiteSpace: "nowrap",
          }}>
            {deployed ? "DEPLOYED" : "PENDING"}
          </span>
        </div>

        <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
          <div style={{ flex: 1, padding: "9px 12px", borderRadius: "8px", background: "rgba(0,0,0,.2)" }}>
            <div style={{ fontSize: "9px", color: "rgba(242,240,255,.25)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>APY</div>
            <div className="mono" style={{ fontSize: "18px", fontWeight: "800", color: "#c084fc", marginTop: "2px" }}>{apy}</div>
          </div>
          <div style={{ flex: 1, padding: "9px 12px", borderRadius: "8px", background: "rgba(0,0,0,.2)" }}>
            <div style={{ fontSize: "9px", color: "rgba(242,240,255,.25)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>Backed by</div>
            <div style={{ fontSize: "12px", fontWeight: "700", color: "#f2f0ff", marginTop: "3px" }}>T-bills</div>
          </div>
        </div>

        <div style={{ fontSize: "11px", color: "rgba(242,240,255,.4)", lineHeight: "1.7", marginBottom: deployed ? "12px" : "0" }}>
          Agents post yield-bearing USYC as collateral.
          On breach, consumer receives USYC{" "}
          <span style={{ color: "#c084fc", fontWeight: "700" }}>worth more than original deposit.</span>
        </div>

        {deployed && (
          <a href={`${ARCSCAN}${addr}`} target="_blank" rel="noreferrer"
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "7px 10px", borderRadius: "7px",
              background: "rgba(124,58,237,.1)", border: "1px solid rgba(192,132,252,.2)",
              textDecoration: "none",
            }}
          >
            <span className="mono" style={{ fontSize: "9px", color: "#c084fc" }}>
              {addr.slice(0,14)}…{addr.slice(-6)}
            </span>
            <span style={{ color: "#c084fc", fontSize: "11px" }}>↗</span>
          </a>
        )}
      </div>
    </div>
  );
}
