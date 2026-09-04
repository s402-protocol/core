# ADR-016: s402's 402 is an x402 V2 envelope — a profile of x402, not a second dialect on its header

**Status:** Accepted (Danny, 2026-09-04: *"yes on the envelope change"*)
**Implementation:** not-started
**Force:** invariant — checked by `test/interop-x402-client.test.ts` run **without** any x402 option, and by the `requirements-encode` / `requirements-decode` vectors once rewritten
**Date:** 2026-09-04
**Supersedes:** ADR-015 rule 3 and its `x402` gate option (ADR-015 rules 1 and 2 — unconditional intake, dialect-echo receipt — stand). Retires ADR-015 Alternative A's rejection.
**Related:** ADR-005 (Interop Superset Principle), ADR-007 / ADR-014 (settlement envelope), ADR-013 (intake obligation), ADR-006 (version negotiation), DAN-1075
**Verified against:** x402 `x402-foundation/x402` @ `2cc7e9a6` (2026-09-04), `@x402/core` 2.25.0 — `PaymentRequired` / `PaymentRequirements` in `typescript/packages/core/src/types/payments.ts`

---

## Context

ADR-015 made the interop claim true with one server option. The Phase 2 audit of DAN-1075
(`core/projects/s402-project/knowledge/architecture-audit-2026-09.md`) found that the option was
protecting a design premise that no longer holds.

**The premise.** ADR-005 (April 2026) said x402's governance was "structurally limited to exact +
upto," so s402's four further schemes were a superset x402 could not absorb, and a rival wire
format was the price of carrying them. **At the pin, x402 ships four schemes:** `exact`, `upto`,
`auth-capture` (landed 2026-05-20; `escrow` payment flow; hold, capture, void, refund, reclaim) and
`batch-settlement`. Three of s402's four superset schemes now have an upstream lifecycle analogue.
Only `unlock` does not.

**The shape.** s402's native 402 is one flat requirement (`network`, `asset`, `amount`, `payTo`,
…) plus `accepts: string[]`, a list of scheme *names*. x402's is `accepts: PaymentRequirements[]`,
a list of full requirement *objects*, each with its own network, asset, amount and an `extra` bag,
under an envelope with `resource` and `extensions`. The x402 shape is strictly more expressive:
one 402 can offer `exact` on one network and `prepaid` on another, which the flat shape cannot
say. The `accepts` collision ADR-015 named is therefore not a naming clash to be resolved by a
rename; it is the less expressive shape colliding with the more expressive one on a header the
more expressive one owns.

**The installed base.** `s402` on npm: 194 downloads in the month to 2026-08-29. No independent
implementation has claimed the vectors. A wire-format break is as cheap today as it will ever be.

**What s402 is, after this.** The audit's one-sentence answer, which Danny accepted: *s402 is where
Sui meets x402, and where the rules about what an agent may pay live.* A profile of x402 — the
Sui binding, the policy layer (`mandate`, extensions), `unlock`, and the conformance vectors — not
a rival protocol. Whether `VISION.md` is rewritten to say so is a separate decision and is not
made here.

## Decision

**s402's `payment-required` header carries an x402 V2 `PaymentRequired` envelope. Always. There is
no s402-native 402 shape and no option to select one.**

1. **Envelope.** `{ x402Version: 2, resource, accepts: PaymentRequirements[], extensions }`,
   byte-compatible with `@x402/core`'s decoder at the pin. `resource` is required by x402 and
   therefore required by s402; `s402Gate` takes it as a mandatory option where ADR-015 took it as
   part of an optional one.

2. **One `accepts[]` entry per offered scheme.** `scheme` is the s402 scheme name (`exact`, `upto`,
   `prepaid`, `stream`, `escrow`, `unlock`). `network` is CAIP-2 (`sui:mainnet` already is).
   `asset`, `amount`, `payTo`, `maxTimeoutSeconds` are x402's fields with x402's meaning. A
   requirement an x402 client does not understand (`prepaid`, `unlock`) is one it skips; x402's
   client picks the first entry it has a scheme handler for, so **`exact` is listed first whenever
   it is offered.**

3. **Per-requirement s402 fields ride in that entry's `extra`.** `facilitatorUrl`, `expiresAt`, fee
   fields, and the scheme-specific extras (`s402UptoExtra`, `s402PrepaidExtra`, `s402StreamExtra`,
   `s402EscrowExtra`, `s402UnlockExtra`) move into `extra`, keyed as they are today. This is the
   slot x402's own family spec (#3145) names for method-specific requirement fields.

