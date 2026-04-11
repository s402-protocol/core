# ADR-001: Protocol Boundaries — Facilitator Trust, Receipt Cardinality, Scheme Cap, and Extension Hygiene

**Status:** Accepted
**Date:** 2026-04-11
**Supersedes:** (none — first ADR)

## Context

s402 is about to leave the "single facilitator, single chain, low-volume" phase. v0.1 shipped the Sui reference implementation and the MCP server; v0.2 added signed receipts and hardened the wire protocol; v0.3 will begin receiving external contributions, cross-chain facilitators, and — if the plan works — agent-initiated traffic at volumes the current implementation was never stress-tested against.

A scale-fragility review of the protocol surfaced four load-bearing decisions that are currently **implicit** in the code and invariants, but not written down. Each one is the kind of thing that decays silently across AI sessions or external contributions: nobody *means* to break it, but in the absence of a written rationale, the first person who needs to touch the area makes a locally-reasonable choice that's globally wrong. The S7 boundary incident (see `knowledge/protocol-design.md`, Feb 2026) is the canonical cautionary tale — Sui-specific address validation was introduced into `http.ts` by four consecutive AI sessions before a human caught it, because each session saw the existing regex and assumed it was load-bearing.

This ADR exists to capture four decisions that should not be re-derived by future contributors or re-debated in future sessions. Each decision is made in the spirit of Tim Berners-Lee's original HTTP: **minimal core, legible extensions, explicit retirement paths.** Protocols that accrete extensions are protocols that won. Protocols that stay pristine are protocols that lost. We design for winning.

## Decision

### Decision 1 — Facilitator Trust Model: Clients Must Independently Verify

**Rule:** A client MUST NOT mark a payment as complete based solely on a facilitator's `SettleResponse`. The client MUST independently verify the on-chain transaction digest against the chain's ledger before treating the payment as settled.

**Mechanism:**
- Every `SettleResponse` from a facilitator MUST include a chain-native transaction digest (e.g., Sui tx digest, EVM tx hash)
- The client MUST call the appropriate chain RPC to confirm the digest exists, includes the expected payee, amount, and asset, and has reached the finality threshold the resource server requested
- If the verification fails, the client MUST raise `SETTLEMENT_UNVERIFIED` and treat the payment as non-settled — the request is NOT retried automatically, because retries would double-pay

This elevates the currently-implicit assumption ("facilitators are honest") to an explicit invariant candidate (**S8: Facilitator accountability**) which will be added to `INVARIANTS.md` in v0.3.

**Why this matters for scale:** At 1 facilitator, trust is a config choice. At 500 facilitators across compliance jurisdictions, wallet providers, and chains, trust-by-allowlist becomes the client's only defense — AND the allowlist is only as good as the verification step behind it. Without independent chain verification, a malicious facilitator can issue fake settlement acknowledgments and the resource server has no way to detect the fraud until users complain on Twitter.

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

- [ ] Add S8 (Facilitator accountability) to `INVARIANTS.md` with the Decision 1 mechanism as proof
- [ ] Add `tx_digest` field to `SettleResponse` wire type (breaking change for facilitators)
- [ ] Create `docs/extensions/` directory with README describing the documentation requirement
- [ ] Add boundary test that fails if any `extensions` key is unprefixed (mirrors the S7 boundary test)
- [ ] Write conformance test vectors for "facilitator returns tx_digest for an invalid on-chain state" — client must reject
- [ ] Schedule council review of INVARIANTS.md at 1K / 1M / 1B payments/sec to surface any decisions this ADR missed
