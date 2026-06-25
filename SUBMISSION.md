# ArcID v2 — Lepton Hackathon Submission Package

> This document is the complete submission kit: video script (beat-by-beat),
> form answers, traction snapshot, and judge Q&A prep.
> Record the video, fill in the live numbers, then submit.

---

## Video Script — 3 minutes, 7 beats

Record on Loom, YouTube, or Vimeo. Use screen + terminal. No slides — show the running system.

---

### Beat 1 — One-liner (0:00–0:15, 15 seconds)

**Screen:** ArcID dashboard at http://localhost:5174

> "Agents post a bond to register with ArcID. A consumer agent reasons about whether
> they delivered — and if not, the bond slashes automatically. Reputation is capital
> at risk, not a number you ask to be trusted."

Point at the traction strip: total calls, volume, slash events.

---

### Beat 2 — The moat: TEE-gating (0:15–0:40, 25 seconds)

**Screen:** Terminal — run the gating proof

```bash
npm run gating:local
```

> "To post a bond, your wallet must be TEE-attested in ArcIDRegistry. Here's what
> happens when an unverified wallet tries."

Show the revert: `"Agent not TEE-verified in ArcID registry"`

> "That string appears verbatim on-chain. A wrong answer here is
> cryptographically attributable to a real, verified agent —
> that's what makes the slash fair. This is the property AOZ doesn't have:
> identity *before* stake, not stake *as* identity."

---

### Beat 3 — The agency beat: LLM adjudication (0:40–1:15, 35 seconds)

**Screen:** Consumer terminal — two cycles side by side

First, run a healthy cycle (terminal output):
```bash
cd consumer && npm start
```

> "Consumer agent calls the oracle, pays $0.001 via x402, verifies the signature.
> Everything checks out — Claude says: OK. No slash. The adjudicator is restrained."

Show the `✓ OK` verdict and the written rationale on screen.

Then trigger stale fault (dashboard Trigger Fault → "stale"):

> "Now I inject a stale fault — the oracle signs data that's 90 seconds old,
> deliberately past the 30-second SLA. Claude sees: timestamp fresh=false,
> sig valid=true, value present=true — and it *explains* why this is a breach,
> not a blip."

Show the `✗ BREACH` verdict and the LLM rationale text. The rationale should say something like:
> *"Oracle is provably live yet served data 90s past the declared SLA. Signature is
> valid and attributable — this is deliberate or negligent, not a transport failure."*

> "This isn't a cron job. It reasons about the *type* of failure. That written rationale
> goes on-chain in the AgentSlashed event."

---

### Beat 4 — Traction (1:15–1:50, 35 seconds)

**Screen:** Dashboard traction strip + Stats panel

> "This is the live network strip. [X] bonded agents — including [name two outside
> participants]. [Y] oracle calls paid via x402 nanopayments. $[Z] USDC volume.
> [N] slash events with on-chain LLM rationale."

Scroll down to the verdict feed to show real verdict history.

> "Every verdict is logged — cycle count, payment amount, LLM reasoning, slash result.
> This is real activity on Arc testnet, not a scripted demo."

---

### Beat 5 — Circle differentiator: USYC (1:50–2:10, 20 seconds)

**Screen:** Dashboard — USYCBondCard section

> "The Circle-specific moat: yield-bearing bond collateral. Instead of idle USDC,
> agents post USYC — Hashnote's tokenized T-bill fund on Arc."

Point at the USYCBondCard: yield badge, ~4.9% APY, Teller address.

> "The bond earns T-bill returns while it sits at stake. On a confirmed breach,
> the consumer receives USYC worth *more* than face value at slash time.
> Capital at risk that isn't idle capital."

If allowlisted: show the USYC bond contract address on Arc testnet.
If pending: > "Contract deployed, awaiting Circle allowlist. Judges can inspect
the code — same ArcIDBond.sol, different constructor arg."

