# ADR-013: x402 compatibility is an obligation on INTAKE, not a licence to change emission

**Status:** Accepted
**Implementation:** shipped
**Force:** heuristic
**Date:** 2026-08-31
**Related:** ADR-005 (Interop Superset Principle), ADR-007 (Settlement Response Envelope), ADR-002 (s402 is pure protocol), DAN-843, DAN-846

---

## Context

Between 2026-08-14 and 2026-08-31, upstream x402 and MPP moved in three ways that reach
the s402 compat layer:

| | Upstream | What it is |
|---|---|---|
| D1 | mpp-specs #328 (`ccab885`, 08-25) | A Payment challenge may carry `header="Payment-Authorization"`, selecting a different HTTP field for the credential. |
| D2 | x402 #3083 (`6dba93ed`, 08-17), shipped in `230e6a9a..94f9951a` | `settlement_pending` — a **non-terminal** settle outcome: broadcast succeeded, confirmation could not be established, tx hash carried so the caller reconciles on chain. |
| D3 | x402 #3240 / #3267 (08-25/26) | `exact` gained an `upfront` payment flow, signalled by `accepts[].extra.paymentFlow`. |

D1 and D3 are bounded parsing gaps. **D2 is not**, and it is where this ADR earns its
number, because "be compatible with x402" has two readings that look identical until you
try to build one:

1. **Understand what x402 says.** Read `settlement_pending` off an x402 server's response
   and know it is not a failure.
2. **Say what x402 says.** Put a third settlement state on s402's own wire.

Reading (1) is a bug fix. Reading (2) is a wire-format change to `s402SettleResponse`, the
same class of decision as the escrow / multi-settle question DAN-855 already declared out
of scope. An agent that slides from one to the other while "fixing compatibility" has
changed the protocol without anyone deciding to.

The distinction is load-bearing because the failure mode is asymmetric and expensive.
`settlement_pending` reaching an s402 client as `success: false` invites a retry, and the
retry is a **second payment for a transaction that already landed**. Upstream's own
resource server does exactly one automatic re-settle on it (`settleWithPendingRetry`) — a
re-settle of the *same* broadcast, never a fresh payload — for precisely this reason.

## Decision

**Compatibility obliges s402 to UNDERSTAND upstream on intake. It does not oblige s402 to
EMIT a new state of its own.**

Concretely, as of this ADR:

- `compat/x402.ts` gains `fromX402SettleResponse` / `fromX402SettleResponseHeaders`,
  which classify an x402 settle result as `settled | pending | failed` and mark both
  `settled` and `pending` as **not retryable**.
- `compat/x402.ts` gains `extra` on its intake requirements type and
  `x402PaymentFlowOf`, so the `exact` scheme's flow is readable. Emission
  (`toX402V2Requirements`) is unchanged: it defaults `extra: {}`, and an absent
  `paymentFlow` *means* `authorization`, so what s402 emits was already correct.
- `compat/mpp.ts` preserves the `header` challenge parameter, refuses any value the spec
  forbids, echoes it in the credential only when the challenge carried it, and exposes
  `mppCredentialHeaderName` so a caller knows which field to use.
- **`s402SettleResponse` is untouched.** There is deliberately no
  `toS402SettleResponse(outcome)` counterpart to the intake classifier, and the absence is
  documented in the code where someone would go looking for it.

### The invariant this states as an absence

> **Architecture Invariant:** nothing in `compat/` may collapse an x402 `pending` onto
> s402's `success: false`. The compat layer is permitted to *read* a state s402 cannot
> express; it is not permitted to *flatten* one. If a future caller needs to relay a
> pending outcome onward, that is an ADR-007 change and needs its own decision, not a
> mapping function added quietly to compat.

## Alternatives Considered

- **Option A — add `pending` to `s402SettleResponse` now.** Reaches x402 parity in one
  move and would let an s402 server relay upstream's pending state honestly. Rejected as
  out of scope for a compat pass: it is a wire-format decision, it touches ADR-007, and
  nobody has asked for it. A compat fix that changes the protocol is not a compat fix.

- **Option B — map `pending` to `success: false` and document the caveat.** The cheapest
  patch, and the one that reintroduces the exact bug. A caveat in a doc does not stop a
  retry loop that is reading a boolean.

- **Option C (chosen) — a compat-layer outcome type that names `pending`, and no path
  back into the s402 envelope.** The information survives at the boundary where it
  arrives, and the boundary where it would have to be re-emitted stays a decision rather
  than a side effect.

## Consequences

**Positive.** The double-pay is closed for any caller using the intake helpers. The
MPP `MUST NOT`s around the alternate credential header are enforced by refusal rather than
by documentation. The `exact` flow is legible for the first time.

**Negative.** An s402 *server* fronting an x402 facilitator still cannot tell its own
clients "pending, reconcile before retrying" — it can only decline to lie about it. That
gap is real and is the open item below, not an oversight.

**Risk / what to watch.** ADR-007 already defines `s402EnvelopePending`
(`status: 'pending'`, with `retryAfter` and `reason`) and it is shipped in
`typescript/src/envelope.ts`. The wire path `gate.ts` uses is still the legacy flat
`s402SettleResponse`, which has no pending. So the emission question is **half-answered
already**: the envelope reserved the slot, the gate never wired it. Whoever picks up the
emission decision should start from that fact rather than from a blank page — the design
work is done, the wiring is not.

## Open — needs a decision, not an agent

**Should s402's `payment-response` be able to say "pending"?** That is an ADR-007 question
about the settle envelope. It is the only item from the 2026-08-31 upstream-drift triage
that this ADR does not settle, and it has been open since 2026-08-21.
