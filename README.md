# s402

[![CI](https://github.com/s402-protocol/core/actions/workflows/ci.yml/badge.svg)](https://github.com/s402-protocol/core/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/s402.svg)](https://www.npmjs.com/package/s402)

**Chain-agnostic HTTP 402 protocol.** Six payment schemes for AI agent commerce. Wire-compatible with x402 — audited and tested against x402 @ `2cc7e9a6` (`x402-foundation/x402`, 2026-09-04; `@x402/core` 2.25.0). Zero runtime dependencies. Includes a compat layer (`s402/compat`) for normalizing x402 input.

s402 is a chain-agnostic HTTP 402 wire format — types, HTTP encoding, scheme registry, and error handling for six payment schemes. The protocol layer contains no chain-specific logic (see [S7 invariant](./AGENTS.md)). The reference implementation on Sui uses Programmable Transaction Blocks to reduce 1,000 payments to just 2 on-chain transactions via the Prepaid scheme, cutting per-call effective gas from $0.007 to $0.000014 and making micropayments economically viable for AI agents for the first time.

```bash
npm install s402
pnpm add s402
bun add s402
deno add npm:s402
```

> **ESM-only.** This package ships ES modules only (`"type": "module"`). Requires Node.js >= 20. CommonJS `require()` is not supported.

## Governing Principle

> **We interop when possible. We superset when wise.**

s402 does not fight x402 or Stripe MPP head-on. s402 **absorbs** them as payment-in formats where their design choices are legitimate (exact, upto), and **supersets** them on primitives their business models cannot ship (prepaid with on-chain ceiling, streaming with rate enforcement, escrow with arbiter, Seal-encrypted unlock).

This is the Postgres-eats-MySQL move: the superset always eats the subset because adopters never lose what they had — they only gain. The asymmetry is in s402's favor because competitors' constraints forbid reciprocating. Stripe cannot accept s402 schemes without bypassing card-processing margin. x402's 2-scheme governance envelope cannot absorb s402's 5 without re-ratification.

See [ADR-005](./docs/adr/005-interop-superset-principle.md) for the full reasoning.

## Why s402?

HTTP 402 ("Payment Required") has been reserved since 1999 — waiting for a payment protocol that actually works. Coinbase's x402 proved the concept on EVM. s402 takes it further by leveraging what makes Sui different.

### s402 vs x402

| | x402 (Coinbase) | s402 |
|---|---|---|
| **Settlement** | Two-step: verify then settle (temporal gap) | Atomic: verify + settle in one PTB |
| **Finality** | 12+ second blocks (EVM L1) | ~400ms (Sui) |
| **Payment models** | Exact (one-shot) only | Six schemes: Exact, Prepaid, Escrow, Unlock, Stream, Upto |
| **Micro-payments** | ~$1.60 gas per 1K calls on Base (broken) | $0.014 gas per 1K calls (prepaid) |
| **Coin handling** | approve + transferFrom | Native `coinWithBalance` + `splitCoins` |
| **Agent auth** | None | AP2 mandate delegation |
| **Direct mode** | No | Yes (no facilitator needed) |
| **Receipts** | Off-chain | On-chain NFT proofs |
| **Compatibility** | n/a | Optional x402 compat layer (`s402/compat`) |

**s402 is Sui-native by design.** These advantages come from Sui's object model, PTBs, and sub-second finality. They can't be replicated on EVM — and they don't need to be. x402 already handles EVM well. s402 handles Sui better.

## Who This Is For

**Use s402 if** you are charging for an HTTP endpoint that AI agents call, and either you settle
on Sui, or you need a payment model x402 does not have — metered draw-down, streaming with rate
enforcement, escrow with an arbiter, or pay-to-decrypt. Also use it if you are implementing the
protocol in another language: the wire format is specified independently of this codebase and
ships with conformance vectors to check yourself against.

**Do not use s402 if** you are EVM-only and `exact` covers you — x402 is the better fit and we
say so. Also skip it if you want a payments *product*: s402 is a wire format and a set of types
with zero runtime dependencies. It does not move money, custody funds, or run a facilitator for
you. Fiat and card rails are out of scope and will stay that way.

## Which Scheme Should I Use?

| Your situation | Scheme | Gas per 1K calls | Latency |
|---|---|---|---|
| One-time API call, simplest path | **Exact** | $7.00 | ~400ms |
| High-frequency API (10+ calls) | **Prepaid** | $0.014 | ~0ms per call |
| Buyer needs dispute protection | **Escrow** | $7.00 | ~400ms |
| Selling encrypted content | **Unlock** | $7.00 | ~400ms |
| Real-time billing (per-second) | **Stream** | variable | ~400ms setup |

**Quick decision:** Use **Prepaid** for AI agents making repeated API calls. Use **Exact** for everything else (it's the x402-compatible default). See the [full guide](https://s402-protocol.org/guide/which-scheme) for details.

## Architecture

```
s402          <-- You are here. Protocol spec. Zero runtime deps.
  |
  |-- Types         Payment requirements, payloads, responses
  |-- Schemes       Client/Server/Facilitator interfaces per scheme
  |-- HTTP          Encode/decode for HTTP headers (base64 JSON)
  |-- Compat        Optional x402 migration aid
  |-- Errors        Typed error codes with recovery hints
  |
@sweefi/sui         <-- Sui adapter: 40 PTB builders + SuiPaymentAdapter + createS402Client
@sweefi/server      <-- Chain-agnostic HTTP: s402Gate middleware + wrapFetchWithS402
@sweefi/ui-core     <-- State machine + PaymentAdapter interface
@sweefi/vue         <-- Vue 3 plugin + useSweefiPayment() composable
@sweefi/react       <-- React context + useSweefiPayment() hook
```

`s402` is **chain-agnostic protocol plumbing**. It defines _what_ gets sent over HTTP. The Sui-specific _how_ lives in [`@sweefi/sui`](https://www.npmjs.com/package/@sweefi/sui).

## Payment Schemes

### Exact (v0.1)

One-shot payment. Client builds a signed transfer PTB, facilitator verifies + broadcasts atomically.

```
Client                    Server                  Facilitator
  |--- GET /api/data ------->|                         |
  |<-- 402 + requirements ---|                         |
  |                          |                         |
  |  (build PTB, sign)       |                         |
  |--- GET + x-payment ----->|--- verify + settle ---->|
  |                          |<--- { success, tx } ----|
  |<-- 200 + data -----------|                         |
```

This is the x402-compatible baseline. An **unmodified x402 client** (`@x402/fetch`, `x402Client`) gets paid content from an `s402Gate` with **zero client changes and zero server options** — s402's `payment-required` is an x402 V2 `PaymentRequired` envelope on every route, the gate accepts x402's `PAYMENT-SIGNATURE`, and it answers with a receipt x402's decoder reads. Proven in `typescript/test/interop-x402-client.test.ts` against the real upstream packages. See [ADR-016](./docs/adr/016-s402-402-is-an-x402-envelope.md): s402 is a profile of x402, not a second dialect on its header.

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

### Unlock

Pay-to-decrypt encrypted content. Escrow + encrypted content delivery. The buyer pays into escrow; on release, the `EscrowReceipt` unlocks encrypted content stored on [Walrus](https://docs.walrus.site). Currently powered by [Sui SEAL](https://docs.sui.io/concepts/cryptography/seal).

This scheme depends on encryption key server infrastructure and is under active development.

### Stream

Per-second micropayments via on-chain `StreamingMeter`. Client deposits funds into a shared object; recipient claims accrued tokens over time.

```
Phase 1 (402 exchange):
  Client builds stream creation PTB --> facilitator broadcasts
  Result: StreamingMeter shared object on-chain

Phase 2 (ongoing access):
  Client includes x-stream-id header --> server checks on-chain balance
  Server grants access as long as stream has funds
```

Use cases: AI inference sessions, video streaming, real-time data feeds.

## Quick Start

### Types only (most common)

```typescript
import type {
  s402PaymentRequired,
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

// Server: build the 402. One `accepts[]` entry per offered scheme, exact first.
const required: s402PaymentRequired = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/data', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: 'sui:mainnet',
      asset: '0x2::sui::SUI',
      amount: '1000000', // 0.001 SUI in MIST
      payTo: '0x0000000000000000000000000000000000000000000000000000000000000001',
    },
    {
      scheme: 'stream',
      network: 'sui:mainnet',
      asset: '0x2::sui::SUI',
      amount: '1000000',
      payTo: '0x0000000000000000000000000000000000000000000000000000000000000001',
      stream: { ratePerSecond: '1000', budgetCap: '100000000', minDeposit: '10000000' },
    },
  ],
};

response.status = 402;
response.headers.set('payment-required', encodePaymentRequired(required));

// …which puts this on the wire — an x402 V2 PaymentRequired, verbatim:
// {
//   "x402Version": 2,
//   "resource": { "url": "https://api.example.com/data", "mimeType": "application/json" },
//   "accepts": [
//     { "scheme": "exact", "network": "sui:mainnet", "asset": "0x2::sui::SUI",
//       "amount": "1000000", "payTo": "0x00…01", "maxTimeoutSeconds": 60, "extra": {} },
//     { "scheme": "stream", …, "extra": { "stream": { "ratePerSecond": "1000", … } } }
//   ],
//   "extensions": { "s402": { "version": "2" } }
// }

// Client: read the 402 response
const header = response.headers.get('payment-required')!;
const reqs = decodePaymentRequired(header);
console.log(reqs.accepts.map((a) => a.scheme)); // ['exact', 'stream']
console.log(reqs.accepts[0].amount);            // '1000000'
```

Everything s402 adds to a single offer — `facilitatorUrl`, `expiresAt`, the fee fields, the
per-scheme extras — rides inside that entry's `extra`, and everything it adds to the whole 402
rides in `extensions.s402`. In memory the fields sit at the top level, exactly as before; the
codec does the projection. That is what makes one document readable by both decoders.

### x402 compat (opt-in)

```typescript
import {
  normalizeRequirements,
  isS402,
  isX402,
  toX402Requirements,
  fromX402Requirements,
} from 's402/compat';

// Normalize x402 JSON (V1 or V2) to s402 format
const requirements = normalizeRequirements(rawJsonObject);

// Convert s402 -> x402 V1 for legacy clients
const x402Reqs = toX402Requirements(requirements);
```

Serving **x402 clients** takes no compat call and no option at all — every `s402Gate` already
emits x402's envelope:

```typescript
import { s402Gate } from 's402';

const gate = s402Gate({
  server,
  requirements,
  // Required: x402's V2 envelope carries a ResourceInfo, so s402's does too.
  resource: { url: 'https://api.example.com/paid', mimeType: 'application/json' },
});
```

What the compat layer is still for: reading the two RETIRED flat shapes. `fromS402V1Requirements()`
decodes s402's own pre-v2 402; `normalizeRequirements()` takes any of them and returns the wire-v2
document.

The compat layer records the upstream commit it was audited against as `X402_UPSTREAM_PIN`
(`s402/compat/x402`). If that sha is old, the claim is old.

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

// Register scheme implementations (from @sweefi/sui or your own)
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

The reference Sui implementation of the schemes is available in [`@sweefi/sui`](https://www.npmjs.com/package/@sweefi/sui).

## Wire Format

s402's 402 leg **is** x402 V2's `PaymentRequired`. The other two legs use x402 V1's header names:

| Header | Direction | Content |
|--------|-----------|---------|
| `payment-required` | Server -> Client | Base64-encoded x402 V2 `PaymentRequired` envelope (`s402PaymentRequired`) |
| `x-payment` | Client -> Server | Base64-encoded `s402PaymentPayload` JSON |
| `payment-response` | Server -> Client | Base64-encoded `s402SettleResponse` JSON |

> **Note:** x402 V2 renamed the client payment header to `payment-signature`. s402 uses `x-payment` (matching x402 V1). All header names are lowercase per HTTP/2 (RFC 9113 §8.2.1). x402 V2 servers accept both headers, so s402 clients work with both versions. If your server needs to accept x402 V2 clients, also check `payment-signature`.

The 402 leg is x402 V2's document, so nothing distinguishes an s402 402 from an x402 one except
`extensions.s402` — and its absence is not a problem to solve: a plain x402 402 decodes and is
payable. `detectProtocol()` reports which of the two you are looking at.

## Discovery

Servers can advertise s402 support at `/.well-known/s402.json`:

```json
{
  "s402Version": "1",
  "schemes": ["exact", "stream", "escrow", "unlock", "prepaid"],
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
const offer: s402PaymentRequirements = {
  scheme: 'exact',
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0x0000000000000000000000000000000000000000000000000000000000000001',
  expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute window
};
```

## Design Principles

1. **Protocol-agnostic core, Sui-native reference.** `s402` defines chain-agnostic protocol types and HTTP encoding. The reference implementation (`@sweefi/sui`, coming soon) will exploit Sui's unique properties — PTBs, object model, sub-second finality. Other chains can implement s402 schemes using their own primitives.

2. **Optional x402 compat.** The `s402/compat` subpath provides a migration aid for codebases with x402-formatted JSON. It normalizes x402 V1 (`maxAmountRequired`) and V2 (`amount`) to s402 format. This is opt-in — the core protocol has no x402 dependency.

3. **Scheme-specific verification.** Each scheme has its own verify logic. Exact verify (signature recovery + dry-run) is fundamentally different from stream verify (deposit check + rate validation). The facilitator dispatches — it doesn't share logic.

4. **Zero runtime dependencies.** `s402` is pure TypeScript protocol definitions. No Sui SDK, no crypto libraries, no HTTP framework. Chain-specific code belongs in adapters.

5. **Errors tell you what to do.** Every error code includes `retryable` (can the client try again?) and `suggestedAction` (what should it do?). Agents can self-recover.

## Conformance Testing

s402 ships machine-readable JSON test vectors for cross-language conformance — 187 vectors across 14 files. If you're implementing s402 in Go, Python, Rust, or any other language, use these vectors to verify your implementation matches the spec.

```bash
# From the npm package
ls node_modules/s402/test/conformance/vectors/

# Or from a clone of this repo
ls spec/vectors/
```

The two paths hold the same files. `spec/vectors/` is the canonical, version-controlled
location; `scripts/prepare-publish.sh` copies it into `test/conformance/vectors/` at publish
time so it lands inside the npm tarball. **In a fresh clone only `spec/vectors/` exists** —
`test/conformance/vectors/` is generated and git-ignored.

See [`test/conformance/README.md`](./typescript/test/conformance/README.md) for the vector format, encoding scheme, and implementation guide.

## Related

- **[SweeFi](https://github.com/sweeinc/sweefi)** — Open-source payment SDK built on s402. 10 packages including PTB builders, MCP tools, CLI, and UI components.
- **[Sui Gas Station](https://github.com/Danny-Devs/sui-gas-station)** — Sponsored transaction infrastructure for Sui.

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
