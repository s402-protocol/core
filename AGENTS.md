# s402 — Agent Manual

## What is this?

`s402` is a chain-agnostic HTTP 402 payment protocol. This repo is a **monorepo** containing the protocol specification, conformance test vectors, and implementations in multiple languages.

## Repository Structure

```
s402-protocol/core
├── spec/vectors/          — 167 conformance test vectors (THE protocol spec, language-agnostic) <!-- corrected 2026-07-02: was 132; count verified on disk + v0.8.0 changelog -->
├── docs/                  — VitePress docs site (s402-protocol.org) + wire format specification
├── typescript/            — TypeScript reference implementation (npm: s402)
│   ├── src/               — 11 source files, zero runtime deps
│   ├── test/              — 1,098 tests (adversarial, fuzz, MC/DC, conformance) <!-- corrected 2026-07-02: was 736; per v0.8.0 CHANGELOG -->
│   └── examples/          — Runnable joke-api demo
├── python/                — Python implementation (pip: s402)
│   ├── src/s402/          — 5 source files, zero runtime deps
│   └── tests/             — Conformance test runner (reads spec/vectors/)
├── AGENTS.md              — This file (repo-level)
├── LICENSE                — Apache-2.0
└── CONTRIBUTING.md        — How to contribute
```

Both implementations read conformance vectors from `spec/vectors/` — one canonical source of truth.

## TypeScript Implementation

```
typescript/src/
  index.ts        — Barrel export (public API)
  types.ts        — All protocol types, interfaces, constants
  scheme.ts       — Client/Server/Facilitator scheme interfaces
  client.ts       — s402Client class (scheme registry + payment builder)
  server.ts       — s402ResourceServer class (requirements builder)
  facilitator.ts  — s402Facilitator class (verify + settle dispatch)
  http.ts         — Base64 encode/decode for HTTP headers + canonical validators
  compat.ts       — Optional x402 migration aid (opt-in, not ambient)
  errors.ts       — Typed error codes with recovery hints
  receipts.ts     — Signed usage receipt header format/parse
  test-utils.ts   — Mock schemes for integration testing
```

## Key rules

- **Zero runtime deps.** This package must never add runtime dependencies.
- **Chain-agnostic (S7).** No chain-specific address formats, amount bounds, or imports in `src/`. Sui validation → `@sweefi/sui`. Solana validation → `@sweefi/solana`. See S7 invariant below.
- **ESM only.** No CommonJS.
- **Types are the product.** Most consumers import types only. Keep the type surface clean and well-documented.
- **x402 compat is opt-in.** The `s402/compat` subpath provides x402 V1/V2 normalization as a migration aid. The core protocol (`client.ts`, `http.ts`) has no x402 dependency.

## Commands

```bash
# TypeScript (run from typescript/)
cd typescript
pnpm run build      # Build with tsdown
pnpm run test       # Run tests (1,098 across 28 files, incl. 167-vector conformance)
pnpm run typecheck  # tsc --noEmit

# Python (run from python/)
cd python
pip install -e ".[dev]"
pytest              # Run conformance tests (154 vectors — the 12 codec files; settlement-verification + transport-carriers vectors are TS-only for now)
```

## Conformance test suite

`spec/vectors/` contains 167 machine-readable JSON test vectors across 14 files. <!-- corrected 2026-07-02: was "132 across 12" --> These are the **product** — both the TypeScript and Python implementations read from this single directory. Cross-language implementors (Go, Rust) use these same vectors to verify s402 conformance.

- **Generator**: `npx tsx test/conformance/generate-vectors.ts` — regenerate after any encode/decode changes
- **TS Runner**: `typescript/test/conformance/conformance.test.ts`
- **Python Runner**: `python/tests/test_conformance.py`
- **Docs**: `typescript/test/conformance/README.md` — cross-language implementation guide

## Sub-path exports (TypeScript)

```typescript
import { ... } from 's402';              // Everything
import type { ... } from 's402/types';   // Types + constants
import { ... } from 's402/http';         // HTTP encode/decode
import { ... } from 's402/compat';       // Optional x402 migration aid
import { ... } from 's402/errors';       // Error types
import { ... } from 's402/test-utils';   // Mock schemes for integration testing
```

