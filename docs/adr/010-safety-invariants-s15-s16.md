# ADR-010: Safety Invariants S15–S16 — Session Binding and Version Binding

**Status:** Draft
**Date:** 2026-04-21
**Related:** INVARIANTS.md (S1–S8), ADR-006 (Version Negotiation), ADR-007 (Settlement Envelope), ADR-008 (Safety Invariants S9–S14), ADR-009 (Open Gaps)

---

## Context

After the Wave 4 Council review of April 2026, five candidate safety properties were proposed as potentially missing from s402: **atomicity**, **auditability**, **version binding**, **cross-process idempotency**, and **revocability**. A disciplined delta analysis against existing invariants and ADRs reveals only two are genuine gaps:

| Candidate | Status | Reason |
|-----------|--------|--------|
| Atomicity | ❌ Already covered | S8 (digest binding) + ADR-007 §`txBinding` together give "if `settled = true`, the claim is cryptographically verifiable." Adding a separate atomicity invariant would be rhetoric not substance. |
| Auditability | ❌ Already covered | S11 (unlock-TX2 attestation chain) + ADR-007 envelope (`facilitatorIds`, `txBinding`, typed status) already give structured audit records per settlement. |
| Version binding | ✅ **Genuine gap** | ADR-006 puts `s402-Version` and `s402-Spec-Digest` in **HTTP transport headers only**. These are not in the signed payload, so a signature produced under v0.5 scheme semantics is cryptographically indistinguishable from the same bytes interpreted under a future v0.6 scheme. |
| Cross-process idempotency | ❌ Already covered | ADR-007 §"Idempotency semantics" (lines 252–279) defines the `Idempotency-Key` header with facilitator-side dedup cache semantics. Combined with S5 (per-process in-flight set) and Sui validator dedup, the retry story is covered end-to-end. |
| Revocability | ❌ Out of scope for s402 | Revocation is a **capability-layer** concern belonging to the Swee Mandate Move module (SweeFi) and to facilitator identity rotation (ADR-009 G1). s402 is a wire protocol — it transports payments, it does not issue the authorities being revoked. |

In addition, agentic systems in production rotate signing addresses mid-session for five distinct reasons: (1) zkLogin ephemeral key expiry on Sui, (2) session-key rotation (cold key in vault, hot key signs), (3) OAuth-style mandate refresh, (4) privacy rotation (agent cycles signers every N txs to avoid address correlation), (5) agent handoff. Long-running schemes (`stream`, `prepaid`, `escrow`) are designed to outlive single transactions — and therefore single signers. The wire protocol today implicitly assumes signer identity is stable across the lifecycle of a scheme's shared-object state machine. **That assumption is wrong for the Sui case, where zkLogin ephemeral keys cycle on epochs by construction.** This is the "QUIC connection migration" problem restated in payment terms.

This ADR closes both gaps.

---

## Decision

Add two new invariants to `typescript/INVARIANTS.md`:

- **S15 — Mid-Session Signer Rotation** (Safety): bind long-running scheme state to the mandate/capability object, not to the signer's public key.
- **S16 — Protocol Version Binding** (Safety): bind the protocol version and scheme digest into the signed payload, not only into transport headers.

Also make two small augmentations to existing invariants to acknowledge partial-coverage relationships:

- **S5** — add a one-paragraph note referencing ADR-007's `Idempotency-Key` extension for cross-process dedup.
- **S8** — add a one-paragraph note referencing S15 for the long-lived scheme case.

### S15. Mid-Session Signer Rotation (Safety)

