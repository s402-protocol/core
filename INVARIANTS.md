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

Layer 2 — verify() (facilitator-level):
  The facilitator's verify() independently checks expiresAt
  before dispatching to scheme.verify().

Layer 3 — settle() (facilitator-level):
  The facilitator's settle() checks expiresAt one final time
  before dispatching to scheme.settle().

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
  Validates payTo as non-empty string with no control characters (http.ts
  wire-decode). Chain-specific address format validation (e.g. Sui hex,
  Solana base58) is delegated to downstream chain adapters per S7.

Each layer INDEPENDENTLY validates. No layer trusts the output of a previous layer.

Therefore: For corrupted data to reach business logic, it must pass
base64 decode + JSON parse + allowlist stripping + Zod validation +
URL validation + amount validation + address validation.  ∎
```

---

## S3. Six Irreducible Payment Schemes (Structural)

**Statement**: The six payment schemes (exact, upto, prepaid, stream, escrow, unlock) are irreducible — none can be decomposed into a combination of the others.

**Proof (by unique on-chain object lifecycle)**:

```
Each scheme has a UNIQUE on-chain object lifecycle that cannot
be simulated by combining other schemes:

exact:   No persistent object. Single atomic transfer.
         Cannot be composed FROM others (it IS the atomic base case).

upto:    UptoDeposit object with cap-bounded variable settlement.
         Requires: deposit(max) → settle(actual ≤ ceiling ≤ max), remainder
         returned to payer (or deadline → expire/reclaim).
         Cannot be exact (settlement amount unknown at authorization;
         needs a deposit object and a refund path).
         Cannot be prepaid (ONE cap-bounded settlement, not repeated
         provider claims against a persistent balance).
         Cannot be escrow (no delivery condition or arbiter — the
         variable is the amount, not the release).

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

  const key = JSON.stringify(payload)
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
transaction dedup (by digest) provides the final safety net.

