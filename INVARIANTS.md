# s402 Protocol — Invariants & Proofs

> Formal safety properties of the s402 wire protocol.
> s402 is the HTTP layer — it defines WHAT gets sent, not HOW to settle.

---

## Notation

- **Safety**: Something bad NEVER happens
- **Liveness**: Something good EVENTUALLY happens
- `∎` marks the end of a proof
- `⚠️` marks a known limitation or assumption

---

## S1. Stale Payment Rejection (Safety)

**Statement**: A payment with an expired `expiresAt` timestamp is NEVER processed.

**Formally**: For all payment payloads P where `P.expiresAt < now`:
```
process(P) → reject (never settles on-chain)
```

**Proof (defense-in-depth via three independent layers)**:

```
Layer 1 — process() (facilitator.ts):
  if (payload.expiresAt < Date.now()) → reject with PAYMENT_EXPIRED

Layer 2 — verify() (scheme-specific):
  Each FacilitatorScheme.verify() independently checks expiresAt
  before submitting any RPC call.

Layer 3 — settle() (scheme-specific):
  Each FacilitatorScheme.settle() checks expiresAt one final time
  before constructing the PTB.

For a stale payment to settle, ALL THREE layers must fail simultaneously.

Layer 1 fails only if Date.now() returns a value LESS than the real time.
Layer 2 fails only if the same clock error persists through an async gap.
Layer 3 fails only if the same clock error persists through verify + settle.

Since each layer calls Date.now() independently (not caching a single value),
and JavaScript's Date.now() is monotonically non-decreasing on modern systems,
the probability of triple failure approaches zero.

⚠️ Assumption: The system clock does not go backwards.
On NTP-synced systems, backward jumps are rate-limited to < 1 second.  ∎
```

---

## S2. Trust Boundary Integrity (Safety)

**Statement**: Untrusted data from the network cannot corrupt internal protocol state.

**Formally**: For all HTTP inputs I, either:
```
decode(I) → valid s402PaymentRequirements  (safe to process)
OR
decode(I) → rejection  (input discarded)
```

No intermediate "partially decoded" state escapes the boundary.

**Proof (three-layer validation)**:

```
Layer 1 — Wire decode (http.ts):
  base64 string → JSON.parse → shape validation
  Unknown keys are stripped (allowlist, not blocklist — D-10 trust boundary)
  Invalid base64 → throw (caught at boundary)
  Invalid JSON → throw (caught at boundary)
  Missing required fields → throw (caught at boundary)

Layer 2 — Client intake (client.ts):
  Accepts only typed s402PaymentRequirements objects
  TypeScript compiler enforces field presence and types at compile time
  Runtime: Zod validation on untrusted input (facilitatorUrl, amounts)

Layer 3 — Facilitator process (facilitator.ts):
  Type checks expiresAt (must be number)
  Validates facilitatorUrl via new URL() (SSRF guard — M-1 patch)
  Validates amount via isValidU64Amount() (overflow guard — M-2 patch)
  Validates payTo via /^0x[0-9a-fA-F]{64}$/ regex (M-6 patch)

Each layer INDEPENDENTLY validates. No layer trusts the output of a previous layer.

Therefore: For corrupted data to reach business logic, it must pass
base64 decode + JSON parse + allowlist stripping + Zod validation +
URL validation + amount validation + address validation.  ∎
```

---

## S3. Five Irreducible Payment Schemes (Structural)

**Statement**: The five payment schemes (exact, prepaid, stream, escrow, unlock) are irreducible — none can be decomposed into a combination of the others.

**Proof (by unique on-chain object lifecycle)**:

