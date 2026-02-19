# s402: An Internet-Native Payment Protocol for Autonomous Agents

**Version 1.0 · February 2026 · Swee Group LLC**

---

## Abstract

The internet has contained a payment instruction for twenty-nine years. Since 1997, every browser and every server has shipped with HTTP status code 402 — "Payment Required" — reserved, standardized, never implemented. The infrastructure didn't exist. There was no way to move money at internet speed, at internet cost, without a financial institution in the middle.

Now there is.

s402 is an open protocol that activates HTTP 402 on the Sui blockchain, defining a wire format for machine-to-machine payments that is fast enough for a real-time conversation (~400ms finality), cheap enough for micropayments ($0.014 per thousand API calls), and rich enough for the full spectrum of commercial relationships AI agents need: one-shot transfers, prepaid budgets, trustless escrow, per-second streaming, and pay-to-decrypt content. s402 extends x402 (Coinbase, 2025) with Sui-native capabilities while maintaining full wire compatibility with existing x402 clients.

The agent economy is here. This is its payment layer.

---

## 1. The 27-Year Promise

> "This status code is reserved for future use."
> — RFC 2068, Section 10.4.3, January 1997

HTTP 402 was a bet on the future. The architects of the web foresaw a world where resources could be monetized directly through the protocol — no subscription portals, no API key dashboards, no billing integrations. Just a standard signal: *this costs money, here's how to pay.*

The bet was right. The infrastructure wasn't ready.

In 1997, "digital payments" meant credit cards over SSL, processing fees of 2-3%, and settlement windows of 2-5 business days. There was no native concept of sub-cent amounts. You cannot build a micropayment system on that foundation. So HTTP 402 sat in the spec, acknowledged and unused, for twenty-eight years — present in every browser, every server, every HTTP library ever shipped. Infrastructure waiting for a moment that hadn't arrived.

Two things changed in 2025. First, Coinbase launched x402 — the first serious protocol to implement HTTP 402 at scale. Within months, x402 had processed over 100 million payments, attracted Cloudflare and Stripe integrations, and spawned a Foundation. The proof of concept was decisive: HTTP payments work. Agents, scripts, and services can exchange payment and receive data in a single round-trip.

Second, the agent economy arrived — not as a research concept, but as deployed infrastructure. AI agents were making thousands of API calls per session, booking services, processing data, orchestrating other agents. McKinsey projects the global agentic commerce market at $3–5 trillion by 2030. These agents need to pay for things. And they need to do it without a human entering a credit card number.

x402 proved the model. But proof of concept is not the same as production infrastructure. The economics exposed a deeper problem.

---

## 2. The Economics of Per-Call Settlement

x402's architecture inherits EVM's payment model: every API call requires an on-chain transaction. At scale, this creates a structural cost problem.

Consider an AI agent making 1,000 API calls priced at $0.001 each — a common usage pattern for data enrichment, content moderation, or embedding generation. Gas costs on Base vary with ETH price and network congestion; the table below uses conservative current figures:

| | x402 Exact on Base |
|---|---|
| API value (1,000 × $0.001) | $1.00 |
| Gas fees (1,000 × ~$0.0016/tx)* | ~$1.60 |
| **Total cost** | **~$2.60** |
| **Gas-to-value ratio** | **~1.6×** |

*At Base gas price of 0.012 Gwei and ETH at ~$2,000 (February 2026). At higher ETH prices or congestion — $4,000 ETH and 0.05 Gwei — the same 1,000 calls cost ~$13 in gas, a 13× overhead. Gas costs on EVM are volatile by design.*

Gas overhead of 1.6× to 13× the API value is a real economic constraint, not a minor inconvenience. When gas can exceed the value being transacted, the model breaks for high-frequency low-value use cases. Reducing call volume helps but doesn't fix the fundamental problem: every discrete API call requires its own on-chain settlement.

### x402 V2 and the Extensions Model