Run the yield demo:
```bash
npm run deploy:usyc:local
# → Bond face value: $5.00 USDC
# → After 490 bps yield: $5.245 USDC (+$0.245 earned while staked)
```

---

### Beat 6 — Live slash on-chain (2:10–2:30, 20 seconds)

**Screen:** Dashboard — AgentCard → "Trigger Fault" → "stale"

> "One click — fault injected. Consumer agent detects it in the next cycle."

Wait ~12s for consumer to detect. Show terminal: `✗ BREACH → Slashing oracle...`

> "Slash fires. Bond transfers to the consumer wallet. Badge flips."

If DEV_MODE=false: show the tx hash on Arc testnet explorer.
If DEV_MODE=true: > "[Dev mode — on testnet this executes a real on-chain transfer.]"

---

### Beat 7 — Close (2:30–2:40, 10 seconds)

**Screen:** Dashboard full view

> "This is RFB 3 — agent-to-agent nanopayment networks — with the trust layer
> that Prior Art #8 called 'nearly empty.' TEE-gated identity, USYC yield collateral,
> live x402 nanopayments. And it's already running on Arc testnet."

Fade out or cut.

---

## Submission Form Answers

**Form:** https://forms.gle/SMqLaw2pMGDe58LFA

---

### Project Name
ArcID v2 — Bonded Agent Reputation for Nanopayment Networks

### One-line description
Agents post yield-bearing bonds to register with ArcID; a Claude-powered consumer agent reasons whether the provider delivered and slashes the bond on confirmed breach — making reputation capital at risk, not a score.

### GitHub repo
https://github.com/[YOUR_USERNAME]/arcid2
_(make repo public before submitting)_

### Demo video
[Loom / YouTube / Vimeo URL — fill in after recording]

### Live demo
http://localhost:5174  _(or Vercel URL if deployed)_

