---
description: Variable-amount HTTP 402 payments on Sui. Client authorizes a maximum, server reports actual usage, facilitator settles the precise amount. On-chain ceiling protection.
---

# Upto Scheme

Variable-amount payment. The client deposits up to a maximum; the server reports actual usage; the facilitator settles the precise amount. The remainder is refunded on-chain. Client-chosen `settlementCeiling` provides on-chain protection against overcharging.

## When to Use

- Usage-based API pricing (tokens consumed, compute time, bandwidth)
- Variable-cost operations where the exact price isn't known upfront
- Metered billing (the server measures usage, then charges)
- Any scenario where "pay up to X, refund the rest" is the right model

## How It Works

```
Client                    Server                  Facilitator
  |--- GET /api/analyze ---->|                         |
  |<-- 402 + requirements ---|                         |
  |   (maxAmount, estimate)  |                         |
  |                          |                         |
  |  (build deposit PTB)     |                         |
  |  (set settlementCeiling) |                         |
  |--- GET + x-payment ----->|                         |
  |                          |   [serve resource]      |
  |                          |   [meter actual usage]  |
  |                          |--- settle(actual) ----->|
  |                          |<--- { success, actual } |
  |<-- 200 + data -----------|                         |
```

**Step by step:**

1. Client requests a paid resource
2. Server responds with HTTP 402 + payment requirements including `upto.maxAmount` and optional `upto.estimatedAmount`
3. Client builds a deposit PTB, optionally setting `settlementCeiling` (e.g., 1.2x the estimate)
4. Client retries the request with the signed deposit TX in the `x-payment` header
5. Server delivers the resource and measures actual usage
6. Server tells the facilitator the `actualAmount` via `settlementOverrides`
7. Facilitator calls `settle(actualAmount)` on-chain. The Move contract enforces `actualAmount <= min(maxAmount, settlementCeiling)`. Remainder is refunded to the payer.

## Economics

| | Cost |
|---|---|
| Per API call | ~$0.007 (one deposit TX on Sui) |
| Settlement | Included in facilitator's TX |
| Latency | ~400ms (on-chain settlement) |

Upto has similar per-call economics to Exact. The advantage is not gas savings — it's the ability to handle variable pricing with on-chain refund guarantees. For high-frequency fixed-price calls, use [Prepaid](/schemes/prepaid) instead.

## Trust Model

The upto scheme provides a three-layer trust model:

1. **`maxAmount`** (server-set): The absolute maximum the client can be charged. Set in requirements.
2. **`settlementCeiling`** (client-set, on-chain enforced): A tighter cap the client chooses. The Move contract rejects settlements above this. Lets the client bound exposure to e.g., 1.2x the server's estimate.
3. **`actualAmount`** (server-reported): What the server says the client actually owes. Must be ≤ `settlementCeiling` ≤ `maxAmount`.

**If the facilitator doesn't settle before `settlementDeadlineMs`**, the client can reclaim the full deposit via `expire()`. This is permissionless — anyone can trigger it after the deadline.

**The server is trusted to report honest usage.** The facilitator enforces the ceiling but cannot independently verify that the reported `actualAmount` matches real usage. On-chain events provide an audit trail for dispute resolution.

## Requirements

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['upto'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '0', // not used for upto — maxAmount is in the upto sub-object
  payTo: '0xrecipient...',
  expiresAt: Date.now() + 5 * 60 * 1000,
  upto: {
    maxAmount: '10000000',            // 0.01 SUI max
    settlementDeadlineMs: String(Date.now() + 60 * 60 * 1000), // 1 hour
    estimatedAmount: '3000000',       // ~0.003 SUI estimated (advisory)
  },
};
```

## Payload

```typescript
const payload: s402UptoPayload = {
  s402Version: '1',
  scheme: 'upto',
  payload: {
    transaction: '<base64 signed deposit PTB>',
    signature: '<base64 signature>',
    maxAmount: '10000000',
    settlementCeiling: '4000000',    // client caps at ~1.3x estimate
  },
};
```

## Comparison with x402

x402 V1 uses `maxAmountRequired` for variable-amount payments, but the settlement amount is opaque to the client — the facilitator settles whatever it wants up to the max with no on-chain ceiling enforcement. s402's Upto makes the trust model explicit:

| | x402 | s402 Upto |
|---|---|---|
| Client-set ceiling | No | Yes (`settlementCeiling`, on-chain enforced) |
| Server cost estimate | No | Yes (`estimatedAmount`, advisory) |
| Actual amount visible | No | Yes (`actualAmount` in settlement response) |
| Deadline-based refund | No | Yes (`expire()` after `settlementDeadlineMs`) |

## Common Mistakes

::: danger Always check `estimatedAmount` before setting `settlementCeiling`
If you set `settlementCeiling` too low (below actual usage), the settlement will fail and you'll need to retry with a higher ceiling. Use the server's `estimatedAmount` as a baseline and add a buffer (e.g., 1.2x–1.5x).
:::

::: danger Set `settlementDeadlineMs` appropriately
Too short: the facilitator might not settle in time, and you'll need to reclaim and retry. Too long: your capital is locked for the duration. Match the deadline to the expected request processing time plus a buffer.
:::

## Edge Cases

- **What if the server overcharges?** The Move contract enforces `actualAmount <= settlementCeiling`. If the server reports more than the client's ceiling, the transaction fails on-chain. The client's funds are protected.
- **What if the facilitator never settles?** After `settlementDeadlineMs`, the client (or anyone) can call `expire()` to reclaim the full deposit. No funds are lost.
- **What if `estimatedAmount` is wildly wrong?** `estimatedAmount` is advisory only — it has no on-chain effect. The client should use it as a hint for setting `settlementCeiling`, but the ceiling is the real protection.
