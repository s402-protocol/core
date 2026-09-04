# ADR-014: Landing the settlement envelope on the wire is a transport change, not a wiring change

**Status:** Accepted
**Implementation:** not-started
**Force:** heuristic
**Date:** 2026-08-31
**Related:** ADR-007 (Settlement Response Envelope), ADR-011 (Transport Abstraction), ADR-006 (Version Negotiation), ADR-013 (x402 Intake Compatibility)

---

## Context

Danny ruled on 2026-08-31: **wire the gate to the envelope.** He was told the decision was a
one-line wiring choice, on the strength of ADR-007 reading `Implementation: shipped` while
`gate.ts:186` emitted the legacy flat `s402SettleResponse`. That framing was wrong, and this ADR
exists so the correction outlives the conversation it was made in.

**What is actually true.** The envelope's *types* shipped in April. The envelope has **never been
on the wire.** `buildSettledEnvelope`, `buildPendingEnvelope` and `encodeEnvelopeBody` appear
nowhere in `typescript/src/` except their own module and a re-export line in `index.ts`. Their only
callers are in `test/envelope.test.ts`. ADR-007's `Supersedes:` line describes an intention that
was never executed.

So the gap is not a loose wire. **It is a complete, tested component that was never connected to
anything**, and a status field that said `shipped` because a symbol was exported.

## Four reasons this is bigger than a swap

1. **It is a breaking wire change on a public repo.** `encodeSettleResponse` and
   `decodeSettleResponse` are public API (`index.ts:75-76`), the joke-api example client decodes
   the `payment-response` header directly, and the flat shape is baked into the published
   conformance vectors (`test/conformance/generate-vectors.ts`). Any existing client breaks.

2. **The envelope has no header encoder.** It ships `encodeEnvelopeBody` — plain JSON, with a
   `MAX_BODY_BYTES` guard. The gate writes a base64 **header**. Header-versus-body is ADR-011's
   ground, and choosing one is a protocol decision, not an implementation detail.

3. **There is no version negotiation to hide behind.** `S402_VERSION` is the constant `'1'`, and
   the gate deliberately treats `s402Version` as optional so x402 clients pass through
   (`gate.ts:218`). There is currently no mechanism to emit the new shape only to clients that
   understand it — which is the thing that would make this safe.

4. **Nothing is broken today.** `s402SettleResponse` cannot express `pending`, so no s402 server
   can emit one, so the double-pay this would prevent is **latent, not live.** ADR-013 already
   closed the live half on intake. Urgency is low; blast radius is high. That is the worst possible
   ratio for a change made while nobody can review it.

## Decision

**The ruling stands — the envelope should land on the wire — and it is scoped as a versioned
transport change, not a wiring fix.** Three things must be decided before code, and none of them
were part of the question as originally put:

- **Body or header?** The envelope is body-shaped and the receipt path is header-shaped.
- **How does a client opt in?** Version negotiation, a second header, or a major-version break.
- **What happens to the conformance vectors?** They encode the flat shape as correct behavior.

Until those are answered, the honest state is `not-started`, and ADR-007 has been corrected from
`shipped` to `in-progress` so it stops asserting otherwise.

## Alternatives Considered

- **Swap `gate.ts:186` to emit an envelope.** Rejected: silently breaks every existing client and
  the published vectors, to fix a bug that cannot currently occur.
- **Emit the envelope in an additional header, leaving `payment-response` untouched.** Genuinely
  attractive — additive and non-breaking. Rejected *for now* because inventing a second receipt
  header is itself a protocol design decision, and it is the kind that gets made once.
- **Close ADR-007's supersession as abandoned.** Rejected: Danny ruled the other way, and the
  design is good. The envelope's chain-agnostic shape and `txBinding` are the reasons ADR-007
  exists, and they have not stopped being right.
- **Chosen: record the true scope, correct the lying status field, and leave the wire alone**
  until the three questions above have answers.

## Consequences

- **Positive.** ADR-007 no longer claims a state it never reached. The next agent starts from
  what is true rather than re-deriving it, and the three real questions are written down.
- **Negative.** The latent gap stays open: an s402 server fronting an x402 facilitator still
  cannot relay `pending` to its own clients. That is the same open item ADR-013 named, unchanged.
- **Risk to watch.** `Implementation:` fields that track whether a *symbol exists* rather than
  whether a *behavior reaches the wire*. This ADR is the second instance found in one night. A
  useful check would assert that every ADR marked `shipped` names a call site outside its own
  module and its tests.
