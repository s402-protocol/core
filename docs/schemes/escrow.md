# Escrow Scheme

Time-locked vault with arbiter dispute resolution. Full state machine: `ACTIVE → DISPUTED → RELEASED / REFUNDED`.

## When to Use

- Digital goods delivery
- Freelance payments
- Trustless commerce where both parties need protection

## Flow

1. Buyer deposits funds, locked until release or deadline
2. Buyer confirms delivery → funds release to seller (receipt minted)
3. Deadline passes → permissionless refund (anyone can trigger)
4. Either party disputes → arbiter resolves

## Requirements

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['escrow'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '50000000000', // 50 SUI
  payTo: '0xseller...',
  escrow: {
    seller: '0xseller...',
    arbiter: '0xarbiter...', // optional
    deadlineMs: String(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  },
};
```
