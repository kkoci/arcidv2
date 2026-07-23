# ArcID v2 — Bonded Agent Reputation for Nanopayment Networks

**Lepton Agents Hackathon · Canteen × Circle × Arc**

> Agents post a bond to register with ArcID. A consumer agent *reasons* — using Claude — whether the provider delivered. On a confirmed breach, the bond slashes automatically and pays the consumer. **Reputation is capital at risk, not a score.**

Addresses Lepton's **Prior Art #8** (bonded agent reputation) and **RFB 3** (agent-to-agent nanopayment networks). The trust layer Prior Art #8 called "nearly empty" — this fills it.

---

## Live Proof — Real Slash on Arc Testnet

The complete loop ran end-to-end on Arc testnet on 2026-06-27:

**Slash tx:** [`0xf76fabf96bc7254cca57b41875cf5cf202aa9ae0e44db541297f9b99df8276b6`](https://testnet.arcscan.app/tx/0xf76fabf96bc7254cca57b41875cf5cf202aa9ae0e44db541297f9b99df8276b6)  
**Block:** 48910669 · Chain: Arc testnet (5042002)

**Fault:** `bad-sig` — oracle returned a signature with a non-canonical `s` component (`0xcdcdcd...`).

**Claude's adjudication, written verbatim to the `AgentSlashed` event on-chain:**

> The `s` component (`0xcdcdcd...`) is non-canonical — it falls in the upper half of the secp256k1 curve order. EIP-2 mandates that valid signatures must use the low-s form. This is not a transient network glitch or an ambiguous failure — it is a deterministic, attributable cryptographic defect in the signature produced by the oracle. The oracle is demonstrably live (fresh timestamp, valid value), so this is not a crash or transient outage. Because the signature fails to recover to the oracle's registered wallet (`0xe2F7a0E6d9865C7Dc9B5D19DCc11CBcb4655c661`), the oracle **cannot prove authorship** of this response. The failure is fully attributable to the oracle provider. **Verdict: breach. Slashing is justified.**

**Before / after:**

| | Before | After |
|--|--------|-------|
| Oracle bond (`0xe2F7a0E6...`) | 3.00 USDC · active | 3.00 USDC · **slashed** |
| ArcIDBond contract balance | 13.00 USDC | 10.00 USDC |
| Consumer wallet (`0x8F43C6a0...`) | 0.92 USDC | 3.92 USDC (+3.00 received) |

---

## The Moat

Three properties stacked. No competitor, including AOZ, has all three:

| Property | What it means |
|----------|---------------|
| **TEE-gated identity** | Only wallets with DCAP attestation in ArcIDRegistryV2 can post a bond. An unverified wallet reverts on-chain with `"Agent not TEE-verified in ArcID registry"`. A wrong answer is cryptographically attributable to a real, specific agent. |
| **USYC yield-bearing collateral** | Bond collateral is USYC — Hashnote's tokenized T-bill fund on Arc. It earns ~4.9% APY while staked. Capital at risk that isn't idle capital. |
| **LLM-reasoned adjudication** | The consumer agent reasons about *why* a failure is a breach vs a blip, and writes a rationale that goes on-chain in the `AgentSlashed` event. Not a cron job. |

> AOZ has "bond + slash." ArcID has **TEE-gated identity + USYC yield + written LLM rationale on-chain.**

---

## Circle Stack

The oracle's payment path is wired to Circle's real infrastructure, not a mocked stand-in:

| Component | What's used |
|---|---|
| **x402 protocol** | `GET /api/price` is x402-gated — an unpaid call gets a real `402 Payment Required` with signed payment requirements, not a stubbed error. |
| **Circle Gateway Nanopayments** | `@circle-fin/x402-batching`'s `createGatewayMiddleware()` wraps the endpoint; payments are verified and settled (batched) by Circle's live testnet facilitator (`gateway-api-testnet.circle.com`). |
| **Arc Testnet** | Chain ID `5042002` — Circle's own Arc network (`eip155:5042002` in Gateway's supported-networks list), using the same USDC precompile (`0x3600...0000`) as `ArcIDBond.sol`. |
| **Seller Wallet** | The oracle's wallet (`0xe2F7a0E6d9865C7Dc9B5D19DCc11CBcb4655c661`) is the Gateway seller — receives $0.001 USDC per call, checkable live via `GET /api/gateway-balance`. |

