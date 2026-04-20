# s402 Threat Model (Draft)

**Status:** Draft v0.1 · 2026-04-19 · to be hardened in waves
**Scope:** The s402 protocol itself — wire format, scheme semantics, SDK trust boundary. Operational threats (facilitator deployment, key custody, rate limiting) belong in SweeFi's threat model.

---

## 1. Attacker models

### A1. Malicious resource server
Controls the HTTP 402 challenge — can lie about `amount`, `payTo`, `scheme`, `schemeDigest`, `network`.

### A2. Malicious facilitator
Controls settlement broadcast. Can sign attestations, withhold settlement, return valid settlements for different requests, construct unlock-TX2 transactions that diverge from agreed policy.

### A3. Network attacker (MITM)
Can read and modify HTTP requests/responses in transit. Assumes TLS is not present (adversarial deployment) or TLS is compromised (nation-state).

### A4. Malicious client
Tries to double-spend, replay, or defraud a resource server.

### A5. Malicious extension author
Publishes an s402 extension that appears to add functionality but weakens scheme invariants.

### A6. Malicious scheme author (future)
Proposes a new scheme that claims to be S3-irreducible but is actually a decomposition of existing schemes (opens new attack surface).

### A7. Passive observer
Logs all traffic, attempts to correlate payments with identities or infer business intent.

---

## 2. Asset inventory

- **Payment intent integrity** — the amount, recipient, and scheme the client *intends* to pay.
- **Settlement authenticity** — the claim "this payment was settled on-chain."
- **Scheme semantics** — the formal guarantees each of the five schemes provides.
- **Extension boundary** — the guarantee that extensions cannot weaken scheme semantics.
- **Protocol upgradeability** — the ability to version and evolve schemes without silent drift.

---

## 3. Protocol-layer threats

### T1. Payment-requirements tampering (A1 or A3)
**Attack:** Resource server (or MITM) advertises `amount: "1 USDC"` but client's PTB pays `amount: "100 USDC"`.
**Defense:** S2 — client SDK validates that the PTB it builds matches the requirements it received; mismatch = client refuses to sign. INVARIANT.
**Residual risk:** Client SDK implementation bugs. Mitigated by conformance vectors at `spec/vectors/`.

### T2. Replay of a previously-settled payment (A4)
**Attack:** Malicious client re-submits a previously-settled payload to a second facilitator/resource.
**Defense:** S5 (per-process dedup) + S9 (per-scheme replay bounds, on-chain nonce/dedup). Sui validator-level digest dedup is the final backstop.
**Residual risk:** Two facilitators not sharing dedup state could both submit; on-chain dedup resolves. Window: milliseconds.

### T3. Stale payment acceptance (A4)
**Attack:** Client submits a payment with a past `expiresAt`, hoping for clock skew.
**Defense:** S1 (three-layer timestamp check).
**Residual risk:** Wall-clock attacks on a single facilitator with bad NTP. Acknowledged; operational mitigation in SweeFi.

### T4. Facilitator returns settlement for a different request (A2)
**Attack:** Facilitator receives request R1, returns a valid-looking envelope claiming to settle R1 but actually settling R2 (or fabricating).
**Defense:** S8 (Sui digest binding, client-signed) + ADR-007 (request-digest binding, all chains). Client recomputes `requestDigest` locally and rejects mismatches.
**Residual risk:** For unlock-TX2 specifically, see T7.

### T5. Scheme-semantics silent drift (A1, A2)
**Attack:** Server claims to support scheme "exact" but has implemented a semantically divergent variant.
**Defense:** ADR-006 scheme content-hashing. Clients pin `schemeDigest`; facilitator advertises supported digests; mismatch = 409.
**Residual risk:** Clients who don't pin digests. Mitigated in v0.6.0 by making digest pinning default-on in `@sweefi/sdk` client wrapper.