```
Each scheme has a UNIQUE on-chain object lifecycle that cannot
be simulated by combining other schemes:

exact:   No persistent object. Single atomic transfer.
         Cannot be composed FROM others (it IS the atomic base case).

prepaid: Shared PrepaidBalance object with claim/dispute lifecycle.
         Requires: deposit → claim → claim → ... → withdraw
         Cannot be exact (needs persistent balance tracking).
         Cannot be stream (provider-initiated, not time-based).
         Cannot be escrow (no delivery condition, no arbiter).

stream:  Shared Stream object with time-based ticks.
         Requires: open → tick → tick → ... → close
         Cannot be prepaid (time-based, not count-based).
         Cannot be exact (needs persistent state across ticks).

escrow:  Shared Escrow object with conditional release.
         Requires: lock → {condition met → release} OR {deadline → refund}
         Cannot be stream (condition-based, not time-based).
         Cannot be exact (needs two-party confirmation).
         Cannot be prepaid (single delivery, not repeated calls).

unlock:  Two-stage flow: escrow creation → key release.
         Requires: pay → receipt → SEAL decrypt
         Cannot be exact (needs two transactions for key release).
         Cannot be escrow alone (adds cryptographic access control).

For decomposition to work, scheme A must be expressible as
f(B, C, ...) for other schemes B, C. But each scheme has
a distinct state machine (shared object lifecycle) that the
others cannot replicate. Move's type system enforces this:
a PrepaidBalance is not a Stream is not an Escrow.  ∎
```

**Corollary (Auction decomposition)**: An auction is NOT a sixth scheme because:
```
auction = price_discovery (coordination protocol) + settlement (exact | prepaid | stream)
Price discovery is not a payment primitive. It's a coordination problem.  ∎
```

---

## S4. Error Recoverability (Liveness)

**Statement**: For every s402Error, an autonomous agent can determine whether to retry without human intervention.

**Formally**: For all errors E:
```
E.retryable ∈ {true, false}
E.suggestedAction ∈ {meaningful recovery instruction}
```

**Proof (by construction)**:

```
errors.ts defines 16 error codes. Each carries:
  - code: typed identifier
  - retryable: boolean
  - suggestedAction: string

Retryable errors (agent should retry):
  NETWORK_ERROR         → retry with backoff
  SETTLEMENT_FAILED     → retry (M-5 patch: settle failure ≠ verify failure)
  TIMEOUT               → retry with longer timeout

Non-retryable errors (agent must change approach):
  PAYMENT_EXPIRED       → request new payment requirements
  INSUFFICIENT_BALANCE  → fund wallet
  INVALID_SIGNATURE     → rebuild and re-sign

No error has retryable = undefined or suggestedAction = "".
An agent processing an s402Error can always determine its next action
without parsing error message strings.  ∎
```

---

## S5. Concurrent Payment Deduplication (Safety)

**Statement**: Identical payment payloads submitted concurrently result in at most one settlement.

**Proof**:

```
facilitator.ts process() maintains an in-flight Set (H-2 hardening):

  const key = hash(payload)
  if (inflight.has(key)) → reject with DUPLICATE_PAYMENT
  inflight.add(key)
  try { verify() → settle() }
  finally { inflight.delete(key) }

For a duplicate to settle, it must pass the Set check.
Since Set.has() is synchronous in the Node.js event loop,
two concurrent calls with the same payload will be serialized:
  Call 1: has(key)? NO → add(key) → verify → settle
  Call 2: has(key)? YES → reject

⚠️ Limitation: This is per-process dedup. Multiple facilitator
instances could both process the same payload. On-chain, Sui's
transaction dedup (by digest) provides the final safety net.  ∎
```

---

## S6. x402 Compatibility Roundtrip (Structural)

**Statement**: Converting s402 → x402 → s402 preserves all x402-compatible fields.

**Formally**:
```
For all s402PaymentRequirements R:
  let x = toX402(R)
  let r = fromX402(x)
  For all fields f in x402 spec: r[f] == R[f]
```

**Proof**:

```
compat.ts defines:
  toX402(): maps s402 fields → x402 V1/V2 wire format
  fromX402(): maps x402 wire format → s402 fields

Fields in both specs (preserved in roundtrip):
  payTo, amount, network, asset, expiresAt → direct mapping

s402-only fields (stripped in toX402, absent in roundtrip):
  scheme, extensions, mandateId, prepaid-specific fields

This is BY DESIGN: s402 is a superset of x402.
The roundtrip preserves the x402 subset exactly.

42 compat tests verify this property exhaustively
across V1 and V2 format variations.  ∎
```

---

## Assumptions

1. **JavaScript monotonic clock**: `Date.now()` does not go backwards
2. **Node.js event loop**: Synchronous operations within a microtask are not interleaved
3. **Sui transaction dedup**: Validators reject duplicate transaction digests
4. **TLS transport**: HTTP payloads are not tampered with in transit (HTTPS assumed)
