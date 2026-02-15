# s402 — Agent Manual

## What is this?

`s402` is the Sui-native HTTP 402 payment protocol. It defines chain-agnostic types, HTTP encoding/decoding, and error handling. Optional x402 compat layer available via `s402/compat`. **Zero runtime dependencies.**

## Architecture

```
src/
  index.ts        — Barrel export (public API)
  types.ts        — All protocol types, interfaces, constants
  scheme.ts       — Client/Server/Facilitator scheme interfaces
  client.ts       — s402Client class (scheme registry + payment builder)
  server.ts       — s402ResourceServer class (requirements builder)
  facilitator.ts  — s402Facilitator class (verify + settle dispatch)
  http.ts         — Base64 encode/decode for HTTP headers + canonical validators
  compat.ts       — Optional x402 migration aid (opt-in, not ambient)
  errors.ts       — Typed error codes with recovery hints
```

## Key rules

- **Zero runtime deps.** This package must never add runtime dependencies. Chain-specific code belongs in `@sweepay/sui`.
- **ESM only.** No CommonJS.
- **Types are the product.** Most consumers import types only. Keep the type surface clean and well-documented.
- **x402 compat is opt-in.** The `s402/compat` subpath provides x402 V1/V2 normalization as a migration aid. The core protocol (`client.ts`, `http.ts`) has no x402 dependency.

## Commands

```bash
pnpm run build      # Build with tsdown
pnpm run test       # Run tests (207 across 9 suites)
pnpm run typecheck  # tsc --noEmit
```

## Sub-path exports

```typescript
import { ... } from 's402';          // Everything
import type { ... } from 's402/types';  // Types + constants
import { ... } from 's402/http';     // HTTP encode/decode
import { ... } from 's402/compat';   // Optional x402 migration aid
import { ... } from 's402/errors';   // Error types
```

## Design Decisions

### The Five Irreducible Payment Primitives

s402 defines exactly five payment schemes. Each has a **unique on-chain lifecycle** that cannot be reduced to any other:

| Scheme | On-chain object | Lifecycle | Why irreducible |
|--------|----------------|-----------|-----------------|
| `exact` | None (atomic transfer) | pay → done | Base case. No persistent state. |
| `prepaid` | `PrepaidBalance` shared object | deposit → claim → claim → withdraw | Deposit-then-claim pattern. Provider-initiated claims invert the flow. |
| `stream` | `Stream` shared object | open → tick → tick → close | Time-based. On-chain clock drives payments autonomously. |
| `escrow` | `Escrow` shared object | lock → condition → release/refund | Conditional. Money locked until delivery confirmed or deadline passes. |
| `unlock` | Encryption receipt + encrypted blob | pay → receipt → decrypt (two-stage) | Entangled with encryption key servers. Decryption is atomic with payment. |

**Why not six?** Auction (agent-to-agent bidding) was considered. Auction decomposes into two phases: price **discovery** (coordination problem) and **settlement** (one of the five existing schemes). The settlement of an auction is just `exact` (or `prepaid`, or `stream`) at the discovered price. Discovery is not a payment primitive — it's a coordination service.

**Why not four?** Every scheme was tested for reducibility. Escrow cannot be expressed as "exact now + refund later" (the atomic lock is the point). Unlock cannot be expressed as escrow (encryption key server integration is entangled with payment). Stream cannot be expressed as repeated exact (on-chain clock autonomy is the point).

### Auction via the `extensions` Field

The `extensions` field on `s402PaymentRequirements` is the forward-compatibility escape hatch. Auction (and any future pattern that doesn't need its own on-chain object type) uses it:

```typescript
// Auction signals via extensions — settlement uses exact scheme
{
  s402Version: '1',
  accepts: ['exact'],
  amount: '1000000',           // minimum bid
  extensions: {
    auction: {
      type: 'sealed-bid',      // or 'english', 'dutch', 'vickrey'
      deadline: 1708000000000, // bidding closes at this timestamp
      minIncrement: '100000',  // minimum bid increment
    }
  }
}
```

An auction-aware agent reads `extensions.auction` and enters bidding mode. A standard agent ignores `extensions` and pays the minimum via `exact`. Both work.

**Promotion path:** If auction usage explodes, it can be promoted to a full sixth scheme in s402 v2 with its own `s402AuctionPayload` type and `Auction` on-chain object. The `extensions` field is the proving ground.

### Three-Actor Scheme Architecture

The plugin system splits into three interfaces, one per payment actor:

```
s402ClientScheme       → requirements → signed payload    (1 method)
s402ServerScheme       → route config → requirements      (1 method)
s402FacilitatorScheme  → payload → verify + settle        (2 methods)
```

**Why three?** This mirrors the natural factoring of payment protocols (SWIFT: originator/correspondent/beneficiary; cards: cardholder/acquirer/issuer). The 402 flow is: server states price → client pays → facilitator verifies and settles. Three actors, three interfaces.

**Why verify + settle are separate on FacilitatorScheme:** Verify is a free dry-run simulation. Settle costs gas. Separating them lets you verify cheaply before committing gas. The `s402Facilitator.process()` method orchestrates verify→settle with expiration guards between them.

**Extensibility:** Adding a new scheme requires implementing the three interfaces and calling `.register()`. Zero changes to existing code. No switch statements, no if/else chains — the two-level `Map<network, Map<scheme, impl>>` dispatches via lookup.

**Watch item:** `s402RouteConfig` in `scheme.ts` accumulates optional config blocks for each scheme. At 5 schemes this is clean. At 10+ it could get unwieldy. Mitigation: each ServerScheme implementation only reads its own fields (TypeScript structural typing), and scheme-specific config types can extend the base without breaking it.

### Trust Boundary Model

Three independent validation boundaries, each validates without trusting the previous:

| Boundary | Location | Defense |
|----------|----------|---------|
| Wire decode | `http.ts` `decodePaymentRequired()` | Base64 → JSON → shape validation → allowlist key stripping |
| Client intake | `client.ts` `createPayment()` | Accepts typed `s402PaymentRequirements` only. For x402 input, caller must use `normalizeRequirements()` from `s402/compat` first. |
| Facilitator process | `facilitator.ts` `process()` | Type defense on expiresAt → expiration guard → verify → latency guard → settle |

The canonical validators (`validateRequirementsShape`, `pickRequirementsFields`) live in `http.ts`. The compat layer imports from `http.ts` — no duplicated validation code.

### Error Design: Machines First

Every `s402Error` carries `{ code, retryable, suggestedAction }`. This is designed for autonomous agents, not human developers. An agent's error handler branches on `retryable` (boolean) and reads `suggestedAction` (string) to decide next steps — no message parsing, no regex on error strings.
