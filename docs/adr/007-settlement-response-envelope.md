# ADR-007: Settlement Response Envelope

**Status:** Draft (v2 — post /vet wave review)
**Implementation:** shipped
**Date:** 2026-04-19
**Related:** ADR-001 (Protocol Boundaries), ADR-006 (Version Negotiation), ADR-008 (Safety Invariants S9-S13), ADR-009 (Open Gaps), INVARIANTS S7, S8
**Supersedes:** `s402SettleResponse` (legacy flat shape in `typescript/src/scheme.ts`)

---

## Context

The legacy `s402SettleResponse` is narrowly shaped:

```typescript
type s402SettleResponse = {
  success: boolean;
  txDigest?: string;       // Sui-specific term; leaks chain semantics
  error?: string;
  // scheme-specific fields vary ad-hoc
};
```

Four structural problems:

1. **Chain leakage.** `txDigest` is Sui's term; EVM says `txHash`; Solana says `signature`. Adding a field per chain violates S7 (Chain-Agnostic Surface) and guarantees breakage as chain adapters land.
2. **No binding.** S8 currently binds client-signed Sui settlement to the signed bytes via BLAKE2b digest. For non-Sui chains, `/verify` responses, and facilitator-constructed TX2 (unlock scheme), there is no standardized check that the response answers the request the client actually sent. A facilitator can return a valid settlement for a *different* request.
3. **Untyped success/failure.** A boolean + optional error is weaker than a discriminated union; clients silently misread partial states.
4. **No cryptographic agility.** Hashes and signature algorithms are hardcoded. Future migration (SHA-256 deprecation, post-quantum) has no spec-level pathway.

Industry context (April 2026): x402 v2 inlines settlement details at top level (no discriminator, chain leakage). MPP mandates `Payment-Receipt` header but leaves schema open (unreliable interop). A2A §3.2.3 uses a strong discriminated union (`task | message | statusUpdate | artifactUpdate`) — best-in-class precedent we adopt.

---

## Decision

Introduce a typed, chain-agnostic settlement envelope with:

1. Explicit `scheme` + `specDigest` pair at the top level (prevents scheme-type confusion).
2. Explicit `network` field (prevents cross-network replay of signed transactions).
3. `txBinding` field: domain-separated cryptographic hash binding the response to the request.
4. `algs` field: digest + signature algorithm identifiers for future agility.
5. `facilitatorIds: string[]` (array, not singular) reserving space for threshold / federated attestations.
6. Discriminated union on `status`: `settled | verified | rejected | pending`.

### Envelope type

```typescript
type s402Envelope =
  | s402EnvelopeSettled
  | s402EnvelopeVerified
  | s402EnvelopeRejected
  | s402EnvelopePending;

type s402EnvelopeBase = {
  /** Protocol version — matches s402-Version header. */
  s402Version: string;

  /** Scheme name (enum: "exact" | "prepaid" | "stream" | "escrow" | "unlock"). */
  scheme: SchemeName;

  /** Content-hash of the scheme spec this response was computed against. Renamed from legacy `schemeDigest` to disambiguate from `txBinding`. */
  specDigest: string;

  /** Cryptographic binding: sha256("s402-txbinding-v1\0" || canonical(requirements) || 0x1E || canonical(payload)). Client recomputes locally and rejects on mismatch. */
  txBinding: string;

  /** Network identifier (e.g. "sui:mainnet", "sui:testnet", "solana:mainnet-beta", "eth:1"). Client MUST verify against the network it signed for. */
  network: string;

  /** Algorithm identifiers — enables migration without wire-break. Values use SRI-compatible naming. */
  algs: {
    digest: "sha256";      // default; reserved "sha384" | "sha512" | "blake3"
    sig: "ed25519";        // default; reserved "ed25519ph" | "secp256k1" | "ml-dsa-44"
  };

  /** ISO-8601 UTC millisecond timestamp. Client MUST reject if |envelope.timestamp - now| > 5 min. */
  timestamp: string;

  /** Facilitator identities that contributed to this envelope. Array shape reserves federation/threshold designs; v0.6.0 populates single-element for single-facilitator. */
  facilitatorIds?: string[];
};

type s402EnvelopeSettled = s402EnvelopeBase & {
  status: "settled";
  settled: {
    /** Chain-specific settlement blob. Schema delegated to chain adapter; s402 protocol treats as opaque. */
    settlement: unknown;
    settledAt: string;
    /** Scheme-specific attestation (e.g., UnlockTx2Attestation for scheme="unlock"). Inline, not URL-referenced — see ADR-008 S11. */
    attestation?: unknown;
  };
};

type s402EnvelopeVerified = s402EnvelopeBase & {
  status: "verified";
  verified: {
    /** Pre-settlement check passed. No broadcast yet. Used by /verify endpoint. */
  };
};

type s402EnvelopeRejected = s402EnvelopeBase & {
  status: "rejected";
  rejected: { error: s402Error };
};

type s402EnvelopePending = s402EnvelopeBase & {
  status: "pending";
  pending: { retryAfter?: number; reason: string };
};
```

