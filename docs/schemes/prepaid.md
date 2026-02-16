# Prepaid Scheme

<img src="/images/prepaid.png" alt="Glowing reservoir of tokens being deposited into a digital vault" style="border-radius: 12px; margin-top: 16px; margin-bottom: 24px;" />

Deposit-based access. An agent deposits funds into an on-chain `PrepaidBalance` shared object, makes API calls off-chain, and the provider batch-claims accumulated usage. The Move contract enforces rate caps — no trust required.

## When to Use

- High-frequency API access (100+ calls per session)
- AI agent API budgets
- Compute metering
- Any scenario where per-call settlement is too expensive

## Economics

| | Exact (per-call) | Prepaid (batched) |
|---|---|---|
| 1,000 API calls | 1,000 on-chain TXs | 2 on-chain TXs |
| Gas cost | ~$7.00 | ~$0.014 |
| Per-call effective gas | $0.007 | $0.000014 |
| Improvement | — | **500x cheaper** |

## How It Works

### Phase 1: Deposit (one on-chain TX)

The agent deposits funds into a `PrepaidBalance` shared object targeting a specific provider.

```
Agent → Sui: "Lock 1 SUI into PrepaidBalance for provider 0xABC"
Result: PrepaidBalance object created on-chain
Gas: ~$0.007
```

### Phase 2: Usage (off-chain, zero gas)

The agent makes API calls, including the PrepaidBalance object ID in each request. The server:

1. Reads the on-chain balance (free — no transaction)
2. Verifies sufficient funds remain
3. Serves the response
4. Increments a local usage counter

```
Agent → Server: GET /api/data
  Header: x-prepaid-balance: 0x123...    (application-level, not part of s402)

Server checks balance → serves response → tracks usage locally
```

No on-chain transaction per call. The server tracks usage in its own database.

::: info Phase 2 is outside the s402 protocol
The `x-prepaid-balance` header shown above is an **application-level convention**, not a standard s402 header. The s402 protocol covers Phase 1 (deposit via the standard 402 flow). Phase 2 (off-chain usage) and Phase 3 (provider claims) are between your server and the on-chain contract.
:::

### Phase 3: Claim (one on-chain TX)

The provider batch-claims accumulated usage from the balance.

```
Provider → Sui: "Claim 250 calls × 0.004 SUI each = 1.0 SUI from balance 0x123"
Gas: ~$0.007
```

**Total gas for 1,000 calls**: $0.014 (deposit + claim)

## Trust Model

The provider tracks usage off-chain, which means they could theoretically over-report. The on-chain contract prevents this:

- `claimed ≤ maxCalls × ratePerCall` — can't claim more than the math allows
- `claimed ≤ deposited amount` — can't claim more than what's in the balance
- **Withdrawal delay**: The agent can withdraw unclaimed funds after `withdrawalDelayMs` passes

The agent doesn't need to trust the provider. The Move contract enforces the rules.

## Common Mistakes

::: danger Don't use Exact for high-frequency calls
If your agent makes more than ~10 API calls per session, Exact costs 500x more in gas than Prepaid. Check the economics table above — the savings are structural, not marginal.
:::

::: danger Validate `withdrawalDelayMs` before accepting deposits
If `withdrawalDelayMs` is 0, the agent can deposit and immediately withdraw, making the deposit useless for the provider. Set a reasonable delay (e.g., 1 hour) so the provider has time to claim.
:::

## Requirements

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['prepaid'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '10000000', // 0.01 SUI minimum deposit
  payTo: '0xprovider...',
  prepaid: {
    ratePerCall: '1000',     // 0.000001 SUI per call
    maxCalls: '10000',       // up to 10K calls
    minDeposit: '10000000',  // 0.01 SUI minimum
    withdrawalDelayMs: '3600000', // 1 hour delay
  },
};
```
