---
description: Core TypeScript type definitions for the s402 protocol — payment requirements, scheme types, payloads, and settlement responses.
---

# Types

Core type definitions for the s402 protocol. All types are importable from the main package or the `s402/types` sub-path.

```typescript
import type { s402PaymentRequirements, s402Scheme } from 's402';
// or
import type { s402PaymentRequirements } from 's402/types';
```

## Protocol Constants

### `S402_VERSION`

```typescript
const S402_VERSION = '1' as const;
```

Current protocol version. Always `"1"`. Required in every requirements object. Optional in payloads (x402 payloads omit it).

### `S402_HEADERS`

```typescript
const S402_HEADERS = {
  PAYMENT_REQUIRED: 'payment-required',   // 402 response → client
  PAYMENT: 'x-payment',                   // client → server
  PAYMENT_RESPONSE: 'payment-response',   // server → client (200 response)
  STREAM_ID: 'x-stream-id',              // client → server (stream phase 2)
} as const;
```

HTTP header names used by s402. All lowercase per HTTP/2 spec (RFC 9113 §8.2.1). The `Headers` API normalizes casing for HTTP/1.1, so lowercase works everywhere.

## Scheme Types

### `s402Scheme`

```typescript
type s402Scheme = 'exact' | 'upto' | 'prepaid' | 'stream' | 'escrow' | 'unlock';
```

The six payment schemes.

### `s402SettlementMode`

```typescript
type s402SettlementMode = 'facilitator' | 'direct';
```

How a payment gets settled. `'facilitator'` routes through a third-party settlement service. `'direct'` means the client builds, signs, and broadcasts the transaction itself.

## Payment Requirements

### `s402PaymentRequired`

The 402 **document** — an x402 V2 `PaymentRequired` envelope, which is what
`payment-required` carries on every route (ADR-016). There is no s402-native flat
shape and no option to select one.

```typescript
interface s402PaymentRequired {
  x402Version: 2;
  resource: s402ResourceInfo;         // what is being paid for; required
  accepts: s402PaymentRequirements[]; // one entry per offered scheme
  error?: string;                     // human-readable, surfaced by x402 clients
  extensions?: Record<string, unknown>;
  mandate?: s402MandateRequirements;  // envelope-level; rides in extensions.s402
}
```

`exact` is listed **first whenever it is offered** — an x402 client pays the
first entry it has a handler for.

### `s402ResourceInfo`

x402 V2's `ResourceInfo`, verbatim. `url` is mandatory on emission; the optional
metadata is bounded the way upstream bounds it (`serviceName` 1–32 printable
ASCII, at most five `tags` of the same shape, `iconUrl` at most 2048 characters).

```typescript
interface s402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}
```

### `s402PaymentRequirements`

ONE entry of the 402's `accepts[]` — an offer of a single scheme. On the wire
this is an x402 V2 `PaymentRequirements`; everything below that x402 does not
name travels inside that entry's `extra` and is lifted back to the top level
here on decode.

**Architecture Invariant:** there is no `accepts` on this type. A requirement
describes one scheme. Offering several is what the envelope's `accepts[]` array
is for.

```typescript
interface s402PaymentRequirements {
  // ── x402 V2's own fields ──
  scheme: s402SchemeName;       // one scheme, not a list
  network: string;              // CAIP-2, e.g., "sui:mainnet"
  asset: string;                // e.g., "0x2::sui::SUI"
  amount: string;               // base units (MIST)
  payTo: string;                // recipient address
  maxTimeoutSeconds?: number;   // positive; the encoder supplies 60 when omitted

  // ── s402's own fields — carried inside this entry's `extra` on the wire ──
  facilitatorUrl?: string;
  mandate?: s402MandateRequirements;
  protocolFeeBps?: number;      // 0–10000
  protocolFeeAddress?: string;
  receiptRequired?: boolean;
  settlementMode?: s402SettlementMode;
  expiresAt?: number;           // Unix timestamp ms

  // ── Scheme-specific extras ──
  upto?: s402UptoExtra;
  stream?: s402StreamExtra;
  escrow?: s402EscrowExtra;
  unlock?: s402UnlockExtra;
  prepaid?: s402PrepaidExtra;

  settlementOverrides?: s402SettlementOverrides;

  extensions?: Record<string, unknown>;
}
```

#### Scheme Extras

**`s402UptoExtra`**

| Field | Type | Description |
|-------|------|-------------|
| `maxAmount` | `string` | Maximum authorized amount in base units |
| `settlementDeadlineMs` | `string` | Deadline for settlement (ms since epoch) |
| `estimatedAmount?` | `string` | Server's estimated cost (advisory) |
| `usageReportUrl?` | `string` | URL for usage/metering data |

**`s402SettlementOverrides`**

| Field | Type | Description |
|-------|------|-------------|
| `actualAmount` | `string` | Actual amount to settle (must be ≤ maxAmount) |

**`s402StreamExtra`**

