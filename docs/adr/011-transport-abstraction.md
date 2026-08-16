# ADR-011: Transport Abstraction — Payment Rides Any Carrier

**Status:** Accepted (2026-06-28; revised after blind-spot review; Chunks 1a-i, 1a-ii, 1a-iii, and 2 landed + verified — HTTP + MCP + A2A all behind one seam, 1075 tests green)
**Implementation:** shipped
**Date:** 2026-06-28
**Supersedes:** (none)
**Related:** ADR-005 (interop/superset), ADR-002 (s402 is pure protocol), S7 (chain-agnostic boundary)

## Context

x402 V2 (now Linux-Foundation-governed) made two directional moves s402 should answer:

1. **Everything moved into headers** — V2 carries all protocol data in `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers; "response bodies are a server concern." s402 already independently converged on this (header-first, protocol truth in `payment-required` / `payment-response`; body optional). We match on 2 of 3 header names; only the payload header differs (`x-payment` vs x402's `PAYMENT-SIGNATURE`).
2. **`transports-v2/` defines HTTP + MCP + A2A** as distinct carriers for the same protocol. s402 today is **HTTP-only in core**; MCP exists only as `mcp-demo`; A2A is absent.

Agents increasingly call tools over **MCP** (today) and **A2A** (next), not just REST. To be the Sui-native superset on the surfaces agents actually use — without re-implementing payment + security per carrier — s402 needs a **transport seam**: one chain-agnostic core, with each carrier a thin lossless mapping (a *bijection*) between the canonical protocol objects and that carrier's out-of-band metadata slot (HTTP header ↔ MCP `_meta` ↔ A2A task-state).

**Sibling-repo reality (per AGENTS.md "grep siblings first"):** the canonical Sui MCP server already exists — `@sweefi/mcp` v0.1.6 (real MCP SDK, depends on `s402@0.5` + `@sweefi/sui`), exposing payment **as tools** (`pay`, `escrow`, `stream`, `mandate`, …). That is **payment-as-tools** (a wallet over MCP). The missing primitive is **payment-gated-tools** — gating an *arbitrary* tool behind an s402 payment via `_meta` (x402's `paymentWrapper` pattern). This ADR scopes the chain-agnostic half; the Sui half lands in `@sweefi/mcp` (S7).

## Decision

**Extract a chain-agnostic `PaymentTransport` seam in s402 core. Carriers are thin bijections. Sui settlement never enters core (S7).**

1. **`PaymentTransport` interface (s402 core):** a lossless mapping between the canonical `{ PaymentRequired, PaymentPayload, SettleResponse }` and a carrier's out-of-band slot — **designed for the most stateful carrier (A2A) from day one.** The interface carries an optional **correlation/state context** (an opaque correlation token + payment-status enum) that HTTP ignores, MCP optionally uses, and A2A uses fully. Modeling it as a stateless req/resp codec would NOT fit A2A's task lifecycle (`input-required → completed/failed`, `taskId` correlation, multi-step status) and would force an interface break when A2A lands — defeating the "thin adapter" payoff. The core (schemes, facilitator, S1–S16) never knows which carrier it rides. Transports must also support `s402DirectScheme` (self-sovereign, no-facilitator), not assume a facilitator.
2. **Refactor HTTP behind the interface — behavior-preserving (Chunk 1a-i).** No wire change; the existing 736 tests stay green as the regression proof.
3. **MCP `_meta` codec as `s402/mcp` subpath** — PURE protocol mapping, **zero chain code** (S7-safe). Interop is **dual-key**, mirroring the HTTP dual-header rule: **read both `s402/payment` and x402's `x402/payment` (`MCP_PAYMENT_META_KEY`); emit native `s402/payment`.** Recognize x402's `McpError(-32042)` on the read path.
4. **Header hygiene (Chunk 1a-ii).** Read case-insensitively (mandatory; free via `Headers`). **ALL-CAPS emit was considered and REJECTED** — the Fetch `Headers` API byte-lowercases field names (WHATWG Fetch) and HTTP/2 (RFC 9113 §8.2.1) *requires* lowercase, so uppercase emit is a no-op at best and a malformed-message spec violation at worst; lowercase emit is correct by design (already documented in `types.ts`). Accepting inbound `PAYMENT-SIGNATURE` (x402 V2) / `X-PAYMENT` (V1) requires x402→s402 *shape* normalization (their payload envelope differs), so it lives in the OPT-IN `s402/compat/x402` layer (`fromX402PayloadHeaders`) — NOT core gate/transport — keeping the core x402-free per AGENTS.md. Outbound is already covered: s402's `payment-response` matches x402 V2's `PAYMENT-RESPONSE` case-insensitively.
5. **Conformance vectors per carrier** in `spec/vectors/` — the drift contract. **Carrier-specific vectors are tagged** so the Python conformance runner skips MCP/A2A vectors until it implements those codecs (adding them to the shared canonical set otherwise reds Python's suite — `spec/vectors/` is cross-language).
6. **Sui-specific work lands in `@sweefi/mcp`, not core (Chunk 1b):** `withS402Payment()` gating wrapper (model 2) using the core codec + Sui facilitator; a **Streamable HTTP** transport (currently stdio-only) for remote paid tools. **Dependency note:** `@sweefi/mcp` consumes published `s402@^0.5`; 1b cannot consume 1a until s402 republishes (workspace-link during dev; sequence a release before 1b is "done").
7. **Per-carrier content negotiation:** each carrier defines how the `accepts` list is surfaced (HTTP `Accept-Payment`; MCP tool-descriptor + error envelope; A2A task metadata). Not built in Chunk 1 but reserved in the interface so it isn't designed out.

## Alternatives Considered

- **A — Promote `s402-mcp-demo` into core.** Rejected: it settles on Sui (imports `@mysten/sui`) → violates S7; and it duplicates `@sweefi/mcp`.
- **B — Per-carrier parallel implementations (x402's approach: separate `packages/http`, `packages/mcp`).** Rejected: shared types but re-derived flow → behavioral drift between carriers. A single interface both carriers *implement* forces shared behavior. (This is where s402 goes cleaner than x402.)
- **C — Keep HTTP-only.** Rejected: cedes the MCP/A2A surface where agents actually transact.

## Consequences

**Positive:**
- One payment+security core, N thin carriers. A2A becomes a thin adapter — a leapfrog (x402 has only an A2A *spec*, no impl).
- Architecturally cleaner than x402 (unified interface vs parallel packages).
- S7 preserved; interop with x402 V2 across HTTP and MCP.

**Negative / watch-fors:**
- Cross-repo coordination (s402-core interface + `@sweefi/mcp` impl). Keep the boundary crisp: protocol mapping in core, settlement in SweeFi.
- Per-carrier maintenance. Mitigation: the Hono model — public adapter interface + per-adapter vectors, so the ecosystem maintains its own edges.

## Follow-ups

- [x] **Chunk 1a-i (s402 core):** `PaymentTransport` interface + `httpTransport` behind it (behavior-preserving delegation over `http.ts`). Landed 2026-06-28 — 1042 tests green (1032 unchanged + 10 new), typecheck clean, build ✔. See CHANGELOG `[Unreleased]`.
- [x] **Chunk 1a-ii (compat, NOT core):** `fromX402PayloadHeaders()` in `s402/compat/x402` — opt-in x402 inbound payload bridge (reads `PAYMENT-SIGNATURE` V2 / `X-PAYMENT` V1, normalizes shape via `fromX402Payload`). Landed 2026-06-28 — 1050 tests green (+8), S7 boundary green, typecheck + build ✔. **ALL-CAPS emit dropped** (HTTP/2 + `Headers` auto-lowercase; see Decision §4). Core stays x402-free; the bridge is opt-in at server intake.
- [x] **Chunk 1a-iii (s402 core + compat):** `mcpTransport` (`PaymentTransport<McpMetaFrame>`) in `transport.ts` — maps canonical objects to/from `_meta['s402/payment']` as **structured JSON** (MCP's idiom, not base64), validated via the canonical `validate*Shape`/`pick*Fields` (identical trust boundary to HTTP). **No `s402/mcp` subpath created** — the codec is pure object-mapping with ZERO MCP-SDK dependency, so it lives in `transport.ts` next to `httpTransport` (barrel-exported); a subpath would isolate no heavy dep. The x402 `_meta` dual-read moved to compat (`fromX402PayloadMeta`, symmetric with 1a-ii's `fromX402PayloadHeaders`) to keep core x402-free. Landed 2026-06-28 — 1062 tests green (+12), S7 boundary green, build ✔.
- [x] **Chunk 1a-iv (cross-language vectors):** `spec/vectors/transport-carriers.json` — 6 carrier-tagged vectors (3 MCP + 3 A2A) generated by the (now-fixed) generator and validated by a new TS conformance block. Python stays green automatically: its runner loads only named files and does not load this one (the carrier-tagging — the contract exists for when Python/Go/Rust add the codecs). **Found + fixed a latent bug:** the conformance generator had a stale `../../src/compat.js` import (the file moved to `compat/x402.js` in the 0.7.0 reorg) and had been broken/unrunnable since — see `LESSONS.md`. Regenerating produced byte-identical existing vectors (no committed drift) + the new file. Landed 2026-06-28 — 1082 tests green (+7), build ✔.
- [ ] **Chunk 1b (`@sweefi/mcp`):** `withS402Payment()` gating wrapper + Streamable HTTP transport (keep stdio; SSE only for back-compat).
- [ ] Reduce `s402-mcp-demo` to a thin demo of the wrapper.
- [x] **Chunk 2 (leapfrog):** A2A transport — `a2aTransport` maps the canonical objects onto the A2A task-lifecycle `metadata` (`s402.payment.*` keys), with EXPLICIT lifecycle status (READ from metadata, not derived as in HTTP/MCP) + `taskId` correlation via `ctx.correlationId`. x402 inbound bridge `fromX402PayloadA2A` in compat (completes the HTTP·MCP·A2A inbound trio). Landed 2026-06-28 — 1075 tests green (+13), S7 boundary green, build ✔. **s402 now ships an A2A implementation; x402 has only a spec — the leapfrog is real.** The stateful interface from 1a-i absorbed A2A as a ~70-line adapter with no interface change — the design's payoff, proven.
- [ ] Schedule a weekly x402/MPP drift-watch routine (detect, not auto-adapt; runs the compat vectors).
- [x] CHANGELOG: `typescript/CHANGELOG.md` already exists (Keep-a-Changelog format); 1a-i logged under `[Unreleased]`. (Earlier "absent" note was checking the repo root, not `typescript/`.)
