# ArcID v2 — Bonded Agent Reputation for Nanopayment Networks

**Lepton Agents Hackathon · Canteen × Circle × Arc**

> Agents post a USDC bond to register with ArcID. They sell a service via x402 nanopayments. A consumer *agent reasons about whether the service was actually delivered* — and if it underdelivers, the bond slashes automatically and pays the consumer. Reputation becomes capital at risk, not a score you ask to be trusted.

Maps to Lepton's own **Prior Art #8** and **RFB 3 (Agent-to-Agent Nanopayment Networks)**.

---

## The Moat

Three properties stacked — no competitor has all three:

| Property | What it means |
|----------|---------------|
| **TEE-gated identity** | Only wallets registered in ArcIDRegistry (with a real DCAP attestation) can post a bond. An unverified wallet literally cannot participate. A wrong answer is cryptographically attributable to a specific verified agent. |
| **USYC yield-bearing collateral** | Bond collateral earns yield while it sits at stake — capital at risk that isn't idle capital. Unique Circle differentiator. (Phase 5) |
| **Live registry with real agents** | 17+ verified agents already on-chain. The trust layer isn't theoretical — it's running. |

The closest adjacent project is **AOZ** (oath-based on-chain stake → slash). "Bond + slash" alone is not the moat — AOZ has it. The moat is the combination above.

---

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                   ArcIDRegistry (existing)                │
│   TEE-attested agents registered with DCAP quotes         │
│   agentIdBySigner[wallet] → bytes32 agentId               │
└─────────────────────┬────────────────────────────────────┘
                      │ gating check
┌─────────────────────▼────────────────────────────────────┐
│                   ArcIDBond (Phase 1)                     │
│   postBond(amount)   → reverts for unverified wallets     │
│   slash(agent, consumer, reason) → transfers bond         │
│   isActiveBondedAgent(addr) → bool                        │
│   Events: BondPosted · AgentSlashed · BondWithdrawn       │
└─────────────────────┬────────────────────────────────────┘
                      │ x402 nanopayments
┌─────────────────────▼────────────────────────────────────┐
│              Oracle Service (Phase 2)                     │
│   GET /api/price — $0.001 via Gateway nanopayments        │
│   Response: {value, timestamp, signature}                  │
│   Fault modes: stale / null / bad-sig (for demo)          │
└─────────────────────┬────────────────────────────────────┘
                      │ LLM adjudication
┌─────────────────────▼────────────────────────────────────┐
│           Consumer Agent (Phase 3) ⭐                      │
│   Calls oracle → pays x402 → verifies signature           │
│   LLM judge: did the provider meet its SLA?               │
│   Verdict: {verdict: "breach", reason: "47s stale..."}    │
│   On breach → slash() → proceeds to consumer wallet       │
└──────────────────────────────────────────────────────────┘
```

---

## Phase Status

| Phase | What | Status |
|-------|------|--------|
| 1 | `ArcIDBond.sol` deployed and verified on Arc testnet | ✅ Complete |
| 2 | Oracle service — x402 nanopayment-gated HTTP endpoint | ✅ Complete |
| 3 | Consumer agent — LLM-reasoned adjudication loop | ✅ Complete |
| 4 | Frontend dashboard — live traction strip, fault injection, verdict feed | ✅ Complete |
| 5 | USYC yield-bearing collateral (core differentiator) | 🔜 Pending |
| 6 | Video, writeup, submission | 🔜 Pending |

---

## Phase 4 — What Was Built

### Frontend dashboard (`frontend/`)

A live React dashboard (Vite 5, port 5174) that visualises system health in real-time without any manual curl commands — the single-pane-of-glass for a hackathon demo.

**Five-panel layout:**

| Panel | What it shows |
|-------|---------------|
| **Traction strip** | Bonded agents · Total calls · Volume (USDC) · OK verdicts · Slash events |
| **Agent card** | Oracle wallet address · active/slashed badge · collateral · fault-injection buttons |
| **Fault controls** | One-click `stale / null / bad-sig` buttons calling `POST /admin/fault` — viewer can watch slash appear live |
| **System info** | Chain, protocol, TEE gate, adjudicator, consumer wallet |
| **Verdict feed** | Scrolling history of every Claude adjudication: badge (ok/breach/uncertain), three check marks, LLM rationale, payment amount, age |

The dashboard polls `/api/stats` and `/api/verdicts` every 5 seconds and shows a live/disconnected indicator. All API calls are proxied through Vite to the oracle (no CORS in production build).

**Start:**
```bash
cd frontend
npm install
npm run dev   # http://localhost:5174
```

**Oracle API extensions (added for Phase 4):**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/stats` | Traction counters + oracle/consumer addresses |
| `GET /api/verdicts` | Last 50 adjudications (newest first) |
| `POST /api/verdicts` | Consumer agent pushes verdict after each cycle |
| `POST /admin/fault` | Set fault mode (`stale` / `null` / `bad-sig`) |
| `POST /admin/fault/reset` | Clear fault mode |

