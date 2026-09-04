---
description: Bidirectional interop between s402 and x402. An unmodified x402 client can pay an s402 gate that sets the x402 option; s402 reads x402 payments on every gate.
---

# x402 Compatibility

Bidirectional interop between s402 and x402. An unmodified x402 client can pay an `s402Gate` that sets the `x402` option (via the "exact" scheme), and an s402 client can talk to an x402 server (via automatic normalization).

**Audited against:** x402 `x402-foundation/x402` @ `2cc7e9a6880c08433b692666032862bcbea51187` (2026-09-04), `@x402/core` / `@x402/fetch` 2.25.0. The pin is exported as `X402_UPSTREAM_PIN` and asserted by `test/compat-x402-dialect.test.ts`; the round trip is exercised by `test/interop-x402-client.test.ts` against the real upstream client. Development moved from `coinbase/x402` (frozen at `dd927a26`) to the foundation repo in 2026-04 — check drift against the foundation.

```typescript
import {
  fromX402Requirements,
  toX402Requirements,
  normalizeRequirements,
  isS402,
  isX402,
} from 's402/compat/x402';
```

## Why This Exists

x402 (by Coinbase, now the x402 Foundation) established HTTP 402 payments. s402 extends the protocol for Sui-native capabilities — but maintains wire compatibility so the ecosystem isn't fragmented. An x402 client that only knows "exact" payments can pay an s402 gate without any client changes; the gate needs the `x402` option to emit a 402 that client can read (see [Serving x402 clients](#serving-x402-clients-from-a-gate)).

## Auto-Detection

### `normalizeRequirements(obj)`

The recommended entry point. Auto-detects the protocol format and normalizes to s402.

```typescript
function normalizeRequirements(
  obj: Record<string, unknown>,
): s402PaymentRequirements;
```

Handles three formats:
1. **s402** — validates and passes through
2. **x402 V1** — flat object with `x402Version`, `scheme`, `maxAmountRequired`
3. **x402 V2** — envelope with `accepts` array

**Example:**

```typescript
import { decodePaymentRequired } from 's402/http';
import { normalizeRequirements } from 's402/compat/x402';

// Option A: decode s402 headers directly (validates s402Version)
const requirements = decodePaymentRequired(header);

// Option B: normalize any format (s402, x402 V1, x402 V2)
const requirements = normalizeRequirements(decodedJson);
// Always returns s402PaymentRequirements
```

::: warning
Do not use `JSON.parse(atob(...))` for decoding. The protocol uses Unicode-safe base64 (UTF-8 → base64), so plain `atob()` will break on non-ASCII content in the `extensions` field. Use `decodePaymentRequired()` or `normalizeRequirements()` instead.
:::

### `isS402(obj)` / `isX402(obj)`

Quick checks for protocol format.

```typescript
function isS402(obj: Record<string, unknown>): boolean;  // has s402Version
function isX402(obj: Record<string, unknown>): boolean;  // has x402Version, no s402Version
```

### `isX402Envelope(obj)`

Detect x402 V2 envelope format (has `x402Version` + `accepts` array).

```typescript
function isX402Envelope(obj: Record<string, unknown>): boolean;
```

## x402 → s402

### `fromX402Requirements(x402)`

Convert x402 requirements to s402 format.

```typescript
function fromX402Requirements(
  x402: x402PaymentRequirements,
): s402PaymentRequirements;
```

- Maps `scheme` → `accepts: ['exact']`
- Handles both V1 (`maxAmountRequired`) and V2 (`amount`) wire formats
- Preserves `extensions` field for forward compatibility

### `fromX402Payload(x402)`

Convert an x402 payment payload to s402 format.

```typescript
function fromX402Payload(x402: x402PaymentPayload): s402ExactPayload;
```

### `fromX402Envelope(envelope)`

Convert an x402 V2 envelope to s402 format. Picks the first requirement from the `accepts` array.

```typescript
function fromX402Envelope(
  envelope: x402PaymentRequiredEnvelope,
): s402PaymentRequirements;
```

## Reading an x402 server's settlement result

### `fromX402SettleResponseHeaders(headers)` · `fromX402SettleResponse(response)`

Classify what an x402 server said about settlement. **Read this section before writing any
retry.**

```typescript
function fromX402SettleResponseHeaders(headers: Headers): x402SettlementOutcome | null;
function fromX402SettleResponse(response: x402SettleResponse): x402SettlementOutcome;

type x402SettlementOutcome =
  | { state: 'settled'; retryable: false; transaction: string; /* ... */ }
  | { state: 'pending';  retryable: false; transaction: string; reason: 'settlement_pending' }
  | { state: 'failed';   retryable: true;  transaction: string; reason?: string };
```

