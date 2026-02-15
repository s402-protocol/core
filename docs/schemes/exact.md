# Exact Scheme

One-shot payment. The client builds a signed transfer PTB, the facilitator verifies and broadcasts it atomically.

**This is the x402-compatible baseline.** An x402 client can talk to an s402 server using this scheme with zero modifications.

## When to Use

- One-off API calls
- Paying multiple different providers
- When you need x402 interoperability
- Low-frequency requests where per-call gas is acceptable

## Flow

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

## Requirements

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000', // 0.001 SUI
  payTo: '0xrecipient...',
  expiresAt: Date.now() + 5 * 60 * 1000,
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

## Gas Cost

One on-chain transaction per API call. On Sui, this is ~$0.007. For high-frequency usage, consider the [Prepaid](/schemes/prepaid) scheme instead.