### Cryptographic binding (`txBinding`)

For any request consisting of `{ paymentRequirements, paymentPayload }`, the binding is computed as:

```
txBinding = "sha256-" || base64url_no_pad(
  sha256(
    "s402-txbinding-v1\0"                    // domain-separation prefix
    || canonical(paymentRequirements)        // RFC 8785 JCS
    || 0x1E                                  // record separator (JCS escapes literal 0x1E in strings to \u001e — no collision)
    || canonical(paymentPayload)
  )
)
```

**Canonicalization** follows `spec/canonicalization.md`: RFC 8785 JCS, parse with duplicate-key rejection, monetary amounts as strings, Unicode NFC for address-shaped fields, no arbitrary-precision numerics.

**Domain-separation rationale.** Every digest in s402 carries a unique versioned ASCII prefix followed by a null terminator, so a byte-sequence that is a valid `txBinding` input cannot collide with any valid `specDigest` input, `attestation` input, or future digest recipe. Pattern: `"s402-{purpose}-v{N}\0"`. See also S11 attestation (ADR-008), which uses `"s402-attestation-v1\0"`.

**Algorithm identifier.** The `"sha256-"` prefix on `txBinding` uses Subresource Integrity (SRI) style — the same encoding as `specDigest` (ADR-006) and as S11 attestation digest fields (ADR-008). Future algorithms alter the prefix (`"sha384-"`, `"blake3-"`) rather than silently swapping hash functions; clients that don't understand the prefix MUST reject. Base64url encoding is unpadded per `spec/canonicalization.md` §3.3. See that document for the purpose registry (`txbinding`, `specdigest`, `attestation`).

### Client verification obligations (normative MUST)

Before treating any envelope as authoritative, the client MUST perform ALL of the following checks. Failure of any check = reject the response and treat the facilitator as misbehaving.

1. **Scheme match:** `envelope.scheme === originalRequest.requirements.scheme`. The envelope explicitly names its scheme; a mismatch is evidence of facilitator confusion or attack.
2. **Spec-digest match:** `envelope.specDigest === expectedSpecDigest` (what the client pinned or discovered).
3. **Network match:** `envelope.network === originalRequest.requirements.network`. Prevents cross-network replay (Sui `IntentScope::TransactionData = 0x00` is the same on mainnet and testnet; the Sui-signed bytes alone do not bind chain).
4. **Binding match:** recompute `txBinding` locally from the CLIENT'S OWN `{requirements, payload}` pair. Compare to `envelope.txBinding` using a constant-time primitive (`crypto.timingSafeEqual`). Never use `===` for this check — see S14.
5. **Resource binding:** `originalRequest.requirements.resource === originalIntent.resource`. The client must track what resource URL it originally intended to pay for and verify the server's 402 challenge echoed the same resource. Prevents confused-deputy attacks where resource-A's facilitator settles for resource-B.
6. **Timestamp skew:** `|envelope.timestamp - now| ≤ 5 minutes`.
7. **Algorithm acceptance:** `envelope.algs.digest` and `envelope.algs.sig` are in the client's acceptable set. Reject unknown algorithms rather than fall through.
8. **For `scheme: "unlock"`:** `envelope.settled.attestation` MUST be present, signed, and verifiable per ADR-008 S11. Client SDK MUST refuse to surface decrypted content before attestation verifies. (Prevents S11 attestation stripping.)

### Chain-agnostic boundary

The `settled.settlement` field is typed `unknown` at the protocol level — chain adapters narrow it. Per S7, s402 itself contains no chain-specific decoders:

```typescript
// @sweefi/sui exports:
type SuiSettlement = { txDigest: string; gasUsed?: string };
type SuiSettledEnvelope = Extract<s402Envelope, { status: "settled" }> & {
  settled: { settlement: SuiSettlement; settledAt: string; attestation?: unknown };
};

// @sweefi/solana exports (future):
type SolanaSettlement = { signature: string; slot?: string };

// @sweefi/eth exports (future):
type EthSettlement = { txHash: string; blockNumber?: string };
```

