# ADR-004: Extensions Architecture — Typed, Lifecycle-Aware Plugin System

**Status:** Proposed
**Implementation:** shipped — `src/extensions.ts` (10KB), exported as the `s402/extensions` subpath in `package.json`.
⚠️ **`Status: Proposed` above is stale and is left as-is deliberately** (found 2026-08-16, DAN-855): this was built without the ADR ever being moved to Accepted. Flipping a governance field is a decision, not a cleanup, so it is surfaced here rather than changed unilaterally. It is also the exact gap the `Implementation:` field exists to expose — under `Status` alone, "proposed and never built" and "proposed and shipped" were the same page.
**Date:** 2026-04-12
**Supersedes:** (none — implements the framework that ADR-001 Decision 4 described as hygiene rules)
**Linear:** DAN-285

## Context

s402 needs a plugin/extension system so capabilities can be added modularly without changing the core protocol. x402 v2 shipped 6 extensions with a three-interface architecture. s402 has the `extensions` wire field (on `s402PaymentRequirements` since v0.1) and extension hygiene rules (ADR-001 Decision 4), but no programmatic extension system — no lifecycle hooks, no registration, no typed interfaces.

### x402's extension architecture (reference)

Three interfaces, one per actor:
- **`FacilitatorExtension`**: `{ key: string }` — literally no lifecycle hooks. Extensions are passive data bags retrieved via `getExtension<T>(key)`.
- **`ResourceServerExtension`**: 3 hooks — `enrichDeclaration`, `enrichPaymentRequiredResponse`, `enrichSettlementResponse`
- **`ClientExtension`**: 1 hook — `enrichPaymentPayload`

Registration via `registerExtension()` on each class, stored in `Map<string, Extension>`.

### x402's design flaws (7 confirmed by code analysis)

| # | Flaw | x402 code evidence |
|---|------|--------------------|
| **F1** | Pervasive `unknown` typing | `enrichDeclaration(declaration: unknown, transportContext: unknown) => unknown` |
| **F2** | No dependency/ordering | Extensions in plain `Map`, no `dependsOn` or priority |
| **F3** | FacilitatorExtension has no hooks | Interface is literally `{ key: string }`. All logic in mechanisms. |
| **F4** | No extension negotiation | Server advertises; client blindly echoes. No capability handshake. |
| **F5** | Round-trip waste | Bazaar echoes full schema+info through client. |
| **F6** | Transport-coupled hooks | `enrichDeclaration(declaration, transportContext)` leaks transport. |
| **F7** | Silent error swallowing | try/catch + console.error. No failure propagation. |

## Decision

### Decision 1 — Three typed extension interfaces with lifecycle hooks for all actors

Every actor gets proper lifecycle hooks. No actor is a passive data bag.

