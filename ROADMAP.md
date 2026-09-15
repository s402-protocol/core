# s402 Roadmap

> This is the public roadmap for s402 — the HTTP wire protocol for agent payments.
> It is forward-looking; nothing here is a commitment to ship on a specific date.
> The authoritative source for shipped behavior is `INVARIANTS.md` and the ADRs under `docs/adr/`.

> **Reality note (2026-07-02):** the version numbers below have drifted from what actually shipped.
> The *actual* v0.7.0 (2026-04-22) shipped **L402 read-path interop** (`s402/compat-l402`, DAN-344),
> and the *actual* v0.8.0 (2026-06-28) shipped the **transport abstraction** (ADR-011: one seam,
> three carriers — HTTP / MCP / A2A, with opt-in x402 inbound bridges). See `typescript/CHANGELOG.md`.
> The items listed under "v0.7.0 — federation + session rotation" below did NOT ship under that
> number and **remain open** (unscheduled); the "v0.6.x" sections' status should likewise be checked
> against the CHANGELOG rather than trusted from this file.

---

## Principles that shape this roadmap

1. **s402 is a wire protocol, not a product.** The roadmap lists protocol changes (formats, invariants, amendment-chain additions), not infrastructure. Facilitator operations and SDK features live in SweeFi and the chain-adapter repos.
2. **Interop when possible, superset when wise.** Each item is evaluated against the interop-superset principle (ADR-005). We absorb x402 / MPP / ACP / A2A formats where they're good; we exceed them where their business models forbid.
3. **Invariants don't inflate.** Every new safety property is measured against the existing invariant set. Redundant invariants are rejected — see the delta analysis in ADR-010 for the Council's dropped proposals.
4. **Chain-agnosticism is non-negotiable.** S7 is enforced repo-wide. Every protocol change must be expressible without chain-specific imports in `typescript/src/`.

---

## Shipped (as of 2026-04-21)

- **Invariants S1–S14** (INVARIANTS.md + ADR-008): stale rejection, trust boundary, scheme irreducibility, error recoverability, dedup, x402 roundtrip, chain-agnostic boundary, facilitator accountability, replay bounds, extension additivity, unlock-TX2 causal binding, adversarial catalogue scaffolding, cross-scheme composition guidance, constant-time comparison.
- **Five schemes** (`exact`, `prepaid`, `stream`, `escrow`, `unlock`) with S3 irreducibility proof.
- **x402 v1/v2 compatibility** (`compat.ts` + 42 roundtrip tests).
- **Version negotiation** (ADR-006): `s402-Version` + `s402-Spec-Digest` headers, discovery document, amendment chain.
- **Settlement envelope** (ADR-007): chain-agnostic discriminated union with `txBinding`, inline attestation for unlock, `Idempotency-Key` semantics.

---

## v0.6.0 — hardening

Target: close all Wave 3/4 adversarial-review gaps identified in the April 2026 /vet pass. ADR-references are the source of truth for each item.

- **Adversarial test catalogue** (S12 / ADR-008): ship documented attack vectors per scheme at `spec/vectors/<scheme>/adversarial/`. Each MUST-fail vector is wired to a specific invariant.
- **S11 inline attestation** (ADR-008): unlock-TX2 attestation lands in the envelope, not at a separate URL. Client verification non-bypassable by construction.
- **Extension additivity runtime check** (S10): `typescript/src/extensions.ts` rejects extensions whose declared effects violate the additivity rule.
- **Canonicalization spec finalized** (`spec/canonicalization.md`): RFC 8785 JCS, domain-separation prefix registry, duplicate-key rejection.
- **Legacy `s402SettleResponse` deprecation warning**: v0.5.9 emits structured warning; v0.6.0 defaults to envelope; legacy still accepted via `Accept: application/json`.

---

## v0.6.1 — S15/S16 docs

Target: write the two new invariants into INVARIANTS.md and land the ADR. Low code, high signal.

- **S15 Mid-Session Signer Rotation** (ADR-010): session bound to mandate/shared-object, not to signer pubkey. Sharpest consequence: zkLogin ephemeral key cycling is now explicitly tolerated for all long-running schemes.
- **S16 Protocol Version Binding** (ADR-010): version + scheme digest bound into signed payload (not only transport headers). Closes semantic-downgrade attacks across scheme amendments.
- **S5 + S8 augmentations**: reference cross-process idempotency (ADR-007 `Idempotency-Key`) and S15 interaction.

---

## v0.6.2 — S16 Sui enforcement

Target: turn S16 from documentation into on-chain enforcement for the Sui adapter.

- **`assert_protocol_version` Move helpers** across all scheme modules in `@sweefi/sui/move/`.
- **SDK PTB construction** prepends the version assertion as the first instruction.
- **Lint**: `s402/require-version-assertion` flags any PTB builder that doesn't include the assertion.
- **Conformance vector** `adversarial/version-strip-v05-presents-as-v06.json` — MUST fail on-chain.

---

## v0.7.0 — federation + session rotation

Target: close ADR-009 G1 (facilitator key rotation) and formalize the `s402ClientSession` API with explicit rotation support.

