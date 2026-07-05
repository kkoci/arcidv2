# ArcID v2 — Claude Code Guide

## Project

**ArcID v2** is a bonded agent reputation system for nanopayment networks on Arc.
Agents post USDC (or USYC) collateral to register a bond. They sell a service via
x402 nanopayments. A consumer agent uses LLM-reasoned adjudication to decide whether
the service was delivered — on confirmed breach, the bond slashes automatically and
pays the consumer. Reputation is capital at risk, not a score.

**Submission:** Lepton Agents Hackathon (Canteen × Circle × Arc)
**Judging weights:** 30% Agentic Sophistication · 30% Traction · 20% Circle Tools · 20% Innovation

---

## Context Loading Order

Before starting any task, read in this order:

1. This file (`CLAUDE.md`) — constraints, phase status, what not to build
2. `contracts/ArcIDBond.sol` — the bond contract (core Phase 1 artifact)
3. `contracts/interfaces/IArcIDRegistry.sol` — the registry interface
4. `README.md` — architecture diagram, deployed addresses, phase status
5. Relevant phase file (see Key Files below)

---

## Stack

| Layer | Technology |
|-------|-----------|
| Bond contract | Solidity 0.8.24 — `ArcIDBond.sol` |
| Token standard | IERC20 (USDC and USYC) |
| Registry interface | `IArcIDRegistry` — reads live `ArcIDRegistry` on Arc |
| Contract tooling | Hardhat v2 + `@nomicfoundation/hardhat-toolbox` |
| Oracle service | Node.js/Express + x402 middleware (Phase 2) |
| Consumer agent | Node.js with Anthropic SDK (Phase 3) |
| LLM adjudication | Claude claude-sonnet-4-6 via `anthropic` SDK (Phase 3) |
| Frontend | React 18 + Vite 5 — standalone `frontend/` dir, port 5174 (Phase 4) |
| x402 payments | `circlefin/arc-nanopayments` Gateway pattern |
| Collateral (Phase 1) | USDC — Arc testnet: `0x3600000000000000000000000000000000000000` |
| Collateral (Phase 5) | USYC — Arc testnet: `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| USYC mint/redeem | Teller contract: `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` |
| Oracle hosting | Phala Cloud CVM (Intel TDX) — Phase 7 |
| Frontend hosting | Vercel — deployment in progress, no live URL yet — Phase 7 |

---

## Environment Constraints

**Arc testnet:**
- Chain ID: 5042002 (verified via `eth_chainId` against the live RPC — this is Circle's own
  Arc Testnet network, not Arbitrum Sepolia's 421614; do not reuse that chain ID anywhere)
- RPC: `https://rpc.testnet.arc.network` (set via `ARC_RPC_URL`)
- Explorer: `testnet.arcscan.app`
- USDC faucet: `faucet.circle.com` — select Arc Testnet

**Registry gating:**
- `agentIdBySigner[addr] == bytes32(0)` → unverified (cannot postBond)
- `agentIdBySigner[addr] != bytes32(0)` → TEE-attested (may postBond)
- Do NOT deploy a new ArcIDRegistry — read from the live one only.

**Secrets:** always read from `.env` via `process.env`. Never hardcode private keys
or contract addresses. `.env.example` documents all required vars.

**USYC allowlist:** USYC requires wallet allowlisting via Circle Support. Chase
this starting Day 0 — lead time is the only real risk. If allowlist hasn't arrived,
ship the USYC contract anyway (deployed + verified = stronger than a hand-wave).

---

## Architecture

