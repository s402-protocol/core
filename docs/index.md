---
layout: home
hero:
  name: s402
  text: Your AI agent needs to pay for things.
  tagline: >-
    Chain-agnostic HTTP 402 payment protocol. Six payment schemes.
    TypeScript and Python implementations — built for agents
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
    title: Tiny. Zero dependencies. Multi-language.
    details: TypeScript (~30 KB) and Python implementations. No Sui SDK, no crypto libs bundled. Import the types, build your own stack.
  - icon: 🔌
    title: Works with x402 clients today
    details: An x402 client can talk to your s402 server using the exact scheme — zero code changes. Migrate incrementally.
  - icon: 🧩
    title: Pay once, cap it, prepay, escrow, stream, or encrypt
    details: One-shot transfers for simple calls. Capped variable-amount payments. Prepaid deposits for 500x gas savings. Escrow for trustless commerce. Streams for real-time billing. Unlock for pay-to-decrypt.
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

  // 2. Build and sign a payment (you bring the chain SDK)
  const payment = await buildPayment(requirements);

  // 3. Retry with payment attached
  return fetch(url, {
    headers: { [S402_HEADERS.PAYMENT]: encodePaymentPayload(payment) },
  });
}
```

s402 defines the wire format — _what_ gets sent over HTTP. You bring your own chain SDK for the _how_ (PTB builders, signers, RPC calls).

### Python

```python
import httpx
from s402 import decode_payment_required, encode_payment_payload, S402_HEADERS

url = "https://api.example.com/premium-data"
res = httpx.get(url)
if res.status_code == 402:
    requirements = decode_payment_required(res.headers[S402_HEADERS["PAYMENT_REQUIRED"]])
    payment = build_payment(requirements)  # you bring the chain SDK
    res = httpx.get(url, headers={S402_HEADERS["PAYMENT"]: encode_payment_payload(payment)})
```

```bash
pip install s402   # Python — zero dependencies
npm install s402   # TypeScript — zero dependencies
```

---

**v0.5.0** · Six payment schemes · 831 tests · [161-vector conformance suite](/guide/conformance) · Apache-2.0 · [npm](https://www.npmjs.com/package/s402)
