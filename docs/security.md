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
- **Unlock**: escrow creation, SEAL encryption ID match
- **Prepaid**: deposit amount, rate per call, max calls cap

### Facilitator `process()` (temporal validation)

Before dispatching to scheme verification:
- Checks `expiresAt` against current time
- Rejects expired requirements with `REQUIREMENTS_EXPIRED`

## What s402 Does NOT Validate

The core `s402` package is a **protocol layer** — it handles encoding, decoding, and dispatch. It does **not**:

- Verify cryptographic signatures (that's the scheme implementation's job)
- Check on-chain balances (requires Sui SDK / RPC, lives in your scheme implementation)
- Broadcast transactions (scheme implementation)
- Rate-limit requests (server middleware concern)
- Authenticate callers (application concern)

This separation is intentional. The protocol layer stays small and auditable. Security-critical operations (signing, verification, settlement) live in scheme implementations where they can use the Sui SDK directly.

## Supply Chain

- **Zero runtime dependencies** — no `node_modules` attack surface in production
- **Dev dependencies only** — TypeScript, tsdown, vitest (build/test tools)
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
- On-chain rate caps: `claimed ≤ maxCalls × ratePerCall` — hard ceiling enforced by Move contract
- On-chain balance cap: `claimed ≤ deposited amount` — provider cannot claim beyond deposit
- Withdrawal delay prevents immediate drain after deposit; gives provider time to claim
- **Trust model caveat:** The contract enforces a maximum, not an exact count. A provider can claim up to the cap regardless of actual API calls served. This is a trust-bounded model — appropriate for commercial relationships, not adversarial zero-trust scenarios. For the latter, use Escrow.
- **Horizontal scaling:** Multi-instance providers must coordinate off-chain usage counters to prevent double-authorization across instances.

### Escrow
- Time-locked vault: funds locked on-chain, not transferred until resolution
- Deadline enforcement: permissionless refund after deadline — anyone can trigger, no arbiter required
- **Optional arbiter:** An arbiter is a trusted third party for dispute resolution. Without one, the only resolution paths are buyer-confirms or deadline-expires. Arbiters are optional by design; for high-value transactions, choose an arbiter you trust independently of the protocol.

### Stream
- Per-second rate cap enforced on-chain
- Budget cap prevents runaway spending
- Minimum deposit ensures the stream is worth creating

### Unlock
- Two-stage flow: TX1 creates escrow receipt, TX2 passes receipt to `seal_approve`
- Sui's `seal_approve` requires all arguments as `Argument::Input` — this constraint forces the two-stage design
- Encrypted content on Walrus is only decryptable after payment

## Direct Settlement

When using `s402DirectScheme`, the client builds, signs, and broadcasts the transaction itself. The `settleDirectly()` interface **must** call `waitForTransaction()` before returning success.

Without the finality wait, a client could report success for a transaction that hasn't been confirmed, creating a race condition with the resource server.

## Reporting Vulnerabilities

If you find a security issue, please report it privately via either method:

- **Email:** dannydevs@proton.me (subject: `[s402 security] <brief description>`)
- **GitHub:** [Open a private security advisory](https://github.com/s402-protocol/core/security/advisories/new) on the `s402-protocol/core` repository

We take security seriously and will respond within 48 hours. See [SECURITY.md](https://github.com/s402-protocol/core/blob/main/SECURITY.md) for full disclosure policy and scope.
