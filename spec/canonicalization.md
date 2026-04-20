# s402 Canonicalization Spec

**Status:** Normative, v0.6.0-draft
**Date:** 2026-04-19
**Referenced by:** ADR-006 (scheme-spec digest), ADR-007 (txBinding), ADR-008 (S11 attestation)

---

## 0. Purpose

s402 computes cryptographic digests over three classes of data:

1. **Scheme spec files** (markdown at `docs/schemes/<scheme>.md`) → `specDigest`.
2. **Protocol payloads** (`paymentRequirements`, `paymentPayload`) → `txBinding`.
3. **Attestation inputs** (length-prefixed TLV for S11) → unlock-TX2 signature input.

Each class has a different structure, but they share a single principle: **two independently-built implementations, when given the same logical content, MUST produce identical bytes fed to the hash function.**

This document is language-neutral. Every rule is stated as prose, with TypeScript references included only as examples. Python / Rust / Go / Move implementers write from the prose, not from the TypeScript.

---

## 1. Scope and non-goals

**In scope:**
- Canonicalization of JSON values for payload digests (§3).
- Canonicalization of markdown scheme-spec files for scheme digests (§4).
- Byte-layout rules for attestation TLV inputs (§5).
- File-size and resource limits (§6).

**Not in scope:**
- Transport-layer encoding (Content-Encoding, gzip, brotli). Digests are computed on logical bytes, not wire bytes.
- Signing algorithms. See ADR-008 S11 + ADR-007 §Algorithm acceptance.
- Chain-specific serialization (BCS, Borsh, RLP). Delegated to chain adapters per INVARIANT S7.

---

## 2. Normative language

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are used per RFC 2119.

When this spec says "implementations MUST reject X", the required behavior is:
- Refuse to emit a digest for the input.
- Return an error identifiable as `S402_CANONICALIZATION_REJECTED` (see §7 for error taxonomy).
- Not silently mutate the input to make it acceptable.

---

## 3. JSON payload canonicalization

### 3.1 Base standard

Implementations MUST implement **RFC 8785 JSON Canonicalization Scheme (JCS)** as the baseline. RFC 8785 defines:

- UTF-8 serialization.
- Sorted object keys by Unicode code-point order.
- Minimal whitespace (no insignificant spaces).
- Numeric serialization per the ECMAScript `Number.prototype.toString` algorithm.
- String escape rules per RFC 8259 plus the JCS refinements.

RFC 8785 is load-bearing. If the chosen language has no maintained JCS implementation, contributors MUST port `rfc8785` (npm) or `jcs` (Go) rather than hand-roll.

### 3.2 s402 profile on top of JCS

s402 adds five profile rules that RFC 8785 does not enforce:

#### 3.2.1 Duplicate-key rejection

**Rule:** During parse, if any JSON object contains two members with byte-identical keys, the implementation MUST reject the input. RFC 8259 permits parsers to behave any way they like with duplicate keys; s402 requires rejection.

**Why:** Two parsers that keep different keys produce different canonical bytes, which produces different digests from identical-looking input. This is a known canonicalization attack class (see RFC 8785 §5).

**TypeScript reference:**
```ts
// reject via reviver
JSON.parse(input, (_key, value) => { /* standard parse disallows duplicate keys */ return value; });
// but node's JSON.parse silently keeps the last. Use a strict parser:
import { parse } from "secure-json-parse";
parse(input, { protoAction: "error", constructorAction: "error", allowDuplicateKeys: false });
```

Python: `json.loads(s, object_pairs_hook=lambda pairs: _reject_dupes(pairs))`.
Rust: `serde_json` rejects duplicates by default when targeting a typed struct; ensure `deny_unknown_fields` on the target type.
Go: `encoding/json` silently keeps the last duplicate — MUST replace with a strict alternative.

#### 3.2.2 Monetary amounts as strings

**Rule:** All monetary amounts in `paymentRequirements` and `paymentPayload` MUST be serialized as JSON strings containing only ASCII digits (no decimal point, no scientific notation, no leading zeros except for the value `"0"`). Units are always the smallest on-chain unit (e.g., MIST for SUI, lamports for Solana, wei for ETH).

**Why:** JavaScript `Number` loses precision beyond 2⁵³. IEEE-754 round-trips cannot represent `1000000000000000001` faithfully. Amounts are value-critical; precision loss is an attack.

**Reject:** `"amount": 1000000`, `"amount": 1e6`, `"amount": "1,000,000"`, `"amount": "1.0"`, `"amount": "01"`, `"amount": "-1"`, `"amount": "+1"`.
**Accept:** `"amount": "1000000"`, `"amount": "0"`.

#### 3.2.3 No arbitrary-precision numerics