### Relationship to S8

ADR-007 strengthens S8 from Sui-specific to chain-agnostic:

- **S8 (current):** For client-signed Sui schemes, client verifies `settleResponse.txDigest == localDigestFromBytes(signed_bytes)`. Catches: facilitator broadcast a different transaction than the client signed. Scope: Sui-only.
- **S8 (extended by ADR-007):** For *every* scheme on *every* chain, client verifies envelope fields per the 8-step obligation list above — in particular `txBinding` recomputation catches request-level swap. Scope: all chains, all schemes, including facilitator-constructed flows like unlock-TX2.

The two checks are complementary: S8-tx-binding (original) catches tx-level forgery *once the signed bytes exist*; ADR-007 request-binding catches the earlier attack where the facilitator answers a different request entirely.

### Backward compatibility

- **v0.5.x:** Servers MAY return either legacy `s402SettleResponse` or the envelope. Client negotiates via `Accept: application/vnd.s402.envelope+json`.
- **v0.6.0:** Envelope is default. Legacy response requires opt-in via `Accept: application/json`.
- **v1.0.0:** Legacy removed.

### Field rename summary (breaking — v0.6.0)

| Legacy (v0.5) | New (v0.6) | Rationale |
|---|---|---|
| `schemeDigest` (in envelope) | `specDigest` | Disambiguates from `txBinding`; "spec" matches what's hashed (the scheme spec file). |
| `requestDigest` | `txBinding` | "Binding" conveys cryptographic commitment, not just a hash. Also consistent with "tx-level binding" language used in S8. |
| `txDigest` (Sui-leaked) | `settled.settlement.txDigest` | Moved under chain-adapter narrowing. Sui-specific field now lives where it belongs. |
| `facilitatorId` (singular) | `facilitatorIds: string[]` | Reserves federation/threshold designs. v0.6.0 uses single-element array. |

---

## Alternatives considered

**A1. Inline chain-specific fields at top level.** Rejected — violates S7, each new chain adapter forces a minor version bump.

**A2. Envelope without `txBinding`.** Rejected — leaves the request-swap attack open. Wave 3 adversarial review found this as an EXPLOITABLE gap.

**A3. Signed envelopes (JWS) at protocol layer.** Rejected for v0.6.0 — signing keys are operator concerns, deferred to SweeFi. When SweeFi publishes a facilitator-identity JWS scheme, it can wrap the envelope without s402 changing.

**A4. HTTP trailing `Payment-Receipt` header (MPP style).** Rejected — body-size limits, streaming-unfriendly, weak TypeScript ergonomics.

**A5. URL-referenced unlock attestation (`attestationUri`).** Rejected — Wave 3 found this creates an "attestation stripping" attack where naïve clients surface decrypted content before fetching the attestation. Inline attestation forces verification into the happy path.

**A6. Singleton `facilitatorId`.** Rejected — future federation (quorum of 3-of-5 facilitators signing unlock attestations) cannot be added without wire break. Array shape is free to reserve now.

**A7. Separator-only concatenation (no domain-separation prefix).** Rejected — Wave 1 crypto review found length-variable concatenation with only a record separator vulnerable to collision crafting. Versioned ASCII prefix + null terminator is the libsodium/Noise/Signal pattern.

**A8. Keep the legacy `schemeDigest` field name.** Rejected — Wave 4 DX review identified the 4-way "digest" naming collision (`s402-Scheme-Digest` header + `schemeDigest` field × 2 places + `requestDigest`) as an adoption blocker. Renaming to `specDigest` + `txBinding` eliminates the ambiguity.

---

## Consequences

**Positive:**
- Chain-agnostic at the protocol layer — new chain = new adapter, zero protocol change.
- Closes request-swap, cross-network replay, scheme-type confusion, and attestation stripping attacks surfaced in Wave 3 adversarial review.
- Algorithm agility prevents the SHA-256-is-broken-in-2040 time bomb.
- Matches A2A's proven discriminated-union pattern (§3.2.3).
- `verified` vs `settled` statuses formalize the `/verify` vs `/settle` distinction.
- Inline attestation makes S11 verification non-bypassable by construction.

