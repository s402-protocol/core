---
description: Academic and security research track for s402 — whitepaper, threat model, safety invariants, ADRs, conformance vectors, and formal specification. Everything an auditor, security researcher, or academic needs to evaluate the protocol.
---

# Research & Security

This page is for auditors, security researchers, and academics evaluating s402. Everything here is primary-source material — specs, threat models, invariants, and ADRs — not marketing copy.

If you're here to *use* s402, you probably want the [Quick Start](/guide/quickstart) instead. If you're here to *evaluate* s402, read on.

## Primary Artifacts

| Artifact | What it covers | Audience |
|---|---|---|
| **[Whitepaper](/whitepaper)** | Protocol motivation, scheme design, economic model, Sui rationale | Academics, protocol designers |
| **[Wire Format Spec](/specification)** | Normative HTTP headers, encoding, payload schemas | Implementers, auditors |
| **[Threat Model](/THREAT_MODEL)** | Adversarial analysis: what attackers can and cannot do, per scheme | Security reviewers |
| **[Security Model](/security)** | Trust assumptions, invariants, key-rotation and reorg handling | Security engineers |
| **[Architecture](/architecture)** | Facilitator contract, verify/settle split, receipt formats | System architects |

## Safety Invariants (S1–S13)

The protocol is governed by thirteen named invariants. Every implementation, adapter, and scheme must preserve them or be non-conforming. Full formal statements live in [AGENTS.md](https://github.com/s402-protocol/core/blob/main/AGENTS.md); highlights:

| Invariant | Statement |
|---|---|
| **S1** | Requirements never contain client-side secrets |
| **S2** | Payment payloads are canonical — one byte representation per logical payload |
| **S3** | Every scheme defines its own settlement atomicity semantics explicitly |
| **S4** | Error codes are stable across versions — new codes may be added, existing ones never change meaning |
| **S5** | Base64 encoding uses URL-safe alphabet with no padding |
| **S6** | Version negotiation is explicit — no silent fallback across major versions |
| **S7** | **Core protocol is chain-agnostic** — no chain-specific logic in the `s402` package |
| **S8** | Compat layers are one-way input — they normalize x402/MPP into s402, never reverse |
| **S9** | Scheme digests are content-addressed — two schemes with the same digest are interchangeable |
| **S10** | Settlement responses are signed by the facilitator — clients verify before trusting |
| **S11** | Rate caps and ceilings are on-chain contract state, not server-held policy |
| **S12** | Key rotation does not invalidate outstanding receipts |
| **S13** | Reorgs up to chain-documented finality depth preserve receipt validity |

See [ADR-008](https://github.com/s402-protocol/core/blob/main/docs/adr/008-safety-invariants-s9-s13.md) for the derivation of S9–S13.

## Architecture Decision Records

The protocol's design decisions are tracked as ADRs. Each one states the question, options considered, chosen path, and consequences.

| ADR | Decision |
|---|---|
| [001](https://github.com/s402-protocol/core/blob/main/docs/adr/001-protocol-boundaries.md) | Protocol boundaries — what's in s402 vs chain adapters |
| [002](https://github.com/s402-protocol/core/blob/main/docs/adr/002-s402-is-pure-protocol.md) | s402 is pure protocol — zero runtime chain dependencies |
| [003](https://github.com/s402-protocol/core/blob/main/docs/adr/003-upto-scheme.md) | Upto scheme design — on-chain ceiling, variable amount |
| [004](https://github.com/s402-protocol/core/blob/main/docs/adr/004-extensions-architecture.md) | Extensions architecture — how to add non-core features without forking |
| [005](https://github.com/s402-protocol/core/blob/main/docs/adr/005-interop-superset-principle.md) | **Interop when possible, superset when wise** — governing strategic principle |
| [006](https://github.com/s402-protocol/core/blob/main/docs/adr/006-version-negotiation-and-scheme-digests.md) | Version negotiation and scheme digests |
| [007](https://github.com/s402-protocol/core/blob/main/docs/adr/007-settlement-response-envelope.md) | Settlement response envelope shape |
| [008](https://github.com/s402-protocol/core/blob/main/docs/adr/008-safety-invariants-s9-s13.md) | Safety invariants S9–S13 — content addressing, rotation, reorg |
| [009](https://github.com/s402-protocol/core/blob/main/docs/adr/009-open-gaps-rotation-reorg.md) | Open gaps — known unresolved questions in rotation and reorg |

## Conformance Suite

Every official adapter passes 161 vectors in [`spec/vectors/`](https://github.com/s402-protocol/core/tree/main/spec/vectors). The vectors are language-agnostic JSON — run them against any implementation to verify compliance.

| Category | Vector count | What it tests |
|---|---|---|
| Requirements encode/decode | 24 | Server → Client challenge round-trips |
| Payload encode/decode | 28 | Client → Server payment round-trips |
| Roundtrip (full handshake) | 22 | End-to-end flow for all six schemes |
| Settlement encode/decode | 18 | Settlement response shape and signature |
| Settlement verification | 19 | Facilitator signature validation |
| Receipt format / parse | 16 | Receipt canonicalization |
| Compat normalize | 12 | x402 V1/V2 → s402 translation |
| Validation reject | 14 | Malformed inputs must reject, not silently accept |
| Body transport | 8 | HTTP body edge cases |

Full schema and vector sources: [`spec/canonicalization.md`](https://github.com/s402-protocol/core/blob/main/spec/canonicalization.md) and [`spec/vectors/`](https://github.com/s402-protocol/core/tree/main/spec/vectors).

## Threat Model Summary

The full [THREAT_MODEL](/THREAT_MODEL) covers seven adversary classes. Quick reference:

| Adversary | What they try | s402 mitigation |
|---|---|---|
| **Malicious server** | Over-charge, refuse delivery, forge receipts | On-chain ceiling (Upto), atomic PTB settlement (Sui), arbiter (Escrow) |
| **Malicious client** | Replay, double-spend, forge payloads | Canonical encoding, nonce-based replay protection, on-chain settlement |
| **Malicious facilitator** | Censor, front-run, mis-settle | Direct mode (no facilitator), signed settlement receipts, open facilitator market |
| **Network adversary** | Drop, delay, reorder HTTP | Idempotent settlement by nonce, retry-safe semantics |
| **Chain reorg** | Invalidate settled payments | Finality-depth gating per scheme (S13), documented per-chain thresholds |
| **Compromised key** | Sign unauthorized payments | Key rotation (S12), outstanding receipts survive rotation |
| **Compat layer bugs** | x402/MPP inputs trigger s402 invariant violations | One-way input only (S8), conformance vectors for every compat path |

## Formal Specification Status

- **Wire format**: frozen for v0.5, additive-only for v0.6
- **Scheme semantics**: Exact, Upto, Prepaid, Escrow, Stream frozen; Unlock finalizing for v0.5
- **Canonicalization**: frozen — see [`spec/canonicalization.md`](https://github.com/s402-protocol/core/blob/main/spec/canonicalization.md)
- **IETF Internet-Draft**: `draft-ahn-httpauth-s402-00` in preparation ([DAN-342](https://linear.app/dannydevs/issue/DAN-342))

## Audit Status

| Scope | Status | Auditor |
|---|---|---|
| TypeScript core (`s402`) | Internal review complete; external audit pending | — |
| Move contracts (Sui, per-scheme) | Internal review complete; formal audit required before mainnet | 3-auditor requirement (Swee policy) |
| Compat layers | Under active development | — |
| Facilitator hosted service | Operational; SOC 2 work pending | — |

**No scheme is considered production-safe for non-trivial value until its Move contracts complete formal audit.** The Sui testnet deployment is for integration testing only.

## Bug Bounty

Responsible disclosure: see [SECURITY.md](https://github.com/s402-protocol/core/blob/main/SECURITY.md). Critical protocol-level findings are bountied; contract-level findings on deployed Move code will be covered once bounties are live (tracked with mainnet launch).

## Contributing Research

If you're doing academic or security research on s402:

- **Drafts of findings, PoCs, or papers**: [file an issue](https://github.com/s402-protocol/core/issues) tagged `research`.
- **Private disclosures**: use the channel in [SECURITY.md](https://github.com/s402-protocol/core/blob/main/SECURITY.md).
- **Questions about the formal spec**: GitHub Discussions on [s402-protocol/core](https://github.com/s402-protocol/core/discussions).

## Related Work & Citations

- **x402** (Coinbase, 2025) — [github.com/coinbase/x402](https://github.com/coinbase/x402). The EVM-native prior art; s402's compat layer reads x402 V1 and V2 natively.
- **MPP** (Stripe + Tempo, 2026) — [machinepayments.org](https://machinepayments.org). Multi-rail payment intents for machine commerce; s402 coexists via `Accept-Payment`.
- **AP2** (Google, 2026) — Agent Payments Protocol; s402 supports AP2 mandate delegation as a client credential.
- **RFC 9110** — HTTP Semantics, including the 402 status code reservation.
- **RFC 7231** — HTTP/1.1 Semantics, basis for `Accept-Payment` q-value negotiation.

## Next Steps

- **[Whitepaper](/whitepaper)** — the full academic treatment
- **[Threat Model](/THREAT_MODEL)** — adversarial analysis
- **[Specification](/specification)** — normative wire format
- **[Conformance Vectors](/guide/conformance)** — 161-vector test suite
