# EVIDENCE — DAN-591 s402 reanalysis (2026-07-19, night shift)

Branch `agent/dan-591` off `930787b`. Worktree `/Users/dannydevs/swee/wt/dan-591-s402`.

## What changed

- **New:** `docs/REANALYSIS-2026-07.md` — the ticket deliverable (verdict block, ranked bug inventory, x402/MPP drift matrix, per-scheme verdicts, up-stack table, drift-script status).
- **No source code changed.** This ticket's deliverable is a severity-classified inventory + drift analysis; fixing the findings is a future ticket (hard limit: do not chain into fixes).
- **`bin/check-x402-mpp-drift.sh` NOT modified** — see "Drift script" below; it lives in `~/sweeos`, a different repo I am forbidden to write to.

## Verification output

### s402 test suite — GREEN (found the real command via AGENTS.md)

```
# typescript/ (reference impl) — pnpm run typecheck && pnpm run test
> tsc --noEmit                         # clean
 Test Files  28 passed (28)
      Tests  1098 passed (1098)
   Duration  20.60s
```

```
# server-ts/ (@sweefi/server middleware) — pnpm run test
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

**Pre-existing harness note (not caused by me):** `server-ts` tests fail with
`Failed to resolve entry for package "s402"` on a cold checkout because the
`s402` workspace dependency has no built `dist/`. This predates this branch
(the worktree is a fresh `pnpm install` at `930787b`, untouched source). Fix is
to build the dep first:

```
cd typescript && pnpm run build      # ✔ 23 files, 265 kB
cd ../server-ts && pnpm run test     # → 18 passed
```

After building `s402`, the full suite is green. The failure is build-ordering,
not a code defect, and is out of scope for this ticket. (No `pnpm -r build`
wired at repo root; worth a root script — noted, not fixed.)

Python conformance suite not run (no funds-relevant delta expected; the TS
reference is authoritative and green). Flagged as a deliberate omission below.

### F1 repro — x402 non-exact scheme silently coerced to `exact` (CONFIRMED)

Temporary vitest (removed after run) against `src/compat/x402.js`:

```
stdout | F1 non-exact x402 scheme coerced to exact
F1 requirements.accepts = ["exact"]  <- input scheme "auth-capture"
F1 payload.scheme       = "exact"    <- input scheme "batch-settlement"
 ✓ test/zz-repro591.test.ts (1 test)
```

i.e. `fromX402Requirements({scheme:'auth-capture', …})` returns `accepts:['exact']`
and `fromX402Payload({scheme:'batch-settlement', …})` returns `scheme:'exact'`.
`auth-capture` and `batch-settlement` are both **shipped upstream x402 schemes**
(see drift matrix). Repro file was deleted; the behavior is also enshrined by the
existing `test/security-hardening.test.ts` case "normalizes non-exact scheme to
exact (x402 only supports exact)" — a test whose premise is now false.

### F2 / F3 — traced, not reproduced (client-side / cache-internal, no tx)

- F2: `src/envelope.ts:12-15` claims 8 checks; `verifyEnvelope` (`:372-435`)
  implements 6; ADR-007 check 5 references `requirements.resource`, which does
  not exist in the wire format (`docs/specification.md` §4.1/4.2, `src/types.ts`).
  Up-stack confirmation: `~/swee/sweeai/verticals/sweefi/sui/src/s402/unlock/client.ts:93-100`
  defers the TX2 attestation with a code comment.
- F3: `src/facilitator.ts:316` uses `JSON.stringify(payload)` vs ADR-007 §idempotency
  ("canonical field ordering per canonicalization.md §4").

## Web scans (delta vs 2026-07-18 intel brief)

Two background research agents (x402, MPP), web-read-only. Full sourced findings
folded into the drift matrix in `docs/REANALYSIS-2026-07.md` §2. Key facts:
x402 HEAD `67b1ba0a` and mpp-specs HEAD `55045e5e` both unchanged since the brief;
x402 is a 4-scheme family (exact/upto/auth-capture/batch-settlement) on ~11 chains;
Cloudflare has its own `cloudflare:402` scheme + AWS x402 is GA; a live 37-file
Sui impl PR (#2616, non-Mysten) is open as of today.

## Drift script

`bin/check-x402-mpp-drift.sh` is at `~/sweeos/bin/`, **not in this repo**. I did
NOT fork it into the worktree (Curry doctrine: never fork cathedral state; Tier-1:
never touch other repos) and did NOT execute it (it `git fetch`es the external
forks and writes a dated report — both mutate sweeos). Reviewed its pinned
assumptions: one is stale — the x402 `typescript/packages/mechanisms/src` glob
misses per-chain mechanism packages. Proposed one-line patch is in
`REANALYSIS-2026-07.md` §5 for Danny to apply in sweeos. Baselines deliberately
left un-`--accept`ed (tripwire stays red pending the 0.9.0 compat audit).

## What I deliberately did NOT do

- Did not fix any finding (severity-inventory is the deliverable; fixes are a
  future ticket — explicit hard limit).
- Did not modify or run the drift script (lives in another repo; running mutates it).
- Did not write to `~/swee/sweeai` (up-stack notes are read-only observations).
- Did not run the Python conformance suite (TS reference is authoritative + green;
  no funds-relevant delta expected).
- No push / PR / publish / external comms. Web reads only.

## Open questions for Danny

1. **F2 resource-binding home:** add a `resource` field to the s402 wire format so
   ADR-007 check 5 is enforceable at the protocol layer, OR formally move it to the
   SDK layer (tracked-intent) and downgrade the ADR's "MUST at protocol layer"? The
   spec currently promises a defense the wire format can't express.
2. **`split` scheme:** x402 `batch-settlement` (one settlement → many recipients,
   ~11 chains) pre-empts the fan-out idea. Kill `split` as a novel primitive and
   interop with batch-settlement, or is there a PTB-atomic split it can't do?
3. **Sui-bridge timing:** x402 Sui impl PR #2616 is live today (non-Mysten author).
   Does the "x402↔Sui bridge author" play still matter enough to move on it this
   week, given it feeds the competitor's ecosystem story? (External PR = human gate.)
4. **Compat scope (F1 fix):** reject non-exact x402 outright, or ship an explicit
   auth-capture→escrow / upto→upto mapping? The latter is more interop but more
   surface to keep in sync with upstream.
