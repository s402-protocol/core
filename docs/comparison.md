# s402 vs x402

s402 extends [x402](https://github.com/coinbase/x402) (Coinbase's HTTP 402 protocol) with Sui-native capabilities. They are **complementary**, not competing — x402 handles EVM well, s402 handles Sui.

## At a Glance

| | x402 (Coinbase/EVM) | s402 (Sui) |
|---|---|---|
| **Settlement** | Two-step: verify then settle (temporal gap) | Atomic: verify + settle in one PTB |
| **Finality** | ~12 seconds (EVM L1) | ~400ms (Sui) |
| **Payment models** | Exact (one-shot) | Exact, Prepaid, Escrow, Stream, Unlock |
| **Coin handling** | approve + transferFrom | Native `coinWithBalance` + `splitCoins` |
| **Direct mode** | No | Yes (no facilitator needed) |
| **Receipts** | Off-chain | On-chain NFT proofs |
| **Agent auth** | None | AP2 mandate delegation |
| **Wire compatibility** | — | x402 V1 wire-compat; V2 via compat layer |

## High-Frequency API Payments

This is where the economics diverge most. When an AI agent makes thousands of API calls, the gas model matters:

| | x402 Exact | s402 Prepaid |
|---|---|---|
| 1,000 API calls | 1,000 on-chain TXs | 2 on-chain TXs |
| Gas cost | ~$7.00 | ~$0.014 |
| Latency per call | ~12s (block confirmation) | ~5ms (off-chain balance check) |
| Settlement finality | ~12 seconds | ~400ms |

### Methodology (Important)

This comparison is **not apples-to-apples**. x402's Exact scheme settles every call individually. s402's Prepaid scheme amortizes costs by depositing upfront and batch-claiming later.

**Exact-to-exact**, the gas difference is more modest — roughly 10-20x from Sui's lower base gas cost. The 500x advantage comes from a payment model (Prepaid) that EVM architecturally cannot support because it relies on Sui's shared objects and Programmable Transaction Blocks.

We state this explicitly because transparent methodology builds trust.

## Wire Compatibility

s402 uses the same HTTP headers as x402 V1:

| Header | Direction | x402 | s402 |
|--------|-----------|------|------|
| `payment-required` | Server → Client | ✅ | ✅ |
| `x-payment` | Client → Server | ✅ (V1) | ✅ |
| `payment-signature` | Client → Server | ✅ (V2) | Via compat |
| `payment-response` | Server → Client | ✅ | ✅ |

An x402 client sending an `exact` payment can interact with an s402 server. The `detectProtocol()` function auto-detects which protocol a server is using by checking for `s402Version` in the decoded requirements.

```typescript
import { detectProtocol } from 's402';
import { normalizeRequirements } from 's402/compat';

// Works whether the server sent s402 or x402
const protocol = detectProtocol(response.headers);

// Normalize either format into s402 types
const requirements = normalizeRequirements(decoded);
```

## Why Not Just Use x402 on Sui?

You can — s402's `exact` scheme is wire-compatible with x402. But you'd miss:

1. **Prepaid**: Deposit-based access with off-chain API calls. 500x gas savings for high-frequency usage.
2. **Escrow**: Time-locked trustless commerce with arbiter dispute resolution.
3. **Stream**: Per-second micropayments via on-chain meters.
4. **Unlock**: Pay-to-decrypt via Sui SEAL + Walrus encrypted storage.
5. **Direct settlement**: No facilitator needed — settle directly on-chain.
6. **On-chain receipts**: Permanent, auditable proof of every payment as NFTs.
7. **AP2 mandates**: Agent spending authorization with per-tx and lifetime caps.

These capabilities come from Sui's object model, PTBs, and sub-second finality. They can't be replicated on EVM — and they don't need to be. x402 already handles EVM well. s402 handles Sui.