```
ArcIDRegistry (existing, read-only)
  └─ agentIdBySigner[wallet] → bytes32 agentId  (gating source of truth)

ArcIDBond (Phase 1 — this repo)
  ├─ postBond(amount)          requires registry.agentIdBySigner(msg.sender) != 0
  ├─ slash(agent, consumer, reason)  authorizedSlasher only; logs LLM rationale
  ├─ withdrawBond()            agent only, unslashed bonds
  └─ isActiveBondedAgent(addr) view — used by consumer agent

Oracle Service (Phase 2)
  └─ GET /api/price            x402-gated, signed response, ?fault=true toggle

Consumer Agent (Phase 3) ⭐
  ├─ Calls oracle + pays x402
  ├─ Verifies signature
  ├─ LLM adjudication: did the provider meet its SLA?
  │    verdict + written rationale (not a cron job — this is the agency beat)
  └─ On breach → ArcIDBond.slash()

Frontend (Phase 4) ✅
  ├─ Vite proxy → oracle (all /api + /admin calls proxied, no CORS issue)
  ├─ TractionStrip — 5-stat header (bonds, calls, volume, ok, slash)
  ├─ AgentCard — oracle identity, fault injection buttons (stale/null/bad-sig)
  └─ VerdictHistory — scrolling feed of every Claude adjudication

USYC Bond (Phase 5)
  └─ Same ArcIDBond.sol, deployed with USYC token address

Phala Cloud CVM (Phase 7)
  ├─ Oracle runs inside Intel TDX enclave on Phala dstack
  ├─ GET /api/attest → returns TDX quote (prototype or real via USE_REAL_PHALA=true)
  ├─ Quote embeds oracle wallet address as report_data (keccak256 of address → 32 bytes)
  └─ Live URL: https://1d6a697fdbc91c92c33a195103720c3a25685994-3001.dstack-pha-prod5.phala.network

Vercel Frontend (Phase 7)
  ├─ Deployment in progress — no live URL yet
  ├─ frontend/vercel.json rewrites /api/* and /admin/* → Phala CVM URL (no CORS, no code change)
  └─ All fetch("/api/...") calls work identically locally and in prod
```

---

## Key Files

```
contracts/ArcIDBond.sol              Core bond contract — TEE-gating, slash, events
contracts/interfaces/IArcIDRegistry.sol  agentIdBySigner() interface to live registry
contracts/mocks/MockUSDC.sol         Test-only ERC-20 (6 decimals, free mint)
contracts/mocks/MockRegistry.sol     Test-only registry (setVerified/unsetVerified)
scripts/deploy.js                    Deploy + post initial bond + gating proof
scripts/verify_gating.js             Standalone gating demo (the screenshot clip)
test/ArcIDBond.test.js               27-test suite covering all Phase 1 paths
hardhat.config.js                    Hardhat config (hardhat / localhost / arcTestnet)
.env.example                         All required env vars documented
deployments/<network>.json           Persisted address output from deploy.js
oracle/src/index.js                  Phase 2+4: Express oracle; x402-gated + stats/verdicts/admin endpoints
oracle/src/signer.js                 Signs (value, timestamp) with oracle wallet
oracle/src/config.js                 Oracle env config
oracle/.env.example                  Oracle env vars
consumer/src/index.js               Phase 3+4: Main loop — fetch → verify → adjudicate → slash → POST verdict
consumer/src/adjudicator.js         LLM adjudication via Claude tool_use (structured verdict)
consumer/src/verifier.js            Signature verification (ethers.verifyMessage)
consumer/src/oracle.js              x402 oracle client (dev bypass + prod path)
consumer/src/slasher.js             ArcIDBond.slash() on-chain caller
consumer/src/config.js              Consumer env config
frontend/src/App.jsx                Phase 4: Root component — polls /api/stats + /api/verdicts every 5s
frontend/src/components/TractionStrip.jsx  5-stat header row
frontend/src/components/AgentCard.jsx      Oracle identity + fault injection
frontend/src/components/VerdictHistory.jsx Scrolling adjudication feed
frontend/vite.config.js             Vite config; proxies /api /admin /health → oracle:3001
README.md                            Architecture, phase status, contract reference
```

Phase 5 files:
```
contracts/mocks/MockUSYC.sol         8-decimal yield-bearing mock; simulateYield(bps) for tests
contracts/interfaces/ITeller.sol     Teller interface (deposit/redeem/sharePrice)
test/ArcIDBondUSYC.test.js           13 tests: face value, yield accrual, slash includes yield
scripts/deploy_usyc.js               Deploy ArcIDBond with USYC; handles allowlist gracefully
scripts/mint_usyc.js                 Mint USYC from USDC via Teller on Arc testnet
frontend/src/components/USYCBondCard.jsx  USYC card — APY, T-bill backed, deployed address
```

