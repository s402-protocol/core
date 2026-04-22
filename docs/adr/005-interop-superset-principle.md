# ADR-005: Interop When Possible, Superset When Wise

**Status:** Accepted
**Date:** 2026-04-14
**Supersedes:** (none — formalizes informal positioning against x402 and MPP)
**Linear:** DAN-313

## Context

s402 enters a market with two incumbent agent-payment protocols:

- **x402** (Coinbase): 2 schemes (exact, upto), 7 chains, 6 extensions, ~1,800 PRs, x402-foundation backing. Wire-compatible with HTTP 402 semantics.
- **Stripe MPP** (with Tempo L1): 2 intents (subscription, tap), CC0 spec, IETF draft, coalition of Visa/Anthropic/OpenAI/Mastercard/Cloudflare/Shopify. Permissioned Tempo L1 as settlement substrate.

Both are better-resourced than s402. Both have distribution channels s402 lacks. The strategic question is: how does s402 win without the resources of Coinbase or the coalition power of Stripe/Visa?

The answer is not "compete feature-for-feature." It is **structural asymmetry in what each protocol can express**. s402 is not constrained by a revenue model that forbids certain primitives. MPP is: any scheme that bypasses Stripe's card-processing margin cannot ship in MPP. x402 is: any scheme beyond the 2-scheme design envelope requires re-architecting the spec in a governance structure owned by a single company. s402's constraint envelope is strictly larger than both.

But expressiveness alone is insufficient if adopters have to *choose* between protocols. The governing principle below resolves the choice problem.

## Decision

**s402 interops when possible. s402 supersets when wise.**

### Interop when possible

Where a competing protocol has a legitimate design that s402 can accept without compromise, s402 **absorbs** the competing protocol as a payment-in format. Specifically:

1. **x402 compatibility** — `s402/compat/x402` normalizes x402 `exact` and `upto` payloads to s402 payloads. An s402 resource server accepts x402 clients transparently. Already shipped (ADR-001 §3).
2. **MPP compatibility** — a future `@sweefi/mpp-adapter` will accept MPP intent payloads and convert to s402 payment payloads where semantics map cleanly. Intents that cannot map (e.g., scheme-specific Stripe-only fields) return `UNSUPPORTED_INTENT` with clear guidance.
3. **Future protocols** — the compat layer is the contract; new protocols get adapters in `@sweefi/*-adapter` packages, never in the `s402` core.

Interop is **asymmetric in s402's favor**. Competitors' business models forbid reciprocating:

- Stripe cannot accept s402 payment-in formats because s402 schemes bypass the card-processing margin that funds Stripe's business.
- Coinbase's x402 is structurally limited to exact + upto because those are the schemes the x402 spec governance has ratified; acceptance of s402's prepaid, streaming, escrow, or unlock schemes would require re-ratifying the spec.
- Neither can match s402's expressiveness without violating their own design or revenue constraints.

### Superset when wise

Where s402 schemes go beyond what competitors can structurally ship, s402 **supersets** the competitor. Specifically:

| s402 scheme | x402 | MPP | Why competitors can't match |
|-------------|------|-----|------------------------------|
| **Prepaid with on-chain settlement ceiling** | No | No | Requires PTB atomicity for batch settlement |
| **Streaming with rate enforcement on-chain** | No | No | MPP subscription ≠ on-chain streaming; x402 has no streaming scheme |
| **Escrow with arbiter** | No | No | Would eliminate Stripe's dispute-fee revenue; x402 governance hasn't ratified |
| **Unlock (Seal-encrypted pay-to-decrypt)** | No | No | Requires Sui-native threshold encryption |
| **Upto with on-chain ceiling** | Partial (Permit2 max, facilitator discretion) | No | s402 enforces server-declared ceiling on-chain |

An adopter who only needs exact payments can use x402 or MPP and switch to s402 later without losing anything. An adopter who needs prepaid batching, streaming with enforcement, escrow, or Seal unlock *must* use s402. The superset always eats the subset because adopters never lose what they had — they only gain.