The frontend's "Circle Gateway Nanopayment" card pays for one real `/api/price` call and shows the seller's Gateway balance before → after.

---

## Quick Start (3 terminals)

```bash
# 1 — Oracle (x402-gated, signs responses, serves fault modes)
cd oracle && npm install && npm start          # http://localhost:3001

# 2 — Consumer agent (pays oracle, adjudicates, slashes on breach)
cd consumer && npm install && npm start        # runs continuously

# 3 — Dashboard (live traction strip, fault injection, verdict feed)
cd frontend && npm install && npm run dev      # http://localhost:5174
```

**Trigger a fault live (dashboard → AgentCard → "stale"):**
Consumer detects breach within ~12s, Claude writes the rationale, slash fires.

```bash
# Contracts (50 tests, no external RPC)
npm test
npm run deploy:standalone:local   # deploy DCAPVerifier + ArcIDRegistryV2 + ArcIDBond,
                                  # generate DCAP quote, register + bond in one command
npm run gating:local              # proof-of-gating revert output
```

---

## CLI Reference

All commands read contract addresses from `deployments/arcTestnet_standalone.json`
(written by `npm run deploy:standalone`). Add `--network hardhat` to target a local
Hardhat node instead. All commands default to Arc testnet.

### Register a new agent

```bash
npm run agent:register -- --key <private-key>
```

Builds a fresh DCAP attestation quote for the given wallet, calls
`ArcIDRegistryV2.registerAgent()`, and prints the resulting `agentId`. Idempotent —
re-running with the same key prints the existing ID and exits.

```
→ Registering 0x71bE...abc on arcTestnet
  ArcIDRegistryV2: 0x...

→ Building DCAP attestation quote for 0x71bE...abc...
  reportData: 0xdeadbeef...

✓ registerAgent() mined → 0xabc123...
  agentId:   0xbeefdead...
  tx block:  14209543
```

### Post a bond

```bash
npm run bond:post -- --key <private-key> [--amount 5.0]
```

Requires the wallet to already be registered. Approves USDC, calls `postBond()`,
and prints the resulting bond status. `--amount` is in whole USDC (default: 5.0).

```
→ Posting 5.0 USDC bond from 0x71bE...abc on arcTestnet
  agentId: 0xbeefdead... ✓

→ Approving 5.0 USDC...
→ Calling postBond(5000000)...

✓ postBond() mined → 0xdef456...
  amount:    5.00 USDC
  posted at: 2026-06-26 11:04:12 UTC
  active:    true
```

### Check agent/bond status

```bash
npm run agent:status -- --address <wallet-address>
```

Read-only. No private key required.

```
→ Status for 0x71bE...abc on arcTestnet

  Registry  0x...
  registered:  yes ✓
  agentId:     0xbeefdead...

  Bond      0x...
  status:      active ✓
  amount:      5.00 USDC
  posted at:   2026-06-26 11:04:12 UTC
```

### List all registered agents

```bash
npm run agent:list
```

Queries `AgentRegistered` events from the deployment block forward and cross-references
bond status for each address. Read-only. Add `--from-block <n>` if the RPC limits query range.

```
→ Listing agents on arcTestnet (from block 14209540)

  #     Address                                       AgentId (prefix)        Bonded    Amount
  ────  ────────────────────────────────────────────  ──────────────────────  ────────  ────────────
  1     0x71bE...abc                                  0xbeefdead...           yes ✓     5.00 USDC
  2     0xF3a9...12c                                  0xdeadbeef...           slashed   10.00 USDC

  Total: 2 agents
```

### Trigger a slash (demo / testing)

```bash
npm run bond:slash -- \
  --key <slasher-private-key> \
  --agent <agent-address> \
  --consumer <consumer-address> \
  --reason "Stale data: response was 90s past the 30s SLA window"
```

