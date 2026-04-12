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

Layer 1 fails only if Date.now() returns a value LESS than the real wall time.
Layer 2 fails only if the same clock error persists through an async gap.
Layer 3 fails only if the same clock error persists through verify + settle.

Each layer calls Date.now() independently (not caching a single value), so a
single spurious reading cannot defeat all three. Under the assumption below,
the probability of triple failure approaches zero.

⚠️ Assumption (explicit): Date.now() is wall-clock time, NOT a monotonic
clock. It CAN move backwards under NTP adjustments, leap-second smearing, or
manual operator changes. Prior versions of this proof incorrectly claimed
Date.now() is "monotonically non-decreasing"; that claim is false and has been
removed.

What we actually rely on:
  1. Under NTP discipline, backward adjustments are slewed (rate-limited),
     not stepped. Typical slew rate caps backward motion at ~500 parts per
     million, i.e. <0.5ms per wall-second.
  2. Even under a rare step-backward event (e.g. manual sysclock set), an
     attacker must arrange for Date.now() to read back-in-time at THREE
     independent call sites in the same request. On a non-colluding clock
     this is vanishingly unlikely.
  3. Facilitator operators SHOULD expose an operability check that fails
     closed when |ntp_offset| > 1s or a backward step > 100ms is detected
     in the process lifetime (see OPERATIONS.md, TBD in v0.3).

What the proof does NOT guarantee:
  - Fleet-wide consistency. Two facilitator instances MAY have drift
    ε_fleet up to ~500ms on virtualized hosts. The wire protocol makes
    no fleet-consistency claim; scheme-level dedup (S5) is the defense.
  - Security against a root attacker who can freely reset the clock. That
    is out of scope for S1 and belongs to the facilitator threat model.  ∎
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

## S7. Chain-Agnostic Protocol Surface (Structural)

**Statement**: The s402 wire protocol — as defined by `typescript/src/` and the 132 conformance vectors in `spec/vectors/` — contains **no chain-specific knowledge**. Address formats, amount bounds, signature schemes, and finality semantics are delegated to chain adapter packages (`@sweefi/sui`, `@sweefi/solana`, etc.). A breach of this invariant is how the protocol loses chain-agnosticism by accident.

**Formally**: For all source files `f ∈ typescript/src/`:
```
f imports no chain SDK            (@mysten/sui, @solana/*, ethers, viem, etc.)
f contains no chain-format regex  (e.g. /^0x[0-9a-fA-F]{64}$/, base58 checks, EVM checksums)
f contains no chain-specific amount bounds (e.g. u64 caps tied to Sui, decimals tied to SOL)
```

**Proof (by enforced boundary test)**:

```
test/s7-chain-agnostic.test.ts (boundary test introduced after the Feb 2026
incident) statically reads every file in typescript/src/ and asserts:

  1. No `import ... from '@mysten/...'`
  2. No `import ... from '@solana/...'`
  3. No `import ... from 'ethers'` or 'viem' or '@metaplex-foundation/...'
  4. No literal regex matching known chain address patterns
  5. No hard-coded chain-specific decimal/denomination constants

Chain-format validation belongs in chain adapters. `isValidU64Amount`
(http.ts) is allowed because u64 is a language-level integer bound, not a
chain-level property — it happens to be the current intersection of Sui
SUI/Move and EVM uint64 type widths, and exists to defeat amount-overflow
attacks at decode time.

Historical incident (2026-02): four consecutive AI sessions introduced a
`/^0x[0-9a-fA-F]{64}$/` regex into http.ts on the grounds that "the existing
tests expected it." A human reviewer caught the drift. S7 now exists to
make that drift impossible to introduce silently — the boundary test fires
on every PR. The LESSONS.md entry records the incident.

⚠️ Limitation: S7 is a LEXICAL check, not a semantic one. A contributor
could still introduce a chain-specific assumption inside a comment or a
string literal. The boundary test is defense against the common case
(imports + regexes), not against adversarial contributors.  ∎
```

**Scope note**: S7 applies ONLY to `typescript/src/`, not to `typescript/test/` or `typescript/examples/`. Chain-specific code lives in downstream implementation repos (e.g., `@sweefi/sui` for the Sui implementation) which consume this package from npm and add chain validation on top. Per ADR-002, the s402 repo itself contains NO chain-specific imports at the repo level — the protocol-pure boundary is enforced repo-wide, not just inside `src/`.

---

## S8. Facilitator Accountability (Safety)

