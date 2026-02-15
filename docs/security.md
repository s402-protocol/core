# Security Model

How s402 handles trust, validation, and failure modes.

## Trust Boundaries

```
Untrusted                    Trust Boundary                   Trusted
────────────────────────────────┬──────────────────────────────────────
  HTTP headers (base64 JSON)    │  Decoded, validated types
  Network responses             │  Scheme implementations
  User-provided config          │  Internal function calls
```

All data from HTTP headers is **untrusted** until it passes through a decode function (`decodePaymentRequired`, `decodePaymentPayload`, `decodeSettleResponse`). These functions validate the shape of the JSON and throw `s402Error('INVALID_PAYLOAD')` if anything is wrong.

After validation, internal code can rely on TypeScript types.

## What s402 Validates

### Decode-time (shape validation)

Every decode function checks required fields exist and have the correct types:

| Function | Validates |
|----------|-----------|
| `decodePaymentRequired` | `accepts` (array), `network`, `asset`, `amount`, `payTo` (all strings) |
| `decodePaymentPayload` | `scheme` (valid enum), `payload` (object) |
| `decodeSettleResponse` | `success` (boolean) |

### Scheme-specific (semantic validation)

Each scheme's `verify()` method validates business logic:

- **Exact**: signature recovery, dry-run simulation, balance check
- **Stream**: stream creation PTB structure, deposit amount
- **Escrow**: deadline, arbiter address, escrow amount
- **Seal**: escrow creation, SEAL encryption ID match
- **Prepaid**: deposit amount, rate per call, max calls cap

### Facilitator `process()` (temporal validation)

Before dispatching to scheme verification:
- Checks `expiresAt` against current time
- Rejects expired requirements with `REQUIREMENTS_EXPIRED`

## What s402 Does NOT Validate

The core `s402` package is a **protocol layer** — it handles encoding, decoding, and dispatch. It does **not**:

- Verify cryptographic signatures (that's the scheme implementation's job)
- Check on-chain balances (requires Sui SDK / RPC, lives in `@sweepay/sui`)
- Broadcast transactions (scheme implementation)
- Rate-limit requests (server middleware concern)
- Authenticate callers (application concern)

This separation is intentional. The protocol layer stays small and auditable. Security-critical operations (signing, verification, settlement) live in scheme implementations where they can use the Sui SDK directly.

## Supply Chain

- **Zero runtime dependencies** — no `node_modules` attack surface in production
- **Dev dependencies only** — TypeScript, tsdown, vitest, vitepress (build/test tools)
- **ESM-only** — no dual CJS/ESM complexity that can lead to module confusion attacks

## Error Recovery

Every `s402Error` includes:

| Field | Purpose |
|-------|---------|
| `code` | Machine-readable error type |
| `retryable` | Whether the client should try again |
| `suggestedAction` | Human-readable recovery hint |

This prevents clients from guessing whether to retry. If `retryable` is `false`, the client knows to take a different action (top up balance, get a new mandate, switch schemes).

## Scheme-Specific Security

### Exact
- One transaction per request. No state between calls.
- The facilitator **must** call `waitForTransaction()` before returning success. Without finality confirmation, the server could grant access for a transaction that gets reverted.

### Prepaid
- On-chain rate caps: `claimed ≤ maxCalls × ratePerCall`
- On-chain balance cap: `claimed ≤ deposited amount`
- Withdrawal delay prevents immediate drain after usage
- The provider tracks usage off-chain, but the Move contract enforces the math

### Escrow
- Time-locked vault: funds can't be released until the buyer confirms
- Deadline enforcement: permissionless refund after deadline (anyone can trigger)
- Optional arbiter for dispute resolution

### Stream
- Per-second rate cap enforced on-chain
- Budget cap prevents runaway spending
- Minimum deposit ensures the stream is worth creating

### Seal
- Two-stage flow: TX1 creates escrow receipt, TX2 passes receipt to `seal_approve`
- Sui's `seal_approve` requires all arguments as `Argument::Input` — this constraint forces the two-stage design
- Encrypted content on Walrus is only decryptable after payment

## Direct Settlement

When using `s402DirectScheme`, the client builds, signs, and broadcasts the transaction itself. The `settleDirectly()` interface **must** call `waitForTransaction()` before returning success.

Without the finality wait, a client could report success for a transaction that hasn't been confirmed, creating a race condition with the resource server.

## Reporting Vulnerabilities

If you find a security issue, email **security@pixeldrift.co** (or open a private GitHub advisory on `s402-protocol/core`). We take security seriously and will respond within 48 hours.