Consumer agent now sends `consumer` address in every verdict POST so the dashboard can surface it.

---

## Phase 3 — What Was Built

### Consumer agent (`consumer/`)

An autonomous loop that pays for oracle data, verifies it, and lets Claude reason about whether the provider delivered — then slashes on a confirmed breach.

**Adjudication results (live-tested):**

| Fault mode | Age | Sig | Value | Claude's verdict | Slash? |
|-----------|-----|-----|-------|-----------------|--------|
| none (healthy) | 0s | ✓ | ✓ | **ok** — "No SLA violations. No slashing warranted." | No |
| `stale` | 90s | ✓ | ✓ | **breach** — "Oracle is provably live yet served data 3× past the SLA. Signed and attributable → slashable." | Yes |
| `null` | 0s | null | null | **uncertain** — "Single isolated null; timestamp is fresh so oracle is live. Benefit of the doubt on Cycle 1." | No |
| `bad-sig` | 0s | ✗ | ✓ | **breach** — "Non-canonical s value is a deterministic signing failure, not a network blip. Authorship cannot be proven." | Yes |

The `uncertain` verdict on `null` demonstrates **adjudicator restraint** — the agent correctly refuses to slash on ambiguous failures. This is explicitly part of the agency story.

**Run locally (oracle must be running first):**

```bash
# Terminal 1
cd oracle && npm start

# Terminal 2 — normal loop
cd consumer && npm start

# Single cycles for each fault mode
npm run fault:stale
npm run fault:null
npm run fault:bad-sig
```

**Log format** (`consumer/logs/*.jsonl`):
```json
{"cycle":1,"verdict":"breach","reason":"...LLM rationale...","checks":{"timestamp_fresh":false,"value_present":true,"signature_valid":true},"payment_usdc":0.001,"slash_simulated":true}
```
Every line is traction data: cycle count, payment volume, slash count, LLM rationale.

**To slash on-chain:** set `DEV_MODE=false` in `consumer/.env` and point `ARC_RPC_URL` + `BOND_CONTRACT_ADDRESS` at the deployed ArcIDBond.

---

## Phase 2 — What Was Built

### Oracle service (`oracle/`)

A nanopayment-gated Express service that signs every response with the oracle agent's registered wallet. Three distinct fault modes let Phase 3's consumer agent *reason* about different breach types.

**Response format:**
```json
{
  "value":     "3450.12",
  "timestamp": 1782416932,
  "oracle":    "0xe2F7a0E...",
  "signature": "0xfd7363...",
  "sla":       { "max_age_seconds": 30 }
}
```

**Signature:** `sign(keccak256(abi.encodePacked(string(value), uint256(timestamp))))` — consumer verifies with `ethers.verifyMessage`. Wrong answers are attributable to the oracle's TEE-registered wallet.