```typescript
/**
 * Base extension interface. All three actor-specific interfaces extend this.
 */
interface s402Extension {
  /** Reverse-domain key (per ADR-001 §4a): e.g., "org.s402.discovery" */
  readonly key: string;
  /** Semver version (per ADR-001 §4b) */
  readonly version: string;
  /** If true, failure in this extension blocks the payment flow.
   *  If false, failure is logged but doesn't block (advisory). */
  readonly critical: boolean;
}

/**
 * Client-side extension.
 * Hooks fire during payment creation and settlement verification.
 */
interface s402ClientExtension extends s402Extension {
  /** Enrich the payment payload before sending.
   *  Return the (potentially modified) payload with extension data added. */
  enrichPayload?(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402PaymentPayload>;

  /** Process extension data from the settle response.
   *  Use for client-side bookkeeping (receipts, idempotency tracking, etc.) */
  onSettlement?(
    response: s402SettleResponse,
    payload: s402PaymentPayload,
  ): Promise<void>;
}

/**
 * Server-side extension (resource server).
 * Hooks fire during requirements building and settlement response.
 */
interface s402ServerExtension extends s402Extension {
  /** Enrich payment requirements before sending the 402 response.
   *  Add extension-specific fields to requirements.extensions[key]. */
  enrichRequirements?(
    requirements: s402PaymentRequirements,
    config: s402RouteConfig,
  ): s402PaymentRequirements;

  /** Enrich the settlement response before returning to client.
   *  Add extension data to response.extensions[key]. */
  enrichSettleResponse?(
    response: s402SettleResponse,
    payload: s402PaymentPayload,
  ): Promise<s402SettleResponse>;
}

/**
 * Facilitator-side extension.
 * Hooks fire during the verify→settle pipeline.
 */
interface s402FacilitatorExtension extends s402Extension {
  /** Called before verify(). Can reject by throwing.
   *  Use for pre-verification checks (rate limiting, allowlisting, etc.) */
  beforeVerify?(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<void>;

  /** Called after successful verify(), before settle().
   *  Use for logging, metrics, extension-specific validation. */
  afterVerify?(
    payload: s402PaymentPayload,
    verifyResult: s402VerifyResponse,
  ): Promise<void>;

  /** Called before settle(). Last chance to abort.
   *  Use for final checks (balance confirmation, fraud detection). */
  beforeSettle?(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<void>;

  /** Called after successful settle().
   *  Use for post-settlement bookkeeping (indexing, receipts, analytics). */
  afterSettle?(
    payload: s402PaymentPayload,
    settleResult: s402SettleResponse,
  ): Promise<void>;
}
```