x402 V2 has three settlement outcomes, not two. `settlement_pending` means **the transaction
was broadcast and the wait for its confirmation failed** — the payment may well have landed.
On the wire it arrives as `success: false`, which is the trap: a client that reads the boolean
and retries builds a second payment for a transaction that already went through.

`settled` and `pending` are both `retryable: false`, and that is the same answer for different
reasons — one has been paid, the other may have been. Reconcile the `transaction` hash on chain
before doing anything else.

Reads `PAYMENT-RESPONSE` (V2) then `X-PAYMENT-RESPONSE` (V1), case-insensitively. Returns
`null` when neither is present, so you can fall back to the native s402 decode path.

::: warning s402's own settle response has two states, not three
This helper classifies what an **x402 server** sent you. s402's own `payment-response` body is
still `{ success: boolean, ... }`, and there is deliberately no function mapping a `pending`
outcome back into it — that mapping would have to collapse `pending` onto `success: false`,
which is the bug this type exists to prevent. See ADR-013.
:::

## Reading the `exact` payment flow

### `x402PaymentFlowOf(requirement)`

```typescript
function x402PaymentFlowOf(req: { extra?: Record<string, unknown> }): 'authorization' | 'upfront';
```

`exact` runs under one of two resource-server orderings. `authorization` (verify → resource →
settle) is the default and what an absent `extra.paymentFlow` means. `upfront` (settle →
resource → respond) is for resources needing on-chain finality before execution; `/verify` is
not invoked and `/settle` both validates and commits.

The payload you build is byte-identical either way. What changes is what a retry means: under
`upfront`, a second 402 does **not** imply you have not been charged. An unrecognized flow
throws rather than defaulting, because the guess a client wants least is the optimistic one.

## s402 → x402

### `toX402Requirements(s402)`

Convert s402 requirements to x402 V1 wire format. Strips s402-only fields (mandate, stream, escrow, unlock, prepaid extensions).

```typescript
function toX402Requirements(
  s402: s402PaymentRequirements,
  overrides?: {
    maxTimeoutSeconds?: number;  // default: 60
    resource?: string;           // default: ''
    description?: string;        // default: ''
  },
): x402PaymentRequirements;
```

Includes both `maxAmountRequired` (V1) and `amount` (V2) for maximum compatibility. Defaults `maxTimeoutSeconds` to 60 (required by x402). Use the optional `overrides` parameter to customize V1 metadata fields.

### `toX402Payload(s402)`

Convert s402 payload to x402 format. Only works for "exact" scheme — other schemes have no x402 equivalent.

```typescript
function toX402Payload(
  s402: s402PaymentPayload,
): x402PaymentPayload | null;
```

Returns `null` if the scheme is not "exact".

### `toX402SettleResponse(s402, network)` · `encodeX402SettleResponse(response)`

Translate an s402 settlement result into the x402 `SettleResponse` an x402 client's `PAYMENT-RESPONSE` decoder reads, and encode it for the header.

```typescript
function toX402SettleResponse(
  s402: s402SettleResponse,
  network: string,          // x402 requires it; s402's settle response does not carry it
): x402SettleResponse;
```

| s402 | x402 |
|---|---|
| `txDigest` | `transaction` (`""` when nothing was broadcast — x402 requires the field) |
| `errorCode` | `errorReason` |
| `error` | `errorMessage` |
| `actualAmount` | `amount` |

s402's own fields are kept alongside; x402 decoders ignore unknown keys. The reverse translation deliberately does not exist — see [ADR-013](../adr/013-x402-intake-compatibility.md).

### `x402PayloadDialect(headers)`

`'x402'` when a request's payment arrived under `PAYMENT-SIGNATURE` (x402 V2) or under `X-PAYMENT` carrying an `x402Version` (x402 V1); `null` for a native s402 payment or no payment. The gate uses this to answer the receipt in the dialect it was addressed in.

## Serving x402 clients from a gate

There is nothing to configure. s402's `payment-required` **is** an x402 V2 `PaymentRequired`
envelope on every route, so an unmodified `@x402/fetch` client completes the whole round trip:
it reads the 402, pays under `PAYMENT-SIGNATURE`, and decodes the receipt.

```typescript
import { s402Gate } from 's402';

const gate = s402Gate({
  server,
  requirements,   // one offer, or an array — one entry per scheme, `exact` first
  resource: { url: 'https://api.example.com/paid', description: 'Paid data', mimeType: 'application/json' },
});
```

