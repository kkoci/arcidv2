import { useEffect, useState } from "react";

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
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
          <div>
            <div style={{ fontSize: "12px", fontWeight: "700", letterSpacing: "-.01em" }}>Circle Gateway Nanopayment</div>
            <div style={{ fontSize: "10px", color: "var(--paper-faint)", marginTop: "2px" }}>
              x402 · batched USDC settlement
            </div>
          </div>
          <span style={{
            fontSize: "9px", padding: "3px 10px", borderRadius: "4px",
            background: "rgba(192,138,62,.1)", color: "var(--seal)",
            border: `1px solid rgba(192,138,62,.28)`,
            fontWeight: "600", letterSpacing: ".08em", whiteSpace: "nowrap",
          }}>
            $0.001 / call
          </span>
        </div>

        <div style={{ fontSize: "11px", color: "var(--paper-muted)", lineHeight: "1.7", marginBottom: "12px" }}>
          Pays for one real <code style={{ color: "var(--seal)" }}>/api/price</code> call via Circle Gateway —
          verified and settled by the live testnet facilitator, separate from the fault/slash demo above.
        </div>

        {!result && !error && (
          <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
            <div style={{ flex: 1, padding: "9px 12px", borderRadius: "6px", background: "rgba(0,0,0,.18)" }}>
              <div style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>Seller balance</div>
              <div className="mono" style={{ fontSize: "16px", fontWeight: "700", color: "var(--paper)", marginTop: "2px" }}>
                {balance?.balance ? fmtUsdc(Number(balance.balance.balance) + Number(balance.balance.pendingBatch)) : "—"}
              </div>
            </div>
          </div>
        )}

        {result && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <div style={{ flex: 1, padding: "9px 12px", borderRadius: "6px", background: "rgba(0,0,0,.18)" }}>
              <div style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>Before</div>
              <div className="mono" style={{ fontSize: "14px", fontWeight: "700", color: "var(--paper-muted)", marginTop: "2px" }}>{fmtUsdc(settled(before))}</div>
            </div>
            <span style={{ color: "var(--seal)", fontSize: "16px", fontWeight: "700" }}>→</span>
            <div style={{ flex: 1, padding: "9px 12px", borderRadius: "6px", background: "rgba(127,184,143,.06)", border: `1px solid rgba(127,184,143,.22)` }}>
              <div style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>After</div>
              <div className="mono" style={{ fontSize: "14px", fontWeight: "700", color: "var(--settle)", marginTop: "2px" }}>{fmtUsdc(settled(after))}</div>
            </div>
          </div>
        )}

        <button onClick={pay} disabled={paying} style={{
          width: "100%", padding: "11px 16px",
          fontSize: "12px", fontWeight: "700", letterSpacing: "-.01em",
          borderRadius: "7px",
          background: paying ? "rgba(237,234,225,.05)" : "var(--seal)",
          color: paying ? "var(--paper-faint)" : "#0A0C10",
          border: "none", cursor: paying ? "not-allowed" : "pointer",
          transition: "all .2s",
        }}>
          {paying ? "Paying via Circle Gateway…" : "Pay $0.001 for oracle price →"}
        </button>

        {error && (
          <div style={{ marginTop: "9px", fontSize: "10px", color: "var(--breach)" }}>
            {error === "Circle Gateway demo requires DEV_MODE=false (real facilitator)"
              ? "Live demo only — this runs against the production oracle (DEV_MODE=false)."
              : error}
          </div>
        )}
      </div>
    </div>
  );
}