In December 2025, x402 launched V2, which formalizes an Extensions system and adds multi-chain support (Base, Solana, and traditional payment rails via the x402 Foundation). V2 makes "subscription-like and session-based access patterns possible" through application-layer conventions — a meaningful step toward the same problem space s402 addresses.

The architectural distinction: x402 V2's session patterns are implemented at the application layer, with behavior negotiated between client and server. s402's Prepaid scheme encodes the rate cap and deposit ceiling directly in a Move smart contract on Sui — the constraints are protocol-enforced on-chain, not application-layer conventions. A provider cannot overclaim past `maxCalls × ratePerCall` because the contract prevents it, not because a policy says so.

Both approaches are valid. The choice depends on whether on-chain enforcement of usage caps matters for your trust model.

### The Structural Problem

Regardless of x402's evolution, the per-call settlement model has a fundamental ceiling: every call that requires finality confirmation requires an on-chain transaction. The ceiling is the chain's transaction cost floor multiplied by call volume. On Solana, x402 already achieves ~$0.00025/tx — making 1,000 calls cost ~$0.25 in gas. That is a real improvement. But it still scales linearly with call count.

s402's Prepaid scheme breaks this linearity: two transactions regardless of call count.

---

## 3. Why Now: The Convergence

The conditions for s402 don't exist on every blockchain. They exist on Sui specifically, and they converged in 2025-2026. Three capabilities made the difference.

**Programmable Transaction Blocks (PTBs).** A PTB is a single atomic transaction that encodes multiple operations — reads, writes, condition checks — that either all succeed or all fail together. For payment protocols, this eliminates the most dangerous gap in settlement: the window between "payment verified" and "payment settled." On EVM, this gap is irreducible — verification is a read operation (off-chain simulation), settlement is a write operation (on-chain broadcast). Something can change between them. On Sui, verification and settlement execute atomically in one PTB. Either the payment goes through or it doesn't, with no intermediate state.

**Sub-second finality.** Sui's Mysticeti consensus achieves full transaction finality in approximately 390–480ms for standard transactions. Base (where x402 primarily runs) confirms blocks in ~2 seconds. Solana achieves optimistic confirmation in ~400ms — comparable to Sui — though full finality takes ~13 seconds. For payment protocols, the meaningful threshold is whether finality fits within a single request-response cycle. At ~400ms, payment + resource delivery happens in one perceptible moment. At 2 seconds, it requires user-visible latency. Note: Sui's shared-object transactions (required by Prepaid and Escrow) go through consensus and may take longer than owned-object transactions. The 400ms figure reflects owned-object and simple transfer performance.

**Shared objects and the prepaid model.** Sui's object model allows multiple parties to interact with the same on-chain object concurrently. This is what enables s402's Prepaid scheme: a `PrepaidBalance` shared object that an agent deposits into once and a provider incrementally claims against across thousands of off-chain API calls. The result: **two on-chain transactions for 1,000 API calls**, instead of 1,000.

| | s402 Prepaid on Sui |
|---|---|
| API value (1,000 × $0.001) | $1.00 |
| Gas: 1 deposit + 1 claim | $0.014 |
| **Total cost** | **$1.014** |
| **Gas-to-value ratio** | **1.4%** |

This is not a modest improvement. It is a phase transition. APIs that were economically impossible to operate at scale — because gas overhead would exceed revenue — become viable. New categories of services become buildable. The agent economy's unit economics change.

### What About EVM Payment Channels?

EVM has a well-established answer to the per-call gas problem: state channels and payment channels (Lightning-style). A client and server open a channel, make thousands of off-chain payments, and settle the net result on-chain in two transactions — structurally similar to s402's Prepaid in terms of on-chain transaction count.

The tradeoffs are real and worth stating honestly:

- **Channel must be pre-funded** per counterparty — no single shared balance across multiple clients
- **Watchtower requirement** — channels need monitoring to prevent stale-state fraud
- **No on-chain usage cap enforcement** — the usage ceiling is an off-chain agreement, not a contract constraint
- **No concurrent multi-client sharing** — each channel is bilateral, not a shared object multiple parties interact with