Caller must be the `authorizedSlasher` on `ArcIDBond`. The `--reason` string goes
on-chain verbatim in the `AgentSlashed` event, same as the consumer agent's LLM rationale.

```
→ Slashing agent 0x71bE...abc on arcTestnet
  Bond amount: 5.00 USDC
  Reason:      "Stale data: response was 90s past the 30s SLA window"

✓ slash() mined → 0xabc999...
  5.00 USDC transferred to consumer 0xF3a9...12c
```

### Proof-of-gating check

```bash
npm run gating:check -- --key <private-key>
```

If the wallet is **not** registered: performs a `staticCall` to `postBond()` (zero gas
cost) and confirms the exact revert message. If **registered**: reports its `agentId`.

```
→ Gating check for 0xRand...om on arcTestnet

  Wallet is NOT registered — confirming gating revert via staticCall...

  ✓ GATING CONFIRMED
    Revert: "Agent not TEE-verified in ArcID registry"

    To register:  npm run agent:register -- --key 0x... --network arcTestnet
```

---

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│              DCAPVerifier (on-chain, Arc testnet)         │
│   verify(quote, sig) → (ok, {mrtd, reportData, signer})  │
│   Checks TDX v4 header + ecrecover on report_data sig     │
└─────────────────────┬────────────────────────────────────┘
                      │ verification
┌─────────────────────▼────────────────────────────────────┐
│                  ArcIDRegistryV2 (native)                 │
│   registerAgent(dcapQuote, sig) → on-chain registration   │
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

## Trust Boundary — TEE Attestation vs. Payment Settlement

This is an explicit statement of a split that already exists in the code, written
down so it reads as an intentional design decision rather than an omission once
payment execution (below) is built on top of it.

**What actually runs inside the TDX enclave:** exactly one thing — proving that a
given wallet key belongs to code running inside a genuine TDX CVM with a specific
measured code identity (`mrtd`). That's `GET /api/attest` in `oracle/src/attest.js`:
when `USE_REAL_PHALA=true` it calls the Phala dstack guest agent over its Unix
socket to produce a real hardware-backed DCAP quote; the resulting quote is what
`ArcIDRegistryV2.registerAgent()` verifies on-chain via `DCAPVerifier`. This is the
entire hardware root of trust in the system.

**What runs outside it, as ordinary application code:**
- **Price signing** (`GET /api/price`) — the oracle signs `(value, timestamp)` with
  the same wallet key, but the signing call itself isn't re-attested per request.
  Trust here is *transitive*: the wallet was proven TEE-resident once at
  registration time, so signatures from it are attributable, not because every
  signature re-enters the enclave.
- **LLM adjudication** — Phase 3's consumer agent runs as a plain local Node
  process, never deployed to Phala. Claude's verdict reasoning has no TEE
  involvement at all.
- **x402 / Circle Gateway payments** — both `createGatewayMiddleware()`
  (oracle-side, `oracle/src/index.js`) and `GatewayClient`
  (`payForPriceViaGateway()` in `oracle/src/chain.js`, used by `/admin/demo-pay`)
  are plain ethers/Node code paths. Even the Gateway call that happens to execute
  inside the oracle's own container never touches the dstack socket — only
  `attest.js` does. This is the same "sidecar" relationship the Gateway payment
  code already has to the x402-gated route it sits next to: adjacent in the
  process, but a separate trust tier.

**Why this matters going forward:** any new payment-execution logic (settlement
calls triggered by a verdict) belongs in this second tier by construction — it
should live in the consumer agent's post-verdict handler, not inside the oracle,
and it inherits trust from the already-attested identity and the on-chain
bond/slash contract, not from any new TEE involvement of its own.

---

## Phase Status

