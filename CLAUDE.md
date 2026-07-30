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
| Frontend hosting | Vercel — `frontend-five-eta-43.vercel.app` — Phase 7 |

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

**Never pass private keys as CLI arguments in any command.** Private keys must
only be read from `.env` files via environment variables. Added after a real
incident (post-submission — see CHANGELOG.md): a key passed via a `--key` flag
was echoed into a visible transcript twice — once by `npm run`'s own
command-echo, and once by a downstream error message that embedded the raw
argument value it was given. Every `scripts/cli/*.js` tool now uses
`requireEnvKey(VAR_NAME)` from `_lib.js`, which reads exclusively from
`process.env` and never accepts a key-shaped value from `argv`. If you add a
new script that needs a private key, use `requireEnvKey()` — do not add a
`--key`-style flag, no matter how convenient it seems for a one-off script.

**USYC allowlist:** USYC requires wallet allowlisting via Circle Support. Chase
this starting Day 0 — lead time is the only real risk. If allowlist hasn't arrived,
ship the USYC contract anyway (deployed + verified = stronger than a hand-wave).

---

## Cost Safety

**The consumer agent's main loop calls Claude on every cycle, unconditionally, on a timer —
not on click.** `consumer/src/index.js`'s `main()` runs `while (true) { runCycle(); sleep(POLL_INTERVAL_MS) }`
starting the instant `consumer && npm start` launches, independent of the oracle or frontend.
`runCycle()` always calls `adjudicate()` (one Claude call) — there is no "response looks fine,
skip the LLM call" path. Default `POLL_INTERVAL_MS=12000` (12s) → roughly **4-5 Claude calls/minute,
~5,800-7,200/day**, for as long as the process is running, whether or not anyone is watching.

- There is no `consumer/Dockerfile` — it was never meant to run as a persistent deployed service.
  Only the oracle is containerized for Phala (`oracle/Dockerfile`).
- **Never deploy the consumer agent as a persistent, unattended service** (Phala, a VM, a background
  process, etc.). Run it locally, only for as long as it takes to record a demo or test a cycle,
  then kill it (Ctrl+C).
- For a live/recorded demo of the full slash loop without running the consumer's timer at all, use
  `POST /admin/trigger-cycle` (oracle-side, one-shot, gated by `X-Fault-Token`) — it's a self-contained
  version of the same fault → adjudicate → slash flow, fired once per call instead of every 12s forever.
- If a live, always-on Phala deployment is wanted for judges to poke at, deploy the oracle alone.
  `/api/price` only spends money when something actually pays for it via Circle Gateway; the two
  routes that call Claude or move funds (`/admin/trigger-cycle`, `/admin/demo-pay`) are both gated
  by `X-Fault-Token` and rate-limited (see below) — a random visitor can't trigger either.
- **Set a real `FAULT_TOKEN` on Phala** before deploying — never leave the `dev-fault-token` default
  in a public deployment; it's the only thing standing between a visitor and a real Claude/slash call.

**Cost circuit breaker:** `oracle/src/index.js`'s `checkCooldown()` enforces a shared 5-minute
cooldown across `/admin/trigger-cycle` and `/admin/demo-pay`, independent of the `X-Fault-Token`
check. This bounds worst-case cost even if the token ever leaks or is guessed. The cooldown window
is deliberately longer than a full `trigger-cycle` run (re-bond + slash + recharge, each waiting on
testnet confirmation) — a shorter window doesn't actually stop back-to-back calls, since each one
can individually outlast a too-short cooldown before the previous call even finishes. (This was
found the hard way: an early 15s cooldown didn't block two real sequential `trigger-cycle` calls
during testing, because one full cycle took longer than 15s to complete — both went through,
each firing a real Claude call and a real on-chain slash on testnet.)

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
  └─ Live URL: https://9c3a144f929db3e05d05bb03839a04527bda9841-3001.dstack-pha-prod5.phala.network

Vercel Frontend (Phase 7)
  ├─ Deployed at https://frontend-five-eta-43.vercel.app (Vercel project "frontend" —
  |    the earlier "arcidv2" project no longer exists, was deleted/inaccessible)
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
consumer/src/settlement.js          Post-submission: Gateway settlement + ArcIDBond.recordSettlement() on clean verdict
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