## Examples

```bash
# TypeScript: joke API server + client (mock — no Sui connection needed)
cd typescript
npx tsx examples/joke-api/server.ts    # terminal 1
npx tsx examples/joke-api/client.ts    # terminal 2

# Python: agent client talking to the TS server
cd python
python examples/agent_client.py        # terminal 2 (after starting TS server)
```

## Documentation (VitePress)

The `/docs` directory contains the full documentation site deployed to https://s402-protocol.org.

```
docs/
  .vitepress/config.ts   — VitePress configuration (nav, sidebar, editLink)
  index.md                — Landing page
  guide/                  — Getting started guides
  schemes/                — Per-scheme reference pages
  api/                    — API reference pages
  public/                 — Static assets (favicon, images)
  architecture.md         — Design principles
  comparison.md           — s402 vs x402
  security.md             — Security model
  faq.md                  — Frequently asked questions
```

```bash
pnpm run docs:dev       # Start dev server (localhost:5173)
pnpm run docs:build     # Build static site
pnpm run docs:preview   # Preview production build (localhost:4173)
```

**Key rules:**
- **Docs don't ship to npm.** The `files` field in `package.json` is an allowlist — only `dist/`, `README.md`, and `LICENSE` are published.
- **Images go in `docs/public/images/`.** VitePress serves them at `/images/` in the built site.
- **Edit the config for nav/sidebar changes.** `docs/.vitepress/config.ts` defines all navigation.
- **VitePress cache/dist are gitignored.** Never commit `.vitepress/dist/` or `.vitepress/cache/`.
- **Deployment:** Auto-deploys on push to `main` via Vercel. The Vercel project `s402-docs` points to this repo with Root Directory set to `docs`.

## Design Decisions

### The Five Irreducible Payment Primitives

s402 defines exactly five payment schemes. Each has a **unique on-chain lifecycle** that cannot be reduced to any other:

| Scheme | On-chain object | Lifecycle | Why irreducible |
|--------|----------------|-----------|-----------------|
| `exact` | None (atomic transfer) | pay → done | Base case. No persistent state. |
| `prepaid` | `PrepaidBalance` shared object | deposit → claim → claim → withdraw | Deposit-then-claim pattern. Provider-initiated claims invert the flow. |
| `stream` | `Stream` shared object | open → tick → tick → close | Time-based. On-chain clock drives payments autonomously. |
| `escrow` | `Escrow` shared object | lock → condition → release/refund | Conditional. Money locked until delivery confirmed or deadline passes. |
| `unlock` | Encryption receipt + encrypted blob | pay → receipt → decrypt (two-stage) | Entangled with encryption key servers. Decryption is atomic with payment. |

**Why not six?** Auction (agent-to-agent bidding) was considered. Auction decomposes into two phases: price **discovery** (coordination problem) and **settlement** (one of the five existing schemes). The settlement of an auction is just `exact` (or `prepaid`, or `stream`) at the discovered price. Discovery is not a payment primitive — it's a coordination service.

**Why not four?** Every scheme was tested for reducibility. Escrow cannot be expressed as "exact now + refund later" (the atomic lock is the point). Unlock cannot be expressed as escrow (encryption key server integration is entangled with payment). Stream cannot be expressed as repeated exact (on-chain clock autonomy is the point).

### Auction via the `extensions` Field