**Statement**: A client NEVER marks a payment as settled based solely on a facilitator's self-reported `SettleResponse`. Every settlement claim is independently checked against a commitment the client made at signing time.

**Formally**: For all settlement flows where the client is also the signer:
```
let expected = chainDigest(hash_over(signed_bytes))   (local, offline)
let actual   = settleResponse.txDigest                (facilitator-reported)

client.treats_as_settled(payment)  ⟹  actual == expected
```

**Proof (for the `exact` scheme on Sui, by cryptographic commitment)**:

```
In the `exact` scheme, the client builds and signs the Transaction locally
in its chain-specific adapter (the canonical Sui reference is planned for
`sweefi/packages/sui/src/s402/exact/client.ts`, which consumes this package
from npm and implements `s402ClientScheme`). The signed payload consists of
{transaction: base64(bcs_bytes), signature: base64(ed25519_sig)}.

Sui's transaction digest is defined as:
  digest = base58(blake2b_256("TransactionData::" || bcs_bytes))

This is a pure function of bcs_bytes. No RPC call, no chain state, no gas
estimation, no network epoch — the digest is fully determined at the moment
the client signs.

Therefore, the client holding {bcs_bytes, signature} can compute the expected
digest at any time via TransactionDataBuilder.getDigestFromBytes() — a
synchronous, pure, offline function.

When the facilitator returns SettleResponse{txDigest: D}, the client runs:
  let expected = TransactionDataBuilder.getDigestFromBytes(fromB64(signed_bytes))
  if (D !== expected) → throw DIGEST_MISMATCH   (do NOT treat as settled)

For the facilitator to defeat this check, it would need to find
bcs_bytes' ≠ bcs_bytes such that:
  blake2b_256("TransactionData::" || bcs_bytes')
    == blake2b_256("TransactionData::" || bcs_bytes)

This is a blake2b-256 collision. Current cryptographic consensus places
this at ~2^128 work — infeasible by any current or projected compute.  ∎
```

**Implementation**: `s402ClientScheme.verifySettlement` is an optional interface method in `typescript/src/scheme.ts`. Concrete implementations live in downstream adapter repos — the canonical Sui implementation is planned for `sweefi/packages/sui/src/s402/{exact,stream,escrow,unlock}/client.ts` and will be tracked in SweeFi's own ADR-010. Callers MUST invoke `verifySettlement` after decoding `SettleResponse` and before recording a payment as settled. Every client-signed Sui scheme adapter should copy the implementation template below — the digest check is identical across schemes because the Sui transaction digest is a pure function of the BCS-encoded signed bytes.

**Scope — which schemes does S8 cover today?**