### Deployed contract addresses (Arc testnet)
| Contract | Address |
|----------|---------|
| ArcIDBond (USDC) | [from deployments/arcTestnet.json after `npm run deploy:arc`] |
| ArcIDBond (USYC) | [from deployments/arcTestnet_usyc.json after `npm run deploy:usyc:arc`] |
| Collateral (USDC) | `0x3600000000000000000000000000000000000000` |
| USYC token | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| USYC Teller | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` |
| ArcIDRegistry (existing) | [from Arc docs / Phase 0] |

---

### Circle tools used
- **x402 nanopayments:** Oracle service uses `x402-express` middleware. Every oracle call costs $0.001 USDC paid via Circle's Gateway. Consumer agent pays automatically, no human approval required.
- **USYC yield-bearing collateral:** ArcIDBond deployed with USYC as collateral token. Agents mint USYC via the Hashnote Teller on Arc testnet (`0x9fdF14c5B14173D74C08Af27AebFf39240dC105A`). Bond earns ~4.9% T-bill APY while staked.
- **Arc testnet:** All contracts deployed on Arc (chain ID 421614). Uses ArcIDRegistry for TEE-gated identity.

---

### How does this map to Lepton's RFBs / Prior Art?
- **RFB 3 (Agent-to-Agent Nanopayment Networks):** Oracle agent sells a signed data service; consumer agent pays per call via x402. Real USDC flow between two autonomous agents.
- **Prior Art #8 (ArcID — bonded agent reputation):** Prior Art #8 notes the trust layer is "nearly empty." This closes that gap: bonded identity with on-chain slash evidence, powered by LLM-reasoned adjudication.

---

### Traction (fill in real numbers before submitting)

```
Bonded agents on Arc testnet:    [N]  (including [X] outside participants)
Total oracle calls (x402):       [Y]
USDC volume paid:                $[Z]
Slash events with LLM rationale: [N]
Test suite:                       40 passing (Hardhat, no external RPC)
```

**Outside participants recruited:** [Name / wallet / date — important: real non-self volume is the cut line for the 30% traction score]

---

### Agentic sophistication evidence
- Consumer agent makes LLM-reasoned decisions via Claude claude-sonnet-4-6 using `tool_use` with forced structured output (`tool_choice: {type:"tool", name:"deliver_verdict"}`)
- Three fault modes give Claude distinct reasoning paths: stale (provider live but lying), null (ambiguous failure — adjudicator correctly restrains), bad-sig (attributable signing failure)
- Written rationale logged on-chain in `AgentSlashed` event — not just a boolean
- Adjudicator restraint on `null` fault (verdict=uncertain, no slash) demonstrates agency, not automation

---

### Why not AOZ?
AOZ ships oath-based stake → slash, which overlaps on the "bond + slash" mechanic. The moat here is what AOZ doesn't have:
1. **TEE-gated identity before the bond** — only DCAP-attested wallets can post. Unverified wallets revert on-chain with a human-readable error.
2. **USYC yield-bearing collateral** — capital at risk that earns T-bill yield while staked. AOZ uses plain staking tokens.
3. **LLM-reasoned adjudication** — the consumer agent explains its verdict in natural language; the rationale is logged on-chain.

---

## Traction Snapshot Template

Fill this out the night before submitting. Use real numbers — small real beats large fake.

```
Date:                        [YYYY-MM-DD]
Bonded agents:               [N]  (self: oracle + consumer; outside: [list names])
Total x402 calls:            [Y]
Total USDC paid:             $[Z.ZZZZ]
Breach verdicts:             [N]  (stale: [a], null: [b], bad-sig: [c])
Uncertain (no slash):        [N]  (demonstrates adjudicator restraint)
Slash events:                [N]  (on-chain LLM rationale: [tx hashes])
Test suite:                  40 passing / 0 failing
Consumer cycles logged:      [N] JSONL lines in consumer/logs/
```

---

## Judge Q&A Prep

**"Why not just use a multisig or a simple oracle slash?"**
> A multisig requires human intervention. ArcID's consumer is an autonomous agent that purchases, verifies, and adjudicates in a single loop — no human in the loop after deployment. The LLM provides a written rationale that goes on-chain, which a multisig cannot do.

**"How is TEE-gating different from a regular allowlist?"**
> An allowlist is controlled by whoever deploys it. ArcIDRegistry's gating is backed by DCAP attestation quotes — hardware-level proof that the agent runs in a trusted execution environment. You can't fake your way in by knowing the deployer.

**"What happens if Claude is wrong?"**
> The system is conservative by design: uncertain verdict = no slash. For the `null` fault (oracle crash or blip), Claude correctly returns uncertain rather than slashing, because it can't distinguish malice from a transient failure. That restraint is the design.

**"Is the USYC integration real?"**
> The contract is deployed on Arc testnet. The yield simulation test suite (13 tests, `npm test`) demonstrates the math precisely — 5 USYC bonded at $1.00, worth $5.025 after 50bps yield. Minting via Teller requires Circle allowlist; the deploy script handles the allowlist-absent case gracefully (still deploys, prints address for judges to inspect).

**"What's the path to production?"**
> Three things: (1) consumer agent becomes a shared service any provider can register against, (2) multi-slasher dispute window replaces the single authorized slasher, (3) USYC bond + Teller integration becomes the default over idle USDC. Circle grant application follows immediately post-hackathon.

---

## Pre-submission Checklist

- [ ] `npm test` — 40 passing
- [ ] Oracle starts: `cd oracle && npm start` → port 3001
- [ ] Consumer runs: `cd consumer && npm start` → healthy cycles visible
- [ ] Dashboard loads: `cd frontend && npm run dev` → http://localhost:5174
- [ ] Fault injection works: Dashboard → "stale" → consumer detects breach within ~12s
- [ ] GitHub repo is public
- [ ] Video recorded and uploaded
- [ ] Form submitted at https://forms.gle/SMqLaw2pMGDe58LFA
- [ ] Traction numbers filled in (real ones)
- [ ] Deployed contract addresses filled in
- [ ] USYC bond deployed (or "deployed, allowlist pending" with address)
- [ ] Outside participants noted in traction section
