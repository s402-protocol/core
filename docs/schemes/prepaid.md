---
description: Deposit-based API access on Sui. One deposit, thousands of API calls, one claim — $0.014 total gas vs $7 per-call. Built for AI agent API budgets.
---

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

## Agent Security Recommendations

The contract enforces the ceiling — it does not audit every call. These practices bound your exposure:

**1. Keep deposits small and refill often.**
Do not deposit a week's budget upfront. Deposit enough for one session or one day and refill as needed. If a provider overclaims, your maximum loss is bounded by one deposit cycle — not your total balance.

**2. Size your deposit to your acceptable risk.**
A $5 deposit with a $0.001/call rate and 5,000-call cap means the worst-case overclaim is $5. Think of your deposit size as your risk budget, not just your usage budget.

**3. Evaluate `withdrawalDelayMs` before depositing.**
This parameter is set by the provider, not you. A 1-hour delay means you cannot reclaim unclaimed funds for 1 hour after requesting withdrawal. A 7-day delay (the maximum) is a significant capital lockup. Always check this value before committing funds to an unfamiliar provider.

**4. Prefer providers that advertise `providerPubkey`.**
When a provider includes `providerPubkey` in their requirements, they support signed-receipt mode (v0.2) — cryptographic evidence of every call served. This upgrades the trust model from economic to verifiable. See [v0.2: Signed Receipts](#v02-signed-receipts-opt-in) below.

**5. Use Escrow for unknown providers.**
If you have no prior relationship with a provider and cannot evaluate their reputation, use [Escrow](/schemes/escrow) instead. Escrow gives you full on-chain dispute resolution with an arbiter and automatic deadline refunds. Prepaid is designed for recurring, established relationships — not first-contact commerce.

## v0.2: Signed Receipts (Opt-In)

Providers can opt into signed-receipt mode by including `providerPubkey` in their requirements. This is **backward-compatible** — providers without `providerPubkey` behave identically to v0.1. No changes required for existing providers or agents that don't implement v0.2.

### How it works

**Provider requirements (v0.2 mode):**

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['prepaid'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '10000000',
  payTo: '0xprovider...',
  prepaid: {
    ratePerCall: '1000',
    maxCalls: '10000',
    minDeposit: '10000000',
    withdrawalDelayMs: '3600000',
    providerPubkey: '0xabc123...', // Ed25519 public key, 32 bytes hex
    disputeWindowMs: '3600000',    // 1 hour window for agent to dispute
  },
};
```

**Per-call receipt in HTTP response:**

When `providerPubkey` is set, each API response includes a signed receipt in the header:

```
X-S402-Receipt: v2:<base64(signature)>:<callNumber>:<timestampMs>:<base64(responseHash)>
```

The provider signs a BCS-encoded message containing the balance ID, call number, timestamp, and response hash using the Ed25519 private key corresponding to `providerPubkey`. This creates a tamper-proof record tied to the specific balance, call sequence, and response content.

**Agent accumulates receipts:**

The agent stores the receipts locally (memory or disk). If the provider later claims X calls but the agent holds only Y < X valid signatures, the agent has a cryptographic fraud proof — verifiable evidence of overclaiming.

**Trust model with v0.2:**

| | v0.1 (default) | v0.2 (opt-in, `providerPubkey` set) |
|---|---|---|
| **Ceiling enforcement** | On-chain (trustless) | On-chain (trustless) |
| **Call audit** | Economic only | Cryptographic — signed per call |
| **Overclaim proof** | None | Ed25519 signature set |
| **Provider overhead** | None | ~1ms Ed25519 sign per response |
| **Agent overhead** | None | ~100 bytes stored per call |

::: tip Building a new provider?
Implement v0.2 from the start. The overhead is minimal — one Ed25519 signature added to each HTTP response — and it gives your clients a verifiable trust guarantee from day one.
:::

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