| Scheme | Client signs? | S8 verification method | Status |
|--------|---------------|------------------------|--------|
| exact       | Yes           | Local digest comparison     | INTERFACE SHIPPED (s402 v0.3.0); back-port into `sweefi/packages/sui/src/s402/exact/client.ts` pending per ADR-002. The `ExactSuiClientScheme` class exists in SweeFi; `verifySettlement` just needs to be added using the template below |
| stream      | Yes           | Local digest comparison     | INTERFACE SHIPPED (s402 v0.3.0); back-port into `sweefi/packages/sui/src/s402/stream/client.ts` pending. Move module `stream.move` already deployed on SweeFi testnet v11 |
| escrow      | Yes           | Local digest comparison     | INTERFACE SHIPPED (s402 v0.3.0); back-port into `sweefi/packages/sui/src/s402/escrow/client.ts` pending. Move module `escrow.move` already deployed on SweeFi testnet v11 |
| unlock TX1  | Yes           | Local digest comparison     | INTERFACE SHIPPED (s402 v0.3.0); back-port into `sweefi/packages/sui/src/s402/unlock/client.ts` pending. TX1 only — TX2 is facilitator-constructed and falls under the open question below |
| unlock TX2  | **No — facilitator constructs** | Attestation-based (TBD)     | OPEN QUESTION (blocks full S8 coverage for the unlock scheme — see the Allium spec's `open_question UnlockTX2` block) |
| prepaid     | Signed receipts | Receipt-chain verification | DIFFERENT MECHANISM — prepaid uses a facilitator-signed receipt chain, not client-signed tx digests. The current `s402ClientScheme.verifySettlement` shape does not apply directly; prepaid needs its own receipt-validation surface, which is a separate follow-up |

⚠️ **Implementation distinction (important).** The `exact` scheme is architecturally unique: it uses Sui framework primitives (`splitCoins`, `transferObjects`) and therefore requires no custom Move module. The other four schemes are shared-object state machines that require custom Move contracts (`stream.move`, `escrow.move`, `unlock_receipt`, `prepaid.move`). Per ADR-002, SweeFi testnet v11 already has all five Move modules deployed and all five TypeScript scheme classes implemented (`ExactSuiClientScheme`, `StreamSuiClientScheme`, etc. in `sweefi/packages/sui/src/s402/*/client.ts`). The only missing piece for the four client-signed schemes is the `verifySettlement` method itself — a mechanical back-port using the template below.

⚠️ **Known gap: unlock-TX2.** `unlock-TX2` is constructed by the facilitator after TX1 settles (see `s402UnlockPayload` comments in types.ts:270-288). S8 as stated does NOT cover this transaction. This is the single narrow case where the April 2026 council's original S13 "causal binding" proposal would bite, and it needs a separate invariant in v0.3. Filed as a follow-up against ADR-001.

### Implementation template — verifySettlement for any client-signed Sui scheme

The digest-binding check is **identical** across all client-signed schemes on Sui, because the digest is a pure function of the signed BCS bytes regardless of what the transaction does (transfer, Move call, shared-object mutation, etc.). When implementing a new client-signed scheme adapter, copy this template directly:

```typescript
verifySettlement(
  payload: s402PaymentPayload,
  settleResponse: s402SettleResponse,
): s402SettlementVerification {
  // Guard: make sure we were called on the right scheme variant
  if (payload.scheme !== '<YOUR_SCHEME>') {
    return {
      verified: false,
      expectedDigest: '',
      actualDigest: settleResponse.txDigest ?? null,
      reason: `verifySettlement called with non-<YOUR_SCHEME> scheme "${payload.scheme}"`,
    };
  }

  // Recompute the digest from OUR signed bytes — pure, offline, no RPC.
  // This is the commitment the client made to the facilitator at signing time.
  const signedBytes = fromB64(payload.payload.transaction);
  const expectedDigest = TransactionDataBuilder.getDigestFromBytes(signedBytes);

  const actualDigest = settleResponse.txDigest ?? null;
  if (actualDigest == null) {
    return {
      verified: false,
      expectedDigest,
      actualDigest: null,
      reason: 'SettleResponse did not include a txDigest — cannot verify',
    };
  }

  if (actualDigest !== expectedDigest) {
    return {
      verified: false,
      expectedDigest,
      actualDigest,
      reason:
        `Digest mismatch: facilitator returned ${actualDigest} but the ` +
        `signed payload commits to ${expectedDigest}. The facilitator ` +
        `broadcast a different transaction, or is lying about what it ` +
        `broadcast. Treat this payment as non-settled and do NOT retry.`,
    };
  }

  return { verified: true, expectedDigest, actualDigest };
},
```

**Why this is scheme-agnostic:** Sui's tx digest is `base58(blake2b_256("TransactionData::" || bcs_bytes))`. The bytes can encode any PTB — a bare transfer (exact), a `streaming_meter::create` Move call (stream), an `escrow::lock` call (escrow), whatever. The digest function doesn't care what the bytes mean. So every client-signed scheme's `verifySettlement` is literally a rename of the scheme guard check. The real work in implementing a new scheme is `createPayment` (building the PTB for the specific Move call), not `verifySettlement`.

**Chain-agnosticism note (S7):** This template is specific to the Sui adapter. A future Solana or EVM adapter would implement the same interface method but substitute Solana's transaction signature / EVM's transaction hash for the digest function. The `s402SettlementVerification` return type is chain-neutral and lives in `typescript/src/scheme.ts` to preserve S7.

---

## Assumptions

1. **Wall-clock nature of Date.now()**: `Date.now()` is wall time and CAN go backwards. Under NTP discipline, backward motion is slewed (not stepped); absent NTP, the S1 proof degrades. See S1 Assumption block for the detailed threat model.
2. **Node.js event loop**: Synchronous operations within a microtask are not interleaved.
3. **Sui transaction dedup**: Validators reject duplicate transaction digests.
4. **TLS transport**: HTTP payloads are not tampered with in transit (HTTPS assumed).
5. **Blake2b-256 collision resistance**: S8's digest-binding argument depends on blake2b-256 being collision-resistant at the ~2^128 work level.
6. **Ed25519 signature unforgeability**: The `exact` scheme's replay defense depends on the facilitator being unable to forge a signature over mutated transaction bytes.
