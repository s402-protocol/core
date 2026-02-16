# Design Principles

How s402 is built and why it's built that way.

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
| `payment-required` | Server → Client | Base64-encoded JSON requirements |
| `x-payment` | Client → Server | Base64-encoded JSON payload |
| `payment-response` | Server → Client | Base64-encoded JSON settle result |

The presence of `s402Version` in the decoded JSON distinguishes s402 from x402. The `normalizeRequirements()` function handles auto-detection.

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

## Forward Compatibility

- **`extensions` field** on requirements allows arbitrary data without breaking parsers
- **`accepts` array** lets servers advertise multiple schemes, and clients pick the best one
- **Version field** (`s402Version: '1'`) enables future protocol evolution
- **Sub-path exports** (`s402/types`, `s402/http`, `s402/errors`, `s402/compat`) let consumers import only what they need
