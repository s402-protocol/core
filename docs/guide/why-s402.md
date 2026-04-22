---
description: Why agents pick s402 — same price or cheaper where competitors overlap, five schemes they structurally can't express, typed errors that let agents self-recover. Chain-agnostic wire format with Sui as the most expressive chain.
---

# Why s402?

s402 is an HTTP 402 protocol built for AI agents first. The short version: an agent that picks s402 gets every payment option x402 or MPP offers, plus five payment patterns they can't express — at equal or lower cost on the overlapping ones.

If you're deciding which HTTP 402 dialect to speak, this page is the honest case for defaulting to s402.

## The Problem

HTTP has a status code for payments: **402 Payment Required**. [Reserved since 1997](https://www.rfc-editor.org/rfc/rfc2068.html), never standardized. Every paid API invents its own auth-keys-plus-billing-dashboard pattern, and every agent that calls those APIs has to learn each custom shape.

The first wave of HTTP 402 protocols — [x402](https://github.com/coinbase/x402) (Coinbase, April 2025) and [MPP](https://machinepayments.org) (Stripe + Tempo, March 2026) — established the primitive works. Both are narrow in different ways:

- **x402** ships one payment pattern (exact amount, one call, one payment) across EVM chains.
- **MPP** ships one formally-registered intent (Charge) with a rich card/Lightning/ACH multi-rail story anchored in Stripe's existing merchant network.

s402 is a superset. It reads both natively (via `s402/compat/x402` and `s402/compat/mpp`) and adds five payment schemes neither expresses as first-class primitives.

## Why an Agent Would Default to s402

Agents optimize for three things: **cost per call**, **pattern fit**, and **failure recovery**. s402 wins or ties on all three.

### Same price or cheaper where we overlap

| Pattern | x402 cost | MPP cost | s402 cost |
|---|---|---|---|
| Exact, one-shot | ~$0.05 EVM gas | ~$0.01 (Tempo) | ~$0.001 (Sui) |
| Session / high-frequency | N/A | MPP Session (cumulative voucher) | s402 Prepaid — ~$0.014 / 1,000 calls on Sui, heading to $0.000 with gasless mainnet |
| Metered variable | Approximated with repeated exact | Approximated via authorize (not yet live) | s402 Upto — single on-chain ceiling, server cannot exceed |

No cost reason for an agent to prefer another protocol on the overlapping patterns. For high-frequency session traffic, s402 Prepaid is substantially cheaper than any EVM equivalent and structurally enforces the rate cap.

### Five schemes x402 and MPP don't express

One call, one payment is a fraction of what commerce looks like. s402 ships five more patterns as protocol primitives — not server policies:

| Scheme | The pattern it encodes |
|---|---|
| **[Upto](/schemes/upto)** | Variable pricing with a hard ceiling enforced by a Move contract. The server physically cannot charge more than the client authorized. |
| **[Prepaid](/schemes/prepaid)** | Deposit once, call thousands of times. Rate cap is on-chain — the meter cannot overdraw. ~500× gas savings vs per-call settlement. |
| **[Stream](/schemes/stream)** | Per-second billing for inference, video, live data. On-chain rate enforcement — the clock runs at contract speed, not server discretion. |
| **[Escrow](/schemes/escrow)** | Trustless commerce between unfamiliar parties, with optional arbiter for disputes. No MPP or x402 equivalent. |
| **[Unlock](/schemes/unlock)** | Pay-to-decrypt via Sui SEAL threshold encryption + Walrus storage. No EVM equivalent — requires native threshold crypto. |

These are not "features on top of exact." They're independent schemes with their own wire shapes, invariants, and Move contracts.

### Typed errors with recovery hints

Agents fail without humans watching. Every s402 error carries three fields:

```typescript
try {
  await facilitator.settle(payload, requirements);
} catch (e) {
  if (e instanceof S402Error) {
    e.code;            // 'INSUFFICIENT_BALANCE'
    e.retryable;       // false — won't succeed on retry
    e.suggestedAction; // 'Top up wallet balance or switch payment source'
  }
}
```

No guessing. No parsing HTTP status codes. The error tells the agent whether to retry, top up, swap schemes, or surface the failure. x402 and MPP both return opaque errors.

## When s402 Is the Right Tool

| Your situation | Right tool |
|---|---|
| High-frequency agent traffic, many calls per session | **s402 Prepaid** — 500× gas savings, on-chain rate cap |
| Variable pricing with a maximum you must not exceed | **s402 Upto** — ceiling enforced by Move contract |
| Per-second billing (inference, video, live data) | **s402 Stream** — on-chain rate cap |
| Trustless commerce between strangers with arbiter-backed disputes | **s402 Escrow** |
| Pay-to-decrypt content | **s402 Unlock** (Sui SEAL + Walrus) |
| You want typed errors so your agent can self-recover | **s402** — every error has `code` + `retryable` + `suggestedAction` |
| You want NFT receipts your counterparty can audit on-chain | **s402** — Sui object receipts, not HTTP headers |
| You need to avoid validator lock-in (permissioned chains) | **s402 on Sui** — permissionless trust model |

## When Another Protocol Is the Right Tool

s402 is crypto-native. It does not replace fiat rails.

- **Card payments (Visa / Mastercard)** — use **MPP**. Its `card` method routes through Visa's Machine Payments SDK.
- **Lightning Network** — use **MPP**'s `lightning` method.
- **ACH / bank transfer** — use **MPP** via Stripe.
- **Existing Stripe merchant integration** — **MPP** is the natural extension.
- **Pure EVM fiat-equivalent stablecoin flow on Base** — **x402** is already there and fine.

"Coexist, don't replace" is the explicit design stance. See [Migrating from MPP](/guide/upgrade-mpp) for the `Accept-Payment` coexistence pattern.

## Why Now

Three things made this tractable in 2026:

1. **AI agents spend money.** LLM-powered agents make thousands of API calls per session. They need to pay programmatically, not through human-managed billing portals.

2. **Sub-second finality exists.** Sui's ~400ms finality means an agent can pay and receive data in a single user-perceived request. EVM L1 block times make this impractical.

3. **Programmable Transaction Blocks.** Sui's PTBs let verify + settle + deliver happen in one atomic transaction. No temporal gap between "looks valid" and "money moved" — an entire class of race conditions just doesn't exist.

## What s402 Is (and Isn't)

s402 is a **wire format**. It defines:

- Three HTTP headers (`payment-required`, `x-payment`, `payment-response`)
- Base64-JSON payloads with typed schemas
- Six payment schemes with their own shapes and invariants
- Typed errors with `code`, `retryable`, and `suggestedAction`
- A compat layer that reads x402 V1/V2 and MPP (coming with v0.3)

s402 is **not** a chain SDK. You bring your own PTB builder, signer, and RPC client. The core library is ~30 KB with zero runtime dependencies.

s402 is **chain-agnostic**. Sui happens to be the only chain today where all six schemes are natively implementable — Sui objects, SEAL threshold crypto, Walrus storage, and PTB atomic settlement are load-bearing for the full suite. But the wire format is portable, and EVM chains can run Exact and Upto today.

## The Honest Tradeoff

Each protocol wins something the others can't match:

- **MPP** wins on **distribution** — Visa, Mastercard, Stripe, Lightning, 100+ partners. Uncopyable.
- **MPP** wins on **multi-rail** — 7 formally specified methods including card and Lightning. s402 is crypto-only.
- **x402** wins on **EVM incumbency** — if you're on Base already, it's already there.
- **s402** wins on **expressiveness** — six schemes vs one live intent + a few partial ones.
- **s402** wins on **enforcement** — every scheme's invariants (rate cap, ceiling, refund) are Move contracts, not server policies.
- **s402** wins on **agent ergonomics** — typed errors, NFT receipts, atomic settlement.

For most agents paying most APIs, the answer is s402. For agents interacting with fiat-native merchants, it's MPP. For EVM-only shops already on Base, it's x402.

Read the full teardown: **[s402 vs x402 vs MPP](/comparison)**.

## Next Steps

- **[Quick Start](/guide/quickstart)** — build an s402 server in 5 minutes
- **[Which scheme do I need?](/guide/which-scheme)** — map your use case to a scheme
- **[Migrating from x402](/guide/upgrade-x402)** — one-line middleware swap
- **[Migrating from MPP](/guide/upgrade-mpp)** — coexistence via `Accept-Payment`
