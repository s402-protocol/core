# ADR-003: `upto` Scheme — Usage-Based Payments with Settlement Overrides

**Status:** Accepted (implemented — see note)
**Implementation:** shipped
**Date:** 2026-04-12
**Supersedes:** (none)
**Linear:** DAN-284

> **Status note (2026-07-02):** the `upto` scheme designed here SHIPPED in `s402` v0.5.0 (2026-04-12) — including `estimatedAmount` and the client-chosen `settlementCeiling` (see `typescript/CHANGELOG.md` §0.5.0, DAN-284). The "Proposed" status was never updated after implementation. ADR body below is preserved as written.

## Context

x402 shipped an `upto` scheme in v2: the client authorizes a **maximum** amount; the actual charge is determined at settlement time by the resource server based on resource consumption. Use cases: LLM token billing, bandwidth metering, dynamic compute pricing, search-result-dependent API fees.

s402 currently has five payment schemes (exact, stream, escrow, unlock, prepaid). ADR-001 Decision 3 requires formal proof that a sixth scheme is irreducible before it can be added. This ADR provides that proof and designs an `upto` scheme that fixes five identified design flaws in x402's implementation.

### Why this matters for the AI Engineer talk

The `upto` scheme is **the** payment primitive for AI agent services. When an agent calls Claude's API, it doesn't know the final token count until the response completes. When an agent queries a vector database, cost depends on result set size. Every usage-based API in the AI ecosystem needs this primitive. s402 without `upto` is a payment protocol that can't handle the most common AI payment pattern.

### x402's implementation (reference)

x402 uses EVM's Permit2 for upto on Ethereum:
- Client signs a Permit2 `permitWitnessTransferFrom` with `permitted.amount` = max
- A dedicated `x402UptoPermit2Proxy` contract enforces `actualAmount <= permitted.amount`
- `SettlementOverrides` determines the actual amount (supports raw units, percent, dollar price)
- The `witness.facilitator` field binds authorization to a specific facilitator

### x402's design flaws (confirmed by code analysis)

| # | Flaw | Impact |
|---|------|--------|
| **F1** | **Trust gap** — client has no on-chain guarantee of fair charging. x402's own spec says "clients trust that servers will charge fair amounts." | Malicious server charges max regardless of usage. |
| **F2** | **Semantic overload** — `amount` means max during verify, actual during settle. Facilitator has to swap `requirements.amount` back to `permitted.amount` for re-verification. | Fragile code, easy to introduce bugs. |
| **F3** | **No receipt of actual usage** — the client that signed the authorization never sees what it was charged. `SettleResponse` goes to the resource server, not the payer. | Agent can't audit its own spending. |
| **F4** | **Zero settlement doesn't consume nonce** — if `actual = 0`, no on-chain tx fires. The Permit2 authorization stays valid until deadline. | Compromised facilitator can settle non-zero later. |
| **F5** | **No multi-settlement** — each authorization is single-use. LLM streaming needs a new signature per chunk. | High overhead for the primary use case. |

## Decision

### Decision 1 — `upto` is a sixth irreducible scheme

**The four-test proof (per ADR-001 Decision 3):**

**Test 1: Cannot be expressed as a composition of existing five.**

| Existing scheme | Why upto ≠ this scheme |
|----------------|----------------------|
| exact | Fixed amount at sign-time. Upto's amount is variable at settle-time. |
| prepaid | Multi-claim lifecycle (deposit → claim → claim → withdraw). Upto is single-settlement. |
| stream | Time-based ticks (open → tick → tick → close). Upto is event-triggered, not time-driven. |
| escrow | **Trust model mismatch.** Escrow uses three-party dispute resolution (buyer/seller/arbiter). Upto uses two-party facilitator settlement (payer/server, facilitator as trusted settler). There is no arbiter, no dispute state, no conditional release. Even if escrow gained a `settle_partial()` entry point (currently absent — escrow.move line 23), the authorization model is fundamentally different: escrow requires `arbiter != seller != buyer`; upto delegates settlement authority to a bound facilitator address. |
| unlock | Entangled with encryption key servers and two-stage TX flow. Upto has no encryption component. |

