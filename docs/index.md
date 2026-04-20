---
layout: home
hero:
  name: s402
  text: Your AI agent needs to pay for things.
  tagline: >-
    The chain-agnostic HTTP 402 protocol for AI agents.
    Superset of x402 and MPP — same price or cheaper where
    they overlap, six payment schemes where they can't.
    TypeScript, Python, Go.
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
  - icon: 🧭
    title: Superset of x402 and MPP
    details: Speaks x402 V1/V2 and MPP as payment-in formats, plus five schemes they structurally can't express. An agent that picks s402 gets every option the others offer, plus the ones they don't.
  - icon: 💸
    title: Same price or cheaper for agents
    details: Wire-compatible schemes match competitors at parity. Prepaid on Sui hits $0.014 per 1,000 calls — 500× savings on session-based access. No reason for an agent not to route through s402.
  - icon: 🧩
    title: Six payment schemes, one protocol
    details: Exact for one-shot. Upto for metered. Prepaid for high-frequency. Escrow for trustless commerce. Stream for per-second billing. Unlock for pay-to-decrypt. Sui happens to be the most expressive chain — every scheme lands natively.
  - icon: 🤖
    title: Built for agents that self-recover
    details: Every error includes `retryable` and `suggestedAction`. Your agent knows whether to retry, top up, or switch schemes — no human needed. Zero runtime deps. TypeScript, Python, Go.
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

## Start Where You Are

<div class="stakeholder-grid">

**🤖 I'm building an AI agent**
Need to pay for APIs, tools, or inference. Start with the [Quick Start](/guide/quickstart) to wire a client in 5 minutes, then read [Which Scheme Do I Need?](/guide/which-scheme) to pick between Exact, Upto, and Prepaid.

**🏗 I run a paid API**
Want agents to pay you directly — no billing dashboards, no API keys. See the [server tutorial](/guide/tutorial) for a 402 endpoint in 20 lines, then [Fee Ownership & Trust](/guide/fee-ownership) for who pays gas.

**🦊 I build a wallet or SDK**
Need to speak s402 from a client library. Start with the [Wire Format Spec](/specification) and the [161-vector conformance suite](/guide/conformance). TypeScript, Python, Go adapters exist today.

**⚙️ I operate a facilitator**
Running verify/settle infra for a chain or scheme. Read the [Architecture](/architecture) page for the facilitator contract, then [Security Model](/security) for invariants you must preserve.

**🔎 I'm auditing or researching**
Evaluating s402 for production or academic work. Start with the [Whitepaper](/whitepaper), [Threat Model](/THREAT_MODEL), and the [three-way comparison](/comparison) against x402 and MPP.

**🔁 I'm migrating from another protocol**
Already running x402 or MPP. See [Migrating from x402](/guide/upgrade-x402) (one-line middleware swap) or [Migrating from MPP](/guide/upgrade-mpp) (coexistence pattern, no rip-and-replace).

</div>

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