### T6. Protocol version downgrade (A3)
**Attack:** MITM strips `s402-Version: 0.6.0` to force the server into a lower-version code path with known weaknesses.
**Defense:** Under TLS, this is the TLS threat model, not ours. Without TLS, ADR-006's `s402-Supported-Versions` response header is advisory only — we do not solve the downgrade problem protocol-side.
**Residual risk:** Acknowledged — s402 assumes TLS (Assumption #4 in INVARIANTS.md).

### T7. Unlock-TX2 forgery (A2)
**Attack:** Facilitator constructs a TX2 that diverges from the agreed unlock policy (wrong recipient, wrong unlock conditions) yet reports it as authorized.
**Defense:** S11 (Unlock-TX2 causal binding) — attestation chain from TX1 digest to TX2 digest signed by facilitator; client verifies before trusting decrypted content.
**Residual risk:** Semantic divergence within the policy boundary (see S11 ⚠️). Mitigated by Move contract-level policy enforcement at SweeFi layer.

### T8. Extension relaxes scheme invariant (A5)
**Attack:** Third-party extension for scheme "exact" quietly relaxes `expiresAt` check to 0, effectively disabling S1 for payments using that extension.
**Defense:** S10 (Extension Additivity) — static analysis of extension manifests + runtime rejection of manifests declaring forbidden behaviors.
**Residual risk:** Extension behaves differently at runtime than its manifest declares. Mitigation: extension review before publication (process, not protocol).

### T9. Forged scheme claim / new malicious scheme (A6)
**Attack:** Author submits a new scheme that is actually a composition of existing schemes, claiming S3-irreducibility to hide attack surface.
**Defense:** S3 proof obligation — any new scheme MUST include a proof of irreducibility against the existing five. Review at spec-acceptance time.
**Residual risk:** Proof review is human-gated; quality depends on reviewers.

### T10. Cross-scheme composition weakening (A4)
**Attack:** Client composes `unlock → stream` via an intermediate bridge account that holds funds between legs, reintroducing counterparty risk.
**Defense:** S13 — composition inherits weakest invariant; bridging is an anti-pattern and s402's composition-safety linter (v0.7.0) flags it.
**Residual risk:** Clients who orchestrate outside `@sweefi/sdk`. Protocol documents the anti-pattern; enforcement is SDK-side.

### T11. Amount overflow / unit confusion (A1, A4)
**Attack:** Amount encoded as u64 string, but client interprets as u128 or smallest-unit vs integer-USD confusion.
**Defense:** S2 via `isValidU64Amount`. All scheme specs require amounts in smallest on-chain unit (e.g., MIST for SUI).
**Residual risk:** Documentation-level clarity. Mitigated by conformance vectors.

### T12. Address validation bypass at s402 layer (A3, A4)
**Attack:** Control characters or whitespace in `payTo` that survive s402-layer validation but break chain-layer parsing.
**Defense:** S2 layer 1 — http.ts wire-decode rejects control characters; chain-format validation delegated to adapter per S7.
**Residual risk:** Adapter layer bug. Mitigated by S7 boundary tests + adapter-specific test suites.

### T13. Envelope discriminator confusion (A2)
**Attack:** Facilitator returns envelope with `status: "settled"` but missing `settled` field, or with both `settled` and `rejected` populated, hoping client accepts the happy path.
**Defense:** ADR-007 TypeScript discriminated union + runtime Zod validation. Client SDK rejects malformed envelopes.
**Residual risk:** Non-TypeScript clients must replicate the validation; conformance vectors cover this.

---

## 4. Information-disclosure threats

### ID1. Request traffic correlation (A7)
**Claim:** s402 does not protect against traffic analysis. Payment intents (amount, recipient, scheme) are visible to MITM if TLS is absent.
**Scope:** Acknowledged; not in s402's remit. Privacy-preserving schemes (e.g., sealed-payment extensions) are a SweeFi-layer concern.

### ID2. Identity leakage via discovery document (A7)
**Claim:** `.well-known/s402.json` and `.well-known/s402-facilitator` disclose operator identity and supported capabilities.
**Scope:** By design. Operators who need anonymity should not run public facilitators.

### ID3. Scheme-digest enumeration (A7)
**Claim:** Digest values in discovery + response headers enumerate every scheme revision the operator supports, which may reveal deployment history.
**Mitigation:** Operators who need to obscure this can serve only the latest digest; s402 makes advertising multiple digests optional.

---

## 5. Cryptographic assumptions

| Assumption | Used for | If broken |
|-----------|----------|-----------|
| BLAKE2b-256 collision resistance | S8 (Sui digest binding) | Facilitator could forge tx that produces same digest as client's signed tx. Probability: ~2^-128. |
| SHA-256 collision resistance | ADR-006 scheme digest, ADR-007 request digest | Attacker could publish a different scheme spec with the same digest. Probability: ~2^-128. |
| Ed25519 signature unforgeability | Exact scheme + S11 attestations | Facilitator could forge attestation. Probability: negligible. |
| TLS transport confidentiality + integrity | All network hops | All threats above degrade to the TLS threat model. |

---

## 6. Known gaps (call-out — do not silently rely)

- **G1. Protocol downgrade attack absent TLS** — see T6. No protocol-layer defense. Documented.
- **G2. Facilitator-side extension behavior vs manifest** — see T8 residual risk. Human review required.
- **G3. Cross-facilitator dedup during the settlement window** — see T2. On-chain dedup resolves within seconds; window is acknowledged.
- **G4. Semantic divergence within a policy (unlock)** — see T7. Move contract enforcement at SweeFi layer.
- **G5. Facilitator key rotation + chain reorg + scheme acceptance process** — tracked in ADR-009. Deferred to v0.7.0.

---

## 7. Disclosure policy

See `SECURITY.md` at repo root. Vulnerabilities in s402 the protocol → disclose to s402 maintainers. Vulnerabilities in SweeFi's implementation of s402 → disclose to SweeFi maintainers.

---

## 8. Hardening waves (planned)

- **Wave 1 (this quarter):** Ship S9–S13 invariants + ADR-006 + ADR-007. Publish adversarial test catalogue.
- **Wave 2:** External review by one Sui Move specialist + one agent-protocol specialist. Budget for $5K per reviewer (total $10K).
- **Wave 3:** Public threat-model RFC (GitHub Discussion) — invite x402/MPP/A2A contributors to critique.
- **Wave 4:** Post-mainnet bug bounty (Immunefi tier, $25K max per critical).

---

## 9. Revision history

- v0.1 (2026-04-19): Initial draft. 13 protocol-layer threats catalogued. 5 invariants (S9–S13) referenced.
