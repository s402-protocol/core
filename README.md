# s402

**Sui-native HTTP 402 protocol.** Interoperable with [x402](https://github.com/coinbase/x402) via the `exact` scheme and compat layer. Architecturally superior via Sui's atomic Programmable Transaction Blocks (PTBs).

```
npm install s402
```

> **ESM-only.** This package ships ES modules only (`"type": "module"`). Requires Node.js >= 18. CommonJS `require()` is not supported.

## Why s402?

HTTP 402 ("Payment Required") has been reserved since 1999 — waiting for a payment protocol that actually works. Coinbase's x402 proved the concept on EVM. s402 takes it further by leveraging what makes Sui different.

### s402 vs x402

| | x402 (Coinbase) | s402 |
|---|---|---|
| **Settlement** | Two-step: verify then settle (temporal gap) | Atomic: verify + settle in one PTB |
| **Finality** | 12+ second blocks (EVM L1) | ~400ms (Sui) |
| **Payment models** | Exact (one-shot) only | Exact, Prepaid, Escrow (v0.1) + Seal, Stream (v0.2) |
| **Micro-payments** | $7.00 gas per 1K calls (broken) | $0.014 gas per 1K calls (prepaid) |
| **Coin handling** | approve + transferFrom | Native `coinWithBalance` + `splitCoins` |
| **Agent auth** | None | AP2 mandate delegation |
| **Direct mode** | No | Yes (no facilitator needed) |
| **Receipts** | Off-chain | On-chain NFT proofs |
| **Compatibility** | n/a | x402 V1 wire-compat; V2 via compat layer |

**s402 is Sui-native by design.** These advantages come from Sui's object model, PTBs, and sub-second finality. They can't be replicated on EVM — and they don't need to be. x402 already handles EVM well. s402 handles Sui better.

## Architecture

```
s402          <-- You are here. Protocol spec. Zero runtime deps.
  |
  |-- Types         Payment requirements, payloads, responses
  |-- Schemes       Client/Server/Facilitator interfaces per scheme
  |-- HTTP          Encode/decode for HTTP headers (base64 JSON)
  |-- Compat        Bidirectional x402 conversion
  |-- Errors        Typed error codes with recovery hints
  |
@sweepay/sui        <-- Sui-specific implementations (PTB builders, signers)
@sweepay/sdk        <-- High-level DX (s402-fetch, payment gate)
```

`s402` is **chain-agnostic protocol plumbing**. It defines _what_ gets sent over HTTP. The Sui-specific _how_ lives in `@sweepay/sui`.

## Payment Schemes

### Exact (v0.1)

One-shot payment. Client builds a signed transfer PTB, facilitator verifies + broadcasts atomically.

```
Client                    Server                  Facilitator
  |--- GET /api/data ------->|                         |
  |<-- 402 + requirements ---|                         |
  |                          |                         |
  |  (build PTB, sign)       |                         |
  |--- GET + X-PAYMENT ----->|--- verify + settle ---->|
  |                          |<--- { success, tx } ----|
  |<-- 200 + data -----------|                         |
```

This is the x402-compatible baseline. An x402 client can talk to an s402 server using this scheme with zero modifications.

### Prepaid (v0.1)

Deposit-based access. Agent deposits funds into an on-chain Balance shared object targeted at a specific provider. API calls happen off-chain. Provider batch-claims accumulated usage. Move module enforces rate caps — no trust required.

```
Phase 1 (deposit — one on-chain TX):
  Agent deposits 10 SUI → Balance shared object created
  Gas: ~$0.007

Phase 2 (usage — off-chain, zero gas):
  Agent makes 1,000 API calls
  Server tracks usage, no on-chain TX per call

Phase 3 (claim — one on-chain TX):
  Provider claims accumulated $1.00 from Balance
  Gas: ~$0.007
  ─────────────────────────────────────────────────────
  Total gas: $0.014 for 1,000 calls
  Per-call effective gas: $0.000014
```

This is the agent-native payment pattern. Without prepaid, per-call settlement costs $7.00 in gas for $1.00 of API usage (economically impossible). With prepaid, it costs $0.014 (economically trivial).

Use cases: AI agent API budgets, high-frequency API access, compute metering.

### Escrow (v0.1)

Time-locked vault with arbiter dispute resolution. Full state machine: `ACTIVE -> DISPUTED -> RELEASED / REFUNDED`.

- Buyer deposits funds, locked until release or deadline
- Buyer confirms delivery -> funds release to seller (receipt minted)
- Deadline passes -> permissionless refund (anyone can trigger)
- Either party disputes -> arbiter resolves

Use cases: digital goods delivery, freelance payments, trustless commerce.

### Seal (v0.2)

Pay-to-decrypt via [Sui SEAL](https://docs.sui.io/concepts/cryptography/seal). Escrow + encrypted content delivery. The buyer pays into escrow; on release, the `EscrowReceipt` unlocks SEAL-encrypted content stored on [Walrus](https://docs.walrus.site).

This scheme depends on SEAL key server infrastructure and is under active development.

### Stream (v0.2)

Per-second micropayments via on-chain `StreamingMeter`. Client deposits funds into a shared object; recipient claims accrued tokens over time.

```
Phase 1 (402 exchange):
  Client builds stream creation PTB --> facilitator broadcasts
  Result: StreamingMeter shared object on-chain

Phase 2 (ongoing access):
  Client includes X-STREAM-ID header --> server checks on-chain balance
  Server grants access as long as stream has funds
```

Use cases: AI inference sessions, video streaming, real-time data feeds.

## Quick Start

### Types only (most common)

```typescript
import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
} from 's402';
```

### HTTP header encoding

```typescript
import {
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  detectProtocol,
} from 's402';

// Server: build 402 response
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact', 'stream'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000', // 0.001 SUI in MIST
  payTo: '0xrecipient...',
};

response.status = 402;
response.headers.set('payment-required', encodePaymentRequired(requirements));

// Client: read 402 response
const header = response.headers.get('payment-required')!;
const reqs = decodePaymentRequired(header);
console.log(reqs.accepts); // ['exact', 'stream']
console.log(reqs.amount);  // '1000000'
```

### x402 interop

```typescript
import {
  normalizeRequirements,
  decodePaymentRequired,
  isS402,
  isX402,
  toX402Requirements,
  fromX402Requirements,
} from 's402';

// Decode and auto-normalize incoming requirements
// Works whether the server sent s402 or x402 (V1 or V2) format
const decoded = decodePaymentRequired(header);
// Or normalize raw JSON from any source:
// const requirements = normalizeRequirements(rawJsonObject);

// Convert s402 -> x402 V1 for legacy clients
const x402Reqs = toX402Requirements(requirements);
```

### Error handling

```typescript
import { s402Error, s402ErrorCode } from 's402';

try {
  await facilitator.settle(payload, requirements);
} catch (e) {
  if (e instanceof s402Error) {
    console.log(e.code);            // 'INSUFFICIENT_BALANCE'
    console.log(e.retryable);       // false
    console.log(e.suggestedAction); // 'Top up wallet balance...'
  }
}
```

### Scheme registry (client)

```typescript
import { s402Client } from 's402';

const client = new s402Client();

// Register scheme implementations (from @sweepay/sui or your own)
client.register('sui:mainnet', exactScheme);
client.register('sui:mainnet', streamScheme);

// Auto-selects best scheme from server's accepts array
const payload = await client.createPayment(requirements);
```

### Scheme registry (facilitator)

```typescript
import { s402Facilitator } from 's402';

const facilitator = new s402Facilitator();
facilitator.register('sui:mainnet', exactFacilitatorScheme);

// Atomic verify + settle
const result = await facilitator.process(payload, requirements);
if (result.success) {
  console.log(result.txDigest); // Sui transaction digest
}
```

## Sub-path Exports

```typescript
import { ... } from 's402';         // Everything
import type { ... } from 's402/types';   // Types + constants only
import { ... } from 's402/http';     // HTTP encode/decode
import { ... } from 's402/compat';   // x402 interop
import { ... } from 's402/errors';   // Error types
```

## Implementing a Scheme

s402 is designed as a plugin system. Each payment scheme implements three interfaces:

```typescript
import type {
  s402ClientScheme,       // Client: build payment payload
  s402ServerScheme,       // Server: build payment requirements
  s402FacilitatorScheme,  // Facilitator: verify + settle
  s402DirectScheme,       // Optional: settle without facilitator
} from 's402';
```

See `@sweepay/sui` for the reference Sui implementation of all four schemes.

## Wire Format

s402 uses the same HTTP headers as x402 V1:

| Header | Direction | Content |
|--------|-----------|---------|
| `payment-required` | Server -> Client | Base64-encoded `s402PaymentRequirements` JSON |
| `X-PAYMENT` | Client -> Server | Base64-encoded `s402PaymentPayload` JSON |
| `payment-response` | Server -> Client | Base64-encoded `s402SettleResponse` JSON |

> **Note:** x402 V2 renamed the client payment header to `PAYMENT-SIGNATURE`. s402 uses `X-PAYMENT` (matching x402 V1). x402 V2 servers accept both headers, so s402 clients work with both versions. If your server needs to accept x402 V2 clients, also check `PAYMENT-SIGNATURE`.

The presence of `s402Version` in the decoded JSON distinguishes s402 from x402. Clients and servers can auto-detect the protocol using `detectProtocol()`.

## Discovery

Servers can advertise s402 support at `/.well-known/s402.json`:

```json
{
  "s402Version": "1",
  "schemes": ["exact", "stream", "escrow"],
  "networks": ["sui:mainnet"],
  "assets": ["0x2::sui::SUI", "0xdba...::usdc::USDC"],
  "directSettlement": true,
  "mandateSupport": true,
  "protocolFeeBps": 50
}
```

## Security

**HTTPS is required.** s402 payment data (requirements, payloads, settlement responses) travels in HTTP headers as base64-encoded JSON. Without TLS, this data is visible to any network observer. All production deployments MUST use HTTPS.

**Requirements expiration.** Servers SHOULD set `expiresAt` on payment requirements to prevent replay of stale 402 responses. The facilitator rejects expired requirements before processing.

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0xrecipient...',
  expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute window
};
```

## Design Principles

1. **Protocol-agnostic core, Sui-native reference.** `s402` defines chain-agnostic protocol types and HTTP encoding. The reference implementation (`@sweepay/sui`) exploits Sui's unique properties — PTBs, object model, sub-second finality. Other chains can implement s402 schemes using their own primitives.

2. **Wire-compatible with x402.** The `exact` scheme uses the same headers and encoding as x402 V1, and the compat layer handles both V1 (`maxAmountRequired`) and V2 (`amount`) field names. An x402 facilitator can settle s402 exact payments and vice versa.

3. **Scheme-specific verification.** Each scheme has its own verify logic. Exact verify (signature recovery + dry-run) is fundamentally different from stream verify (deposit check + rate validation). The facilitator dispatches — it doesn't share logic.

4. **Zero runtime dependencies.** `s402` is pure TypeScript protocol definitions. No Sui SDK, no crypto libraries, no HTTP framework. Chain-specific code belongs in adapters.

5. **Errors tell you what to do.** Every error code includes `retryable` (can the client try again?) and `suggestedAction` (what should it do?). Agents can self-recover.

## License

MIT
