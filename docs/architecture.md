---
description: s402 design principles — the three-actor model, validation boundaries, zero-dependency philosophy, and machine-native error model for autonomous agents.
---

# Design Principles

How s402 is built and why it's built that way. For a deeper walkthrough with annotated code and trade-off analysis, see [The Complete Guide — Chapters 5 & 6](/guide/the-s402-story#chapter-5-architecture-deep-dive).

## Three-Actor Model

Every s402 interaction involves three roles:

```
┌──────────┐     ┌──────────────────┐     ┌──────────────┐
│  Client   │────▶│  Resource Server  │────▶│  Facilitator │
│  (payer)  │◀────│  (payee)         │◀────│  (settler)   │
└──────────┘     └──────────────────┘     └──────────────┘
```

| Role | Responsibility | Class |
|------|---------------|-------|
| **Client** | Builds and signs payment transactions | `s402Client` |
| **Resource Server** | Sends 402 requirements, serves content after payment | `s402ResourceServer` |
| **Facilitator** | Verifies and broadcasts transactions on-chain | `s402Facilitator` |

Direct settlement collapses client + facilitator — the client broadcasts its own transaction without a middleman.

## Scheme Registry Pattern

Each role is a **registry** of scheme implementations. You register only the schemes you need:

```typescript
const client = new s402Client();
client.register('sui:mainnet', myExactScheme);
client.register('sui:mainnet', myStreamScheme);

// Client auto-selects the best scheme from server's accepts array
const payment = await client.createPayment(requirements);
```

This pattern means:
- **No dead code** — don't pay for schemes you don't use
- **Extensible** — add new schemes without modifying the core
- **Network-aware** — different scheme implementations per network

## Scheme Interfaces

Each scheme implements a specific interface depending on its role:

```typescript
// Client-side: builds payment payloads
interface s402ClientScheme {
  readonly scheme: s402Scheme;
  createPayment(requirements: s402PaymentRequirements): Promise<s402PaymentPayload>;
}

// Server-side: builds requirements
interface s402ServerScheme {
  readonly scheme: s402Scheme;
  buildRequirements(config: s402RouteConfig): s402PaymentRequirements;
}

// Facilitator-side: verifies and settles
interface s402FacilitatorScheme {
  readonly scheme: s402Scheme;
  verify(payload, requirements): Promise<s402VerifyResponse>;
  settle(payload, requirements): Promise<s402SettleResponse>;
}

// Direct settlement: no facilitator needed
interface s402DirectScheme {
  readonly scheme: s402Scheme;
  settleDirectly(requirements): Promise<s402SettleResponse>;
}
```

Each scheme has its **own** verify logic. Exact verification (signature recovery + dry-run) is fundamentally different from stream verification (deposit check) or escrow verification (deadline + arbiter check). The facilitator dispatches to the correct scheme — it never shares verification logic across schemes.

## Zero Runtime Dependencies

The `s402` package has zero production dependencies. The entire protocol layer is pure TypeScript using only:

- `TextEncoder` / `TextDecoder` (built-in)
- `btoa` / `atob` (built-in)
- `JSON.parse` / `JSON.stringify` (built-in)

Sui SDK, cryptographic signing, and RPC calls live in scheme implementations that you build on top of the protocol layer. This keeps the core small, auditable, and free from supply chain risk.

## Wire Compatibility

s402 uses the same HTTP headers as x402:

| Header | Direction | Content |
|--------|-----------|---------|
| `payment-required` | Server → Client | Base64-encoded x402 V2 `PaymentRequired` envelope |
| `x-payment` | Client → Server | Base64-encoded JSON payload |
| `payment-response` | Server → Client | Base64-encoded JSON settle result |

The 402 document is x402 V2's, so nothing distinguishes an s402 402 from a plain x402 one except `extensions.s402` — and a 402 without it is still payable. `detectProtocol()` reports which you have; `normalizeRequirements()` also reads the two retired flat shapes (x402 V1, s402 wire v1).

## Transport Abstraction

Payment is not tied to HTTP. The `PaymentTransport` interface (ADR-011) is a lossless mapping between the canonical `{ PaymentRequirements, PaymentPayload, SettleResponse }` and a *carrier's* out-of-band metadata slot. The protocol core (schemes, facilitator, invariants) is transport-agnostic; each carrier is a thin adapter — a projection, not a reimplementation.

