---
layout: home
hero:
  name: s402
  text: Your AI agent needs to pay for things.
  tagline: >-
    The HTTP 402 payment protocol for Sui. One npm install. Five payment schemes.
    From one-shot payments to prepaid API budgets — built for agents
    that spend money autonomously.
  image:
    src: /images/hero.png
    alt: Abstract visualization of digital payment flowing through a network
  actions:
    - theme: brand
      text: Quick Start
      link: /guide/quickstart
    - theme: alt
      text: Read the Whitepaper
      link: /whitepaper
    - theme: alt
      text: Why s402?
      link: /guide/why-s402
features:
  - icon: ⚡
    title: Tiny. Zero dependencies.
    details: ~30 KB runtime. Pure TypeScript protocol layer. No Sui SDK, no crypto libs bundled. Import the types, build your own stack.
  - icon: 🔌
    title: Works with x402 clients today
    details: An x402 client can talk to your s402 server using the exact scheme — zero code changes. Migrate incrementally.
  - icon: 🧩
    title: Pay once, prepay, escrow, stream, or encrypt
    details: One-shot transfers for simple calls. Prepaid deposits for 500x gas savings. Escrow for trustless commerce. Streams for real-time billing. Unlock for pay-to-decrypt.
  - icon: 🤖
    title: Built for agents that self-recover
    details: Every error includes retryable and suggestedAction. Your agent knows whether to retry, top up, or switch schemes — no human needed.
---

## See It in Action

An AI agent hits a paid API. The server says "pay me." The agent pays and gets the data. Three HTTP requests, zero human intervention.

```typescript
import {
  extractRequirementsFromResponse,
  encodePaymentPayload,
  S402_HEADERS,
} from 's402';

async function agentFetch(url: string, buildPayment: PaymentBuilder) {
  const res = await fetch(url);

  if (res.status !== 402) return res;

  // 1. Decode what the server wants
  const requirements = extractRequirementsFromResponse(res);
  if (!requirements) throw new Error('Invalid 402 response');

  // 2. Build and sign a payment (you bring the Sui SDK)
  const payment = await buildPayment(requirements);

  // 3. Retry with payment attached
  return fetch(url, {
    headers: { [S402_HEADERS.PAYMENT]: encodePaymentPayload(payment) },
  });
}
```

s402 defines the wire format — _what_ gets sent over HTTP. You bring your own Sui integration for the _how_ (PTB builders, signers, RPC calls).

---

**v0.1.2** · Exact, Prepaid, and Escrow schemes are stable · 211 tests with property-based fuzzing · MIT licensed · [View on npm](https://www.npmjs.com/package/s402)