Phase 7 files (Phala + Vercel deployment):
```
oracle/Dockerfile                    Node 18-alpine image; exposes port 3001
oracle/docker-compose.yml            Local dev compose (USE_REAL_PHALA=false)
oracle/docker-compose.phala.yml      Phala CVM compose (USE_REAL_PHALA=true, all vars as ${VAR})
oracle/src/attest.js                 TDX attestation: prototype 592-byte quote OR real Phala dstack quote
oracle/src/config.js                 Added USE_REAL_PHALA and PHALA_ENDPOINT vars
frontend/vercel.json                 Vercel rewrites: /api/* /admin/* /health → Phala CVM URL
```

Frontend design overhaul (Phase 7):
```
frontend/src/index.css               Deep indigo palette (#0d0b24), grid overlay, glass utilities (.g / .gh)
frontend/src/App.jsx                 No hero section — stats inline in sticky header; compact headline strip
frontend/src/components/AgentCard.jsx      Glassmorphism card; orange slash button with glow
frontend/src/components/VerdictHistory.jsx Verdict cards: first sentence bold lead + "▾ Full reasoning" toggle
frontend/src/components/TractionStrip.jsx  Removed — replaced by inline header stats
```

---

## ArcIDBond Contract Events

These events are the source of truth for the frontend live counters.
**Never poll a log file — read on-chain events.**

| Event | Fields | Frontend use |
|-------|--------|-------------|
| `BondPosted(agent, amount, token)` | agent wallet, USDC amount (6 dec), token addr | TVL counter, agent card badge |
| `AgentSlashed(agent, consumer, amount, reason)` | all parties, amount, LLM rationale | Slash counter, badge flip, rationale display |
| `BondWithdrawn(agent, amount)` | agent, amount | TVL update |
| `SlasherUpdated(old, new)` | wallet addrs | Admin audit |

---

## Test Suite (40 passing — run with `npm test`)

```
test/ArcIDBond.test.js
  construction            1   collateralToken / registry / authorizedSlasher
  postBond                8   success, BondPosted event, USDC transfer, gating revert,
                              ZeroAmount, BondAlreadyActive, re-bond after slash
  slash                   7   USDC transfer to consumer, mark slashed, AgentSlashed event
                              with rationale, NotAuthorizedSlasher, NoBondFound,
                              AlreadySlashed, isActiveBondedAgent after slash
  withdrawBond            5   success, BondWithdrawn event, record delete, NoBondFound, AlreadySlashed
  isActiveBondedAgent     3   false/true/false across lifecycle
  setAuthorizedSlasher    4   success, event, OwnableUnauthorizedAccount, new slasher works

ArcIDBond — USYC yield-bearing collateral (Phase 5)  [test/ArcIDBondUSYC.test.js]
  basic USYC bond         4   accepts USYC, BondPosted event, $5 face value, TEE-gating still applies
  yield-bearing           4   value increases after simulateYield, 490bps APY, monotonic price, YieldAccrued event
  slash                   3   consumer gets USYC, worth > $5 after yield, agent can re-bond
  withdrawal              1   agent gets USYC back; redeems for more USDC via Teller
  multi-agent             1   two bonds coexist, yield accrues on both (TVL tracking)
```

**Run tests:** `npm test` (no external RPC, no .env required — uses Hardhat in-memory network)

**Critical test:** "reverts for an unverified wallet with the exact gating message" — this is
the test that proves the moat. It must always pass. Do not weaken the assertion.

---

## Phase Status

| Phase | What | Status |
|-------|------|--------|
| 1 | `ArcIDBond.sol` — bond contract, TEE-gating, 27 tests | ✅ Complete |
| 2 | Oracle service — x402 nanopayment endpoint, fault modes | ✅ Complete |
| 3 | Consumer agent — LLM adjudication, slash loop | ✅ Complete |
| 4 | Frontend — live traction strip, fault injection, verdict feed | ✅ Complete |
| 5 | USYC yield-bearing collateral — MockUSYC, ITeller, 13 new tests | ✅ Complete |
| 6 | Video script, submission form answers, pre-submit checklist | ✅ Complete → SUBMISSION.md |
| 7 | Phala Cloud (TDX CVM) + Vercel deploy + frontend visual overhaul | ✅ Complete |

---