**Statement.** For any long-running scheme whose state persists across multiple on-chain transactions (`stream`, `prepaid`, `escrow`, `unlock` multi-phase), the protocol MUST bind scheme state to a stable **session anchor** (mandate ID, or the scheme's shared-object ID) rather than to the signer's public key. Rotation of the signer mid-session MUST NOT invalidate, truncate, or double-bill the in-flight scheme, provided the new signer is authorized by the session anchor.

**Formally.** For a scheme instance `S` with state-bearing object `obj(S)` (a shared `Stream`, `PrepaidBalance`, `Escrow`, or mandate capability):

```
Let pk_n = signer pubkey at the n-th transaction in S's lifecycle.
Let auth(pk, obj) = does the on-chain authorization predicate on obj(S) admit pk?

  For all n, m  where  tx_n and tx_m  act on  obj(S):
    settlement(tx_n) succeeds  ⟺  auth(pk_n, obj(S)) = true
    settlement(tx_m) succeeds  ⟺  auth(pk_m, obj(S)) = true
    pk_n ≠ pk_m  does NOT imply  invalidation or double-billing of S
```

Equivalently: the state machine of a scheme depends on its shared object's state, not on "same signer proved it last time."

**Per-scheme cases.**

| Scheme | Session anchor | Rotation tolerated? | Authorization predicate |
|--------|---------------|---------------------|------------------------|
| exact | None (one-shot) | N/A — scheme is a single tx | Signer signs bytes |
| prepaid | `PrepaidBalance` object ID | YES | On-chain check: new signer pubkey is in `balance.authorized_claimants` OR holds the mandate capability referenced by `balance.mandate_id` |
| stream | `Stream` object ID | YES | On-chain check: new signer holds the stream's withdrawal capability OR matches `stream.provider` |
| escrow | `Escrow` object ID | PARTIAL — rotation of *arbiter* tolerated; rotation of *payer* or *payee* is a new escrow | Arbiter capability is transferable per `escrow::transfer_arbiter`; payer/payee are fixed at lock time |
| unlock | TX1 digest + `UnlockReceipt` object | NO for TX1 (single-shot); YES for TX2 facilitator identity per ADR-009 G1 | S11 attestation binds TX2 to TX1 cryptographically; facilitator pubkey rotation is ADR-009 G1 |

**Proof sketch (prepaid case, representative):**

```
PrepaidBalance is a shared object. Its state includes:
  - authorized_claimants: vector<address>   (or)
  - mandate_id: Option<ID>                  (reference to a Swee Mandate capability)
  - last_claimed_counter: u64                (S9 replay bound)

At claim time, the Move entry function verifies:
  let caller = tx_context::sender(ctx)
  assert!( vector::contains(&balance.authorized_claimants, &caller)
           OR swee_mandate::holds_capability(mandate_id, caller),
           EUnauthorizedClaim )

Call this predicate auth(caller, balance). Move's type system and the
call's tx_context guarantee caller is the current-tx signer.

If at tx_n the signer rotates from pk_n to pk_{n+1}, the new signer
is admitted iff auth(pk_{n+1}, balance) holds. S9 (monotonic counter)
continues to prevent replay regardless of which authorized signer claims.
Therefore: rotation preserves S1 (expiry), S5 (dedup), S9 (replay) without
truncating the scheme's lifecycle.                                         ∎
```

**What S15 forbids.**

1. s402 SDKs MUST NOT cache "the signer for this stream is pubkey X" in memory and reject later envelopes that come from a different signer but the same session anchor.
2. Scheme Move modules MUST NOT store `signer: address` as the single authority on the shared object. Authority MUST be a capability, a vector, or a mandate reference — something that can name multiple pubkeys or be transferred.
3. SDK-level session objects (e.g., `s402ClientSession`) MUST expose a `rotateSigner(newSigner)` method OR MUST be constructed with a capability reference rather than a pubkey.

**Interaction with existing invariants.**

- **S8 (facilitator accountability / digest binding)** — unaffected: each individual tx's digest is still a pure function of the signed bytes, regardless of which pubkey signed. S15 operates one layer up, at the scheme-lifecycle level.
- **S9 (replay bounds)** — unaffected: monotonic counters and per-object state dedup are signer-agnostic.
- **S11 (unlock-TX2 attestation)** — clarified: TX1's signer may be different from the signer that later consumes the released key, provided the key consumer holds the unlock's recipient capability.

**Limitation (⚠️).** S15 does not *prevent* lost authority — if an agent rotates to a new signer without updating the on-chain authorization predicate, the new signer is correctly rejected. This is a coordination concern (agent must update on-chain authority before rotating), not a protocol concern. S15 guarantees the protocol is *capable* of tolerating rotation; it does not hand-hold operators through the ceremony.

**Enforcement.**

- **Lint.** `@sweefi/eslint-config` adds a rule that flags any SDK-level `const signer = session.signer` pattern captured outside of a per-transaction scope. Sessions expose `getActiveSigner()` (per-tx, re-evaluated); capturing a signer reference for the lifetime of a session is forbidden.
- **Move-side.** Move modules in `@sweefi/sui` that implement scheme state objects MUST use a capability-based authority pattern (`TransferCap`, `ClaimCap`, or a mandate reference). An audit check on PRs to `sweefi/move/*.move` verifies no scheme stores `signer: address` as sole authority.
- **Conformance.** Each long-running scheme's adversarial test catalogue (S12) MUST include a "rotate signer mid-session" vector: initiate with signer A, complete with signer B where B is authorized by the session anchor. Vector MUST pass (not fail).

---

### S16. Protocol Version Binding (Safety)

**Statement.** The protocol version and the scheme spec digest that a client commits to when signing MUST be cryptographically bound into the signed payload, not transmitted only as transport headers. A facilitator that receives a signed payload for scheme `X` under version `V_old` MUST NOT be able to present it as a payload for scheme `X` under version `V_new` (even if `V_new` is a valid future upgrade of `X`).

**Formally.** For all signed payment payloads `P` with signing operation `sig = sign(sk, bytes(P))`:

```
bytes(P)  includes  version_tag       (protocol version, e.g. "0.5.0")
bytes(P)  includes  spec_digest(P.scheme)  (SRI-format content-hash of the scheme spec)

Therefore:
  sign(sk, bytes(P_v0.5.0))  ≠  sign(sk, bytes(P_v0.6.0))
even when every other field is identical.

A v0.6.0-aware facilitator that receives P_v0.5.0 MUST:
  (a) verify sig against the v0.5.0-tagged bytes, not re-tag as v0.6.0, AND
  (b) execute the v0.5.0 semantics for P.scheme, not v0.6.0's semantics.
```

**Why this matters.** ADR-006 puts `s402-Version` and `s402-Spec-Digest` in HTTP headers and optionally in the `PaymentRequirements` JSON body. A header is a transport assertion made by the facilitator or the client at request time; it is not part of the bytes the signer signs over. Consider a scheme amendment where `v0.5.1 → v0.6.0` changes the `exact` scheme to require an extra field (say, `intent_scope_version`). A signed v0.5.1 `exact` payload does not commit to v0.5.1 semantics. A malicious facilitator that speaks v0.6.0 could present the same bytes to the chain under v0.6.0 semantics — the signature still verifies (same bytes), but the on-chain interpretation differs. This is a **semantic downgrade attack**: same bytes, different meaning, unchanged signature.

**Implementation — for the `exact` scheme on Sui.**

The client-signed `bytes(P)` is the BCS-encoded Sui `TransactionData`. The protocol version cannot be added to Sui's native TransactionData without breaking Sui's own signing rules, so the binding lives one layer out, in the PTB itself:

- Every s402 Move scheme module MUST expose a `fn assert_protocol_version(version: vector<u8>, spec_digest: vector<u8>)` entry function.
- SDKs constructing a PTB for an s402 payment MUST prepend a call to `assert_protocol_version(version, spec_digest)` as the first instruction in the PTB.
- The Move function verifies the passed version + digest against module constants compiled into the scheme's on-chain package at its publication time.
- If the version/digest do not match, the entry function aborts — the entire PTB fails atomically.

Result: the signed `TransactionData` BCS bytes now include a call to `assert_protocol_version(v0.5.1, sha256-a1b2…)`. A facilitator trying to present the same bytes under v0.6.0 semantics cannot — the on-chain assertion aborts.

**Implementation — for non-Sui chains.**

For chains whose signing bytes are less flexible than Sui's (e.g., EVM where a `personal_sign` wraps an opaque string), the binding is achieved by embedding the version tuple **inside the signed message text** under a reserved domain prefix:

```
message-to-sign = "s402-v1\0"
                || version_tag_length (u32 BE) || version_tag
                || spec_digest_length (u32 BE) || spec_digest
                || chain_payload_bytes
```

Where `chain_payload_bytes` is the chain-native request (e.g., EIP-712 typed struct for EVM, Solana transaction bytes). The domain prefix `"s402-v1\0"` ensures this message cannot collide with any non-s402 signing context.

**Verification obligation (client).** After receiving a `settled` envelope, the client (in addition to the 8 checks already required by ADR-007) MUST verify that the `specDigest` in the envelope equals the digest the client bound into its own signed payload. Envelope-level and payload-level digests MUST agree; disagreement proves a rogue facilitator or a cross-version attack.

**Verification obligation (facilitator).** On intake:
1. Compare the `s402-Version` and `s402-Spec-Digest` headers against the version/digest embedded in the signed payload.
2. If headers disagree with embedded values, reject with `S402_VERSION_MISMATCH` (400).
3. Only after headers-vs-payload consistency checks pass may the facilitator dispatch to scheme-specific logic.

**Proof (that S16 closes the semantic-downgrade attack):**

```
Attack model: Adversarial facilitator F receives a client-signed
payload P under v0.5.1 exact semantics. F wishes to present P to the
chain under v0.6.0 exact semantics (where the semantics have diverged
in a way that benefits F — e.g., v0.6.0 includes an optional refund
field that F populates to route funds elsewhere).

Without S16 (current state, post-ADR-006):
  Signed bytes B = BCS(TransactionData{ inputs: [...], ptb: [
    Move_call(exact::pay, [Coin, recipient, amount])
  ]})
  B contains no commitment to version.
  F submits B to the chain.
  Chain executes v0.6.0 of exact (because that's what's published).
  Signature verifies against B. Attack succeeds.

With S16 (post this ADR):
  Signed bytes B' = BCS(TransactionData{ inputs: [...], ptb: [
    Move_call(exact::assert_protocol_version, ["0.5.1", "sha256-a1b2..."]),
    Move_call(exact::pay, [Coin, recipient, amount])
  ]})
  B' contains an explicit version assertion as the first PTB instruction.
  F submits B' to the chain.
  Chain executes assert_protocol_version, which compares "0.5.1" and
  "sha256-a1b2..." against the exact module's compiled-in constants.
  If the on-chain exact module has been upgraded to v0.6.0 without
  preserving v0.5.1 as a supported version, the assertion aborts.
  The entire PTB reverts. No state change. Attack defeated.                ∎
```

**Implementation implications for scheme maintainers.**

Each scheme Move module publishes a `supported_versions: vector<VersionTag>` constant at package publish time. Scheme upgrades MAY preserve older versions in this vector (allowing in-flight signed payloads to continue settling under their signed semantics) OR MAY drop older versions (forcing all clients to re-sign under the new version). The choice is per-upgrade and documented in the amendment chain (ADR-006).

**Interaction with existing invariants.**

- **S6 (x402 roundtrip)** — x402 responses that do not carry s402 version metadata will fail S16 on return trip if the facilitator ingesting them is enforcing version binding. Mitigation: compat layer in `typescript/src/compat.ts` tags x402-sourced payloads with a reserved version tag `"x402-compat-v<n>"` during ingestion.
- **S9 (replay bounds)** — version binding is orthogonal. A payload signed under v0.5.1 cannot be replayed under v0.6.0 semantics; within v0.5.1 itself, S9 still governs.
- **S10 (extension additivity)** — extensions MUST also bind their own version into the signed payload via an analogous `assert_extension_version` call. An extension upgrade that doesn't preserve backward version compatibility is a breaking change.

**Limitation (⚠️).**
1. S16's Sui implementation costs one extra PTB command (~300 gas units). Measured cost at v0.6.0 release: ~6% overhead on the minimal `exact` settlement.
2. Non-Sui chains with signed-opaque-bytes APIs (EVM `personal_sign`) have weaker guarantees: the binding is enforced at the facilitator layer on ingress, not at the chain itself. A facilitator that strips the version prefix before on-chain submission breaks S16 — detected only if the client runs an S8-style digest verification.
3. S16 presumes a trustworthy scheme-digest registry. If a malicious maintainer backdoors the scheme's published spec without bumping the digest, the binding binds to the wrong content. This is ADR-006's "history trust model" problem and is out of scope here.

**Enforcement.**

- **Lint.** `@sweefi/eslint-config` rule `s402/require-version-assertion` flags any PTB constructor in `@sweefi/sui/src/s402/**/client.ts` that doesn't prepend `assert_protocol_version` as the first instruction.
- **Test.** Conformance vector set includes `adversarial/version-strip-v05-presents-as-v06.json`: a valid v0.5.1 signed payload that a malicious facilitator attempts to execute under v0.6.0 semantics. Vector MUST fail (on-chain abort).
- **Move CI.** An audit check on `@sweefi/sui/move/**` modules verifies every scheme module exports `assert_protocol_version` and every scheme module's entry functions are unreachable without first calling it.

---

## Small augmentations to existing invariants

### S5 (Concurrent Payment Deduplication) — partial-coverage note

Append to S5's existing `⚠️ Limitation` block:

> **Cross-process dedup.** S5's in-flight Set provides per-process safety. Multi-instance facilitator deployments (e.g., federated or horizontally-scaled facilitators) obtain cross-process dedup via the `Idempotency-Key` header defined in ADR-007 §"Idempotency semantics", with a shared dedup cache (Redis, DynamoDB, or equivalent) keyed on the `Idempotency-Key` value. S5 itself does not mandate shared caching — operators who run multiple instances without a shared cache rely on Sui validator dedup as the final safety net.

### S8 (Facilitator Accountability) — S15 note

Append to S8's **Scope — which schemes does S8 cover today?** table a note:

> ⚠️ **S8 × S15 interaction.** S8 binds a single transaction's digest to the signer of *that* transaction. Long-running schemes (`stream`, `prepaid`, `escrow`, multi-phase `unlock`) span many transactions and may be signed by multiple pubkeys across their lifecycle (see S15). Each individual transaction's S8 binding remains intact — the long-lived scheme's *authority* is independently tracked per S15 via session-anchor capabilities. S8 is per-tx; S15 is per-session. Both hold; neither subsumes the other.

---

## Alternatives considered

**A1. Bind version via JWS signed metadata.** Rejected for the same reason ADR-006 rejected it: signing does not solve "what version does the other side speak." Binding lives in the payload being signed, not in a separate JWS envelope.

**A2. Bind version at the HTTP layer only (current ADR-006 state).** Rejected here — headers are not part of the signed bytes, so semantic-downgrade attacks are feasible across scheme-amendment boundaries. This ADR closes that door.

**A3. Add a generic `Session-Id` header to preserve session across signer rotation.** Rejected — a header is not a cryptographic commitment. The session anchor must be an on-chain object whose authority predicate is evaluated at every tx. S15 formalizes this; a session-id header is at best a SDK convenience.

**A4. Require every scheme to adopt a single authority model (e.g., always a capability, never a vector).** Rejected for v0.6.0 — different schemes have different authority semantics. A single model forces premature generalization. S15 states the invariant; each scheme picks the predicate that fits its semantics.

**A5. Drop S16 entirely; rely on facilitators to check version headers honestly.** Rejected — the whole point of s402 invariants is to hold in the presence of adversarial facilitators. S8 exists because the same argument was made there, and the response was "cryptographic binding is the answer, not facilitator trust." S16 is the analogous answer for version drift.

**A6. Add all five Council proposals (atomicity, auditability, version binding, idempotency, revocability) as new invariants.** Rejected — the delta analysis in **Context** shows three are already covered or out of scope. Invariant inflation reduces signal-to-noise without adding security.

---

## Consequences

**Positive:**
- The wallet-rotation-mid-session attack on long-running schemes now has a formal protocol response.
- The semantic-downgrade attack (same bytes, different version semantics) is closed at the Sui layer and mitigated for other chains.
- Two Council-identified concerns are addressed; three are explicitly shown to be already covered (prevents future re-litigation).
- Discipline: rejecting redundant invariants keeps the invariant system dense and learnable.

**Negative:**
- S15 adds an implementation burden to all long-running scheme Move modules (capability-based authority, not address).
- S16 adds ~300 gas (~6%) to every Sui settlement as an extra PTB instruction.
- S16 non-Sui enforcement is weaker (facilitator-layer, not chain-layer) until each chain's signing API is reviewed for domain-prefix compatibility.
- Scheme amendment process (ADR-006) becomes more consequential — a scheme upgrade that drops older versions from `supported_versions` breaks in-flight signed payloads.

**Neutral:**
- Invariants are documentation + CI obligations, not runtime cost on the critical path (except S16's one PTB instruction).

---

## Implementation sequencing

1. **Phase 1 (v0.6.1 docs):** Write S15 + S16 into INVARIANTS.md. Augment S5 and S8 with the notes defined above. Low effort, high signal.
2. **Phase 2 (v0.6.2 Sui):** Ship `assert_protocol_version` Move helpers across all scheme modules in `@sweefi/sui`; SDKs prepend it to every PTB. Lint rule `s402/require-version-assertion` lands here.
3. **Phase 3 (v0.7.0 multi-signer):** Formalize the `s402ClientSession` interface with explicit rotation support. Add `rotate-signer-mid-stream.json` conformance vector.
4. **Phase 4 (v0.7.x other chains):** As second chain adapter lands (Solana or EVM), adapt S16's non-native binding to that chain's signing API. Document the chain-specific weakening in the chain adapter's README.

---

## References

- s402 INVARIANTS.md §S1–S14
- s402 ADR-006 (Version Negotiation and Scheme Digests)
- s402 ADR-007 (Settlement Response Envelope) — §"Idempotency semantics" explains why cross-process idempotency is out of scope for this ADR
- s402 ADR-008 (Safety Invariants S9–S14)
- s402 ADR-009 (Open Gaps) — G1 (facilitator key rotation) is the analogous concern one layer up
- Sui zkLogin specification — ephemeral key epoch semantics
- RFC 9000 (QUIC) §9 — connection migration as the transport-layer precedent for session-vs-endpoint binding
- OAuth 2.0 RFC 6749 §1.5 — refresh token pattern as the capability-layer precedent for authority rotation without session loss