No composition of these produces the upto lifecycle. The critical distinction is the **trust model**, not just the mechanics: upto delegates variable-amount settlement to a facilitator without arbiter mediation — a pattern no existing scheme supports, alone or in combination.

**Test 2: Cannot be expressed as an extension of an existing scheme.**

The closest candidate is escrow + a "partial release" extension. Analysis:

- **Even with `settle_partial()` added to escrow**, the trust model remains wrong. Escrow's authorization flows through buyer→arbiter→seller. Upto's flows through payer→facilitator→payTo. The facilitator determines the actual amount autonomously (based on server-reported usage), while an arbiter resolves disputes between two parties. These are categorically different authorization patterns.
- Escrow requires `arbiter != seller != buyer` (enforced on-chain). Upto has no arbiter — attempting to use escrow with a "dummy arbiter" set to the facilitator address would violate escrow's own invariants and corrupt its state machine.
- Encoding variable settlement in `extensions` would mean every facilitator implementation must understand the extension to function correctly — that's not an extension, that's a scheme.

**Test 3: Unique on-chain object lifecycle.**

```
UptoDeposit shared object:
  deposit(max, payer, payTo, deadline) → DEPOSITED
  DEPOSITED → settle(actual ≤ max)   → SETTLED  (actual → payTo, remainder → payer)
  DEPOSITED → cancel()               → CANCELLED (full refund → payer, nonce consumed)
  DEPOSITED → expire(after deadline)  → EXPIRED  (full refund → payer)
```

Three terminal states (SETTLED, CANCELLED, EXPIRED), each with distinct fund distribution. No other scheme's on-chain object has this lifecycle.

**Test 4: Production use case.**

| Use case | Why exact/escrow/stream won't work |
|----------|-----------------------------------|
| LLM token billing (Claude API, GPT-4) | Token count unknown until completion. Can't use exact (fixed). Can't use stream (not time-based — a 100-token response takes the same time as a 10K-token response). |
| Bandwidth metering | Transfer size unknown until complete. |
| Search-result-dependent pricing | Cost depends on result quality/count, determined server-side after query execution. |
| Dynamic compute pricing | GPU time varies by workload complexity. |

All four tests pass. `upto` is promoted to s402's sixth scheme. ∎

### Decision 2 — Wire format: distinct `maxAmount` and `actualAmount`

s402 fixes x402's semantic overload by using separate fields:

**Requirements (server → client):**

```typescript
interface s402UptoExtra {
  /** Maximum amount the client authorizes (in base units). 
   *  Server charges ≤ this. */
  maxAmount: string;
  /** Settlement deadline (Unix timestamp ms). Authorization expires after this. */
  settlementDeadlineMs: string;
  /** URL where actual usage amount will be determined (optional — 
   *  facilitator uses this to query the server for the final charge). */
  usageReportUrl?: string;
}
```

The `requirements.amount` field is set to `maxAmount` for x402 compatibility (an x402 client sees it as a normal `exact` payment at the max price). The `upto.maxAmount` field is the s402-native way to express the cap.

**Payload (client → facilitator):**

```typescript
interface s402UptoPayload extends s402PaymentPayloadBase {
  scheme: 'upto';
  payload: {
    /** Base64-encoded deposit transaction (deposits max into UptoDeposit proxy) */
    transaction: string;
    /** Client's signature */
    signature: string;
    /** Max authorized amount (echoed from requirements for facilitator cross-check) */
    maxAmount: string;
  };
}
```

**SettleResponse additions:**

```typescript
// Added to s402SettleResponse (all fields optional, present only for upto):
{
  /** Actual amount charged (base units). Always ≤ maxAmount. */
  actualAmount?: string;
  /** UptoDeposit object ID on-chain */
  depositId?: string;
}
```

**SettlementOverrides (new concept):**

```typescript
/** Provided by the resource server to the facilitator at settle-time */
interface s402SettlementOverrides {
  /** Actual amount to charge (base units). Must be ≤ maxAmount. */
  actualAmount: string;
}
```

Unlike x402, s402 does NOT support percent or dollar-price formats in `SettlementOverrides`. The server knows the actual amount in base units — forcing a single canonical format eliminates x402's inconsistent rounding (floor for percent, round for dollars) and keeps the facilitator implementation simple.

