# Unlock Scheme

<img src="/images/seal.png" alt="Encrypted geometric crystal with a keyhole, surrounded by clouds" style="border-radius: 12px; margin-top: 16px; margin-bottom: 24px;" />

Pay-to-decrypt via [Sui SEAL](https://docs.sui.io/concepts/cryptography/seal) and [Walrus](https://docs.walrus.site). The content stays encrypted until the buyer pays. Payment creates an escrow receipt that unlocks decryption.

::: warning Status
This scheme depends on SEAL key server infrastructure and is under active development.
:::

## When to Use

- Paywalled content (articles, research papers, datasets)
- Digital asset sales (music, art, software)
- Encrypted file delivery
- Any scenario where content should only be decryptable after payment

## How It Works

Unlock combines escrow with encrypted content delivery in a two-stage flow.

### Why Two Stages?

Sui's `seal_approve` function requires all arguments to be `Argument::Input` (not results of prior PTB commands). This means you cannot create an escrow receipt and pass it to `seal_approve` in the same transaction. The flow is split:

### Stage 1: Escrow Creation

The buyer pays into escrow via the standard 402 flow. On success, an `EscrowReceipt` is minted.

```
Buyer → Sui: "Create Escrow for seller 0xABC, amount 5 SUI"
Result: EscrowReceipt NFT on-chain
Gas: ~$0.007
```

### Stage 2: Decryption

The buyer (or facilitator) passes the `EscrowReceipt` as input to `seal_approve`. The SEAL key server verifies the receipt on-chain and releases the decryption key.

```
Buyer → SEAL: "Decrypt blob_xyz using EscrowReceipt 0x456"
SEAL key server verifies receipt → releases decryption key
Buyer decrypts content from Walrus
```

### Full Flow

```
Buyer                    Server                  SEAL Key Server    Walrus
  |--- GET /content ---->|                            |               |
  |<-- 402 + unlock reqs |                            |               |
  |                      |                            |               |
  |  (build escrow PTB)  |                            |               |
  |--- pay via escrow -->|                            |               |
  |<- receipt + blob ID -|                            |               |
  |                      |                            |               |
  |--- seal_approve -----+---> verify receipt ------->|               |
  |<-- decryption key ---+<--- key released ----------|               |
  |                      |                            |               |
  |--- fetch encrypted --+--->------------------------+---> get blob >|
  |<-- encrypted blob ---+<---------------------------+<--- blob data |
  |                      |                            |               |
  |  (decrypt locally)   |                            |               |
```

## Trust Model

- **Content stays encrypted**: The content is stored encrypted on Walrus. Without the SEAL decryption key, it is unreadable.
- **Payment unlocks decryption**: The SEAL key server only releases the key when it can verify an on-chain `EscrowReceipt` exists for the correct encryption ID.
- **Escrow protection**: The buyer's funds are in escrow, not directly transferred. The same escrow guarantees (deadline refund, optional arbiter) apply.
- **No server trust needed**: The server never sees the decrypted content during the transaction. Decryption happens client-side.

## Economics

| | Cost |
|---|---|
| Escrow creation (Stage 1) | ~$0.007 |
| SEAL decryption (Stage 2) | Free (off-chain key request) |
| Walrus blob fetch | Free (read-only) |
| Total | ~$0.007 |

Unlock is designed for one-time content purchases, not high-frequency access. For repeated access to the same content, consider [Prepaid](/schemes/prepaid) or [Exact](/schemes/exact).

## Requirements

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['unlock'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '5000000000', // 5 SUI
  payTo: '0xseller...',
  unlock: {
    encryptionId: '0xabc...',
    walrusBlobId: 'blob_xyz...',
    encryptionPackageId: '0xseal_pkg...',
  },
  escrow: {
    seller: '0xseller...',
    deadlineMs: String(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  },
};
```

## Payload

```typescript
const payload: s402UnlockPayload = {
  s402Version: '1',
  scheme: 'unlock',
  payload: {
    transaction: '<base64 signed escrow creation PTB>',
    signature: '<base64 signature>',
    encryptionId: '0xabc...',
  },
};
```

## Common Mistakes

::: danger Don't combine escrow creation and `seal_approve` in one PTB
Sui's `seal_approve` requires all arguments to be `Argument::Input`. You cannot pass the escrow receipt from a prior PTB command. This is a two-transaction flow by design — trying to combine them will fail silently.
:::

## Edge Cases

- **What if the SEAL key server is down?** The `UNLOCK_DECRYPTION_FAILED` error is retryable. The buyer can retry with a fresh session key. The escrow remains funded on-chain.
- **What if the encrypted content is corrupted?** The buyer can dispute the escrow before the deadline. If an arbiter is set, they can resolve the dispute.
- **What about large files?** Walrus handles blob storage and retrieval. File size limits depend on the Walrus network, not s402.