**Why four facilitator hooks (vs x402's zero):** The facilitator is the most security-sensitive actor. Pre-verify hooks enable rate limiting and allowlisting. Post-verify hooks enable logging before gas commitment. Pre-settle hooks enable final fraud checks. Post-settle hooks enable indexing and analytics. x402's approach (passive data bag, all logic in mechanisms) means every mechanism must re-implement extension interaction — the opposite of modularity.

### Decision 2 — Registration with dependency ordering

Extensions are registered on each actor class and executed in dependency order:

```typescript
// On s402Client, s402ResourceServer, s402Facilitator:
registerExtension(ext: s402ClientExtension): this;

// Extensions declare dependencies:
interface s402Extension {
  // ...existing fields...
  /** Keys of extensions that must run before this one. */
  readonly dependsOn?: string[];
}
```

At registration time, the class builds a topological sort of extensions. If a cycle is detected, registration throws. This fixes x402's F2 — extensions that need another extension's output declare the dependency explicitly.

**Execution order:** Extensions run in topological order. Within the same dependency level, registration order is preserved.

### Decision 3 — Extension data on all three wire types

Currently `extensions` exists only on `s402PaymentRequirements`. s402 adds it to the other two:

```typescript
// s402PaymentPayload gains (on the base type):
extensions?: {
  /** Keys the client supports (capability advertisement) */
  supported?: string[];
  /** Extension-specific data keyed by extension key */
  data?: Record<string, unknown>;
};

// s402SettleResponse gains:
extensions?: Record<string, unknown>;
```

**Why `supported` in the payload:** This fixes x402's F4 (no negotiation). The server advertises extensions in requirements; the client responds with which ones it supports in the payload. The facilitator and server can then make decisions based on the intersection.

**Why NOT echo schema:** The client sends `supported` keys + `data`, never the schema/info from requirements. This fixes x402's F5 (round-trip waste). The bazaar-style discovery info stays in the 402 response; it doesn't make a round trip.

### Decision 4 — Transport-agnostic hooks (no transport context)

No hook signature accepts a `transportContext` parameter. Extensions operate on protocol types only (`s402PaymentRequirements`, `s402PaymentPayload`, `s402SettleResponse`, `s402RouteConfig`).

This fixes x402's F6. If an extension needs transport-specific behavior (e.g., HTTP method detection for discovery), the transport adapter enriches the `s402RouteConfig` or `extensions` field before the extension hooks fire. The extension never knows or cares whether it's running over HTTP, MCP, or A2A.

### Decision 5 — Configurable error handling via `critical` flag

Each extension declares `critical: boolean`:

- **`critical: true`** — failure throws `s402Error('EXTENSION_FAILED', ...)`. The payment flow stops. Use for security-critical extensions (rate limiting, fraud detection, idempotency).
- **`critical: false`** — failure is caught, logged via a configurable `onExtensionError` callback, and the flow continues. Use for advisory extensions (analytics, discovery indexing).

This fixes x402's F7 (silent error swallowing). x402 catches all extension errors and logs them, losing the distinction between "analytics extension failed" (fine) and "rate limiter extension failed" (not fine).

```typescript
// New error code:
s402ErrorCode.EXTENSION_FAILED = 'EXTENSION_FAILED';
// retryable: false, suggestedAction: 'Contact the extension provider or disable the extension'
```

### Decision 6 — Wire format uses `Record<string, unknown>` (typed layer is API-only)

The wire format stays `Record<string, unknown>` for maximum interoperability. Any JSON-capable client can produce and consume extension data without understanding the TypeScript type system.

The typed `s402Extension` interfaces are a **TypeScript API convenience**, not a wire format constraint. Extension authors get compile-time safety when implementing hooks. Consumers get type inference when using `getExtensionData<T>(key)`:

```typescript
// Type-safe extension data retrieval:
function getExtensionData<T>(
  extensions: Record<string, unknown> | undefined,
  key: string,
): T | undefined {
  return extensions?.[key] as T | undefined;
}
```

This fixes x402's F1. The wire format is the same (`Record<string, unknown>`), but the API layer provides typed access patterns that catch mistakes at compile time.

### Decision 7 — Extension integration points in s402Facilitator.process()

The `process()` method gains extension hook calls at four points:

```
process(payload, requirements):
  1. Run all facilitator beforeVerify hooks (topological order)
  2. verify(payload, requirements)          ← existing
  3. Run all facilitator afterVerify hooks
  4. Latency guard                          ← existing
  5. Run all facilitator beforeSettle hooks
  6. settle(payload, requirements)          ← existing
  7. Run all facilitator afterSettle hooks
  8. Return result
```

Critical extension failures at steps 1, 3, 5 abort the flow and return `{ success: false, errorCode: 'EXTENSION_FAILED' }`. Advisory extension failures at step 7 (post-settle) are logged but don't change the result.

### Decision 8 — First three extensions to implement

| Extension | Key | Critical | Priority | Purpose |
|-----------|-----|----------|----------|---------|
| **discovery** | `org.s402.discovery` | false | HIGH | MCP registry listing, facilitator cataloging. Equivalent to x402's "bazaar." |
| **payment-identifier** | `org.s402.payment-id` | true | HIGH | Client-provided idempotency key. Simple but load-bearing. |
| **sign-in-with-x** | `org.s402.auth` | false | MEDIUM | Wallet-based authentication. zkLogin on Sui gives this for free; need protocol handshake. |

These three are self-contained and together demonstrate the full extension lifecycle (server enrichment, client negotiation, facilitator verification).

## Alternatives Considered

**Alt A — Use the `extensions` field informally without a typed system.**
Rejected. s402 already has the informal `extensions` field. Without lifecycle hooks and typed interfaces, every consumer re-implements extension handling ad-hoc. x402 tried this for `FacilitatorExtension` — it became a passive data bag with all logic in mechanisms.

**Alt B — Use middleware/wrapper pattern instead of lifecycle hooks.**
Rejected. Middleware patterns (like Express) wrap the entire handler. Extension hooks are more precise — they fire at specific points in the verify→settle pipeline. Middleware also doesn't compose well when extensions need each other's data (the dependency problem).

**Alt C — Make all extensions critical by default.**
Rejected. Most extensions are advisory (analytics, discovery, gas sponsoring). Making them critical by default would mean a non-essential analytics extension could block payments.

**Alt D — Add extension hooks to scheme interfaces instead of actor classes.**
Rejected. Scheme interfaces (`s402ClientScheme`, etc.) are per-scheme. Extensions are cross-cutting (an idempotency extension applies to ALL schemes). The right home is the actor class, not the scheme.

**Alt E — Use a generic `Plugin` interface with a single `handle(event)` method.**
Rejected. A single event handler loses type safety — every plugin must switch on event types internally. Four typed hooks per actor are more explicit and enable better IDE support.

**Alt F — Put extension negotiation in a separate handshake (pre-402).**
Rejected. Adding a pre-flight request doubles latency. The 402 response already carries requirements; the payment payload already carries data. Piggybacking `supported` keys on the payload is zero extra round trips.

## Consequences

**Positive:**
- All seven x402 design flaws are fixed.
- Extension authors get a typed, lifecycle-aware API with clear contracts.
- The `critical` flag gives operators control over failure behavior.
- Dependency ordering prevents non-deterministic hook execution.
- Transport-agnostic design means extensions work across HTTP, MCP, and A2A without modification.

**Negative:**
- `process()` gains four hook invocation points, adding latency (mitigated by skipping when no extensions registered).
- The `extensions` field on `s402PaymentPayload` changes shape (gains `supported` and `data` sub-fields). Existing consumers that set `extensions` as a flat `Record` need migration.
- Extension dependency cycles are a new failure mode at registration time.

**Risks & watch-fors:**
- **Hook ordering assumptions.** Extensions that depend on execution order but don't declare `dependsOn` will have non-deterministic behavior. Mitigation: document that undeclared ordering is undefined; lint rule that warns when two extensions read/write the same key without a dependency.
- **Extension proliferation.** ADR-001 Decision 4's retirement criteria still apply. Every extension must have a deprecation criterion in its docs.
- **Performance in hot path.** The facilitator's `process()` is the payment hot path. Four hook invocation points with async/await could add latency. Mitigation: skip hook invocation entirely when no extensions are registered (zero-cost when unused).

## Implementation Plan

| Step | Where | What |
|------|-------|------|
| 1 | `s402/typescript/src/extensions.ts` | New file: `s402Extension`, `s402ClientExtension`, `s402ServerExtension`, `s402FacilitatorExtension` interfaces + `getExtensionData<T>()` helper + topological sort utility |
| 2 | `s402/typescript/src/types.ts` | Add `extensions` to `s402PaymentPayloadBase` and `s402SettleResponse` |
| 3 | `s402/typescript/src/errors.ts` | Add `EXTENSION_FAILED` error code |
| 4 | `s402/typescript/src/client.ts` | Add `registerExtension()` + call `enrichPayload` hooks in `createPayment()` |
| 5 | `s402/typescript/src/server.ts` | Add `registerExtension()` + call `enrichRequirements` and `enrichSettleResponse` hooks |
| 6 | `s402/typescript/src/facilitator.ts` | Add `registerExtension()` + four hook invocation points in `process()` |
| 7 | `s402/typescript/src/index.ts` | Export new types and interfaces |
| 8 | `s402/docs/extensions/` | Create directory with README describing the documentation requirement |
| 9 | Tests | Unit tests for hook invocation order, critical vs advisory, dependency sort, negotiation |

## Follow-ups

- [ ] Implement extension interfaces (step 1)
- [ ] Wire into existing classes (steps 2-7)
- [ ] Create docs/extensions/ directory (step 8)
- [ ] Implement `org.s402.discovery` extension
- [ ] Implement `org.s402.payment-id` extension
- [ ] Implement `org.s402.auth` extension
- [ ] Add extension-related conformance test vectors
- [ ] Update s402-protocol.org docs with extensions guide
- [ ] Consider: should `s402RouteConfig` gain an `extensions` field for per-route extension config?
