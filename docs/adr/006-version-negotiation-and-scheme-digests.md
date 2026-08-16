# ADR-006: Version Negotiation and Scheme Content-Hashing

**Status:** Draft
**Implementation:** not-started
**Date:** 2026-04-19
**Supersedes:** implicit version string in `s402Version` field
**Related:** ADR-001 (Protocol Boundaries), ADR-002 (Protocol-Pure), ADR-004 (Extensions), ADR-005 (Interop-Superset), INVARIANTS S3

---

## Context

As of April 2026, the three relevant agent-payment/coordination protocols handle versioning as follows:

- **x402 v2** (Coinbase): `x402Version: 2` field in every request/response. No wire-level handshake. No content-hash of schemes. Amendment process = GitHub PRs.
- **MPP / ACP** (Stripe + Tempo): per-intent IETF drafts (`draft-payment-intent-charge-00`). Version lives in draft filename. No content-hash. Amendment process = IETF I-D revisions.
- **A2A** (Google): `A2A-Version: major.minor` request header; server MUST process with that version's semantics or return `VersionNotSupportedError` (§3.6.2). Agent Cards are JWS-signed — integrity per card, but no semver-chained cryptographic history.

**Market consensus:** version negotiation belongs at the protocol layer. **Gap in all three:** none content-hash their schemes/intents; amendment history is editorial, not cryptographic.

s402 can do better here **because S3 proves the five payment schemes are structurally irreducible** (`typescript/INVARIANTS.md` §S3). Irreducibility means each scheme is a stable, atomic unit of protocol semantics — which means each scheme can be independently content-hashed and version-tracked without coupling to the full protocol version.

---

## Decision

s402 adopts a two-level versioning model:

1. **Protocol version** — semver of the wire format itself, declared per-request, negotiated via RFC 9110 semantics.
2. **Scheme digest** — SHA-256 content-hash of each scheme's canonical markdown spec, individually version-tracked via an amendment chain.

### Wire format

**Request headers (new, required):**

```
s402-Version: 0.5.0
```

**Request headers (new, optional — strict when present):**

```
s402-Spec-Digest: exact=sha256-a1b2c3…; prepaid=sha256-d4e5f6…
```

When present, the server MUST reject with `409 Conflict` if any pinned digest does not match a supported digest for that scheme.

**Payment requirements (new, optional field):**

```json
{
  "scheme": "exact",
  "specDigest": "sha256-a1b2c3…",
  …existing fields…
}
```

When present, both client and facilitator MUST reject the payment if the digest is not in their supported set.

**Server response headers (new, advisory):**

```
s402-Supported-Versions: 0.4.0, 0.5.0, 0.6.0-rc1
s402-Supported-Spec-Digests: exact=sha256-a1b2c3…; prepaid=sha256-d4e5f6…
```

### HTTP status semantics

| Condition | Status | Response body |
|-----------|--------|---------------|
| Client version not supported | `400 Bad Request` | `{ code: "S402_VERSION_UNSUPPORTED", requested: "0.6.0", accepted: ["0.4.0", "0.5.0"] }` |
| Pinned scheme digest unknown | `412 Precondition Failed` | `{ code: "S402_SPEC_DIGEST_MISMATCH", scheme: "exact", clientPinned: "sha256-…", serverSupports: ["sha256-…"] }` |
| Missing `s402-Version` header | `400 Bad Request` | `{ code: "S402_VERSION_REQUIRED" }` |

**Rationale for 400 over 426:** RFC 9110 §15.5.22's `426 Upgrade Required` presupposes an `Upgrade:` + `Connection: Upgrade` header pair for HTTP-transport upgrades (e.g., HTTP/1.1 → HTTP/2, plaintext → TLS). s402 version mismatch is an application-protocol concern, not a transport upgrade. A2A — the closest industry precedent — returns `VersionNotSupportedError` via a structured body at HTTP 400, not 426. Following that precedent avoids confusing HTTP intermediaries that may strip or rewrite 426 responses expecting transport-upgrade semantics.

