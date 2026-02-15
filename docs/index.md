---
layout: home
hero:
  name: s402
  text: Sui-native HTTP 402 protocol
  tagline: Wire-compatible with x402. Atomic settlement via PTBs. Five payment schemes. Zero runtime dependencies.
  actions:
    - theme: brand
      text: Quick Start
      link: /guide/quickstart
    - theme: alt
      text: View on GitHub
      link: https://github.com/s402-protocol/core
features:
  - icon: ⚡
    title: Zero Runtime Dependencies
    details: Pure TypeScript protocol definitions. No Sui SDK, no crypto libraries, no HTTP framework. 16 KB on npm.
  - icon: 🔌
    title: Wire-Compatible with x402
    details: Same HTTP headers, same base64 encoding. An x402 client can talk to an s402 server using the exact scheme with zero modifications.
  - icon: 🧩
    title: Five Payment Schemes
    details: "Exact (one-shot), Prepaid (deposit + batch-claim), Escrow (trustless commerce), Stream (per-second), Seal (pay-to-decrypt)."
  - icon: 🔒
    title: Errors That Help
    details: Every error code includes retryable (can the client try again?) and suggestedAction (what should it do?). AI agents can self-recover.
---

## 30 Seconds

```bash
npm install s402
```

```typescript
import {
  encodePaymentRequired,
  decodePaymentRequired,
  type s402PaymentRequirements,
} from 's402';

// Server: build a 402 response
const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact', 'prepaid'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000', // 0.001 SUI in MIST
  payTo: '0xrecipient...',
};

// Encode for HTTP header
const header = encodePaymentRequired(requirements);
// → base64 string for the `payment-required` header

// Client: decode the 402 response
const decoded = decodePaymentRequired(header);
console.log(decoded.accepts); // ['exact', 'prepaid']
console.log(decoded.amount);  // '1000000'
```

s402 defines _what_ gets sent over HTTP. The Sui-specific _how_ (PTB builders, signers) lives in [`@sweepay/sui`](https://github.com/SweePay/sweepay).