## Judging Weights (keep front-of-mind on every decision)

| Axis | Weight | How to maximize |
|------|--------|----------------|
| Agentic Sophistication | 30% | Phase 3 LLM adjudication is the cut line. **Never cut the reasoning step.** |
| Traction | 30% | Real non-self volume. Recruit outside agents from Day 0. |
| Circle Tool Usage | 20% | x402 Gateway payments + USYC yield collateral. |
| Innovation | 20% | TEE-gated identity + USYC yield bonds = unique combination. |

---

## What NOT to Build

- **New ArcIDRegistry** — Phases 1–6 only *read from* the existing registry. Never modify or redeploy the identity layer.
- **Decentralized multi-slasher / dispute window** — legitimate future work, not hackathon scope. Note it in the README.
- **Minimum bond enforcement on-chain** — the adjudication agent is the trust layer; don't over-engineer the contract.
- **Fancy oracle logic** — Phase 2 oracle is a minimal express service. A single deterministic value + signature is enough.
- **Hardhat fork testing against Arc testnet** — use MockRegistry + MockUSDC for all tests. No external RPC in CI.
- **Broker agent before Phase 3 core is solid** — the broker is a stretch within Phase 3. Ship LLM adjudication first.

---

## Workflow Rules

### On every contract change

1. Run `npm test` — confirm 27 tests passing, zero failures.
2. The gating test ("reverts for an unverified wallet with the exact gating message") must always pass. This is the moat; do not change the revert string or weaken the check.
3. If you add a new event, update the events table in this file and README.md.
4. If you change constructor args, update `.env.example` and the deploy script.

### On Phase 3 work

1. The consumer agent must return a **structured verdict with written rationale** — not a boolean. `{verdict: "breach", reason: "..."}` is the agency beat worth 30%.
2. The three fault modes from Phase 2 must produce clearly different LLM reasoning paths — don't collapse them into a single check.
3. Log every oracle call + every verdict. The log is traction data.
4. The oracle signing scheme: `keccak256(abi.encodePacked(string(value), uint256(timestamp)))` then `signMessage()` with EIP-191. Verify in the consumer with `ethers.verifyMessage(ethers.getBytes(hash), sig)`.
5. The oracle runs locally at `http://localhost:3001` — start it with `cd oracle && npm start`.

### On errors

1. Custom errors for gas-efficient reverts on internal checks.
2. `require(condition, "human-readable string")` for the TEE-gating check only — this is the screenshot string.
3. Never use `assert()`.

### On Phala / attestation (Phase 7 — complete)

1. `oracle/src/attest.js` builds a 592-byte prototype TDX DCAP v4 quote for local dev. Set `USE_REAL_PHALA=true` to call Phala dstack at `PHALA_ENDPOINT/attestation/quote`.
2. `report_data` = `keccak256(abi.encodePacked(address oracleWallet))` — 32 bytes, right-padded to 64 in the quote.
3. The signature inside the quote uses raw ECDSA (no EIP-191 prefix) to be compatible with `DCAPVerifier._recover()`.
4. The Phala CVM URL is hardcoded in `frontend/vercel.json`. Update it if the CVM is redeployed.
5. To redeploy oracle to Phala: `docker build -t kkoci/arcid2-oracle:latest oracle/` → push → update CVM image → update `vercel.json` rewrite URL → `npx vercel --prod` from `frontend/`.

### On frontend deployment (Phase 7 — complete)

1. Deploy frontend: `cd frontend && npx vercel --prod`
2. The Phala CVM URL in `frontend/vercel.json` must be updated whenever the CVM is redeployed.
3. Local dev still uses `vite.config.js` proxy → `localhost:3001`. No changes needed.
4. `TractionStrip.jsx` returns null — stats moved to the header. Do not restore it as a separate section.

### On USYC (Phase 5 — complete)

1. The same `ArcIDBond.sol` supports USYC — deploy with `_collateralToken = USYC address`. No new contract code.
2. MockUSYC uses a share-price model (8 decimals, starts at $1.00). `simulateYield(bps)` increases price.
3. `deploy_usyc.js` handles the allowlist-absent case: still deploys and prints address for judges.
4. Teller address (Arc testnet): `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` — `deposit(USDC, amount, 0)` mints USYC.
5. After deploying: set `USYC_BOND_ADDRESS` in `oracle/.env` so frontend shows the deployed address.
6. Update `deployments/arcTestnet_usyc.json` and the README deployed addresses table.

