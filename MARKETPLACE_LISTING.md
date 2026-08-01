# Circle Agent Marketplace — Listing Package (Phase 7.4, post-submission)

**Status: prepared, NOT submitted.** Two real blockers, both explained below
rather than papered over. Do not treat this file as proof of an active
marketplace listing — it's the submission package, ready to send once the
blockers clear.

## Research: how listing actually works (checked, not assumed)

Circle Agent Marketplace (`agents.circle.com`) has **no self-serve
publish API or CLI command**. `circle services` only covers the buyer/
discovery side (`search`, `inspect`, `pay`) — confirmed via
`circle services --help`, which lists exactly those three verbs and
nothing seller-facing. Circle's own `circlefin/skills` repo's
`accept-agent-payments` skill explicitly warns against assuming otherwise:
*"There may not be a self-serve publish command. Treat marketplace
listing as a submission package unless current docs expose a registry
API."* Confirmed live on `agents.circle.com/services`: the seller
call-to-action ("Your API is a storefront" → "Accept USDC from agents")
links to a Google Form intake, not an API:
**https://forms.gle/7YFzvdmMcn1JH5tF6**

The exact machine-readable schema below was reverse-engineered from real
live listings, not guessed — pulled via `circle services search --output
json` (792 total listings at the time of writing) and cross-checked
against `circle services inspect <url>` on one of them (Allium's price
endpoint, the closest existing analog to arcid2's oracle).

## Positioning decision (per the scoping doc's own recommendation)

The literal invocable thing is a price-feed endpoint — accurate but
undersells it. Framing the *description* around the actual pitch instead:
arcid2 is a bonded, TEE-attested, LLM-adjudicated trust layer; the price
feed is (per the Phase 6 design doc's own words) "merely the simplest
demonstration," not the product. The listing below carries that framing
in `provider.description`, while every field an agent would actually
invoke (`resource`, `input`, `price`) stays accurate to the concrete
oracle endpoint — no field is padded or fabricated to sound bigger than
it is.

## The listing entry (Circle's real schema)

```json
{
  "resource": "https://9c3a144f929db3e05d05bb03839a04527bda9841-3001.dstack-pha-prod5.phala.network/api/price",
  "type": "http",
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:5042002",
      "asset": "0x3600000000000000000000000000000000000000",
      "payTo": "0xe2F7a0E6d9865C7Dc9B5D19DCc11CBcb4655c661",
      "amount": "1000",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "GatewayWalletBatched",
        "version": "1"
      }
    }
  ],
  "metadata": {
    "provider": {
      "name": "ArcID Oracle",
      "website": "https://github.com/kkoci/arcidv2",
      "docsUrl": "https://github.com/kkoci/arcidv2/blob/main/README.md",
      "description": "Signed price-feed endpoint backed by a bonded, TEE-attested, LLM-adjudicated trust layer (ArcID) — the oracle's own collateral is slashed on-chain if a consumer agent's Claude-reasoned adjudication finds a breach (stale data, bad signature, or an implausible value). The price feed is the simplest concrete demo of that trust layer, not the product itself: any x402 service could bond collateral against ArcIDBond and get the same automatic, reasoned accountability.",
      "category": "FINANCIAL_ANALYSIS",
      "tags": ["x402", "oracle", "price-feed", "arc", "tee", "bonded-reputation", "circle-gateway"]
    },
    "path": "/api/price",
    "method": "GET",
    "description": "Returns a signed price value with timestamp and an SLA (max_age_seconds). Response: {value, timestamp, oracle, signature, sla}. Payment is verified/settled via Circle Gateway (createGatewayMiddleware) — see arcidv2's Phase 7.3 CHANGELOG entry for confirmation this uses the same BatchFacilitatorClient.verify()/settle() as Circle's reference Nanopayments implementation.",
    "mimeType": "application/json",
    "output": {
      "type": "object",
      "properties": {
        "value": { "type": "string", "description": "Price value, or null under the 'null' fault mode (demo only)" },
        "timestamp": { "type": "integer" },
        "oracle": { "type": "string", "description": "Oracle's TEE-registered wallet address" },
        "signature": { "type": "string" },
        "sla": { "type": "object", "properties": { "max_age_seconds": { "type": "integer" } } }
      }
    },
    "supportsVanillax402": true,
    "supportsCircleGateway": true
  }
}
```

## Additional fields the intake form asks for (per `accept-agent-payments`)

| Field | Value |
|---|---|
| Provider / service name | ArcID Oracle |
| Public base URL | `https://9c3a144f929db3e05d05bb03839a04527bda9841-3001.dstack-pha-prod5.phala.network` — **currently unreachable, see blocker below** |
| Endpoint path | `GET /api/price` |
| Price | $0.001 USDC per call |
| Payment options | Circle Gateway (x402, batched, gasless) on Arc Testnet |
| Category | FINANCIAL_ANALYSIS (matches the closest existing listing, Allium's price endpoint) |
| Health check | `GET /health` |
| Support / contact | `https://github.com/kkoci/arcidv2/issues` |
| 402/200 evidence | Unpaid `GET /api/price` → `402` with a `PAYMENT-REQUIRED`-shaped body (dev mode: legacy `x402Version:1` shape — see `oracle/src/index.js`'s `devX402Middleware`; prod mode via `createGatewayMiddleware`). Paid call → `200` with the JSON body documented above. Both demonstrated locally (`npm test`-adjacent manual curl, not yet against the public URL — see blocker). |

## Blockers — why this is a package, not a live listing

1. **The oracle isn't currently publicly reachable.** Re-verified directly
   this session, not from a stale note: `curl` against the documented
   Phala CVM URL times out (SSL connect failure, `http_code=000`) on both
   `/health` and `/api/price`. The marketplace intake explicitly wants a
   public base URL and a health-check endpoint — neither can be
   demonstrated against a dead deployment. Per `CLAUDE.md`'s Phala
   redeploy steps: `docker build` → push → update the CVM image → update
   `frontend/vercel.json`'s rewrite URL. Not done as part of this phase —
   redeploying infrastructure is a bigger, riskier action than documenting
   a listing package, and wasn't asked for here.
2. **Actually submitting the Google Form is an external, identity-linked
   action** (a real submission to Circle, presumably reviewed by a human
   there, under this project's name) — left for a deliberate decision
   rather than done automatically. Once the oracle is redeployed and
   reachable, submit the form using the values above.