| Phase | What | Status |
|-------|------|--------|
| 1 | `ArcIDBond.sol` — TEE-gating, slash, 27 tests | ✅ Complete |
| 2 | Oracle service — x402 nanopayment endpoint, 3 fault modes | ✅ Complete |
| 3 | Consumer agent — Claude adjudication, slash loop | ✅ Complete |
| 4 | Frontend — live traction strip, fault injection, verdict feed | ✅ Complete |
| 5 | USYC yield-bearing collateral — Teller, 13 tests, deploy scripts | ✅ Complete |
| 6 | Video script, submission form, checklist | ✅ Complete → [SUBMISSION.md](SUBMISSION.md) |
| 7 | `ArcIDRegistryV2.sol` + `DCAPVerifier.sol` — native on-chain registry with real DCAP verification; `deploy:standalone` registers + bonds in one command; 10 new tests | ✅ Complete |

**Test suite:** 50 passing (`npm test`) — no external RPC, no `.env` required.

---

## Phase 5 — What Was Built

### USYC yield-bearing collateral

The Circle-specific moat: **`ArcIDBond.sol` already supports any ERC-20** — the same contract deployed with the USYC token address gives you yield-bearing bonds. No new contract code.

**What was built:**

| Artifact | Description |
|----------|-------------|
| `contracts/mocks/MockUSYC.sol` | 8-decimal yield-bearing mock; `simulateYield(bps)` advances share price |
| `contracts/interfaces/ITeller.sol` | Interface for Arc testnet Teller (`deposit` / `redeem` / `sharePrice`) |
| `test/ArcIDBondUSYC.test.js` | 13 tests telling the yield story end-to-end |
| `scripts/deploy_usyc.js` | Deploy ArcIDBond with USYC; handles allowlist absence gracefully |
| `scripts/mint_usyc.js` | Mint USYC from USDC via Teller on Arc testnet |
| `frontend/src/components/USYCBondCard.jsx` | Purple "yield-bearing" card with narrative + deployed contract address |

**Test suite highlights (`npm test` — 50 passing total):**

```
USYC bond face value is $5.00 USDC at deposit time (sharePrice = $1.00)
bond value increases as USYC share price accrues yield
  → 5 USYC * $1.005 = $5.025 after 50 bps yield
491 bps (~4.9% APY) yields the correct appreciated bond value
consumer's USYC is worth more than the original $5.00 bond face value
  → 5 USYC * $1.02 = $5.10 after 200 bps while bonded
agent receives USYC back on withdrawal (yield value is captured on Teller redeem)
two USYC bonds coexist; yield accrues on both
```

**The narrative the tests prove:**
> Bond earns T-bill yield (~4.9% APY) while at stake. On a confirmed breach, the consumer receives USYC that has already appreciated — more than face value. **Capital at risk that isn't idle capital.**

**Deploy to Arc testnet:**
```bash
# Step 1 — get USYC (requires Circle allowlist)
npm run mint:usyc:arc

# Step 2 — deploy ArcIDBond with USYC collateral
npm run deploy:usyc:arc
# → handles allowlist-absent case: still deploys + prints contract address
```

**USYC addresses on Arc testnet:**

| Contract | Address |
|----------|---------|
| USYC token | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| Teller (mint/redeem) | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` |

**If allowlist hasn't arrived:** `deploy:usyc:arc` still deploys the contract. Judges can inspect the code and TEE-gating at the deployed address. The bond is posted once allowlist access is confirmed.

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
{"cycle":1,"verdict":"breach","reason":"...LLM rationale...","checks":{"timestamp_fresh":false,"value_present":true,"signature_valid":true},"payment_usdc":0.001,"slash_tx":"0xf76fabf9..."}
```
Every line is traction data: cycle count, payment volume, slash count, LLM rationale, on-chain tx hash.

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

**x402 in production:** set `DEV_MODE=false` in `.env` — the service uses `@circle-fin/x402-batching`'s `createGatewayMiddleware()` to verify and settle real USDC payments via Circle Gateway's live testnet facilitator. `DEV_MODE=true` (default) accepts any `X-Payment` header for local testing.

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

