# Seal Scheme

Pay-to-decrypt via [Sui SEAL](https://docs.sui.io/concepts/cryptography/seal). Combines escrow with encrypted content delivery. The buyer pays into escrow; on release, the `EscrowReceipt` unlocks SEAL-encrypted content stored on [Walrus](https://docs.walrus.site).

::: warning Status
This scheme depends on SEAL key server infrastructure and is under active development.
:::

## When to Use

- Paywalled content (articles, research, datasets)
- Digital asset sales
- Encrypted file delivery
- Any scenario where content should only be decryptable after payment

## Requirements

```typescript
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['seal'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '5000000000', // 5 SUI
  payTo: '0xseller...',
  seal: {
    encryptionId: '0xabc...',
    walrusBlobId: 'blob_xyz...',
    sealPackageId: '0xseal_pkg...',
  },
  escrow: {
    seller: '0xseller...',
    deadlineMs: String(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  },
};
```
