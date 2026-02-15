# Stream Scheme

Per-second micropayments via an on-chain `StreamingMeter`. The client deposits funds into a shared object; the recipient claims accrued tokens over time.

## When to Use

- AI inference sessions
- Video streaming
- Real-time data feeds
- Any service billed by duration

## Flow

```
Phase 1 (402 exchange):
  Client builds stream creation PTB → facilitator broadcasts
  Result: StreamingMeter shared object on-chain

Phase 2 (ongoing access):
  Client includes X-STREAM-ID header → server checks on-chain balance
  Server grants access as long as stream has funds
```

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