The `extensions` field on `s402PaymentRequirements` is the forward-compatibility escape hatch. Auction (and any future pattern that doesn't need its own on-chain object type) uses it:

```typescript
// Auction signals via extensions — settlement uses exact scheme
{
  s402Version: '1',
  accepts: ['exact'],
  amount: '1000000',           // minimum bid
  extensions: {
    auction: {
      type: 'sealed-bid',      // or 'english', 'dutch', 'vickrey'
      deadline: 1708000000000, // bidding closes at this timestamp
      minIncrement: '100000',  // minimum bid increment
    }
  }
}
```

An auction-aware agent reads `extensions.auction` and enters bidding mode. A standard agent ignores `extensions` and pays the minimum via `exact`. Both work.

**Promotion path:** If auction usage explodes, it can be promoted to a full sixth scheme in s402 v2 with its own `s402AuctionPayload` type and `Auction` on-chain object. The `extensions` field is the proving ground.

### Three-Actor Scheme Architecture

The plugin system splits into three interfaces, one per payment actor:

```
s402ClientScheme       → requirements → signed payload    (1 method)
s402ServerScheme       → route config → requirements      (1 method)
s402FacilitatorScheme  → payload → verify + settle        (2 methods)
```

**Why three?** This mirrors the natural factoring of payment protocols (SWIFT: originator/correspondent/beneficiary; cards: cardholder/acquirer/issuer). The 402 flow is: server states price → client pays → facilitator verifies and settles. Three actors, three interfaces.

**Why verify + settle are separate on FacilitatorScheme:** Verify is a free dry-run simulation. Settle costs gas. Separating them lets you verify cheaply before committing gas. The `s402Facilitator.process()` method orchestrates verify→settle with expiration guards between them.

**Extensibility:** Adding a new scheme requires implementing the three interfaces and calling `.register()`. Zero changes to existing code. No switch statements, no if/else chains — the two-level `Map<network, Map<scheme, impl>>` dispatches via lookup.

**Watch item:** `s402RouteConfig` in `scheme.ts` accumulates optional config blocks for each scheme. At 5 schemes this is clean. At 10+ it could get unwieldy. Mitigation: each ServerScheme implementation only reads its own fields (TypeScript structural typing), and scheme-specific config types can extend the base without breaking it.

### Trust Boundary Model

Three independent validation boundaries, each validates without trusting the previous:

| Boundary | Location | Defense |
|----------|----------|---------|
| Wire decode | `http.ts` `decodePaymentRequired()` | Base64 → JSON → shape validation → allowlist key stripping |
| Client intake | `client.ts` `createPayment()` | Accepts typed `s402PaymentRequirements` only. For x402 input, caller must use `normalizeRequirements()` from `s402/compat` first. |
| Facilitator process | `facilitator.ts` `process()` | Type defense on expiresAt → expiration guard → verify → latency guard → settle |

The canonical validators (`validateRequirementsShape`, `pickRequirementsFields`) live in `http.ts`. The compat layer imports from `http.ts` — no duplicated validation code.

### Safety Invariants

s402 has **8 formally proven invariants** in `INVARIANTS.md`. Read these before modifying payment processing, error handling, or scheme dispatch:

| ID | Property | Type | What it protects |
|----|----------|------|------------------|
| S1 | Stale payment rejection | Safety | Expired payments never settle (triple-layer defense) |
| S2 | Trust boundary integrity | Safety | Untrusted HTTP input cannot corrupt internal state |
| S3 | Five irreducible schemes | Structural | No scheme can be decomposed into others |
| S4 | Error recoverability | Liveness | Agents can always determine retry vs. abandon |
| S5 | Concurrent payment dedup | Safety | Identical payloads produce at most one settlement |
| S6 | x402 compatibility roundtrip | Structural | s402 → x402 → s402 preserves all x402 fields |
| S7 | Chain-agnostic boundary | Safety | s402 core contains ZERO chain-specific logic (see below) |
| S8 | Facilitator accountability | Safety | Client-side causal-binding check detects digest substitution |

**If you change `facilitator.ts`, `http.ts`, or `errors.ts`, re-verify the relevant invariant.**

### S7: Chain-Agnostic Boundary (CRITICAL — Read Before ANY Code Change)

**s402 is a chain-agnostic protocol.** The `src/` directory must NEVER contain:

- Chain-specific address validation (no Sui `0x` + 64 hex, no Solana base58, no Ethereum EIP-55)
- Chain-specific amount magnitude checks (no u64 max, no lamport bounds)
- Chain-specific imports (`@mysten/sui`, `@solana/web3.js`, `ethers`, etc.)
- Chain-specific constants (coin type strings, network IDs, RPC URLs)

**Where chain-specific code belongs:** `@sweefi/sui` (Sui), `@sweefi/solana` (Solana), or future chain packages. These packages import from `s402` and add chain-specific validation on top.

**What s402 validates:** Structure and safety only — non-empty strings, no control characters, numeric format (parseable as integer), key presence/absence. Never format correctness of chain-specific values.

**This invariant is enforced by `test/boundary.test.ts`.** The test greps `src/` for chain-specific patterns and fails if any are found. If you believe a chain-specific check is genuinely needed in s402, you are almost certainly wrong — discuss with the maintainer first.

**Why this exists:** In Feb 2026, multiple AI sessions introduced Sui-specific address validation (`/^0x[0-9a-fA-F]{64}$/`) into `http.ts` — the protocol layer. Each subsequent AI session saw the regex and assumed it was correct. It took 4-6 AI sessions and a human review to catch the violation. This invariant + test prevents recurrence.

### Verify Prior AI Work (CRITICAL for AI Agents)

**Do not assume existing code is correct.** Prior code may have been written by another AI session that:
- Misunderstood the s402/SweeFi boundary (S7 above)
- Introduced chain-specific logic in the wrong layer
- Added validation that is too strict or too loose
- Made assumptions that aren't documented in this file

**Before modifying existing code:** Verify it against the invariants (S1-S8) above. If you find a violation, fix it — don't perpetuate it. If a prior AI added something that looks wrong, it probably is wrong.

**Before adding new validation:** Ask: "Is this chain-specific?" If yes, it belongs in `@sweefi/sui`, not here. The `test/boundary.test.ts` test will catch you if you get this wrong.

### Cross-Repo Awareness: Grep Sibling Projects Before Implementing (CRITICAL for AI Agents)

**Before implementing a new scheme, adapter, Move module, or subsystem in this repo, grep sibling projects under `../../projects/` for the name.** Parallel drift across repos is one of the most expensive failure modes in an AI-driven workflow — two repos evolve along independent tracks, each internally coherent, and the cost of reconciliation later is vastly higher than the cost of a 30-second check up front.

**Sibling repos to check first:**
- `../../projects/sweefi-project/sweefi/contracts/sources/` — Move modules for all five schemes
- `../../projects/sweefi-project/sweefi/packages/sui/src/s402/` — Sui adapter client/facilitator/server classes
- `../../projects/sweefi-project/sweefi/packages/mcp/` — the canonical Sui MCP server (`@sweefi/mcp`)
- `../../projects/sweefi-project/sweefi/STATUS.md` — deployment state, testnet package ID, test counts

**Concrete check commands:**
```bash
ls ../../projects/sweefi-project/sweefi/contracts/sources/
ls ../../projects/sweefi-project/sweefi/packages/sui/src/s402/
grep -r "yourFeatureName" ../../projects/sweefi-project/sweefi/packages/
```

**Why this rule exists:** In April 2026, an AI session was about to implement `stream.move`, `escrow.move`, `prepaid.move`, and an unlock scheme adapter from scratch inside `s402/mcp-server/` — all of which already existed in `sweefi/contracts/sources/` and `sweefi/packages/sui/src/s402/`, tested with 1,775 passing tests and deployed to Sui testnet v11 with live demo transactions. The only reason the duplication was caught was a human asking "isn't this the wrong level for an MCP server?" A single `ls` of the sweefi folder 30 seconds earlier would have prevented a lengthy detour. See ADR-002 for the full incident writeup.

**Corollary rule:** If you find that sibling code already implements what you were about to build, STOP. Do not rebuild. Either (a) improve the sibling implementation in place if the gap is there, or (b) consume the sibling package as a dependency, or (c) escalate to Danny with the discovery. Duplicating existing work is worse than building nothing — it creates divergent implementations that have to be reconciled at higher cost later.

### Error Design: Machines First

Every `s402Error` carries `{ code, retryable, suggestedAction }`. This is designed for autonomous agents, not human developers. An agent's error handler branches on `retryable` (boolean) and reads `suggestedAction` (string) to decide next steps — no message parsing, no regex on error strings.