---

## Critical Invariants

- `postBond()` MUST revert for any wallet where `registry.agentIdBySigner(wallet) == bytes32(0)`. This is the moat. Never bypass or mock away this check except in `MockRegistry`-based unit tests.
- `slash()` MUST only be callable by `authorizedSlasher`. No consumer can slash without authorization.
- `slash()` on an already-slashed agent MUST revert. No double-slash.
- Bond amount MUST be transferred to contract on `postBond`, to consumer on `slash`, back to agent on `withdraw`. No funds stuck in contract.

---

## Decisions and Rationale

**Why `require()` for TEE-gating instead of a custom error?**
The submission video and grant deck show the revert message verbatim. `require()` embeds
the string in the transaction revert reason — visible in explorers, curl output, and
Hardhat test output. A custom error (`NotTEEVerified()`) is more gas-efficient but less
demo-visible. The gating check is cold path (called once at bond-time) so the gas cost
is irrelevant.

**Why `authorizedSlasher` = deployer at construction?**
Simplest path for the hackathon: consumer agent runs under the deployer key. This is
explicitly documented as a simplification; the multi-slasher path is future work.
`setAuthorizedSlasher()` lets us rotate to a dedicated consumer wallet at any point.

**Why fixed collateral token at construction instead of per-bond token choice?**
The Phase 5 plan calls for a separate USYC deployment ("same contract, different
constructor arg"). A single-token-per-deployment design is simpler, auditable, and
makes TVL accounting per contract unambiguous. The alternative (accept any ERC-20 per
bond) adds attack surface and complicates slash accounting.

**Why no minimum bond?**
The consumer agent adjudicator is the trust layer — it won't slash a provider over
$0.001 for a $0.01 service. A minimum bond enforced on-chain adds complexity with
no security gain at hackathon scale. Document as "configurable future upgrade."

**Why Phala Cloud for the oracle?**
Phala dstack runs the oracle inside an Intel TDX enclave. `GET /api/attest` returns a
TDX DCAP v4 quote with the oracle wallet address embedded as `report_data`. This makes
the TEE attestation claim tangible and verifiable — not just a narrative. Set
`USE_REAL_PHALA=true` in the Phala compose file to get a real hardware quote.

**Why Vercel rewrites instead of env-var URL switching?**
`frontend/vercel.json` rewrites `/api/*` and `/admin/*` to the Phala CVM URL at the
CDN layer. The React code never changes — all `fetch("/api/...")` calls work identically
locally (proxied by Vite) and in production (rewritten by Vercel). No CORS, no build-time
env vars, no conditional logic.

**Why remove the hero/landing section from the frontend?**
A landing-page hero above the dashboard creates a jarring two-section layout. Stats now
live inline in the sticky header (bonded / at risk / slashed). The page opens directly
to the adjudication feed. The "AI agents that cheat lose their deposit." headline is a
compact one-liner below the header, not a full-viewport section.

**Frontend color palette (Phase 7):**
- Background: deep indigo `#0d0b24` — clearly purple, not black
- Glowing orbs: orange top-right `rgba(251,113,3,.18)`, cyan bottom-left `rgba(34,217,232,.12)`
- Slash / breach: `#fb7103` (vivid orange)
- Active / OK: `#22d9e8` (bright cyan)
- Oracle / system: `#c084fc` (soft violet)
- Cards: glassmorphism — `rgba(255,255,255,0.05)` + `backdrop-filter:blur(16px)` over the indigo

**Why split Claude's reasoning in VerdictHistory?**
Long unbroken paragraphs are hard to scan. The first sentence becomes a bold 14px
"finding" headline. The rest collapses behind a "▾ Full reasoning" toggle. Cards stay
compact by default; full rationale is one click away.

---

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/status` | Current phase, test count, next task |
| `/deploy` | Deploy ArcIDBond to hardhat (local smoke test) |
| `/test` | Run `npm test` and report failures |
| `/gating` | Run verify_gating.js to confirm proof-of-gating revert |
