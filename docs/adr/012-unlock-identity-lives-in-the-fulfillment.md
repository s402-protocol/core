# ADR-012: The unlock Seal identity lives in the fulfillment, not in requirements

**Status:** Accepted
**Implementation:** shipped
**Force:** invariant
**Date:** 2026-08-16
**Related:** ADR-008 (Safety Invariants S9–S13, S11 unlock attestation), ADR-010 (S15–S16), DAN-860, DAN-598

---

## Context

`main` was red from 2026-07-21 to 2026-08-16 — three and a half weeks — on two conformance
tests. The proximate symptom was `unlock payload requires encryptionId (string), got NoneType`.

The underlying condition was worse than a missing field. The Python and TypeScript
implementations of the *same* scheme had **disjoint requirements field sets — the
intersection was empty**:

| Surface | `unlock` requirements fields |
|---|---|
| `python/src/s402/http.py` | `encryptionId`, `encryptedContentId`, `encryptionServiceId` |
| `typescript/src/types.ts`, `typescript/src/http.ts`, `spec/vectors/` | `packageId`, `keyServers`, `threshold`, `contentDigest` |
| `docs/specification.md` | `encryptionId` et al., marked **Required: Yes** |

A Seal-style threshold key-server model had replaced an `encryptionId` model on 2026-07-20
(recorded in `docs/proposals/REVIEW-NOTES.md` §6b and `DESIGN-unlock-vs-escrow.md`), and it
propagated to the vectors and the TypeScript runtime but not to Python or the written spec.

Three positions were on record, and picking whichever one made CI green would have made a
spec bug permanent.

## Decision

**The Seal threshold key-server model is canonical.** `unlock` requirements carry
`packageId`, `keyServers`, `threshold`, and optional `contentDigest`. The payload carries
`transaction` and `signature` only.

**No identity field appears in requirements or payload.** The Seal identity is
`receiptId ‖ nonce`, where `receiptId` is the object ID of the `UnlockReceipt` minted by
`sweefi::unlock::pay_and_mint`. It travels in the unlock **fulfillment**
(`s402UnlockFulfillment`), returned in `PAYMENT-RESPONSE` after payment.

### The test that settles it, and it is reusable

> **Can the server know this value at the moment it must send it?**

Requirements ship in the `402` response, **before any payment exists**. `packageId`,
`keyServers`, `threshold` and `contentDigest` are all properties of how the seller *already*
encrypted the content, so the server knows them. `receiptId` is the object ID of a receipt
minted by a transaction the **buyer** constructs *in response to* that very 402.

So `encryptionId` in requirements was never merely stale — it was **unsatisfiable by the
party required to populate it**. That is why this is an invariant rather than a preference:
no amount of implementation effort makes the server able to answer.

**State the reason precisely, because the next reader acts on it.** It is *not* that "the
escrow does not exist yet" — under `seal_policy.move`'s escrow-based flow the `escrow_id` is
deterministic from signed TX1 bytes and the seller genuinely can encrypt before release.
`unlock` was rebuilt on 2026-07-20 as a **single-transaction** scheme with no escrow at all;
its anchor is the receipt's own object ID. An agent who goes looking for `escrowId` in the
unlock flow will not find it. (`REVIEW-NOTES.md` contains both statements — §3 item C says
`escrowId‖nonce`, §6b says the receipt's own object ID — and §6b is the later and correct one.)

## Alternatives Considered

- **Add `encryptionId` to the conformance vectors so Python passes.** Rejected, and it is
  explicitly out of scope in DAN-860. The vectors are the contract between implementations;
  editing one to match a single implementation silently re-specifies the protocol for every
  external implementer.
- **Keep `encryptionId` required and have the server mint the receipt first.** Rejected — it
  inverts the payment flow. The buyer would have to pay before receiving requirements.
- **Move `encryptionId` out of requirements into a fulfillment object** (the "third position"
  in `REVIEW-NOTES.md`). **Chosen — and it is not a third position.** It is the Seal model
  with the identity placed where the timeline allows. `s402UnlockFulfillment` already existed
  in `typescript/src/types.ts` when this was written; there were only ever two positions and
  one is falsified.

## Consequences

- **Positive:** `main` goes green (154/154 Python, 1102/1102 TypeScript). All five surfaces
  agree. The wire contract matches the deployed Move module.
- **Positive:** the "can the server know this?" test is reusable at every future scheme
  boundary and is cheaper than re-litigating field placement.
- **Negative:** any external consumer that populated `unlock.encryptionId` in requirements
  breaks. Acceptable — that shape never validated against the published vectors, so no
  conforming implementation can have depended on it.
- **Risk to watch:** `spec/vectors/` is *generated* by
  `typescript/test/conformance/generate-vectors.ts`, which writes vectors by running the
  live `encode`/`decode` functions. Nothing asserts that the tracked vectors still match
  what the current code produces. That check is worth building and is **not** built here —
  `tsx` is not an installed dependency, so it could not be watched green, and an unverified
  gate is worse than an absent one.

  Note what is *not* a risk, because it looks like one: `typescript/test/conformance/vectors/`
  is gitignored build output, produced by `scripts/prepare-publish.sh` copying `spec/vectors/`
  at publish time, and that script hard-fails if the source is missing. It cannot drift — `cp`
  has no opinions — and it is correctly absent from a clean checkout. DAN-860's criterion 4
  reads it as a "stale duplicate ... a trap with no upside"; it is neither stale nor a
  duplicate, and deleting it would strip the vectors from the published npm package.