**Threading SettlementOverrides through the facilitator (architectural decision):**

The current `s402FacilitatorScheme.settle()` signature is `(payload, requirements) → SettleResponse`. Adding a third parameter would be a breaking change to the scheme interface. Instead, overrides are threaded via an optional field on requirements:

```typescript
// Added to s402PaymentRequirements:
settlementOverrides?: s402SettlementOverrides;
```

The resource server populates `requirements.settlementOverrides` before calling `facilitator.settle()`. The upto facilitator scheme reads `requirements.settlementOverrides.actualAmount`; all other schemes ignore it. This keeps the `s402FacilitatorScheme` interface stable at two parameters.

**Runtime validation gates (must update simultaneously):**

Three hardcoded validation gates in `http.ts` will reject upto payloads if not updated:
1. `VALID_SCHEMES` — must include `'upto'`
2. `S402_PAYLOAD_INNER_KEYS` — must include `upto`-specific inner keys (`maxAmount`)
3. `S402_SETTLE_RESPONSE_KEYS` — must include `actualAmount`, `depositId`

These are runtime validation gates, not just type definitions. They must be updated in the same commit as the type changes.

### Decision 3 — Fix the trust gap with Move events

x402's trust gap: the client has NO on-chain proof of fair charging.

s402's improvement: the `upto.move` module emits typed events at every lifecycle transition:

```move
struct UptoCreated has copy, drop {
    deposit_id: ID, payer: address, pay_to: address, facilitator: address,
    max_amount: u64, deadline_ms: u64, fee_micro_pct: u64,
    coin_type: ascii::String, timestamp_ms: u64,
}

struct UptoSettled has copy, drop {
    deposit_id: ID, payer: address, pay_to: address,
    max_amount: u64, actual_amount: u64, fee_amount: u64,
    remainder_returned: u64, settled_by: address,
    coin_type: ascii::String, timestamp_ms: u64,
}

struct UptoCancelled has copy, drop {
    deposit_id: ID, payer: address, max_amount: u64,
    cancelled_by: address, coin_type: ascii::String, timestamp_ms: u64,
}

struct UptoExpired has copy, drop {
    deposit_id: ID, payer: address, max_amount: u64,
    expired_by: address, coin_type: ascii::String, timestamp_ms: u64,
}
```

Any client (or auditor) can query Sui's event API to verify:
1. The actual charge matches what the server reported
2. The remainder was returned to the payer
3. `actual_amount + fee_amount + remainder_returned == max_amount` (conservation invariant)

**Honest assessment**: Events provide **observability**, not **prevention**. If the facilitator overcharges, the damage is done when the event is emitted — the money has already moved. The mitigation is that events create a verifiable audit trail: agents can detect overcharging post-hoc and switch facilitators. This is analogous to credit card dispute resolution — you can't prevent a malicious merchant from overcharging, but you can detect and remedy it. This is still meaningfully better than x402, where there is no verifiable audit trail at all.

### Decision 4 — Zero settlement MUST consume the deposit

x402's flaw: zero settlement leaves the Permit2 nonce alive. A compromised facilitator can settle later.

s402's fix: when `actualAmount = 0`, the facilitator MUST call `cancel()` on the UptoDeposit. This:
1. Returns the full deposit to the payer
2. Transitions the deposit to CANCELLED (terminal state)
3. Emits an `UptoCancelled` event
4. Makes the deposit unusable for future settlement

There is no "silent zero settlement" path. Every authorization results in an on-chain state transition.

**Gas cost tradeoff:** `cancel()` costs ~0.003-0.01 SUI in gas (~$0.003-$0.01 at current prices). x402 skips the on-chain tx for zero settlement to save gas. We accept this cost because: (a) the security benefit (nonce consumption) outweighs the gas cost for any non-trivial payment; (b) Sui's low gas makes this a fraction of a cent; (c) zero settlement should be the exception (the server usually charges *something*), so this cost is amortized across many non-zero settlements.

### Decision 5 — Single settlement per authorization (by design)

