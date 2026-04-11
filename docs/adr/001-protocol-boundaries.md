# ADR-001: Protocol Boundaries — Facilitator Trust, Receipt Cardinality, Scheme Cap, and Extension Hygiene

**Status:** Accepted
**Date:** 2026-04-11
**Supersedes:** (none — first ADR)

## Context

s402 is about to leave the "single facilitator, single chain, low-volume" phase. v0.1 shipped the Sui reference implementation and the MCP server; v0.2 added signed receipts and hardened the wire protocol; v0.3 will begin receiving external contributions, cross-chain facilitators, and — if the plan works — agent-initiated traffic at volumes the current implementation was never stress-tested against.

A scale-fragility review of the protocol surfaced four load-bearing decisions that are currently **implicit** in the code and invariants, but not written down. Each one is the kind of thing that decays silently across AI sessions or external contributions: nobody *means* to break it, but in the absence of a written rationale, the first person who needs to touch the area makes a locally-reasonable choice that's globally wrong. The S7 boundary incident (see `knowledge/protocol-design.md`, Feb 2026) is the canonical cautionary tale — Sui-specific address validation was introduced into `http.ts` by four consecutive AI sessions before a human caught it, because each session saw the existing regex and assumed it was load-bearing.

This ADR exists to capture four decisions that should not be re-derived by future contributors or re-debated in future sessions. Each decision is made in the spirit of Tim Berners-Lee's original HTTP: **minimal core, legible extensions, explicit retirement paths.** Protocols that accrete extensions are protocols that won. Protocols that stay pristine are protocols that lost. We design for winning.

## Decision

### Decision 1 — Facilitator Trust Model: Clients Must Independently Bind the Settlement to Their Signed Payload

**Rule:** A client MUST NOT mark a payment as complete based solely on a facilitator's `SettleResponse`. For any scheme in which the client signs the full transaction before sending it to the facilitator (currently: `exact`, `stream`, `escrow`, `unlock-TX1`), the client MUST verify that the facilitator-reported tx digest is **causally bound** to the exact bytes the client signed — before treating the payment as settled.

**Mechanism — local, offline, zero-RPC (revised 2026-04-11):**

The `exact` scheme (and any scheme following the same client-signs-full-transaction pattern) gets this for free, because Sui's tx digest is a deterministic blake2b hash of the BCS-encoded transaction bytes:

```
digest = base58(blake2b_256("TransactionData::" || bcs_bytes))
```

The client already holds `bcs_bytes` — it just signed them. Therefore:

- Every `SettleResponse` from a facilitator MUST include a chain-native transaction digest
- The client's scheme implementation MUST expose a `verifySettlement(payload, settleResponse)` function that recomputes the expected digest from the signed payload bytes and compares it to the facilitator's reported digest. For Sui, this is a single call to `TransactionDataBuilder.getDigestFromBytes()` — **no chain RPC required**
- If the digests do not match, the client MUST raise `DIGEST_MISMATCH` and treat the payment as non-settled — the request is NOT retried automatically, because retries would double-pay. A mismatch means the facilitator either broadcast a different transaction than the one the client signed, or is lying about what it broadcast; either is grounds to stop trusting that facilitator
- Optional belt-and-suspenders: an RPC roundtrip to the chain can additionally confirm the digest exists on the ledger and has reached the desired finality threshold. This is **not required by the wire protocol** and is layered on top by implementations that want defense-in-depth against facilitator-side censorship (rather than facilitator-side fraud)

This elevates the currently-implicit assumption ("facilitators are honest") to an explicit invariant (**S8: Facilitator Accountability**), now in `INVARIANTS.md` with the above mechanism as its proof.

**Why a local digest check, not an RPC roundtrip:** An earlier draft of this decision (pre-vet, April 2026 council) mandated that clients MUST call chain RPC to confirm the tx digest exists on-ledger. Vet Agent Beta pointed out that this is unnecessary for schemes where the client signs the full transaction: since Sui's digest is a pure function of the signed bytes, any substitution by the facilitator is detectable *without any network call*. The RPC roundtrip is still allowed (and recommended for high-stakes settlements where the client also wants to detect facilitator-side censorship or reorgs), but making it a protocol-level MUST would (a) add per-payment latency for a check the client can already do offline, (b) make every facilitator-using client hard-dependent on RPC availability, and (c) violate S7 (chain-agnostic protocol surface) by requiring chain-specific verification logic in every s402 implementation.

