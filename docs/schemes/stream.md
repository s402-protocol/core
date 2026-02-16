# Stream Scheme

Per-second micropayments via an on-chain `StreamingMeter`. The client deposits funds into a shared object; the server claims accrued tokens over time. Pay only for what you use.

## When to Use

- AI inference sessions (pay per second of compute)
- Video or audio streaming
- Real-time data feeds (market data, IoT sensors)
- Any service billed by duration

## How It Works

### Phase 1: Stream Creation (one on-chain TX)

The client deposits funds into a `StreamingMeter` shared object via the standard 402 flow.

```
Client → Sui: "Create StreamingMeter with 0.1 SUI deposit for provider 0xABC"
Result: StreamingMeter shared object on-chain
Gas: ~$0.007
```

The server responds with the stream ID and begins granting access.

### Phase 2: Ongoing Access (off-chain, zero gas)

The client includes the stream ID in every subsequent request. The server checks the on-chain balance and grants access as long as funds remain.

```
Client → Server: GET /api/realtime-data
  Header: x-stream-id: 0x123...

Server reads on-chain balance (free) → grants access
```

No on-chain transaction per request. The meter accrues cost per second at the agreed rate, and the server reads it periodically.

### Phase 3: Claim (one on-chain TX)

The provider claims accrued funds from the meter.

```
Provider → Sui: "Claim 300 seconds × 0.000001 SUI/sec = 0.0003 SUI"
Gas: ~$0.007
```

## Economics

| | Exact (per-call) | Stream |
|---|---|---|
| 1-hour session (3,600 requests) | 3,600 on-chain TXs | 2 on-chain TXs |
| Gas cost | ~$25.20 | ~$0.014 |
| Latency per request | ~400ms (on-chain) | ~5ms (balance check) |
| Billing granularity | Per request | Per second |

## Trust Model

- **On-chain rate cap**: The `StreamingMeter` enforces the maximum rate per second. The provider cannot claim more than `elapsed_seconds × ratePerSecond`.
- **Budget cap**: Total claims cannot exceed `budgetCap`. The client sets a hard ceiling on total spend.
- **Minimum deposit**: Ensures the stream is economically viable to create (prevents spam).
- **Client can close**: The client can close the stream and withdraw remaining funds at any time.

## Requirements

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['stream'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '100000000', // 0.1 SUI initial deposit
  payTo: '0xprovider...',
  stream: {
    ratePerSecond: '1000',    // 0.000001 SUI/sec
    budgetCap: '1000000000',  // 1 SUI max
    minDeposit: '100000000',  // 0.1 SUI minimum
  },
};
```

## Payload

```typescript
const payload: s402StreamPayload = {
  s402Version: '1',
  scheme: 'stream',
  payload: {
    transaction: '<base64 signed stream creation PTB>',
    signature: '<base64 signature>',
  },
};
```

## Common Mistakes

::: danger Always set `budgetCap`
Without a budget cap, a runaway agent could drain its entire wallet through an open stream. The `budgetCap` is a hard ceiling enforced on-chain — set it to the maximum you're willing to spend per session.
:::

::: danger Don't use Streams for request-response APIs
Streams bill per second, not per request. If your API has idle gaps between calls, you're paying for dead air. Use [Prepaid](/schemes/prepaid) for request-response patterns and Streams for continuous consumption (inference, video, real-time feeds).
:::

## Edge Cases

- **What if the stream runs out of funds?** The server stops granting access. The client receives `STREAM_DEPLETED` (retryable) and can top up the deposit.
- **What if the client disappears?** The provider claims whatever has accrued. Remaining funds stay in the meter until the client withdraws.
- **What about variable pricing?** The rate is fixed at stream creation. For variable pricing, close the stream and create a new one with updated terms.