x402's multi-settlement limitation is acknowledged but NOT fixed. Rationale:

- **Stream already handles continuous payment.** An agent consuming an API continuously should use `stream`, not repeated `upto` authorizations.
- **Upto handles "I don't know the final bill."** A single LLM completion, a single search query, a single compute job. The agent signs once, gets charged once, done.
- **Multi-settlement adds complexity with marginal benefit.** It requires partial-state tracking, re-verification of remaining authorization, and race-condition handling between concurrent settlements. The stream scheme already solves this with a cleaner model (time-based ticks).

Upto and stream are complementary: upto for discrete jobs, stream for continuous access.

**Acknowledged gap: discrete batch jobs.** An agent running a 5-step pipeline (plan → retrieve → generate → verify → summarize) with unpredictable per-step cost wants ONE authorization for all 5 steps. Neither upto (single settlement) nor stream (time-based) handles this cleanly. Three options for this pattern:
- **Upto with generous max:** Authorize the maximum possible total, settle for the actual total after all steps complete. Simple but capital-inefficient if the max is much larger than actual.
- **Prepaid deposit:** Use prepaid with a deposit, provider claims after each step. More gas (5 claims vs 1 settlement) but per-step visibility.
- **Future: batch-upto variant.** If the pattern becomes dominant, a multi-settlement variant of upto could be designed (deposit max → settle partial → settle partial → finalize). Deferred to v2 — requires partial-state tracking and re-verification of remaining authorization. The `extensions` field can prototype this (per ADR-001 Decision 4's graduation path).

### Decision 6 — Sui implementation via dedicated Move module

On Sui, the upto scheme uses a dedicated `upto.move` module (NOT a modification of `escrow.move`):

**Why not extend escrow?**
- Escrow's state machine (ACTIVE → DISPUTED → RELEASED/REFUNDED) is purpose-built for three-party dispute resolution. Adding partial settlement would require a new state (`PARTIALLY_SETTLED`?), new authorization rules, and a different fee model — essentially a second module inside escrow.
- Escrow's arbiter constraint (`arbiter != seller != buyer`) doesn't apply to upto.
- Mixing two lifecycles in one module violates the irreducibility proof — if upto and escrow share a module, they're not independent.

**Module design:**

```move
module sweefi::upto {
    /// UptoDeposit — shared object. Holds the max deposit until settlement.
    /// All terminal functions (settle, cancel, expire) consume by value
    /// and delete the UID — no zombie objects left on-chain.
    struct UptoDeposit<phantom T> has key {
        id: UID,
        payer: address,
        pay_to: address,
        facilitator: address,    // bound at creation, only this address can settle
        max_amount: u64,
        balance: Balance<T>,
        deadline_ms: u64,
        fee_micro_pct: u64,
        fee_recipient: address,
    }

    /// Minimum deposit: 1,000,000 base units (0.001 SUI / 1 USDC).
    /// Prevents dust-deposit spam creating near-empty shared objects.
    const MIN_DEPOSIT: u64 = 1_000_000;

    /// Create a deposit. Called by the payer via PTB.
    /// Enforces: not paused, min deposit, payer != pay_to, payer != facilitator,
    /// deadline in future.
    public fun create<T>(coin: Coin<T>, pay_to: address, facilitator: address,
                         deadline_ms: u64, fee_micro_pct: u64, fee_recipient: address,
                         protocol_state: &admin::ProtocolState,
                         clock: &Clock, ctx: &mut TxContext): UptoDeposit<T>;

    /// Settle at the actual amount. Consumes the deposit by value.
    /// Enforces: ctx.sender() == facilitator, actual <= max, not expired.
    /// Fee = math::calculate_fee(actual_amount, fee_micro_pct).
    /// Remainder = max_amount - actual_amount - fee (absorbs rounding dust).
    /// Sends: actual - fee → pay_to, fee → fee_recipient, remainder → payer.
    /// Emits UptoSettled. Deletes the UID.
    public fun settle<T>(deposit: UptoDeposit<T>, actual_amount: u64,
                         clock: &Clock, ctx: &mut TxContext);

    /// Cancel (zero settlement). Consumes by value.
    /// Enforces: ctx.sender() == facilitator OR ctx.sender() == payer.
    /// Returns full deposit to payer. No fee. Emits UptoCancelled. Deletes UID.
    public fun cancel<T>(deposit: UptoDeposit<T>, clock: &Clock,
                         ctx: &mut TxContext);

    /// Permissionless timeout refund. Consumes by value.
    /// Anyone can call after deadline. Full refund to payer. No fee.
    /// Emits UptoExpired. Deletes UID.
    public fun expire<T>(deposit: UptoDeposit<T>, clock: &Clock,
                         ctx: &mut TxContext);
}
```

**Key design decisions from council review:**

1. **Consume by value, not `&mut`.** All terminal functions take `deposit: UptoDeposit<T>` (by value), destructure it, and call `id.delete()`. This prevents zombie shared objects lingering on-chain in terminal states. Follows the escrow pattern (`release` and `refund` both consume by value).

2. **Explicit `facilitator` field (Option B).** The facilitator address is bound at creation time. `settle()` asserts `ctx.sender() == deposit.facilitator`. Prevents fee_recipient address reuse from accidentally granting settle rights. **Limitation:** If the facilitator goes down, the deposit is locked until deadline expiry. Mitigation: short deadlines (minutes, not days) and the `cancel()` escape hatch (payer can cancel anytime).

3. **ProtocolState pause guard.** `create()` takes `protocol_state: &admin::ProtocolState` and calls `assert_not_paused()`. Only guards creation — withdrawals (settle, cancel, expire) are never blocked, following the two-tier guard design in admin.move.

4. **Address guards.** `create()` enforces `payer != pay_to` (same-party payment is meaningless) and `payer != facilitator` (self-dealing vector).

5. **Fee on `actual_amount`, not `max_amount`.** The facilitator earns proportionally to what was actually settled. The payer doesn't pay fees on money returned to them. Remainder absorbs rounding dust (at most 1 base unit) — computed as `max - actual - fee`, not independently calculated. Conservation invariant holds by construction.

### Decision 7 — `s402Scheme` type expansion

The `s402Scheme` union type becomes:

```typescript
export type s402Scheme = 'exact' | 'stream' | 'escrow' | 'unlock' | 'prepaid' | 'upto';
```

**S3 invariant update:** The proof in INVARIANTS.md gains a sixth row:

```
upto:    UptoDeposit shared object with variable settlement.
         Requires: deposit(max) → settle(actual ≤ max) → done
         Cannot be exact (variable amount at settle-time).
         Cannot be prepaid (single-settlement, not multi-claim).
         Cannot be stream (event-triggered, not time-driven).
         Cannot be escrow (continuous outcome, no arbiter, no dispute).
         Cannot be unlock (no encryption component).
```

**Backward compatibility:** Existing s402 clients that don't understand `upto` will ignore it in `requirements.accepts` and fall through to `exact` (which is always present per the x402 compat rule). **Sharp edge:** falling through to `exact` means the client pays `maxAmount` (the full cap), not the actual usage amount. This is silent overpayment, not graceful degradation. Servers SHOULD set `amount` (the x402-compat field) to a reasonable value for exact-scheme fallback, separate from `upto.maxAmount`. Agents SHOULD log a warning when falling back from `upto` to `exact`.

## Alternatives Considered

**Alt A — Express upto as an extension of `exact` with a settlement override field.**
Rejected. The on-chain mechanism is fundamentally different: exact is an atomic transfer of a fixed amount. Upto requires depositing into a proxy object and having the server determine the final amount. The client signs a different transaction (deposit into proxy vs direct transfer). An extension that changes the on-chain mechanism isn't an extension — it's a scheme.

**Alt B — Add `settle_partial()` to the existing escrow Move module.**
Rejected. Escrow's state machine (ACTIVE → DISPUTED → RELEASED/REFUNDED) is purpose-built for three-party dispute resolution with binary outcomes. Adding partial settlement would require new states, new authorization paths, and would contaminate escrow's clean lifecycle. The irreducibility proof requires independent on-chain objects.

**Alt C — Use `prepaid` with `maxCalls: "1"` as a single-use variable-amount payment.**
Rejected. Prepaid's lifecycle is deposit → claim → claim → withdraw. Even with maxCalls=1, the provider must submit a claim (provider-initiated). In upto, settlement is facilitator-initiated with a server-reported amount. The trust model and data flow are different.

**Alt D — Support multi-settlement (x402's acknowledged gap).**
Rejected for v1. Multi-settlement adds partial-state tracking, re-verification of remaining authorization, and race conditions between concurrent settlements. The `stream` scheme already handles continuous payment with a cleaner time-based model. Upto handles discrete jobs; stream handles continuous access. They're complementary.

**Alt E — Support percent and dollar-price formats in SettlementOverrides.**
Rejected. x402 supports `"50%"`, `"$0.05"`, and raw units in the same field, leading to inconsistent rounding (floor for percent, Math.round for dollars). s402 requires base units only. The server knows the exact amount — there's no reason to make the facilitator do unit conversion.

**Alt F — Name it `metered` or `usage` instead of `upto`.**
Rejected. `upto` matches x402's naming for migration familiarity. It describes the mechanism (up to a maximum) rather than the use case, consistent with s402's other scheme names (exact, stream, escrow, unlock, prepaid).

## Consequences

**Positive:**
- s402 gains the payment primitive most needed for AI agent services — usage-based billing.
- All five x402 design flaws are fixed: distinct field names, on-chain verifiability, mandatory nonce consumption, actual amount in settle response.
- The Move module is simple (~150 lines) with a 3-state lifecycle. Easy to audit.
- Backward compatible: existing clients fall through to `exact`.

**Negative:**
- S3 invariant proof must be updated (five → six schemes). The proof structure is designed for this (per ADR-001 Decision 3's graduation path).
- A new Move module must be audited before mainnet deployment.
- Conformance test vectors must be generated for the new scheme.
- The "five irreducible primitives" marketing story becomes "six." Less elegant, but more complete.

**Risks & watch-fors:**
- **Facilitator as trusted settler.** The server reports actual usage to the facilitator, which settles on-chain. A colluding server+facilitator can overcharge. Mitigation: Move events provide an audit trail, and clients can switch facilitators. This is the same trust model as credit cards (merchant + acquirer vs cardholder).
- **Deposit lockup period.** Max amount is locked in the UptoDeposit until settlement or deadline. For large max amounts, this is capital-inefficient. Mitigation: servers should set realistic max amounts and short deadlines.
- **`settle()` access control.** If the facilitator key is compromised, the attacker can settle any active deposit for any amount up to max. Mitigation: short deadlines + monitoring + the cancel() escape hatch.

## Implementation Plan

| Step | Where | What |
|------|-------|------|
| 1 | `s402/typescript/src/types.ts` | Add `'upto'` to `s402Scheme`, add `s402UptoExtra`, `s402UptoPayload`, update `s402SettleResponse`, add `s402SettlementOverrides` |
| 2 | `s402/typescript/src/scheme.ts` | Add `upto?` config block to `s402RouteConfig` |
| 3 | `s402/INVARIANTS.md` | Update S3 proof with sixth scheme row |
| 4 | `s402/spec/vectors/` | Generate conformance test vectors for upto |
| 5 | `sweefi/contracts/sources/upto.move` | Implement Move module |
| 6 | `sweefi/packages/sui/src/s402/upto/` | Implement `UptoSuiClientScheme`, `UptoSuiFacilitatorScheme`, `UptoSuiServerScheme` |
| 7 | `sweefi/packages/sui/` | Tests, typecheck, verify S7 boundary |

## Follow-ups

- [ ] Implement types in s402 core (step 1-2)
- [ ] Update S3 proof in INVARIANTS.md (step 3)
- [ ] Write upto.move (step 5)
- [ ] Implement SweeFi adapters (step 6)
- [ ] Generate conformance vectors (step 4)
- [ ] Add `upto` to the s402-protocol.org docs site
- [ ] Add `upto` to the pre-rejected proposals table in ADR-001 for proposals that decompose into upto (e.g., "dynamic pricing" = upto, "usage billing" = upto)
- [ ] Consider whether `usageReportUrl` should be a first-class protocol field or an extension
