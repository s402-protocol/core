# Prepaid Scheme

<img src="/images/prepaid.png" alt="Glowing reservoir of tokens being deposited into a digital vault" style="border-radius: 12px; margin-top: 16px; margin-bottom: 24px;" />

Deposit-based access. An agent deposits funds into an on-chain `PrepaidBalance` shared object, makes API calls off-chain, and the provider batch-claims accumulated usage. The Move contract enforces rate caps — no trust required.

## When to Use

- High-frequency API access (100+ calls per session)
- AI agent API budgets
- Compute metering
- Any scenario where per-call settlement is too expensive

## Economics

Gas costs vary with ETH price and network congestion. Figures below use February 2026 spot rates (Base: 0.012 Gwei / ETH ~$2,000; Solana: ~$0.00025/tx). The Prepaid advantage is structural — 2 transactions regardless of call count.

| | x402 Exact (Base) | x402 Exact (Solana) | s402 Exact (Sui) | s402 Prepaid (Sui) |
|---|---|---|---|---|
| 1,000 calls (gas) | ~$1.60 | ~$0.25 | ~$7.00 | **~$0.014** |
| 10,000 calls (gas) | ~$16.00 | ~$2.50 | ~$70.00 | **~$0.014** |
| On-chain TXs | 1,000 | 1,000 | 1,000 | **2** |

The Prepaid advantage scales with call volume. At 1,000 calls it is ~18× cheaper than the next-cheapest option (x402 on Solana). At 100,000 calls it is ~1,800× cheaper. The gas cost is fixed at 2 transactions regardless of session length.

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

The provider tracks usage off-chain and claims on-chain. Understanding exactly what the Move contract enforces — and what it doesn't — is important for choosing the right scheme.

**What the contract enforces (hard limits):**
- `claimed ≤ maxCalls × ratePerCall` — the provider cannot claim more than this ceiling
- `claimed ≤ deposited amount` — the provider cannot claim more than is in the balance
- **Withdrawal delay**: The agent can withdraw unclaimed funds after `withdrawalDelayMs` passes — the delay exists so the provider has time to claim before the agent can drain the balance

**What the contract does NOT enforce:**
- The exact number of API calls served. The contract enforces a ceiling, not an exact count. A provider could claim up to the cap regardless of actual usage.

**Practical implication:** The Prepaid scheme is **trust-bounded**, not trustless. The contract sets the maximum that can be taken; it does not audit that the provider served every call they claim. For most commercial relationships this is sufficient — overclaiming is a business risk and a breach of contract. For zero-trust adversarial relationships, use Escrow instead.

**Horizontal scaling note:** If a provider runs multiple server instances, off-chain usage tracking must be coordinated across instances (e.g., with a shared counter or distributed lock). Without this, two instances could independently authorize calls against the same balance, each believing it has headroom. This is an implementation concern for providers — ensure your usage counter is consistent before deploying Prepaid in a multi-instance setup.

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