Payment execution files (post-submission — see CHANGELOG.md):
```
consumer/src/settlement.js           executeSettlement() — Gateway payment + recordSettlement() on clean verdict
scripts/cli/settle.js                npm run bond:settle — standalone recordSettlement() demo/test CLI
CHANGELOG.md                         Transparency log for post-deadline commits
```

Session-key wallet hardening files (post-submission, Phase 6 — see CHANGELOG.md):
```
contracts/ConsumerSessionKeyGuard.sol   Bounds consumer agent's slash/settlement authority to a capped, expiring session key
contracts/interfaces/IArcIDBondSlash.sol Minimal slash()/recordSettlement() interface the guard calls
test/ConsumerSessionKeyGuard.test.js    22 tests: grant/revoke, guarded slash/settlement, cap, expiry, mutual exclusion
scripts/deploy_session_guard.js         Deploy guard against existing ArcIDBond; ACTIVATE_SESSION_GUARD=true flips authorizedSlasher
scripts/cli/session-key.js              npm run session:grant / session:revoke
consumer/src/slasher.js                 Routes through the guard when SESSION_GUARD_ADDRESS is set
consumer/src/settlement.js              Same — guardedRecordSettlement() instead of recordSettlement() directly
```

Deterministic payment gate files (post-submission, Phase 7 — see CHANGELOG.md):
```
consumer/src/paymentGate.js             gateGatewayPayment() + gateOnChainRecord() — non-LLM payee/amount/cap checks
consumer/src/settlement.js              Wires the gate as GatewayClient's onBeforePaymentCreation hook + a pre-flight
                                         check before recordSettlement()/guardedRecordSettlement()
```

Spend-velocity circuit breaker files (post-submission, Phase 8 — see CHANGELOG.md):
```
consumer/src/settlement.js              checkCircuitBreaker() — rolling 1m/1h spend vs MAX_SPEND_PER_*_USDC,
                                         tripped state persisted in settlement_ledger.json under "_circuitBreaker"
consumer/scripts/breaker.js             npm run breaker:status / breaker:resume — manual-only resume, no auto-recovery
```

Attributable audit trail files (post-submission, Phase 9 — see CHANGELOG.md):
```
consumer/src/auditTrail.js              writeAuditRecord() — one uniform-schema line per settlement attempt in
                                         settlement_audit.jsonl, regardless of outcome; resolves agentId from
                                         ArcIDRegistryV2 via agentIdBySigner() if REGISTRY_ADDRESS is set
consumer/src/settlement.js              Calls writeAuditRecord() at every exit path: settled, gated,
                                         circuit_breaker, payment_failed, onchain_failed, deduped
```

Tiered slash adjudication files (post-submission, tiered-adjudication doc, Phase 1 — see CHANGELOG.md):
```
consumer/src/deterministicVerifier.js   verifyDeterministic() — Tier 1: signature_valid, timestamp_fresh,
                                         schema_valid, attestation_current (optional; caveated "still
                                         registered", not a true lapse check — ArcIDRegistryV2 has no expiry).
                                         hard_breach short-circuits straight to slash, no LLM call at all.
                                         Own log channel: deterministic_breaches.jsonl
consumer/src/index.js                   Runs verifyDeterministic() before adjudicate(); Tier 2 (Claude) only
                                         ever sees responses that already passed every Tier 1 check
consumer/src/adjudicator.js             Phase 2: prompt forbids citing signature/timestamp/schema grounds
                                         (not just omits them); deliver_verdict schema replaces checks{} with
                                         breach_class + structured evidence[] (claim+category, not free prose);
                                         assertWithinJurisdiction() deterministically rejects any verdict that
                                         cites a Tier 1 ground anyway — same "gate it, don't just prompt it"
                                         pattern as paymentGate.js
consumer/src/slashGate.js               Phase 3: gateSlash() — payee, target (agent === response.oracle ===
                                         config), breach-classification, and verdict-hash binding, called by
                                         slasher.js before DEV_MODE branch. Own log channel:
                                         slash_failures.jsonl (stage: "slash-gate"); rejections also write a
                                         "gated" line to settlement_audit.jsonl via auditTrail.js. NOTE: as of
                                         Phase 4, ArcIDBond.slash() now DOES compute amount from a real
                                         on-chain formula — slashGate.js's own docstring still describes this
                                         as a Phase-4 dependency and has not yet been updated to reflect that
                                         Phase 4 has since shipped (cosmetic doc lag, not a functional gap;
                                         gateSlash()'s own checks are unaffected either way)
consumer/src/serviceId.js               serviceIdFor() extracted out of settlement.js so slashGate.js uses the
                                         identical "which interaction is this" definition, not a second copy
```

