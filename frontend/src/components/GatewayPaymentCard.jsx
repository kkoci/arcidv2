import { useEffect, useState } from "react";

const violet = "#c084fc";
const live   = "#22d9e8";

const fmtUsdc = (v) => v == null ? "—" : `$${Number(v).toFixed(6)}`;

export default function GatewayPaymentCard() {
  const [balance, setBalance] = useState(null);
  const [paying,  setPaying]  = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState("");

  useEffect(() => {
    fetch("/api/gateway-balance").then(r => r.ok ? r.json() : null).then(setBalance).catch(() => {});
  }, []);

  async function pay() {
    setPaying(true); setError(""); setResult(null);
    try {
      const r = await fetch("/admin/demo-pay", { method: "POST" });
      const data = await r.json();
      if (!r.ok) { setError(data.error || "Payment failed"); return; }
      setResult(data);
      setBalance(b => ({ ...b, balance: data.seller.after }));
    } catch (e) {
      setError(e.message);
    } finally {
      setPaying(false);
    }
  }

  const before = result?.seller?.before;
  const after  = result?.seller?.after;
  const settled = (bal) => bal ? Number(bal.balance) + Number(bal.pendingBatch) : null;

  return (
    <div className="g" style={{ overflow: "hidden" }}>
      <div style={{ height: "2px", background: `linear-gradient(90deg, ${violet}, ${live}, transparent)` }} />
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
          <div>
            <div style={{ fontSize: "12px", fontWeight: "800", letterSpacing: "-.01em" }}>Circle Gateway Nanopayment</div>
            <div style={{ fontSize: "10px", color: "rgba(242,240,255,.35)", marginTop: "2px" }}>
              x402 · batched USDC settlement
            </div>
          </div>
          <span style={{
            fontSize: "9px", padding: "3px 10px", borderRadius: "99px",
            background: "rgba(192,132,252,.12)", color: violet,
            border: `1px solid rgba(192,132,252,.3)`,
            fontWeight: "700", letterSpacing: ".08em", whiteSpace: "nowrap",
          }}>
            $0.001 / call
          </span>
        </div>

        <div style={{ fontSize: "11px", color: "rgba(242,240,255,.4)", lineHeight: "1.7", marginBottom: "12px" }}>
          Pays for one real <code style={{ color: violet }}>/api/price</code> call via Circle Gateway —
          verified and settled by the live testnet facilitator, separate from the fault/slash demo above.
        </div>

        {!result && !error && (
          <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
            <div style={{ flex: 1, padding: "9px 12px", borderRadius: "8px", background: "rgba(0,0,0,.2)" }}>
              <div style={{ fontSize: "9px", color: "rgba(242,240,255,.25)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>Seller balance</div>
              <div className="mono" style={{ fontSize: "16px", fontWeight: "800", color: "#f2f0ff", marginTop: "2px" }}>
                {balance?.balance ? fmtUsdc(Number(balance.balance.balance) + Number(balance.balance.pendingBatch)) : "—"}
              </div>
            </div>
          </div>
        )}

        {result && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <div style={{ flex: 1, padding: "9px 12px", borderRadius: "8px", background: "rgba(0,0,0,.2)" }}>
              <div style={{ fontSize: "9px", color: "rgba(242,240,255,.25)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>Before</div>
              <div className="mono" style={{ fontSize: "14px", fontWeight: "800", color: "rgba(242,240,255,.6)", marginTop: "2px" }}>{fmtUsdc(settled(before))}</div>
            </div>
            <span style={{ color: live, fontSize: "16px", fontWeight: "900" }}>→</span>
            <div style={{ flex: 1, padding: "9px 12px", borderRadius: "8px", background: "rgba(34,217,232,.08)", border: `1px solid rgba(34,217,232,.25)` }}>
              <div style={{ fontSize: "9px", color: "rgba(242,240,255,.25)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>After</div>
              <div className="mono" style={{ fontSize: "14px", fontWeight: "800", color: live, marginTop: "2px" }}>{fmtUsdc(settled(after))}</div>
            </div>
          </div>
        )}

        <button onClick={pay} disabled={paying} style={{
          width: "100%", padding: "11px 16px",
          fontSize: "12px", fontWeight: "800", letterSpacing: "-.01em",
          borderRadius: "9px",
          background: paying ? "rgba(255,255,255,.05)" : `linear-gradient(135deg, ${violet} 0%, #7c3aed 100%)`,
          color: paying ? "rgba(242,240,255,.2)" : "#fff",
          border: "none", cursor: paying ? "not-allowed" : "pointer",
          boxShadow: paying ? "none" : `0 6px 22px rgba(192,132,252,.35)`,
          transition: "all .2s",
        }}>
          {paying ? "Paying via Circle Gateway…" : "Pay $0.001 for oracle price →"}
        </button>

        {error && (
          <div style={{ marginTop: "9px", fontSize: "10px", color: "#fb7103" }}>
            {error === "Circle Gateway demo requires DEV_MODE=false (real facilitator)"
              ? "Live demo only — this runs against the production oracle (DEV_MODE=false)."
              : error}
          </div>
        )}
      </div>
    </div>
  );
}