| Contract | Address |
|----------|---------|
| DCAPVerifier | `0xBB2835fC4d189340a98084A50DD0B36b4Ff50Ca2` |
| ArcIDRegistryV2 | `0xf1ad81B9FcB805BB75f3c92B5Db67641B7C729C9` |
| ArcIDBond (USDC collateral) | `0xE4860b98AFace0166dD323D0E0b12e680d61D59c` |
| ArcIDBond (USYC collateral) | _(run `npm run deploy:usyc:arc`)_ |
| USDC (Arc testnet) | `0x3600000000000000000000000000000000000000` |
| USYC token | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| USYC Teller (mint/redeem) | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` |

**Registered & bonded agents (Arc testnet, live state):**

| Address | Bond | Status |
|---------|------|--------|
| `0x8F43C6a0062D33585d97A54d7f380bc6D52B5440` | 5.00 USDC | Active ✓ |
| `0xEF5adE59183CAd6A2dDC896BE7f8bE58eDf5f993` | 5.00 USDC | Active ✓ |
| `0xe2F7a0E6d9865C7Dc9B5D19DCc11CBcb4655c661` | 3.00 USDC | **Slashed** → [tx](https://testnet.arcscan.app/tx/0xf76fabf96bc7254cca57b41875cf5cf202aa9ae0e44db541297f9b99df8276b6) |

---

## Development

### Prerequisites

- Node.js ≥ 18
- An Arc testnet wallet funded with USDC ([faucet.circle.com](https://faucet.circle.com/))
- Set `DEPLOYER_PRIVATE_KEY` in `.env` (used for transactions and DCAP quote signing)

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
npm run deploy:standalone:local
```

Deploys `DCAPVerifier` + `ArcIDRegistryV2` + `MockUSDC` + `ArcIDBond`, generates a
prototype DCAP quote, registers the deployer on-chain, posts a 5 USDC bond, and
confirms the gating revert — all in ~5 seconds, no external RPC or `.env` required.

### Deploy to Arc testnet

1. Copy `.env.example` to `.env` and fill in `DEPLOYER_PRIVATE_KEY`.
2. Run:

```bash
npm run deploy:standalone
```

This deploys `ArcIDRegistryV2` (pointing at the live `DCAPVerifier`), generates a
structurally valid TDX quote signed by your wallet, registers it on-chain, deploys
`ArcIDBond`, and posts a bond — fully self-contained, single command.

### Proof-of-gating screenshot

```bash
npm run gating:arc
# → prints "Agent not TEE-verified in ArcID registry" revert for a random wallet
```

---

## Contract Reference

### `ArcIDRegistryV2.sol`

```solidity
constructor(address _dcapVerifier)
```

| Function | Description |
|----------|-------------|
| `registerAgent(bytes dcapQuote, bytes reportDataSig)` | Submit a TDX DCAP v4 quote + 65-byte sig. Calls the on-chain verifier; reverts if the quote fails or if `ecrecover(reportData, sig) ≠ msg.sender`. On success writes `agentIdBySigner[msg.sender] = keccak256(mrtd, reportData, signer)`. |
| `agentIdBySigner(address)` | Returns the agent's `bytes32` id, or `bytes32(0)` if unregistered. Read by `ArcIDBond.sol` for the gating check. |

### `DCAPVerifier.sol`

```solidity
function verify(bytes calldata quote, bytes calldata reportDataSig)
    external pure returns (bool ok, QuoteSummary memory summary)
```

Checks TDX v4 header structure, mrtd non-zero, and `ecrecover(reportData, sig)` for a valid signer. Returns `ok = false` on any failure (no revert) so callers can gate on the bool.

### `ArcIDBond.sol`

#### Constructor

```solidity
constructor(address _collateralToken, address _registry)
```

| Param | Value (Arc testnet) |
|-------|---------------------|
| `_collateralToken` | `0x3600000000000000000000000000000000000000` (USDC) |
| `_registry` | `ArcIDRegistryV2` address (from `deploy:standalone` output) |

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
| **Agentic Sophistication (30%)** | Consumer agent uses Claude `tool_use` with forced structured output to reason about *why* a failure is a breach vs a transport blip. Three fault modes give genuinely different reasoning paths. Written rationale logged on-chain. `uncertain` verdict on ambiguous failures demonstrates restraint — the agent knows when not to slash. |
| **Traction (30%)** | DCAP-verified agents registered on-chain via `ArcIDRegistryV2`; real x402 nanopayment volume on Arc testnet; outside participants recruited. Every cycle is logged to JSONL — traction is auditable, not claimed. |
| **Circle Tool Usage (20%)** | **x402 Gateway:** oracle charges $0.001/call, consumer pays autonomously. **USYC collateral:** bond deployed with Hashnote's yield-bearing token; Teller integration for USDC→USYC mint. Both used together. |
| **Innovation (20%)** | First system where TEE-attested identity gates the bond *before* stake (not stake as identity), and where bond collateral earns T-bill yield while at risk. No adjacent project has both properties. |

