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

Current protocol version. Always `"1"`. Present in every requirements and payload object.

### `S402_HEADERS`

```typescript
const S402_HEADERS = {
  PAYMENT_REQUIRED: 'payment-required',   // 402 response → client
  PAYMENT: 'X-PAYMENT',                   // client → server
  PAYMENT_RESPONSE: 'payment-response',   // server → client (200 response)
  STREAM_ID: 'X-STREAM-ID',              // client → server (stream phase 2)
} as const;
```

HTTP header names used by s402. Same names as x402 for wire compatibility.

## Scheme Types

### `s402Scheme`

```typescript
type s402Scheme = 'exact' | 'stream' | 'escrow' | 'seal' | 'prepaid';
```

The five payment schemes.

### `s402SettlementMode`

```typescript
type s402SettlementMode = 'facilitator' | 'direct';
```

How a payment gets settled. `'facilitator'` routes through a third-party settlement service. `'direct'` means the client builds, signs, and broadcasts the transaction itself.

## Payment Requirements

### `s402PaymentRequirements`

Sent by the server in the 402 response. Tells the client how to pay.

```typescript
interface s402PaymentRequirements {
  // ── Core fields (x402-compatible) ──
  s402Version: '1';
  accepts: s402Scheme[];
  network: string;              // e.g., "sui:mainnet"
  asset: string;                // e.g., "0x2::sui::SUI"
  amount: string;               // base units (MIST)
  payTo: string;                // recipient address
  facilitatorUrl?: string;

  // ── s402 extensions ──
  mandate?: s402MandateRequirements;
  protocolFeeBps?: number;      // 0–10000
  protocolFeeAddress?: string;
  receiptRequired?: boolean;
  settlementMode?: s402SettlementMode;
  expiresAt?: number;           // Unix timestamp ms

  // ── Scheme-specific extras ──
  stream?: s402StreamExtra;
  escrow?: s402EscrowExtra;
  seal?: s402SealExtra;
  prepaid?: s402PrepaidExtra;

  extra?: Record<string, unknown>;
}
```

#### Scheme Extras

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

**`s402SealExtra`**

| Field | Type | Description |
|-------|------|-------------|
| `encryptionId` | `string` | SEAL encryption ID |
| `walrusBlobId` | `string` | Walrus blob containing encrypted content |
| `sealPackageId` | `string` | SEAL package ID on Sui |

**`s402PrepaidExtra`**

| Field | Type | Description |
|-------|------|-------------|
| `ratePerCall` | `string` | Max base units per API call |
| `maxCalls?` | `string` | Max calls cap (omit for unlimited) |
| `minDeposit` | `string` | Minimum deposit amount |
| `withdrawalDelayMs` | `string` | Withdrawal delay (min 60s, max 7d) |

## Payment Payloads

Sent by the client in the `X-PAYMENT` header. Contains the signed transaction.

### `s402PaymentPayloadBase`

```typescript
interface s402PaymentPayloadBase {
  s402Version: '1';
  scheme: s402Scheme;
}
```

### Scheme-specific Payloads

All payloads contain a `payload` object with `transaction` (base64 signed PTB) and `signature` (base64). Some schemes add extra fields:

| Payload Type | Extra Fields | Notes |
|-------------|-------------|-------|
| `s402ExactPayload` | — | One-shot transfer |
| `s402StreamPayload` | — | Stream creation PTB |
| `s402EscrowPayload` | — | Escrow creation PTB |
| `s402SealPayload` | `encryptionId` | Two-stage: TX1 escrow, TX2 seal_approve |
| `s402PrepaidPayload` | `ratePerCall`, `maxCalls?` | Deposit into PrepaidBalance |

### `s402PaymentPayload`

```typescript
type s402PaymentPayload =
  | s402ExactPayload
  | s402StreamPayload
  | s402EscrowPayload
  | s402SealPayload
  | s402PrepaidPayload;
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
