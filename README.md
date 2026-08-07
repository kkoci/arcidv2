# ArcID v2 — Bonded Agent Reputation for Nanopayment Networks

> **arcid2 is the bonded economic-security module for Arc's agentic economy:** TEE-attested agents post USDC/USYC collateral, sell via Circle Nanopayments/x402, and face tiered slashing — writing outcomes into ERC-8004 reputation and plugging into ERC-8183 evaluation.

Concretely: agents post a bond to register with ArcID. A consumer agent *reasons* — using Claude — whether the provider delivered. On a confirmed breach, the bond slashes automatically and pays the consumer. **Reputation is capital at risk, not a score.**

Addresses bonded agent reputation and agent-to-agent nanopayment networks. Arc's own agent-identity standard, **ERC-8004**, explicitly excludes bonds and slashing from its scope ("incentives and slashing... are outside the scope of this registry") — arcid2 is the module that fills exactly that gap, writing real slash/settlement outcomes back into ERC-8004's ReputationRegistry rather than competing with or replacing it.

> **Transparency note:** the submission form locked 2026-07-06. Payment
> execution on a clean verdict (real Circle Gateway settlement +
> `ArcIDBond.recordSettlement()`), session-key wallet hardening, a
> deterministic anti-injection payment gate, a spend-velocity circuit
> breaker, an attributable audit trail for every settlement attempt, a
> deterministic Tier-1 verifier ahead of LLM slash adjudication, a narrowed
> Tier-2 adjudicator jurisdiction (with deterministic enforcement, not just
> a prompt instruction), a mirrored deterministic gate in front of
> `slash()` itself, proportional breach-class slashing with epoch
> escalation (replacing full-bond-per-incident), and the full off-chain
> wiring + two live demo commands for both tiers were all added afterward,
> during the (extended, ongoing) event window — judges track commit
> activity through the end of the event, and no winner date had been
> announced at the time. See [CHANGELOG.md](CHANGELOG.md) for the full
> breakdown, commit-by-commit.
>
> **Two known gaps, flagged rather than left silent:** agent #1's re-bond
> on the redeployed `ArcIDBond` (`0x5E5eA9...`) is blocked by a persistent
> Arc testnet RPC write-rate-limit, tabled as a follow-up rather than
> forced through after repeated wait-and-retry attempts — registration,
> `transferOwnership()`, and `setAuthorizedSlasher()` all succeeded and are
> confirmed independently on-chain, only the bond itself is pending. And
> `npm run demo:semantic-breach`'s live Claude call currently fails on an
> invalid `ANTHROPIC_API_KEY` (external credential issue, not a code
> problem — the wiring downstream of it was verified separately with a
> synthetic verdict object). Neither gap reflects incomplete wiring — see
> CHANGELOG.md's Phase 5 entry for exactly what was and wasn't verified
> live, and why.

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

## Proof-of-Exploit — A Second Vertical on the Same Primitive

Post-submission (see [CHANGELOG.md](CHANGELOG.md)). arcid2's core mechanism —
an agent posts collateral, a TEE-attested verifier judges an outcome, a
confirmed breach pays out automatically on-chain — was built around one
problem: did an oracle meet its SLA, judged by Claude. This adds a second,
deliberately different problem on the *same* mechanism:

> **A TEE-attested, automated bug bounty.** A target owner registers a
> contract + invariant + bounty pool. A registered, TEE-attested verifier
> wallet runs a known exploit class against the target, checks a
> deterministic invariant, and signs a verdict. A confirmed exploit pays
> the researcher automatically.

**Why this is a different claim, not a restatement:** the price-oracle
vertical's payout decision is an LLM judgment call — Claude reasoning about
whether a response constitutes a breach. This vertical's payout decision is
**not**. "Did the invariant break" is checked by actually running the code,
yes/no, deterministically. No LLM anywhere in the payout-critical path.
TEE-attested identity is the whole differentiator here, not a supporting
detail sitting alongside an LLM the way it does in the price-oracle
vertical.

**Checked against a named competitor before committing to this, not assumed:**
AgentIndemnity — a real, existing USDC-backed performance-bond product on
Arc, priced via Circle Gateway Nanopayments — already occupies the "agent
posts bond, harmful output slashes it" category the price-oracle vertical
is in. A web search confirmed that directly rather than taking it on faith.
The same search found no live Arc/Circle product combining TEE attestation
with automated, on-chain bug-bounty payout — the closest hits were academic
proposals and conventional (human-triage, non-TEE) bounty platforms like
Immunefi/Hacken/Sherlock. Stated honestly: "no evidence found," not
"provably doesn't exist" — search coverage of a very recent hackathon
submission is never guaranteed.

### Mechanism

```
Target owner registers: contract + invariant + bounty pool (USDC)
                              │
Researcher submits a known exploit class (reentrancy, this build)
                              │
Harness runs it against a FRESH LOCAL DEPLOYMENT of the target's
bytecode (see "What's cut" below — not a fork of live on-chain state)
                              │
Deterministic invariant check: did the attacker drain more than
their own legitimate deposit? yes/no — no LLM involved
                              │
Verifier wallet (TEE-registered via the same ArcIDRegistryV2 moat
the price-oracle vertical uses) signs the verdict
                              │
ExploitBounty.submitVerdict() on-chain — confirmed exploit pays the
researcher automatically; rejected submission moves nothing
```

### What's real vs. what's explicitly cut for time