Proportional breach-class slashing files (post-submission, tiered-adjudication doc,
Phase 4 — see CHANGELOG.md):
```
contracts/ArcIDBond.sol                 BreachClass enum (Semantic/Hard), owner-tunable schedule config,
                                         BondInfo.amount now means REMAINING balance (decrements on partial
                                         slashes), _computeSlashAmount()/previewSlash() shared formula, never-
                                         zero floor, fixed-24h-window epoch escalation, permanent bond-contract
                                         blacklist (NOT a registry write — CLAUDE.md forbids touching the
                                         identity layer) on escalation. New events: BreachClassified,
                                         AgentEscalatedAndBlacklisted. AgentSlashed signature unchanged.
contracts/interfaces/IArcIDBondSlash.sol  Now the canonical home of the BreachClass enum; ArcIDBond formally
                                         `is IArcIDBondSlash` so the compiler enforces the two never drift
contracts/ConsumerSessionKeyGuard.sol   guardedSlash() gained a breachClass passthrough param (contract-layer,
                                         required to compile against the new slash() — in scope for Phase 4
                                         even though off-chain wiring is Phase 5's job)
test/ArcIDBondSlashClasses.test.js      25 new tests — the full plan reviewed and approved before this was written
```

Phase 5 wiring + demo CLI files (post-submission, tiered-adjudication doc,
Phase 5 — see CHANGELOG.md; resolves the breakage the Phase 4 entry above used to describe):
```
consumer/src/slasher.js                 breachClassFor(verdict) — maps verdict.tier
                                         ("deterministic"->Hard, else->Semantic) to the
                                         BreachClass enum; the one place this mapping lives
oracle/src/chain.js                     triggerCycle()'s local LLM adjudicator (VERDICT_TOOL,
                                         SYSTEM_PROMPT, adjudicate(), @anthropic-ai/sdk) REMOVED
                                         entirely — bad-sig is now a Tier 1 deterministic
                                         SIG_INVALID verdict, zero Claude calls, matching real
                                         consumer behavior instead of contradicting it
oracle/src/index.js                     new fault mode ?fault=bad-price — valid signature/
                                         timestamp/schema, semantically implausible value
                                         (99999999.99); the only fault that reaches Tier 2
scripts/cli/slash.js                    new required --breach-class <hard|semantic> flag;
                                         calls previewSlash() before sending, reads actual
                                         transferred amount from AgentSlashed after
consumer/package.json                   npm run demo:hard-breach / demo:semantic-breach
```
Both demo commands are live-verified against the redeployed contract
(`0x5E5eA9513f96A537AE966840F3355ff80824691d`) — see CHANGELOG.md's Phase 5
entry for exactly what was confirmed live vs. via a synthetic verdict
(the semantic path's live Claude call is blocked by an external
`ANTHROPIC_API_KEY` credential issue, not a wiring problem).

