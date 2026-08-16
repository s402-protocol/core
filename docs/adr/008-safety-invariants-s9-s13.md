# ADR-008: Safety Invariants S9–S14

**Status:** Draft (v2 — post /vet wave review; S14 added, S11 hardened)
**Implementation:** in-progress — **S11** and **S14** are built (`src/envelope.ts:77`, `:430`, `:443`; S14's constant-time comparison has its own test at `test/envelope.test.ts:429`). **S9, S10, S12 and S13** have no enforcement site found. Determined 2026-08-16 (DAN-855) by searching for the mechanisms, not only the labels — but treat the negatives as *no witness found*, not *proven absent*.
**Date:** 2026-04-19
**Related:** INVARIANTS.md (S1–S8), ADR-004 (Extensions), ADR-007 (Settlement Envelope), ADR-009 (Open Gaps)

---

## Context

s402 currently has eight invariants (`typescript/INVARIANTS.md` S1–S8) covering stale payment rejection, trust boundary integrity, scheme irreducibility, error recoverability, concurrent dedup, x402 roundtrip, chain-agnostic boundary, and facilitator accountability (client-signed Sui).

Gaps that block a "paranoid, defensive, proactive" security posture:

1. **Scheme-specific replay bounds are not centrally stated.** S1 covers stale payments via `expiresAt`. But each scheme has its own replay surface — exact has the nonce in the signed tx; stream has per-tick nonces; prepaid has claim receipts; escrow has two-party confirmations; unlock has sealed-key windows. These are implemented but not formalized as protocol-layer invariants.

2. **Extension safety is undefined.** ADR-004 describes the extensions architecture mechanically but doesn't guarantee that an extension cannot weaken a scheme's invariants.

3. **Unlock-TX2 causal binding is a known hole in S8** (already flagged at INVARIANTS.md:375). The attacker model: facilitator constructs TX2 after TX1 settles, so the client never signs TX2 and has no digest to bind against. Needs its own invariant + attestation protocol.

4. **No catalogued adversarial test vectors.** Each scheme ships unit tests, but there's no enumeration of "here are the attacks this scheme defends against and the MUST-fail-safe vectors that prove it."

5. **Cross-scheme composition is undefined.** Agents will chain schemes (e.g., unlock-to-decrypt then stream-to-consume). Invariants under composition are not stated.

---

## Decision

Add five new invariants S9–S13 to `typescript/INVARIANTS.md`.

### S9. Scheme Replay Bounds (Safety, per-scheme)

**Statement:** Every scheme declares an explicit replay window and nonce semantics. For each scheme, there exists a formal argument (in that scheme's `docs/schemes/<name>.md`) that a settled payment cannot be re-settled.

**Per-scheme cases:**

| Scheme | Nonce source | Window | Rejection mechanism |
|--------|--------------|--------|---------------------|
| exact | BCS tx bytes → digest | `expiresAt` | Sui validator dedup (same digest rejected) + S1 + S5 |
| prepaid | Receipt counter (monotonic, signed by client) | Per-claim | On-chain `PrepaidBalance.last_claimed_counter` < received counter |
| stream | Tick index (monotonic) | Per-tick | On-chain `Stream.next_tick_idx` > received idx |
| escrow | Escrow object ID + phase | Lifecycle | Move type system: `locked → {released|refunded}` is one-shot |
| unlock | TX1 digest + TX2 attestation (S11) | Two-phase | TX1 one-shot (Sui dedup); TX2 bound to TX1 via S11 |

**Proof obligation:** Each scheme's canonical spec at `docs/schemes/<scheme>.md` MUST contain a "Replay Rejection" section matching the row above.

**Test obligation:** Each scheme's conformance vector set MUST include at least one "replay the same payload twice; second attempt MUST fail" vector.

---

### S10. Extension Additivity (Structural)

**Statement:** An s402 extension cannot relax any safety invariant. Extensions can only *add* constraints.

**Formally:** For any extension `E` registered against scheme `S`:

```
invariants(S + E) ⊇ invariants(S)
```

Every invariant of the base scheme remains true when E is applied; E may add new invariants but cannot remove or weaken existing ones.

**Concrete prohibitions on extensions:**

- MUST NOT relax `expiresAt` checking (S1).
- MUST NOT short-circuit trust-boundary validation (S2).
- MUST NOT make scheme semantics composable into another scheme (S3 irreducibility is preserved).
- MUST NOT introduce chain-specific imports into the extension's protocol-layer code (S7).
- MUST NOT weaken replay bounds (S9).

**Enforcement:**

- `scripts/extension-lint.mjs` statically inspects declared extensions against a prohibition checklist.
- Runtime: the extensions loader (`typescript/src/extensions.ts`) rejects extensions whose declared effects violate the additivity rule.

**Limitation (⚠️):** Static analysis catches declared violations. An extension could still violate S10 via runtime behavior not reflected in its manifest. The runtime check is best-effort; defense-in-depth relies on manual review of third-party extensions before registration.

---

### S11. Unlock-TX2 Causal Binding (Safety)

**Statement:** For the `unlock` scheme's second transaction (TX2, constructed by the facilitator after TX1 settles), there exists an attestation chain `TX1_digest → TX2_digest` such that the client can verify TX2 was caused by its own TX1 and by no other cause.

**Formally:**

```
Let D1 = digest(TX1_signed_by_client)
Let D2 = digest(TX2_constructed_by_facilitator)
Let A  = facilitator_attestation(D1, D2, policy_hash)

client_accepts_unlock(D2) ⟹ verify_signature(A, facilitator_pubkey) AND attestation_binds(A, D1)
```

**Attestation structure:**

```typescript
type UnlockTx2Attestation = {
  /** digest of client's TX1 (format: "blake2b256-<base64url-no-pad>" for Sui) */
  tx1Digest: string;
  /** digest of facilitator's TX2 (same algorithm as tx1Digest) */
  tx2Digest: string;
  /** hash of the unlock policy (who gets the key, under what conditions), format "sha256-<base64url-no-pad>" */
  policyDigest: string;
  /** ISO-8601 UTC ms */
  constructedAt: string;
  /** ed25519 pubkey of the facilitator, format "ed25519-<base64url-no-pad>" */
  facilitatorPubkey: string;
  /** signature over the TLV-encoded input below */
  signature: string;
  /** algorithm identifier for the signature — "ed25519" default, reserves migration path */
  sigAlg: "ed25519";
};
```

**Signature input — length-prefixed TLV with domain separation.** The signature is computed over bytes assembled as:

```
input = "s402-attestation-v1\0"                   // domain-separation prefix, 20 bytes
      || u32_be(len(tx1Digest))        || tx1Digest
      || u32_be(len(tx2Digest))        || tx2Digest
      || u32_be(len(policyDigest))     || policyDigest
      || u32_be(len(constructedAt))    || constructedAt
      || u32_be(len(facilitatorPubkey))|| facilitatorPubkey

signature = Ed25519_sign(input, facilitator_secret_key)
```

Each field is UTF-8 bytes of its string representation. `u32_be` is a 4-byte big-endian length prefix. The domain prefix ensures this signature cannot be confused with any other s402 signature context (e.g., a future attestation type). Length prefixes eliminate the variable-length-concatenation collision class where one field's suffix could be absorbed into the next field's prefix.

**Rationale for TLV over concatenation.** An earlier draft used `sha256(tx1Digest || tx2Digest || policyDigest || constructedAt)`. Wave 1 cryptographic review found this ambiguous: if `policyDigest` and `constructedAt` have variable lengths, an attacker who can nudge the policy digest by N bytes and trim N bytes off the timestamp produces the same concatenated bytes — classic Merkle-Damgård preimage crafting. Length-prefixed TLV makes field boundaries unambiguous.

**Inline delivery — attestation MUST ride in the envelope.** For `scheme === "unlock"`, the `s402EnvelopeSettled.settled.attestation` field (typed `unknown` at protocol level, narrowed to `UnlockTx2Attestation` by the unlock adapter) MUST contain the attestation object. A facilitator that omits this field produces a non-conforming envelope and the client MUST reject.

This is a departure from the earlier "attestation at a separate URL" design (`GET /unlock/attestation/:tx1Digest`). The URL design was rejected in Wave 3 adversarial review as "attestation stripping": a naïve client consuming only `settled.settlement` gets SEAL key material without ever fetching the attestation, bypassing verification. Inline delivery puts the attestation on the happy path where the client cannot skip it by accident.

**Verification:** Client, before decrypting with the released SEAL key, MUST:

1. Observe TX2 on-chain (confirm facilitator actually broadcast it; tolerate finality window per chain adapter).
2. Extract the attestation from `envelope.settled.attestation`.
3. Verify `attestation.tx1Digest` matches the client's own TX1 digest (constant-time compare, S14).
4. Recompute the TLV-encoded signature input locally.
5. Verify `attestation.signature` against a pre-registered facilitator public key (from `.well-known/s402-facilitator` identity document) using `attestation.sigAlg`.
6. Verify `attestation.policyDigest` matches the policy the client agreed to at TX1 construction time (constant-time compare).
7. Verify `attestation.constructedAt` is within the envelope's overall skew window.

If any check fails, the client MUST NOT trust the decrypted content as authorized — even if SEAL returns the key — and MUST flag the facilitator as compromised.

**Layer boundary.** s402 defines S11 as an invariant: the attestation format, signing semantics, TLV encoding, and client verification. The facilitator implementation (SEAL key release, attestation construction, signing) is a SweeFi operator concern specified at `packages/facilitator/` per SweeFi ADR-011. Any conforming facilitator (SweeFi or third-party) MUST produce envelopes with inline attestations matching this structure; s402 does not prescribe how the attestation is signed (key custody is ADR-009 G1 territory).

**Limitation (⚠️):** S11 binds TX2 to TX1 *cryptographically*, not semantically. A malicious facilitator could still construct a TX2 that broadcasts to the wrong recipient — S11 ensures the client can *detect* this (via the `policyDigest` mismatch) but not *prevent* it. Prevention requires contract-level enforcement of the policy, which is a SweeFi Move-layer concern.

---

### S12. Adversarial Test Vector Catalogue (Structural)

**Statement:** Each scheme ships a documented adversarial test catalogue at `spec/vectors/<scheme>/adversarial/`. Each entry in the catalogue is a named attack, a description, and a conformance vector that MUST fail in a specified way.

**Minimum catalogue per scheme (v0.6.0 target):**

| Attack class | Schemes in scope | Vector name example |
|--------------|------------------|---------------------|
| Replay | all | `replay-same-payload.json` |
| Expired payment | all | `expired-slightly-before.json`, `expired-by-hours.json` |
| Amount tampering | all | `amount-overflow.json`, `amount-negative.json` |
| Address substitution | all | `paytoaddress-swapped.json` |
| Nonce-out-of-order | prepaid, stream | `stream-tick-regression.json` |
| Escrow double-release | escrow | `escrow-release-after-refund.json` |
| Unlock-TX2 forgery | unlock | `unlock-tx2-attestation-invalid.json`, `unlock-tx2-attestation-missing.json` |
| Extension additivity breach | all-with-extensions | `extension-relaxes-expiry.json` |
| Facilitator request-swap | all | `envelope-requestdigest-mismatch.json` |

Each vector MUST specify:
- The input payload.
- The expected rejection outcome (error code + suggested action).
- A rationale linking the vector to a specific invariant (S1–S13).

**CI obligation:** `pnpm test:adversarial` runs all catalogue vectors against the reference facilitator and asserts the expected rejection. PR fails if any adversarial vector silently passes.

---

### S13. Cross-Scheme Composition (Guidance, not wire-enforceable)

**Status:** *Composition guidance.* Unlike S9–S12, S13 cannot be enforced at the s402 wire protocol because composition happens in agent orchestration code, above the wire. Enforcement is the responsibility of `@sweefi/sdk` (the reference composer) and any third-party SDK that exposes multi-scheme flows. S13 is stated here as a protocol-level design principle that SDKs MUST reflect, not as a validator-checked invariant.

**Principle:** When two schemes are composed in a single agent flow (scheme A's settlement triggers scheme B's initiation), the composed flow's guarantees are the intersection of A's and B's — no composition weakens either scheme's guarantees.

**Formally:** For any ordered pair of schemes `(A, B)` where A's settlement event is a precondition of B's initiation:

```
guarantees(A ∘ B) ⊇ guarantees(A) ∪ guarantees(B)
```

**Common compositions and the invariants each leg must independently satisfy:**

| Composition | Example use case | Invariants that must hold per-leg |
|-------------|------------------|-----------------------------------|
| `unlock ∘ stream` | Pay once to decrypt a stream config, then consume the stream | S1 (both), S5 (both), S9 (both), S11 (unlock) |
| `exact ∘ prepaid` | One-shot deposit then claim-metered consumption | S1, S5, S9 (both) |
| `escrow ∘ exact` | Conditional delivery then final payment | S1 (both), S9 (both) |

**SDK obligation:** an SDK that exposes a composed flow MUST verify each leg's invariants independently — the composition does not forgive the weakest leg. The `@sweefi/sdk` reference composer performs this verification; third-party SDKs that claim s402 compliance MUST document equivalent checks.

**Anti-pattern — "bridging":** inserting an intermediary account that holds funds between legs reintroduces counterparty risk that the individual schemes eliminated. If a composition requires bridging, it is not a composition — it is a new custom scheme that requires its own S9 proof. An s402-composition linter at `@sweefi/sdk` (v0.7.0) detects bridging patterns and refuses to emit them.

---

### S14. Constant-Time Digest and Signature Comparison (Safety)

**Statement:** Every server-side equality check on a digest, signature, attestation field, or `txBinding` value MUST use a constant-time primitive. Variable-time comparison (e.g., JavaScript's `===` on strings, byte-by-byte short-circuit) is forbidden on these values.

**Motivation.** A timing side-channel turns 2^256 brute force into ~32 × 256 = 8,192 oracle queries. An attacker who can measure response latency learns which byte of a submitted digest was the first mismatch — then brute-forces each byte independently. Historical precedent: Moxie Marlinspike's 2016 iMessage timing attack, and every mature crypto library (libsodium, NaCl, BoringSSL, Node.js `crypto`) ships a `timingSafeEqual` primitive specifically to defeat this.

**Scope (what MUST be constant-time):**

- Scheme `specDigest` comparison at facilitator ingress.
- `txBinding` comparison at facilitator and (critically) at the client during verification.
- `attestation.tx1Digest` and `attestation.policyDigest` comparisons during S11 verification.
- `attestation.signature` verification (most crypto libraries are constant-time by default, but verify the specific library in use — Node's `crypto.verify` is constant-time; some browser `WebCrypto` paths pre-2023 were not).
- `Idempotency-Key` and `requestDigest` lookup keys when used as dedup.
- Any HMAC or MAC verification added by extensions (S10 extension additivity).

**Scope (what MAY use fast equality):**

- Enum tag comparisons (`scheme`, `status`, `network`) — values are drawn from closed sets; no secret-derived variation.
- Protocol version strings.
- Timestamps.

**Reference implementation.** In TypeScript/Node:

```typescript
import { timingSafeEqual } from "node:crypto";

function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;  // length is public — acceptable to leak
  return timingSafeEqual(ab, bb);
}
```

In browser contexts without Node `crypto`, use the W3C `SubtleCrypto` API or a vetted pure-JS constant-time equality library.

**Enforcement.**

- **Lint.** `@sweefi/eslint-config` ships rule `s402/no-string-eq-on-digest` that flags `===`, `!==`, `==`, `!=` on any variable whose name ends in `Digest`, `Hash`, `Signature`, `Binding`, `Attestation`, or `Key` (case-insensitive). CI blocks merges that introduce new violations.
- **Test.** Conformance vector set includes a timing-discipline harness that runs the facilitator against 10,000 near-miss digests and measures response-time variance; PR fails if variance exceeds a fixed threshold.
- **Review.** Any new digest comparison in server-side code requires a PR reviewer to tag `security:constant-time-verified` before merge.

**Limitation (⚠️):** Constant-time in JavaScript is best-effort. V8's JIT and CPU-level speculative execution can reintroduce timing variance independent of source-level constant-time code. The `timingSafeEqual` primitive ships with this caveat documented. For the s402 threat model, defeating network-observable timing attacks is sufficient; defeating local-machine timing attacks is the operator's concern (e.g., run facilitator in a dedicated VM, not a shared-tenancy serverless environment that leaks CPU counters).

---

## Consequences

**Positive:**
- The five new invariants close the known gaps identified in the April 2026 /vet audit (request-swap, unlock-TX2 binding, extension safety, replay enumeration).
- Each scheme's adversarial catalogue becomes a trust asset: auditors, integrators, and adversaries all see the defended attack surface.
- S13 makes composition-safety a first-class concern before an agent ecosystem starts composing schemes in unexpected ways.

**Negative:**
- Each scheme must ship an adversarial catalogue — real work, ~1–2 days per scheme.
- S11 inline attestation in envelope adds ~200–400 bytes per unlock settlement response (acceptable; unlock settlements are infrequent).
- S10's runtime enforcement is best-effort — extension review remains a human-in-the-loop activity.
- S14 lint rule may produce false positives on unrelated `Key` / `Hash` named variables — suppress via inline comment with security reviewer sign-off.

**Neutral:**
- Invariants are documentation + CI obligations, not new runtime code paths in the critical path.

---

## Implementation sequencing

1. **Phase 1 (v0.5.1 docs):** Write S9–S13 into INVARIANTS.md. Update each scheme spec at `docs/schemes/<name>.md` with its S9 replay proof. Low effort, high signal.
2. **Phase 2 (v0.6.0):** Ship adversarial test catalogue (S12) + request-digest envelope (ADR-007) + S10 runtime extension checker.
3. **Phase 3 (v0.6.1):** Ship S11 attestation endpoint + client verification in `@sweefi/sui` unlock adapter.
4. **Phase 4 (v0.7.0):** S13 composition-safety linter (detect unsafe bridging patterns in `@sweefi/sdk`).

---

## References

- s402 INVARIANTS.md §S1–S8
- s402 ADR-004 (Extensions)
- s402 ADR-007 (Settlement Envelope)
- SweeFi ADR-010 (Sui settlement verification, unlock-TX2 gap)