s402 Prepaid achieves similar gas economics (2 transactions for many calls) with on-chain contract enforcement of rate caps, no watchtower dependency, and a shared balance multiple agents can deposit into independently. The distinction is architectural: Sui's shared object model enables a multi-client prepaid balance in a way that bilateral EVM payment channels cannot replicate.

The convergence of PTBs, sub-second finality, and the shared object model is specific to Sui's architecture. The protocols are complementary — x402 on Base or Solana for their ecosystems, s402 on Sui for its unique capabilities.

---

## 4. Protocol Architecture

s402 defines a wire format, not a settlement engine. The package (`s402` on npm) contains TypeScript types, HTTP header encoding and decoding, a scheme dispatcher, and a machine-native error model. Zero runtime dependencies. No Sui SDK bundled. The protocol layer is approximately 2,000 lines of TypeScript — auditable in an afternoon.

### The Three-Actor Model

Every s402 interaction involves three roles:

```
┌──────────┐     ┌──────────────────┐     ┌──────────────┐
│  Client   │────▶│  Resource Server  │────▶│  Facilitator │
│  (payer)  │◀────│  (payee)         │◀────│  (settler)   │
└──────────┘     └──────────────────┘     └──────────────┘
```

The **Client** (an AI agent, a script, a browser) wants a resource. The **Resource Server** has the resource and knows what it costs. The **Facilitator** verifies the payment is valid and broadcasts it to Sui. In direct settlement mode — for agents with signing keys — the Client and Facilitator roles collapse into one: the agent pays directly without an intermediary.

### The Wire Format

s402 uses the same three HTTP headers as x402, which is the source of their wire compatibility:

| Header | Direction | Content |
|---|---|---|
| `payment-required` | Server → Client | Base64-encoded payment requirements (in 402 response) |
| `x-payment` | Client → Server | Base64-encoded signed payment payload (in retry request) |
| `payment-response` | Server → Client | Base64-encoded settlement result (in 200 response) |

A 402 response from an s402 server looks identical to a 402 response from an x402 server to any client that doesn't inspect the JSON structure. An x402 client sending an exact payment can interact with an s402 server with zero code changes. This is the foundation of the ecosystem bridge.

### Validation at Trust Boundaries

Every decode function validates incoming data and strips unknown fields before returning typed objects. The principle is **allowlist, not blocklist**: unknown keys from HTTP headers are silently dropped, never rejected with errors that would reveal internal structure. Once data passes the decode boundary, TypeScript types can be trusted. Before that, everything is `unknown`.

