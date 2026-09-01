---
description: Bidirectional interop between s402 and x402. An x402 client can pay an s402 server using the Exact scheme with zero code changes.
---

# x402 Compatibility

Bidirectional interop between s402 and x402. An x402 client can talk to an s402 server (via the "exact" scheme), and an s402 client can talk to an x402 server (via automatic normalization).

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

x402 (by Coinbase) established HTTP 402 payments. s402 extends the protocol for Sui-native capabilities — but maintains wire compatibility so the ecosystem isn't fragmented. An x402 client that only knows "exact" payments can talk to an s402 server without any changes.

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
