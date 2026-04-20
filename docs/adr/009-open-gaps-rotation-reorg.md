# ADR-009: Open Gaps — Facilitator Key Rotation, Chain Reorg Tolerance, Scheme Acceptance Process

**Status:** Placeholder — tracked gaps, not yet resolved
**Date:** 2026-04-19
**Related:** ADR-006, ADR-007, ADR-008, INVARIANTS S8, S11

---

## Context

The /vet review of ADR-006/007/008 surfaced three gaps that are real but out of scope for v0.6.0. Recorded here so they don't get lost.

---

## G1. Facilitator key rotation

**Gap:** S11 (Unlock-TX2 Causal Binding) references `facilitatorPubkey` retrieved from `.well-known/s402-facilitator`. Neither ADR-008 nor the discovery document defines:

- How a facilitator rotates its signing key.
- How a client that cached an old key discovers the new one.
- What happens to attestations signed by a compromised/revoked key.

**Why not solved in v0.6.0:** key rotation requires either (a) a CRL/OCSP-style revocation channel, or (b) a JWKS-style rotating set with overlap windows, or (c) an external trust root (Sigstore/root-of-trust transparency log). Each option has nontrivial operational cost. v0.6.0 assumes a single long-lived key per facilitator.

**Interim mitigation:** facilitators SHOULD publish `keyValidFrom` + `keyValidUntil` in their discovery document. Clients MUST reject attestations signed outside the validity window.

**Target:** v0.7.0 (paired with MCP registry listing and public key ceremony).

---

## G2. Chain reorganization tolerance

**Gap:** s402 envelopes claim `status: "settled"` once a transaction is broadcast and its digest observed. On chains where "settled" means "in the mempool + one confirmation" (e.g., EVM pre-merge days), a reorg could unsettle a payment that s402 already reported as settled.

Sui has fast finality (~2-3 seconds to checkpoint), so this is a small window — but the protocol doesn't formally commit to a finality threshold. A future chain adapter on an eventually-consistent chain would have no guidance.

**Why not solved in v0.6.0:** defining "finality" is chain-specific. s402 cannot decree it without making chain assumptions, which violates S7 (Chain-Agnostic Surface).

**Interim mitigation:** each chain adapter MUST document in its README the finality threshold its `/settle` endpoint commits to (e.g., `@sweefi/sui`: "settled = checkpoint-included, observed on 2 nodes"). Envelope `settledAt` is the observation time, not finalization time.

**Target:** ADR-012 when the second chain adapter ships (Solana or EVM).

---

## G3. Acceptance process for scheme #6 and beyond

**Gap:** S3 (Five Irreducible Payment Schemes) proves the current five are structurally irreducible. But the ecosystem may need a sixth scheme (Lightning invoice? EIP-7702 batched? Intent-auctions?). There is no documented acceptance process.

**Why not solved in v0.6.0:** a formal acceptance process is governance work. DNA of s402 is "take what MPP/x402/A2A do well, improve" — a governance model should emerge from usage, not be imposed preemptively.

**Interim mitigation:** scheme proposals go through a two-stage review: (1) community RFC via GitHub Discussion (minimum 30-day comment window), (2) S3 irreducibility proof obligation before acceptance. Proposals that decompose into existing schemes are rejected; proposals that genuinely expand the scheme space are accepted with a new content-hash and a `amends: null` entry in their history.

**Target:** v0.7.0 or later, when a concrete sixth-scheme proposal motivates a formal process.

---

## Consequences

- Gaps are explicit; v0.6.0 ship does not silently assume them away.
- Threat model (`docs/THREAT_MODEL.md`) G1-G5 refer to this ADR for rotation/reorg/acceptance context.
- Implementers of non-Sui adapters or alternative facilitators know what they're inheriting.

---

## References

- ADR-008 S11 (Unlock-TX2 attestation — depends on G1)
- ADR-007 envelope `settled` status (depends on G2)
- ADR-006 scheme amendment chain (sibling to G3)
- INVARIANTS.md S3, S7, S8
