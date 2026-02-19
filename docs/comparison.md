# s402 vs x402

s402 extends [x402](https://github.com/coinbase/x402) (Coinbase's HTTP 402 protocol) with Sui-native capabilities. They are **complementary**, not competing — x402 handles Base, Solana, and traditional rails; s402 handles Sui's unique architecture.

## At a Glance

| | x402 V1 (Base/EVM) | x402 V2 (Multi-chain) | s402 (Sui) |
|---|---|---|---|
| **Settlement** | Two-step: verify then settle | Two-step + Extensions for deferred/batch | Atomic: verify + settle in one PTB |
| **Finality** | ~2s (Base) / ~400ms opt. (Solana) | Same per chain | ~400ms (owned objects) |
| **Payment models** | Exact (per-call) | Exact + session/deferred via Extensions | Exact, Prepaid, Escrow, Stream, Unlock |
| **Session patterns** | None | Application-layer conventions | Protocol-enforced Move contracts |
| **Coin handling** | approve + transferFrom | Same + multi-chain | Native `coinWithBalance` + `splitCoins` |
| **Direct mode** | No | No | Yes (no facilitator needed) |
| **Receipts** | Off-chain | Off-chain | On-chain NFT proofs |
| **Agent auth** | None | None | AP2-aligned mandate delegation |
| **Wire compatibility** | — | — | x402 V1 wire-compat; V2 via compat layer |
| **Chains** | Base, Ethereum | Base, Solana, ACH, cards | Sui |

**On x402 V2 (December 2025):** x402 V2 adds multi-chain support, dynamic payment routing, and formalized Extensions that enable subscription-like and session-based patterns at the application layer. The x402 Foundation includes Google, Cloudflare, and Visa. This is a meaningful step toward the same use cases s402 addresses. The key difference: x402's session patterns are application-layer conventions negotiated between client and server; s402's Prepaid and Stream schemes are Move contracts with on-chain rate cap enforcement — the contract prevents overclaiming by design, not by policy.

## High-Frequency API Payments

Gas costs are volatile. The table below uses February 2026 spot prices (Base: 0.012 Gwei / ETH ~$2,000; Solana: ~$0.00025/tx).

| | x402 Exact (Base) | x402 Exact (Solana) | s402 Exact (Sui) | s402 Prepaid (Sui) |
|---|---|---|---|---|
| 1,000 API calls | 1,000 on-chain TXs | 1,000 on-chain TXs | 1,000 on-chain TXs | 2 on-chain TXs |
| Gas cost | ~$1.60* | ~$0.25 | ~$7.00 | ~$0.014 |
| Latency per call | ~2s (block) | ~400ms (opt. conf.) | ~400ms | ~5ms (off-chain) |

*At $4,000 ETH or high Base congestion, the Base Exact figure rises to ~$6–13 for 1,000 calls.

**Reading this honestly:**
- x402 Exact on Solana ($0.25/1K calls) is cheaper than s402 Exact on Sui ($7.00/1K calls)
- s402 Prepaid ($0.014/1K calls) wins on total gas — but only for session-based access
- For single one-off calls, x402 on Solana is the most cost-effective option today
- s402 Prepaid's advantage scales with call volume: 10,000 calls still costs $0.014

### Methodology

This comparison is **not apples-to-apples**. x402 Exact settles every call individually. s402 Prepaid amortizes via deposit-then-claim.

**Exact-to-exact (same model):** Sui is approximately 10-20× cheaper per transaction than Base. That is real but not transformative for single calls. The structural advantage is the Prepaid model's fixed 2-transaction ceiling, which relies on Sui's shared object model. EVM payment channels (Lightning-style) achieve similar 2-transaction amortization but with different tradeoffs: bilateral channels, watchtower requirements, no on-chain usage cap enforcement.

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