| | |
|---|---|
| **Real** | `ExploitBounty.sol` deployed and live on Arc testnet. A real reentrancy exploit runs against a fresh local deployment of a real vulnerable contract. A confirmed exploit produces a real `submitVerdict()` transaction that really pays the researcher, live-verified below. A genuinely non-vulnerable negative control (`VulnerableVaultFixed`) correctly produces zero payout — the invariant check isn't hardcoded to always confirm. The verifier wallet is really TEE-registered through the same `ArcIDRegistryV2` the price-oracle vertical uses. |
| **Cut — forking live state** | The harness runs the exploit against a **fresh local deployment** of the target's exact bytecode, not a fork of an already-deployed contract's live on-chain state. This was a deliberate decision made *before* building the harness (see the Phase 1 spike, `spike/proof-of-exploit/`), not a fallback discovered mid-build. |
| **Cut — arbitrary submissions** | The harness runs one pre-registered, known exploit class (reentrancy) against one pre-written vulnerable contract. It does not compile or execute arbitrary researcher-supplied code. |
| **Cut — real Gateway settlement on the anti-spam gate** | `bounty/server.js`'s x402 submission gate is DEV_MODE only — same dev-stub-accepts-any-header behavior the price-oracle vertical's dev mode has, not the real Circle Gateway path that vertical also has in production. |
| **Cut — persistent deployment** | The harness runs locally for the demo, same posture the consumer agent already has ("never meant to run as a persistent deployed service" — see CLAUDE.md). Not deployed to Phala. |

### Trust boundary (same doctrine as the price-oracle vertical)

Nothing new enters the TDX enclave for this vertical. The verifier
wallet's TEE-residency is proven once, separately, through the same
`GET /api/attest` flow the price-oracle wallet already uses — trust in a
verdict is transitive from that registration, not from the harness process
re-entering an enclave per submission. The exploit execution, invariant
check, and verdict signing all live in the same "transitive trust" tier
price-signing and LLM adjudication already occupy — see "Trust Boundary"
below.

### Live Proof — Real Payout on Arc Testnet

Both directions, real transactions, 2026-08-07:

| | |
|---|---|
| `ExploitBounty` | [`0x52fB6011a6FaCD0f86CC28b32cDF85Df47449A61`](https://testnet.arcscan.app/address/0x52fB6011a6FaCD0f86CC28b32cDF85Df47449A61) |
| Verifier wallet (dedicated, TEE-registered) | `0x95C80031Ec9831cD5A830AF61616CC68e6B9d671` — agentId `0xa86231d2647014006cafd9b5c5b21be8947ab06bc89e2b7ee0e1651170ff6497` |
| **Confirmed exploit → real payout** | Target 1, `VulnerableVault` at `0x53Cc93a28C839EEA98FF87abF4c7994EAe81dA6a`. `submitVerdict()`: [`0xeee331d0...`](https://testnet.arcscan.app/tx/0xeee331d0b03120421511939e23444d497bf748a9cc6920ba8de57570f0546a9f) — 2 USDC paid to the researcher for real; `claimed=true` confirmed on-chain afterward. |
| **Negative control → zero payout** | Target 2, `VulnerableVault` at `0xfeBe8b00fb6d8e7eB63E9b62340e42f407A4b4A8`. `submitVerdict()`: [`0x52d32eef...`](https://testnet.arcscan.app/tx/0x52d32eef70d0a7c3391eaefe12648df13c7312714deac04e72fac0412e48a6f8) — `exploitConfirmed=false`, zero funds moved; `claimed=false`, `bountyAmount=2.00 USDC` confirmed unchanged on-chain afterward. Also exercised live through `bounty/server.js`'s HTTP `/submit` endpoint (real CORS + x402 dev-gate, request shaped exactly like the frontend card's own fetch call). |

### Try it

```bash
# 1 — deploy ExploitBounty (points at the EXISTING ArcIDRegistryV2, never a new one)
#     also provisions + registers a dedicated verifier wallet
npm run deploy:exploit-bounty:arc

# 2 — register a bounty target (deploys a real VulnerableVault as the reference target)
TARGET_OWNER_PRIVATE_KEY=... in .env, then:
npm run bounty:register-target -- --bounty 2.0

# 3a — CLI: run the harness (exploit -> invariant check -> sign -> real submitVerdict())
BOUNTY_VERIFIER_PRIVATE_KEY=... in .env (written automatically by step 1), then:
npm run bounty:submit -- --target-id <id> --researcher 0xYourAddress
npm run bounty:submit -- --target-id <id> --researcher 0xYourAddress --mode control  # negative control

# 3b — or the HTTP server + dashboard card
npm run bounty:server                 # http://localhost:3002, x402-gated /submit
cd frontend && npm run dev            # ProofOfExploitCard talks to it directly
```

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
| **Circle Gateway Nanopayments** | `@circle-fin/x402-batching`'s `createGatewayMiddleware()` wraps the endpoint; payments are verified and settled (batched) by Circle's live testnet facilitator (`gateway-api-testnet.circle.com`). Post-submission Phase 7.3 (see CHANGELOG.md) verified this directly against Circle's reference Nanopayments implementation (`circlefin/arc-nanopayments`) — `createGatewayMiddleware().require()` and the reference's hand-rolled `withGateway()` both resolve to the identical `BatchFacilitatorClient.verify()`/`.settle()` calls under the hood. Genuine SDK parity, not a similarly-named reimplementation. |
| **Arc Testnet** | Chain ID `5042002` — Circle's own Arc network (`eip155:5042002` in Gateway's supported-networks list), using the same USDC precompile (`0x3600...0000`) as `ArcIDBond.sol`. |
| **Seller Wallet** | The oracle's wallet (`0xe2F7a0E6d9865C7Dc9B5D19DCc11CBcb4655c661`) is the Gateway seller — receives $0.001 USDC per call, checkable live via `GET /api/gateway-balance`. |
| **Circle Agent Wallets** | Post-submission Phase 7.2 (see CHANGELOG.md) — provisioned via `@circle-fin/cli` (`circle wallet login` + `circle wallet create`), scoped to USDC custody/balance-checks only. Oracle: `0x9867a0a4b7631a66b0433034a45e472023f809d6`. Consumer: `0xb84cd0e18a75dd89e6f7e2781012748f612d13c3`. **Not** used for signing — `postBond`/`slash`/`fileIndictment`/`resolveDispute` remain on the existing raw-key + `ConsumerSessionKeyGuard` path. The two wallets are on two different Circle accounts (`kristian.koci@gmail.com` for the oracle, `kristian.koci@feeltech.co.uk` for the consumer) — a CLI-driven balance check needs `circle wallet login` for whichever account owns the wallet being queried. |
| **Circle Agent Marketplace** | Post-submission Phase 7.4 (see `MARKETPLACE_LISTING.md` + CHANGELOG.md) — listing package prepared in Circle's real schema (reverse-engineered from live `circle services search --output json` listings), framed around the trust-layer pitch rather than just "price feed." **Not yet submitted** — Circle's own listing intake is a Google Form, not a self-serve API, and the Phala CVM oracle URL is currently unreachable (re-verified this session), so the required live health-check/402-evidence can't be demonstrated yet. |
| **Agent Wallet Spend Policies** | Post-submission Phase 8.4 (see CHANGELOG.md) — **undemoed on testnet by Circle's own product constraint, not an arcid2 gap**: `circle wallet limit`'s own `--help` states outright "Mainnet blockchain (required; testnets not supported)", and calling it against Arc Testnet returns `"Policy limits are only available on mainnet chains."` (re-confirmed live this phase, not assumed from Phase 7.2's memory). The intended mainnet configuration is specified below, calibrated to tell the same economic story as `ArcIDBond`'s own on-chain slash caps, not an arbitrary number. |

The frontend's "Circle Gateway Nanopayment" card pays for one real `/api/price` call and shows the seller's Gateway balance before → after.

---

## Intended Mainnet Agent Wallet Spend Policy

Post-submission, Phase 8.4 (see CHANGELOG.md). Circle's Agent Wallet spend
policies are mainnet-only by Circle's own product design — re-confirmed
live this phase (`circle wallet limit --help` states it outright; the CLI
rejects Arc Testnet with `"Policy limits are only available on mainnet
chains"`). Nothing to demo here on testnet; what follows is the exact
configuration arcid2 would apply the day it runs on a mainnet chain,
derived from numbers that already exist — not invented for this doc.

**Two rule types, not just an amount cap** (`circle wallet limit set
--rule-type ...`) — Circle's policy primitive is richer than a single
spend ceiling:

| Rule | Config | Why this number, not an arbitrary one |
|---|---|---|
| `contract-allowlist` | Restrict the wallet to `ArcIDBond`'s address only | Mirrors `ConsumerSessionKeyGuard.sol`'s existing on-chain invariant — a fixed target contract, no general-purpose `execute(target, data)` escape hatch — at the wallet-custody layer too. Defense in depth: the guard already enforces this on-chain; the wallet policy would enforce the same fact independently, so a bug in one layer isn't the only thing standing between a leaked key and an arbitrary contract call. |
| `transfer-limit` | See table below | Calibrated directly from `ArcIDBond`'s live slash-schedule constants (`hardCapBps=1000`, `semanticCapBps=100`, `semanticFeeMultiple=100`, `serviceFeeAtomic=$0.001`), not a round number picked for looks. |

**`transfer-limit` caps, worked from the current $5.00 bond default**
(the formula scales with any bond size — `bondSize × hardCapBps / 10000`
for the per-tx figure):

| Cap | Formula | Value on a $5.00 bond | Reasoning |
|---|---|---|---|
| `--per-tx` | `bondSize × hardCapBps ÷ 10000` | **$0.50** | The largest amount a single non-escalating slash can ever move (Hard breach, 10% of remaining bond — the larger of the two classes; Semantic's cap is `min(1% bond, k×fee)` = $0.05 on this bond, always smaller). A wallet-level policy above this figure adds no protection; below it would block legitimate slash payouts. |
| `--daily` | `bondSize × 1` | **$5.00** | The absolute ceiling of what should ever leave in one day even in the worst case — a full-bond-drain escalation (`hardEscalationThreshold=3` or `semanticEscalationThreshold=5` breaches inside one rolling 24h window) takes the entire remaining bond in that single call. Nothing legitimate should ever need to exceed 100% of the bond in a day. |
| `--weekly` | `bondSize × 2` | **$10.00** | Headroom above the daily ceiling for legitimate settlement-payment volume (`recordSettlement()` on every clean verdict) accumulating across a week, on top of — not instead of — the slash-side worst case. |
| `--monthly` | `bondSize × 6` | **$30.00** | Same reasoning as weekly, scaled out; loose enough not to trip on real traffic, tight enough that a monthly total anywhere near a full bond's worth of *slash* volume alone would already indicate something worth a human looking at. |

(`per-tx ≤ daily ≤ weekly ≤ monthly` is a hard ordering constraint Circle's
CLI itself enforces — the table above already satisfies it.)

**What this would actually gate, stated honestly:** as of Phase 7.2's own
explicit decision, Agent Wallets are custody/balance-check only — they do
not sign `postBond`/`slash`/`fileIndictment`/`resolveDispute` today, and
`ConsumerSessionKeyGuard.sol` remains the sole on-chain authority for
those calls. This configuration describes what arcid2 would apply *if and
when* an Agent Wallet became the actual signing custody for outbound
payments on mainnet — a forward-looking specification, not a currently-
wired integration. No code changes this phase; the on-chain guard already
provides the testnet-testable version of the same idea (fixed target,
capped amount) today.

---

## ERC-8004 Reputation Dual-Write

Post-submission, Phase 8.2 (see CHANGELOG.md) — arcid2 also writes into Arc's
own agent-identity standard, ERC-8004, whose reputation registry deliberately
excludes bonds/slashing from its scope. arcid2 is the module that fills that
gap: every slash/settlement outcome also produces a real, externally-readable
`giveFeedback()` entry.

| Component | What's used |
|---|---|
| **Identity** | Oracle and consumer wallets both registered in Arc's real ERC-8004 IdentityRegistry (`0x8004A818BFB912233c491871b3d84c89A494BD9e`) — real agentIds (`856872` oracle, `856873` consumer), not placeholders. |
| **Reputation write** | `giveFeedback()` on Arc's real ReputationRegistry (`0x8004B663056A597Dffe9eCcC1965A193B7388713`). Value is a real function of the same numbers ArcIDBond already computes — the negative percentage of bond slashed, or 100 for a clean settlement. |
| **Path** | **Off-chain, EOA-direct** (`consumer/src/erc8004.js`), not on-chain — live-verified that the real registry rejects contract-relayed `giveFeedback()` calls (requires `tx.origin == msg.sender`); a same-transaction on-chain dual-write (`contracts/ERC8004ReputationAdapter.sol`, still deployed and wired into `ArcIDBond.sol`) is kept as a harmless, forward-looking no-op. See CHANGELOG.md's full entry for the evidence. |
| **Crash safety** | A durable pending→confirmed/failed ledger plus a startup orphan-check, since the off-chain write is now a second transaction that can diverge from the slash/settlement it describes. Live-verified, including the crash-recovery path itself. |
| **feedbackURI** | `GET /api/verdict/:verdictHash` (new oracle route) — serves the existing structured evidence/rationale as JSON. |

---

## ERC-8183 Premium Job Flow

Post-submission, Phase 8.3 (see CHANGELOG.md). A second, genuinely separate,
higher-value service tier — **"premium oracle analysis," $0.05 USDC** (50x
the $0.001 price feed) — sold through Arc's real job/escrow/evaluator
contract instead of x402/Nanopayments. One real payment per mechanism: this
never touches or duplicates the existing price feed's own payment.

| Component | What's used |
|---|---|
| **Job contract** | `AgenticCommerce` on Arc Testnet — proxy `0x0747EEf0706327138c69792bF28Cd525089e4583`, implementation `0xA316fd02827242D537F84730F8a37D0BA5fd351a` (verified via Arc's block explorer before writing any integration code). |
| **Flow** | `createJob()` (client=consumer) → `setBudget()` (provider=oracle sets its own price) → approve + `fund()` (client escrows) → oracle generates + signs a real analysis payload, served live over HTTP → `submit()` (provider, the payload's hash as `deliverable`) → evaluator (consumer) independently re-verifies the hash, signature, freshness, and `ArcIDBond.isActiveBondedAgent()` → `complete()` (release) or `reject()` (full refund). |
| **Composition, not duplication** | On a confirmed **hard** breach (bad signature or hash mismatch) discovered during evaluation, the demo **also** calls the existing, unmodified `ArcIDBond.slash()` — a separate pool of funds (the oracle's bond collateral) reacting to the same breach, not a second payment for the same job. |
| **Demo** | `npm run demo:premium-job` (clean path) / `npm run demo:premium-job -- --fault bad-sig` (reject + slash composition path) — both live-verified end to end on Arc Testnet, real transactions, first attempt succeeded both ways. See CHANGELOG.md for the full transaction record. |

---

## Marketplace Gating + Grant Metrics

Post-submission, Phase 8.5 (see CHANGELOG.md). Two dashboard/aggregation
additions — no new trust logic, both read data that already exists on-chain
or in the existing verdict stream.

**Unbonded-agent gating** — `/api/price` can refuse callers that aren't
TEE-registered in ArcIDRegistryV2, on top of (not instead of) the x402
payment requirement itself: "an agent marketplace that refuses unbonded
agents." Since arcid2 has no consumer-side bond concept (only providers
post collateral), this checks *registration*, reusing the same
`agentIdBySigner` moat `postBond()` already enforces. **Opt-in, default
off** (`REQUIRE_REGISTERED_CALLER=true` in `oracle/.env`) — a deliberate
choice, not an oversight: turning it on would also refuse any outside
consumer agent that pays but isn't itself TEE-registered, directly cutting
against the real-outside-traffic traction goal this project's own
grant-readiness assessment flags as the actual decisive weakness. Live-
verified both ways: a registered caller is served, an unregistered one gets
a `403`, and the default (off) leaves today's open-marketplace behavior
completely unchanged. Only gates the `DEV_MODE` x402 path today — gating
the real Gateway path would need dropping to the manual
`BatchFacilitatorClient` pattern so the payer can be inspected before
settlement clears; not built this pass.

**Grant metrics dashboard** — the frontend's sidebar gained a
`GrantMetricsCard`: % of verdicts resolved deterministically (Tier 1, no
LLM call) vs. requiring Claude's judgment (Tier 2), the challenge/dispute
rate (indictments vs. instant slashes), and cumulative USDC throughput
(slashed + settled) through bonded services. All three are aggregations
over existing on-chain events (`AgentSlashed`, `PaymentSettled`,
`IndictmentFiled`, `DisputeResolved`) and the existing per-verdict `tier`
field — `oracle/src/chain.js`'s `getChainStats()` and the in-memory `stats`
object, not new state.
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
SLASHER_PRIVATE_KEY=... in .env (never a CLI argument — see CLAUDE.md's private-key rule), then:
npm run bond:slash -- \
  --agent <agent-address> \
  --consumer <consumer-address> \
  --reason "Stale data: response was 90s past the 30s SLA window" \
  --breach-class hard \
  [--network arcTestnet]
```

Caller must be the `authorizedSlasher` on `ArcIDBond`. `--breach-class` is
required (`hard` or `semantic`, no default — post-submission tiered-
adjudication, see [CHANGELOG.md](CHANGELOG.md)); the contract computes the
transferred amount internally from it — this command never supplies or
influences an amount. The `--reason` string goes on-chain verbatim in the
`AgentSlashed` event, same as the consumer agent's LLM rationale. Before
sending, it previews the actual amount via `previewSlash()` — the same
formula `slash()` itself uses — so the on-chain result is never a surprise.

```
→ Slashing agent 0x71bE...abc on arcTestnet
  ArcIDBond:    0x5E5e...4691d
  Caller:       0xA662...0085
  Consumer:     0xF3a9...12c
  BreachClass:  hard (1)
  Reason:       "Stale data: response was 90s past the 30s SLA window"
  Bond remaining: 5.00 USDC
  Preview:        0.50 USDC

✓ slash() mined → 0xabc999...
  0.50 USDC transferred to consumer 0xF3a9...12c
```

### Record a settlement (demo / testing)

```bash
npm run bond:settle -- \
  --key <slasher-private-key> \
  --agent <agent-address> \
  --consumer <consumer-address> \
  [--amount 0.001] \
  [--verdict-hash 0x...]
```

The "no breach" counterpart to `bond:slash`. Caller must be the
`authorizedSlasher`. Does not move funds — the Circle Gateway payment already
happened (via the consumer agent's `settlement.js`, or manually); this only
writes the on-chain `PaymentSettled` audit record. Reverts (`AlreadySlashed`)
if the agent's bond was already slashed, so a payment can never be logged
against an agent that was already paid out via slash.

```
→ Recording settlement for agent 0x71bE...abc on arcTestnet
  ArcIDBond:    0x...
  Caller:       0x...
  Consumer:     0xF3a9...12c
  Amount:       0.001000 USDC
  VerdictHash:  0x9d5be3aa...

✓ recordSettlement() mined → 0x1304d8e4...
  0.001000 USDC settlement logged for agent 0x71bE...abc
```

### List / resolve disputes (post-submission — see CHANGELOG.md)

```bash
npm run dispute:list [-- --network arcTestnet] [-- --all]
```

Read-only, no private key required. Loops `disputes(1..nextDisputeId)` directly
(no event pagination needed — it's a simple counter). Shows open (`Indicted`)
disputes by default; `--all` also shows resolved ones. For each dispute, tries
to find the original Claude rationale + evidence in the consumer agent's own
`consumer/logs/*.jsonl` (matched by `dispute_id`) — the on-chain record only
ever stores `rationaleHash`, never the full text.

```bash
DEPLOYER_PRIVATE_KEY=... in .env, then:
npm run dispute:resolve -- --id <disputeId> --approve|--reject [--network arcTestnet]
```

`DEPLOYER_PRIVATE_KEY` (the contract's `owner` — see CLAUDE.md's private-key
rule: never a CLI argument). Prints the full stored dispute state, the
off-chain rationale + evidence if found locally, and — on `--approve` — a live
`previewSlash()` of what would actually transfer (which may differ from the
`claimAmount` captured at indictment time, and may be `0` if the agent's bond
was independently slashed in the meantime — see `_executeSlashOrVoid()`),
**before** asking for interactive confirmation. Only a typed `"yes"` proceeds;
anything else aborts with no on-chain action. No `--yes`/`--force` flag to skip
the prompt, deliberately — the tool exists so a human looks at the evidence
first, not to rubber-stamp a disputeId.

### Deploy + grant a session-key guard (post-submission — see CHANGELOG.md)

```bash
# 1 — Deploy the guard against the existing ArcIDBond deployment
npm run deploy:session-guard:arc

# 2 — Move slasher authority from the raw consumer EOA to the guard
ACTIVATE_SESSION_GUARD=true npm run deploy:session-guard:arc

# 3 — Grant a bounded, expiring session key
npm run session:grant -- \
  --owner-key <guard-owner-private-key> \
  --session-key <hot-wallet-address> \
  --payout <fixed-payout-address> \
  [--max-amount 0.01] \
  [--expires-in 3600]

# Revoke immediately (e.g. suspected leak)
npm run session:revoke -- --owner-key <guard-owner-private-key>
```

Moves the consumer agent's on-chain slash/settlement authority off a
plain EOA and onto a bounded session key: capped per-call amount, a fixed
payout address the key cannot redirect, a single target contract
(`ArcIDBond`, called only through the guard), and an expiry. Load the
**session** key (not the owner key) as `CONSUMER_PRIVATE_KEY` in the running
consumer agent's `.env`, plus `SESSION_GUARD_ADDRESS` from
`deployments/<network>_session_guard.json`. The owner key stays offline.

### Check / resume the settlement circuit breaker (post-submission — see CHANGELOG.md)

```bash
# From consumer/
npm run breaker:status
npm run breaker:resume -- --reason "confirmed legitimate traffic spike"
```

Reports rolling 1-minute/1-hour settlement spend against `MAX_SPEND_PER_MINUTE_USDC`
/ `MAX_SPEND_PER_HOUR_USDC`, and whether the breaker is currently tripped.
There is no automatic recovery — `breaker:resume` is the only way to clear a
trip, and it's a manual, human decision by design.

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

**Corollary (Phase 7, post-submission — see [CHANGELOG.md](CHANGELOG.md)):**
because the LLM verdict has no TEE involvement, and reasons over service
response content that's untrusted by the same logic as any other network
input, `consumer/src/paymentGate.js` inserts a deterministic, non-LLM check
directly in front of both the real Gateway payment and the on-chain audit
write — independently re-deriving payee/amount from config, never from
`verdict.*` or the oracle response, and refusing the call on any mismatch.

**Corollary 2 (Phase 8, post-submission — see [CHANGELOG.md](CHANGELOG.md)):**
per-call caps (Phase 6/7) don't catch a consumer stuck in a retry or
re-adjudication loop firing many small, individually-legitimate settlements
— each passes its own cap check, but the total drains the budget.
`checkCircuitBreaker()` in `settlement.js` sums the settlement ledger's spend
over rolling 1-minute/1-hour windows before every call; crossing either caps
it, persists a tripped flag in the ledger, and halts every further
settlement until a human runs `npm run breaker:resume` (in `consumer/`) —
there is no automatic recovery path.

**Corollary 3 (Phase 9, post-submission — see [CHANGELOG.md](CHANGELOG.md)):**
`AgentSlashed` already gives the breach path a first-class, queryable record
with Claude's rationale attached — before this, the payment path's
provenance was scattered across three files with no single record per
attempt. `consumer/src/auditTrail.js`'s `writeAuditRecord()` now runs at
every exit point of `executeSettlement()` — settled, gated, circuit-breaker-
blocked, payment-failed, on-chain-write-failed, or deduped — writing one
uniform-schema line to `settlement_audit.jsonl` per attempt: agentId (from
`ArcIDRegistryV2.agentIdBySigner()` if `REGISTRY_ADDRESS` is set), agent,
payee, verdict hash, amount, Gateway tx hash, on-chain audit tx hash,
outcome, and timestamp. "The agent paid, trust us" becomes "here is the
exact authorization and receipt for every attempt" — the same standard the
slash flow already meets.

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
| Post-submission | Payment execution — real Circle Gateway settlement + `ArcIDBond.recordSettlement()` audit trail on a clean verdict; 7 new tests | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | `ConsumerSessionKeyGuard.sol` — session-key wallet hardening for the consumer agent's slash/settlement authority; 22 new tests | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | `consumer/src/paymentGate.js` — deterministic, non-LLM payee/amount/cap gate in front of Gateway settlement and the on-chain audit write | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | Spend-velocity circuit breaker — rolling 1m/1h settlement spend caps, manual-only resume | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | `consumer/src/auditTrail.js` — attributable audit record (agentId, payee, verdict hash, amount, tx hash) for every settlement attempt | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | `consumer/src/deterministicVerifier.js` — Tier 1 of tiered slash adjudication; mechanically-checkable breaches skip the LLM entirely | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | Narrowed Tier 2 adjudicator — Claude's jurisdiction restricted to semantic quality, structured `evidence` schema, deterministic `assertWithinJurisdiction()` enforcement | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | `consumer/src/slashGate.js` — deterministic payee/target/classification/verdict-hash gate in front of `slash()`, mirroring `paymentGate.js` | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | Proportional breach-class slashing + epoch escalation in `ArcIDBond.sol`; 25 new tests | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | `breachClass` wiring (slasher.js, oracle trigger-cycle, CLI) + `demo:hard-breach`/`demo:semantic-breach`; new `bad-price` oracle fault mode; live-verified against the redeployed contract | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | Phase 6.1: optimistic challenge window in `ArcIDBond.sol` — large semantic slashes held pending dispute (owner-only interim resolver, stated as a placeholder — see Future Work) instead of executing instantly; auto-finalizes if unresolved; 27 new tests | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | Phase 6.2: `slashGate.js` routes large semantic slashes to `fileIndictment()` instead of `slash()`, decided by a live on-chain read mirroring the contract's own rule; live-verified against a local redeploy of Phase 6.1's bytecode (the shared Arc testnet contract still predates 6.1 — redeploy is 6.4's job) | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | Phase 6.3: `dispute:list` / `dispute:resolve` CLI — interim owner review tooling that surfaces the off-chain Claude rationale before an interactive approve/reject confirmation | ✅ Complete → [CHANGELOG.md](CHANGELOG.md) |
| Post-submission | **Proof-of-Exploit — a second vertical**: `ExploitBounty.sol`, TEE-attested automated bug bounty (deterministic invariant check, no LLM in the payout path); 51 new tests | ✅ Complete → see below + [CHANGELOG.md](CHANGELOG.md) |

**Test suite:** 209 passing (`npm test`) — no external RPC, no `.env` required.

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

**Test suite highlights (`npm test` — 104 passing total):**

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

> **Superseded by tiered adjudication (post-submission — see [CHANGELOG.md](CHANGELOG.md)):**
> this table is the original Phase 3 demo record, left as-is per this doc's own
> transparency principle of not rewriting pre-deadline results. It no longer
> describes current behavior: `stale`, `null`, and `bad-sig` are all
> mechanically-checkable and now hard-breach at Tier 1 with **zero LLM calls**
> — Claude never sees them. The `uncertain`-on-`null` restraint moment above
> was real and is preserved as a record of what was demoed, but is not
> reproducible on the current code path; see `deterministicVerifier.js`'s
> module doc for why that's an intentional redesign, not a regression.

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

**Current demo commands (post-submission, tiered-adjudication Phase 5 — see
[CHANGELOG.md](CHANGELOG.md)):** the two commands that actually demonstrate
today's tiered behavior, run from `consumer/` with the oracle already
running:

```bash
npm run demo:hard-breach      # bad-sig — Tier 1, zero LLM calls, ~500ms
npm run demo:semantic-breach  # bad-price (new oracle fault) — passes Tier 1,
                               # only Claude's semantic judgment catches it
```

`demo:hard-breach` is a live-verified alias for `fault:bad-sig` above —
same command, new name matching what it actually demonstrates now (Tier 1,
no LLM in the trace, not "Claude reasons about a bad signature" the way
the historical beat above describes). `demo:semantic-breach` exercises a
fault mode that didn't exist before this phase — see the oracle's new
`?fault=bad-price` in "Phase 2 — What Was Built" below.

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

> **Post-submission (tiered-adjudication Phase 5 — see [CHANGELOG.md](CHANGELOG.md)):**
> the three modes above are all Tier 1 now — Claude never sees them (see the
> superseded-table note earlier in this doc). A fourth mode was added
> specifically because none of the three above can reach Tier 2:
> `?fault=bad-price` returns a genuinely valid signature over a fresh,
> well-formed, but semantically implausible value (`99999999.99`) — passes
> every mechanical check, only caught by Claude's judgment. This is what
> `npm run demo:semantic-breach` exercises.

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
| ArcIDBond (USDC collateral, current) | `0x5E5eA9513f96A537AE966840F3355ff80824691d` — post-submission redeploy for tiered-adjudication Phase 4 (proportional slashing); see [CHANGELOG.md](CHANGELOG.md) |
| ArcIDBond (USDC collateral, original/pre-tiering) | `0xE4860b98AFace0166dD323D0E0b12e680d61D59c` — superseded, kept here for reference; the real historical slash tx in "Live Proof" above happened on this address |
| ArcIDBond (USYC collateral) | _(run `npm run deploy:usyc:arc`)_ |
| USDC (Arc testnet) | `0x3600000000000000000000000000000000000000` |
| USYC token | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| USYC Teller (mint/redeem) | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` |
| ExploitBounty (Proof-of-Exploit vertical) | `0x52fB6011a6FaCD0f86CC28b32cDF85Df47449A61` |
| ExploitBounty verifier wallet (TEE-registered) | `0x95C80031Ec9831cD5A830AF61616CC68e6B9d671` |
| VulnerableVault, target 1 (confirmed exploit, claimed) | `0x53Cc93a28C839EEA98FF87abF4c7994EAe81dA6a` |
| VulnerableVault, target 2 (negative control, unclaimed) | `0xfeBe8b00fb6d8e7eB63E9b62340e42f407A4b4A8` |

**Registered & bonded agents on the current ArcIDBond (`0x5E5eA9...`), as of
2026-07-30 — ⚠ not the same live state as the pre-tiering table this
replaces:**

| Address | Registered | Bonded | Status |
|---------|------------|--------|--------|
| `0xA6622e7E77ed0f63FeA527273418C267C1c70085` (agent #1, rotated) | ✓ | **Pending** — re-bond blocked by an Arc testnet RPC write-rate-limit; owner + authorizedSlasher already point here, confirmed independently on-chain | Also `authorizedSlasher` and contract `owner` |
| `0xe2F7a0E6d9865C7Dc9B5D19DCc11CBcb4655c661` (oracle wallet) | ✓ (on the original registry, carries over) | **Not yet bonded on this contract** — never was; surfaced during Phase 5 live verification | — |
| `0xEF5adE59183CAd6A2dDC896BE7f8bE58eDf5f993` (agent #2) | ✓ (on the original registry, carries over) | **Not yet re-bonded on this contract** | — |

The original (pre-tiering) contract's historical state — including the real
slash documented in "Live Proof" above — is unaffected and remains exactly
as it was; this table describes the *new* contract's state, which starts
from zero bonds by design (fresh deployment, no migration — see
[CHANGELOG.md](CHANGELOG.md)).

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
| `postBond(uint256 amount)` | TEE-verified agent | Transfers collateral to contract. Reverts for unverified wallets or a blacklisted agent (see Phase 4). |
| `slash(address agent, address consumer, string reason, BreachClass breachClass)` | authorizedSlasher | Post-submission Phase 4 (see [CHANGELOG.md](CHANGELOG.md)): `breachClass` is `Semantic` (0) or `Hard` (1) — no `amount` parameter exists; the contract computes it internally (capped, proportional to the remaining bond) and escalates to a full-drain + permanent blacklist past a per-class rolling-24h threshold. `reason` is the LLM (or Tier 1 machine-generated) rationale. |
| `previewSlash(address agent, BreachClass breachClass)` | view | Post-submission Phase 4. Returns `(amount, wouldEscalate)` without executing — the same internal formula `slash()` uses, independently checkable. |
| `recordSettlement(address agent, address consumer, uint256 amount, bytes32 verdictHash)` | authorizedSlasher | Post-submission (see [CHANGELOG.md](CHANGELOG.md)). Does NOT move funds — logs an off-chain Gateway settlement against a clean verdict. Reverts if the bond is already slashed. |
| `withdrawBond()` | Bond holder | Returns unslashed bond to agent — whatever currently *remains*, post Phase 4, not necessarily the original deposit. |
| `isActiveBondedAgent(address)` | view | True if agent has active (unslashed) bond. |
| `setAuthorizedSlasher(address)` | owner | Rotate the consumer agent wallet. |
| `setSlashParameters(uint256 k, uint256 semanticCapBps, uint256 hardCapBps)` | owner | Post-submission Phase 4. Retune the slash-amount schedule. |
| `setServiceFee(uint256 serviceFeeAtomic)` | owner | Post-submission Phase 4. Retune the fee basis used in the semantic-tier `k × fee` term. |
| `setEscalationThresholds(uint16 hard, uint16 semantic)` | owner | Post-submission Phase 4. Retune breaches-per-24h-epoch before full-drain escalation. |
| `fileIndictment(address agent, address consumer, bytes32 rationaleHash)` | authorizedSlasher | Post-submission Phase 6.1 (see [CHANGELOG.md](CHANGELOG.md)). Holds a non-escalating Semantic slash whose amount exceeds `challengeThreshold` pending dispute instead of executing it. Reverts `ChallengeThresholdNotExceeded` / `EscalatingBreachNotDisputable` if the call should have gone through `slash()` instead — the two functions are mutually exclusive by on-chain state, not convention. |
| `resolveDispute(uint256 disputeId, bool approved)` | owner | Post-submission Phase 6.1. Interim resolver (Option A — explicitly a placeholder, see Future Work). Approval recomputes the slash amount fresh via the same formula `slash()` uses, not the amount stored at indictment time. Rejection leaves the bond untouched. |
| `finalizeExpiredDispute(uint256 disputeId)` | anyone | Post-submission Phase 6.1. Permissionless. Once `challengeDeadline` passes with no `resolveDispute()` call, executes the slash as if approved — the "optimistic" default. |
| `previewSlash` / `disputes(uint256)` / `nextDisputeId` | view | Post-submission Phase 6.1. `disputes(id)` returns the full `Dispute` struct; `nextDisputeId` is the 1-based upper bound for CLI listing. |
| `setChallengeParameters(uint256 challengeThreshold, uint64 disputeWindow)` | owner | Post-submission Phase 6.1. Retune the challenge-window threshold (atomic units of collateralToken) and window duration (seconds, must be nonzero). |

#### Events

| Event | When |
|-------|------|
| `BondPosted(agent, amount, token)` | Successful `postBond()` |
| `AgentSlashed(agent, consumer, amount, reason)` | Successful `slash()` — signature unchanged since before Phase 4; `amount` is now whatever that call actually transferred (proportional or full), not always the full bond |
| `BreachClassified(agent, breachClass, amount, epochBreachCount, escalated)` | Successful `slash()` — post-submission Phase 4 (see [CHANGELOG.md](CHANGELOG.md)) |
| `AgentEscalatedAndBlacklisted(agent, amountTaken, breachClass)` | Only on the escalation path — post-submission Phase 4 |
| `PaymentSettled(agent, consumer, amount, verdictHash)` | Successful `recordSettlement()` — post-submission (see [CHANGELOG.md](CHANGELOG.md)) |
| `BondWithdrawn(agent, amount)` | Successful `withdrawBond()` |
| `SlasherUpdated(oldSlasher, newSlasher)` | `setAuthorizedSlasher()` called |
| `SlashParametersUpdated` / `ServiceFeeUpdated` / `EscalationThresholdsUpdated` | Respective admin setters called — post-submission Phase 4 |
| `IndictmentFiled(disputeId, agent, consumer, claimAmount, challengeDeadline, rationaleHash)` | Successful `fileIndictment()` — post-submission Phase 6.1 |
| `DisputeResolved(disputeId, approved, amountTransferred, autoFinalized)` | Successful `resolveDispute()` or `finalizeExpiredDispute()` — post-submission Phase 6.1 |
| `ChallengeParametersUpdated(challengeThreshold, disputeWindow)` | `setChallengeParameters()` called — post-submission Phase 6.1 |

### `ConsumerSessionKeyGuard.sol` — post-submission (see [CHANGELOG.md](CHANGELOG.md))

```solidity
constructor(address _bond, address _owner)
```

Sits in front of `ArcIDBond` as its `authorizedSlasher` once activated
(`ArcIDBond.setAuthorizedSlasher(guardAddress)`). Bounds the consumer agent's
on-chain slash/settlement authority to a revocable, expiring, capped session
key instead of a plain EOA with unbounded authority — closes the "leaked
consumer key can slash any bonded agent's entire collateral to an
attacker-chosen address" hole a raw `authorizedSlasher` EOA has, since
`ArcIDBond.slash()` takes an arbitrary `consumer` address.

Scope: hardens the on-chain call surface only (`slash()` /
`recordSettlement()`). Circle Gateway payments are authorized off-chain via
EIP-712 signatures relayed through Circle's API — a different authority
model this contract does not cover.

#### Functions

| Function | Who | Description |
|----------|-----|-------------|
| `grantSessionKey(address sessionKey, address payoutAddress, uint256 maxAmountPerCall, uint64 expiresInSeconds)` | owner | Grants (or overwrites) the active session. `payoutAddress` is fixed on-chain — the session key can never redirect proceeds. |
| `revokeSessionKey()` | owner | Immediately kills the active session (e.g. on suspected leak). |
| `guardedSlash(address agent, string reason, BreachClass breachClass)` | sessionKey | Calls `ArcIDBond.slash(agent, payoutAddress, reason, breachClass)`. `breachClass` param added post-submission Phase 4 (see [CHANGELOG.md](CHANGELOG.md)) — passed through unmodified; the guard never supplies or influences the amount, before or after Phase 4. Reverts if expired or unauthorized. |
| `guardedRecordSettlement(address agent, uint256 amount, bytes32 verdictHash)` | sessionKey | Calls `ArcIDBond.recordSettlement(agent, payoutAddress, amount, verdictHash)`. Reverts `AmountExceedsCap` over the cap. |
| `hasActiveSession()` | view | True if a session key is set and not expired. |

#### Events

| Event | When |
|-------|------|
| `SessionKeyGranted(sessionKey, payoutAddress, maxAmountPerCall, expiry)` | `grantSessionKey()` called |
| `SessionKeyRevoked(sessionKey)` | `revokeSessionKey()` called |
| `GuardedSlash(agent, sessionKey, reason)` | Successful `guardedSlash()` |
| `GuardedSettlement(agent, sessionKey, amount, verdictHash)` | Successful `guardedRecordSettlement()` |

---

## Capability Summary

| Area | How arcid2 addresses it |
|--------------------|---------------------------|
| **Agentic reasoning** | Consumer agent uses Claude `tool_use` with forced structured output to reason about *why* a failure is a breach vs a transport blip. Three fault modes give genuinely different reasoning paths. Written rationale logged on-chain. `uncertain` verdict on ambiguous failures demonstrates restraint — the agent knows when not to slash. |
| **Traction** | DCAP-verified agents registered on-chain via `ArcIDRegistryV2`; real x402 nanopayment volume on Arc testnet; outside participants recruited. Every cycle is logged to JSONL — traction is auditable, not claimed. |
| **Circle tool usage** | **x402 Gateway:** oracle charges $0.001/call, consumer pays autonomously. **USYC collateral:** bond deployed with Hashnote's yield-bearing token; Teller integration for USDC→USYC mint. Both used together. |
| **Innovation** | First system where TEE-attested identity gates the bond *before* stake (not stake as identity), and where bond collateral earns T-bill yield while at risk. No adjacent project has both properties. |

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

- **Decentralized dispute resolution (Kleros or equivalent):** the actual target for `resolveDispute()`'s authority. The optimistic challenge window (post-submission Phase 6.1 — see [CHANGELOG.md](CHANGELOG.md)) ships the state machine now with the existing `owner` role wired in as an explicitly-labeled interim resolver — a known centralization point, stated rather than hidden. Prerequisite work before integrating a real arbitration layer: confirm its cross-chain story against Arc, and get real dispute-volume data from the interim system first. A multi-model LLM quorum was considered and rejected — correlated model failure doesn't buy the independence a human/economic arbitration layer does.
- **Provider-side contest tooling:** today a disputed provider has no way to actively argue their case beyond what's already in the recorded evidence — the owner reviews Claude's rationale, not a rebuttal. Appropriate once a real resolver (above) is in place; building rebuttal tooling around a single-owner interim resolver would be investing in the wrong long-term architecture.
- **Broker agent:** chooses which bonded provider to route to based on bond size + slash record (Phase 3 stretch)
- **USYC redemption flow:** yield tracking per bond via Teller

---

## Links

- Live frontend: [frontend-five-eta-43.vercel.app](https://frontend-five-eta-43.vercel.app)
- Arc testnet explorer: [testnet.arcscan.app](https://testnet.arcscan.app)