The facilitator's `process()` method enforces three independent guards: an expiration check before verification (don't waste RPC calls on stale requirements), a type guard on the `expiresAt` field (defend against `"never"` string bypass attacks where `Date.now() > "never"` evaluates to `false` in JavaScript), and an expiration re-check after verification (don't broadcast transactions the server has already invalidated). Each guard is independent — any one can fail without relying on the others.

---

## 5. Five Irreducible Payment Primitives

s402 defines five payment schemes. The number is not arbitrary — each encodes a distinct class of economic relationship that cannot be expressed as another scheme plus additional logic.

### Exact — The Handshake

One payment, one resource. A signed transaction transfers value atomically from client to server via a PTB. Settlement is immediate. The facilitator verifies the signature, runs a dry-run simulation, and broadcasts the transaction in a single atomic operation.

This is x402's model, made atomic by Sui's PTBs. Use it for simple API calls, for x402 interoperability, for situations where the per-call cost is acceptable. The gas cost is approximately $0.007 per request — negligible when each request carries meaningful value.

### Prepaid — The Budget

The agent deposits into an on-chain `PrepaidBalance` shared object. Subsequent API calls are authorized off-chain: the server tracks usage locally and serves responses without a chain operation per call. The provider batch-claims accumulated usage in a single transaction at the end of the session.

The economics: deposit TX + claim TX = **$0.014 total gas for arbitrarily many API calls** within the deposited balance.

**Trust model — stated precisely.** The Move contract enforces two hard ceilings: `claimed ≤ maxCalls × ratePerCall` and `claimed ≤ deposited amount`. This is a ceiling, not an exact count. A provider can claim up to the cap regardless of actual calls served — the contract enforces the maximum, not the exact amount. The client's protections are: (1) the on-chain rate cap limits what can be claimed per time window; (2) the deposit ceiling sets the absolute maximum; (3) a configurable withdrawal delay gives the client a window to reclaim unused funds before the provider claims.

For most commercial relationships this model is sufficient — overclaiming would mean billing for services not rendered, which is a business risk, not just a protocol one. For adversarial zero-trust relationships, Escrow is the appropriate scheme.

One implementation note: if a provider runs multiple server instances, off-chain usage tracking must be coordinated across instances to prevent concurrent sessions from double-authorizing against the same balance. This is an implementation concern, not a protocol-level guarantee s402 makes.

For the agent economy, Prepaid is the most important scheme for high-frequency access. It only works at this economics because Sui's shared objects enable a multi-client deposit balance — multiple independent agents can deposit concurrently into one shared balance. Bilateral EVM payment channels are point-to-point and cannot replicate this pattern.

### Escrow — The Contract

A buyer deposits into a time-locked on-chain `Escrow` object. The seller delivers work or content. The buyer confirms receipt (the happy path), or the deadline passes triggering a permissionless refund, or either party invokes an optional arbiter for dispute resolution.

The permissionless refund path requires no trusted intermediary: after the deadline, anyone can trigger the refund function on-chain. If an arbiter is configured, disputes can be escalated to that party — but the arbiter is optional, and without one, the only resolution paths are buyer-confirms or deadline-expires. An arbiter is a trusted third party and should be chosen accordingly; the protocol does not select or vet arbiters.

This is trustless commerce for the agent economy — an agent commissioning work from another agent can do so with a provably safe exit path that does not require trusting the counterparty to honor an agreement.

### Stream — The Meter

An on-chain `StreamingMeter` maintains a deposit and a configured rate per second. The agent includes the stream ID in request headers; the server grants access as long as the meter balance is positive. The provider accumulates value and claims in batches.

Per-second billing for AI inference, real-time data feeds, continuous audio/video — the use cases where the economic relationship is fundamentally continuous, not discrete. The on-chain clock is the authority. No server-side billing logic, no metering infrastructure to build, no invoice disputes.

### Unlock — The Vault

Content is encrypted at rest using Sui SEAL and Walrus distributed storage. Payment releases the decryption key atomically — the key server releases only after verifying on-chain payment evidence. There is no window where the buyer has the ciphertext but not the key, or the seller has the payment but the key hasn't been released. Pay-and-decrypt is a single operation.

This scheme is for information commerce: paywalled research, encrypted datasets, licensed software, proprietary model weights. Once information is disclosed, it cannot be undisclosed — the atomic payment model is not a convenience but a correctness requirement.

### Why Not Six?

The auction mechanism was considered and rejected. An auction decomposes into price discovery (a coordination problem, not a payment primitive) plus settlement (one of the five existing schemes). The `extensions` field allows auction price signals to be included in requirements without s402 encoding the coordination logic. Primitives that decompose are not primitives.

---

## 6. Economic Analysis

### The Gas Comparison

Gas costs are volatile and depend on ETH price and network congestion. The figures below use February 2026 spot prices: Base at 0.012 Gwei / ETH at ~$2,000; Solana at ~$0.00025/tx. Sui Prepaid at 2 transactions fixed.

| Scenario | x402 Exact (Base)* | x402 Exact (Solana) | s402 Exact (Sui) | s402 Prepaid (Sui) |
|---|---|---|---|---|
| 1 API call | ~$0.0016 | ~$0.00025 | ~$0.007 | ~$0.000014 amortized |
| 100 calls | ~$0.16 | ~$0.025 | ~$0.70 | $0.014 total |
| 1,000 calls | ~$1.60 | ~$0.25 | ~$7.00 | $0.014 total |
| 10,000 calls | ~$16.00 | ~$2.50 | ~$70.00 | $0.014 total |

*Base gas is highly sensitive to ETH price. At $4,000 ETH and 0.05 Gwei congestion, Base Exact at 1,000 calls approaches ~$13.

**Reading the table honestly:** x402 Exact on Solana ($0.25 for 1,000 calls) is cheaper than s402 Exact on Sui ($7.00 for 1,000 calls). The Prepaid scheme ($0.014) wins on total gas economics — but only for session-based access where the 2-transaction model applies. For single one-shot calls, x402 on Solana is the cheapest option available today.

The structural advantage of s402 Prepaid is not the per-transaction cost — it is the **fixed overhead regardless of call volume**, enforced by an on-chain contract. 10,000 calls costs the same $0.014 as 100 calls.

### What Becomes Economically Viable

When API infrastructure overhead approaches zero, a new class of services becomes buildable:

- **Sub-cent embeddings** — pay per vector, not per batch job or monthly subscription
- **Real-time data feeds** — per-second pricing for market data, sensor telemetry, AI inference outputs
- **Micropayment content** — single-article access at $0.001, without subscription friction
- **Agent orchestration markets** — agents hiring agents at fractions of a penny, with escrow protection
- **Trustless automation** — escrow-backed agent-to-agent work contracts with permissionless exit

The economic unlock is not just cost reduction. It is the enablement of business models that didn't exist before because the infrastructure overhead made them impossible. When the marginal cost of a payment approaches the cost of an HTTP request, the payment protocol stops being a constraint and becomes infrastructure.

---

## 7. Machines First: The Error Model

Human-facing payment errors are designed to be read by people. Agent-facing errors need to be processed by code.

s402's error model has three fields, each optimized for programmatic consumption:

```typescript
{
  code: 'INSUFFICIENT_BALANCE',       // Enum: what went wrong
  retryable: boolean,                 // Boolean: retry or escalate?
  suggestedAction: string             // String: what to do next
}
```

An agent encountering `INSUFFICIENT_BALANCE` with `retryable: false` knows not to retry — it should top up its wallet or attempt a smaller amount. An agent encountering `FINALITY_TIMEOUT` with `retryable: true` knows its transaction was submitted but unconfirmed — rechecking finality before retrying is correct. An agent encountering `FACILITATOR_UNAVAILABLE` knows it can attempt direct settlement if it holds signing keys.

Agents branch on booleans. Agents read strings for LLM context. Agents do not parse error messages. Fourteen error codes cover the full state space of payment failures, each with documented semantics.

### Mandate Delegation (AP2-Aligned)

Beyond errors, agents need bounded authorization — a way for a human principal to grant an agent spending authority without unlimited wallet access.

AP2 (Agent Payments Protocol) is an open standard from Google Cloud, backed by more than 60 organizations including payment networks, AI providers, and financial institutions. AP2 defines cryptographically-signed "mandates" as the mechanism for recording and proving what a user authorized an agent to spend — covering intent, scope, and limits.

s402's mandate system aligns with AP2 principles: mandate requirements are declared in the `payment-required` header's `mandate` field, specifying whether a mandate is required and minimum per-transaction amounts. Mandate authorization is represented on-chain as a Sui object (`mandateId`), enabling **trustless revocation**: a principal revokes authorization by invalidating the on-chain mandate object — no server needs to be informed, no off-chain state updated. Any server checking the mandate will see it is invalid.

This is the infrastructure for trust in autonomous systems: not removing human oversight, but making it cryptographically auditable and autonomously enforceable.

---

## 8. Security Model

### Three Independent Validation Boundaries

Security is enforced at decode time, not at call time. Three independent boundaries ensure that untrusted network data never reaches business logic without validation:

1. **Wire decode** — Base64 decode, JSON parse, shape validation, allowlist field stripping. Unknown keys from the network are dropped. Malformed payloads throw typed errors before any logic runs.

2. **Facilitator dispatch** — Expiration guard, type guard on `expiresAt`, scheme mismatch check (payload scheme must be in requirements' `accepts` array), latency re-check after dry-run. Each guard is independent and fails explicitly.

3. **Scheme verification** — Scheme-specific logic: signature recovery, dry-run simulation, balance checks, rate validation. Each scheme implements its own `verify()` — there is no shared verification code, which means there is no shared code path to bypass.

### The Trust Spectrum

s402 provides a spectrum of trust models rather than a single approach, because different commercial relationships require different guarantees:

| Scheme | Trust model |
|---|---|
| Prepaid | Trust-bounded: server tracks call count off-chain; on-chain rate cap and withdrawal delay enforce the ceiling |
| Stream | Trust-bounded: on-chain budget cap is the hard limit; server billing logic operates within it |
| Escrow | Trustless: permissionless refund path requires no trusted intermediary |
| Exact | Atomic: PTB execution eliminates the verify/settle temporal gap |

The appropriate scheme is chosen by the trust relationship between parties, not by the security requirement alone. Escrow is not more secure than Prepaid — it is the correct model for zero-trust counterparty relationships.

### Audit History

s402 v0.1.1 (February 2026) addressed findings from an internal security audit: `expiresAt` type enforcement to defend against string bypass attacks; sub-object field stripping at wire decode to defend against prototype pollution; scheme mismatch guard in the facilitator to prevent cross-scheme attacks; exception wrapping in `settle()` to prevent uncaught scheme errors from crashing the facilitator. Each finding was addressed with defense-in-depth rather than point fixes.

---

## 9. x402 Compatibility

s402 is designed to work within the existing x402 ecosystem. Wire compatibility is a first-class property, not an afterthought.

An x402 V1 client making an exact payment can interact with an s402 server — the `payment-required` and `x-payment` headers are structurally identical in the exact scheme. An s402 client detects which protocol a server is using via the `detectProtocol()` function, which checks for `s402Version` in decoded requirements. x402 V1 and V2 formats normalize into s402 types via the optional `s402/compat` layer. Note: x402 V2 renamed the client payment header to `payment-signature`; s402 uses `x-payment` (V1-compatible). The compat layer handles this normalization, but x402 V2 clients communicating natively require the compat layer on the s402 side.

**x402 V2 in context:** x402's December 2025 V2 release adds multi-chain support (Base, Solana, and traditional payment rails), formalized Extensions for session-based and subscription-like patterns, and Google, Cloudflare, and Visa as x402 Foundation members. This is a significant step. s402's differentiation from V2 lies in protocol-layer enforcement: s402's Prepaid and Stream schemes are Move contracts with on-chain rate caps; x402 V2's session patterns are application-layer conventions. Both are valid architectures with different trust guarantees.

The compat package is a deliberate sub-path import (`s402/compat`), not part of the main barrel export. The framing: x402 serves Base, Solana, and traditional rails. s402 serves Sui's unique capabilities. The protocols are complementary.

---

## 10. Implementation

The `s402` npm package (v0.1.5, MIT licensed) is the protocol layer:

- **2,079 lines** of TypeScript — types, encoding logic, scheme dispatch, error model
- **2,915 lines** of tests — 207 total, including property-based fuzzing with arbitrarily generated payloads
- **Zero runtime dependencies** — pure TypeScript using only built-in APIs (`TextEncoder`, `btoa/atob`, `JSON`)
- **Sub-path exports** — import only what you need: `s402/types`, `s402/http`, `s402/errors`, `s402/compat`

The layered architecture:

```
Discovery layer             — Service registry; agents find services to pay for
SDK / DX layer              — React hooks, middleware, retry logic (bring your own)
Sui implementation layer    — PTB builders, transaction types, gas station
s402 (this package)         — Protocol: wire format, types, HTTP encoding, dispatch
Sui                         — Chain: objects, PTBs, sub-second finality
```

s402 is intentionally the narrowest layer. The Sui SDK integration, transaction builders, developer experience abstractions — all of that lives above the protocol. Any team can implement s402 schemes using their own Sui SDK. This keeps the core auditable, chain-agnostic in principle, and free from transitive supply chain risk.

---

## 11. The Vision: Autonomous Commerce

RFC 2068 reserved a status code because its authors believed the internet would eventually need native payments. They were right. They were twenty-nine years early.

The agent economy changes the timeline.

When software agents are the primary economic actors on the internet — buying compute, purchasing data, hiring other agents, paying for APIs at scale — the absence of a native payment protocol is not an inconvenience. It is a structural bottleneck. Every agent that needs to pay for something either relies on a human-managed API key (which doesn't scale) or builds a custom payment integration (which doesn't compose). The result is a payment infrastructure built of fragile, proprietary integrations that cannot be composed, discovered, or audited.

s402 is a protocol, which means it is an agreement. When a server responds with a 402 and a standard payment requirement, any compliant client can fulfill that requirement without prior knowledge of the server's billing system. Agents can discover, evaluate, and transact with services they've never interacted with before — because the payment protocol is standardized, not proprietary.

The immediate horizon: AI agents paying for inference APIs, data feeds, content access, and compute — at economics that actually work. The medium horizon: agents commissioning other agents for specialized work — orchestration markets where capabilities are traded on-demand, with economic contracts that don't require human approval of each transaction. The longer horizon: a dense mesh of agent-to-agent economic activity where the payment protocol recedes into infrastructure, as invisible and as critical as TCP/IP.

SweeWorld is the first marketplace built on s402: a discovery layer where services advertise their payment endpoints and agents find them. But the protocol is not owned by the marketplace. s402 is open, MIT-licensed, and implementable by anyone. The bet is not on a platform. The bet is on the protocol layer — the same bet the internet made on TCP/IP, on HTTP, on TLS.

In 1997, the architects of HTTP wrote: *"This status code is reserved for future use."*

The future is using it now.

---

## References

**HTTP Standards**
- RFC 2068 — Hypertext Transfer Protocol HTTP/1.1 (Fielding et al., January 1997)
- RFC 7235 — Hypertext Transfer Protocol: Authentication (Fielding & Reschke, June 2014)
- MDN Web Docs — 402 Payment Required (developer.mozilla.org)

**x402 Protocol**
- Coinbase Developer Platform — Introducing x402 (May 2025)
- x402.org — Protocol documentation and ecosystem statistics (2025–2026)
- x402 V2 Launch Announcement — x402.org/writing/x402-v2-launch (December 2025)
- x402 Foundation — Members include Google, Cloudflare, Visa (2025–2026)
- BeInCrypto — x402 Transaction Volume Analysis (February 2026)
- Stripe — AI Agents and x402 on Base (2025)
- Solana.com — x402 on Solana

**Sui Blockchain**
- Sui Documentation — Programmable Transaction Blocks (docs.sui.io)
- Sui Documentation — Object Model and Shared Objects (docs.sui.io)
- Mysten Labs — The Sui Smart Contracts Platform
- Sui Blog — Performance Update: Mysticeti Consensus (2024)

**Agent Economy & Authorization**
- McKinsey Global Institute — The Agentic Commerce Opportunity: $3–5 Trillion by 2030 (2025)
- Google Cloud — Announcing Agent Payments Protocol (AP2) (2025)
- AP2 GitHub — google-agentic-commerce/AP2
- Circle — Machine-to-Machine Micropayments with USDC (2025)
- FinTech Brain Food — The Agentic Payments Map (2025)

**Gas Cost Data (February 2026)**
- BaseScan Gas Tracker — basescan.org/gastracker (0.012 Gwei, February 2026)
- Base Network Fees Documentation — docs.base.org
- Solana Transaction Fees — solana.com/docs/core/fees (~$0.00025/tx)

**s402 Implementation**
- s402 npm package v0.1.4 — npmjs.com/package/s402
- s402 Protocol documentation — s402-protocol.org
- s402 Source repository — github.com/s402-protocol/core

---

*s402 v1.0 · February 2026 · © Swee Group LLC · MIT License*

*s402-protocol.org*