**Fault modes** (distinct inputs to Phase 3's LLM reasoner):

| Mode | What happens | Phase 3 verdict |
|------|-------------|-----------------|
| `?fault=stale` | Timestamp 90s old, valid signature | "Provider live but serving stale data → slashable" |
| `?fault=null` | `value: null`, `signature: null` | "Malformed response — crash or intentional? Check if recurring" |
| `?fault=bad-sig` | Valid value + timestamp, corrupted signature | "Cannot verify authorship → slashable" |

**Start locally:**
```bash
cd oracle
cp .env.example .env   # fill in ORACLE_PRIVATE_KEY + ORACLE_WALLET_ADDRESS
npm install
npm start              # port 3001
```

**Test with curl:**
```bash
# 402 without payment
curl http://localhost:3001/api/price

# 200 with dev payment header
curl -H "X-Payment: dev" http://localhost:3001/api/price

# Fault modes
curl -H "X-Payment: dev" "http://localhost:3001/api/price?fault=stale"
curl -H "X-Payment: dev" "http://localhost:3001/api/price?fault=null"
curl -H "X-Payment: dev" "http://localhost:3001/api/price?fault=bad-sig"
```

**x402 in production:** set `DEV_MODE=false` in `.env` — the service uses `x402-express` with Circle's facilitator to verify real USDC payments. `DEV_MODE=true` (default) accepts any `X-Payment` header for local testing.

---

## Phase 1 — What Was Built

### `ArcIDBond.sol`

- **TEE-gating:** `postBond()` calls `registry.agentIdBySigner(msg.sender)` — reverts with `"Agent not TEE-verified in ArcID registry"` for unverified wallets. This is the proof-of-gating screenshot.
- **Bond collateral:** fixed ERC-20 at deploy (USDC for Phase 1, USYC for Phase 5 — same contract, different constructor arg).
- **Slash:** `authorizedSlasher` (initially deployer / consumer wallet) calls `slash(agent, consumer, reason)`. The `reason` field holds the LLM-authored rationale from Phase 3's adjudication agent — logged on-chain in the `AgentSlashed` event.
- **Events for live counters:** `BondPosted`, `AgentSlashed`, `BondWithdrawn` — the frontend reads these for TVL, nanopayment count, and slash history.

### Test suite (27 passing)

```
postBond     → success for verified agent
             → gating revert: "Agent not TEE-verified in ArcID registry"
             → ZeroAmount error
             → BondAlreadyActive error
             → allows re-bond after slash
slash        → transfers full bond to consumer
             → emits AgentSlashed with LLM rationale
             → NotAuthorizedSlasher error
             → NoBondFound error
             → AlreadySlashed error
withdrawBond → returns bond to agent
             → emits BondWithdrawn
             → NoBondFound / AlreadySlashed errors
views        → isActiveBondedAgent correct across lifecycle
admin        → setAuthorizedSlasher (owner only, emits SlasherUpdated)
```

---

## Deployed Addresses (Arc Testnet)

> Updated after each phase deploy. See `deployments/arcTestnet.json` for full output.

| Contract | Address |
|----------|---------|
| ArcIDBond | TBD — deploy Phase 1 |
| Collateral (USDC) | `0x3600000000000000000000000000000000000000` |
| ArcIDRegistry | TBD — from Phase 0 |

---

## Development

### Prerequisites

- Node.js ≥ 18
- An Arc testnet wallet funded with USDC ([faucet.circle.com](https://faucet.circle.com/))
- The wallet must be TEE-registered in ArcIDRegistry

### Install

```bash
cd arcid2
npm install
```

### Compile

```bash
npm run compile
```

### Test

```bash
npm test
# or for verbose output:
npx hardhat test --verbose
```

### Deploy locally (Hardhat in-memory network)

```bash
npm run deploy:local
```

This deploys `MockUSDC` + `MockRegistry` + `ArcIDBond`, posts a 5 USDC bond, and runs the gating check — all in ~3 seconds, no external RPC needed.

### Deploy to Arc testnet

1. Copy `.env.example` to `.env` and fill in your private key + contract addresses.
2. Run:

```bash
npm run deploy:arc
```

### Proof-of-gating screenshot

```bash
npm run gating:arc
# → prints "Agent not TEE-verified in ArcID registry" revert for a random wallet
```

---

## Contract Reference

### `ArcIDBond.sol`

#### Constructor

```solidity
constructor(address _collateralToken, address _registry)
```

| Param | Value (Arc testnet) |
|-------|---------------------|
| `_collateralToken` | `0x3600000000000000000000000000000000000000` (USDC) |
| `_registry` | Live ArcIDRegistry address |

#### Functions

| Function | Who | Description |
|----------|-----|-------------|
| `postBond(uint256 amount)` | TEE-verified agent | Transfers collateral to contract. Reverts for unverified wallets. |
| `slash(address agent, address consumer, string reason)` | authorizedSlasher | Transfers bond to consumer. `reason` is the LLM rationale. |
| `withdrawBond()` | Bond holder | Returns unslashed bond to agent. |
| `isActiveBondedAgent(address)` | view | True if agent has active (unslashed) bond. |
| `setAuthorizedSlasher(address)` | owner | Rotate the consumer agent wallet. |

#### Events

| Event | When |
|-------|------|
| `BondPosted(agent, amount, token)` | Successful `postBond()` |
| `AgentSlashed(agent, consumer, amount, reason)` | Successful `slash()` |
| `BondWithdrawn(agent, amount)` | Successful `withdrawBond()` |
| `SlasherUpdated(oldSlasher, newSlasher)` | `setAuthorizedSlasher()` called |

---

## Judging Alignment

| Criterion (weight) | How ArcID v2 addresses it |
|--------------------|---------------------------|
| **Agentic Sophistication (30%)** | Phase 3: consumer agent makes LLM-reasoned slash decisions with written rationale. Not a cron job — it reasons about "provider down" vs "provider lying" vs "network blip". |
| **Traction (30%)** | 17+ existing verified agents on registry; real x402 nanopayment volume; outside participants recruited from Day 0. |
| **Circle Tool Usage (20%)** | x402 Gateway nanopayments + USYC yield-bearing collateral (Phase 5). |
| **Innovation (20%)** | TEE-gated identity + yield-bearing bonds = first system where reputation collateral earns yield while staked. |

---

## Future Work

- **Decentralized multi-slasher:** dispute window + N-of-M slasher quorum (intentionally out of scope for hackathon cadence)
- **Broker agent:** chooses which bonded provider to route to based on bond size + slash record (Phase 3 stretch)
- **USYC redemption flow:** yield tracking per bond via Teller

---

## Links

- Live frontend: [arcid-jade.vercel.app](https://arcid-jade.vercel.app)
- Arc testnet explorer: [testnet.arcscan.app](https://testnet.arcscan.app)
- Lepton submission: [forms.gle/SMqLaw2pMGDe58LFA](https://forms.gle/SMqLaw2pMGDe58LFA)
