---
description: Migrating from MPP to s402 — coexistence pattern via Accept-Payment, permissionless trust, and four scheme categories MPP cannot structurally express. Keep MPP for fiat rails, add s402 for everything crypto-native.
---

# Migrating from MPP

Already running MPP (Stripe's Machine Payment Protocol on Tempo)? s402 is designed to coexist with MPP, not replace it — each protocol has genuine strengths the other doesn't.

This guide is for teams evaluating s402 alongside MPP, or already running MPP and considering s402 for the patterns MPP doesn't cover.

::: info Availability
MPP compat **read path** (challenge parsing + Charge-to-s402 translation) ships with v0.3 — the code is in the `s402/compat-mpp` entry point. Write-path emission (s402 → MPP challenges) and the Session-to-Prepaid shim are on the v0.4 roadmap ([DAN-339](https://linear.app/dannydevs/issue/DAN-339)). Today you can consume MPP Charge 402 responses natively; emitting MPP challenges still requires routing to an MPP-native server.
:::

## TL;DR

- s402 will read MPP Charge via `s402/compat/mpp` (shipping with v0.3)
- Your existing MPP flow keeps working
- You gain four scheme categories MPP structurally cannot express: Upto on-chain ceiling, Escrow with arbiter, Stream with on-chain rate cap, Unlock pay-to-decrypt
- Coexistence is the default: advertise both via `Accept-Payment` and let each client pay its native way

## When to pick s402 over MPP

| Situation | Right tool |
|---|---|
| You need to charge an agent less than $0.01 per call, thousands of times per session | **s402 Prepaid** — ~$0.014 / 1,000 calls on Sui, heading to $0.000 with gasless mainnet |
| Your API has variable pricing and you must bound the maximum charge | **s402 Upto** — the ceiling is enforced by a Move contract, not server policy |
| You're running per-second billing (inference, video, live data) | **s402 Stream** — on-chain rate enforcement, meter physically cannot overdraw |
| Trustless commerce between unfamiliar parties with arbiter-backed disputes | **s402 Escrow** — no MPP equivalent |
| Pay-to-decrypt content | **s402 Unlock** — uses Sui SEAL + Walrus; no EVM equivalent exists |
| You need to avoid Stripe or Tempo validator lock-in | **s402** — permissionless trust model on Sui |

## When to stay on MPP

s402 is crypto-native. MPP has rails s402 doesn't:

- **Card payments (Visa)** — MPP's `card` method routes through Visa's Machine Payments SDK
- **Lightning** — MPP's `lightning` method
- **ACH / bank transfers** — via Stripe
- **Split payments** — MPP's `methodDetails.splits` distributes to multiple payees in one atomic settlement
- **Existing Stripe merchant integration** — if your customers already pay via Stripe, MPP is a natural extension

If your use case is "pay a card-only merchant," use MPP. s402 is not trying to be a card network.

## Coexistence pattern — the default

You don't need to migrate *away* from MPP to adopt s402. Advertise both protocols on the same endpoint via the `Accept-Payment` header, and let each client pay its native way.

```typescript
import { parseAcceptPayment, selectBestScheme, S402_HEADERS } from 's402';

async function handle(req: Request): Promise<Response> {
  const preferred = parseAcceptPayment(req.headers.get(S402_HEADERS.ACCEPT_PAYMENT));

  // Advertise what this endpoint speaks.
  const supported = [
    's402/exact',       // s402 native
    's402/prepaid',     // s402 high-frequency
    'tempo/charge',     // MPP on Tempo (v0.3 compat)
    'stripe/charge',    // MPP card rail (v0.3 compat)
  ];

  const chosen = selectBestScheme(preferred, supported);

  if (chosen?.startsWith('tempo/') || chosen?.startsWith('stripe/')) {
    // v0.3: delegate to 's402/compat-mpp' challenge builder.
    // Until then, route MPP traffic to your existing MPP server path.
    return routeToMppHandler(req, chosen);
  }

  // s402-native path — build a standard payment-required response.
  return buildS402Challenge(chosen ?? 's402/exact');
}
```

`parseAcceptPayment` and `selectBestScheme` ship today in `s402`. The MPP challenge builder arrives with the v0.3 compat module — until then, `chosen` tells you *which* protocol to route to, and you forward MPP-shaped requests to whatever MPP server you already operate.

Result: MPP clients pay via MPP (card, Lightning, Tempo EVM). s402 clients pay via s402 (Sui Exact, Prepaid, etc.). Neither client stack changes.

## Migrating off MPP (if you want to)

Some teams want to consolidate on a single protocol. s402's compat layer makes that mechanical — the read path ships with v0.3, letting an s402 client consume an MPP Charge 402 response using native s402 types:

```typescript
// Receiving an MPP Charge challenge as an s402 client
import {
  parseWwwAuthenticatePayment,
  fromMppChargeChallenge,
} from 's402/compat-mpp';

const challenge = parseWwwAuthenticatePayment(
  response.headers.get('WWW-Authenticate'),
);
if (challenge?.intent === 'charge') {
  const requirements = fromMppChargeChallenge(challenge);
  // requirements is s402PaymentRequirements with scheme "exact",
  // network resolved (e.g., "tempo:42431", "eip155:8453"),
  // asset = currency, payTo = recipient, expiresAt from RFC 3339.
  const payment = await buildS402Payment(requirements);
}
```

`parseWwwAuthenticatePayment` extracts the RFC 9110 auth-params; `fromMppChargeChallenge` decodes the base64url JCS request body, enforces blockchain-method invariants (recipient required, amount integer, non-expired), and returns an `s402PaymentRequirements` with `scheme: 'exact'`.

### Method coverage

The translator handles MPP's **blockchain Charge methods** — the subset where the request shape exposes a payTo and asset that s402's exact scheme can consume:

| MPP method | s402 network | Notes |
|---|---|---|
| `tempo` | `tempo:{chainId}` | chainId from `methodDetails.chainId` |
| `evm` | `eip155:{chainId}` | EIP-155 convention |
| `solana` | `solana:unknown` | chain implicit in method |
| `lightning` | `lightning:unknown` | bolt11 invoice in methodDetails |
| `stellar` | `stellar:unknown` | chain implicit in method |
| `stripe`, `card` | — | processor routes internally; no payTo exposed |

Processor methods (Stripe, card) have no payTo in the Charge request — they route payments through the processor's internal ledger. Keep those on the MPP path; the translator rejects them explicitly.

### What's not in the read path yet

The v0.3 read path intentionally stops short of:

- **Session intent** — cumulative voucher model needs a translation shim to Prepaid receipts
- **Credential dispatch** — each method spec (EVM permit2/authorization/transaction/hash, Tempo transaction/hash/proof) defines its own payload shape; `decodeMppCredential` exposes the envelope but method-specific handling lives in chain adapters
- **HMAC challenge-binding verification** — requires the server's secret; implemented in the facilitator, not this client-facing module
- **Write path** (s402 → MPP emission) — on the v0.4 roadmap

## Honest comparison

Read the full three-way breakdown: **[s402 vs x402 vs MPP](/comparison)**. Short version:

- **MPP wins on distribution** — Visa, Mastercard, Stripe, Lightning, 100+ partners. Uncopyable.
- **MPP wins on multi-rail** — 7 formally specified methods, including card and Lightning. s402 is crypto-only.
- **s402 wins on expressiveness** — six schemes as first-class protocol primitives vs MPP's 1 formally registered intent (Charge) + Session as a Tempo-method mode.
- **s402 wins on enforcement** — every scheme's invariants (rate cap, ceiling, refund) are Move contracts, not server policies.
- **s402 wins on trust model** — permissionless Sui vs Tempo's permissioned validator set + Stripe for fiat.

Each wins something the other can't match. The right answer for most production systems is "both, via `Accept-Payment`."

## FAQ

### Do I have to run Sui to use s402?

No. s402 is a chain-agnostic wire format. You can deploy on any chain, but Sui is where all six schemes are currently implemented natively.

### Does s402 speak MPP's `WWW-Authenticate: Payment` header?

Read path lands in v0.3: `parseWwwAuthenticatePayment` + `fromMppChargeChallenge` in `s402/compat-mpp`. Write-path emission (s402 server sending an MPP-shaped `WWW-Authenticate: Payment` header) is v0.4 roadmap. Native s402 uses its own headers (`payment-required`, `x-payment`); the two coexist via the `Accept-Payment` negotiation.

### Can MPP clients consume s402 NFT receipts?

Not natively — MPP uses HTTP header receipts only. The compat layer will emit MPP-shaped receipts alongside the on-chain NFT, so MPP clients see what they expect.

### What about MPP's `Accept-Payment` header?

s402 will parse and emit it. See [DAN-341](https://linear.app/dannydevs/issue/DAN-341) for the tracking issue.

### What about MPP Session (EIP-712 cumulative vouchers)?

That maps to s402 Prepaid. The compat module needs a translation shim (cumulative amount ↔ per-call receipts). Scoped in [DAN-339](https://linear.app/dannydevs/issue/DAN-339).

### What about `authorize` and `subscription` intents?

MPP's IETF draft reserves these identifiers but they're not yet specified or deployed. When they land, s402 will either map them to existing schemes (Upto for authorize, repeated Exact for subscription) or add a dedicated scheme if the on-chain lifecycle is truly irreducible.

## Next steps

- **[Compare s402 vs x402 vs MPP](/comparison)** — the honest three-way breakdown
- **[See the six schemes](/guide/which-scheme)** — match each scheme to a use case
- **[Migrating from x402](/guide/upgrade-x402)** — if you're also running x402

If you're already on MPP and want to pilot s402 alongside it, [file an issue](https://github.com/s402-protocol/core/issues) — we'll help you wire up the coexistence pattern.
