# Exact Scheme

One-shot payment. The client builds a signed transfer PTB, the facilitator verifies and broadcasts it atomically. One transaction per request.

**This is the x402-compatible baseline.** An x402 client can talk to an s402 server using this scheme with zero modifications.

## When to Use

- One-off API calls
- Paying multiple different providers
- When you need x402 interoperability
- Low-frequency requests where per-call gas is acceptable
- Prototyping (simplest scheme to start with)

## How It Works

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

**Step by step:**

1. Client requests a paid resource
2. Server responds with HTTP 402 + payment requirements
3. Client builds a transfer PTB (SUI coin split + transfer), signs it
4. Client retries the request with the signed TX in the `x-payment` header
5. Server forwards to facilitator, which verifies and broadcasts
6. Facilitator returns the transaction digest
7. Server delivers the content with a `payment-response` header

## Economics

| | Cost |
|---|---|
| Per API call | ~$0.007 (one TX on Sui) |
| 1,000 calls | ~$7.00 |
| Latency | ~400ms (on-chain settlement) |

For high-frequency usage (more than ~10 calls per session), the [Prepaid](/schemes/prepaid) scheme is 500x cheaper because it amortizes gas across a batch.

## Trust Model

- **Atomic settlement**: The PTB either succeeds entirely or fails entirely. No partial state.
- **No state between calls**: Each request is independent. No deposits, no meters, no streams.
- **Facilitator must wait for finality**: The facilitator calls `waitForTransaction()` before returning success. Without this, the server could grant access for a transaction that gets reverted.

## Requirements

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000', // 0.001 SUI
  payTo: '0xrecipient...',
  expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute window
};
```

## Payload

```typescript
const payload: s402ExactPayload = {
  s402Version: '1',
  scheme: 'exact',
  payload: {
    transaction: '<base64 signed PTB bytes>',
    signature: '<base64 signature>',
  },
};
```

## x402 Compatibility

Exact is the bridge between s402 and x402. The wire format is identical:

- Same HTTP headers (`payment-required`, `x-payment`, `payment-response`)
- Same base64 JSON encoding
- The `detectProtocol()` function distinguishes s402 from x402 by checking for `s402Version` in the decoded JSON

An x402 client sending an exact payment will work against an s402 server. The `normalizeRequirements()` function handles the conversion transparently.

## Common Mistakes

::: danger Don't skip `expiresAt`
Omitting `expiresAt` from requirements means they never expire. A signed transaction captured today can be replayed tomorrow. Always set a short window (2-5 minutes for API calls).
:::

::: danger Always call `waitForTransaction()` before granting access
The facilitator must confirm on-chain finality before returning `success: true`. Without this, the server may deliver content for a transaction that gets reverted. Sui finality is ~400ms — the wait is negligible.
:::

## Edge Cases

- **What if the transaction fails on-chain?** The facilitator returns `{ success: false, error: "..." }`. The client receives the error in the `payment-response` header and can retry.
- **What if requirements expire?** The facilitator rejects with `REQUIREMENTS_EXPIRED` (retryable). The client re-fetches requirements from the server.
- **What about double-spending?** Sui's object model prevents double-spending at the consensus level. If the same coin is used in two transactions, one will fail.
