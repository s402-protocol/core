# Why s402?

## The Problem

HTTP has a status code for payments: **402 Payment Required**. It has been reserved [since 1997](https://www.rfc-editor.org/rfc/rfc2068.html) but never standardized. Every API that charges money invents its own auth-key-plus-billing system, and every AI agent that needs to pay for an API call needs custom integration code for each provider.

That is a lot of glue code. And it doesn't compose.

## What HTTP 402 Should Be

```
Agent                    API Server
  |--- GET /data -------->|
  |<--- 402 + "pay me" ---|    (standard format)
  |                       |
  |  (build payment)      |
  |--- GET + payment ---->|    (standard header)
  |<--- 200 + data -------|
```

A universal payment negotiation layer. The server says how much, the client pays, the server delivers. No API keys. No billing dashboards. No monthly invoices. Just HTTP.

## Why Now

Three things converged:

1. **AI agents spend money.** LLM-powered agents make thousands of API calls per session. They need to pay programmatically, not through human-managed billing portals.

2. **Sui has sub-second finality.** Payment confirmation in ~400ms means the agent can pay and get data back in a single user-perceived request. On EVM chains, 12-second block times make this impractical.

3. **Programmable Transaction Blocks.** Sui's PTBs allow verify + settle in a single atomic transaction. No temporal gap between "looks valid" and "money moved." This eliminates an entire class of race conditions.

## What s402 Is

s402 is a wire format for HTTP 402 on Sui. It defines:

- **What goes in the headers** — base64 JSON in three headers (`payment-required`, `x-payment`, `payment-response`)
- **What the JSON looks like** — typed requirements, payloads, and responses
- **Five payment schemes** — different economics for different use cases
- **Error codes with recovery hints** — so agents can self-recover without human intervention

s402 is **not** a payment SDK. It does not include Sui SDK code, transaction builders, or RPC clients. It is a ~30 KB TypeScript package with zero runtime dependencies that defines the protocol layer. You build the Sui integration on top.

## Five Schemes, One Protocol

| Scheme | What It Does | Best For |
|--------|-------------|----------|
| [Exact](/schemes/exact) | One payment per request | Simple API calls, x402 interop |
| [Prepaid](/schemes/prepaid) | Deposit upfront, call off-chain | High-frequency APIs (500x gas savings) |
| [Escrow](/schemes/escrow) | Time-locked vault with dispute resolution | Digital goods, freelance payments |
| [Stream](/schemes/stream) | Per-second micropayments | AI inference, video, real-time data |
| [Unlock](/schemes/unlock) | Pay-to-decrypt via Sui SEAL | Paywalled content, encrypted files |

Not sure which one? See the [scheme decision guide](/guide/which-scheme).

## Wire Compatibility with x402

[x402](https://github.com/coinbase/x402) by Coinbase established HTTP 402 payments on EVM. s402 uses the **same HTTP headers and base64 encoding** — an x402 client sending an exact payment can talk to an s402 server with zero code changes.

s402 extends the format with Sui-native capabilities (additional schemes, PTB-based settlement, mandate delegation) while maintaining backward compatibility. See the [full comparison](/comparison).