**Negative:**
- Client code must switch on `status` — slightly more verbose than reading `success: boolean`.
- Canonicalization library dependency (RFC 8785 JCS) — adds ~5 KB to bundle.
- Breaking rename from v0.5 field names — mitigated by v0.5.9-warn deprecation phase + codemod (see ADR-006 migration plan).
- Eight client-side verification checks is non-trivial — mitigated by `@sweefi/sdk` facade that performs all checks in one call.

**Neutral:**
- New conformance vectors required for envelope discrimination + txBinding + scheme-name binding + algorithm-field round-tripping.

---

## Open questions

**OQ-1: Envelope versioning independent of `s402Version`?** Leaning NO — envelope shape changes rarely; tying to protocol version keeps surface small. Revisit if envelope changes out-of-phase.

**OQ-2: `pending` status internal structure for long-running streams?** Minimal for now. Streams carry progress inside chain-specific `settlement` blob. Revisit if stream-specific need emerges.

**OQ-3: Should `algs` permit per-field algorithms (different digest for spec vs binding)?** v0.6.0 uses single digest algorithm for all hashes in a given envelope. Per-field allows finer migration but doubles the combinatorial test surface. Revisit at v1.0.

---

## Error codes

ADR-007 adds two error codes to `typescript/src/errors.ts`:

- **`S402_TX_BINDING_MISMATCH`** — emitted when the client's locally-recomputed `txBinding` does not equal `envelope.txBinding`. Semantic: "the facilitator's response is bound to a different request than the one I sent." Severity: MUST reject; MUST NOT retry against the same facilitator without out-of-band escalation.
- **`S402_UNKNOWN_ALGORITHM`** — emitted when `envelope.algs.digest` or `envelope.algs.sig` is not in the client's acceptable set. Severity: MUST reject.

Full taxonomy (all error codes across ADR-006, ADR-007, and canonicalization): `spec/canonicalization.md` §7.

---

## Idempotency semantics

Settlement is a cross-chain spend — clients retry, networks partition, responses time out. The envelope itself is bound to a specific request (`txBinding`), but the **retry story** needs facilitator-side dedup to prevent the failure mode where a retry after a timed-out successful broadcast causes a second on-chain spend.

**Wire-level (optional, Stripe-compatible):**

Clients MAY send an `Idempotency-Key` HTTP header on `POST /settle`:

```
Idempotency-Key: <opaque caller-chosen string, ≤255 UTF-8 bytes>
```

When present, the facilitator MUST use this string as the dedup key. Otherwise, the facilitator MUST compute a deterministic fingerprint of the decoded payment payload (the object produced after canonical field ordering per `spec/canonicalization.md` §4).

**Facilitator-side semantics:**

| Arrival pattern | Facilitator behavior |
|----------------|---------------------|
| First request with key K | Execute pipeline; cache result |
| Second request with key K while first is in flight | Await the in-flight promise; both callers receive the same envelope |
| Second request with key K after first completes (within TTL) | Return cached envelope; pipeline does NOT re-execute |
| Second request with key K after TTL expiry | Execute pipeline; cache new result |

**Parameters:**

- Cache TTL: implementation-defined, RECOMMENDED 5 minutes. Shorter TTLs risk double-spends on retrying clients; longer TTLs risk stale responses for evolving requirements.
- Cache bound: implementation-defined LRU eviction to cap memory under load.

**What gets cached:** all results, including failures (mirrors Stripe). Safe default: if `scheme.settle()` timed out but the transaction reached the chain, a retry with the same key returns the original failure envelope rather than broadcasting a second spend. Clients that want to retry a transient failure must either wait for TTL or use a fresh key.

**What does NOT get cached:** requests rejected before dedup — `REQUIREMENTS_EXPIRED`, `SCHEME_NOT_SUPPORTED`, `INVALID_PAYLOAD`. These are cheap to re-evaluate and caching them offers no double-spend protection.

**Relation to `txBinding`:** idempotency prevents double-execution; `txBinding` prevents response swaps. They are orthogonal — a correct client enforces both.

---

## References

- RFC 8785 (JSON Canonicalization Scheme)
- RFC 7515 (JSON Web Signature — A3 reference)
- Unicode Standard Annex #15 (NFC normalization)
- A2A Specification §3.2.3 (`a2a-protocol.org/latest/specification/`)
- libsodium domain-separation conventions (`doc.libsodium.org/key_derivation`)
- Noise Protocol Framework §5 (prologue + domain separation)
- s402 INVARIANTS.md §S7 (Chain-Agnostic), §S8 (Facilitator Accountability)
- s402 ADR-001, ADR-006, ADR-008, ADR-009
