# Changelog

## Post-submission: Payment Execution (2026-07-23)

**Context.** The submission form locked on 2026-07-06. Judging had not
started and no winner date had been announced as of this addition. A
program organizer confirmed judges track commit activity "before the end
of the event," and a Discord thread independently confirmed continued
building during the (extended) event window is expected and encouraged.
This entry logs that addition transparently, on the record, rather than
leaving it unremarked in the commit history.

**What was added.** Before this work, a clean ("no breach") adjudication
verdict had no on-chain consequence at all — the loop closed on breach
(slash) but not on success. These four phases close that gap: a real Circle
Gateway settlement now fires on a clean verdict, with the same on-chain
audit-trail quality the slash path already had.

| Commit | Date | What |
|--------|------|------|
| `958bd4e` | 2026-07-23 | `docs:` clarify TDX attestation boundary vs external payment settlement — written statement of the existing split between what runs inside the TEE (attestation only) and what runs outside it (signing, adjudication, payment), so the payment work below builds on a documented boundary rather than an implicit one. |
| `4fe6135` | 2026-07-23 | `feat:` execute real Gateway settlement on successful SLA verdict — new `consumer/src/settlement.js`, fired from the consumer agent's post-verdict handler (never from the oracle), gated on `verdict === "ok"`, deduped on `serviceId + verdictHash`, with payment failures logged to a channel separate from the slash audit trail. |
| `fa7f6ff` | 2026-07-23 | `feat:` gate payment execution against bond/slash verdict outcome — `ArcIDBond.sol` gained `recordSettlement()` / `PaymentSettled`, the "no breach" counterpart to `slash()` / `AgentSlashed`. Reverts `AlreadySlashed` if the agent's bond was already slashed, so payment-logging and slashing are mutually exclusive on-chain, not just by convention in the consumer agent's code. 7 new tests (57 passing total). |
| `ddaaf46` | 2026-07-23 | `feat:` add payment execution step to CLI demo flow — `npm run bond:settle`, a standalone way to demo/test `recordSettlement()` without running the full consumer loop; added a beat to the `SUBMISSION.md` video script. |

**Why during the event window and not before the deadline:** the payment
path was scoped and built after 2026-07-06, phase by phase, with each phase
landing as its own commit (table above) so the addition is auditable
commit-by-commit rather than as one undifferentiated drop.

**What this doesn't change:** the original submission's core claims —
TEE-gated identity, USYC yield collateral, LLM-reasoned slash adjudication —
were all complete and demoed before the form deadline. This work only adds
the symmetric "pay on success" half of the loop; it does not retroactively
alter any of the pre-deadline traction numbers or test results reported in
`SUBMISSION.md`.

---

## Post-submission: Session-Key Wallet Hardening (2026-07-28)

**Context.** Same post-form-lock, extended-event-window basis as the entry
above. Continuation of the payment-execution scoping doc's Phase 6.

**What was added.** Before this, the consumer agent's wallet was a standard
EOA with unbounded on-chain authority — `ArcIDBond.slash()` takes an
arbitrary `consumer` address, so a leaked `CONSUMER_PRIVATE_KEY` could drain
*any* bonded agent's full collateral to an attacker-chosen wallet, not just
misuse a payment. This phase adds `contracts/ConsumerSessionKeyGuard.sol`,
which becomes `ArcIDBond`'s `authorizedSlasher` in place of the raw EOA and
issues the running consumer agent a bounded, revocable session key instead:

- **Fixed payout address** — set once by the (offline) owner key at grant
  time; the session key cannot redirect slash or settlement proceeds
  anywhere else.
- **Capped amount** — `recordSettlement()` calls above a configured cap
  revert (`AmountExceedsCap`).
- **Single target contract** — the guard only ever calls `ArcIDBond`; there
  is no general-purpose `execute(target, data)` escape hatch.
- **Expiry** — sessions lapse on a timestamp; no silent auto-renewal.

`consumer/src/slasher.js` and `consumer/src/settlement.js` route through the
guard automatically when `SESSION_GUARD_ADDRESS` is set in `.env`, and fall
back to the pre-Phase-6 direct-call behavior when it's unset — this is
additive, not a breaking change to the existing setup. 22 new tests
(`test/ConsumerSessionKeyGuard.test.js`), 79 passing total.

**Explicit scope limitation, stated rather than hidden:** this hardens the
on-chain call surface only (`slash()` / `recordSettlement()`). Circle
Gateway payments are authorized off-chain via EIP-712 signatures relayed
through Circle's API — a different authority model a session-key guard on
the wallet's own on-chain call surface does not reach. A full ERC-4337
smart-account migration (the literal ask in the original scoping doc) was
scoped down to this guard-contract approach instead, because Arc testnet's
ERC-4337 bundler/paymaster infrastructure availability wasn't verified
within this work window, and a self-contained, Hardhat-testable guard
contract was the higher-confidence way to ship the actual security property
(bounded, revocable, non-redirectable authority) rather than depending on
unverified external infra. Noted here rather than silently substituted.

---

## Post-submission: Deterministic Payment Gate (2026-07-28)

**Context.** Same post-form-lock, extended-event-window basis as the entries
above. Continuation of the payment-execution scoping doc's Phase 7, and it
directly closes the gap the Phase 6 entry above flagged and left open: "Circle
Gateway payments are authorized off-chain via EIP-712 signatures... a
different authority model a session-key guard... does not reach."

**What was added.** The adjudicator's verdict is Claude reasoning over
oracle response content that's untrusted the same way any network input is.
`adjudicator.js`'s `deliver_verdict` tool schema has no payee/amount field —
Claude cannot emit one today — but that was safety by omission, not an
enforced invariant. `consumer/src/paymentGate.js` makes it an enforced one:

- **`gateGatewayPayment()`** — registered as `GatewayClient`'s
  `onBeforePaymentCreation` hook in `settlement.js`. Runs *before* the buyer
  signs any EIP-712 payment authorization, independently checking the 402
  response's `payTo` and `amount` — both server-supplied, i.e. untrusted —
  against the known oracle wallet and the agreed `PRICE_USDC`. This is the
  piece that actually reaches the Gateway signing path Phase 6 explicitly
  said it didn't cover.
- **`gateOnChainRecord()`** — a synchronous pre-flight check immediately
  before `recordSettlement()` / `guardedRecordSettlement()`, re-confirming
  the same payee/amount right before the on-chain write.

Both throw/abort on any mismatch against a hard per-call cap
(`MAX_SETTLEMENT_USDC`) in addition to requiring an exact price match —
belt-and-suspenders alongside, not a replacement for, the Phase 6 guard's
own on-chain cap. A gate rejection is logged to its own `stage:
"payment-gate"` entry in the existing settlement-failure log, distinct from
both a plain payment failure and an SLA breach.

**Verification:** unit-level checks against both functions (correct
payee/amount passes; wrong payee, wrong amount, and over-cap amount all
reject/throw) — run manually since `consumer/` has no wired test runner yet;
not added to the Hardhat suite because this module has no on-chain
component to exercise there.

---

## Post-submission: Spend-Velocity Circuit Breaker (2026-07-28)

**Context.** Same post-form-lock, extended-event-window basis as the entries
above. Continuation of the payment-execution scoping doc's Phase 8.

**What was added.** The per-call caps from Phases 6 and 7 stop any single
settlement from being too large, but neither one notices *many* small,
individually-legitimate settlements firing in a short window — a consumer
agent stuck retrying or re-adjudicating the same interaction would pass
every per-call check while still draining the budget. `settlement.js` gained
`checkCircuitBreaker()`, called before every settlement attempt (real or
simulated):

- Sums this same settlement ledger's recorded spend — the "same ledger used
  for idempotency" from Phase 2.3, exactly as scoped, no separate
  subsystem — over rolling 1-minute and 1-hour windows
  (`MAX_SPEND_PER_MINUTE_USDC`, `MAX_SPEND_PER_HOUR_USDC`).
- If adding the incoming call would cross either window's cap, it trips: a
  `_circuitBreaker` entry (namespaced so it can never collide with a
  `serviceId:verdictHash` dedupe key) is written into the ledger and the
  call is refused.
- Every subsequent settlement call checks that flag first and refuses
  immediately without recomputing, logging each trip/resume to a new
  `circuit_breaker_alerts.jsonl` — a distinct log channel from both
  payment failures and SLA breaches, per the project's existing rule that
  failure classes don't get merged.
- **No automatic recovery.** `resumeCircuitBreaker()` is the only way to
  clear a trip, exposed via `npm run breaker:status` / `npm run
  breaker:resume` (in `consumer/`) — a human has to look at why it tripped
  and decide it's safe to continue.

DEV_MODE settlements now record a notional `PRICE_USDC`-equivalent amount in
the ledger (previously `null`) specifically so the breaker's rolling-spend
math is exercisable and demoable without a funded testnet wallet — this
doesn't change what DEV_MODE actually does (still no real funds move, still
`simulated: true`).

**Verified:** ran a simulated runaway loop (6 settlement calls with a
deliberately low per-minute cap) — the first 3 calls succeeded up to the
cap boundary, the 4th tripped the breaker, calls 5–6 stayed refused
referencing the same trip, `breaker:status`-equivalent reporting matched,
and `resumeCircuitBreaker()` correctly cleared it and logged the prior trip.

---

## Post-submission: Attributable Audit Trail (2026-07-28)

**Context.** Same post-form-lock, extended-event-window basis as the
entries above. Continuation of the payment-execution scoping doc's Phase 9
— the last phase in that doc's original scope.

**What was added.** `ArcIDBond.slash()` already gives the breach path a
first-class, queryable record: the `AgentSlashed` event with Claude's
written rationale attached, on-chain, permanently. Before this phase, the
payment path's provenance was scattered across three separate files —
`settlement_ledger.json` (successful/deduped only), `settlement_failures.jsonl`
(payment/on-chain failures only), `circuit_breaker_alerts.jsonl` (trips/resumes
only) — with no single record per attempt and no link back to the
TEE-attested agent identity. "The agent paid, trust us," not the standard
the slash flow meets.

`consumer/src/auditTrail.js`'s `writeAuditRecord()` is now called from
every exit path of `executeSettlement()`:

| Outcome | When |
|---|---|
| `settled` | Gateway payment (real or DEV_MODE-simulated) + on-chain audit write both succeeded |
| `gated` | Refused by the Phase 7 deterministic payee/amount gate, either before signing or before the on-chain write |
| `circuit_breaker` | Refused by the Phase 8 spend-velocity breaker |
| `payment_failed` | Gateway payment itself failed for a reason other than the gate |
| `onchain_failed` | Payment succeeded but the on-chain audit write failed for a reason other than the gate |
| `deduped` | Already settled for this exact service interaction (Phase 2.3 idempotency) |

Every line in `settlement_audit.jsonl` carries the same fixed schema
regardless of outcome: `agentId`, `agent`, `payee`, `verdictHash`,
`serviceId`, `amount`, `txHash` (Gateway), `onChainTx` (ArcIDBond/guard),
`simulated`, `outcome`, `reason`, `at`. `agentId` resolves the oracle
wallet's real on-chain identity via `ArcIDRegistryV2.agentIdBySigner()` —
a free view call, cached per process — when `REGISTRY_ADDRESS` is
configured; consumer/ previously had no knowledge of the registry contract
at all, so this is new wiring, not a rename of an existing field. Audit
writes never throw — a failure to log must never mask or block the
settlement outcome it's describing (logs a console warning and continues).

This is additive to, not a replacement for, the three existing per-class
logs — Phase 2.4's rule that failure classes don't get merged still holds
for those. `settlement_audit.jsonl` is the flat, uniform index across all
of them: one file answers "what happened to this clean verdict's payment"
without knowing which of the other three to check.

**Verified:** ran four settlement attempts against a shared ledger —
two fresh DEV_MODE settlements, a retry of the first (correctly deduped),
and a fourth that crossed a deliberately low per-minute cap (correctly
blocked by the circuit breaker) — and confirmed all four produced exactly
one audit line each, with the right `outcome` and fields, in
`settlement_audit.jsonl`.

**This closes out the original payment-execution scoping doc.** Phases
1–5 closed the pay-on-success loop; Phases 6–9 hardened it (session-key
wallet scoping, a deterministic anti-injection gate, a spend-velocity
breaker, and now an attributable audit trail matching the slash path's
standard). All nine phases shipped during the post-deadline, extended
event window, each logged here as it landed.

---

## Post-submission: Tiered Adjudication — Phase 1, Deterministic Verifier (2026-07-30)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. First phase of a new scoping doc (`arcid2-tiered-adjudication`)
that restructures the slash path itself — the older, higher-stakes half of
the system the payment-side hardening (Phases 6–9) didn't touch. Decision:
replace "Claude verdict → slash()" with two tiers — a deterministic
verifier that slashes instantly on mechanically-checkable failures with no
LLM in the loop, and Claude narrowed to the genuinely ambiguous semantic
residue (narrowing lands in a later phase). This is the same pattern
already shipped on the payment side (Phase 7's `paymentGate.js` sitting
between Claude and settlement), applied here to the slash path.

**What was added.** `consumer/src/deterministicVerifier.js` runs on every
oracle response before any adjudicator call, with four checks:

- **signature_valid** — reuses `verifier.js`'s existing signature recovery;
  no logic duplicated.
- **timestamp_fresh** — same freshness math previously inlined in
  `adjudicator.js`, now owned by the verifier.
- **schema_valid** — new: response shape/type validation (value
  numeric-parseable, timestamp a number, oracle address-shaped,
  `sla.max_age_seconds` present).
- **attestation_current** — new, optional (only when `REGISTRY_ADDRESS` is
  configured): confirms the oracle wallet still resolves to a registered
  `agentId` in `ArcIDRegistryV2`. **Caveat stated in the code and repeated
  here at the same transparency standard as the rest of this log:**
  `ArcIDRegistryV2` has no expiry or deregistration concept today —
  registration is permanent once made. This check verifies "still resolves
  to a registered agentId right now," not a true lapse/expiry. A genuine
  attestation-expiry mechanism would require a registry contract change,
  which is out of scope here and not silently implied by the field name.

Any failure produces a `hard_breach` with a machine-generated code
(`SIG_INVALID` / `TIMESTAMP_STALE` / `SCHEMA_FAIL` / `ATTESTATION_LAPSED`),
logged to its own `deterministic_breaches.jsonl` channel (per this
project's existing rule that failure classes don't get merged), and routed
straight to slash — Claude is never called. Everything that passes flows
unchanged to the existing `adjudicate()`.

**Behavior change, stated rather than left implicit:** the pre-tiering
system asked Claude to show "restraint" on the null/malformed-response
fault (verdict: `uncertain`, no slash) as a deliberate demonstration of
adjudicator judgment — see `SUBMISSION.md` Beat 3 and the Phase 3 README
section. Under Tier 1, a null signature and a null value are both
mechanically-checkable facts, not judgment calls — the "was this malice or
a blip" question moves to epoch-based escalation (a later phase of this
doc) rather than a per-incident LLM guess. The `null` fault mode now
hard-breaches instantly with zero LLM calls in the trace, which is the
literal point of this redesign, not a regression from the earlier demo.

**Verified live** against the running oracle: `npm run fault:stale`
produced a genuine Tier 1 hard breach (`TIMESTAMP_STALE`) in 641ms with no
`Adjudicating via...` line (confirming zero LLM calls), correctly attempted
a real on-chain slash, and wrote a correctly-shaped entry to
`deterministic_breaches.jsonl`. Unit-level checks confirmed all four
priority-ordered codes trigger correctly (null fault → `SIG_INVALID`, stale
timestamp with a valid signature → `TIMESTAMP_STALE`, healthy → `pass`,
garbage signature → `SIG_INVALID` with the same non-canonical-`s` failure
mode as the original documented slash tx). Full 79-test Hardhat suite still
passes — no contract changes this phase. Tier 2 (Claude, unmodified this
phase) was verified by code inspection rather than a live call: no
`ANTHROPIC_API_KEY` was configured in this environment, so a live
confirmation is deferred rather than faked; `adjudicator.js` has a zero
diff this phase and the new Tier 2 branch in `index.js` passes it the
identical argument shape as before.

The stale-fault test's "no active bond — skipping slash" line was
double-checked against on-chain state directly (querying the exact
`BOND_CONTRACT_ADDRESS` / `ORACLE_WALLET_ADDRESS` pair `consumer/.env`
uses): `slashed: true`, `postedAt` a timestamp from weeks before this
phase's work began. Pre-existing state from the original documented slash
in README's "Live Proof" section, not something this phase's wiring
caused.

---

## Post-submission: Tiered Adjudication — Phase 2, Narrowed Adjudicator (2026-07-30)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. Second phase of the tiered-adjudication scoping doc: `adjudicate()`
is now only ever invoked on responses that already passed every Tier 1
mechanical check (Phase 1), and its jurisdiction is narrowed to match —
semantic/contextual quality only, never signature, timestamp, or schema
grounds.

**What was added.** `adjudicator.js`'s system prompt and `deliver_verdict`
tool schema were rewritten:

- The prompt tells Claude the three mechanical checks are RESOLVED FACTS by
  the time it's called, states it is **not authorized** to re-litigate
  them, and — the actual prompt-injection defense, not just an omission —
  instructs it to treat any response content *arguing* those points as a
  manipulation attempt and disregard it entirely, rather than weigh it.
