# Escrow Scheme

<img src="/images/escrow.png" alt="Geometric vault with a luminous time-lock mechanism" style="border-radius: 12px; margin-top: 16px; margin-bottom: 24px;" />

Time-locked vault with arbiter dispute resolution. The buyer deposits funds, the seller delivers, and the buyer confirms. If anything goes wrong, the deadline or an arbiter resolves it.

## When to Use

- Digital goods delivery (buyer protection)
- Freelance payments (both parties protected)
- Trustless commerce where neither party knows the other
- Any scenario where "pay first, deliver later" needs guarantees

## How It Works

### State Machine

```
ACTIVE --> RELEASED    (buyer confirms delivery)
  |
  +--> REFUNDED        (deadline passes, anyone can trigger)
  |
  +--> DISPUTED --> RELEASED or REFUNDED (arbiter decides)
```

### Phase 1: Deposit

The buyer creates an escrow via a signed PTB. Funds are locked on-chain.

```
Buyer → Sui: "Lock 50 SUI into Escrow for seller 0xABC, deadline 7 days"
Result: Escrow shared object on-chain (state: ACTIVE)
Gas: ~$0.007
```

### Phase 2: Delivery

The seller sees the funded escrow and delivers the goods or service off-chain. The escrow object ID serves as a receipt reference.

### Phase 3: Resolution

Three possible outcomes:

**Happy path** — Buyer confirms delivery:
```
Buyer → Sui: "Release Escrow 0x123 to seller"
Result: Funds transfer to seller. EscrowReceipt NFT minted.
```

**Deadline passes** — Permissionless refund:
```
Anyone → Sui: "Refund expired Escrow 0x123"
Result: Funds return to buyer. No arbiter needed.
```

**Dispute** — Either party escalates:
```
Buyer or Seller → Sui: "Dispute Escrow 0x123"
Result: State moves to DISPUTED. Arbiter resolves.
Arbiter → Sui: "Resolve in favor of seller/buyer"
```

## Trust Model

- **Buyer protection**: Funds are locked, not transferred. Buyer can get a refund if the seller doesn't deliver before the deadline.
- **Seller protection**: Once the buyer confirms, funds release immediately. The seller doesn't need to trust the buyer to pay later.
- **Deadline enforcement**: After the deadline, anyone can trigger a refund. This is permissionless — no arbiter needed for the timeout case.
- **Arbiter** (optional): A trusted third party who can resolve disputes. If no arbiter is set, the only resolution paths are buyer-confirms or deadline-refund.

## Economics

| | Cost |
|---|---|
| Create escrow | ~$0.007 (one TX) |
| Release or refund | ~$0.007 (one TX) |
| Total | ~$0.014 |

Escrow is designed for single high-value transactions, not high-frequency API calls. For per-call payments, use [Exact](/schemes/exact) or [Prepaid](/schemes/prepaid).

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

## Payload

```typescript
const payload: s402EscrowPayload = {
  s402Version: '1',
  scheme: 'escrow',
  payload: {
    transaction: '<base64 signed escrow creation PTB>',
    signature: '<base64 signature>',
  },
};
```

## Common Mistakes

::: danger Set a realistic deadline
Too short: the seller can't deliver. Too long: the buyer's funds are locked for weeks. Match the deadline to actual delivery expectations — hours for digital goods, days for services.
:::

::: danger Don't skip the arbiter for high-value escrows
Without an arbiter, the only resolution paths are buyer-confirms or deadline-refund. If the goods are ambiguous (partial delivery, quality disputes), there's no way to resolve it. Set an arbiter for any escrow over $100.
:::

## Edge Cases

- **What if the buyer never confirms?** The deadline triggers an automatic refund. Anyone can call the refund function after the deadline — it is permissionless.
- **What if the arbiter is compromised?** The arbiter can only resolve disputes, not withdraw funds. If no dispute is raised, the arbiter has no power. Keep the arbiter optional and only set one for high-value transactions.
- **What about partial delivery?** The current escrow is all-or-nothing. Partial release would require a custom Move contract extension.
