# s402 Reanalysis — 2026-07 (DAN-591)

**Date:** 2026-07-19 · **Branch:** `agent/dan-591` · **Base:** `930787b` · **Reviewer:** night-shift agent (Curry)
**Scope:** foundational-bug sweep of s402 proper → x402/MPP evolution scan → primitive re-validation → up-stack propagation notes.

---

## Verdict (what / why / proof / risk / ask)

- **What:** s402 *proper* (the pure-protocol repo) holds up. No new funds-at-risk bug found; the 8 prior audit findings are all fixed and the adversarial/fuzz/MC-DC suite is comprehensive (1,098 tests green). The real exposure is **strategic and interop-drift, not a broken primitive**.
- **Why it matters:** x402 evolved from *exact-only* (the premise still hard-coded into our compat layer) into a **4-scheme family** (exact · upto · auth-capture · batch-settlement) deployed on ~11 EVM chains. Two schemes we positioned as differentiated — `upto` and (via auth-capture) `escrow` — now have upstream analogues; a third idea (`split`) is pre-empted by x402 `batch-settlement`. Our durable moat narrows to **PTB-atomic pay-and-deliver + prepaid signed-receipts + unlock**.
- **Proof:** repro in `EVIDENCE.md` (F1 coercion demonstrated); file:line cites throughout; drift matrix sourced to upstream commits/APIs fetched 2026-07-19; x402 HEAD `67b1ba0a` and mpp-specs HEAD `55045e5e` both confirmed unchanged since the 2026-07-18 brief.
- **Risk if ignored:** (a) our x402 compat silently relabels non-exact x402 payments as `exact` — fail-safe today on Sui, latent correctness debt as multi-scheme x402 traffic grows; (b) ADR-007's confused-deputy and unlock-attestation MUST-checks are documented as enforced but are **not wired** at either the protocol layer or the sweefi unlock client; (c) positioning docs that still say "x402 = exact-only / can't do multi-scheme" are now false and will fail due diligence.
- **Ask (Danny):** approve the 3 follow-up tickets in the up-stack table (compat multi-scheme handling; ADR-007 check-5/8 wiring; positioning refresh). One-line drift-script patch proposed below (in *sweeos*, so human-applied). No push/publish done.

---

## 1. Foundational-bug inventory (ranked)

Severity key: **FUNDS** = funds-at-risk · **CORRECTNESS** = wrong-but-fail-safe / latent · **CONTRACT** = doc-vs-code or spec-vs-wire gap · **HARDENING** = defense-in-depth.
No **FUNDS** findings in s402 proper. Every claim is traced or reproduced.

### F1 — x402 compat coerces *every* scheme to `exact` (CORRECTNESS, drift-induced)

- **Where:** `typescript/src/compat/x402.ts:118` (`fromX402Requirements` returns `accepts: ['exact']` unconditionally) and `:147` (`fromX402Payload` returns `scheme: 'exact'` unconditionally). `validateX402Shape` (`:585`) only asserts `scheme` is a string — never that it is `exact`. The premise is *enshrined* by `test/security-hardening.test.ts` → "normalizes non-exact scheme to exact (x402 only supports exact)".
- **Failure scenario:** an x402 client advertising `scheme: "auth-capture"` or `"batch-settlement"` (both **shipped upstream** since our layer was cut) is normalized into an s402 `exact` requirement/payload. The scheme identity is lost before dispatch. Today this fails safe — a Sui `exact` facilitator rejects an EVM authorization blob at verify — but it is a silent mis-label, not an explicit "unsupported scheme" rejection, and it will produce confusing failures (or wrong-scheme settlement attempts) as non-exact x402 adoption grows.
- **Proof:** reproduced — see `EVIDENCE.md` §F1 (`accepts` = `["exact"]` for input scheme `auth-capture`; `payload.scheme` = `"exact"` for input `batch-settlement`).
- **Severity:** CORRECTNESS (fail-safe today; latent interop debt). Not funds-at-risk.
- **Fix direction:** make the coercion explicit and honest — accept `exact` (the only scheme with a Sui-atomic equivalent), and for any other x402 scheme **reject with `SCHEME_NOT_SUPPORTED`** rather than silently relabel. Optionally map `x402:auth-capture` → s402 `escrow` and `x402:upto` → s402 `upto` behind an explicit, tested mapping table. Do NOT expand silently.