**Why this matters for scale:** At 1 facilitator, trust is a config choice. At 500 facilitators across compliance jurisdictions, wallet providers, and chains, trust-by-allowlist becomes the client's only defense — AND the allowlist is only as good as the verification step behind it. Without causal binding, a malicious facilitator can issue fake settlement acknowledgments referencing unrelated real on-chain transactions and the resource server has no way to detect the fraud until users complain on Twitter. The offline digest check eliminates this attack surface for client-signed schemes with a ~3-line client assertion, scales linearly with zero network cost, and survives the 500-facilitator future.

**Scheme coverage (live status, per INVARIANTS.md S8):**

| Scheme | Status | Notes |
|---|---|---|
| exact       | IMPLEMENTED | `mcp-server/src/sui-exact.ts` `verifySettlement`. Unique among the five — uses Sui framework primitives (`splitCoins` + `transferObjects`), no custom Move module required. |
| stream      | NOT YET IMPLEMENTED | Needs a `streaming_meter` Move module + `sui-stream.ts` adapter. `verifySettlement` is mechanical (template in INVARIANTS.md § S8). |
| escrow      | NOT YET IMPLEMENTED | Needs an `escrow` Move module with lock/release/refund + `sui-escrow.ts` adapter. Same `verifySettlement` template. |
| unlock-TX1  | NOT YET IMPLEMENTED | Needs an `unlock_receipt` Move module + `sui-unlock.ts` adapter + Seal key-server integration (for TX2). S8 coverage of TX1 itself is mechanical once the adapter exists. |
| unlock-TX2  | OPEN    | Facilitator-constructed after TX1 settles — needs a separate attestation mechanism because the client has no pre-sign commitment for TX2. Filed as v0.3 follow-up; see `spec/allium/s8-facilitator-accountability.allium` § `open_question UnlockTX2`. |
| prepaid     | NOT YET IMPLEMENTED | Needs a `prepaid_balance` Move module with deposit/claim/dispute lifecycle. v0.2 uses a receipt-chain mechanism (not digest binding) for the claim path, but the deposit-phase adapter is still missing. |

**Implementation note.** The "NOT YET IMPLEMENTED" rows above do NOT mean "verifySettlement is the only missing piece." They mean **both the Move contract AND the TypeScript adapter are missing**. `exact` is architecturally unique because Sui framework functions ARE the scheme — the other four require custom Move shared-object state machines that don't exist yet in this repo. See INVARIANTS.md § S8 for the distinction and the verifySettlement pattern template.

### Decision 2 — Receipts Are Scheme-Internal: Wire Protocol Makes No Cardinality Guarantees

