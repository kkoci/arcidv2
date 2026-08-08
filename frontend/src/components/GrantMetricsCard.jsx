// Grant-readiness metrics (Phase 8.5, post-submission — see CHANGELOG.md).
// Stat tiles, not a chart — three headline numbers the research assessment
// asked to see live: how much of the trust layer runs deterministically vs.
// needs an LLM call, how often a breach gets routed to the challenge window
// instead of executing instantly, and cumulative USDC that has actually
// moved through bonded services (slashed + settled). All three are read
// straight off existing on-chain events / the existing verdict stream —
// aggregation, not new trust logic.

const usd = (atomicStr) => atomicStr != null ? `$${(Number(atomicStr) / 1e6).toFixed(2)}` : "—";
const pct = (n) => `${Math.round(n * 100)}%`;

export default function GrantMetricsCard({ stats, chainStats }) {
  const det = stats?.deterministicVerdicts ?? 0;
  const sem = stats?.semanticVerdicts ?? 0;
  const totalTiered = det + sem;
  const detShare = totalTiered > 0 ? det / totalTiered : null;

  const disputeRate = chainStats?.summary?.disputeRate ?? 0;
  const hasDisputes = (chainStats?.summary?.totalIndictments ?? 0) > 0;

  const throughput = chainStats?.summary?.cumulativeThroughputUsdc;

  return (
    <div className="gh" style={{ overflow: "hidden" }}>
      <div style={{
        padding: "14px 16px",
        borderBottom: "1px solid var(--hairline)",
      }}>
        <div style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "600" }}>
          Trust Layer — Grant Metrics
        </div>
        <div style={{ fontSize: "10px", color: "var(--paper-muted)", marginTop: "3px" }}>
          Deterministic vs. reasoned, challenge rate, cumulative throughput
        </div>
      </div>

      <div style={{ display: "flex" }}>
        <div title="Share of verdicts decided by mechanical checks alone (signature/freshness/schema) vs. ones that needed Claude's judgment call." style={{ flex: 1, padding: "11px 14px", borderRight: "1px solid var(--hairline)", cursor: "help" }}>
          <div className="hint" style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>
            Tier 1 (no LLM call)
          </div>
          {totalTiered > 0 ? (
            <>
              <div className="mono" style={{ fontSize: "15px", fontWeight: "700", color: "var(--settle)", marginTop: "3px" }}>
                {pct(detShare)}
              </div>
              <div style={{ fontSize: "9px", color: "var(--paper-faint)", marginTop: "2px" }}>
                {det} deterministic / {sem} reasoned
              </div>
            </>
          ) : (
            <div className="mono" style={{ fontSize: "15px", fontWeight: "700", color: "var(--paper)", marginTop: "3px" }}>—</div>
          )}
        </div>

        <div title="Share of large, non-obvious breaches held in a dispute window for owner review instead of slashing instantly." style={{ flex: 1, padding: "11px 14px", borderRight: "1px solid var(--hairline)", cursor: "help" }}>
          <div className="hint" style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>
            Challenge Rate
          </div>
          <div className="mono" style={{ fontSize: "15px", fontWeight: "700", color: hasDisputes ? "var(--amber)" : "var(--paper)", marginTop: "3px" }}>
            {pct(disputeRate)}
          </div>
          <div style={{ fontSize: "9px", color: "var(--paper-faint)", marginTop: "2px" }}>
            {chainStats?.summary?.totalIndictments ?? 0} indicted / {chainStats?.summary?.totalSlashes ?? 0} instant
          </div>
        </div>

        <div title="Cumulative USDC that has actually moved through bonded services — slashed to injured parties plus settled to honest providers." style={{ flex: 1, padding: "11px 14px", cursor: "help" }}>
          <div className="hint" style={{ fontSize: "9px", color: "var(--paper-faint)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: "600" }}>
            Throughput
          </div>
          <div className="mono" style={{ fontSize: "15px", fontWeight: "700", color: "var(--seal)", marginTop: "3px" }}>
            {usd(throughput)}
          </div>
          <div style={{ fontSize: "9px", color: "var(--paper-faint)", marginTop: "2px" }}>
            slashed + settled, cumulative
          </div>
        </div>
      </div>
    </div>
  );
}