`resource` is required because x402's V2 envelope requires it — it is a field, not an interop
switch. The `x402` option this page used to document is **gone**: it selected between two
grammars, and there is only one now ([ADR-016](../adr/016-s402-402-is-an-x402-envelope.md)).

Every s402 scheme is expressible. `prepaid`, `stream`, `escrow`, `unlock` and `upto` each get
their own `accepts[]` entry; an x402 client without a handler for one skips it, which is what
`accepts[]` is for. The encoder sorts `exact` to the front, because x402's client pays the first
entry it has a handler for and an `exact` entry listed third is one it walks past. s402's own per-requirement fields (`facilitatorUrl`, `expiresAt`, the fee
fields, the per-scheme extras) ride in that entry's `extra`, and `mandate` rides in
`extensions.s402` — so nothing is dropped to make the document readable.

Intake is unchanged and still unconditional: every gate accepts x402 payments
(`PAYMENT-SIGNATURE` V2, `X-PAYMENT` V1) and answers an x402-dialect payment with an
x402-dialect receipt ([ADR-013](../adr/013-x402-intake-compatibility.md)).

## Reading the retired flat shapes

Two 402 shapes are no longer emitted by anything and are still read on intake.

### `fromS402V1Requirements(v1, options?)`

Decodes s402's own pre-wire-v2 402 — `{ s402Version: '1', accepts: ['exact', 'prepaid'], network,
asset, amount, payTo, … }` — into the wire-v2 document. Every field except `accepts` described the
one offer the document made, so each expanded entry carries all of them; `accepts` becomes one
entry per scheme, with `exact` hoisted to the front. `mandate` moves to the envelope.

```typescript
import { fromS402V1Requirements } from 's402/compat/x402';

const required = fromS402V1Requirements(JSON.parse(atob(legacyHeader)), {
  resource: { url: 'https://api.example.com/paid' },   // v1 had none; pass the URL you fetched
});
```

### `normalizeRequirements(obj, now?)`

Takes any of them — wire v2 / x402 V2 envelope, x402 V1 flat, s402 v1 flat — and returns an
`s402PaymentRequired`. The V2 case is identity plus the `extra` projection, because that envelope
is the native shape.

### One thing every decode path adds rather than copies

When a document carries **no** `extensions.s402` — a plain x402 402, from a server that has never
heard of s402 — an offer with no `expiresAt` gets one derived from its `maxTimeoutSeconds`. Without
it, inbound x402 traffic bypasses every S1 stale-payment guard, because those guards skip an
undefined `expiresAt`.

This runs in `decodePaymentRequired`, `decodeRequirementsBody`, the MCP and A2A decoders and
`normalizeRequirements` alike — one helper, every entry point. `decodePaymentRequired(header, now)`
and `decodeRequirementsBody(body, now)` take an optional clock for testing and for reproducible
conformance vectors.

Two things it does not do: it never overwrites an expiry the peer stated, and it skips offers
naming a scheme s402 does not implement — an offer no s402 payment will be built for has nothing
for S1 to protect, and writing to it would clobber whatever that scheme means by the same key.

s402's own documents are never touched. Saying nothing about expiry is an answer, and it is ours.

### `x402AcceptedFromHeaders(headers)`

The requirement an x402 V2 payment says it is paying. x402 V2's `PaymentPayload` carries
`accepted` — the FULL `PaymentRequirements` the client chose, not just its scheme name — and on a
402 that offered several entries at several prices, that object is the only thing that says which
one the money is for. `s402Gate` uses it to settle against the offer the payer actually took, and
refuses when it matches none. Returns `null` for an x402 V1 payload, which has no `accepted`.

## x402 Types

Exported for consumers who need to work with x402 data directly:

```typescript
import type {
  x402PaymentRequirements,
  x402PaymentRequiredEnvelope,
  x402PaymentPayload,
} from 's402/compat/x402';
```

### `x402PaymentRequirements`

```typescript
interface x402PaymentRequirements {
  x402Version: number;
  scheme: string;
  network: string;
  asset: string;
  amount?: string;              // V2
  maxAmountRequired?: string;   // V1
  payTo: string;
  maxTimeoutSeconds?: number;
  resource?: string;            // V1 only
  description?: string;         // V1 only
  facilitatorUrl?: string;
  extensions?: Record<string, unknown>;
}
```

### `x402PaymentRequiredEnvelope`

```typescript
interface x402PaymentRequiredEnvelope {
  x402Version: number;
  accepts: x402PaymentRequirements[];
  resource?: { url?: string; mimeType?: string; description?: string };
  extensions?: Record<string, unknown>;
  error?: string;
}
```