⚠️ Cross-process dedup: S5's in-flight Set provides per-process
safety. Multi-instance facilitator deployments (federated or
horizontally-scaled) obtain cross-process dedup via the
Idempotency-Key header defined in ADR-007 §"Idempotency semantics",
combined with a shared dedup cache (Redis, DynamoDB, or equivalent)
keyed on the Idempotency-Key value. S5 itself does not mandate shared
caching — operators who run multiple instances without a shared cache
rely on Sui validator dedup as the final safety net.  ∎
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
| exact       | Yes           | Local digest comparison     | IMPLEMENTED in `sweefi/packages/sui/src/s402/exact/client.ts` via shared `verifySuiSettlement` helper. Wired into `createS402Client` fetch path. See SweeFi ADR-010. |
| stream      | Yes           | Local digest comparison     | IMPLEMENTED in `sweefi/packages/sui/src/s402/stream/client.ts` via shared `verifySuiSettlement` helper. |
| escrow      | Yes           | Local digest comparison     | IMPLEMENTED in `sweefi/packages/sui/src/s402/escrow/client.ts` via shared `verifySuiSettlement` helper. |
| unlock TX1  | Yes           | Local digest comparison     | IMPLEMENTED in `sweefi/packages/sui/src/s402/unlock/client.ts` via shared `verifySuiSettlement` helper. TX1 only — TX2 is facilitator-constructed and falls under the open question below. |
| unlock TX2  | **No — facilitator constructs** | Attestation-based (TBD)     | OPEN QUESTION (blocks full S8 coverage for the unlock scheme — see the Allium spec's `open_question UnlockTX2` block) |
| prepaid     | Yes (deposit TX) | Local digest comparison | IMPLEMENTED in `sweefi/packages/sui/src/s402/prepaid/client.ts` via shared `verifySuiSettlement` helper. The deposit TX is client-signed — S8 applies. Receipt-chain verification for the claim phase is a separate concern. |

⚠️ **Implementation distinction (important).** The `exact` scheme is architecturally unique: it uses Sui framework primitives (`splitCoins`, `transferObjects`) and therefore requires no custom Move module. The stateful schemes are shared-object state machines that require custom Move contracts (`stream.move`, `escrow.move`, `unlock_receipt`, `prepaid.move`; `upto` uses an `UptoDeposit` proxy). The TypeScript scheme classes in `sweefi/packages/sui/src/s402/*/client.ts` implement `verifySettlement` via a shared `verifySuiSettlement()` helper in `sweefi/packages/sui/src/s402/verify.ts`. The `createS402Client` fetch wrapper calls this automatically after every successful settlement. See SweeFi ADR-010 for the design decision.

⚠️ **Known gap: unlock-TX2.** `unlock-TX2` is constructed by the facilitator after TX1 settles (see `s402UnlockPayload` comments in types.ts:270-288). S8 as stated does NOT cover this transaction. This is the single narrow case where the April 2026 council's original S13 "causal binding" proposal would bite, and it needs a separate invariant in v0.3. Filed as a follow-up against ADR-001.

⚠️ **S8 × S15 interaction.** S8 binds a single transaction's digest to the signer of *that* transaction. Long-running schemes (`stream`, `prepaid`, `escrow`, multi-phase `unlock`) span many transactions and may be signed by multiple pubkeys across their lifecycle (see S15, ADR-010). Each individual transaction's S8 binding remains intact — the long-lived scheme's *authority* is independently tracked per S15 via session-anchor capabilities. S8 is per-tx; S15 is per-session. Both hold; neither subsumes the other.

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
  const signedBytes = fromBase64(payload.payload.transaction);
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

## S15. Mid-Session Signer Rotation (Safety)

**Statement**: For any long-running scheme whose state persists across multiple on-chain transactions (`stream`, `prepaid`, `escrow`, multi-phase `unlock`), scheme state is bound to a stable **session anchor** (mandate capability, or the scheme's shared-object ID) rather than to the signer's public key. Rotation of the signer mid-session MUST NOT invalidate, truncate, or double-bill the in-flight scheme, provided the new signer is authorized by the session anchor.

**Formally**: For a scheme instance S with state-bearing object `obj(S)` and per-tx signer pubkey `pk_n`:

```
Let auth(pk, obj) = on-chain authorization predicate on obj(S) admits pk.

For all n, m where tx_n and tx_m act on obj(S):
  settlement(tx_n) succeeds  ⟺  auth(pk_n, obj(S)) = true
  settlement(tx_m) succeeds  ⟺  auth(pk_m, obj(S)) = true
  pk_n ≠ pk_m  does NOT imply  invalidation or double-billing of S
```

**Motivation (Sui-specific sharpness).** zkLogin ephemeral keys cycle on a max-epoch window by construction. Any long-running stream/prepaid/escrow will outlive multiple ephemeral keys. A protocol that binds scheme state to "the pubkey that signed the first tx" is incompatible with zkLogin at the limit. S15 makes the protocol explicitly rotation-tolerant.

**Per-scheme cases**:

| Scheme | Session anchor | Rotation tolerated | Authorization predicate |
|--------|---------------|--------------------|-------------------------|
| exact | None (one-shot) | N/A | Signer signs bytes |
| prepaid | `PrepaidBalance` object ID | YES | Caller ∈ `balance.authorized_claimants` OR holds mandate referenced by `balance.mandate_id` |
| stream | `Stream` object ID | YES | Caller holds stream's withdrawal capability OR matches `stream.provider` |
| escrow | `Escrow` object ID | PARTIAL — arbiter rotation tolerated; payer/payee fixed at lock | Arbiter cap transferable via `escrow::transfer_arbiter` |
| unlock | TX1 digest + `UnlockReceipt` | NO for TX1 (single-shot); facilitator rotation per ADR-009 G1 | S11 binds TX2 to TX1 cryptographically |

**Proof (prepaid case, representative)**:

```
PrepaidBalance is a shared object with state:
  - authorized_claimants: vector<address>   (or)
  - mandate_id: Option<ID>                  (Swee Mandate capability ref)
  - last_claimed_counter: u64                (S9 replay bound)

At claim time, the Move entry function verifies:
  let caller = tx_context::sender(ctx)
  assert!( vector::contains(&balance.authorized_claimants, &caller)
           OR swee_mandate::holds_capability(mandate_id, caller),
           EUnauthorizedClaim )

If signer rotates from pk_n to pk_{n+1} between claims, the new
signer is admitted iff auth(pk_{n+1}, balance) holds. S9 (monotonic
counter) continues to prevent replay regardless of which authorized
signer claims. Therefore: rotation preserves S1 + S5 + S9 without
truncating the scheme's lifecycle.                                  ∎
```

**What S15 forbids**:
1. SDKs MUST NOT cache "the signer for this stream is pubkey X" in memory and reject later envelopes from a different but still-authorized signer.
2. Scheme Move modules MUST NOT store `signer: address` as sole authority on the shared object. Authority MUST be a capability, a vector, or a mandate reference.
3. SDK-level session objects MUST expose `rotateSigner(newSigner)` OR be constructed with a capability reference rather than a pubkey.

⚠️ **Limitation**: S15 does not prevent lost authority. An agent that rotates without updating the on-chain authorization predicate will correctly be rejected. This is a coordination concern, not a protocol concern. S15 guarantees the protocol is *capable* of tolerating rotation.

See ADR-010 for the full discussion, enforcement (`s402/no-captured-signer` lint rule), and the Move capability-authority audit check.

---

## S16. Protocol Version Binding (Safety)

**Statement**: The protocol version and scheme spec digest that a client commits to at signing time MUST be cryptographically bound into the signed payload, not transmitted only as transport headers. A facilitator that receives a signed payload for scheme X under version `V_old` MUST NOT be able to present it as a payload for scheme X under version `V_new`.

**Formally**: For all signed payment payloads P with `sig = sign(sk, bytes(P))`:

```
bytes(P)  includes  version_tag       (protocol version, e.g. "0.5.0")
bytes(P)  includes  spec_digest(P.scheme)  (SRI-format hash of scheme spec)

Therefore:
  sign(sk, bytes(P_v0.5.0))  ≠  sign(sk, bytes(P_v0.6.0))
  (even when every other field is identical)
```

**Motivation**. ADR-006 binds `s402-Version` and `s402-Spec-Digest` into **HTTP transport headers only**. These are not part of the bytes the signer signs over. This leaves a semantic-downgrade attack window: consider scheme `exact` upgrading v0.5.1 → v0.6.0 with a new field. A signed v0.5.1 `exact` payload does not commit to v0.5.1 semantics. A malicious facilitator that speaks v0.6.0 could present the same bytes under v0.6.0 semantics — the signature still verifies (same bytes), but the on-chain interpretation differs. Same bytes, different meaning, unchanged signature.

**Proof (that S16 closes the semantic-downgrade attack, Sui case)**:

```
Attack model: adversarial facilitator F receives client-signed payload P
under v0.5.1 exact semantics. F wants to submit under v0.6.0 semantics
(where v0.6.0 adds, e.g., an optional refund field that F populates to
route funds elsewhere).

Without S16 (post-ADR-006 state):
  Signed bytes B = BCS(TransactionData{ ptb: [
    Move_call(exact::pay, [Coin, recipient, amount])
  ]})
  B contains no commitment to version. F submits B to the chain.
  Chain executes whichever version of `exact` is currently published.
  Signature verifies against B. Attack succeeds.

With S16:
  Signed bytes B' = BCS(TransactionData{ ptb: [
    Move_call(exact::assert_protocol_version, ["0.5.1", "sha256-a1b2..."]),
    Move_call(exact::pay, [Coin, recipient, amount])
  ]})
  B' contains an explicit version assertion as the first PTB instruction.
  Chain executes assert_protocol_version, comparing "0.5.1" and
  "sha256-a1b2..." against the exact module's compiled-in constants.
  If on-chain exact is v0.6.0 without v0.5.1 in supported_versions, the
  assertion aborts. Entire PTB reverts. No state change. Attack defeated. ∎
```

**Implementation (Sui)**: every s402 scheme Move module exposes `assert_protocol_version(version, spec_digest)` and SDKs constructing a PTB prepend it as the first instruction.

**Implementation (non-Sui)**: for chains with opaque-bytes signing APIs (EVM `personal_sign`), binding is achieved by embedding the version tuple inside the signed message under a reserved domain prefix:

```
message = "s402-v1\0"
       || u32_be(len(version_tag))  || version_tag
       || u32_be(len(spec_digest))  || spec_digest
       || chain_payload_bytes
```

**Facilitator obligation**: on intake, compare `s402-Version` + `s402-Spec-Digest` headers against version/digest embedded in the signed payload; reject with `S402_VERSION_MISMATCH` (400) on disagreement.

**Client obligation**: after receiving a `settled` envelope, verify `envelope.specDigest` equals the digest the client bound into its own signed payload (constant-time compare, per S14).

⚠️ **Limitation**:
1. Sui: adds one extra PTB command (~300 gas, ~6% overhead on minimal `exact` settlement).
2. Non-Sui: enforcement is facilitator-layer, not chain-layer. A facilitator that strips the version prefix before on-chain submission breaks S16 — detected only if the client runs S8-style digest verification.
3. Presumes a trustworthy scheme-digest registry (ADR-006 history trust model).

See ADR-010 for the full implementation spec, `s402/require-version-assertion` lint rule, and the Move CI audit requirement.

---

## Assumptions

1. **Wall-clock nature of Date.now()**: `Date.now()` is wall time and CAN go backwards. Under NTP discipline, backward motion is slewed (not stepped); absent NTP, the S1 proof degrades. See S1 Assumption block for the detailed threat model.
2. **Node.js event loop**: Synchronous operations within a microtask are not interleaved.
3. **Sui transaction dedup**: Validators reject duplicate transaction digests.
4. **TLS transport**: HTTP payloads are not tampered with in transit (HTTPS assumed).
5. **Blake2b-256 collision resistance**: S8's digest-binding argument depends on blake2b-256 being collision-resistant at the ~2^128 work level.
6. **Ed25519 signature unforgeability**: The `exact` scheme's replay defense depends on the facilitator being unable to forge a signature over mutated transaction bytes.
7. **On-chain authority evaluation (S15)**: Move's `tx_context::sender` correctly reflects the transaction's signer at the point of capability/vector lookup, and Sui validators reject transactions whose signer fails the scheme's on-chain authorization predicate.
8. **Scheme-digest registry integrity (S16)**: The `supported_versions` constants compiled into a scheme's on-chain Move package at publish time accurately reflect the canonical spec digest for each advertised version. A backdoored registry defeats S16 — this is the ADR-006 history trust model problem, out of scope for S16 itself.