**Rule:** Non-monetary numeric fields (e.g., `expiresAt` ms-since-epoch, `settlementTimeoutSec`) MUST fit in a signed 64-bit integer. Implementations MUST reject JSON numbers whose canonical serialization per RFC 8785 §3.2.2.3 exceeds that range. Implementations MUST reject non-integer numerics in fields declared as integer.

**Why:** JCS uses ECMAScript `toString`, which accepts any finite double. Timestamps with fractional milliseconds and amounts with scientific notation both serialize to legal JCS output but break downstream parsers in chain-specific code paths.

#### 3.2.4 Unicode NFC for address-shaped fields

**Rule:** Fields holding chain addresses (`payTo`, `asset`, `from`, `facilitator`, etc. — names vary by scheme) MUST be NFC-normalized (Unicode Standard Annex #15) before inclusion in the canonical form. Implementations MUST reject input that was supplied in a non-NFC form AND contains any code point whose NFC form differs from its input form. (Equivalently: NFC(input) != input for any character in the field.)

**Rationale:** Two visually-identical addresses can differ in bytes (pre-composed vs decomposed forms) and produce different digests. Addresses on most chains are ASCII, so this rule is a no-op for them; the rule guards against non-ASCII identifier schemes (DIDs, ENS, Solana custom programs with Unicode).

**Why reject non-NFC rather than normalize silently:** silent normalization hides address-smuggling. If the caller intended a composed form and we emitted a decomposed form, they produced an unintended digest. Better to error loudly.

**Case sensitivity:** s402 canonicalization is case-sensitive. Chain-specific address case rules (EIP-55 checksum, Sui lower-case) are the chain adapter's job. s402 treats the address as opaque bytes.

#### 3.2.5 Enum name case-sensitivity

**Rule:** Enum values like `scheme: "exact"`, `status: "settled"`, `network: "sui:mainnet"` MUST be matched byte-exact. `"Exact"`, `"EXACT"`, `"settled "` (trailing space) are distinct and MUST be rejected.

**Why:** JSON does not constrain string case; s402 does. Case-folding at canonicalization time would hide typos and add ambiguity to the wire.

### 3.3 Digest recipe (domain-separated)

For each purpose, the digest input is constructed as:

```
digest_input = prefix || body
prefix       = UTF-8 ASCII "s402-{purpose}-v{N}" || 0x00
body         = (purpose-specific, per §3.4)
digest       = sha256(digest_input)
advertised   = "{alg}-" || base64url_no_pad(digest)
```

**Registered purposes (v0.6.0):**

| Purpose | Prefix | Body |
|---|---|---|
| `txbinding` | `"s402-txbinding-v1\0"` | `canonical(requirements) || 0x1E || canonical(payload)` |
| `specdigest` | `"s402-specdigest-v1\0"` | canonicalized markdown per §4 |
| `attestation` | `"s402-attestation-v1\0"` | TLV per ADR-008 §S11 (see §5) |

**Why the prefix pattern.** Every s402 digest is computed with a non-empty ASCII tag followed by a null byte. This guarantees that no byte-sequence that is a valid `specdigest` input can be reinterpreted as a valid `txbinding` input (or vice versa), because the prefixes differ. This is the libsodium / Noise / Signal domain-separation convention.

**Why the null terminator.** Without the null, `"s402-txbinding-v1"` is a prefix of `"s402-txbinding-v10"`, `"s402-txbinding-v11"`, etc. When v10 ships in 2030, its inputs would be collision-bait against v1. The null locks the version boundary.

### 3.4 0x1E record-separator safety

The `txbinding` purpose concatenates two canonical JSON documents with `0x1E` (RFC 20 record separator) between them.

**Proof the separator is unambiguous:**
1. Both `canonical(requirements)` and `canonical(payload)` are RFC 8785 JCS outputs.
2. RFC 8785 §3.2.2.2 mandates that all control characters in strings (U+0000 through U+001F inclusive) are escaped using `\uXXXX` notation.
3. `0x1E` is U+001E, a control character, and MUST be escaped inside any JCS string. It cannot appear literally inside a JCS document.
4. Therefore the literal `0x1E` byte between two JCS documents is the unique position the separator can occupy. No JCS document contains `0x1E` at any position.
5. The parser can recover `(canonical(requirements), canonical(payload))` uniquely by splitting on the first unescaped `0x1E`.

This means the pair is injective into the digest input without ambiguity.

### 3.5 Canonicalization failures

If any §3.2 rule fails, implementations MUST:
1. Not emit a digest.
2. Return error code `S402_CANONICALIZATION_REJECTED` with a `reason` field from this enum:
   - `"duplicate-key"`
   - `"non-string-amount"` / `"invalid-amount-format"`
   - `"number-out-of-int64-range"`
   - `"non-nfc-address"`
   - `"unknown-enum-value"`
   - `"file-too-large"` (see §6)
3. Include the JSON-pointer path to the offending field when applicable.

---

## 4. Markdown scheme-spec canonicalization

Scheme specs are `docs/schemes/<scheme>.md`. The canonicalization target is the bytes handed to SHA-256 for `specDigest`.

### 4.1 Procedure

Execute steps 1-8 in order. Any step failure rejects the file.

1. **Read as UTF-8.** Reject any file whose first three bytes are `0xEF 0xBB 0xBF` (UTF-8 BOM, U+FEFF).
2. **Apply Unicode NFC normalization** to the entire document.
3. **Reject CR-only line endings.** Scan the bytes; if any `0x0D` byte is not immediately followed by `0x0A`, reject. Then replace every `0x0D 0x0A` pair with a single `0x0A` (LF-only internal representation).
4. **Strip trailing whitespace from every line.** "Whitespace" for this step is exactly `{U+0020 SPACE, U+0009 TAB}`. Every other space-like code point (U+00A0 NBSP, U+200B ZWSP, U+000B VT, U+2028 LS, etc.) is either preserved or rejected per step 5, never silently stripped.
5. **Reject TABs outside fenced code blocks.** Parse the document with a **CommonMark parser** (NOT regex). Walk the AST. If any text or heading or blockquote node contains `0x09`, reject. TABs inside ``` ``` ``` code fences are permitted.
6. **Ensure exactly one trailing newline.** If the file ends in 0 newlines, append one. If it ends in 2 or more, trim to exactly 1.
7. **Compute `sha256(canonical_bytes)`** where the domain-separation prefix is prepended per §3.3:
   ```
   digest_input = "s402-specdigest-v1\0" || canonical_bytes
   digest       = sha256(digest_input)
   ```
8. **Encode as** `"sha256-" || base64url_no_pad(digest)` for advertisement.

### 4.2 Why CommonMark parser, not regex

Fenced code blocks can be triple-backtick ``` ``` ``` or tilde ``~~~`` or indented-four-spaces, can have info strings, can be nested inside blockquotes, and can contain apparent fence markers that are actually content. A regex that recognizes "inside fence vs outside fence" fails on:

````markdown
    This is an indented code block.

> ```
> This fence is nested in a blockquote.
> ```

~~~python
def f(): pass  # tilde fence
~~~
````

Implementations MUST use a CommonMark 0.30 or later compliant parser. Reference: `commonmark.js` (JS), `markdown-it` (JS, CommonMark mode), `pulldown-cmark` (Rust), `goldmark` (Go), `markdown-it-py` (Python).

### 4.3 Why NFC before parse

NFC on the whole document (step 2) guarantees that visually-identical prose with different code-point sequences produces identical digest input. Scheme spec authors who paste text from Word, Google Docs, or editors with composition differences all hash to the same value.

### 4.4 Why reject BOM

BOM-prefixed UTF-8 breaks shell tools (`grep`, `diff`, `git log -p`) in subtle ways, and causes intermittent digest mismatches when editors are configured differently. A spec file with a BOM is almost certainly an editor accident.

### 4.5 Why case-sensitive enum matching even here

When the markdown spec declares an enum like `status: "settled"`, that string is part of the spec's normative content. If the canonicalizer lower-cased it, it would erase the distinction between the spec saying `"Settled"` (error) and `"settled"` (normative). The canonicalizer is not a linter; it preserves exact content and hashes it.

---

## 5. TLV attestation input

ADR-008 S11 specifies the unlock-TX2 attestation input as:

```
input = "s402-attestation-v1\0"
      || u32_be(len(tx1Digest))    || tx1Digest
      || u32_be(len(tx2Digest))    || tx2Digest
      || u32_be(len(policyDigest)) || policyDigest
      || u32_be(len(constructedAt))|| constructedAt
      || u32_be(len(facilitatorPubkey)) || facilitatorPubkey
```

### 5.1 Encoding rules

- **Length prefixes** are 32-bit big-endian unsigned integers (`u32_be`).
- **Each field's bytes** are the UTF-8 encoding of the field's string representation — the full string, **including** any algorithm prefix (`"blake2b256-..."`, `"sha256-..."`, `"ed25519-..."`). Length-prefixing makes field boundaries unambiguous without needing a separate serialization for digests vs. strings vs. keys. Note: Sui tx digests are BLAKE2b-256, not SHA-256, so `tx1Digest` / `tx2Digest` on Sui carry the `"blake2b256-"` prefix.
- **Order is fixed.** Any permutation is a new, incompatible input. Future fields are appended; never inserted.
- **No terminators between fields.** The length prefix is sufficient.

### 5.2 Why TLV, not JSON

TLV with length prefixes is unambiguous by construction — two distinct input tuples always produce distinct byte sequences. JSON would require re-canonicalizing an attestation every time a new optional field is added; TLV is append-only and forward-compatible.

### 5.3 Reject rules

- Any length prefix greater than 2²⁰ (1 MiB) → reject. No individual attestation field should exceed 1 MiB; this is a DoS guard.
- Total input length greater than 8 MiB → reject.
- Length claims exceeding actual remaining bytes → reject.

---

## 6. Resource limits

Implementations MUST enforce:

| Limit | Maximum | Enforcement |
|---|---|---|
| Scheme spec file | 1 MiB (1,048,576 bytes) raw | Reject before step 1 of §4.1. |
| Canonicalized spec bytes | 1 MiB | Reject after step 6 of §4.1. |
| `paymentRequirements` JSON | 256 KiB raw | Reject at JSON parse. |
| `paymentPayload` JSON | 256 KiB raw | Reject at JSON parse. |
| TLV attestation | 8 MiB total | Per §5.3. |
| Individual TLV field | 1 MiB | Per §5.3. |

Exceeding any limit returns `S402_CANONICALIZATION_REJECTED` with `reason: "file-too-large"`.

Rationale: DoS protection. A facilitator MUST be able to decline to hash a 1 GiB "scheme spec" submitted by an attacker. The limits are chosen to be generous (real scheme specs are ~20 KiB; real payloads are ~2 KiB) while capping memory cost.

---

## 7. Error taxonomy (non-normative preview — full list in `typescript/src/errors.ts`)

Canonicalization failures expose a stable error code so clients can react programmatically:

| Code | Meaning |
|---|---|
| `S402_CANONICALIZATION_REJECTED` | Umbrella. `reason` field disambiguates. |
| `S402_SPEC_DIGEST_MISMATCH` | Pinned digest does not match supported digest. See ADR-006. |
| `S402_VERSION_UNSUPPORTED` | Client `s402-Version` not in server's supported set. See ADR-006. |
| `S402_TX_BINDING_MISMATCH` | Client's recomputed `txBinding` does not equal `envelope.txBinding`. See ADR-007. |
| `S402_UNKNOWN_ALGORITHM` | `algs.digest` or `algs.sig` not in client's acceptable set. |

---

## 8. Test vectors

Reference vectors live at `spec/vectors/canonicalization/`. Each vector is a triple `(input, canonical_bytes, digest)`. Required coverage:

- **§3.2.1:** duplicate-key object rejection.
- **§3.2.2:** amount-as-string (accept valid, reject `1e6`, reject `01`, reject `"1.0"`).
- **§3.2.3:** int64-overflow rejection.
- **§3.2.4:** non-NFC address rejection (use Unicode test data from UAX #15 §5).
- **§3.2.5:** enum case mismatch rejection.
- **§3.3:** domain-separation proof — two inputs that would hash-collide without the prefix produce different digests with it.
- **§3.4:** `0x1E` separator uniqueness — a payload containing `"foo\u001ebar"` in a string field canonicalizes such that the literal `0x1E` byte never appears in the JCS output.
- **§4.1:** BOM rejection, CR-only rejection, TAB-outside-fence rejection, NFC normalization across the whole document, exactly-one-trailing-newline enforcement.
- **§4.2:** CommonMark parser used for TAB-in-fence detection (a regex-based implementation will fail at least one of the nested-fence vectors).
- **§5.1:** TLV field-ordering — permuting any two fields produces a different digest.
- **§6:** each resource limit, rejected at the stated step.

Conformance for v0.6.0 ship requires 100% of vectors pass on every supported language implementation (`typescript/`, `python/`, `rust/`, `go/`).

---

## 9. Versioning of this spec

This document is versioned alongside the protocol. Changes that alter the byte output for any existing input bump the `-v{N}` in a purpose prefix (e.g., `"s402-txbinding-v2\0"`). Clients reject unknown purpose-versions; this is the safe default.

Backwards-compatible clarifications (editorial, examples, non-normative prose) do not require a version bump but MUST be listed in revision history.

---

## 10. Revision history

- **v0.6.0-draft (2026-04-19):** Initial consolidation of Wave 1.3 + Wave 3.3 + Wave 3.6 + Wave 4.7 findings from /vet review. Defines JCS profile, markdown procedure, TLV layout, resource limits, and domain-separation registry.

---

## 11. References

- RFC 8785 — JSON Canonicalization Scheme
- RFC 8259 — The JavaScript Object Notation (JSON) Data Interchange Format
- RFC 2119 — Key words for use in RFCs to Indicate Requirement Levels
- RFC 20 — ASCII Format for Network Interchange (record separator)
- Unicode Standard Annex #15 — Unicode Normalization Forms
- CommonMark Specification v0.30
- libsodium documentation — key derivation + domain separation conventions
- Noise Protocol Framework §5 — prologue and domain separation
- s402 ADR-006, ADR-007, ADR-008, ADR-009
- s402 INVARIANTS.md S3, S7