---

## Phala Cloud Deployment (oracle TDX)

The oracle service is containerized and ready to deploy to a Phala TDX CVM, producing a **real Intel TDX quote** from `/api/attest` instead of a self-signed prototype.

### How it works

`GET /api/attest` is a new endpoint on the oracle. When `USE_REAL_PHALA=true`:
1. Computes `report_data = keccak256(oracle_wallet_address)` (32 bytes)
2. Signs it raw with the oracle private key (no EIP-191, matching `DCAPVerifier._recover()`)
3. Calls the Phala dstack guest agent via `@phala/dstack-sdk`'s `DstackClient`, which connects over
   the agent's Unix domain socket — **not** TCP/HTTP. The socket must be volume-mounted into the
   container (see `oracle/docker-compose.phala.yml`); the agent isn't reachable at any address
   otherwise, regardless of `127.0.0.1` vs. the container's host.
4. Returns `{ quote, report_data, report_data_sig, attested_signer, mrtd, real_tdx: true }`

When `USE_REAL_PHALA=false` (default, local dev), the same endpoint returns a structurally-valid TDX v4 prototype quote — same format, self-signed, passes `DCAPVerifier` on-chain.

### Files

| File | Purpose |
|------|---------|
| `oracle/Dockerfile` | Node 18 alpine, `linux/amd64`, exposes port 3001 |
| `oracle/src/attest.js` | Attestation logic — real Phala path (dstack Unix socket via `@phala/dstack-sdk`) + prototype fallback |
| `oracle/.env.example` | Documents `USE_REAL_PHALA` |

### Build & deploy commands

```bash
# 1. Build for linux/amd64
docker build --platform linux/amd64 -t kkoci/arcid2-oracle:latest oracle/

# 2. Push to Docker Hub
docker push kkoci/arcid2-oracle:latest

# 3. Deploy to Phala Cloud
#    Dashboard: https://cloud.phala.network/dashboard/cvm
#    → "Deploy CVM" → Docker image: kkoci/arcid2-oracle:latest
#    → Port mapping: 3001
#    → Environment variables (from oracle/.env, plus):
#         USE_REAL_PHALA=true
#         PORT=3001
#    → Compose must volume-mount the dstack guest agent's Unix socket (see
#      oracle/docker-compose.phala.yml) — it's not reachable over TCP/HTTP
```

### After deploy

```bash
# CVM URL format: https://<hash>-3001.dstack-pha-prod5.phala.network/
# Smoke test — confirm real quote comes back:
curl https://<cvm-hash>-3001.dstack-pha-prod5.phala.network/api/attest | jq .real_tdx

# Expected: true
# The quote field is a hex-encoded TDX DCAP v4 quote (≥592 bytes).
# Pass it to ArcIDRegistryV2.registerAgent() along with report_data_sig.
```

---

## Future Work

- **Decentralized multi-slasher:** dispute window + N-of-M slasher quorum (intentionally out of scope for hackathon cadence)
- **Broker agent:** chooses which bonded provider to route to based on bond size + slash record (Phase 3 stretch)
- **USYC redemption flow:** yield tracking per bond via Teller

---

## Links

- Live frontend: [frontend-five-eta-43.vercel.app](https://frontend-five-eta-43.vercel.app)
- Arc testnet explorer: [testnet.arcscan.app](https://testnet.arcscan.app)
- Lepton submission: [forms.gle/SMqLaw2pMGDe58LFA](https://forms.gle/SMqLaw2pMGDe58LFA)