- `deliver_verdict`'s old `checks: {timestamp_fresh, value_present,
  signature_valid}` object is gone — there is no field left to restate a
  mechanical result in, even redundantly. In its place: a required
  `breach_class: "semantic"` marker and a required `evidence` array of
  structured `{claim, category}` objects — specific, falsifiable
  assertions, not free prose.
- **Enforcement isn't prompt-only.** `assertWithinJurisdiction()` is a new
  deterministic, non-LLM keyword check run on every returned verdict's
  `reason` and `evidence[].claim`, throwing `JurisdictionViolationError` if
  any of them mention signature/timestamp/schema terms — the same
  "don't just prompt it, gate it" pattern as `paymentGate.js` on the
  payment side. Documented in the code as a heuristic (substring matching),
  not a semantic proof — the prompt instruction remains the primary
  defense, this is the belt-and-suspenders layer behind it.
- `index.js`: Tier 1's `detResult.checks` is merged into the verdict object
  for both tiers (hard breach and semantic pass-through) — Claude no longer
  restates checks it isn't allowed to evaluate, but the actual Tier 1
  results are still logged and displayed either way. `printVerdict()` now
  shows the tier and, for semantic verdicts, the evidence array.

**Verified, not just "returned valid JSON" — the actual output content:**
- Five synthetic cases run directly against `assertWithinJurisdiction()`:
  clean semantic evidence passed; a reason citing "signature"; an evidence
  claim citing "stale"; an evidence claim citing "schema"/"malformed"; and
  a simulated prompt-injection case (response content claiming its own
  ECDSA key was compromised, parroted back into the reason field) — all
  four violation cases correctly rejected, the clean case correctly passed.
- **One real Claude call**, a healthy oracle response end-to-end through
  the full consumer loop: verdict `ok`, empty `evidence` array (valid for
  a clean verdict), `breach_class: "semantic"`, reasoning grounded entirely
  in ETH/USD price-range plausibility, zero mention of signature/timestamp/
  schema.
- **One real Claude call engineered to trigger an actual semantic breach**
  (a $99,999,999.99 "price," an obvious sentinel/placeholder value):
  returned `verdict: "breach"`, `should_slash: true`, and a genuinely
  structured two-item `evidence` array (`price_plausibility` +
  `content_mismatch`, each a specific falsifiable claim) — confirmed by
  reading the raw returned object, not inferred from a summary. Zero
  mention of signature/timestamp/schema in either evidence claim, and the
  call passed `assertWithinJurisdiction()` for real, not just in the
  synthetic tests above.
- Full 79-test Hardhat suite still passes — no contract changes this phase.

**Unrelated issue surfaced, noted rather than silently left out:** the
healthy-cycle live test's settlement step failed with `Missing
PAYMENT-REQUIRED header in 402 response` — a Gateway/x402 configuration
issue in this local oracle instance, occurring after adjudication
completed correctly. Not caused by and out of scope for this phase; flagged
for follow-up.

**Two items tracked as outstanding rather than left to fall through the
cracks:**
- `assertWithinJurisdiction()`'s keyword heuristic only catches literal
  mentions of "signature"/"timestamp"/"schema" and their close synonyms —
  a paraphrase that argues the same forbidden ground without the trigger
  words (e.g. "the data is too old to trust" instead of "timestamp stale")
  is not caught. Not a blocker: the system prompt's explicit prohibition is
  the primary defense, this is a narrower net behind it. Candidate for a
  future hardening pass: have Claude self-flag, as a required schema field,
  whether its evidence relies on anything already Tier-1-verified, instead
  of relying purely on post-hoc keyword matching. Documented in
  `adjudicator.js` next to the check itself.
- `SUBMISSION.md` Beat 3's fault-injection half is flagged (⚠, not deleted
  or rewritten) as narrating behavior that no longer happens post-tiering.
  Deliberately left unrewritten until tiered-adjudication Phase 5 ships
  `demo:hard-breach`/`demo:semantic-breach`, rather than patched against
  commands that don't exist yet. Tracked as a checklist item in
  `SUBMISSION.md`'s Pre-submission Checklist so it isn't only a comment
  buried in the video script — revisit when Phase 5 lands.

---

## Post-submission: Tiered Adjudication — Phase 3, Slash Gate (2026-07-30)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. Third phase of the tiered-adjudication doc: the exact mirror
of Phase 7's `paymentGate.js`, now sitting between an adjudication verdict
(either tier) and the `slash()` call — the older, higher-stakes half of
the system that Phases 6–9 hadn't touched.

**What was added.** New `consumer/src/slashGate.js`, called by
`slasher.js`'s `executeSlash()` before the `DEV_MODE` branch (so violations
are demonstrable without a funded testnet wallet, same reasoning Phase 8
applied to the circuit breaker):

- **Payee** — the consumer address must equal `config.CONSUMER_WALLET_ADDRESS`
  exactly. Already true everywhere this is called from; now an enforced
  invariant instead of an implicit one.
- **Target** — the agent about to be slashed must be the same address that
  actually produced/signed the response (`agentAddress === oracleResponse.oracle
  === config.ORACLE_WALLET_ADDRESS`) — a manipulated verdict can't redirect
  punishment to a different bonded agent than the interaction was actually with.
- **Breach classification — HONEST LIMITATION, stated up front, same
  standard as every other gap logged in this file:** the doc's spec calls
  for validating the slash amount against "the deterministic formula's
  output for this breach class," but that formula is Phase 4 (not yet
  shipped) — `ArcIDBond.slash()` today has no `amount` or `breachClass`
  parameter at all; it always transfers the full bond. There is nothing to
  recompute and match yet. Until Phase 4 lands, this check validates the
  closest real invariant available: the verdict carries no
  externally-asserted `amount` field (true by schema construction for both
  tiers already), and the two independent tier-tracking signals — the
  caller's own `tier` and, for semantic verdicts, Claude's own
  `breach_class` — agree with each other. Explicitly named as a partial
  implementation, not silently passed off as the full check.
- **Verdict-hash binding** — recomputes a hash over `(serviceId,
  verdict.verdict, verdict.should_slash, tier, classification)` from the
  live values the gate actually received, and compares it against a hash
  captured by `index.js` the moment the verdict was finalized. Also honestly
  scoped: in the current synchronous call flow (adjudicate → gate → slash,
  no queue or cache in between) both hashes are always computed from the
  same live objects, so today this is primarily a structural invariant, not
  a defense against a currently-exploitable time-of-check/time-of-use gap.
  It becomes a real defense the moment an async gap or verdict cache is
  introduced later.

Rejections log to a new `slash_failures.jsonl` (`stage: "slash-gate"`,
mirroring `settlement_failures.jsonl`'s per-stage shape, kept separate per
this project's existing failure-class-isolation rule) and write a `gated`
line to the shared `settlement_audit.jsonl` via `auditTrail.js`, reusing
its existing outcome enum rather than inventing a parallel one. A
successful slash does not get a new audit line — it already has the
on-chain `AgentSlashed` event as its first-class record, the same
reasoning Phase 9 used to explain why *payment* needed catching up in the
first place (gated/failed attempts have no other record; successful ones
already do).

Also extracted `serviceIdFor()` out of `settlement.js` into a new shared
`consumer/src/serviceId.js` so the payment gate and the slash gate can't
drift on what "the same interaction" means — both now import the identical
definition instead of keeping two copies in sync by hand.

**Verified:**
- Full 79-test Hardhat suite still passes — no contract changes this phase.
- Seven unit-level cases run directly against `gateSlash()`: the happy path
  passed; wrong payee, wrong target, a spoofed `response.oracle`, an
  externally-asserted `amount` field, a tier/`breach_class` disagreement,
  and a verdict-hash mismatch were all correctly rejected with specific
  reasons — confirmed by reading the actual thrown messages, not just
  pass/fail.
- Confirmed both new log paths fire correctly on a rejection: a
  `stage: "slash-gate"` entry in `slash_failures.jsonl` and a matching
  `outcome: "gated"` entry in `settlement_audit.jsonl`, from the same
  rejected call.
- **Live end-to-end**, real oracle: `npm run fault:stale` produced the same
  Tier 1 hard breach as Phase 1's test, now passing cleanly through the new
  gate (no rejection, no `slash_failures.jsonl` entry) before hitting the
  same pre-existing "no active bond" testnet state confirmed genuinely
  pre-existing earlier in this log — the gate adds a real check without
  disrupting an already-working, already-verified flow.

---

## Post-submission: Tiered Adjudication — Phase 4, Proportional Slashing (2026-07-30)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. Fourth phase of the tiered-adjudication doc — the heaviest
single piece of that doc, done deliberately unrushed per its own suggested
build order. Before writing any Solidity, three things were reported back
and confirmed with the user: the real dollar math the suggested parameters
produce, actual testnet state (to decide on a migration path), and the full
Hardhat test plan — all three resolved before this contract was touched.

> ### ⚠ BREAKING: the live consumer slash path is now non-functional until
> ### Phase 5 wires it up
>
> `slash()`'s signature gained a required `breachClass` parameter. Every
> caller still on the old 3-argument signature will fail at the ABI-encoding
> layer (ethers throws "missing argument," not a contract revert) as soon as
> a redeployed `ArcIDBond` is wired in. Deliberately **not** fixed in this
> phase — scoped out because choosing which `breachClass` to pass based on
> adjudication tier is explicitly tiered-adjudication Phase 5's job
> ("slasher.js routes: deterministic hard_breach → slash with
> breachClass=HARD; Claude semantic verdict → slash gate → slash with
> breachClass=SEMANTIC"), not this one's. Left broken and named explicitly
> rather than silently patched around, so nothing is a surprise:
> - `consumer/src/slasher.js` — the consumer agent's actual slash call (BOND_ABI/GUARD_ABI strings and the `.slash()`/`.guardedSlash()` calls)
> - `oracle/src/chain.js`'s `triggerCycle()` — the `/admin/trigger-cycle` demo endpoint
> - `scripts/cli/slash.js` — `npm run bond:slash`
>
> All three compile/run today against the *old* deployed contract; they
> will not work against a contract built from this phase's `ArcIDBond.sol`
> until Phase 5 lands. `ConsumerSessionKeyGuard.sol` (a contract, not
> application code) WAS updated in this phase — see below — since it's a
> direct on-chain dependent, not part of Phase 5's off-chain wiring scope.

**Three decisions locked in before writing the contract, per the user's
review:**

1. **Real numbers, not the doc's numbers assumed correct.** Pulled from the
   live setup: bond size $5.00 USDC (both active testnet bonds), oracle fee
   $0.001 USDC. With the doc's suggested `k=100, semanticCapBps=100,
   hardCapBps=1000`: semantic slash = **$0.05** (bond-cap binds, since
   k×fee=$0.10 > bond-cap=$0.05); hard slash = **$0.50**. Real problem
   surfaced and accepted as a known limitation rather than silently
   shipped: with the doc's suggested escalation thresholds (5 semantic / 3
   hard per epoch), 5 semantic breaches cost only ~5% of the bond combined,
   and the *next* one takes the remaining ~95% in one shot — a steep
   "cheap to nibble, then a cliff" shape. **Decision: keep the flat-cap
   design for now** (simpler to audit and test), **documented as a known
   limitation in `ArcIDBond.sol`'s own NatSpec** (see the contract's
   "PROPORTIONAL SLASHING" doc block) with a graduated per-breach-cap ramp
   named as a deferred future refinement — same deferral pattern as the
   session-key-guard-vs-ERC-4337 scope call in Phase 6 of the
   payment-execution doc.
2. **No migration path.** Testnet census (scoped to every address actually
   named in README/`​.env`, not a full genesis-to-tip event scan — Arc
   testnet's `eth_getLogs` caps at a 10,000-block range against a
   ~5.5M-block-old contract): 2 active bonds at $5.00 USDC each, both
   apparently team-controlled (no filled-in "outside participants" anywhere
   in `SUBMISSION.md`), plus one already-slashed bond. `ArcIDBond.sol` was
   never upgradeable (no proxy), so a new deployment is required regardless
   of the migration decision. Confirmed: no migration path needed — new
   deployment, re-bond the two active agents via already-working
   `npm run bond:post`, update `BOND_CONTRACT_ADDRESS` in both `.env`
   files. The historical slash tx documented in README's "Live Proof"
   section is unaffected either way (it already happened, immutably, on
   the old contract).
3. **Hardhat test plan approved before writing, then implemented exactly as
   reviewed** — see `test/ArcIDBondSlashClasses.test.js`, 25 new tests.

**Two open design questions from the review, resolved:**

- **"Deregister the agent" on escalation is NOT a registry write.**
  `ArcIDBond` has no write access to `ArcIDRegistryV2` and `CLAUDE.md`
  explicitly forbids modifying the identity layer. Implemented instead as a
  bond-contract-local, permanent `blacklisted` mapping — an address that
  escalates can never `postBond()` on this contract again, but its
  `ArcIDRegistryV2` registration is untouched. Functionally equivalent for
  this system's purposes, architecturally honest about not touching the
  identity layer.
- **Epoch duration: a fixed 24h calendar window, not "since last breach."**
  A since-last-breach window is gameable (space incidents just past the
  reset interval, never accumulate). Implemented as `BreachEpoch.epochStart`
  that only advances once the window has actually elapsed — never on every
  breach — so the window boundary can't be pushed by an agent's own timing.

**What was built, beyond the three decisions above:**

- `ArcIDBond.sol`: `BreachClass` enum (`Semantic` | `Hard`), owner-tunable
  schedule config (`serviceFeeAtomic`, `semanticFeeMultiple`,
  `semanticCapBps`, `hardCapBps`, both escalation thresholds — "stored as
  contract config, not hardcoded," per the doc), `BondInfo.amount` now
  means *remaining* balance (decrements on partial slashes, not just a
  static posted amount), a shared internal `_computeSlashAmount()` used by
  both `slash()` and the new read-only `previewSlash()` so the two can
  never drift, and a never-zero floor (bps math can round a slash to 0 for
  a small enough remaining balance — floored to 1 atomic unit so a bond can
  never sit in an untouchable, effectively-free state).
- New events: `BreachClassified` (class, amount, epoch count, escalated
  flag) and `AgentEscalatedAndBlacklisted` (fired only on the escalation
  path). `AgentSlashed`'s signature is **unchanged** — existing
  frontend/tooling that decodes it keeps working; `amount` is now whatever
  that specific call actually transferred, not always the full bond.
- `contracts/interfaces/IArcIDBondSlash.sol`: now the canonical home of the
  `BreachClass` enum; `ArcIDBond` formally `is IArcIDBondSlash` (new — it
  previously matched the interface only by convention), so the compiler
  itself enforces the two signatures can never drift apart again.
- `ConsumerSessionKeyGuard.sol`: `guardedSlash()` gained a `breachClass`
  passthrough parameter (required for the guard to even compile/call
  correctly against the new `slash()` — this is contract-layer, not
  Phase 5's off-chain wiring scope, so it's in this phase). Confirmed by a
  new test that the guard's own `maxAmountPerCall` never bounded slash
  amounts anyway — that cap only ever applied to `recordSettlement()`, so
  Phase 4 doesn't remove a protection, it adds the one that was actually
  missing (see the security-critical test in the new file).
- Existing test files (`ArcIDBond.test.js`, `ArcIDBondUSYC.test.js`,
  `ConsumerSessionKeyGuard.test.js`) updated to the new signature. Two
  tests' *premises* changed, not just their call syntax — "allows
  re-bonding after a slash" is no longer universally true post-Phase-4 (an
  escalated slash also blacklists); both were rewritten to assert the real
  new behavior (`AgentBlacklisted` revert) rather than papering over it
  with a signature-only patch. The positive case (re-bonding IS allowed
  after a non-escalated full depletion) is covered in the new file instead.

**Test suite: 104 passing** (79 pre-existing + 25 new), zero failures,
including the new file's security-critical checks: `previewSlash()` matches
`slash()`'s actual transferred amount for both classes (no hidden
influence on the computed amount), a parametrized sweep across 5 bond
sizes × both classes confirming the amount never exceeds its class's
capBps share, and confirmation that `slash()`'s ABI has no `amount`
parameter at all — there's nowhere for a caller to put one.

---

## Post-submission: Deployment + Private-Key CLI Security Fix (2026-07-30)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. Two things happened together: deploying Phase 4's contract to
Arc testnet (staged, confirmed at each step per the user's explicit
request), and a real security incident during that deploy that got fixed
immediately, not just noted for later.

**Deployment.** New `ArcIDBond` — `0x5E5eA9513f96A537AE966840F3355ff80824691d`
— deployed via new `scripts/deploy_bond_v2.js`, pointed at the EXISTING,
unmodified `ArcIDRegistryV2` (`0xf1ad81B9...`) and USDC, never a new
registry (CLAUDE.md forbids redeploying the identity layer). Root `.env`'s
`ARCID_REGISTRY_ADDRESS` was checked and found stale — pointing at a
different, older registry deployment than the one either active agent is
actually registered in — and deliberately not used; the correct address
was read from `deployments/arcTestnet_standalone.json` instead. Every
deploy step verified independently on-chain (a fresh RPC read against the
new contract, not trusting the deploy script's own printed output).

No migration path was needed (per the Phase 4 entry's decision) — this is
a genuinely fresh deployment, not a data-preserving migration.

**Incident: a private key was leaked into this visible transcript, twice,
during the deploy/re-bond work.** First by `npm run`'s own command-echo of
a `--key` argument. Second, after switching to calling `node` directly to
avoid that, by `_lib.js`'s `signRawDigest()` — it uses
`new ethers.SigningKey(privateKey)`, which (unlike `ethers.Wallet()`)
requires a strict `0x`-prefixed value and throws with the raw invalid
value embedded in its error message when it doesn't get one. Both
exposures reached a visible transcript. Testnet-only funds; the exposed
wallet was rotated (new key + address, funds moved) as a direct result.

**Fix, not just a workaround for that one call site:**
- Every `scripts/cli/*.js` script (`register.js`, `post-bond.js`,
  `gating-check.js`, `slash.js`, `settle.js`, `session-key.js`) had its
  `--key`/`--owner-key` CLI flag removed entirely. New `_lib.js` export
  `requireEnvKey(VAR_NAME)` is now the only way any of these scripts obtain
  a private key — reads exclusively from `process.env`, exits with a clear
  message (never the value) if unset.
- New root `.env` variables, one per actual on-chain permission role so
  switching between "acting as the agent" and "acting as the slasher"
  never means editing the same variable back and forth:
  `AGENT_PRIVATE_KEY`, `SLASHER_PRIVATE_KEY`, `GUARD_OWNER_PRIVATE_KEY`
  (existing `DEPLOYER_PRIVATE_KEY` covers the Ownable-owner role).
- `_lib.js` gained `normalizePrivateKey()` (ensures the `0x` prefix before
  any key reaches `ethers.SigningKey()` or `ethers.Wallet()`) — the actual
  root-cause fix for the second leak, not just the CLI-arg removal.
- New rule in `CLAUDE.md`: "Never pass private keys as CLI arguments in any
  command." States the incident as the reason, not just the rule.
- Two new CLI tools needed for the deploy sequence itself:
  `scripts/cli/set-authorized-slasher.js` and
  `scripts/cli/transfer-ownership.js` — both `requireEnvKey()`-only from
  the start, no legacy `--key` version ever existed for either.

**A second, separate infrastructure discovery made during this work:**
Arc testnet's public RPC (`rpc.testnet.arc.network`) applies a materially
tighter rate limit to `eth_sendRawTransaction` than to reads, and
`scripts/cli/_lib.js`'s `getProvider()` (and `oracle/src/chain.js`'s) were
making it worse by not pinning a static network — ethers was re-running
`eth_chainId` on every single call. Both fixed to pass
`{ chainId: 5042002, name: "arcTestnet" }` with `staticNetwork: true`
(oracle's version only when not pointed at a local RPC, so local dev isn't
silently broken). This measurably reduced how often reads got throttled;
writes still needed patient, sometimes 10+ minute spaced retries even
after the fix — that part is an external constraint, not something this
fix fully solves.

**Confirmed independently on-chain (fresh RPC reads, not deploy-script
output) at each staged step, per the user's explicit request to stop and
report between them:**
- New `ArcIDBond` — collateralToken, registry, authorizedSlasher, and all
  Phase 4 schedule defaults (semanticCapBps=100, hardCapBps=1000,
  thresholds 3/5) read directly from the deployed contract.
- Agent #1's new wallet registered in `ArcIDRegistryV2` — confirmed via
  `agentIdBySigner()`.
- `transferOwnership()` — `owner()` confirmed as the new wallet.
- `setAuthorizedSlasher()` — `authorizedSlasher()` confirmed as the new
  wallet.

**⚠ Known gap, flagged here and in README rather than left silent: agent
#1's re-bond is NOT done.** Registration succeeded; the `approve()` step of
`bond:post` has been blocked by the write-side rate limit described above
across multiple wait-and-retry attempts (30s through 10+ minutes), tabled
as a follow-up rather than forced through. The oracle's own wallet is also
not yet bonded on the new contract (never was — this is separate from
agent #1's re-bond, surfaced during Phase 5's live verification below).
Both are why the live demo verification below could confirm every step of
the wiring except the actual fund-moving transaction.

---

## Post-submission: Tiered Adjudication — Phase 5, Wiring + Demo CLI (2026-07-30)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. Final phase of the tiered-adjudication doc: wire the
`breachClass` selection Phase 4's contract requires into every off-chain
caller left broken since that phase shipped, plus the two demo commands.

**Wiring — `tier` → `BreachClass`, one mapping, one place:**
- `consumer/src/slasher.js` — new `breachClassFor(verdict)` maps
  `verdict.tier` (`"deterministic"` → `Hard`, `"semantic"`/anything else →
  `Semantic`) — the same `tier` field Phase 1/2 already attach to every
  verdict, so no new signal was invented for this. Passed through to both
  `bond.slash()` and `guard.guardedSlash()`.
- `scripts/cli/slash.js` — new required `--breach-class <hard|semantic>`
  flag, no default (explicit over implicit, matching this project's other
  CLI conventions). Also now calls `previewSlash()` before sending, so the
  operator sees the actual amount (and whether this call would escalate)
  before confirming, and reads the real transferred amount from the
  `AgentSlashed` event afterward instead of assuming full-bond (no longer
  true post-Phase-4).

**`oracle/src/chain.js`'s `triggerCycle()` — bigger fix than a parameter.**
This function ran its own separate LLM adjudicator, ported once from the
pre-tiering `consumer/src/adjudicator.js` and never kept in sync with
Phases 1–2. Its one hardcoded fault (bad-sig) is now unambiguously a Tier 1
mechanical fact. Just adding `breachClass: Hard` to its `slash()` call
while leaving the LLM step in place would have written a real
contradiction on-chain: a Claude-authored reason string paired with a
classification that claims no judgment was involved. Fixed by removing the
local LLM adjudicator entirely (`VERDICT_TOOL`, `SYSTEM_PROMPT`,
`adjudicate()`, the `@anthropic-ai/sdk` import) and replacing it with the
same deterministic `SIG_INVALID` reasoning `deterministicVerifier.js`
already uses — this endpoint now makes zero Claude calls, matching what
the real consumer flow actually does for this fault class. Direct
consequence, not a separate optimization: `@anthropic-ai/sdk` dropped from
`oracle/package.json` (nothing else in the oracle package used it), and
the now-orphaned `ANTHROPIC_API_KEY`/`MODEL` removed from
`oracle/src/config.js` and `oracle/.env.example` — including a stale cost
comment about keeping this endpoint off Opus, which no longer applies
because there's no LLM call left to worry about. Also fixed the log line
that assumed a full-bond transfer (Phase 4 makes that untrue) — now reads
the actual amount from the `AgentSlashed` event.

**Two demo commands — `npm run demo:hard-breach` / `demo:semantic-breach`
(from `consumer/`):**
- `demo:hard-breach` aliases the existing `--fault bad-sig` path — already
  proven, no new oracle behavior needed, matches the doc's own "tampered
  signature" description.
- `demo:semantic-breach` needed something new: nothing in the oracle could
  produce a validly-signed, fresh, well-formed response whose *value* is
  semantically wrong — every existing fault mode is mechanically
  detectable (Tier 1) by design. Added a new oracle fault mode,
  `?fault=bad-price` (`oracle/src/index.js`), returning a real signature
  over a sentinel-pattern value (`99999999.99`) — the same implausible
  price used to verify Tier 2's evidence schema live during Phase 2 of the
  tiered-adjudication doc. Passes every Tier 1 check; only Claude's
  semantic judgment catches it.

**Live end-to-end verification against the newly deployed contract, per
the user's explicit requirement not to declare this done on compilation
alone:**
- `npm run demo:hard-breach` — real run, real oracle, real RPC calls
  against `0x5E5eA9513f96A537AE966840F3355ff80824691d`. Produced a genuine
  Tier 1 `SIG_INVALID` verdict in 466ms with zero LLM calls, correctly
  attempted the slash with `breachClass=Hard` against the live contract —
  no ABI mismatch, no gate rejection — and gracefully skipped at the
  final step because the *oracle's* wallet (separate from agent #1) has
  never been bonded on this new contract.
- `npm run demo:semantic-breach` — the `bad-price` fault correctly evaded
  every Tier 1 check and reached Tier 2. The live Claude call itself
  failed with `401 API key is invalid` — an external credential issue
  (the `.env` value is unchanged from earlier in this session when it
  successfully made real Claude calls), not a wiring bug, and not
  something fixed here. **Flagged rather than routed around.**
- To verify the plumbing downstream of Tier 2 without a working key: ran
  `executeSlash()` directly with a synthetic verdict object shaped exactly
  like what Phase 2's live-verified Claude output actually returns
  (`breach_class: "semantic"`, structured `evidence`). Confirmed
  `breachClassFor()` correctly resolved `Semantic` (0), the call passed
  `slashGate.js` cleanly against the live contract, and reached the same
  "no active bond" skip as the hard-breach run — proving the semantic path
  is wired identically correctly, independent of the API key issue.
- Both runs' Hardhat suite check: 104 passing, unaffected (no contract
  changes this phase).

**Two known gaps carried forward, not resolved by this phase, both stated
above and in README:** agent #1's re-bond (rate-limit blocked) and a valid
`ANTHROPIC_API_KEY` for a true live Tier 2 call (external credential
issue). Neither blocks this phase's actual scope — every piece of wiring
this phase was responsible for is verified correct against the real
deployed contract; what's pending is external state (funding, an API key)
this phase doesn't control.

Both gaps have since been resolved live and independently verified
on-chain: agent #1's re-bond succeeded, a new `ANTHROPIC_API_KEY` was
supplied, and both `demo:hard-breach` and `demo:semantic-breach` completed
real slashes end-to-end — hard breach tx transferred 0.5 USDC (10% hard
cap), semantic breach tx transferred 0.045 USDC (1% bond-relative cap
binding over the $0.10 fee-multiple term), both confirmed via fresh RPC
reads of the transaction receipt and resulting bond state, not trusted
from script output.

---

## Post-submission: Optimistic Challenge Window — Phase 6.1, Dispute State Machine (2026-07-30)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. First phase of a new design doc (arcid2 Phase 6): a single
Claude-authored semantic verdict deciding a large slash in one shot is a
real single-point-of-failure risk once the amount gets big enough to
matter. This phase adds a contested-slash path alongside the existing
instant-slash path — it does not replace or slow down anything already
working; small/Hard breaches execute exactly as before.

**Scope, locked in per the design doc:** build the challenge-window
mechanics now with the existing `owner` role wired in as an explicitly
labeled placeholder resolver (Option A) — stated as an interim measure,
not the end state. Decentralized resolution (Kleros or equivalent, Option
C) is documented as the roadmap target, not built this phase. A
multi-model LLM quorum (Option B) was considered and rejected — models
sharing training data and biases can fail in a correlated way on the same
input, so stacking more LLM votes doesn't buy the independence a real
arbitration layer does.

**Architecture decision: extended `ArcIDBond.sol` directly, not a
companion contract.** The dispute-resolution path needs to reuse
`_computeSlashAmount()`, the `bonds`/`breachEpochs`/`blacklisted` storage,
and the exact same escalation bookkeeping `slash()` already has — all of
it `internal`/private to `ArcIDBond`. A separate `ArcIDDispute.sol` would
have needed all of that exposed as a second privileged cross-contract
surface (either a duplicate slash-execution entry point, or `ArcIDDispute`
itself becoming `authorizedSlasher` and juggling that role alongside
`ConsumerSessionKeyGuard`, which already occupies it when active) for no
real benefit over just adding the functions here.

**What was added:**
- `enum DisputeState { None, Indicted, Resolved }` and a `Dispute` struct
  (`consumer`, `provider`, `claimAmount`, `challengeDeadline`,
  `rationaleHash`, `state`). No `breachClass` field — disputes are
  semantic-only by construction (Hard breaches can never reach
  `fileIndictment()`; there's no parameter to misuse).
- `challengeThreshold` (default $1.00 USDC, owner-tunable) and
  `disputeWindow` (default 24h, owner-tunable) — same owner-tunable-config
  pattern as Phase 4's slash schedule.
- `slash()`'s existing body was extracted, unchanged, into a new internal
  `_executeSlash()` — shared by `slash()` (instant path) and the two new
  resolution paths below, so the fund-moving + epoch/escalation logic
  exists in exactly one place, not two copies that could drift.
  `previewSlash()`'s body was similarly extracted into `_previewSlash()`,
  now shared by three callers instead of duplicated logic.
- `slash()` gained a threshold gate: a non-escalating Semantic amount
  above `challengeThreshold` now reverts `ChallengeThresholdExceeded` — the
  caller must use `fileIndictment()` instead.
- `fileIndictment(agent, consumer, rationaleHash)` — `authorizedSlasher`-
  only, same caller as `slash()`. Records the dispute and starts the
  window; does **not** move funds or touch epoch bookkeeping yet. Reverts
  `ChallengeThresholdNotExceeded` if the amount doesn't actually cross the
  threshold (should have used `slash()`) or `EscalatingBreachNotDisputable`
  if this breach would cross the agent's epoch escalation threshold — an
  escalation is a compounding pattern backed by multiple already-confirmed
  prior breaches, not a single fresh judgment call, so it always executes
  instantly through `slash()` regardless of size, never disputable. Only
  `bytes32 rationaleHash` goes on-chain, not the full rationale text — same
  pattern as `PaymentSettled`'s `verdictHash`; the full Claude evidence
  lives in the consumer's own audit log.
- `resolveDispute(disputeId, approved)` — `owner`-only (the interim
  resolver; NatSpec states this verbatim as a placeholder, not the end
  state). On approval, recomputes the slash amount **fresh** via
  `_computeSlashAmount()` at resolution time — never trusts the
  `claimAmount` stored at indictment time, so a bond change in between
  can't produce a stale or pre-baked transfer. On rejection: no slash, bond
  untouched.
- `finalizeExpiredDispute(disputeId)` — permissionless. Once
  `challengeDeadline` passes with nobody calling `resolveDispute()`, this
  executes the slash as if approved — the actual "optimistic" behavior
  (default-execute, not default-block). Anyone can call it; there's no
  privileged decision left to make once the deadline has passed.
- `setChallengeParameters(challengeThreshold, disputeWindow)` — owner
  setter, same pattern as the other admin setters.
- **Stuck-dispute gap, closed (after two review rounds):** if an agent's
  bond is fully drained by an unrelated event (e.g. a separate Hard-breach
  escalation) between indictment and resolution, the underlying claim is
  moot — there's nothing left to take. The first version of this phase
  reverted `AlreadySlashed` on approval in that case, leaving the dispute
  stuck `Indicted` on the *permissionless* `finalizeExpiredDispute()` path
  with no one obligated to notice and clean it up — flagged in review as
  a real gap, not acceptable to leave as "documented." New internal
  `_executeSlashOrVoid()` — used **only** by `resolveDispute()` and
  `finalizeExpiredDispute()`, never by `slash()` itself, which must keep
  reverting on a genuinely invalid target — returns `0` without touching
  any state if the agent is already `slashed`, instead of reverting.
  Both resolution paths still mark the dispute `Resolved` either way, so
  a moot claim now closes out cleanly: `DisputeResolved(id, true, 0, ...)`
  — `approved=true` records the intent, `amountTransferred=0` records that
  nothing moved. Explicit rejection (`resolveDispute(id, false)`) was
  always unaffected by any of this, since it never calls the slash-
  execution path at all.
  **Still-open, narrower gap, deliberately not fixed here:** if the agent
  *voluntarily withdrew* the bond entirely (`withdrawBond()`, not a slash
  — `postedAt` resets to 0 rather than `slashed` flipping to `true`) while
  a dispute was pending, approval still reverts `NoBondFound` and the
  dispute can still get stuck — only an explicit owner rejection closes
  it out in that case. A rational agent facing a pending large dispute has
  an incentive to front-run resolution this way; left out of this fix at
  hackathon scope, flagged rather than silently ignored.
  (Earlier drafts of this entry and the NatSpec first claimed the gap
  didn't exist, then — after review caught that — described it as merely
  "documented" without an owner-independent close-out path. Both were
  wrong in different ways; this entry reflects the actual, now-tested
  behavior, not a description of it.)

**Tests — `test/ArcIDDispute.test.js`, 27 (131 total):** the on-chain
partition this phase depends on — exactly one of `{slash(), fileIndictment()}`
callable for any given state, never both, never neither — is tested
directly: threshold gate on/off, Hard and escalating breaches always
bypassing the gate regardless of size, `fileIndictment()`'s own mirrored
checks, owner-only `resolveDispute()` approve/reject, the fresh-recompute-
at-resolution behavior (proven by shrinking the bond via an intervening
Hard breach between indictment and resolution and confirming the executed
amount differs from the stored `claimAmount`), permissionless
`finalizeExpiredDispute()` before/after the deadline, and the closed
stuck-dispute gap specifically: an agent hard-slashed to full-drain while a
semantic dispute is pending, then `finalizeExpiredDispute()` called after
the window passes — asserted against the actual failure mode, not just
"doesn't crash": the call must not revert, the consumer's balance must be
unchanged by that specific call (genuinely voided, not silently
transferring by accident), the dispute must read back `Resolved` (not
stuck `Indicted`), and a second `finalizeExpiredDispute()` call on the
same id must revert `DisputeNotIndicted` (proving it's truly closed, not
re-triggerable). Mirrored for `resolveDispute(id, true)` directly, plus a
test confirming explicit rejection was and remains unaffected by any of
this. Full existing suite (104 tests) re-run clean alongside — zero
regressions, no existing test needed changes since `slash()`'s ABI and
default-config behavior are both unchanged for every case that doesn't
cross the new threshold.

**Scope note:** this is 6.1 of a 5-phase doc (contract mechanics only).
Off-chain wiring (`slashGate.js` calling `fileIndictment()` instead of
`slash()` above threshold), CLI resolution tooling
(`dispute:list`/`dispute:resolve`), and live-verified demo commands are
later phases, not yet built.

---

## Post-submission: Optimistic Challenge Window — Phase 6.2, Consumer Wiring (2026-07-30)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. Second phase of arcid2 Phase 6: the consumer's existing
post-verdict handler decides instant vs. disputed itself, rather than a
new parallel code path duplicating Phase 3's gate.

**`slashGate.js` gains a 5th check — ROUTING.** The existing four checks
(payee, target, breach classification, verdict-hash binding) stay
untouched. The new check mirrors `ArcIDBond`'s own routing rule exactly:
Hard breaches are always instant regardless of size (no RPC call needed —
skipped entirely for that case); an escalating Semantic breach is always
instant regardless of size; a non-escalating Semantic breach whose
`previewSlash()` amount exceeds the live `challengeThreshold` routes to
dispute. **Deliberate, documented departure from this module's original
design:** checks 1-4 are explicitly "no LLM or network round-trip" (stated
in the module's own docs); this check makes a real RPC read
(`challengeThreshold()` + `previewSlash()`), because getting the routing
decision right on the first attempt matters — a wrong guess still fails
safely (`ArcIDBond`'s own gates independently enforce the identical rule
and simply revert on a mismatch), but wastes a transaction and a demo
beat. If the RPC read itself fails, the gate fails outright rather than
guessing a route — same "refuse on anything it can't verify" posture as
every other check here.

**`slasher.js` acts on the route the gate already decided** — it does not
re-derive or second-guess it. `route: "instant"` behaves exactly as
before (`bond.slash()` / `guard.guardedSlash()`, unchanged). `route:
"dispute"` calls the new `bond.fileIndictment(agent, consumer,
verdictHash)` — reusing the existing `verdictHash` as the on-chain
`rationaleHash` rather than inventing a second hash for the same purpose.
**Known, stated gap:** `ConsumerSessionKeyGuard` has no
`guardedFileIndictment()` passthrough (`guardedSlash()`/
`guardedRecordSettlement()` exist; this doesn't). If `SESSION_GUARD_ADDRESS`
is set and routing decides "dispute", this throws a clear, explicit error
rather than silently bypassing the dispute requirement (unsafe) or
silently falling back to an instant slash the contract would reject
anyway. Wiring guard support is out of scope for this phase — deliberately,
not an oversight.

**`auditTrail.js` gains `"indicted"` in its outcome vocabulary,** written
by `slasher.js` on every successful `fileIndictment()` call (both
DEV_MODE-simulated and real), the way `settled`/`gated`/`circuit_breaker`
already are. Unlike an ordinary instant slash (which relies solely on the
on-chain `AgentSlashed` event as its record, by original Phase 9 design —
"a successful slash does NOT get a new audit line here"), an indictment
gets an explicit audit line because it is not itself a final outcome — it
starts a process that needs following up on, and an operator running
6.3's not-yet-built CLI tooling needs a queryable trail to find it.
`"resolved"`/`"auto_finalized"` are reserved in the outcome vocabulary now
(documented in JSDoc) but not yet written anywhere — the CLI/tooling that
performs those actions is Phase 6.3, not yet built.

**`index.js`** — the "→ Slashing oracle..." console output now
distinguishes `⚖ INDICTED — disputeId N pending challenge window` from
`✗ SLASHED`, and the per-cycle log record gains `slash_route` and
`dispute_id` fields.

**Live verification, not just compilation — against a LOCAL Hardhat
deployment of Phase 6.1's bytecode, not the live Arc testnet contract.**
Checking the currently-deployed testnet `ArcIDBond`
(`0x5E5eA9513f96A537AE966840F3355ff80824691d`) confirmed it predates Phase
6.1 — `serviceFeeAtomic()` (a pre-6.1 var) resolves fine, `challengeThreshold()`
(added in 6.1) reverts with "missing revert data," i.e. the function
doesn't exist in the deployed bytecode. Phase 6.1 was compiled and
Hardhat-tested but never actually redeployed to Arc testnet — that's
explicitly Phase 6.4's job per the doc's own phasing ("verified live
against the real deployed contract"), not assumed or silently done here.
Rather than skip live verification or unilaterally redeploy the shared
testnet contract mid-phase (a disruptive action this project has
consistently treated as needing explicit sign-off, not something to do
as a side effect of a wiring phase), spun up a local Hardhat node,
deployed the actual Phase 6.1 `ArcIDBond` bytecode fresh, and drove the
real (unmodified) `slashGate.js`/`slasher.js` code through it directly —
a genuine end-to-end run, not a synthetic unit test of routing logic in
isolation:
- A large synthetic semantic verdict (scaled fee params so the bondCap
  binds at $5.00 against a $500 bond, same trick as
  `ArcIDDispute.test.js`) correctly routed to `dispute`, filed a real
  `fileIndictment()` tx, and was confirmed independently on-chain:
  `disputes(1)` reads `claimAmount=5000000`, `state=Indicted (1)`,
  `rationaleHash` matching the verdict hash — and the oracle's bond stayed
  untouched by that call (confirmed via a separate Hard breach run
  immediately after, which correctly still routed `instant` and did move
  funds, proving the indictment genuinely didn't).
- The same Hard breach case confirmed the "instant" path is completely
  unaffected — no routing RPC call made at all for a deterministic
  breach, exactly as designed.
- `DEV_MODE=true` correctly simulated both routes without sending a real
  tx, correctly labeled "indictment" vs. "slash" in the console output,
  and still made the real routing RPC read (by design — DEV_MODE skips
  *writes*, not the read needed to know which route to describe).
- The `settlement_audit.jsonl` `"indicted"` record was confirmed written
  correctly for both the real and DEV_MODE-simulated cases, with the
  right `onChainTx`/`amount`/`reason` fields.
- The guard-gap error path was confirmed to fire the intended explicit
  message when `SESSION_GUARD_ADDRESS` is set and routing decides
  "dispute," rather than silently doing something unsafe.

**What this means for the live Arc testnet deployment right now:** the
existing `demo:hard-breach` path is unaffected (Hard breaches never touch
the new routing RPC call). `demo:semantic-breach` and any other semantic
verdict, however, will now fail its slash step against the currently
deployed contract — the routing check's RPC read for `challengeThreshold()`
will revert (function doesn't exist on that bytecode), and the gate fails
loud by design rather than guessing. This is expected and stated here
rather than discovered by surprise: it resolves once the Phase 6.1
contract is actually redeployed to Arc testnet, which is Phase 6.4's
scope.

**Scope note:** this is 6.2 of the 5-phase doc (consumer wiring only). CLI
resolution tooling (`dispute:list`/`dispute:resolve`) and the redeploy +
live-verified demo commands against the real Arc testnet contract are
later phases, not yet built.

---

## Post-submission: Optimistic Challenge Window — Phase 6.3, Owner Resolution CLI (2026-07-31)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. Third phase of arcid2 Phase 6: the interim resolver
(`ArcIDBond`'s `owner`) needs a way to actually resolve disputes, not just
a contract function nobody calls.

**`npm run dispute:list`** (`scripts/cli/dispute-list.js`) — read-only, no
private key. Loops `disputes(1..nextDisputeId)` directly rather than
paginating event logs (`list-agents.js`'s approach) — `disputeId` is a
simple incrementing counter and `disputes()` is a public mapping getter,
so there's nothing to paginate. Shows open (`Indicted`) disputes by
default; `--all` also shows resolved ones, each flagged whether its
deadline has already passed (eligible for `finalizeExpiredDispute()`).

**`npm run dispute:resolve -- --id <id> --approve|--reject`**
(`scripts/cli/dispute-resolve.js`) — `DEPLOYER_PRIVATE_KEY`-gated (the
contract's `owner`; never a CLI argument, per the existing private-key
rule), warns-but-doesn't-block on a key/owner mismatch (same posture as
`slash.js`). On `--approve`, previews the actual amount via
`previewSlash()` first — which may differ from the `claimAmount` captured
at indictment time, and may correctly preview `0` if the target agent's
bond was independently slashed in the meantime, in which case the tool
tells the operator this will gracefully void rather than revert (see
Phase 6.1's `_executeSlashOrVoid()`). Requires a typed `"yes"` before
sending the transaction — no `--yes`/`--force` skip flag, deliberately.

**Both commands share `scripts/cli/_disputeLookup.js`** — a small helper
that scans `consumer/logs/*.jsonl` for the per-cycle record matching a
given `disputeId` (tagged there by `slasher.js` since Phase 6.2) and
returns its `reason`/`evidence`. `ArcIDBond` only ever stores
`rationaleHash` on-chain (same reasoning as `PaymentSettled`'s
`verdictHash`) — this is the one place the full Claude evidence survives,
and it's a best-effort local lookup, not a guarantee: logs rotated away or
generated on a different machine come up empty, and both scripts handle
that by printing an explicit "not found locally — verify independently"
notice rather than silently proceeding as if nothing were missing. This is
the design doc's explicit requirement made real: "print the full Claude
rationale and evidence[] before asking for confirmation, so the interim
manual review is an actual review, not a rubber stamp" — an operator who
can't find the evidence locally is now told exactly that, in the same
place they'd otherwise have read it.

**Live end-to-end verification, same reasoning and same method as Phase
6.2** — against a fresh local Hardhat deployment of the actual Phase 6.1
bytecode, not the live Arc testnet contract (which still predates 6.1;
redeploying it is Phase 6.4's scope, not assumed here). Filed two real
indictments directly on a freshly deployed `ArcIDBond`, with a matching
`consumer/logs/*.jsonl` record written for only ONE of them (deliberately,
to exercise both the found and not-found paths):
- `dispute:list` correctly displayed both as open, correctly rendered the
  found rationale + evidence for dispute #1, and correctly showed the
  "not found locally" notice for dispute #2.
- `dispute:resolve --id 1 --approve` displayed the real rationale, a live
  `previewSlash()` amount, asked for confirmation, and — on a piped `"yes"`
  — sent a real `resolveDispute()` tx that mined successfully
  (`approved: true`, `amountTransferred: 5.00 USDC`).
- `dispute:resolve --id 2 --reject` correctly showed the "not found
  locally" warning, asked for confirmation, and on `"yes"` sent a real
  rejection (`approved: false`, `amountTransferred: 0.00 USDC`), bond
  confirmed untouched.
- A third dispute was filed and `dispute:resolve --id 3 --approve` was run
  with a non-`"yes"` answer (`"no"`) — correctly printed "Aborted — no
  on-chain action taken." and sent nothing.
- Re-running `dispute:resolve --id 1 --approve` against the already-
  resolved dispute #1 correctly refused up front (`Dispute #1 is not open
  (state: Resolved)`) without prompting or attempting a transaction.
- `dispute:list --all` afterward correctly showed disputes #1/#2 as
  Resolved and #3 as still Indicted.
- Test artifacts (temporary deploy script, temporary log file, the local
  Hardhat node itself) cleaned up afterward; the pre-existing
  `deployments/localhost_standalone.json` (a stale artifact from earlier,
  unrelated local testing) was backed up before being overwritten for this
  test and restored exactly afterward — confirmed via `git diff` showing
  no residual change to that file.

**Scope note:** this is 6.3 of the 5-phase doc (CLI tooling only). The
redeploy of Phase 6.1's contract to Arc testnet and the live-verified
demo commands (`demo:large-semantic-breach`,
`demo:dispute-auto-finalize`, `demo:dispute-owner-override`) against the
real deployed contract are Phase 6.4, not yet built.

---

## Post-submission: Incremental Log Scanning + RPC Migration (2026-07-31)

**Context.** Discovered mid-Phase-6.4 redeploy: switching `ARC_RPC_URL`
from Arc testnet's public endpoint to a dedicated Alchemy endpoint (to
fix the write-side rate-limiting that had been blocking re-bonds all
session) traded one problem for another — Alchemy's free tier caps
`eth_getLogs` to a 10-block range per call, versus the 9,000-block chunks
`oracle/src/chain.js` and `scripts/cli/list-agents.js` were written
against.

**The real bug, not just the block-range cap.** `getChainStats()` (backs
`/api/chain-stats`) was re-scanning the *entire* historical range from
`DEPLOY_BLOCK` on every call, and the frontend polls that endpoint every
5 seconds while the dashboard is open, with the same 5s cache TTL on the
oracle side — meaning a full historical rescan on every single cache
tick, routinely, whenever the traction dashboard is open. At the
project's actual current numbers (`DEPLOY_BLOCK=48894041`, latest
`~54.5M`) that's a 5.66M-block range: ~629 chunks at 9,000 blocks/call
(tolerable enough against the old public RPC not to be noticed), ~565,855
chunks at 10 blocks/call (non-functional). Shrinking the chunk size alone
would not have fixed this — it would have made an already-wasteful
routine operation catastrophically slower, not solved it.

**Fix — `oracle/src/chain.js`:** `paginatedLogs()` now caches the last
successfully-scanned block per event filter (module-level `Map`, keyed
`"registry:AgentRegistered"` / `"bond:AgentSlashed"`) and only queries
blocks after that on each call. A cache hit with nothing new since the
last scan makes zero RPC calls. This is the actual fix, independent of
RPC provider or plan tier — it eliminates the *routine* 5-second re-scan
entirely; only the one-time cold-start scan after an oracle restart still
pays for the full historical range. Also added `ARC_LOG_CALL_DELAY_MS`
(default 200ms) — a pacing delay between successive *successful* chunk
calls, distinct from the existing `withBackoff()`, which only delays
after a *failure*. Without pacing, a large chunk count fires back-to-back
fast enough to trip a provider's requests-per-second cap even when every
individual call would otherwise succeed. `CHUNK` is now
`ARC_LOG_CHUNK_SIZE` (env, default `10` to match the current Alchemy free
tier) instead of a hardcoded `9_000` — raise it, no code change needed,
if the plan is upgraded.

**Fix — `scripts/cli/list-agents.js`:** this one is a rare, manually-
invoked tool, not something polled routinely — incremental scan caching
was deliberately NOT added here (would be unused complexity for a
one-shot command). Added the same `withBackoff()`-shaped retry (self-
contained copy, not a shared import — `scripts/cli/` and `oracle/` are
separate packages with no existing cross-import relationship) so a single
transient chunk failure partway through a many-chunk scan doesn't abort
the whole command with zero results, the same `ARC_LOG_CHUNK_SIZE` env
var so chunks actually fit the RPC's per-call limit (retries alone don't
help against a permanent block-range-too-large error), the same
between-successful-calls pacing, and progress logging (`scanning chunk
N/total`) since a manual run against a low chunk-size cap can now take
noticeably longer.

**Verified — the mechanism itself, not a live full-scale run.** A live
cold-start scan at `CHUNK=10` over the real 5.66M-block range would take
~31 hours and isn't a meaningful way to test the caching logic anyway.
Instead, temporarily exported `paginatedLogs()`/`chunkLogCache` from
`chain.js`, drove it against a fake contract recording exactly which
block ranges it was asked to query, and confirmed: (1) an initial scan
correctly chunks and accumulates events; (2) a second call with the same
`latest` block makes **zero** new RPC calls and returns the cached
events; (3) a third call with `latest` advanced only queries the new
delta range, never re-touching already-scanned blocks, and correctly
accumulates the new event alongside the previously cached ones. Export
reverted after the test — not a permanent addition, `chain.js` has no
other reason to expose these internals.

**Honest limitation, not fixed by this change:** the one-time cold-start
scan after every oracle process restart still costs the full historical
range at whatever `ARC_LOG_CHUNK_SIZE` currently is. At the free tier's
`10`, that's still ~565,855 chunks — impractically slow. This is exactly
why the Alchemy plan upgrade matters as a second, complementary fix (not
the primary one): it directly reduces the one remaining expensive
operation (cold start) rather than the routine one (which incremental
caching already eliminated). Also unaffected by this change, called out
again for visibility: the RPC endpoint switch itself is what actually
unblocked write-side rate limiting all session — the oracle re-bond
landed cleanly on the first attempt after switching, with zero retries
needed, after multiple prior attempts against the public endpoint had
failed.

---

## Security Audit Finding: Unauthenticated /admin/trigger-cycle (incident: 2026-06-27 to 2026-07-05; documented: 2026-07-31)

**Context — different from every other entry above.** Every other entry
in this file documents work added *after* the 2026-07-06 form lock, as a
transparency log of the extended-event-window additions. This entry is
different: it documents an incident that happened *before* the lock,
during original submission development, that was fixed in the commit
history at the time but never written up anywhere. It's being added now
because a security audit (requested this session, prompted by wanting a
definitive answer on Claude-call auth coverage across the whole project)
surfaced it. Documented for completeness and honesty, not because it was
itself a post-lock addition — dated by when the incident and fix
actually happened, not by today's date.

**What was exposed.** `POST /admin/trigger-cycle` runs the full slash
demo loop: re-bond the oracle if needed → generate a bad-sig fault →
adjudicate → slash on-chain → recharge. At the time of this incident, the
adjudication step for this endpoint ran its own separate LLM call to
Claude (a copy ported from the consumer's adjudicator, predating the
tiered-adjudication work — see below). The endpoint is meant to be gated
by `isFaultAllowed()` — an `X-Fault-Token` header check (or a `DEV_MODE`
bypass for local dev). For an 8-day window, that check did not exist on
this endpoint at all: any request, from anyone, would have triggered a
real, unauthenticated Claude API call and a real on-chain slash
transaction, with no token, no rate limit beyond the endpoint's own
cooldown, and no cost ceiling other than whatever spend cap existed on
the Anthropic key at the time.

**Root cause and timeline, from git history:**
- `ce3db2f` "Ungate demo button" (2026-06-27 18:38:23 -0400) removed the
  `isFaultAllowed()` check from `/admin/trigger-cycle` — a deliberate
  edit (the check was cut, not accidentally dropped), presumably to
  remove friction from a demo button, without reasoning through what
  removing it actually exposed. **In the same commit**,
  `oracle/docker-compose.phala.yml` — the actual Phala CVM deployment
  config — was created for the first time. The deployment artifact and
  the vulnerability were introduced together.
- `e5ed60f` "Fix unauthenticated /admin/trigger-cycle and add RPC backoff
  to chain-stats polling to prevent runaway billing from scanner hits."
  (2026-07-05 15:33:38 -0400) restored the check — an 8-day gap. The
  commit message's own wording — "scanner hits" — is a strong signal
  this was not a preemptive fix; it reads as a response to real
  unauthorized traffic actually observed hitting the live, ungated
  endpoint, not a theoretical risk caught in review.
- Git records when code was committed, not when a container was actually
  built, pushed, and live on the CVM — that action isn't captured in
  this repository. Given the deployment config was born in the same
  commit as the vulnerability, and the fix commit's own language implies
  real observed traffic, the honest read is that the ungated code was
  very likely live on Phala for a real portion of that 8-day window, not
  merely present in git.

**Fix, and — separately, much later — the actual root-cause elimination:**
- `e5ed60f` restored the `isFaultAllowed()` check, re-gating the endpoint
  behind `X-Fault-Token`.
- Later, during **this session's** tiered-adjudication Phase 5 work (see
  the "Tiered Adjudication — Phase 5" entry above, 2026-07-30) —
  unrelated to this incident at the time, but the thing that actually
  closes it out — `oracle/src/chain.js`'s `triggerCycle()` had its
  entire separate LLM adjudicator (`VERDICT_TOOL`, `SYSTEM_PROMPT`,
  `adjudicate()`, the `@anthropic-ai/sdk` import) **removed outright**,
  not merely re-gated. The reasoning at the time was about consistency
  with the real consumer flow (bad-sig is a Tier 1 deterministic verdict
  with zero LLM calls, and the old endpoint contradicted that by still
  calling Claude) — but the security consequence is the one that matters
  most in hindsight: `/admin/trigger-cycle` now has **no code path to a
  Claude call at all**, gated or not. A future regression that dropped
  the `isFaultAllowed()` check again could not, by itself, cause an
  unauthenticated Claude spend on this endpoint anymore — the capability
  itself is gone, not just fenced off. Confirmed via this session's
  security audit: `oracle/package.json` has no `@anthropic-ai/sdk`
  dependency, and no file under `oracle/src/` references the Anthropic
  SDK anywhere outside a stale comment (also fixed this session — see
  below).

**Current state, confirmed via this session's audit:** the documented
Phala CVM URL is not reachable at all (TLS handshake fails outright,
confirmed independently via both `curl` and Node's `https` client) — the
CVM is not currently running. Real-time public exposure of every oracle
endpoint, gated or not, is presently zero. This entry exists so the
historical exposure is on the record regardless of current deployment
state, matching this project's standing rule that incidents get
documented, not just fixed and forgotten (see the private-key CLI
security fix entry above, same principle applied here retroactively).

**Also fixed this session, surfaced by the same audit:**
- Removed the now-dead `ANTHROPIC_API_KEY` from
  `oracle/docker-compose.phala.yml` — leftover from before the Phase 5
  removal above; nothing in `oracle/src` has read it since.
- Fixed the stale comment above `/admin/trigger-cycle` in
  `oracle/src/index.js`, which still described the old
  "re-bond → bad-sig → Claude → on-chain slash → recharge" flow.

**Not done as part of this entry, flagged as a reminder rather than
silently assumed:** confirm the current `ANTHROPIC_API_KEY` has a hard
spend cap set on the Anthropic console. This cannot be verified from
code — it's the one backstop that would have bounded this incident's
actual cost if it was exploited, and it's worth confirming exists
independent of any code-level fix.

---

## Post-submission: Circle Agent Wallets — USDC Custody Only (2026-08-01)

**Context.** Same post-form-lock, extended-event-window basis as the
entries above. First step of a new scoping doc
(`tiered-adjudication` doc's sibling, "Circle Agent Stack Integration")
aimed at Encode's Agentic Economy track, which requires demonstrable use
of Circle's actual Agent Wallets / Nanopayments / Marketplace / CLI
products, not just Gateway/x402 (already wired — see the "Circle Stack"
table in README.md).

**Explicit design decision, made before any code changed:** does Circle's
Agent Wallets product replace `ConsumerSessionKeyGuard.sol` as the
oracle/consumer's contract-call signer? Researched against Circle's real
`circlefin/skills` repo (not the marketing page) before deciding:
Agent Wallets is CLI-first and human-OTP-authenticated
(`circle wallet login <email> --init` → OTP from that inbox), has no
documented Node.js SDK, and its own spending-policy primitive is
**mainnet-only — testnet chains are rejected**, per Circle's docs. Since
arcid2 runs entirely on Arc Testnet, that policy layer cannot be
exercised here regardless of choice. Decision: use Agent Wallets **only**
for oracle/consumer USDC custody and balance checks. `postBond` / `slash`
/ `fileIndictment` / `resolveDispute` remain exactly as they were —
`CONSUMER_PRIVATE_KEY` (or `ConsumerSessionKeyGuard` when
`SESSION_GUARD_ADDRESS` is set) and `ORACLE_PRIVATE_KEY`. Nothing about
Phase 6's session-key hardening changes.

**What was added:**
- `oracle/.env.example` / `oracle/.env` — `ORACLE_AGENT_WALLET_ADDRESS`,
  a real Agent Wallet (`0x9867a0a4b7631a66b0433034a45e472023f809d6`),
  provisioned via `@circle-fin/cli` (`circle wallet login` +
  `circle wallet create`), funded with 20 testnet USDC via the CLI's
  faucet integration. USDC custody/balance-check only — does not sign.
- `consumer/.env.example` / `consumer/.env` — `CONSUMER_AGENT_WALLET_ADDRESS`,
  a second Agent Wallet (`0xb84cd0e18a75dd89e6f7e2781012748f612d13c3`),
  same provisioning method, also funded with 20 testnet USDC.
- README.md's "Circle Stack" table — new row documenting both addresses
  and the account split below.

**A debugging detour worth recording accurately, since the first working
theory was wrong.** While provisioning the second (consumer) wallet, the
first (oracle) wallet's balance check started failing with
`Wallet not found ... on ARC-TESTNET`, and it dropped out of
`circle wallet list`. The first theory — that a `--network testnet` CLI
flag was a silent no-op and `--testnet` was the real fix — turned out to
be a red herring; the installed CLI's own `--help` for both
`wallet login` and `wallet create` shows no such flag at all. The actual
cause, confirmed by re-authenticating and re-checking: **the two wallets
ended up on two different Circle accounts**
(`kristian.koci@gmail.com` for the oracle wallet, created first;
`kristian.koci@feeltech.co.uk` for the consumer wallet, created second).
`circle wallet balance` / `circle wallet list` are scoped to whichever
account is currently logged in locally, not a global/public lookup — so
the oracle wallet appeared to "vanish" purely because it was being
checked under the wrong session, not because it broke. Re-authenticating
as `kristian.koci@gmail.com` confirmed it was intact the whole time,
still holding its original 20 USDC. Decision (asked and confirmed):
leave the two wallets on their two separate accounts rather than
consolidate — both work fine independently, it just means a CLI-driven
balance check needs `circle wallet login` for whichever account owns the
wallet in question. Relevant for Phase 7.5's demo script, which will need
to switch sessions between the two.

**Side effect of chasing the wrong theory, left as-is:** two extra,
unfunded agent wallets were created under the `feeltech.co.uk` account
while testing whether `circle wallet create --chain ARC-TESTNET` would
target testnet (it doesn't — `create`'s own `--help` lists no chain flag,
and passing one anyway is silently accepted but ignored; both attempts
landed on the mainnet chain set instead): `0x13b7c6ee1ea4ad3efd280b89b911761969779909`
and `0x74e19e9559ac726953bf073b6f3c5e04b6574139`. Harmless — unfunded,
unreferenced anywhere — but they count against that account's 5-wallet
agent-wallet cap (3 of 5 now used there: consumer + these two).

**Not done as part of this entry:** no application code reads
`ORACLE_AGENT_WALLET_ADDRESS` / `CONSUMER_AGENT_WALLET_ADDRESS` yet —
they're provisioned and documented, ready for Phase 7.3 (Nanopayments)
and/or Phase 7.5 (CLI demo) to actually consume. Wiring them into any
runtime code path was explicitly out of scope for this phase by design.

---

## Post-submission: Circle Nanopayments Verification — No Code Gap Found (2026-08-01)

**Context.** Second step of the "Circle Agent Stack Integration" doc
(sibling to CLAUDE.md's Phase 7.2 above). Phase 7.1's research already
found something worth checking rigorously before writing any code: the
oracle and consumer appeared to already use `@circle-fin/x402-batching`
— the same package Circle's own reference Nanopayments demo
(`circlefin/arc-nanopayments`) is built on — rather than a hand-rolled
x402 implementation that merely looked similar. This entry is that check,
done properly instead of assumed.

**What was compared, concretely:**
- `oracle/src/index.js:88-101` — `loadProdX402()` calls
  `createGatewayMiddleware({ sellerAddress, facilitatorUrl, networks })`
  then `.require('$' + PRICE_USDC)`, wrapping `GET /api/price`.
- `consumer/src/settlement.js:286-291` — `new GatewayClient({ chain:
  "arcTestnet", privateKey }).onBeforePaymentCreation(gateGatewayPayment)`,
  then `client.pay(priceUrl)`.
- `oracle/src/chain.js:247-263` (`payForPriceViaGateway()`, used by
  `/admin/demo-pay`) — same `GatewayClient`, `client.getBalances()` /
  `client.deposit()` / `client.pay()` sequence.
- Against the reference repo's `lib/x402.ts` (`withGateway()`, manually
  calls `BatchFacilitatorClient.verify()` then `.settle()`) and
  `agent.mts` (buyer side: `new GatewayClient({chain, privateKey})`,
  `gateway.deposit()`, `gateway.pay(url, {method, body})`, the identical
  `onBeforePaymentCreation` lifecycle hook the SDK's own README
  documents).

**The check that actually settles the question, not just naming
similarity:** read `createGatewayMiddleware()`'s real implementation in
the installed package (`oracle/node_modules/@circle-fin/x402-batching/
dist/server/index.js`, v3.2.0). Line 720's `createGatewayMiddleware()`
instantiates `new BatchFacilitatorClient({url: config.facilitatorUrl,
...})` (line 721), and the `.require()` handler it returns calls
`facilitator.verify(paymentPayload, requirements)` (line 839) then
`facilitator.settle(paymentPayload, requirements)` (line 919) — the
exact same two `BatchFacilitatorClient` methods the reference repo's
`withGateway()` calls directly and manually. **Confirmed: arcid2's usage
is not a superficially-similar reimplementation — it is the identical
underlying Gateway batching machinery**, reached through Circle's own
documented top-level convenience API (the SDK README's "2 lines of code"
quick-start pattern: `createGatewayMiddleware({sellerAddress}).require(
'$0.01')`) rather than the reference demo's more manual, lower-level
path (which exists in that repo mainly because it also needs to log
every payment event to its own Supabase table — a constraint arcid2's
oracle doesn't share).

**A point in arcid2's favor found while reading the SDK source, not
assumed:** `createGatewayMiddleware()` dynamically queries the live
facilitator for supported networks and USDC addresses
(`facilitator.getSupported()`, filtered by `config.networks`) rather than
hardcoding them, unlike the reference repo's `lib/x402.ts`, which
hardcodes `ARC_TESTNET_NETWORK`/`ARC_TESTNET_USDC`/
`ARC_TESTNET_GATEWAY_WALLET` as constants. arcid2's config (`GATEWAY_
NETWORK=eip155:5042002`, `GATEWAY_FACILITATOR_URL=gateway-api-testnet.
circle.com`, `GATEWAY_DOMAIN=26`) matches those same real values, just
resolved live from the facilitator instead of pinned in source.

**Conclusion: no code gap, no new integration work.** Per the scoping
doc's own framing ("swap the single-shot settlement model for genuine
high-frequency nanopayments... replacing arcid2's existing direct
Gateway integration") — that framing assumed a gap that, on inspection,
doesn't exist. arcid2 already had a genuine Circle Nanopayments
integration before this phase was scoped; Phase 7.3 is documentation
only. Batching (off-chain-signed calls settling on-chain periodically,
gas-free) is inherent to `GatewayClient`/`BatchFacilitatorClient`
themselves — nothing for application code to add on top.

**What was actually changed this entry (docs only):**
- `SUBMISSION.md`'s "Circle tools used" bullet — added file:line
  pointers and the verification note above.
- `README.md`'s "Circle Stack" table — same verification note added to
  the existing Gateway Nanopayments row (this row already existed before
  Phase 7.3 — it was accurate, just not yet cross-checked against the
  reference implementation or the SDK's own source).
- This entry.

**Version note, not investigated further:** arcid2 runs
`@circle-fin/x402-batching@^3.2.0`; the reference repo pins `^2.0.4`
(server) / `^2.6.0` (`@x402/evm`, `@x402/core`). The core `verify()`/
`settle()` pattern this entry verifies held across that gap (confirmed
against the installed 3.2.0, which is what actually runs), but a full
2.x→3.x changelog diff wasn't done — flagged in case a future session
needs it, not because anything here depends on it.

---

## Post-submission: Circle Agent Marketplace Listing Package (2026-08-01)

**Context.** Third step of the "Circle Agent Stack Integration" doc.
Goal per the doc: get arcid2 listed somewhere Encode's judges and other
builders would actually find it.

**Research, done before writing anything (same standard as 7.1–7.3):**
`circle services --help` shows only `search`, `inspect`, `pay` — no
seller-facing publish/register verb. Circle's own `circlefin/skills`
repo's `accept-agent-payments` skill explicitly warns against assuming a
self-serve publish path exists: *"There may not be a self-serve publish
command. Treat marketplace listing as a submission package unless
current docs expose a registry API."* Confirmed live by fetching
`agents.circle.com/services`: the seller call-to-action links to a
Google Form (`forms.gle/7YFzvdmMcn1JH5tF6`), not an API. The exact
machine-readable listing schema in `MARKETPLACE_LISTING.md` was reverse-
engineered from real data, not guessed: pulled 792 live listings via
`circle services search --output json --limit 200`, and cross-checked
the shape against `circle services inspect` on an existing FINANCIAL_ANALYSIS
listing (Allium's price endpoint — the closest real analog to arcid2's
oracle) to confirm field names and the `payable`/`402` health-check
convention.

**What was added:** `MARKETPLACE_LISTING.md` — a complete submission
package: the listing JSON in Circle's real schema (`resource`, `accepts[]`,
`metadata.provider.{name,website,docsUrl,description,category,tags}`,
`path`/`method`/`description`/`output`), the additional fields the intake
form asks for (support URL, health-check endpoint, 402/200 evidence), and
the positioning decision the scoping doc asked for made explicitly: the
listing `description` frames arcid2 as the bonded/TEE-attested/adjudicated
trust layer, not just "a price feed" — while every field an agent would
actually invoke stays accurate to the real `/api/price` endpoint, nothing
padded to sound bigger than it is.

**Two blockers, flagged rather than glossed over — this is a package, not
a live listing:**
1. Re-verified this session, first-hand, not from the earlier Phala
   incident audit: `curl` against the documented CVM URL
   (`9c3a144f929db3e05d05bb03839a04527bda9841-3001.dstack-pha-prod5.
   phala.network`) times out on both `/health` and `/api/price`
   (SSL connect failure, `http_code=000`). The marketplace intake wants a
   live public base URL and health check — can't be demonstrated against
   a dead deployment. Redeploying the CVM is a bigger, riskier action
   than preparing a listing doc and wasn't done as part of this entry.
2. Actually submitting the Google Form is an external, identity-linked
   action (a real submission to Circle, under this project's name) —
   left as a deliberate manual step for whenever the redeploy happens,
   not taken automatically here.

**What was changed this entry:**
- `MARKETPLACE_LISTING.md` — new file, the submission package.
- `README.md`'s "Circle Stack" table — new Agent Marketplace row, marked
  "prepared, not yet submitted."
- `SUBMISSION.md`'s "Circle tools used" section — new bullet, framed the
  same way the USYC-allowlist-absent gap is already handled in this doc
  (artifact ready and verified; the one remaining external step named
  honestly rather than implied as done).
- `CLAUDE.md`'s Key Files — pointer to this entry and the file, with an
  explicit "don't treat this file's existence as proof of an active
  listing" note.

---

## Post-submission: Circle CLI in the Demo Flow (2026-08-01)

**Context.** Fourth and final step of the "Circle Agent Stack Integration"
doc (the marketplace form submission from the entry above is explicitly
out of scope here — separate task, pending the Phala CVM coming back
online). Goal: mirror the transcript's live-CLI demo style for at least
one beat, using arcid2's own commands alongside Circle's.

**Command mapping — which arcid2 CLI action has a natural Circle CLI
equivalent, specifically on the wallet/payment side (not a wholesale
replacement of arcid2's own tooling):**

| arcid2 command | Circle CLI equivalent | Relationship |
|---|---|---|
| `oracle`'s `/admin/demo-pay` route | `circle services pay <url> --address <wallet> --chain ARC-TESTNET` | Same action (one real Gateway-paid `/api/price` call) — arcid2's own admin route vs. Circle's CLI doing the identical thing from outside the app. Closest 1:1 pairing. |
| (no existing arcid2 equivalent) | `circle services inspect <url>` | New capability, not a replacement — shows pricing/scheme/health for any x402 endpoint without paying. Complements `oracle`'s own `/api/stats`. |
| `bond-status`/agent on-chain balance checks | `circle wallet balance` / `circle gateway balance --address <wallet> --chain ARC-TESTNET` | arcid2's own tooling reads `ArcIDBond`'s on-chain bond state; Circle's CLI reads the *wallet's* USDC/Gateway balance — different data, same "check balance via CLI" beat. |
| (no existing arcid2 equivalent) | `circle gateway deposit --amount <n> --address <wallet> --chain ARC-TESTNET --method direct` | New capability — moves a wallet's USDC into Circle Gateway on Arc Testnet directly from the CLI, no app code involved at all. |

**Live-verified, not just scripted — the same standard as every phase
before this one:**
1. `circle gateway balance --address 0x9867a0a4b7631a66b0433034a45e472023f809d6
   --chain ARC-TESTNET` — oracle Agent Wallet (from Phase 7.2), Gateway
   balance 0 USDC (never deposited before).
2. `circle gateway deposit --amount 0.5 --address 0x9867...09d6 --chain
   ARC-TESTNET --method direct` — real on-chain deposit. Discovered along
   the way: Gateway's deposit minimum is 0.5 USDC (`0.01` was rejected:
   `Invalid --amount '0.01'. Gateway deposit amount must be at least 0.5
   USDC.`) — real `approveTxHash`/`depositTxHash` returned, both real Arc
   Testnet transactions.
3. Started the oracle locally with `DEV_MODE=false` (temporarily, via an
   inline env override — never touched `oracle/.env` on disk) so
   `/api/price` serves the real `createGatewayMiddleware()` 402 challenge
   instead of the dev-mode bypass; confirmed via the startup log
   (`[x402] Production mode — payments verified + settled via Circle
   Gateway`). This mirrors why `/admin/demo-pay` itself already requires
   `DEV_MODE=false` — the dev-mode 402 shape isn't the real Gateway
   protocol Circle's CLI expects.
4. `circle services inspect http://localhost:3001/api/price --output
   json` — real, live: `{"status":"payable","httpStatus":402,"price":
   {"amount":"1000","formatted":"$0.001 USDC"},"scheme":
   "GatewayWalletBatched","seller":"0xe2F7a0E6d9865C7Dc9B5D19DCc11CBcb4655c661"}`.
5. `circle services pay ... --estimate` (dry run, no funds moved) — same
   requirements confirmed.
6. `circle services pay ...` (real) — succeeded: returned the oracle's
   actual signed response (`value`, `timestamp`, `oracle`, `signature`,
   `sla`) plus a payment receipt. Checked `/api/gateway-balance` before
   (`pendingBatch: "0"`) and after (`pendingBatch: "0.001000"`,
   `balance` unchanged) — the batching model made concretely visible,
   not just asserted: the payment lands in the pending batch, not an
   immediate balance bump.
7. Killed the temporarily-started oracle process afterward (`taskkill` —
   the Bash tool's own `$!` PID didn't match the actual node process on
   Windows; found the real PID via `netstat -ano | grep :3001` first).
   `oracle/.env` was never modified — the `DEV_MODE=false` override was
   process-local only.

**What was changed:**
- `SUBMISSION.md` — new "Beat 3.6 — Circle CLI, live" in the video
  script (marked optional/post-submission-addition, ~15s, placed right
  after Beat 3.5's settlement beat since it's the same payment rail);
  new bullet in "Circle tools used" pointing to it.
- This entry — the full command mapping table and live-verification
  record, so a future session (or a judge reading this file) doesn't
  have to take the beat's existence on faith.

**Explicitly not done, per this session's scope:** the marketplace form
submission from the entry above — that's a separate, later task once the
Phala CVM redeploy happens, not bundled into this one just because both
are "Circle Agent Stack" phases.

---

## Post-submission: ERC-8004 Reputation Dual-Write (2026-08-01/02)

**Context.** First code phase of "Grant-Readiness Repositioning" — a new
scoping doc responding to external (Perplexity deep-research) assessment
that arcid2 is "hackathon-competitive, grant-incomplete" for Circle
Developer Grants / Arc ecosystem funding. Core finding: Arc's own agent
standard, ERC-8004, explicitly excludes bonds/slashing from its scope —
arcid2's actual opening is to present as the bond/slash module that plugs
into that gap, not a competing registry. This entry is Phase 8.2: every
slash/settlement outcome should also write a `giveFeedback()` entry into
Arc's real, standard ReputationRegistry.

**Phase 8.1 (research, no commit) — real, live-verified, not assumed:**
read the actual ERC-8004 EIP text and Arc's registration tutorial, then
confirmed all three registries are real and live on Arc Testnet via direct
RPC calls, not just trusted from docs (same discipline as Phase 7.1):
- `eth_getCode` on IdentityRegistry (`0x8004A818BFB912233c491871b3d84c89A494BD9e`),
  ReputationRegistry (`0x8004B663056A597Dffe9eCcC1965A193B7388713`),
  ValidationRegistry (`0x8004Cb1BF31DAf7788923b405b754f57acEB4272`), and
  ERC-8183 (`0x0747EEf0706327138c69792bF28Cd525089e4583`) all returned
  real, non-empty bytecode.
- `eth_call` for `name()` on IdentityRegistry returned `"AgentIdentity"` —
  confirmed working, not a dead address.
- Both `arc.network` doc/blog URLs in the scoping doc 301-redirect to
  `arc.io` — noted, not treated as broken.
- `giveFeedback()`'s real signature has no room for arcid2's structured
  evidence (`breach_class`, `evidence[]`) — just `value` (int128 score),
  `valueDecimals`, two short `tag` strings, an `endpoint` string, and an
  off-chain `feedbackURI` + `feedbackHash` commitment pair. Confirms the
  scoping doc's anticipated fallback: arcid2's own events stay the full
  record, a compressed score/tag + hash goes to 8004. Full notes in the
  scratchpad's `phase8.1-notes.md` (uncommitted, per that sub-phase's own
  "no commit" instruction).

**Two explicit design decisions, made by the user before any code, not
assumed by Claude Code:**
1. **Value scale** — a real function of the same numbers ArcIDBond
   already computes (percentage of bond slashed, negative; 100 for a
   clean settlement), not an arbitrary separate scale.
2. **feedbackURI** — a real new public route
   (`GET /api/verdict/:verdictHash` on the oracle), serving the existing
   structured evidence/rationale as JSON, reusing data already in the
   audit trail — not a placeholder.

**What was built (all still in the repo, still correct, still tested —
see the pivot below for why it doesn't run the way it was originally
meant to):**
- `contracts/interfaces/IERC8004ReputationRegistry.sol` — minimal
  interface to Arc's real registry, signature taken from the EIP and
  confirmed against the real deployed bytecode.
- `contracts/interfaces/IERC8004ReputationAdapter.sol` +
  `contracts/ERC8004ReputationAdapter.sol` — a thin, separately-deployed
  adapter (not inlined into `ArcIDBond.sol`, which is already 850+ lines
  across six prior phases) holding a `wallet -> agentId8004` mapping and
  the value-scale math, called from `ArcIDBond`'s `_executeSlash()` /
  `recordSettlement()`.
- `ArcIDBond.sol`: new `reputationAdapter` address (owner-settable,
  defaults to zero — every existing deployment and every existing test
  keeps working unchanged until explicitly set), and a call into the
  adapter at the end of `_executeSlash()`/`recordSettlement()`, wrapped in
  `try {} catch {}`. **This try/catch is load-bearing, not defensive
  boilerplate** — new critical invariant, stated plainly: the ERC-8004
  dual-write must never be able to block or revert a real slash/
  settlement. Proved by test, not just asserted: `slash()`/
  `recordSettlement()` still succeed and transfer funds even when (a) the
  registry the adapter wraps reverts, and (b) the adapter contract itself
  is swapped for one that always reverts unconditionally — two
  independent layers of defense against the same failure mode.
- `_executeSlash()`'s evidentiary hash: `keccak256(reason)` for a direct
  `slash()` call (its ABI carries no separate hash param, deliberately
  unchanged — adding one would still be safe per the "no amount param"
  invariant, since a hash doesn't influence transferred amount, but
  wasn't needed once the hash could be derived from `reason` already in
  scope) — versus the dispute's own stored `rationaleHash` for
  `resolveDispute()`/`finalizeExpiredDispute()` (NOT a hash of the
  generic `"[DISPUTE APPROVED] ..."` placeholder string those two
  functions pass as `reason` — that would have been a strictly weaker,
  less meaningful evidence hash than the real rationale already on file).
  `recordSettlement()` reuses its existing `verdictHash` param directly.
  This is a real, pre-existing asymmetry across the three call shapes,
  not something invented for this feature.
- `oracle/src/index.js`: `GET /api/verdict/:verdictHash` — serves a
  matching record from the existing in-memory verdicts buffer. Honest
  limitation stated in the route's own comment: `verdictHash` isn't
  guaranteed unique per individual verdict occurrence (it's an outcome-
  hash, not a per-event UUID) — the route returns the most recent match,
  not a guaranteed 1:1 lookup. A property of the existing hash scheme,
  not a bug introduced here.
- `consumer/src/index.js`/`slasher.js`/`settlement.js`: every
  slash/settlement result now carries the exact `verdictHash` that became
  its on-chain evidence hash, attached to the logged/POSTed record.
- `test/ERC8004ReputationAdapter.test.js` — 27 new tests (158 total):
  value-scale math (including the full-drain and zero-bond edge cases),
  agentId-skip behavior, the try/catch safety net at both layers, and the
  dispute path's `rationaleHash` (not the placeholder string) reaching
  the adapter correctly.
- `scripts/deploy_erc8004_adapter.js`,
  `scripts/cli/register-8004-identity.js`,
  `scripts/cli/set-8004-agent-id.js` — deploy + identity-registration +
  agentId-wiring tooling, following this project's existing staged-
  rollout convention (deploy, then wire, as separate confirmed steps).

**The finding that changed the architecture, live-verified with real
transactions, not assumed:** deployed the real adapter to Arc Testnet
(`0x42a7A56962cc3E990b2Ac5E506602277aB3aefC5`), registered real oracle
(agentId `856872`) and consumer (agentId `856873`) identities in Arc's
real IdentityRegistry, wired the agentId mapping — then, testing the
actual dual-write against the real ReputationRegistry (temporarily
pointing the adapter's `bondContract` at the deployer to exercise it
directly, since the currently-live `ArcIDBond` predates even Phase 6.1's
bytecode and can't call this at all yet — same "redeploy is a separate
phase" precedent as 6.1–6.3), found:
- A direct EOA → `giveFeedback()` call **succeeds** — real tx, real
  feedback entry, confirmed externally via `getSummary()`
  (`count=1, value=-10`).
- The **identical call routed through a contract**
  (adapter → registry, or `ArcIDBond` → adapter → registry in the
  originally-intended design) **reverts** — caught by the adapter's own
  try/catch as `ReputationWriteFailed("unknown revert")`.
- Isolated via a spoofed-`msg.sender` `eth_call` (same adapter address,
  same bytecode, but implicitly `tx.origin == msg.sender` in a single-
  frame simulated call): **succeeds** — ruling out a
  "no-code/EOA-only-by-code-check" theory, since the adapter's address
  genuinely has code on-chain in that test too.
- Conclusion: **Arc's real ReputationRegistry rejects contract-relayed
  calls to `giveFeedback()` — it requires `tx.origin == msg.sender`, a
  genuine externally-owned-account-originated transaction.** Neither the
  EIP text nor Arc's tutorial documents this. Exactly the "docs say X,
  reality is Y" surprise the scoping doc told this phase to budget for —
  a bigger one than expected, since it invalidates the core premise of an
  atomic, same-transaction, contract-to-contract dual-write entirely, not
  just a parameter or config detail.

**Decision (asked and confirmed, not assumed):** keep the on-chain
adapter and `ArcIDBond` wiring exactly as built — harmless (every call
try/catches into a silent no-op against the real registry today),
forward-looking (real again if Arc ever relaxes this restriction, and
correct/tested regardless). Move the actual working write path off-chain:
a second, separate transaction, sent directly from the consumer's own EOA
(the same key that already calls `slash()`/`recordSettlement()`), right
after the first confirms.

**Atomicity trade-off, stated plainly, not glossed over:** this is now
two separate transactions. They can diverge — the slash/settlement can
succeed while the second write fails, or the process can crash in
between. Two real safeguards were built specifically because of that (not
a plain happy-path implementation):
- `consumer/src/erc8004.js` writes a durable **"pending" ledger entry
  BEFORE sending the tx** (`consumer/logs/erc8004_ledger.json`), updates
  it to `"confirmed"`/`"failed"` afterward, and never re-sends once an
  entry reads `"confirmed"` (idempotent on `verdictHash`, same dedup
  pattern as the existing settlement ledger).
- `checkForOrphanedWrites()`, run once at consumer startup, scans for any
  entry still `"pending"` from a prior run — meaning the process crashed
  or was killed between writing the marker and recording an outcome —
  marks it `"orphaned"` (a distinct terminal state; whether the tx
  actually landed is genuinely unknown, not guessed either way) and logs
  it loudly to `consumer/logs/erc8004_failures.jsonl`, matching this
  project's existing rule that failure classes get their own channel
  rather than being silently merged.
- Live-verified, not just unit-tested: real slash-shaped and settlement-
  shaped calls through `reportToERC8004()` produced real txs, confirmed
  externally via `getSummary()` (`semantic: count=1, value=-15`;
  `settlement: count=1, value=100`) and the ledger file. Separately
  injected a synthetic `"pending"` entry and confirmed
  `checkForOrphanedWrites()` correctly detects and logs it as orphaned on
  the next startup — the crash-recovery path was actually exercised, not
  just written and assumed to work.

**Explicit scope boundary, stated rather than left ambiguous:** the
off-chain write only fires for the consumer's routine loop
(instant `slash()` and `recordSettlement()`). It does NOT yet fire for the
dispute path (`resolveDispute()`/`finalizeExpiredDispute()`, resolved
later via `scripts/cli/dispute-resolve.js` — separate tooling, not
touched this phase). A disputed breach that later resolves will not get
an 8004 feedback entry until that CLI tooling is extended too — a known
gap, not a silent one.

**What was changed:**
- Contracts: `ERC8004ReputationAdapter.sol`, two new interfaces,
  `ArcIDBond.sol` (adapter hook + evidence-hash plumbing through
  `_executeSlash`/`_executeSlashOrVoid`/`slash`/`recordSettlement`/
  `resolveDispute`/`finalizeExpiredDispute`), two new mocks
  (`MockReputationRegistry.sol`, `MockBadReputationAdapter.sol`).
- Tests: `test/ERC8004ReputationAdapter.test.js` (27 new, 158 total,
  all passing).
- Scripts: `deploy_erc8004_adapter.js`, `cli/register-8004-identity.js`,
  `cli/set-8004-agent-id.js`, four new `package.json` script entries.
- Consumer: new `erc8004.js` (off-chain write + reconciliation), changes
  to `index.js`/`slasher.js`/`settlement.js` to compute and thread the
  right evidence hash through, new `ORACLE_AGENT_ID_8004` config.
- Oracle: new `GET /api/verdict/:verdictHash` route.
- Real on-chain state changed this phase (Arc Testnet): two new ERC-8004
  identities registered (oracle agentId `856872`, consumer agentId
  `856873`), one adapter contract deployed
  (`0x42a7A56962cc3E990b2Ac5E506602277aB3aefC5`), agentId mappings set,
  and — from live verification — two real feedback entries written
  against the real ReputationRegistry for the oracle's agentId (one
  semantic-tagged, value -15; one settlement-tagged, value 100).

---

## Post-submission: Unbonded-Agent Gating + Grant Metrics Dashboard (2026-08-02)

**Context.** Phase 8.5 of "Grant-Readiness Repositioning" — two checklist
items explicitly scoped as "natural extensions of Phase 7.4/7.5's
already-built pieces," dashboard aggregation over data that already exists
on-chain, not new trust logic.

**Marketplace gating.** The scoping doc itself was uncertain whether
arcid2's model supports consumer-side bonding, and explicitly said to
"clearly document that today only providers bond" if not — checked, and
confirmed: `ArcIDBond.sol` has no consumer-side bond concept at all, only
providers post collateral. Per the doc's own fallback wording ("bonded OR
registered"), gating instead checks *registration* — the same
`agentIdBySigner()` moat `postBond()` already enforces, reused rather than
duplicated. New `oracle/src/chain.js#isRegisteredAgent()`, wired into
`devX402Middleware()` behind a new `REQUIRE_REGISTERED_CALLER` env var —
**opt-in, default off.**

Why default off, a real decision not a hedge: turning this on
unconditionally would refuse any outside consumer agent that pays via
x402 but isn't itself TEE-registered in ArcIDRegistryV2 — directly cutting
against the real-outside-traffic traction goal the scoping doc's own
research explicitly flags as arcid2's actual decisive weakness ("1–2 out
of 5"). Shipping this as a silent default-on gate would have risked
quietly blocking the exact traffic this project most needs, in the name of
a checklist item about a different judging axis entirely. Live-verified
both states, not assumed: with the flag on, a request from the real,
already-registered consumer wallet is served and a request with an
unregistered/random payer address gets a real `403`; with the flag off
(default), the same unregistered-payer request is served exactly as
before — confirmed by actually starting the oracle both ways and curling
both cases, not just reading the code.

**Production-mode gap, stated rather than silently unhandled:** this only
gates the `DEV_MODE` x402 path (`devX402Middleware`). The real Gateway path
(`createGatewayMiddleware().require()`) settles payment and calls the
route handler as one automatic block — by the time this file's own code
runs, payment has already cleared, so gating the caller *before*
settlement in production would require dropping to the manual
`BatchFacilitatorClient.verify()`/`.settle()` pattern (confirmed
functionally equivalent to the convenience wrapper in the Phase 7.3 entry)
instead of the one-line `createGatewayMiddleware()` call currently used.
Not built this pass.

**Grant metrics dashboard.** New aggregations, all reading events/fields
that already exist:
- `oracle/src/index.js`'s in-memory `stats` object gained
  `deterministicVerdicts`/`semanticVerdicts`, tallied from each verdict's
  existing `tier` field (both at `POST /api/verdicts` and
  `/admin/trigger-cycle`'s own bad-sig demo path, which is always Tier 1).
- `oracle/src/chain.js#getChainStats()` now also reads `PaymentSettled`,
  `IndictmentFiled`, and `DisputeResolved` events (all already emitted by
  `ArcIDBond.sol` since Phases 1/6/post-submission) and computes
  `disputeRate` (indictments / (indictments + instant slashes)),
  `cumulativeThroughputUsdc` (slashed + settled volume), and the two
  volumes separately.
- `frontend/src/components/GrantMetricsCard.jsx` — new sidebar card, three
  stat tiles (Tier-1 share, challenge rate, cumulative throughput),
  styled to match the existing `AgentCard`/`USYCBondCard` glass-tile
  language exactly (same `.gh` card shell, same label/value tile
  structure) rather than introducing a separate visual system. Per the
  `dataviz` skill's own guidance (loaded before writing this), three
  status-style numbers are a stat-tile job, not a chart — no new palette
  needed, reused this app's already-established violet/cyan/orange
  system instead of the skill's generic default.

**Verification, live where practical:** contract test suite unaffected
(no contract changes this entry — pure off-chain/frontend work), oracle
JS syntax-checked, the gating behavior live-tested in both states against
a running oracle (see above). `/api/stats` confirmed serving the new
`deterministicVerdicts`/`semanticVerdicts` fields correctly on a fresh
start. `/api/chain-stats`'s new fields depend on a full historical event
scan against the existing (slow, rate-limited-RPC) cold-start scan
`chain.js` already has — exercised, not skipped, though the scan itself
predates this entry and isn't something this phase changed. Frontend:
`npm run build` succeeds cleanly with the new component; Vite serves both
`App.jsx` and `GrantMetricsCard.jsx` without transform errors. **Not
independently confirmed via an actual rendered screenshot** — no browser
tool was available this session; verified by successful build + strict
adherence to the existing component's exact style patterns instead, per
this project's own rule to say so explicitly rather than claim a UI
verification that didn't happen.

**What was changed:**
- `oracle/src/chain.js` — `isRegisteredAgent()`, three new event reads in
  `getChainStats()`, new summary fields.
- `oracle/src/index.js` — gating in `devX402Middleware()`,
  `deterministicVerdicts`/`semanticVerdicts` tallying in two places.
- `oracle/src/config.js` — new `REQUIRE_REGISTERED_CALLER` (default false).
- `frontend/src/components/GrantMetricsCard.jsx` — new component.
- `frontend/src/App.jsx` — wired in.
- `README.md`, `CLAUDE.md` — new sections/Key Files entry.

---

## Post-submission: ERC-8183 Premium Job Flow (2026-08-02)

**Context.** Phase 8.3 of "Grant-Readiness Repositioning" — the doc's own
"heaviest lift" item: one concrete, live-verified ERC-8183 job showing
arcid2's bond/verdict logic composed into a job's evaluator step.

**Architectural decision, made by the user before any code, not assumed:**
do NOT reuse the existing $0.001 price-feed call for this. A genuinely
separate, higher-value service tier — "premium oracle analysis" — sold
specifically through the ERC-8183 job flow, priced meaningfully above the
Nanopayments price feed. The existing price feed stays completely
untouched. One real payment per mechanism, matched to the transaction's
actual value — never two payments for the same call. Price chosen:
**$0.05 USDC** (50x the $0.001 feed) — a real, if arbitrary, judgment call,
adjustable via `PREMIUM_PRICE_USDC`.

**Research before code, same discipline as every prior phase.** Phase
8.1's own notes only had a blog-level summary of ERC-8183's interface —
not enough to safely move real money against. Found the real contract:
the address from Phase 8.1 (`0x0747EEf0706327138c69792bF28Cd525089e4583`)
is an ERC-1967 **proxy** — the real ABI lives at its implementation,
`AgenticCommerce` (`0xA316fd02827242D537F84730F8a37D0BA5fd351a`), fetched
and verified via Arc's block explorer's contract-verification API
(`is_verified: true`, Etherscan bytecode verification). Confirmed, not
assumed:
- `JobStatus` enum: `Open, Funded, Submitted, Completed, Rejected, Expired`.
- `fund()` requires a standard prior ERC-20 `approve()` — `safeTransferFrom`,
  no permit/signature path.
- `setBudget()` is **provider-only** (the oracle sets its own price, not
  the client) — call order matters: `setBudget()` before `fund()`, or
  `fund()` silently transitions to `Funded` with a zero budget.
- `complete()` splits the budget three ways: `platformFee` + `evaluatorFee`
  (both bps-based) to the platform/evaluator, net to the provider.
  `reject()` (from `Funded`/`Submitted`) refunds the **full** budget to the
  client — no evaluator fee taken on a rejection.
- The `Job` struct does NOT store the submitted `deliverable` hash — only
  the `JobSubmitted` event does. The evaluator must read the event, not a
  struct field, to verify it (same event-reading pattern this project
  already uses everywhere else for verification).
- `createJob()`'s `hook` is checked against a whitelist unless
  `address(0)` — used `address(0)` throughout, deliberately avoiding the
  whitelist question entirely rather than guessing at it.

**What was built:**
- `oracle/src/signer.js` — `signPremiumAnalysis()`, a new signing function
  for the richer payload (not a reuse of the existing `signResponse()`,
  which is hard-bound to the `(value, timestamp)` shape). The message hash
  doubles as the ERC-8183 `deliverable` bytes32 — same "hash the evidence,
  verify no tampering" pattern as `verdictHash`/`rationaleHash` elsewhere.
- `oracle/src/index.js` — `POST /api/premium-analysis` (generates, signs,
  caches a payload keyed by jobId — small in-memory map, not a rolling
  buffer, since the exact same payload that was hashed into `submit()`
  must later be served unchanged, not regenerated) and
  `GET /api/premium-analysis/:jobId`. Neither route is x402-gated — payment
  for this tier is the job's own escrow, not Nanopayments. Supports the
  same `?fault=bad-sig`-style fault injection as the existing demo commands
  (a structurally-valid-but-wrong signature), so the reject()+slash
  composition path is demoable on command, not just the happy path.
- `scripts/cli/demo-erc8183-job.js` (`npm run demo:premium-job`) — the full
  8-step live cycle: `createJob()` (client=consumer) → `setBudget()`
  (provider=oracle) → approve + `fund()` (client) → oracle generates+signs
  via live HTTP call → `submit()` (provider) → evaluator (consumer) fetches
  + independently recomputes the deliverable hash + verifies the
  signature + checks freshness + checks `isActiveBondedAgent()` on the
  live `ArcIDBond` → `complete()` or `reject()` (evaluator) → on a
  confirmed **hard** breach specifically (bad signature or hash mismatch —
  mechanical, not a judgment call, same Hard/Semantic classification the
  real consumer flow already uses), **also** calls the existing,
  untouched `ArcIDBond.slash()` — composition, not duplication: the job
  escrow and the bond collateral are two separate pools of funds, and a
  refund from one is not a substitute for the other reacting to a real
  breach.

**Live-verified end to end, both paths, real transactions, first attempt
succeeded on both (no docs-vs-reality surprise this time, unlike Phase
8.2):**
- **Clean path:** job `163870` — created, budgeted ($0.05/50,000 atomic),
  funded, oracle delivered a real signed analysis
  (`value=3440.09 trend=down sma=3450.76 volatilityBps=19`), evaluator
  confirmed hash match + valid signature + freshness + active bond, called
  `complete()` — real `PaymentReleased(50000)` to the oracle, final status
  `Completed`.
- **Fault path (`--fault bad-sig`):** job `163871` — identical flow up to
  delivery; the tampered signature correctly failed verification (ethers
  itself rejected it: `non-canonical s`), classified as a hard breach,
  evaluator called `reject()` — real `Refunded(50000)` to the consumer,
  **and** the composed `bond.slash()` call fired for real:
  `AgentSlashed` transferred `495000` (10% of the bond's $4.95 remaining
  at the time — the existing Hard-breach cap math, unchanged, doing
  exactly what it already does elsewhere), final job status `Rejected`.
  Confirmed afterward the oracle's bond was NOT escalated/blacklisted by
  this test slash (`4.455` USDC remaining, `slashed: false`,
  `active: true`) — a normal proportional slash, not a full drain.
- Both runs used real Arc Testnet wallets/contracts this project already
  controls (oracle + consumer keys), same "both roles are ours" pattern
  every other demo command in this repo already uses — not a simulated
  third party.

**What was NOT built, a stated scope boundary:** the oracle does not run
as a standing service that watches for and auto-fulfills arbitrary
incoming jobs — this is a scripted, one-command demo cycle
(`npm run demo:premium-job`), matching the doc's own framing ("one real,
demoable job," not a rebuilt marketplace). `EvaluatorFeePaid` did not fire
on the clean-path run (evaluator fee bps is apparently configured at 0 on
the live contract, or some other reason the script didn't investigate
further) — noted, not chased down, since `PaymentReleased` already
confirmed the completion worked correctly either way.

**What was changed:**
- `oracle/src/signer.js` — `signPremiumAnalysis()`.
- `oracle/src/index.js` — two new routes, endpoint listing updated.
- `oracle/src/config.js` — `PREMIUM_PRICE_USDC` (default `0.05`).
- `scripts/cli/demo-erc8183-job.js` — new file.
- `package.json` — `demo:premium-job` script entry.
- Real on-chain state changed (Arc Testnet): two real `AgenticCommerce`
  jobs created/funded/submitted/resolved (`163870` completed, `163871`
  rejected), one real `ArcIDBond.slash()` executed
  (`0xBEBD8a19C1BE2802829c1fc50066348EBBD86b3f`, oracle bond
  `4.95 → 4.455` USDC).

---

## Post-submission: Intended Mainnet Agent Wallet Spend Policy (2026-08-02)

**Context.** Phase 8.4 of "Grant-Readiness Repositioning" — explicitly
scoped as documentation, closing the checklist item honestly given Phase
7.2's finding that Circle's Agent Wallet spend policies are mainnet-only.
The doc's own instruction: "no new code required unless Claude Code finds
something genuinely testable within testnet's limits — check, don't
assume."

**Checked, not assumed — re-verified live rather than trusted from Phase
7.2's memory (product behavior can change between phases):**
- `circle wallet limit --help` now states outright, in the CLI's own
  option description: `"-c, --chain <chain>  Mainnet blockchain
  (required; testnets not supported)"`.
- `circle wallet limit --address 0x9867...09d6 --chain ARC-TESTNET`
  (the real oracle Agent Wallet from Phase 7.2) returns a real,
  unambiguous rejection: `"Policy limits are only available on mainnet
  chains. 'ARC-TESTNET' is a testnet."`
- Conclusion: still nothing testable on testnet — the finding holds, now
  confirmed against the CLI's own current behavior rather than carried
  forward from an earlier phase's notes. No new code, per the doc's own
  conditional instruction.

**A richer detail found while re-checking, worth documenting well beyond
"it's mainnet-only":** `circle wallet limit set --help` reveals the
policy primitive supports more than an amount cap —
`--rule-type transfer-limit | recipient-blocklist | recipient-allowlist |
contract-blocklist | contract-allowlist`. `contract-allowlist`
specifically is directly analogous to `ConsumerSessionKeyGuard.sol`'s
existing on-chain design (a fixed target contract, no general-purpose
`execute(target, data)` escape hatch) — worth specifying as part of the
intended mainnet configuration, not just the transfer-limit numbers.

**Intended mainnet configuration, documented in `README.md`, derived from
numbers that already exist rather than picked for looks:**
- `contract-allowlist` restricting the wallet to `ArcIDBond`'s address
  only — defense-in-depth alongside (not instead of) the existing guard
  contract.
- `transfer-limit` caps computed directly from `ArcIDBond`'s live
  slash-schedule constants (`hardCapBps=1000`, `semanticCapBps=100`,
  `semanticFeeMultiple=100`, `serviceFeeAtomic=$0.001`): `--per-tx` =
  the largest single non-escalating slash amount (Hard's 10% cap, the
  larger of the two classes), `--daily` = 100% of bond (the worst-case
  full-drain-via-escalation ceiling — nothing legitimate should ever move
  more than the entire bond in one day), `--weekly`/`--monthly` scaled
  out further to leave headroom for real settlement-payment volume on
  top of the slash-side worst case. Worked concretely against the
  current $5.00 bond default ($0.50 / $5.00 / $10.00 / $30.00) and
  expressed as a formula (`bondSize × hardCapBps ÷ 10000` for per-tx) so
  it scales to any real bond size, not just the demo's.

**Honest scope statement, not glossed over:** this describes what arcid2
*would* apply if an Agent Wallet ever became the actual signing custody
for outbound payments on mainnet. As of Phase 7.2's explicit decision,
Agent Wallets remain custody/balance-check only today —
`ConsumerSessionKeyGuard.sol` is still the sole signer for
`slash()`/`fileIndictment()`/`resolveDispute()`, unchanged by this entry.

**What was changed:** `README.md` (new "Intended Mainnet Agent Wallet
Spend Policy" section + a Circle Stack table row), `SUBMISSION.md` (new
bullet). No contract, script, or application code changed this phase —
purely documentation, per the doc's own conditional commit-message
instruction.

---

## Post-submission: Proof-of-Exploit — a second vertical on the same primitive (2026-08-07)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. This is a genuinely new vertical, not an extension of the
price-oracle one — built in two stages: a throwaway spike
(`spike/proof-of-exploit/`, kept in the repo as a record of what was
proven first and cheaply) to de-risk the highest-uncertainty piece before
committing to the full build, then the real build described below.

**The pitch.** arcid2's core mechanism — an agent posts collateral, a
TEE-attested verifier judges an outcome, a confirmed breach pays out
automatically on-chain — was built around one problem (did an oracle meet
its SLA, judged by Claude). This adds a second, deliberately different
problem on the *same* mechanism: **a TEE-attested, automated bug bounty.**
A target owner registers a contract + invariant + bounty pool. A
registered, TEE-attested verifier wallet runs a known exploit class
against the target, checks a deterministic invariant, and signs a verdict.
A confirmed exploit pays the researcher automatically.

**Why this is a different claim than the price-oracle vertical, not a
restatement of it:** the price-oracle vertical's payout decision is an LLM
judgment call (Claude reasoning about whether a response was a genuine
breach). This vertical's payout decision is **not** — "did the invariant
break" is checked by actually running the code, yes/no, deterministically.
No LLM anywhere in the payout-critical path. TEE-attested identity is the
whole differentiator here, not a supporting detail alongside an LLM.

**Checked against a named competitor, not assumed:** AgentIndemnity (a
real, existing USDC-backed performance-bond product on Arc, priced via
Circle Gateway Nanopayments) already occupies the "agent posts bond,
harmful output slashes it" category the price-oracle vertical is in — a
web search before scoping this confirmed that directly, rather than taking
it on faith. The same search found no live Arc/Circle product combining
TEE attestation with automated, on-chain bug-bounty payout — closest hits
were academic proposals and conventional (human-triage, non-TEE) bounty
platforms. Stated as "no evidence found," not "provably doesn't exist" —
search coverage of a very recent hackathon submission is never guaranteed.

**What was added:**

| Area | What |
|---|---|
| `contracts/vulnerable/VulnerableVault.sol` | Deliberately vulnerable demo target — classic checks-effects-interactions reentrancy bug (sends ETH before zeroing the caller's tracked balance). |
| `contracts/vulnerable/VulnerableVaultFixed.sol` | The negative control — identical contract, CEI-corrected. Kept as a real, checked-in demo path (not just a spike artifact) so the harness can prove it clears a patched target, not only flag a broken one. |
| `contracts/vulnerable/ReentrancyAttacker.sol` | The exploit payload. Stops reentering once the vault can no longer cover one more withdrawal, instead of a fixed hop count — a naive fixed-count version was tried first and found (in the spike) to revert the *entire* attack transaction once it attempts one withdrawal too many, erasing every earlier successful drain in the same call stack. Documented in the contract's own comment as a real gotcha, not a hypothetical one. |
| `contracts/ExploitBounty.sol` | New, small, deliberately NOT an `ArcIDBond` extension — `ArcIDBond`'s `slash()` punishes the bond-holder for their own misbehavior; a bounty pays a third-party researcher out of a pool the target owner funded voluntarily. `registerTarget()` (open to anyone — no TEE-gating on the bounty poster, only on the verifier), `submitVerdict()` (restricted to a single owner-set `authorizedVerifier`, additionally checked against `IArcIDRegistry.agentIdBySigner()` — the same interface `ArcIDBond` already uses, so the verifier's identity is the same class of proof, not a new trust claim), `withdrawBounty()`. Fixed full-bounty-per-finding payout only, no proportional/tiered schedule — a bug bounty conventionally pays a flat amount per validated finding. |
| `test/VulnerableVault.test.js`, `test/ExploitBounty.test.js` | 17 + 34 = 51 new tests (209 total, up from 158) — both exploit directions (drains the vulnerable vault, clears the patched one, including a regression test for the revert-unwind gotcha above), full `ExploitBounty` access control (both independent verifier gates, invariant-ID mismatch, double-claim prevention, owner withdrawal, verifier rotation). |
| `bounty/harness.js` | Runs the exploit against a **fresh local deployment** of `VulnerableVault` (ported from the spike, already proven there), signs the verdict with the registered `BOUNTY_VERIFIER_PRIVATE_KEY` wallet, submits `submitVerdict()` for real on Arc testnet. Two independent network contexts in one process, deliberately not conflated: `hre.ethers` bound to the local `--network hardhat` (the exploit itself) and a separate, independent `JsonRpcProvider` pointed at Arc testnet (the on-chain submission) — see the file's own doc comment. |
| `bounty/server.js` | HTTP submission entrypoint, `POST /submit`, gated by an x402 anti-spam fee — copy-adapted from the exact `devX402Middleware` pattern already in `oracle/src/index.js` (same 402 shape, same dev-stub-accepts-any-header behavior). DEV_MODE only — no real Circle Gateway settlement wired for this vertical, stated plainly rather than left to read as done by omission. |
| `scripts/deploy_exploit_bounty.js` | Deploys `ExploitBounty` pointed at the **existing** `ArcIDRegistryV2` (read from `deployments/<network>_standalone.json`, same discipline as `deploy_bond_v2.js` — never touches the identity layer). Also provisions a **dedicated** verifier wallet (separate from the oracle/consumer wallets, avoiding nonce contention with the live price-oracle vertical's running processes) — funds it, registers it via the same DCAP-prototype-quote flow `deploy_standalone.js` already uses, wires it as `authorizedVerifier`. The generated private key is written directly to `.env` and never printed to stdout. |
| `scripts/cli/bounty-register-target.js`, `scripts/cli/bounty-submit.js` | Standard `scripts/cli/*.js` conventions (`requireEnvKey()`, flag-based args for non-secret parameters). `bounty-submit.js` is a thin wrapper that shells out to `hardhat run bounty/harness.js` — stated plainly in its own comment, not hidden — because the exploit needs a real local EVM, which only Hardhat's runtime provides; every other `scripts/cli/*.js` tool talks to already-deployed contracts via a plain provider and has no such need. This is the fallback demo path if the frontend runs short on time. |
| `frontend/src/components/ProofOfExploitCard.jsx` | One new component — target ID + researcher address inputs, "Run exploit" / "Negative control" buttons, verdict + real payout tx link. One additive import + render line in `App.jsx`, no other existing component touched. Talks directly to `bounty/server.js` (its own CORS headers, not proxied through `frontend/vite.config.js`, which was left untouched). |

**Explicitly cut for time, stated rather than silently absorbed:**
forking Arc testnet's live RPC state (`hardhat_reset`-style forking
pointed at the real deployed target contract) was the original scoping
doc's stretch goal — a decision was made *before* building the harness to
commit to fresh-local-deployment instead and not attempt it at all, not a
fallback discovered mid-build. The harness deploys its own fresh copy of
the exact same `VulnerableVault` bytecode with seeded state, rather than
forking a literal already-deployed instance's live state. The
`registerTarget()` reference `targetContract` address IS a real, separately
deployed instance on Arc testnet (for a real, inspectable address on the
explorer) — but the harness's own invariant check runs against its own
fresh local copy, not that live one. Also cut: real Circle Gateway
settlement for the x402 anti-spam gate (dev-stub only, see
`bounty/server.js` above), and open/arbitrary exploit-code submission
(the harness runs one pre-registered, known exploit class — reentrancy —
against one pre-written vulnerable contract, not arbitrary
researcher-supplied code).

**Live-verified on Arc testnet, both directions, real transactions:**

| | |
|---|---|
| `ExploitBounty` | `0x52fB6011a6FaCD0f86CC28b32cDF85Df47449A61` |
| Verifier wallet (dedicated, TEE-registered) | `0x95C80031Ec9831cD5A830AF61616CC68e6B9d671` — agentId `0xa86231d2647014006cafd9b5c5b21be8947ab06bc89e2b7ee0e1651170ff6497` |
| Target 1 — confirmed exploit | `VulnerableVault` at `0x53Cc93a28C839EEA98FF87abF4c7994EAe81dA6a`; `submitVerdict()` tx [`0xeee331d0...`](https://testnet.arcscan.app/tx/0xeee331d0b03120421511939e23444d497bf748a9cc6920ba8de57570f0546a9f) — 2 USDC paid to the researcher for real, `claimed=true` confirmed on-chain afterward. |
| Target 2 — negative control | `VulnerableVault` at `0xfeBe8b00fb6d8e7eB63E9b62340e42f407A4b4A8`; `submitVerdict()` tx [`0x52d32eef...`](https://testnet.arcscan.app/tx/0x52d32eef70d0a7c3391eaefe12648df13c7312714deac04e72fac0412e48a6f8) — `exploitConfirmed=false`, zero funds moved, `claimed=false`/`bountyAmount=2.00 USDC` confirmed unchanged on-chain afterward. Also exercised via the live HTTP `/submit` endpoint (CORS + x402 dev-gate both verified against a real request shaped exactly like the frontend's own fetch call). |

**What NOT touched, confirmed:** `ArcIDBond.sol`, `DCAPVerifier.sol`,
`ArcIDRegistryV2.sol`, `ConsumerSessionKeyGuard.sol`, every existing
interface, every existing test file, `oracle/src/index.js`'s existing
routes, `oracle/src/chain.js`, `signer.js`, `attest.js`, every file under
`consumer/`, and every existing frontend component beyond the one
additive `App.jsx` line. `npm test` was run after every phase of this
build (not just at the end) and stayed green throughout — 209 passing at
completion, up from 158 at the start of this entry, zero regressions in
the pre-existing 158. The price-oracle vertical's live demo path,
deployed contracts, and Phala CVM were not touched or redeployed.

---

## Post-submission: Licensed AI Training Compensation Rail — a third vertical, real TEE ingestion (2026-08-12)

**Context.** Same post-form-lock, extended-event-window basis as every
entry above. Built to a written Phase 0 scoping doc reviewed and confirmed
before any code — same discipline the Proof-of-Exploit spike used, applied
this time without a throwaway spike stage (the highest-uncertainty piece,
real enclave ingestion, was de-risked by building it directly against
real deployed contracts and checking correctness at every phase, not by a
separate spike first).

**The pitch.** A third, deliberately different problem on the same
bond/attestation primitive: AI companies license training data from
independent artists instead of scraping it. An artist registers a track
(fingerprint hash + rights-metadata commitment). An AI company deposits
USDC into a pool and commits a Merkle root over its intended training
corpus before training. A TEE-attested ingestion enclave verifies the
corpus against that commitment and against artist licensing, computes an
equal-split compensation allocation, and signs it. Artists claim their
exact share via a real on-chain Merkle proof. Reputation-as-collateral
becomes licensing-as-collateral — the same "attest, then let a smart
contract act on the attestation" shape as the other two verticals, a
third distinct payout trigger (N-recipient claim, not a 1:1 slash or
1:1 bounty).

**Why this is a different claim than either existing vertical:** the
price-oracle vertical's payout decision is an LLM judgment call; the
Proof-of-Exploit vertical's is a deterministic yes/no from actually
running code, with no privacy claim attached. This vertical's payout
decision is deterministic **and** the enclave's whole reason for existing
is data confidentiality — the training corpus is never supposed to become
public, which neither existing vertical claims or needs. That's why this
vertical, alone among the three, was scoped and built to run its real
logic inside a real Phala TDX CVM rather than taking the Proof-of-Exploit
harness's "attest the wallet once, run the heavy logic anywhere" shortcut
— see the real-vs-simulated section below for exactly how far that went
this session.

**What was added:**

| Area | What |
|---|---|
| `contracts/ArtistRegistry.sol` | Permissionless track registration (fingerprint hash + rights-metadata hash), same trust shape as `ExploitBounty.registerTarget()` — no TEE-gating on the artist, since the trust-critical identity in this vertical is the ingestion enclave, not the registrant. Deliberately minimal — no `Ownable`, no `ReentrancyGuard`, no funds move here. |
| `contracts/TrainingPool.sol` | AI company escrow + corpus-root commitment. Structurally closest to `ExploitBounty.sol`, not `ArcIDBond.sol` — `createPool`/`distributeToClaimContract`/`withdrawPool` mirror `registerTarget`/`submitVerdict`/`withdrawBounty` directly, single full-amount release, `distributed`/`withdrawn` mutual exclusion in both directions. |
| `contracts/CompensationClaim.sol` | The N-recipient payout layer — genuinely new shape, not present in either existing vertical. Ingestor gating mirrors `ExploitBounty.submitVerdict()` exactly (`authorizedIngestor` + per-call `IArcIDRegistry.agentIdBySigner()`). `submitAllocation()` pulls the pool's escrowed funds in from `TrainingPool` in the same call the allocation is recorded in. `claim()` is a real Merkle-proof claim via `MerkleProof.verify()` (`@openzeppelin/contracts`, already a dependency) — not a simplified direct-transfer loop, a deliberate correction made during Phase 0 review before any contract code was written. |
| `contracts/mocks/MerkleProofTestHelper.sol` | Test-only — exposes OZ's internal `MerkleProof.verify()` externally so the off-chain JS tree builder's proofs could be checked against the *real* on-chain verifier, not just self-consistency with its own reimplementation of the pairing rule. |
| `ingestor/` (new top-level service) | The real TEE ingestion enclave — `src/merkle.js` (hand-rolled, OZ-compatible sorted-pair tree builder, double-hashed leaves), `src/allocator.js` (integrity check against the committed corpus root + licensing check against `ArtistRegistry` + equal-split-per-track allocation, exact remainder handling, multi-track-per-artist aggregation), `src/signer.js` (EIP-191 signs `(poolId, allocationRoot)`, same pattern as `oracle/src/signer.js`), `src/attest.js`/`Dockerfile`/`docker-compose.phala.yml` (direct structural port of the oracle's real Phala TDX deployment pattern — same `USE_REAL_PHALA` split, same dstack Unix-socket integration). |
| `test/ArtistRegistry.test.js`, `test/TrainingPool.test.js`, `test/merkle.test.js`, `test/allocator.test.js`, `test/ingestorSigner.test.js`, `test/CompensationClaim.test.js` | 61 new tests (270 total, up from 209) — including proofs verified against the real on-chain `MerkleProof.verify()` (not just JS self-consistency), an allocator integration test against real deployed `ArtistRegistry`/`TrainingPool` (not mocks), and a full Phase-2/3/4 pipeline integration test: real registration, real pool, the real `ingest()` function run against live contract state, real submission, two artists independently claiming the correct amount via real Merkle proofs. |
| `scripts/deploy_training_compensation.js` | Deploys all three contracts pointed at the **existing** `ArcIDRegistryV2` (read from `deployments/<network>_standalone.json`, same discipline as every other `deploy_*.js`). Provisions a dedicated ingestor wallet — generate-or-reuse, fund, register via the exact same DCAP-prototype-quote flow `deploy_standalone.js`/`deploy_exploit_bounty.js` already use — and wires two separate authorizations correctly: `TrainingPool.authorizedDistributor` → the `CompensationClaim` **contract** address, `CompensationClaim.authorizedIngestor` → the ingestor **wallet** address. |
| `scripts/cli/demo-training-compensation.js` | The primary demo path — register → deposit → ingest → claim, one script, real HTTP call to the real ingestor service (closer to `demo-erc8183-job.js`'s "fetch from a real running service" shape than `bounty-submit.js`'s "spawn a throwaway local EVM" shape, since the ingestor is a genuine standalone service here). `scripts/cli/_lib.js` extended with the same per-vertical loader/ABI/contracts-getter pattern already established for the session guard and bond-v2 verticals. |

**A real bug found and fixed during live verification, not glossed over:**
sequential same-signer transactions (fund wallet → fund wallet → fund
wallet; approve → createPool) hit `NONCE_EXPIRED` against an auto-mining
local node — ethers' default "pending" nonce lookup reused a stale value
across back-to-back sends from one wallet within the demo script. Fixed
with explicit self-incrementing nonces everywhere the same signer sends
more than one transaction in a row in `demo-training-compensation.js`.
Caught by actually running the script, not by inspection.

**Real vs. simulated — stated plainly, same standard as every other
vertical in this repo:**

- **Real:** all three contracts deployed and live on Arc testnet; the
  ingestor wallet's TEE registration (a genuine `registerAgent()` call
  against the same live `ArcIDRegistryV2` every other vertical uses); the
  Merkle tree construction, the equal-split allocation math, the EIP-191
  signature, the on-chain claim — all real code, real tests, and (see
  below) a real end-to-end run on real Arc testnet with real USDC.
- **Simulated / placeholder, unchanged from the original Phase 0 scope:**
  audio fingerprinting (fingerprint hashes are `keccak256` of arbitrary
  demo labels, not derived from actual audio analysis — no fingerprinting
  algorithm exists in this repo); corpus scale (3 demo tracks, not the
  millions a real training run would use — the Merkle mechanism itself is
  indifferent to tree size, but nothing here exercises that scale);
  rights-terms encoding (`rightsMetadataHash` is a placeholder commitment,
  not an encoding of actual royalty/usage/term licensing terms — no such
  schema exists); rights verification (`ArtistRegistry` is first-come,
  permissionless, stated in its own header comment — nothing checks that
  a registrant actually owns what they register); allocation rule (equal
  split per track, not usage- or duration-weighted — the simplest rule
  confirmed sufficient for demo scope in Phase 0).
- **The one honest gap carried forward from Phase 3, unchanged today:**
  the ingestion service is genuinely built to run inside a real Phala TDX
  CVM (identical Dockerfile/compose pattern to the oracle's already-proven
  real deployment) — but actually provisioning a *live* Phala CVM instance
  needs the same manual dashboard/credential steps every other Phala
  deployment in this repo needs, outside this session's reach. Today's
  Arc-testnet verification below ran the ingestor locally
  (`USE_REAL_PHALA=false`, prototype-attestation path) against the real
  chain — the on-chain contracts, the wallet registration, the fund
  movement, and the claims are all real; the enclave hardware attestation
  itself is not yet live. Same honest distinction the price-oracle
  vertical's own `DEV_MODE`/`USE_REAL_PHALA` split already documents
  elsewhere in this file.

**Live-verified on Arc testnet, real transactions, real USDC:**

| | |
|---|---|
| `ArtistRegistry` | `0x6D4A2C82b3aEb6eFFca6dffd8cfA2008601359CA` |
| `TrainingPool` | `0x2d187b0209881b9dfd2ef1448aa55Cd82326fa50` |
| `CompensationClaim` | `0x33Df2A7b8642cbC68455231dB9833f5Aa1d3BFa5` |
| Ingestor wallet (dedicated, TEE-registered) | `0x0F83457C92609De36C99Db323a306C755B333B33` — agentId `0xf3427c5202b18f7b091380c7975a2fffa649e6e053cc49d3523bde02a45f8b0a`, `registerAgent()` tx [`0x2c45c84e...`](https://testnet.arcscan.app/tx/0x2c45c84e89d1aeca190dafb277b830208347ca284a977c9f03c7cfcf83b15cf9) |
| Pool #1 | 3 USDC, corpus of 3 demo tracks (2 owned by one artist, 1 by another), created by a freshly funded demo company wallet |
| Allocation submission | `submitAllocation()` tx [`0xb7d306bc...`](https://testnet.arcscan.app/tx/0xb7d306bc012dae9ddf6c90ae2010550376fee152d0dd66c678798f0592c4b9a5) — real ingestion enclave HTTP call preceded this, real corpus/licensing checks passed, real 2.00/1.00 USDC equal-split allocation computed |
| Claim — artist A (2 tracks) | `claim()` tx [`0x0206f880...`](https://testnet.arcscan.app/tx/0x0206f880dba17136c5c70023f2a17df856fff80ca4c08da9fd14eadb500d570b) — `Claimed` event confirms exactly 2.000000 USDC |
| Claim — artist B (1 track) | `claim()` tx [`0x5bc4629f...`](https://testnet.arcscan.app/tx/0x5bc4629f8129fffcd65a41c5a97a4f6635406fc7f7b0e4fcf74c287e4cfdf2ef) — `Claimed` event **and** the transaction's own internal ERC-20 `Transfer` log independently confirm exactly 1.000000 USDC moved |

**An anomaly investigated, not glossed over:** both freshly-generated demo
artist wallets showed a few thousandths of a USDC more than their exact
claim amount when checked *after* the fact (e.g. artist B read back as
1.006719 USDC, not the exact 1.000000 claimed). Traced directly rather
than assumed benign: pulled the claim transaction's own receipt and
decoded its internal `Transfer` log independently of any event-log range
query — it shows exactly 1.000000 USDC moved by that transaction, and a
`balanceOf` check at the block *immediately before* the claim already
showed a nonzero balance on that "freshly generated" address. Conclusion:
small pre-existing/unrelated dust on a newly-active address on a shared
public testnet, present *before* this vertical's claim transaction ran,
not caused by `CompensationClaim.sol` or `TrainingPool.sol` — the
contracts' own transaction receipts are the authoritative record and they
show the exact intended amounts. Noted here rather than silently
rounding it away.

**What NOT touched, confirmed:** `ArcIDBond.sol`, `ExploitBounty.sol`,
`DCAPVerifier.sol`, `ArcIDRegistryV2.sol`, `ConsumerSessionKeyGuard.sol`,
every existing interface, every existing test file, `oracle/`, `consumer/`,
`bounty/`, and every existing frontend component — no frontend card was
built for this vertical this session (optional per the original Phase 0
scope, same "CLI is the confirmed fallback demo path" precedent Proof-of-
Exploit already established). `npm test` was run after every phase and
stayed green throughout — 270 passing at completion, up from 209 at the
start of this entry, zero regressions in the pre-existing 209. Neither
other vertical's live demo path, deployed contracts, or Phala CVM were
touched or redeployed.