**Rule:** The s402 wire protocol makes NO guarantees about how many receipts a payment produces, whether receipts are stored on-chain or off-chain, or how they are aggregated. Receipt semantics are a **scheme-internal** concern. Implementations MAY change their internal receipt model (per-call → Merkle-batched → zk-rollup'd) without breaking wire compatibility.

**Mechanism:**
- Wire types MUST NOT include fields that commit to "one receipt per call" semantics
- Receipt model details (if any) live in `extensions.receipts.*` with an explicit version field (see Decision 4)
- Conformance tests MUST NOT assert receipt count as part of scheme correctness — only payment outcome

**Why this matters for scale:** At 1M payments/sec, the bottleneck is chain throughput (~300K TPS on Sui's target), not the wire format. Any rollup strategy — Merkle batching, state channels, L2s — can be layered into a scheme's on-chain object without touching the wire format, **as long as the wire format never accidentally committed to the "per-call receipt" model.** The prepaid scheme already dodges this (1,000 calls → 2 on-chain txs). This ADR ensures no future scheme bakes cardinality assumptions into the wire.

**Non-goal:** This ADR does NOT specify what rollup strategies s402 will support. It only ensures the wire protocol doesn't preclude them.

### Decision 3 — Scheme Cap: Five Schemes, Burden of Proof on Proposer

**Rule:** s402 has exactly five payment schemes: `exact`, `prepaid`, `stream`, `escrow`, `unlock`. A sixth scheme MAY be added, but only after the proposer has formally shown:

1. The proposed scheme cannot be expressed as any composition of the existing five
2. The proposed scheme cannot be expressed as an extension of an existing scheme via the `extensions` field
3. The proposed scheme has a unique on-chain object lifecycle (per S3's proof structure in `INVARIANTS.md`)
4. At least one production use case exists that cannot be served by any combination of the above

**Pre-rejected proposals** (these have been considered and decomposed — they are NOT sixth schemes):

| Proposal | Decomposed as | Reasoning |
|---|---|---|
| auction | price discovery (coordination protocol) + settlement (one of the five) | Discovery is not a payment primitive |
| recurring subscription | `stream` with fixed tick pattern OR `prepaid` with auto-topup | Time-based repetition already covered |
| conditional release | `escrow` with explicit condition encoding | This IS escrow |
| reputation-weighted discount | pricing (belongs in 402 response) + settlement (any scheme) | Pricing is not a payment primitive |
| refundable payment | `escrow` with auto-release on delivery + refund on deadline | This IS escrow with a different condition |
| confidential payment | `unlock` variant with different key-server semantics | Belongs as an unlock sub-variant, not a new scheme |

**Rejection is logged, not forgotten.** When someone proposes a new scheme, the first review step is to consult this table. If the proposal is already listed, the discussion is closed. If it isn't, the proposer walks through tests 1–4.

**Why this matters for scale:** OAuth 2.0's failure mode was proliferating grant types that each encoded a slightly different user-agent interaction pattern. That design space was unbounded because interaction patterns are cheap to invent. s402's design space is bounded by the economics of Move contract engineering (~6 months per new scheme + audit), but only if contributors are *aware* the space is bounded. This ADR makes the boundary explicit.

### Decision 4 — Extension Hygiene: Legibility Over Containment

**Rule:** The `extensions` field is the intended growth surface of s402. We do NOT try to prevent extensions; we ensure they are legible, versioned, and retirable. Every extension that is load-bearing for any implementation MUST follow these rules:

**4a. Naming.** Extensions use reverse-domain namespacing: `com.sweefi.confidential-unlock`, `org.s402.receipts.merkle`, `io.github.<org>.<name>`. Unprefixed keys are reserved for the core protocol.

**4b. Versioning.** Every extension MUST carry a `version` field (semver). Breaking changes bump the major version AND change the namespace key (e.g., `com.sweefi.confidential-unlock-v2`) so old and new can coexist during migration.

**4c. Documentation requirement.** An extension is considered "published" when it has a markdown file in `docs/extensions/<namespace>.md` describing: what it does, why it's needed, which schemes it applies to, example payloads, and the deprecation criteria (see 4e).

**4d. Graduation path.** If an extension satisfies the four tests in Decision 3, it becomes eligible for promotion to a scheme. This is the ONLY way a sixth scheme can be added. Graduation requires a new ADR.

**4e. Retirement path.** Every extension documentation MUST include an explicit deprecation criterion: *"This extension is deprecated when ___."* Common criteria:
- "the functionality is graduated into a core scheme"
- "no conformance test has exercised this extension for 12 months"
- "the underlying dependency (e.g., a key server product) is sunset"

When a deprecation criterion is met, the extension moves to `docs/extensions/deprecated/` with a `REMOVED IN: vX.Y` marker. Implementations that still use the extension continue to work (it's still defined), but new implementations see a deprecation warning at wire-decode time.

**Why this matters for scale:** OAuth 2.0 didn't die from extension count — it died because it had no retirement path. Resource Owner Password Credentials was "deprecated" for a decade before libraries actually removed it, because nothing about the deprecation was enforceable and nothing about the "deprecation" invalidated existing implementations. s402 avoids this by making retirement a documented, testable state: if an extension hasn't been exercised by conformance tests in 12 months, it's a candidate for removal and the maintainers can act on that signal instead of debating in a mailing list.

## Alternatives Considered

**Alt A — Cap extensions to prevent OAuth-style rot.** Rejected. Winning protocols accrete extensions; only losing protocols stay pristine. Capping would be a signal that s402 doesn't expect to win. The goal is not minimalism, it's legibility.

**Alt B — Require on-chain receipts for all schemes.** Rejected. Breaks the prepaid scheme's core value proposition (1,000 calls → 2 on-chain txs). Commits the wire format to a specific rollup model, violating Decision 2.

**Alt C — Allow facilitators to assert settlement without chain verification.** Rejected. This is the current implicit model, and it does not survive the 500-facilitator future. Trust has to be verifiable, not asserted. Every other successful protocol with this shape (TLS, DNSSEC, Certificate Transparency) ended up with independent verifiability as a load-bearing property — s402 should start there, not drift there.

**Alt D — Enumerate permitted extensions in the core spec.** Rejected. An allowlist of extensions requires a centralized coordination point, which contradicts the chain-agnostic, self-sovereign nature of the protocol. Reverse-domain namespacing (Decision 4a) gives us the same collision resistance without the gatekeeper.

**Alt E — Leave all four decisions implicit and react when they break.** Rejected. The S7 boundary incident (Feb 2026) is the proof by counterexample: implicit rules get broken by well-intentioned contributors who don't know they're rules. Explicit ADRs are cheaper than the debugging session that catches the violation six months later.

## Consequences

**Positive:**
- Facilitator trust is now a verifiable property, not a config choice. Malicious facilitators are detected automatically, not retroactively.
- The receipt-cardinality escape hatch means s402 can scale to 1M payments/sec without a wire format change — the rollup work happens inside schemes.
- The "burden of proof on the proposer" rule raises the bar for scheme additions from "seems useful" to "formally irreducible." Pre-rejected proposals never get re-debated.
- Extension hygiene gives contributors a clear place to add features (the `extensions` field) AND a clear retirement criterion so the field doesn't turn into the graveyard OAuth 2.0 became.

**Negative:**
- Clients must implement independent chain verification, which adds a round-trip and RPC dependency to every payment. Facilitator performance claims ("we settled it in 2s!") must now be verifiable, not asserted.
- Implementations that shipped before Decision 1 may need upgrade paths. Existing facilitators must add `tx_digest` to `SettleResponse` before s402 v0.3.
- Extension documentation becomes a required step for any feature that doesn't graduate into core. This is a small tax on contributors; the benefit is that we avoid OAuth's 15-year hangover.

**Risks & watch-fors:**
- **"I'll document it later."** Extensions that are added to code but skip the `docs/extensions/` file become the silent cruft this ADR tries to prevent. Lint rule idea: fail CI if `extensions[*].id` appears in typescript tests but has no corresponding `docs/extensions/<id>.md` file. (Add as a LESSONS.md candidate once we see the first violation.)
- **Chain RPC availability becomes a client hard dependency.** If the chain RPC is down, clients cannot verify settlement and must fail closed. This is the correct tradeoff (fail closed > fail open for money) but it does mean RPC reliability becomes a client-facing SLA, not just a facilitator concern.
- **The pre-rejected list in Decision 3 will need to grow.** Future proposers will find new "obviously irreducible" scheme candidates; each one that gets decomposed should be added to the table, not forgotten. Grooming this list is part of the scheme review process.
- **Retirement criteria are aspirational until the first extension is actually retired.** We'll learn the right criteria by doing it once and seeing what broke.

## Follow-ups

- [x] Add S7 (chain-agnostic protocol surface) to `INVARIANTS.md` — previously referenced here but missing from file. Done 2026-04-11.
- [x] Add S8 (Facilitator accountability) to `INVARIANTS.md` with the Decision 1 mechanism as proof. Done 2026-04-11.
- [x] Implement `verifySettlement` for the `exact` scheme (`mcp-server/src/sui-exact.ts`). Done 2026-04-11.
- [x] Wire `verifySettlement` into the 402-retry completion path (`mcp-server/src/tools.ts`). Done 2026-04-11.
- [x] Add `DIGEST_MISMATCH` to `errors.ts`. Done 2026-04-11.
- [x] Write Allium behavioral spec for the digest-assertion rule. See `spec/allium/digest-assertion.allium`. Done 2026-04-11.
- [ ] Implement `verifySettlement` for `stream`, `escrow`, `unlock-TX1` schemes (same pattern).
- [ ] Design separate attestation mechanism for `unlock-TX2` (facilitator-constructed) — open question, filed for v0.3.
- [ ] Write conformance test vectors for "facilitator returns a substituted tx_digest" — client must reject with `DIGEST_MISMATCH`.
- [ ] Create `docs/extensions/` directory with README describing the documentation requirement.
- [ ] Add boundary test that fails if any `extensions` key is unprefixed (mirrors the S7 boundary test).
- [x] Schedule council review of INVARIANTS.md at 1K / 1M / 1B payments/sec. Ran C3 on 2026-04-11; vetted on 2026-04-11. Recommendations ingested: ship the 3 load-bearing fixes (this ADR patch, S1 proof fix, S7/S8 backfill), defer or reject the rest. Target performance envelope deliberately capped at **~10K payments/sec** rather than the council's original 1M/sec framing — see `knowledge/scale-fragility-council-v03.md`.