| Field | Type | Description |
|-------|------|-------------|
| `ratePerSecond` | `string` | Rate in base units per second |
| `budgetCap` | `string` | Maximum total spend |
| `minDeposit` | `string` | Minimum initial deposit |
| `streamSetupUrl?` | `string` | URL for stream status checks |

**`s402EscrowExtra`**

| Field | Type | Description |
|-------|------|-------------|
| `seller` | `string` | Seller/payee address |
| `arbiter?` | `string` | Arbiter address for disputes |
| `deadlineMs` | `string` | Escrow deadline (ms since epoch) |

**`s402UnlockExtra`**

| Field | Type | Description |
|-------|------|-------------|
| `encryptionId` | `string` | Encryption key identifier for key servers |
| `encryptedContentId` | `string` | Content identifier for encrypted blob (e.g., Walrus blob ID, IPFS CID) |
| `encryptionServiceId` | `string` | Identifier for encryption service/module (e.g., Sui package ID) |

**`s402PrepaidExtra`**

| Field | Type | Description |
|-------|------|-------------|
| `ratePerCall` | `string` | Max base units per API call |
| `maxCalls?` | `string` | Max calls cap (omit for unlimited) |
| `minDeposit` | `string` | Minimum deposit amount |
| `withdrawalDelayMs` | `string` | Withdrawal delay (min 60s, max 7d) |
| `providerPubkey?` | `string` | Provider's Ed25519 public key (hex). Enables v0.2 signed receipt mode. |
| `disputeWindowMs?` | `string` | Dispute window in ms (60s–24h). Only relevant with `providerPubkey`. |

## Payment Payloads

Sent by the client via header transport (`x-payment` header) or body transport (`Content-Type: application/s402+json`). Contains the signed transaction.

### `s402PaymentPayloadBase`

```typescript
interface s402PaymentPayloadBase {
  s402Version: '1';
  scheme: s402Scheme;
  /**
   * Which `accepts[]` entry this pays. Optional; `s402Client` fills it in. A
   * 402 may offer the same scheme on several networks at different prices, and
   * the scheme name alone cannot say which one was paid.
   */
  network?: string;
}
```

### Scheme-specific Payloads

All payloads contain a `payload` object with `transaction` (base64 signed PTB) and `signature` (base64). Some schemes add extra fields:

| Payload Type | Extra Fields | Notes |
|-------------|-------------|-------|
| `s402ExactPayload` | — | One-shot transfer |
| `s402UptoPayload` | `maxAmount`, `settlementCeiling?` | Variable-amount deposit |
| `s402StreamPayload` | — | Stream creation PTB |
| `s402EscrowPayload` | — | Escrow creation PTB |
| `s402UnlockPayload` | `encryptionId` | Two-stage: TX1 escrow, TX2 seal_approve |
| `s402PrepaidPayload` | `ratePerCall`, `maxCalls?` | Deposit into PrepaidBalance |

### `s402PaymentPayload`

```typescript
type s402PaymentPayload =
  | s402ExactPayload
  | s402UptoPayload
  | s402PrepaidPayload
  | s402StreamPayload
  | s402EscrowPayload
  | s402UnlockPayload;
```

Discriminated union — switch on the `scheme` field.

## Responses

### `s402SettleResponse`

```typescript
interface s402SettleResponse {
  success: boolean;
  txDigest?: string;          // Sui transaction digest
  receiptId?: string;         // on-chain receipt NFT ID
  finalityMs?: number;        // time to finality
  actualAmount?: string;      // actual amount settled (upto scheme)
  depositId?: string;         // UptoDeposit object ID (upto scheme)
  streamId?: string;          // stream scheme
  escrowId?: string;          // escrow scheme
  balanceId?: string;         // prepaid scheme
  error?: string;
  errorCode?: s402ErrorCodeType;
}
```

### `s402VerifyResponse`

```typescript
interface s402VerifyResponse {
  valid: boolean;
  invalidReason?: string;
  payerAddress?: string;      // recovered from signature
}
```

## Discovery

### `s402Discovery`

Served at `/.well-known/s402.json`. Lets clients discover server capabilities before making any requests.

```typescript
interface s402Discovery {
  s402Version: '1';
  schemes: s402Scheme[];
  networks: string[];
  assets: string[];
  facilitatorUrl?: string;
  directSettlement: boolean;
  mandateSupport: boolean;
  protocolFeeBps: number;
  protocolFeeAddress?: string;
}
```

## Mandate Types

### `s402MandateRequirements`

Included in payment requirements when the server needs agent spending authorization.

```typescript
interface s402MandateRequirements {
  required: boolean;
  minPerTx?: string;
  coinType?: string;
}
```

### `s402Mandate`

On-chain mandate reference included in payment payloads.

```typescript
interface s402Mandate {
  mandateId: string;
  delegator: string;     // human
  delegate: string;      // agent
  maxPerTx: string;
  maxTotal: string;
  totalSpent: string;
  expiresAtMs: string;
}
```
