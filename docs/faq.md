---
description: Common questions about s402 — production readiness, testing, facilitators, and more.
---

# FAQ

## Is s402 production-ready?

The protocol spec and TypeScript package (`s402@0.1.0`) are stable for the **Exact**, **Prepaid**, and **Escrow** schemes. These are v0.1 and covered by 200+ tests.

**Stream** and **Unlock** are v0.2 — the types are defined but the on-chain implementations are under active development. Use them for prototyping, not production.

## Do I need a facilitator?

Not always. There are two settlement modes:

- **Facilitator mode** (default): The client signs a transaction and sends it to a facilitator service, which verifies and broadcasts it. This is the standard flow — the client never needs a Sui RPC connection.
- **Direct mode**: The client builds, signs, and broadcasts the transaction itself. No middleman. Set `settlementMode: 'direct'` in your requirements.

Use a facilitator when your clients are lightweight (browser, mobile, AI agents that shouldn't hold RPC connections). Use direct mode when clients are self-sovereign and hold their own keys.

## How do I test without real money?

Use **Sui testnet**. Set `network: 'sui:testnet'` in your requirements. Testnet SUI is free from the [Sui faucet](https://docs.sui.io/guides/developer/getting-started/get-address#fund-your-account).

For unit tests, you don't need a network at all — `s402` is a protocol layer. You can test encode/decode, error handling, and scheme selection entirely in-memory:

```typescript
import { encodePaymentRequired, decodePaymentRequired } from 's402';

const encoded = encodePaymentRequired({
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0x1234...',
});

const decoded = decodePaymentRequired(encoded);
assert(decoded.amount === '1000000');
```

## What happens if Sui goes down?

If the Sui network is unreachable:
- **Exact/Escrow/Unlock**: Payments fail. The facilitator returns `FINALITY_TIMEOUT` (retryable). Clients should retry with backoff.
- **Prepaid** (Phase 2): Off-chain API calls continue working because they don't hit the chain. The provider can't claim yet, but the agent can keep making calls.
- **Stream**: Existing streams continue. New deposits fail until the network recovers.

The `retryable` field on every error tells the client whether to retry automatically.

## How is this different from Stripe / traditional payments?

Stripe requires:
- Account creation and KYC
- API keys and billing dashboards
- Monthly invoicing and settlement
- Human approval for new integrations

s402 requires:
- A Sui wallet with funds
- One HTTP header

s402 is designed for **machine-to-machine payments** where AI agents need to pay for API calls autonomously. No accounts, no dashboards, no humans in the loop. Stripe is better for human commerce with credit cards and subscriptions.

## Can I accept multiple schemes on the same endpoint?

Yes. The `accepts` array in payment requirements lists all schemes your server supports. The client picks the best one it has an implementation for:

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['prepaid', 'exact'],  // prefer prepaid, fall back to exact
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0xrecipient...',
};
```

Order matters — the client tries the first scheme in the array first.

## Can I use s402 with tokens other than SUI?

Yes. The `asset` field accepts any Move coin type. For example, USDC on Sui:

```typescript
asset: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
```

The facilitator and scheme implementations need to support the coin type, but the protocol itself is coin-agnostic.

## What's the relationship between s402 and x402?

[x402](https://github.com/coinbase/x402) by Coinbase established HTTP 402 payments on EVM. s402 uses the **same wire format** (HTTP headers, base64 JSON encoding) extended with Sui-native capabilities.

- An x402 client can talk to an s402 server using the `exact` scheme — zero code changes
- s402 adds four schemes that EVM can't support (Prepaid, Escrow, Stream, Unlock)
- The `normalizeRequirements()` function handles both protocols transparently

They are complementary. x402 handles EVM. s402 handles Sui. See the [full comparison](/comparison).

## What about gas? Who pays for it?

In the **facilitator model**, the facilitator broadcasts the transaction and pays gas. This cost is typically absorbed by the facilitator service or passed through as a protocol fee (`protocolFeeBps`).

In **direct mode**, the client pays gas directly.

For Prepaid, gas is minimal: one deposit TX (~$0.007) + one claim TX (~$0.007) = $0.014 total for potentially thousands of API calls.

## Is there a size limit on payment headers?

The protocol doesn't define a hard limit, but practical HTTP header size limits apply (most servers cap at 8-16 KB per header). The `decodePaymentRequired()` function enforces a maximum header size to prevent memory exhaustion from malicious payloads.

For typical payment requirements (even with scheme-specific extras), the base64-encoded header is well under 1 KB.
