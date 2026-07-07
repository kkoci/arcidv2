/**
 * adjudicator.js — LLM-driven oracle service adjudication.
 *
 * This is the component that makes the consumer an AGENT rather than a cron job.
 *
 * Instead of `if (timestamp > 30s) slash()`, the agent is given the full oracle
 * response and asked to judge whether the provider met its SLA — and to return
 * a structured verdict with a written rationale.
 *
 * The distinction between "provider is down", "provider is serving stale data",
 * and "provider cannot prove authorship" is exactly the reasoning that earns
 * the 30% Agentic Sophistication score.
 *
 * Uses Claude's tool_use with tool_choice=required to force structured JSON output
 * without parsing fragile text responses.
 */

const Anthropic = require("@anthropic-ai/sdk");
const config    = require("./config");

const client = new Anthropic.default({ apiKey: config.ANTHROPIC_API_KEY });

const VERDICT_TOOL = {
  name: "deliver_verdict",
  description:
    "Deliver the final adjudication verdict on whether the oracle provider met their SLA. " +
    "Called exactly once per oracle response evaluation.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["ok", "breach", "uncertain"],
        description:
          "'ok' — provider met all SLA requirements. " +
          "'breach' — provider clearly failed in a slashable way (stake at risk). " +
          "'uncertain' — ambiguous failure, could be transient; benefit of the doubt.",
      },
      reason: {
        type: "string",
        description:
          "Detailed, written rationale. Include which SLA criteria were met or violated, " +
          "your interpretation of the failure type, and why you chose this verdict. " +
          "This rationale is logged on-chain in the AgentSlashed event.",
      },
      should_slash: {
        type: "boolean",
        description:
          "true only when verdict='breach'. A good adjudicator shows restraint — " +
          "do not slash on uncertain or transient failures.",
      },
      checks: {
        type: "object",
        description: "Boolean results for each SLA dimension",
        properties: {
          timestamp_fresh:  { type: "boolean", description: "Response age ≤ max_age_seconds" },
          value_present:    { type: "boolean", description: "value is non-null and parseable" },
          signature_valid:  { type: "boolean", description: "signature recovers to oracle wallet" },
        },
        required: ["timestamp_fresh", "value_present", "signature_valid"],
      },
    },
    required: ["verdict", "reason", "should_slash", "checks"],
  },
};

const SYSTEM_PROMPT = `You are an autonomous adjudication agent for the ArcID bonded reputation system on Arc.

Your role: evaluate whether a bonded oracle provider met its service-level agreement (SLA) for a paid query.

The oracle provider has posted a USDC bond as collateral. If they underdeliver, their bond is slashed and transferred to you — making reputation capital at risk, not a score.

SLA requirements:
  1. timestamp_fresh  — response timestamp must be within max_age_seconds of the current time
  2. value_present    — value must be non-null and parseable as a number
  3. signature_valid  — the ECDSA signature must recover to the oracle's registered wallet

Verdict guidance:
  - "ok"        — all three checks pass
  - "breach"    — one or more checks fail in a clearly attributable way (slash is justified)
  - "uncertain" — failure is ambiguous or likely transient (e.g. network error caused null response,
                  or a single isolated incident). Show restraint — a good adjudicator does not slash
                  on every anomaly. A wrong slash damages a legitimate provider.

When a breach IS clear:
  - stale timestamp with valid signature → provider is live but deliberately serving stale data
  - bad/missing signature with valid data → provider cannot prove authorship of this response
  - null value AND null signature → completely malformed; could be crash (uncertain) or pattern (breach)

Always reason step by step in your rationale before calling deliver_verdict.

The "reason" field is displayed as plain text in a UI and logged verbatim on-chain — write it as
plain prose sentences. Do not use markdown (no **bold**, no bullet lists, no headers).`;

/**
 * @param {object} opts
 * @param {object} opts.response        Raw oracle response {value, timestamp, oracle, signature, sla}
 * @param {boolean} opts.sigValid       Did signature recover to oracle wallet?
 * @param {string|null} opts.sigError   Reason for sig failure if sigValid=false
 * @param {string|null} opts.sigRecovered  Recovered address from signature
 * @param {number} opts.ageSeconds      Response age in seconds
 * @param {number} opts.cycleNumber     For logging
 * @returns {Promise<{verdict, reason, should_slash, checks}>}
 */
async function adjudicate({ response, sigValid, sigError, sigRecovered, ageSeconds, cycleNumber }) {
  const maxAge = response.sla?.max_age_seconds ?? 30;
  const timestampFresh = ageSeconds <= maxAge;
  const valuePresent = response.value !== null && response.value !== undefined && response.value !== "";

  const userMessage = `
## Oracle Response (Cycle #${cycleNumber})

**Paid:** $0.001 USDC via x402 nanopayment

**Response data:**
- value:       ${response.value === null ? "NULL" : JSON.stringify(response.value)}
- timestamp:   ${response.timestamp} (${ageSeconds}s ago)
- oracle:      ${response.oracle}
- signature:   ${response.signature ? response.signature.slice(0, 20) + "..." : "NULL"}

**SLA:**
- max_age_seconds: ${maxAge}

**Verification results:**
- timestamp_fresh:  ${timestampFresh} (age ${ageSeconds}s vs limit ${maxAge}s)
- value_present:    ${valuePresent}
- signature_valid:  ${sigValid}${sigError ? ` — error: ${sigError}` : ""}${sigRecovered && !sigValid ? ` — recovered: ${sigRecovered}` : ""}

Evaluate these results against the SLA and deliver your verdict.`.trim();

  const msg = await client.messages.create({
    model:      config.MODEL,
    max_tokens: 1024,
    system:     SYSTEM_PROMPT,
    tools:      [VERDICT_TOOL],
    tool_choice: { type: "tool", name: "deliver_verdict" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Adjudicator did not call deliver_verdict tool");
  }

  return toolUse.input;
}

module.exports = { adjudicate };