4. **Envelope-level s402 fields ride in `extensions.s402`.** `{ version: '2', mandate?, … }`. The
   presence of `extensions.s402` is what makes a 402 an *s402 profile* 402; its absence makes it a
   plain x402 402 that an s402 client still pays. `detectProtocol()` reads this, not `s402Version`.

5. **Intake of our own past.** `fromS402V1Requirements()` in `compat/` decodes the flat v1 shape for
   one major version, under ADR-013's rule: understanding what was said is an obligation. Nothing
   emits v1.

6. **`normalizeRequirements()` becomes the native path.** The x402 direction of `compat/x402.ts`
   collapses to identity plus `extra` projection; the module keeps L402 and MPP.

7. **Receipts and payloads are out of scope here**, with one binding consequence: ADR-014, when it
   lands the settlement envelope on the wire, designs it as x402's `SettleResponse` (`success`,
   `transaction`, `network`, `errorReason`) carrying s402's `txBinding`, `algs`, `facilitatorIds`
   and `status` alongside — the same profile stance, applied to the third leg.

### The invariant, stated as an absence

> **Architecture Invariant:** no header s402 emits carries a document an unmodified x402 V2
> decoder at the pinned HEAD cannot parse. There is no `accepts` of strings anywhere on the wire,
> and there is no gate option that changes the 402's grammar. An x402 client that reaches an s402
> gate and finds no scheme it understands fails for that reason and no other.

### Versioning

This is the **s402 wire v2** and an npm **major**. ADR-006's version negotiation carries the
number in `extensions.s402.version`. Vectors touched: `requirements-encode`, `requirements-decode`,
`roundtrip`, `compat-normalize`, `body-transport`, `validation-reject`, `transport-carriers` —
rewritten against the envelope, with the v1 decode cases moved under compat. The interop test
loses its `x402: { resource }` option and must stay green; that is the ratchet.

## Alternatives Considered

- **A · Rename s402's `accepts` to `schemes`, keep the flat shape.** Resolves the key collision
  and nothing else: the header is still unreadable by x402, and the flat shape still cannot offer
  two networks. Rejected.
- **B · Nest the native flat requirement under `extensions.s402` and emit a degenerate x402
  `accepts` beside it.** Two sources of truth for the same offer; an x402 client and an s402 client
  can disagree about the price. Rejected.
- **C · Keep ADR-015's opt-in option.** The status quo. Every x402 client is second-class behind a
  flag, every new vector is written against a shape with a known expiry, and "seamless with x402"
  needs a footnote. Rejected by Danny, 2026-09-04.
- **D · Fold the Sui work upstream and retire the s402 wire entirely** (the audit's dissent, and
  the private falsification test's point 1). Rejected *for now*: the policy layer, `unlock`, and
  the vectors need a home x402 has not offered. **Revisit trigger:** a Sui binding of an x402
  scheme lands upstream from anyone other than us.
- **E (chosen) · Adopt x402's envelope as the only 402 shape; s402 fields in `extra` and
  `extensions`.**

## Consequences

**Positive.** An unmodified x402 client pays an s402 gate with no server flag; the README's
sentence needs no qualifier. One 402 can offer several networks and assets. `compat/x402.ts`'s
requirements direction shrinks to a projection. The vectors become the only published conformance
suite for an x402-shaped 402, which is a stronger claim than the one they make today.

**Negative.** Every s402 client and server on the current wire breaks at the major; the installed
base that pays this cost is measured above. The `extra` bag is untyped at x402's layer, so s402's
requirement types now describe the *contents* of `extra` rather than the header; type safety moves
one level down. `resource` becomes mandatory on every gate.

**Risks / watch.** s402 now tracks x402's V2 envelope directly rather than at arm's length; the
drift checker already fetches `foundation/main` and must treat `PaymentRequired` /
`PaymentRequirements` as a red surface. If x402 ever types `extra` per scheme, our keys must not
collide with theirs; namespacing under `extra.s402` is the escape hatch and is deliberately not
taken now because it costs every s402 field a level of nesting for a collision that has not
happened.

## Open — needs a decision, not an agent

Whether `VISION.md` and the README's positioning move from "protocol" to "profile of x402" in the
same major. The architecture now says profile; the prose still says protocol. Danny's call.