| Transport | Frame (`TFrame`) | Where payment rides |
|-----------|------------------|---------------------|
| `httpTransport` | `Headers` | `payment-required` / `x-payment` / `payment-response` headers (base64 JSON) |
| `mcpTransport` | `_meta` record | `_meta['s402/payment']` (structured JSON — MCP's idiom, no base64) |
| `a2aTransport` | task `metadata` | `s402.payment.*` on the A2A task lifecycle (structured JSON) |

Every method threads an optional `PaymentCarrierContext` (`status` + `correlationId`). This is shaped for the *most stateful* carrier: A2A carries an explicit payment status on its task lifecycle (`input-required → completed/failed`) with a `taskId` correlation, so its decoder **reads** the status; the stateless carriers (HTTP, MCP) **derive** it from which message is present. Designing for the hardest carrier up front is why A2A was added as a thin adapter rather than an interface change.

**One trust boundary, three envelopes.** All decoders route through the same canonical `validate*Shape`/`pick*Fields` (see below), so untrusted MCP or A2A input crosses the identical trust boundary as untrusted HTTP input — adding carriers multiplies the surface area but not the validation logic.

**x402 interop stays opt-in.** Accepting an x402 client over any carrier needs x402→s402 *shape* normalization, so it lives in the opt-in `s402/compat/x402` layer (`fromX402PayloadHeaders` / `fromX402PayloadMeta` / `fromX402PayloadA2A`), keeping the core carriers x402-free. s402 ships an A2A implementation; x402 (as of this writing) defines A2A only as a spec.

## Validation at Trust Boundaries

All decode functions validate the shape of incoming data:

```typescript
// This is a trust boundary — data comes from the network
const requirements = decodePaymentRequired(header);
// ✓ Validates: accepts (array), network (string), asset (string),
//              amount (string), payTo (string)
// ✗ Throws s402Error('INVALID_PAYLOAD') if malformed
```

Validation happens at **decode time**, not deep in business logic. Once data passes the trust boundary, internal code can rely on the types.

## Expiration Guard

The facilitator's `process()` method provides an expiration guard:

```typescript
async process(payload, requirements): Promise<s402SettleResponse> {
  // 1. Type-check + reject expired requirements
  if (requirements.expiresAt != null) {
    if (typeof requirements.expiresAt !== 'number' || !Number.isFinite(requirements.expiresAt))
      return { success: false, errorCode: 'INVALID_PAYLOAD' };
    if (Date.now() > requirements.expiresAt)
      return { success: false, errorCode: 'REQUIREMENTS_EXPIRED' };
  }
  // 2. Verify
  const result = await scheme.verify(payload, requirements);
  if (!result.valid) return { success: false, errorCode: 'VERIFICATION_FAILED' };
  // 3. Latency guard — re-check expiration after verify (dry-run may be slow)
  if (typeof requirements.expiresAt === 'number' && Date.now() > requirements.expiresAt)
    return { success: false, errorCode: 'REQUIREMENTS_EXPIRED' };
  // 4. Settle
  return scheme.settle(payload, requirements);
}
```

Three design details:
- **Type guard**: Defends against `expiresAt: "never"` from untrusted JSON (string comparison silently bypasses the check in JS)
- **Latency guard**: If the dry-run took a long time, don't waste gas on requirements the server has already expired
- **Not a TOCTOU fix**: Sui PTBs are atomic. The latency guard just avoids broadcasting stale transactions

## Cross-Language Conformance

s402 ships [161 machine-readable JSON test vectors](/guide/conformance) that define correct behavior for all encode/decode paths, validation rules, and key-stripping boundaries. Both the TypeScript and Python implementations pass all 161 vectors — producing byte-identical wire output. Any new implementation in any language can load these vectors and verify compliance.

The vectors live in `test/conformance/vectors/` in the repository. They are generated from source (never hand-written) and validated by multiple rounds of expert audit.

## Forward Compatibility

- **`extensions` field** on requirements allows arbitrary data without breaking parsers
- **`accepts` array** lets servers advertise multiple schemes, and clients pick the best one
- **Version fields** (`extensions.s402.version` on the 402, `s402Version` on payloads) enable future protocol evolution
- **Sub-path exports** (`s402/types`, `s402/http`, `s402/errors`, `s402/compat/x402`) let consumers import only what they need