**Rationale for 412 over 409:** RFC 9110 §15.5.13 defines 412 Precondition Failed as the response when one or more preconditions evaluated by the server fail. An `s402-Spec-Digest` header is a client-supplied precondition on scheme identity — if the server does not support the pinned digest, the precondition evaluates to false. 409 Conflict implies a resource state conflict that does not apply here (there is no resource being mutated).

**CDN note:** Origin servers MUST emit `Vary: s402-Version, s402-Spec-Digest` on every response so intermediate caches key on these headers. Without this, a cached response produced for v0.5.0 could be returned to a v0.6.0 client, defeating the negotiation.

### Scheme canonicalization

Each scheme has a canonical markdown spec at `s402/docs/schemes/<scheme>.md`. The **normative** canonicalization procedure is defined at `spec/canonicalization.md` §4. This section summarizes for context only; in case of divergence, `spec/canonicalization.md` wins.

**Summary:** read as UTF-8 (reject BOM) → NFC-normalize the whole document → reject CR-only line endings (accept CRLF, normalize to LF) → strip trailing ASCII space/tab from each line (never strip exotic whitespace — reject TABs outside fenced code blocks via a CommonMark parser, not regex) → ensure exactly one trailing newline → hash with domain-separation prefix:

```
digest_input = "s402-specdigest-v1\0" || canonical_bytes
digest       = sha256(digest_input)
advertised   = "sha256-" || base64url_no_pad(digest)
```

**Why the prefix.** Every s402 digest purpose gets a versioned ASCII prefix + null terminator so that no byte sequence can be a valid input to two purposes simultaneously. See `spec/canonicalization.md` §3.3 for the full purpose registry (`txbinding`, `specdigest`, `attestation`).

**Advertised format:** `sha256-<base64url-no-pad>`, e.g. `sha256-a1b2c3DEfGhI_-…` (Subresource Integrity style).

**Target is the prose spec, not derived artifacts.** The markdown spec at `docs/schemes/<scheme>.md` is normative — it is the human-readable law of the scheme. JSON Schema files and BCS type definitions are derivative; their content-hashes are advertised separately in `spec/scheme-digests.json` under a `derived` key but do not drive version negotiation.

**Implementation plan — NOT BUILT (verified 2026-08-16, DAN-855).** The intent is that
`scripts/compute-scheme-digests.mjs` runs in CI and writes `spec/scheme-digests.json`, so any PR
modifying `docs/schemes/**/*.md` without updating the digests file fails CI.

⚠️ **None of that exists.** Neither file appears in any commit on any branch (`git log --all --
'**/compute-scheme-digests.mjs' '**/scheme-digests.json'` returns nothing), and CI's five jobs
contain no such gate. This paragraph previously asserted the mechanism in the present tense, which
made an unbuilt plan read as a shipped guarantee — in the one field the ADR convention reserves for
answering exactly that question. The header now carries `Implementation: not-started`.

`docs/schemes/` itself is real (`escrow.md`, `exact.md`, `prepaid.md`), so the thing this would
guard exists; only the guard is missing.

### Amendment chain

Each scheme has a history file at `spec/schemes/<scheme>.history.json`:

```json
{
  "scheme": "exact",
  "versions": [
    {
      "version": "1.0.0",
      "digest": "sha256-a1b2c3…",
      "amends": null,
      "released": "2026-01-15",
      "rationale": "Initial version"
    },
    {
      "version": "1.1.0",
      "digest": "sha256-c3d4e5…",
      "amends": "sha256-a1b2c3…",
      "released": "2026-03-22",
      "rationale": "Add optional settlementTimeout field",
      "breaking": false
    }
  ]
}
```

**CI check:** a PR that changes a scheme's digest MUST add a new entry to its history with a non-null `amends` pointing to the previous digest. Breaking changes (where `breaking: true`) require a protocol-version bump and explicit callout in CHANGELOG.

**Trust model for the history:** the history file is an **auditable log**, not a cryptographically independent chain. Its integrity derives from:
1. Git branch protection + required review on `docs/schemes/**` and `spec/schemes/**` paths.
2. CI refusal to merge a digest change without a matching history entry.
3. Published releases tagged on GitHub, which third parties can mirror.