### The one-line form

The principle appears verbatim in every external s402 artifact:

> *We interop when possible. We superset when wise.*

This includes: s402 README, SweeFi README, talks (AIEWF 2026 pitch), ADRs, blog posts, Linear project descriptions, and external pitch decks.

## Alternatives Considered

**Alt A — Pure superset (no interop layer).**
Rejected. Without `s402/compat/x402`, every x402 adopter must migrate or fork. Migration friction kills adoption. The Let's Encrypt analogue is instructive: LE did not require abandoning commercial CAs; it worked alongside them, then ate the market.

**Alt B — Pure interop (no superset schemes).**
Rejected. Without prepaid, streaming, escrow, and unlock, s402 offers no durable reason to exist. Interop is a distribution vector, not a strategy. The strategy is *what s402 can ship that competitors structurally cannot*.

**Alt C — Head-to-head competition on the same schemes.**
Rejected. Coinbase and Stripe have more engineers, more capital, more distribution, and more institutional relationships. Fighting them on a shared scheme surface is a losing battle. The constraint-asymmetry thesis (see `talks/aiewf-2026-s402/NEUTRALITY-PITCH.md`) is specifically that s402 wins on primitives competitors cannot ship, not on primitives both protocols share.

**Alt D — Corporate-owned spec with commercial licensing.**
Rejected. A corporate-owned spec would be a smaller, weaker MPP clone. The thesis is that *permissionlessness and no-monetization-filter are features*, not deficiencies. Corporate ownership eliminates the structural advantage.

## Consequences

**Positive:**
- Adopters never have to choose "s402 or x402/MPP"; they choose "s402 plus x402/MPP."
- The durable strategic answer to "why not MPP?" becomes a factual statement about scheme expressiveness, not a marketing claim.
- Every new competitor protocol becomes a potential payment-in format for s402 via adapter packages, not a threat to core.
- Framework maintainers (ElizaOS, OpenClaw, Letta, CrewAI) can adopt s402 without forcing their users to abandon existing payment rails.

**Negative:**
- Adapter maintenance is ongoing engineering work. Every upstream change in x402 or MPP requires compat-layer updates. Mitigated by keeping adapters in sibling packages (not `s402` core), so core remains untouched.
- The "interop" story invites adopters to *only* use the subset that interops, never reaching for superset schemes. Mitigated by documentation that leads with the problems only superset schemes solve (agent budgets, trustless streaming, pay-to-decrypt content unlock).

**Risks & watch-fors:**
- **Adapter drift.** If x402 or MPP ship breaking changes, adapter packages can silently degrade. Mitigation: CI tests against upstream protocol versions; adapter packages pinned to specific protocol versions.
- **Mission-creep into implementing competitor schemes natively.** An adapter should translate, not re-implement. If a competitor adds a new scheme, s402 decides whether to (a) add a native scheme, (b) translate via adapter, or (c) decline. The default is (b). Native schemes go through the scheme-registry process (ADR-001 §1).
- **Misreading "interop" as "parity."** Interop means accepting competitors' formats as *input*. It does not mean implementing every competitor feature. When a competitor ships a scheme that conflicts with s402's expressiveness thesis (e.g., a permissioned-rail-only scheme), the correct answer is to decline interop, not compromise the thesis.

## Follow-ups

- [ ] Add the "Governing Principle" section to `projects/s402-project/s402/README.md` (done in this batch)
- [ ] Add the "Governing Principle" section to `projects/sweefi-project/sweefi/README.md` (done in this batch)
- [ ] Update Linear DAN-313 with link to this ADR
- [ ] Add the one-line principle to AIEWF 2026 talk script
- [ ] When MPP adapter work begins, create an ADR for the MPP-specific translation decisions (scheme-by-scheme)
- [ ] Quarterly review: does the adapter maintenance burden justify the interop value? If an adapter costs more than it gains in adoption, deprecate it.
