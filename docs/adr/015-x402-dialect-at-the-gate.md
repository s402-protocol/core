# ADR-015: The gate answers in the dialect it was addressed in, and emits x402's 402 only when asked

**Status:** Accepted
**Implementation:** shipped
**Force:** heuristic
**Date:** 2026-09-04
**Related:** ADR-005 (Interop Superset Principle), ADR-013 (x402 Intake Compatibility), ADR-007 (Settlement Response Envelope), DAN-1075
**Verified against:** x402 `x402-foundation/x402` @ `2cc7e9a6` (2026-09-04), `@x402/core` + `@x402/fetch` 2.25.0 — `typescript/test/interop-x402-client.test.ts`

---

## Context

For five months the README said: *"An x402 client can talk to an s402 server using this scheme
with zero modifications."* The sentence had no test. On 2026-09-04, the first test that ran an
**unmodified** upstream client (`@x402/fetch`'s `wrapFetchWithPayment` over `x402Client`) against
`s402Gate` failed on the first leg of the round trip:

```
Failed to create payment payload: No client registered for x402 version: undefined
```

Three wire boundaries stand between an x402 client and paid content, and at the pinned HEAD the
gate crossed none of them cleanly:

| Leg | What x402 V2 does | What `s402Gate` did |
|---|---|---|
| 1 · the 402 | reads `PAYMENT-REQUIRED` → `{ x402Version: 2, resource, accepts: [PaymentRequirements] }` | emitted `payment-required` → `{ s402Version: '1', accepts: ['exact'], network, … }` |
| 2 · the payment | sends `PAYMENT-SIGNATURE` → `{ x402Version: 2, accepted, payload }` | read only `x-payment`; the native decoder wants a top-level `scheme` |
| 3 · the receipt | reads `PAYMENT-RESPONSE` → `{ success, transaction, network }` | emitted `payment-response` → `{ success, txDigest }` |

The gate's own comment said x402 clients were "accepted out of the box." That was true of x402
**V1** payloads — same header name, top-level `scheme` — and false of V2, which is what the
upstream client sends by default. Leg 2 is an intake defect and ADR-013 already obliges us to fix
it. Legs 1 and 3 are **emission**, which ADR-013 deliberately did not license.

The reason leg 1 cannot be fixed by "emit both" is structural: **both dialects use the key
`accepts` on the same header**, s402 for a list of scheme names and x402 for a list of
requirement objects. One header, one JSON, one `accepts`. There is no superset document that
satisfies both decoders.

## Decision

Three rules, one per leg.

1. **Intake is unconditional.** The gate reads `PAYMENT-SIGNATURE` (x402 V2) and `X-PAYMENT`
   carrying an `x402Version` (x402 V1) through `fromX402PayloadHeaders`, and remembers which
   dialect the payment arrived in. No option, no configuration. This is ADR-013 applied to the
   gate.

2. **The receipt is answered in the dialect the payment arrived in.** A payment under
   `PAYMENT-SIGNATURE` or an `x402Version`-bearing `X-PAYMENT` gets a `payment-response` shaped as
   x402's `SettleResponse` (`transaction`, `network`, `errorReason`, `errorMessage`, `amount`),
   with s402's own fields kept alongside because x402 decoders ignore unknown keys. A native s402
   payment gets exactly what it got before. **This is not a change to s402's wire format**: s402
   clients never send the markers that select the x402 receipt, so nothing they receive changed.

3. **The 402 speaks x402 only when the operator asks.** `s402Gate({ x402: { resource } })` emits an
   x402 V2 `PaymentRequired` envelope in the header and body. Off by default, because turning it
   on changes what *every* client of that route receives — an s402 client must then normalize
   the 402 through `normalizeRequirements()`, and s402-only requirement fields (`facilitatorUrl`,
   `mandate`, `expiresAt`, fees, `extensions`) do not travel on an x402 envelope. Only
   `exact`-first requirements are expressible; anything else throws at 402 time rather than
   downgrading silently.

### The invariant, stated as an absence

> **Architecture Invariant:** the gate never emits an x402-shaped 402 unless `options.x402` is
> set, and never emits an x402-shaped receipt unless the payment arrived in x402's dialect. There
> is no heuristic that guesses a client's dialect from anything other than the payment header it
> sent. A guess that is wrong hands a paying client a receipt it cannot decode.

### What "zero modifications" now means, precisely

An unmodified x402 client gets paid content from an s402 gate **when the gate has the `x402`
option set**. Zero changes on the client, one option on the server. The README, the API docs and
the migration guide now say that sentence instead of the old one, and
`test/interop-x402-client.test.ts` is the sentence executed against the real upstream packages.

## Alternatives Considered

- **A · Emit the x402 V2 envelope by default.** Makes the claim true with zero server config.
  Rejected for now: it is a wire-format change for every existing s402 client (they would need
  `normalizeRequirements()` on every 402), and it silently drops s402-only requirement fields.
  This is the *right* long-term answer if s402's `payment-required` is redefined as a superset of
  x402's envelope — but that means renaming s402's `accepts` or nesting native requirements under
  a namespaced key, which is a protocol-version decision. **Open for Danny; see below.**

- **B · A separate header for the x402 envelope** (e.g. emit both `payment-required` native and an
  x402 envelope under another name). Rejected: x402 clients read exactly `PAYMENT-REQUIRED`, and
  x402 owns that name. An extra header nobody reads is not compatibility.

- **C · Leave emission alone, document the `on402` escape hatch.** The pre-existing state, minus
  the false sentence. Rejected: an operator who wants x402 clients should not have to hand-roll
  the envelope encoding when `toX402V2Envelope` already exists one import away.

- **D (chosen) · Unconditional intake, dialect-echo receipt, opt-in 402.** Everything ADR-013
  obliges is on by default; everything that would change an s402 client's experience is a
  visible server choice.

## Consequences

**Positive.** The interop claim has a test, against the real upstream client, pinned to a sha.
An x402 client's V2 payment is no longer refused. An x402 client that pays gets a receipt its own
decoder reads. s402 clients see no change unless their operator opts in.

**Negative.** `gate.ts` now imports from `compat/x402.ts`, so the x402 intake code is in the main
bundle rather than only behind the `s402/compat/x402` sub-path. That is the cost of ADR-013's
"intake is an obligation" — an obligation cannot be opt-in. Zero runtime dependencies is
unaffected. The opt-in 402 means an operator who forgets the option still ships a server the
README's headline sentence does not describe; the sentence now says so.

**Risk / what to watch.** x402's `Base64EncodedRegex` gates every header it decodes; s402 encodes
standard base64 today and the test would catch a drift. The x402 V1 402 (requirements in the
body with `x402Version: 1`) is not emitted in either mode; V1 is frozen upstream and the current
upstream client reads V2 headers first, so no known client needs it. If one appears, it is a
body-shape addition to the `x402` mode, not a new decision.

## Open — needs a decision, not an agent

**Should s402's `payment-required` become a superset of x402's V2 envelope?** That would make
Alternative A safe and retire the option. It requires resolving the `accepts` collision — rename
s402's field, or nest the native requirements under `s402` inside an x402 envelope — and it is
therefore a wire-format decision on the order of ADR-007's. It is the sharpest architectural
question Phase 1 of DAN-1075 surfaced, and it goes to the Phase 2 council with this ADR as input.