It does NOT derive from an external timestamping authority or a blockchain anchor. A malicious maintainer with merge rights could rewrite history via force-push. The `amends` pointer is a content-addressed linked list (similar to git parent-hashes) — tampering with one entry forces rewriting all subsequent entries, which is detectable to anyone who pinned a prior digest. Future work may anchor history roots to OpenTimestamps or Sigstore; v0.6.0 does not.

### Discovery document

`.well-known/s402.json` is extended:

```json
{
  "s402Version": "0.5.0",
  "supportedVersions": ["0.4.0", "0.5.0"],
  "schemes": {
    "exact":   { "digests": ["sha256-a1…", "sha256-c3…"] },
    "prepaid": { "digests": ["sha256-d4…"] },
    "stream":  { "digests": ["sha256-e5…"] },
    "escrow":  { "digests": ["sha256-f6…"] },
    "unlock":  { "digests": ["sha256-07…"] }
  },
  "networks": ["sui:mainnet", "sui:testnet"],
  "directSettlement": true,
  "mandateSupport": false
}
```

Existing `schemes: string[]` field is deprecated but retained for v0.5.x; removed in v1.0.

---

## Alternatives considered

**A1. Version string only, no scheme digest.** Matches x402 exactly. Rejected because it doesn't let clients pin to a specific scheme revision — a silent scheme-semantics change between v0.5.0 and v0.5.1 is undetectable to the client. s402's whole value proposition over x402 includes formal scheme semantics; those semantics need cryptographic identity.

**A2. Full-protocol content-hash (one digest for entire spec).** Rejected because it forces lockstep upgrades across all schemes. S3 proves schemes are independent; versioning should honor that independence.

**A3. JWS-signed version metadata (like A2A agent cards).** Rejected for the protocol-version layer — signing doesn't solve the core problem (knowing what version the other side speaks). Reserved for future use at the facilitator-identity layer (SweeFi concern, not s402).

**A4. Rely on npm package version.** Rejected because the wire protocol is consumed by non-TypeScript clients (Python, Rust, Go) that don't have npm.

---

## Consequences

**Positive:**
- Clients can pin scheme semantics to a specific content-hash — no silent drift within a pinned digest.
- Servers can support multiple scheme revisions concurrently for graceful migrations.
- Amendment history is an auditable content-addressed log (integrity via git + CI, not external timestamping).
- Matches A2A's wire-level negotiation pattern (industry-aligned) while adding content-hash (industry-differentiated).

**Negative:**
- Clients pinning digests must update when schemes evolve (but can choose not to pin).
- One additional header parse per request.
- CI complexity: digest regeneration + history append on every scheme change.

**Neutral:**
- Requires minor spec updates to the `PaymentRequirements` type in `typescript/src/types.ts`.
- Adds 3 new error codes to `typescript/src/errors.ts` (`S402_VERSION_UNSUPPORTED`, `S402_SPEC_DIGEST_MISMATCH`, `S402_VERSION_REQUIRED`).

---

## Migration plan

**v0.5.x:** New headers and fields are OPTIONAL. Servers continue accepting requests without `s402-Version`. Digests advertised in discovery doc but not enforced.

**v0.6.0:** `s402-Version` header becomes REQUIRED. Clients not sending it get `400 Bad Request`. Scheme digests remain optional pins.

**v1.0.0:** Deprecated `schemes: string[]` field in `.well-known/s402.json` is removed. Only the digest-aware form remains.

---

## References

- RFC 9110 §15.5.1 (400 Bad Request), §15.5.13 (412 Precondition Failed)
- RFC 7232 §3.1 (If-Match / precondition semantics — precedent for 412 on content-digest pinning)
- RFC 8785 (JSON Canonicalization Scheme) — applied in ADR-007
- Unicode Standard Annex #15 (NFC Normalization)
- A2A Specification §3.6 (`a2a-protocol.org/latest/specification/`) — uses HTTP 400 + structured error body for version mismatch, not 426
- x402 v2 Specification (`github.com/coinbase/x402/tree/main/specs`)
- MPP Protocol (`mpp.dev/protocol/`)
- s402 INVARIANTS.md §S3 (Five Irreducible Payment Schemes)