Deploy + admin CLI files (post-submission — see CHANGELOG.md's "Deployment +
Private-Key CLI Security Fix" entry):
```
scripts/deploy_bond_v2.js               Deploys ArcIDBond alone, pointed at the EXISTING
                                         ArcIDRegistryV2 (read from deployments/<net>_standalone.json,
                                         NEVER from the stale root .env ARCID_REGISTRY_ADDRESS)
scripts/cli/set-authorized-slasher.js   npm run bond:set-slasher — requires DEPLOYER_PRIVATE_KEY (owner)
scripts/cli/transfer-ownership.js       npm run bond:transfer-ownership — single-step (plain Ownable,
                                         not Ownable2Step) — double-check --new-owner, no undo
scripts/cli/_lib.js                     requireEnvKey() / normalizePrivateKey() — see the private-key
                                         rule above; getProvider() now pins a static network (skips
                                         eth_chainId probing, reduces RPC rate-limit pressure)
```

Optimistic challenge window files (post-submission, arcid2 Phase 6, Phase 6.1 —
see CHANGELOG.md):
```
contracts/ArcIDBond.sol                 DisputeState enum, Dispute struct, challengeThreshold/disputeWindow
                                         (owner-tunable), disputes mapping, nextDisputeId. slash()'s body
                                         extracted unchanged into _executeSlash() (shared with dispute
                                         resolution); previewSlash()'s body extracted into _previewSlash()
                                         (shared by 3 callers). slash() gained a threshold gate — non-
                                         escalating Semantic amounts above challengeThreshold now revert
                                         ChallengeThresholdExceeded. New: fileIndictment() (authorizedSlasher-
                                         only, records a dispute, does NOT move funds), resolveDispute()
                                         (owner-only interim resolver — NatSpec states verbatim this is a
                                         placeholder, not the end state), finalizeExpiredDispute()
                                         (permissionless, the actual "optimistic" default-execute path),
                                         setChallengeParameters(). New events: IndictmentFiled,
                                         DisputeResolved, ChallengeParametersUpdated. New internal
                                         _executeSlashOrVoid() — used ONLY by resolveDispute()/
                                         finalizeExpiredDispute(), never slash() — returns 0 without
                                         reverting if the agent was already fully slashed by an unrelated
                                         event, so a moot claim closes the dispute cleanly instead of
                                         reverting and stranding it Indicted forever on the permissionless
                                         finalize path. Still-open, narrower gap left deliberately unfixed:
                                         voluntary withdrawBond() (postedAt->0, not slashed=true) while a
                                         dispute is pending still reverts NoBondFound on approval.
test/ArcIDDispute.test.js               27 tests — the mutually-exclusive slash()/fileIndictment()
                                         partition, escalation always bypassing the gate, fresh-recompute-
                                         at-resolution (proven via an intervening Hard breach shrinking the
                                         bond between indictment and resolution), and the closed stuck-
                                         dispute gap: agent hard-slashed to full-drain while a dispute is
                                         pending, then finalizeExpiredDispute() called after the window
                                         passes — asserted against the real failure mode (no revert,
                                         consumer balance unchanged by that call, dispute reads back
                                         Resolved not stuck Indicted, a second call reverts
                                         DisputeNotIndicted proving it's truly closed), not just "didn't
                                         crash". Mirrored for resolveDispute(id, true) directly; rejection
                                         confirmed unaffected either way.
```
Extended `ArcIDBond.sol` directly rather than a companion `ArcIDDispute.sol`
— the dispute path needs `_computeSlashAmount()`, `bonds`/`breachEpochs`/
`blacklisted`, and the same escalation bookkeeping `slash()` already has,
all `internal` to `ArcIDBond`; splitting it out would mean exposing all of
that as a second privileged cross-contract surface for no real benefit.
Off-chain wiring (`slashGate.js`), CLI dispute-resolution tooling, and
live-verified demo commands are later phases of the same doc, not yet built.

---

## ArcIDBond Contract Events

These events are the source of truth for the frontend live counters.
**Never poll a log file — read on-chain events.**

| Event | Fields | Frontend use |
|-------|--------|-------------|
| `BondPosted(agent, amount, token)` | agent wallet, USDC amount (6 dec), token addr | TVL counter, agent card badge |
| `AgentSlashed(agent, consumer, amount, reason)` | all parties, amount, LLM rationale | Slash counter, badge flip, rationale display. Signature unchanged by Phase 4 (tiered-adjudication, post-submission) — `amount` is now the proportional/capped amount that specific call transferred, not always the full bond |
| `BreachClassified(agent, breachClass, amount, epochBreachCount, escalated)` | class, amount, rolling-24h count, escalation flag | Post-submission Phase 4 (see CHANGELOG.md) — richer companion to `AgentSlashed` |
| `AgentEscalatedAndBlacklisted(agent, amountTaken, breachClass)` | fires only on full-drain escalation | Post-submission Phase 4 — "this agent is now permanently done" signal |
| `PaymentSettled(agent, consumer, amount, verdictHash)` | all parties, amount, off-chain verdict hash | Post-submission (see CHANGELOG.md) — "no breach" counterpart to `AgentSlashed`; does not move funds |
| `BondWithdrawn(agent, amount)` | agent, amount | TVL update |
| `SlasherUpdated(old, new)` | wallet addrs | Admin audit |
| `IndictmentFiled(disputeId, agent, consumer, claimAmount, challengeDeadline, rationaleHash)` | dispute id, parties, indictment-time amount, deadline, evidence hash | Post-submission Phase 6.1 (see CHANGELOG.md) — a large semantic slash held pending dispute instead of executing |
| `DisputeResolved(disputeId, approved, amountTransferred, autoFinalized)` | dispute id, outcome, actual transferred amount, whether it was owner-resolved or deadline-finalized | Post-submission Phase 6.1 — closes out an `IndictmentFiled`; `amountTransferred` is 0 on rejection |
| `ChallengeParametersUpdated(challengeThreshold, disputeWindow)` | new threshold/window | Post-submission Phase 6.1 — admin audit |

---

## Test Suite (131 passing — run with `npm test`)

```
test/ArcIDBond.test.js
  construction            1   collateralToken / registry / authorizedSlasher
  postBond                8   success, BondPosted event, USDC transfer, gating revert,
                              ZeroAmount, BondAlreadyActive, re-bond after slash
  slash                   7   USDC transfer to consumer, mark slashed, AgentSlashed event
                              with rationale, NotAuthorizedSlasher, NoBondFound,
                              AlreadySlashed, isActiveBondedAgent after slash
                              (this file forces escalation threshold=1 so "one call = full
                              bond, slashed=true" stays valid post-Phase-4 — see
                              ArcIDBondSlashClasses.test.js for the proportional math itself)
  recordSettlement        7   PaymentSettled event, no funds moved, NotAuthorizedSlasher,
                              NoBondFound, AlreadySlashed, AlreadySettled, mutually
                              exclusive with slash() (post-submission — see CHANGELOG.md)
  withdrawBond            5   success, BondWithdrawn event, record delete, NoBondFound, AlreadySlashed
  isActiveBondedAgent     3   false/true/false across lifecycle
  setAuthorizedSlasher    4   success, event, OwnableUnauthorizedAccount, new slasher works

ArcIDBond — USYC yield-bearing collateral (Phase 5)  [test/ArcIDBondUSYC.test.js]
  basic USYC bond         4   accepts USYC, BondPosted event, $5 face value, TEE-gating still applies
  yield-bearing           4   value increases after simulateYield, 490bps APY, monotonic price, YieldAccrued event
  slash                   3   consumer gets USYC, worth > $5 after yield, agent can re-bond
  withdrawal              1   agent gets USYC back; redeems for more USDC via Teller
  multi-agent             1   two bonds coexist, yield accrues on both (TVL tracking)

ConsumerSessionKeyGuard (post-submission, Phase 6 — see CHANGELOG.md)  [test/ConsumerSessionKeyGuard.test.js]
  construction            2   bond/owner set, no active session by default
  grantSessionKey         4   fields set, event, non-owner revert, overwrite
  revokeSessionKey        4   cleared, event, non-owner revert, revoked key blocked
  guardedSlash            6   fixed payout (not attacker-chosen), event, bond marked slashed,
                               NotSessionKey, SessionExpired, session key has no direct bond authority
  guardedRecordSettlement 6   within cap, event, AmountExceedsCap, cap boundary, NotSessionKey,
                               AlreadySlashed mutual exclusion holds through the guard

ArcIDBond — proportional breach-class slashing (post-submission, tiered-adjudication
Phase 4 — see CHANGELOG.md)  [test/ArcIDBondSlashClasses.test.js]
  cap boundaries — semantic   3   bondCap binds, k*fee binds, exact tie boundary — real
                                  numbers ($5 bond, $0.001 fee) pulled from testnet, not assumed
  cap boundaries — hard       2   10% of bond independent of fee, hard cap >= semantic cap
  cap boundaries — general    2   never-zero floor on dust bonds, never exceeds capBps share
  epoch escalation            7   independent hard/semantic counters, 24h rollover reset,
                                  no escalation below threshold, full-drain at threshold,
                                  drains REMAINING not original bond, blacklist blocks
                                  postBond(), positive case: non-escalated depletion allows re-bond
  can't-exceed-cap invariant  4   slash() ABI has no amount param, previewSlash() matches
                                  actual transfer, guard's maxAmountPerCall never bounded slash
                                  (only ever applied to recordSettlement), parametrized sweep
                                  across 5 bond sizes x both classes
  events                      3   BreachClassified fields, AgentEscalatedAndBlacklisted only
                                  on escalation, not emitted otherwise
  admin setters               4   InvalidBps, InvalidThreshold, events, non-owner reverts

ArcIDBond — optimistic challenge window (post-submission, arcid2 Phase 6.1
— see CHANGELOG.md)  [test/ArcIDDispute.test.js]
  slash() threshold gate      4   instant below threshold, ChallengeThresholdExceeded above it,
                                   Hard never gated, escalation never gated even when large
  fileIndictment()            8   records dispute + IndictmentFiled, NotAuthorizedSlasher,
                                   ChallengeThresholdNotExceeded, EscalatingBreachNotDisputable,
                                   NoBondFound, AlreadySlashed, disputeId increments, does NOT
                                   mutate breachEpochs at indictment time
  resolveDispute()            9   owner approval executes + transfers, owner rejection leaves
                                   bond untouched, non-owner revert, unknown/already-resolved
                                   disputeId, fresh recompute at resolution (not the stored
                                   claimAmount); the drained-bond race: approval against an
                                   already-slashed agent gracefully voids (does NOT revert —
                                   _executeSlashOrVoid(), amountTransferred=0, dispute reads
                                   back Resolved not stuck), explicit rejection confirmed
                                   unaffected either way, finalizeExpiredDispute() proven to
                                   gracefully void the identical case (not just "doesn't
                                   crash" — balance unchanged, state=Resolved, and a second
                                   call reverts DisputeNotIndicted, proving it's truly closed)
  finalizeExpiredDispute()    3   ChallengeWindowNotExpired before deadline, permissionless
                                   auto-execute after deadline, DisputeNotIndicted if already resolved
  admin setChallengeParameters 3  updates + event, InvalidDisputeWindow on zero, non-owner revert
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

1. `oracle/src/attest.js` builds a 592-byte prototype TDX DCAP v4 quote for local dev. Set `USE_REAL_PHALA=true` to connect to the dstack guest agent over its Unix socket via `@phala/dstack-sdk` (`DstackClient`) — the agent is **not** exposed over TCP/HTTP; an earlier version of this file assumed an HTTP fetch to `PHALA_ENDPOINT`, which fails with a connection error in production. The socket must be volume-mounted into the container (`oracle/docker-compose.phala.yml`'s `volumes:` — currently guesses `/var/run/dstack.sock`; if wrong for a given dstack version, `/var/run/tappd.sock` is the older name to try).
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
- `postBond()` MUST revert for any blacklisted wallet (post-submission Phase 4 — see CHANGELOG.md). Blacklisting is bond-contract-local only; it never writes to `ArcIDRegistryV2`.
- `slash()` MUST only be callable by `authorizedSlasher`. No consumer can slash without authorization.
- `slash()` on an already-slashed agent MUST revert. No double-slash.
- `slash()` MUST compute its amount internally from on-chain config/state only (post-submission Phase 4). No caller — not even `ConsumerSessionKeyGuard` — may supply or influence the transferred amount. `slash()`'s ABI has no `amount` parameter; this is enforced structurally, not just by convention.
- A single `slash()` call below its breach class's rolling-24h escalation threshold MUST NOT transfer more than that class's `capBps` share of the *remaining* bond. Only an escalating call (threshold crossed) may take the full remainder — and doing so MUST also permanently blacklist the agent.
- Bond amount MUST be transferred to contract on `postBond`, to consumer on `slash` (now the internally-computed proportional or full-drain amount, not always the full bond), back to agent on `withdraw` (whatever currently remains). No funds stuck in contract.
- A non-escalating Semantic breach whose computed amount exceeds `challengeThreshold` MUST NOT execute via `slash()` — it MUST revert `ChallengeThresholdExceeded` (post-submission Phase 6.1). The only paths to move funds for such a breach are `resolveDispute()` (owner-approved) or `finalizeExpiredDispute()` (deadline passed, unresolved). Hard breaches and any escalating breach are NEVER subject to this gate, at any size — enforced on-chain, not just by off-chain convention.
- `resolveDispute()`/`finalizeExpiredDispute()` MUST recompute the slash amount fresh via `_computeSlashAmount()` at resolution time — never trust the `claimAmount` stored at indictment time. A bond-state change between indictment and resolution must be reflected in what actually transfers.
- `finalizeExpiredDispute()` (permissionless) MUST NOT revert when the underlying agent was already fully slashed by an unrelated event before it's called — it MUST close the dispute out (`state = Resolved`, `DisputeResolved(id, true, 0, true)`) instead. Being permissionless is exactly why a revert here is unacceptable: there would be no one obligated to notice and clean it up. `resolveDispute(id, true)` MUST behave identically for the same reason. `resolveDispute(id, false)` (explicit rejection) is unaffected either way — it never touches the slash-execution path.

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