- **Facilitator key rotation** (ADR-009 G1): JWKS-style rotating set with overlap windows, OR CRL/OCSP revocation channel, OR Sigstore-anchored trust root. Implementation choice locked in a follow-up ADR (tentatively ADR-011).
- **`s402ClientSession` interface**: explicit `rotateSigner(newSigner)` method. Capture-by-pubkey is lint-rejected.
- **S13 composition linter** (`@sweefi/sdk`): detect unsafe bridging patterns at SDK-emit time.
- **MCP registry listing** for the reference facilitator.
- **Multi-facilitator threshold attestations** (reserved in ADR-007's `facilitatorIds: string[]` array shape, implemented here).

---

## Parked — real but not yet scheduled

These are items the project believes are worth doing but are blocked on prerequisites (ecosystem readiness, another chain adapter, a concrete proposal, etc). Parked ≠ abandoned. Each parked item has a trigger condition that will move it to scheduled.

### P1. Privacy Scheme

**Why parked.** s402's wire format exposes payment metadata in HTTP headers and in signed payloads. For human-facing checkouts this is fine; for agent-to-agent flows and for use cases where observer analysis of spending is a risk (agent swarms, compliance-sensitive SaaS), a privacy-preserving scheme variant is genuinely useful.

**Trigger to schedule**: Sui's active privacy-primitive development (Seal, zkLogin, research publications) matures to a stable, documented primitive suitable for integration. When that lands, P1 becomes a scheme-proposal under ADR-009 G3 (acceptance process).

**Sketch of scope (not a commitment):**
- A sixth scheme `private` that uses Sui's privacy primitive to hide the `payTo` recipient, the amount, or both.
- Corresponding x402-compat behavior: the `private` scheme is s402-only (no x402 roundtrip) — this is a superset case, not an interop case.
- S10 extension-additivity applies: privacy MUST NOT relax any safety invariant; it can only add structural constraints.

**Related**: ADR-009 G3 (scheme acceptance process), INVARIANTS §S3 (irreducibility proof obligation).

### P2. Sixth-scheme acceptance process (ADR-009 G3)

**Why parked.** A formal acceptance process is governance work. The project's stance is that governance should emerge from concrete usage, not be imposed preemptively. When a concrete proposal for scheme #6 (P1, Lightning invoice, EIP-7702 batched, intent-auctions, or something unforeseen) reaches RFC quality, the process gets built around it.

**Trigger to schedule**: first substantive community RFC for a sixth scheme.

### P3. Non-Sui chain adapters

**Why parked.** s402 is chain-agnostic by construction (S7), but each new chain requires an adapter package that narrows the envelope's chain-specific fields and implements S8-style digest binding in that chain's signing API. The first non-Sui adapter drives ADR-012 (chain-reorg tolerance, ADR-009 G2).

**Trigger to schedule**: a concrete integration demand — either a partner who ships on Solana/EVM, or a use case we want to dogfood that requires it.

**Order of likely adoption** (if forced to rank): Solana (close finality semantics to Sui) > EVM L2 (Base, where x402 already runs) > EVM L1.

### P4. Envelope JWS signing

**Why parked.** ADR-007 considered signing envelopes at the protocol layer and rejected it for v0.6.0 on the grounds that signing keys are operator concerns (SweeFi layer). When SweeFi publishes a facilitator-identity JWS scheme, s402 can wrap the envelope without a wire break.

**Trigger to schedule**: SweeFi ADR defining the facilitator identity document format.

### P5. Post-quantum algorithm migration

**Why parked.** ADR-007's `algs` field reserves `ml-dsa-44` as a signature algorithm identifier. The field is forward-compatible, so migration is mechanical once NIST-standardized primitives have library support in Node's `crypto` and in Sui's validators. No protocol work needed today.

**Trigger to schedule**: post-quantum primitive reaches production-grade library support AND threat model motivation (currently speculative — "store now, decrypt later" is the only argued-real threat and even that is decades out for ed25519 with ~256-bit security margin).

---

## Non-goals (and why)

- **Mandate issuance / revocation as an s402 primitive.** Belongs in Swee Mandate (SweeFi Move layer). s402 transports payments that reference capabilities; it does not issue or revoke them.
- **Settlement finality definition.** Chain-specific. Each chain adapter documents its finality threshold in its README (ADR-009 G2).
- **Key custody / wallet management.** Operator concern, not wire-protocol concern.
- **Pricing / fee schedules.** Market concern, not wire-protocol concern.
- **Human-facing checkout UI.** Belongs in Swee Pay (a SweeFi product); s402 is the wire underneath.

---

## How to propose a change

1. **Bug or tightening**: [file an issue](https://github.com/s402-protocol/core/issues). Include a repro or a failing conformance vector.
2. **New invariant**: open an ADR PR following the pattern of ADR-008 and ADR-010 — delta analysis first (what's already covered), then the proof, then enforcement.
3. **New scheme**: open a Discussion for a 30-day community window (ADR-009 G3), then an ADR with an S3 irreducibility proof.
4. **Non-Sui chain adapter**: start with the adapter repo; s402 protocol changes should be rare and will be driven by ADR-012.

---

## References

- `INVARIANTS.md` — the invariant system (S1–S16).
- `docs/adr/` — architecture decision records.
- `docs/THREAT_MODEL.md` — adversarial model.
- `spec/canonicalization.md` — canonical encoding rules.
- `docs/schemes/` — per-scheme canonical specs.
