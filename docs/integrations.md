---
description: Language adapters, framework integrations, chain SDKs, and compat layers for s402. TypeScript, Python, and Go today; Rust on the roadmap. Matrix of what ships where.
---

# Integrations

s402 is a wire format — three HTTP headers with base64 JSON payloads. Anything that can send HTTP can speak it. This page maps the official adapters and framework integrations maintained by Swee Group.

## Language SDKs

| Language | Package | Status | What it ships |
|---|---|---|---|
| **TypeScript / JavaScript** | [`s402`](https://www.npmjs.com/package/s402) | ✅ Production | Full protocol: types, headers, schemes, errors, compat layer. Zero runtime deps. |
| **Python** | [`s402`](https://pypi.org/project/s402/) | ✅ Production | Full protocol parity with TS. `decode_payment_required`, `encode_payment_payload`. |
| **Go** | `s402-go` | 🟡 Beta | Server-side decode + `net/http` middleware. Client signing planned. |
| **Rust** | `s402-rs` | 📋 Planned | Tracked for v0.4. Target: axum + reqwest integration. |

All official SDKs ship the same wire format and pass the same [161-vector conformance suite](/guide/conformance).

```bash
# TypeScript
npm install s402
pnpm add s402

# Python
uv pip install s402
pip install s402

# Go
go get github.com/s402-protocol/s402-go
```

## Chain Adapters

s402 is chain-agnostic. The protocol layer contains no chain-specific logic (see [S7 invariant](https://github.com/s402-protocol/core/blob/main/AGENTS.md)). Chain integration lives in separate packages that provide PTB builders, signers, and RPC helpers.

| Chain | Package | Status | Schemes supported |
|---|---|---|---|
| **Sui** | [`@sweefi/sui`](https://www.npmjs.com/package/@sweefi/sui) | ✅ Production | All six (Exact, Upto, Prepaid, Escrow, Stream, Unlock) |
| **EVM (via compat)** | `s402/compat` | ✅ Production | Exact, Upto — reads x402 V1/V2 payloads natively |
| **Tempo (via compat)** | `s402/compat-mpp` | 📋 v0.3 roadmap | Charge ↔ Exact, Session ↔ Prepaid |
| **Solana** | — | 📋 Community | Open for contributions |
| **Aptos** | — | 📋 Community | Open for contributions |

**Sui is the most expressive chain.** It's the only chain today where all six schemes land natively — Unlock requires SEAL threshold crypto + Walrus storage, Stream and Prepaid benefit from PTB atomic settlement, and Escrow leverages Sui's object ownership model. EVM chains can run Exact and Upto today via the compat layer.

## Server Framework Integrations

Drop-in middleware for popular HTTP frameworks.

| Framework | Package | Status | Pattern |
|---|---|---|---|
| **Hono** | [`@sweefi/server`](https://www.npmjs.com/package/@sweefi/server) | ✅ Production | `s402Gate({ ... })` middleware |
| **Express** | [`@sweefi/server`](https://www.npmjs.com/package/@sweefi/server) | ✅ Production | Same `s402Gate` — framework-agnostic |
| **Fastify** | [`@sweefi/server`](https://www.npmjs.com/package/@sweefi/server) | ✅ Production | Wraps standard `Request`/`Response` |
| **Next.js API routes** | [`@sweefi/server`](https://www.npmjs.com/package/@sweefi/server) | ✅ Production | Works in Route Handlers |
| **FastAPI (Python)** | `s402[fastapi]` | 🟡 Beta | Dependency injection pattern |
| **Flask (Python)** | `s402[flask]` | 🟡 Beta | `@require_payment` decorator |
| **net/http (Go)** | `s402-go` | 🟡 Beta | Standard `http.Handler` wrapper |
| **Axum (Rust)** | — | 📋 Planned | Tracked with Rust SDK |

## Client Framework Integrations

For building wallet UIs, payment modals, and agent-facing clients.

| Framework | Package | Status | What it provides |
|---|---|---|---|
| **Vue 3** | [`@sweefi/vue`](https://www.npmjs.com/package/@sweefi/vue) | ✅ Production | `useSweefiPayment()` composable + Pinia plugin |
| **React** | [`@sweefi/react`](https://www.npmjs.com/package/@sweefi/react) | ✅ Production | `useSweefiPayment()` hook + context provider |
| **Vanilla JS** | [`@sweefi/ui-core`](https://www.npmjs.com/package/@sweefi/ui-core) | ✅ Production | State machine + `PaymentAdapter` interface |
| **Svelte** | — | 📋 Community | Built on `@sweefi/ui-core` — contributions welcome |
| **Solid** | — | 📋 Community | Built on `@sweefi/ui-core` |

## Agent Runtime Integrations

| Runtime | Package | Status | Pattern |
|---|---|---|---|
| **MCP (Model Context Protocol)** | [`s402-mcp`](https://www.npmjs.com/package/s402-mcp) | ✅ Production | MCP server exposing `s402.pay` and `s402.buy` tools |
| **LangChain (TS)** | — | 📋 Planned | Tool wrapper, tracked for v0.4 |
| **LangGraph** | — | 📋 Planned | Checkpointed agent budgets |
| **CrewAI** | — | 📋 Community | Python `s402` core is the building block |

The MCP integration is the production path for AI coding assistants (Claude Code, Cursor, Windsurf) and general-purpose agents using MCP-compatible runtimes.

## Compat Layers

The compat layers let existing x402 and MPP traffic flow through an s402 server unchanged.

| Source protocol | s402 module | Status | What it handles |
|---|---|---|---|
| **x402 V1** | `s402/compat` | ✅ Production | `x-payment` header, base64 JSON, `exact` scheme |
| **x402 V2** | `s402/compat` | ✅ Production | Multi-chain extensions, new error shapes |
| **MPP Charge** | `s402/compat-mpp` | 📋 v0.3 roadmap | 4-tier credential hierarchy: permit2 / authorization / transaction / hash |
| **MPP Session** | `s402/compat-mpp` | 📋 v0.3 roadmap | Cumulative voucher ↔ Prepaid translation |
| **MPP `Accept-Payment`** | core `s402` | 📋 v0.3 roadmap | q-value parsing, scheme negotiation ([DAN-341](https://linear.app/dannydevs/issue/DAN-341)) |

See [Migrating from x402](/guide/upgrade-x402) and [Migrating from MPP](/guide/upgrade-mpp) for code.

## Facilitator Implementations

Facilitators are verify+settle services. s402 servers can either run their own or use a hosted one.

| Facilitator | Operator | Status | Chains | Endpoint |
|---|---|---|---|---|
| **Swee Hosted** | Swee Group | ✅ Production | Sui mainnet, testnet | `https://facilitator.swee.inc` |
| **Self-hosted (reference)** | You | ✅ Production | Sui | Code in [`@sweefi/sui`](https://www.npmjs.com/package/@sweefi/sui) |
| **x402 compat proxy** | Swee Hosted | 📋 Beta | Sui + EVM read | Bridges x402 inputs to s402 schemes |

The Swee hosted facilitator is the default endpoint in the `s402` SDK — drop-in for agent builders who don't want to run infra.

## Conformance & Testing

Every official adapter passes the [161-vector conformance suite](/guide/conformance). The vectors are language-agnostic JSON files in [`spec/vectors/`](https://github.com/s402-protocol/core/tree/main/spec/vectors) — run them against any new adapter to verify compliance.

```bash
# Run the TS conformance suite
cd typescript && pnpm test conformance

# Run the Python conformance suite
cd python && uv run pytest tests/conformance
```

## Contributing a New Adapter

Want to add Solana, Aptos, Svelte, or LangChain support?

1. Read the [Wire Format Spec](/specification) and [Canonicalization rules](https://github.com/s402-protocol/core/blob/main/spec/canonicalization.md).
2. Run the [conformance suite](/guide/conformance) against your adapter.
3. Open an issue on [s402-protocol/core](https://github.com/s402-protocol/core/issues) with the adapter plan.
4. PR — we review within a week.

The bar for "official" status: pass all 161 vectors, document the public API, include at least one end-to-end example. Community adapters are listed here once they meet the bar.

## Next Steps

- **[Quick Start](/guide/quickstart)** — pick your language and wire a 402 flow in 5 minutes
- **[Wire Format Spec](/specification)** — what goes on the wire (language-independent)
- **[Conformance Vectors](/guide/conformance)** — the 161-vector test suite every adapter must pass
- **[Migrating from x402](/guide/upgrade-x402)** / **[from MPP](/guide/upgrade-mpp)** — drop-in adapters for existing deployments