### F2 — ADR-007's "eight MUST checks" are advertised but only six are wired (CONTRACT / confused-deputy)

- **Where:** `typescript/src/envelope.ts:12-15` (file header: "The eight client-side MUST checks from ADR-007 … live in `verifyEnvelope()` below — they are non-negotiable"). The function (`:372-435`) implements **six**: scheme-match, spec-digest, network, algorithm-acceptance, timestamp-skew, txBinding. Checks **5 (resource binding / confused-deputy)** and **8 (unlock-TX2 attestation)** are silently delegated ("Resource-binding and unlock-attestation checks live in higher layers", `:372` comment).
- **Deeper structural gap:** ADR-007 check 5 (`docs/adr/007-settlement-response-envelope.md:141`) compares `requirements.resource` — **but the s402 wire format has no `resource` field** (`docs/specification.md` §4.1/4.2; `src/types.ts`). So the confused-deputy defense (facilitator-for-resource-A settles for resource-B; flagged EXPLOITABLE in the ADR's own Wave-3 review, alt A2) is **un-implementable at the protocol layer as specified** — it has no field to bind against.
- **Propagation (up-stack):** the sweefi unlock client `verticals/sweefi/sui/src/s402/unlock/client.ts:93-100` `verifySettlement()` only calls `verifySuiSettlement` (S8 / TX1 binding) and explicitly comments "TX2 is facilitator-constructed and needs a separate attestation mechanism" — i.e. ADR-007 check 8 (refuse to surface decrypted content before the attestation verifies) is **also unenforced at the SDK layer**. Neither layer performs it.
- **Failure scenario:** requires a malicious/compromised facilitator (attacker model A2). A client relying on `verifyEnvelope` alone believes all 8 obligations ran; the two that defend against confused-deputy and unlock-attestation-stripping did not.
- **Proof:** citations above; no field to bind (traced). Client-side check only, so no repro tx.
- **Severity:** CONTRACT → advisory-to-medium. Bounded by "malicious facilitator" + "client trusts `verifyEnvelope` as complete." Unlock is a beta scheme, but attestation integrity is the exact confidentiality guarantee it sells.
- **Fix direction:** (a) correct the header comment to say six checks are enforced here and name the two that MUST be enforced by the caller; (b) add a `resource` field to the requirements wire format (or an explicit intent-binding field) so check 5 is wireable, OR downgrade check 5 in ADR-007 from "MUST at protocol layer" to "MUST at the SDK layer with tracked-intent"; (c) implement the S11 unlock attestation verify in the sweefi unlock client before it returns decrypted content.

### F3 — dedup fingerprint uses `JSON.stringify`, not RFC-8785 canonical form (HARDENING)

- **Where:** `typescript/src/facilitator.ts:316` — `const dedupeKey = options?.idempotencyKey ?? JSON.stringify(payload);`. ADR-007's idempotency section (`docs/adr/007-...:264`) says the facilitator "MUST compute a deterministic fingerprint of the decoded payment payload (the object produced after **canonical field ordering per `spec/canonicalization.md` §4**)."
- **Assessment:** for the blessed path (`gate` → `server.process`, payload arriving from `decodePaymentPayload` → `pickPayloadFields`) key order is stable, so dedup is reliable — the in-code comment is correct *for that path*. The gap is a **direct** `process()` caller passing a hand-built payload with different key order: `JSON.stringify` yields a different string → dedup miss → a retry can re-execute settle. Intra-facilitator cache only (never compared cross-instance), so it is hardening, not a live double-spend on the recommended path.
- **Severity:** HARDENING / low.
- **Fix direction:** key the cache on `canonicalizeToString(payload)` (already imported elsewhere) so the fingerprint is order-independent regardless of how the caller built the object — matches the ADR's own normative text.

### Non-bug observations (recorded so they are not silently relied upon)

- **Envelope is unsigned by design.** `verifyEnvelope` performs no signature check; `algs.sig` is a reserved label. This is ADR-007 decision **A3** (JWS deferred to SweeFi) — authenticity rests on **TLS + on-chain verification of the settlement blob**; `txBinding` is *integrity* (this response answers my request), not *authenticity* (this response came from the facilitator). Correct as designed; flagged because a reader of `verifyEnvelope` may over-trust it.
- **Interop-adoption TODOs from the 2026-07-18 brief remain open** (not bugs): MCP challenge code `McpError(-32042)` is not emitted/accepted in the MCP carrier (`src/transport.ts:193-195`); ALL-CAPS `PAYMENT-SIGNATURE` inbound tidy is "deliberately deferred" (`:131`). Track under the 0.9.0 compat pass.

---

## 2. x402 / MPP drift matrix (delta vs 2026-07-18 intel brief)

All rows fetched 2026-07-19. "Δ" = change vs the brief. Brief = `~/sweeos/core/projects/s402-project/knowledge/upstream-drift/2026-07-18-intel-brief.md`.

### x402

| Area | State (2026-07-19) | Δ vs brief | Source (fetched 2026-07-19) |
|---|---|---|---|
| main HEAD | `67b1ba0a` (2026-07-17), 0 commits in last 2 days | CONFIRMED, no move | api.github.com/repos/x402-foundation/x402/commits/main |
| npm `@x402/*` | v2.19.0 (2026-07-17), ~weekly cadence | CONFIRMED | registry.npmjs.org/@x402/core |
| Scheme count | **4**: exact, upto, auth-capture, batch-settlement. No stream/escrow/subscription scheme upstream. | CONFIRMED (matches our stress-test "4-scheme" fix) | GitHub trees `specs/schemes/` |
| batch-settlement | Spec + **TS + Python + Go**; contract at CREATE2 `0x4020…0003`; deployed Base/Arbitrum/Polygon/World/Optimism/Avalanche/Celo/**Linea/Unichain/Monad** (~11) | **Δ** brief said Python-only + 6 chains → Go impl too, ~11 chains | raw contracts/evm/README.md |
| Cloudflare | **Own upstream scheme** `scheme_batch_settlement_cloudflare.md` (`cloudflare:402`, deferred batch, Cloudflare as Merchant-of-Record, RFC-9421 sigs). Monetization Gateway **waitlist-only** (2026-07-01). | **Δ** brief lacked the scheme spec + MoR detail | blog.cloudflare.com/monetization-gateway; raw scheme file |
| AWS | x402 "Monetize" **GA** in CloudFront + WAF Bot Control (USDC on Base + Solana, Coinbase facilitator) | **Δ NEW** — AWS beat Cloudflare to GA | infoq.com/news/2026/07/cloudflare-aws-x402-micropayment |
| Sui | Spec-only in merged code (`scheme_exact_sui.md`, orig. bmwill/Mysten). **Active 37-file community PR #2616** ("@x402/sui gasless", author *Sceat*, non-Mysten, updated 2026-07-19) + #2615 spec + #2619 facilitator. | **Δ HOT** — impl PR in flight *today*, not Mysten-authored → the bridge-author window is contested | github.com/x402-foundation/x402/pull/2616 |
| Chains w/ merged TS mechanism | 11 (aptos, avm, concordium, evm, hedera, keeta, near, stellar, svm, tvm, xrpl) | expands brief's "land-rush" | trees `typescript/packages/mechanisms/` |
| Extensions | **9** (bazaar, builder_code, http-message-signatures, payment_identifier, sign-in-with-x, eip2612/erc20 gas-sponsoring, offer-and-receipt, auth-hints) | **Δ** brief listed 5 → 4 more (all predate brief) | trees `specs/extensions/` |
| A2A transport | Spec-only, **zero impl code** | CONFIRMED — s402's A2A carrier remains the only shipped impl | trees grep `a2a` |
| Governance | LF **operational launch of x402 Foundation 2026-07-14**; 40 orgs (AWS, Visa, Mastercard, Stripe, Circle, Shopify…); ~75M payments / ~$24M cumulative | context | linuxfoundation.org press 2026-07-14 |

### MPP

| Area | State (2026-07-19) | Δ vs brief | Source |
|---|---|---|---|
| Name | **Machine** Payments Protocol (not Merchant/Micro) | correction | stripe.com/blog/machine-payments-protocol |
| main HEAD | `55045e5e` (2026-07-17), nothing merged since | CONFIRMED unchanged | api.github.com/repos/tempoxyz/mpp-specs/commits/main |
| Intent registry | Only `charge` specified; registry "initially empty" (Spec-Required). `authorize`/`subscription` unspecified; `session` appears only in examples. **PR #280 "generic session intent" OPEN** since 2026-06-10. | CONFIRMED + watch #280 | raw draft-httpauth-payment-00.md; PR #280 |
| Session timeline | Solana #201 (6/30), unified EVM #225 (7/3), Tempo v2 #278 (**6/25**, not July), Solana cost-cut **#296** (7/17). Lightning session existed since Jan-05 init. | **Δ correction** — brief mis-dated Tempo v2 + cited wrong PR (#221 is unrelated) + Lightning not new | GitHub PRs |
| Wire deltas | externalId #266 (6/08), `hash` cred #261 (5/18), non-empty challenge id #285 (6/19), Stripe Connect #265 (5/20) | CONFIRMED | GitHub PRs |
| Methods registry | **Repo (10):** card, evm, hedera, lightning, nearintents, solana, stellar, stripe, tempo, usdc. **mpp.dev (10, different):** adds Monad, RedotPay, claims **Tempo subscription** + **Stellar session** with no specs. | **Δ site/repo drift** — impl running ahead of spec; "Tempo subscription supported" while intent unspecified is the sharpest contradiction | api contents `specs/methods`; mpp.dev/methods |
| `usdc` method | Chain-agnostic (EVM+Solana+Stacks, cross-chain via Circle Gateway) | CONFIRMED | raw draft-usdc-charge-00.md |
| Sui/Move | No Sui/Move/Aptos method. **PR #195 "Add Sui payment method" opened 2026-03-19, closed unmerged 2026-04-06** by maintainer, no reason. | **Δ** niche open but maintainers declined first outside attempt | github.com/tempoxyz/mpp-specs/pull/195 |
| IETF | draft-ryan-httpauth-payment-**01** (2026-03-18, exp 2026-09-19), individual I-D, no new rev | CONFIRMED | datatracker.ietf.org |

**Net drift read:** neither upstream HEAD moved since the 2026-07-18 brief, so our mechanical tripwire baselines are still valid-as-of-then; the *interpretation* moved (batch-settlement breadth, Cloudflare's own scheme, AWS GA, the live Sui PR). Our compat layer's stale assumption is **schemes, not commits** — see F1.

---

## 3. Per-scheme verdict (discriminator = PTB-atomic pay-and-deliver in one transaction)

| Scheme | Status | Upstream analogue now? | Verdict | Rationale |
|---|---|---|---|---|
| **exact** | stable | x402 `exact` (all chains) | **KEEP** | The interop floor. Convergence, not uniqueness — position as "wire-compatible," never "unique." |
| **upto** | stable | **x402 `upto`** (partial settlement) + `auth-capture` | **ADJUST** | Uniqueness claim is gone. Keep the scheme; re-position on the PTB-atomic deposit-and-meter property (x402's is EVM-authorization, 2-step). Drop "only s402 does variable settlement." |
| **prepaid** | stable | none direct (MPP `session` voucher is adjacent) | **KEEP** | Signed-receipt metering still differentiated. Watch MPP `session` (PR #280) — if it lands as a generic cumulative-voucher intent, the gap narrows. |
| **stream** | stable | none merged (only a TVM streaming helper; SVM subscriptions PR #2717 unmerged) | **KEEP** | Still differentiated; value is the PTB-atomic rate-limited draw. Low upstream threat this cycle. |
| **escrow** | stable | **x402 `auth-capture`** (hold-then-capture) is the encroachment | **KEEP + counter-position** | auth-capture is authorize-now/capture-later but 2-step and EVM-auth-based. Position escrow as the PTB-atomic superset with arbiter/dispute. This is the sharpest contested boundary. |
| **unlock** | beta | none (no x402/MPP analogue) | **KEEP — strongest moat** | Pay-to-decrypt (Walrus/Seal) is genuinely unique. But fix the F2 attestation gap before amplifying it — the moat is only real if the attestation-stripping defense actually runs. |
| **split** | roadmap (not in code) | **x402 `batch-settlement`** (one settlement, many recipients) | **RECONSIDER / RETIRE-as-unique** | The fan-out idea is pre-empted upstream by batch-settlement across ~11 chains. Either interop with batch-settlement or justify a PTB-atomic split that batch-settlement can't do — don't ship "split" as a novel primitive. |

**Spec hygiene note:** `docs/specification.md` still lists 6 schemes (no `split`), while `README`/positioning discuss beta `split`. `VALID_SCHEMES` in `src/http.ts:320` = exact/upto/prepaid/stream/escrow/unlock. Keep the count reconciled (this was the 7f3910f/930787b stress-test theme — carry it through to any split decision).

---

## 4. Up-stack propagation (READ-ONLY notes on `~/swee/sweeai` — follow-ups, not changes made)

| # | Ticket | Where (sweeai) | What | Priority |
|---|---|---|---|---|
| 1 | x402 multi-scheme compat | `protocols/s402/typescript/src/compat/x402.ts` + any `@sweefi/*` caller of `fromX402*`/`normalizeRequirements` | Replace silent `→exact` coercion with explicit accept-`exact` / reject-others (+ optional tested auth-capture→escrow, upto→upto map). Update the enshrining test. | High (correctness + DD) |
| 2 | ADR-007 check 5 & 8 wiring | `verticals/sweefi/sui/src/s402/unlock/client.ts:93-100` (attestation) + SDK envelope path (resource/intent binding) | Implement S11 unlock-TX2 attestation verify before returning plaintext; decide resource-binding home (wire field vs SDK-tracked intent) and wire it. Correct the `envelope.ts` header claim. | High (unlock is the moat) |
| 3 | Positioning refresh | `protocols/s402/docs/positioning.md`, `comparison.md` | x402 is now a 4-scheme, ~11-chain, LF-governed standard with AWS GA + Cloudflare MoR. Retire any "x402 = exact-only / can't multi-scheme" framing; lead with PTB-atomic + prepaid-receipts + unlock. | Med (already partly done in 930787b — finish it) |
| 4 | dedup canonicalization | `protocols/s402/typescript/src/facilitator.ts:316` | Key dedup on `canonicalizeToString(payload)` per ADR-007 §idempotency. | Low (hardening) |
| 5 | Sui-bridge decision | strategy, not code | x402 Sui impl PR #2616 is live *today* (non-Mysten). If the "x402↔Sui bridge author" play matters for the Mysten lane, the window is closing — human/strategic call, external PR = hard gate. | Time-sensitive (surfaced, not actioned) |

---

## 5. Drift-script status (`bin/check-x402-mpp-drift.sh`)

**Location reality:** the script lives at `~/sweeos/bin/check-x402-mpp-drift.sh` — in the **cathedral repo, not the s402 repo**. It resolves its root from its own path and needs `core/external/{x402,mpp-specs}` + `core/projects/.../upstream-drift/`, none of which exist in this worktree. Per the mission's Tier-1 limit ("never touch any other repo") and Curry doctrine ("never fork state"), I **did not** copy it into the s402 worktree (that would fork it) and **did not** run it (it `git fetch`es the external forks and writes a dated report — both mutate sweeos). Verifying it must be done by Danny in sweeos.

**Reviewed assumptions vs today's scan — one genuinely stale:**

- ✅ `remote=foundation` for x402 — correct (development is on `x402-foundation/x402`).
- ✅ `specs` glob — still catches `specs/schemes/`, `specs/extensions/`, `specs/intents/`.
- ⚠️ **x402 api-surface glob `typescript/packages/mechanisms/src` is stale.** Upstream mechanisms are per-chain packages (`typescript/packages/mechanisms/evm/src/auth-capture/…`), so a prefix match on `…/mechanisms/src` **misses every chain mechanism** — including the auth-capture / batch-settlement code that is the actual scheme drift. Proposed one-line fix (apply in sweeos):

  ```
  # ~/sweeos/bin/check-x402-mpp-drift.sh, REPOS[] line 62:
  - "x402|x402|typescript/packages/core/src/types;typescript/packages/core/src/server;typescript/packages/mcp/src;typescript/packages/mechanisms/src;specs|foundation"
  + "x402|x402|typescript/packages/core/src/types;typescript/packages/core/src/server;typescript/packages/mcp/src;typescript/packages/mechanisms;specs|foundation"
  ```

- Note: mpp `pages/methods;pages/extensions` globs never match (the mpp-specs repo keeps everything under `specs/`); harmless but could be tidied to `specs`.
- **Baselines intentionally NOT `--accept`ed** — the tripwire stays red until the 0.9.0 compat audit (this reanalysis is that audit's front half). Do not advance `.last-known` until F1 + up-stack #1 land.

---

*Prepared autonomously for morning review. No push / PR / publish / external comms performed. Web reads only.*
