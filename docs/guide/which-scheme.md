# Which Scheme Do I Need?

Five schemes sounds like a lot. Here is how to pick the right one in 10 seconds.

## Decision Tree

```
What are you building?
│
├─ API that charges per call
│  ├─ < 10 calls/session → Exact
│  ├─ 10–10,000 calls/session → Prepaid (500x cheaper)
│  └─ Continuous / real-time → Stream
│
├─ Selling digital goods or services
│  ├─ Need buyer protection → Escrow
│  └─ Content must stay encrypted until payment → Unlock
│
└─ Need x402 interoperability → Exact (wire-compatible baseline)
```

## Comparison Table

| | Exact | Prepaid | Escrow | Stream | Unlock |
|---|---|---|---|---|---|
| **On-chain TXs per 1K calls** | 1,000 | 2 | 1 | 2 | 1 |
| **Gas cost per 1K calls** | ~$7.00 | ~$0.014 | ~$0.007 | ~$0.014 | ~$0.007 |
| **Latency per call** | ~400ms | ~5ms | N/A | ~5ms | N/A |
| **Setup complexity** | None | Deposit TX | Deposit TX | Deposit TX | Deposit TX + SEAL |
| **Trust model** | Atomic | On-chain rate caps | Time-lock + arbiter | On-chain meter | Escrow + encryption |
| **x402 compatible** | Yes | No | No | No | No |
| **Best for** | Simple APIs | High-frequency APIs | Digital commerce | Real-time billing | Encrypted content |

## Quick Recommendations

**"I am building an AI agent that calls APIs."**
Start with **Exact** for prototyping. Switch to **Prepaid** when you need to make more than ~10 calls per session — you will save 500x on gas.

**"I am selling digital goods."**
Use **Escrow**. The buyer's funds are locked until they confirm delivery. If the seller disappears, the deadline triggers an automatic refund.

**"I am selling encrypted content (articles, datasets, files)."**
Use **Unlock**. The content stays encrypted on Walrus until the buyer pays. Payment unlocks decryption via Sui SEAL.

**"I need real-time billing (AI inference, video streaming)."**
Use **Stream**. The client deposits funds, the server claims per-second as the session runs.

**"I need to work with existing x402 clients."**
Use **Exact**. It is wire-compatible with x402 V1. No code changes needed on the client side.

## Still Not Sure?

Start with [Exact](/schemes/exact). It is the simplest scheme, works with x402, and you can always add Prepaid or other schemes later. The `accepts` array in payment requirements lets your server advertise multiple schemes — clients pick the best one they support.
