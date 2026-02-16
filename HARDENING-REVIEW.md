# s402 Hardening Review — Pre-npm-publish Audit

**Date**: 2026-02-15
**Reviewer**: Bug-hunter agent (automated code review)
**Scope**: All 9 source files, 7 test files, package.json, tsconfig, dist/ output, README, AGENTS.md, LICENSE
**Tests**: 207/207 passing, typecheck clean
**Updated**: 2026-02-15 — marked resolved items after hardening pass

---

## CRITICAL (must fix before publish)

### C1. `isValidAmount` export inconsistency

**File**: `src/index.ts` + `src/http.ts` (line 134)

`isValidAmount` is exported from `http.ts`, so it shows up in the `s402/http` sub-path export. But it is NOT re-exported from `index.ts`. Users who import from `s402/http` see it; users who import from `s402` do not.

**Fix**: Either explicitly export from `index.ts`, or un-export from `http.ts` and keep it internal.

### C2. ~~`normalizeRequirements` returns raw untrusted object~~ RESOLVED

**Fixed**: `normalizeRequirements` now calls `pickRequirementsFields()` from `http.ts` (canonical key allowlist). Additionally, `normalizeRequirements` is no longer in the client hot path — `createPayment()` accepts typed `s402PaymentRequirements` only. Compat is opt-in via `s402/compat`.

### C3. Missing CJS `require` export condition in package.json

**File**: `package.json` (exports map)

The exports only have `"import"` and `"default"` conditions. The `"default"` points to `.mjs`. Some toolchains (Jest default, older bundlers, ts-node without ESM) try `"require"` first, fail, fall back to `"default"` `.mjs`, and choke.

**Fix**: Either add `"require": null` for clarity, or accept ESM-only (already documented in README). The ambiguity with `"default"` is the concern.

---

## HIGH (should fix)

### H1. ~~`decodePaymentRequired` does not normalize — x402 compat claim is broken~~ RESOLVED (by design)

`decodePaymentRequired` is the s402-only wire decoder. x402 input must go through `normalizeRequirements()` from `s402/compat` first. This is correct now that compat is opt-in — the core protocol validates s402 format only.

### H2. ~~No validation of payload inner fields (transaction, signature)~~ RESOLVED

**Fixed**: `validatePayloadShape` now validates `payload.transaction` and `payload.signature` are strings, plus scheme-specific fields (unlock `encryptionId`, prepaid `ratePerCall`).

### H3. ~~`buildRequirements` does not validate `price`~~ RESOLVED

**Fixed**: `buildRequirements` now validates `config.price` with `isValidAmount()` before copying to `requirements.amount`.

### H4. ~~No `protocolFeeBps` range validation~~ RESOLVED

**Fixed**: Both `validateRequirementsShape` (http.ts) and `validateX402Shape` (compat.ts) now validate `protocolFeeBps` is a finite number between 0 and 10000.

### H5. ~~Empty `accepts` array is not rejected~~ RESOLVED

**Fixed**: `validateRequirementsShape` now rejects empty `accepts` arrays.

### H6. ~~`expiresAt` comparison is type-unsafe~~ RESOLVED

**Fixed**: `facilitator.ts` now has a type defense `typeof expiresAt === 'number' && Number.isFinite(expiresAt)` before the comparison. Additionally, `validateRequirementsShape` validates `expiresAt` is a finite number at the wire decode boundary.

### H7. Bundle awareness (not a bug)

`scheme.ts`, `client.ts`, `server.ts`, `facilitator.ts` are NOT separate entry points — all bundled into `index.mjs`. Importing `s402` pulls everything (~8KB). Acceptable for v0.1.

---

## MEDIUM (nice to fix)

### M1. `accepts` type/runtime mismatch
Type is `s402Scheme[]` but runtime allows unknown strings (Postel's Law). Consider `(s402Scheme | string)[]`.

### M2. `toBase64` O(n^2) string concatenation
Loop concat in `http.ts`. Use `Array.from(bytes, b => String.fromCharCode(b)).join('')` for O(n).

### M3. `MAX_HEADER_BYTES` checks char count, not bytes
Fine for base64 ASCII, but variable name is misleading.

### M4. `s402Error` does not set `Error.cause`
Loses original stack traces on rethrows. Add optional `cause` param (ES2022+).

### M5. `fromX402Requirements` skips validation when called directly
Only validates amount; `network`, `asset`, `payTo` could be undefined.

### M6. ~~`s402Client.createPayment` re-validates typed input~~ RESOLVED
`createPayment()` now accepts typed `s402PaymentRequirements` only — no more `normalizeRequirements()` on every call. Compat is opt-in.

### M7. README discovery example missing `"prepaid"`
Shows `["exact", "stream", "escrow"]` — should include `"prepaid"` and `"unlock"`.

---

## LOW (cosmetic)

- **L1**: AGENTS.md says 112 tests, should be 135
- **L2**: `"files"` whitelist is correct (no `.npmignore` needed)
- **L3**: `skipLibCheck: true` — fine with zero deps
- **L4**: LICENSE says "Pixel Drift Co" — confirm intended for public protocol
- **L5**: README shows `Date.now()` without noting it's ms (Sui uses ms)

---

## Test Coverage Gaps

| ID | Gap | Priority |
|----|-----|----------|
| T1 | No test for `verify()` / `settle()` individually on `s402ResourceServer` | Medium |
| T2 | No test for scheme-specific inner payload fields (unlock `encryptionId`, prepaid `ratePerCall`) | High (after H2 fix) |
| T3 | No test for double-registering same scheme | Low |
| T4 | No test for `decodePaymentPayload` with `payload: null` | Low |
| T5 | No test for u64 max boundary amounts (`18446744073709551615`) | Medium |
| T6 | No test for valid base64 JSON that's not s402 in `extractRequirementsFromResponse` | Medium |
| T7 | No test for latency guard (second expiration check after verify) | Low |

---

## npm Publish Readiness

| Item | Status | Notes |
|------|--------|-------|
| name | OK | `s402` — clean, available |
| version | OK | `0.1.0` |
| description | OK | Clear |
| license | OK | MIT |
| repository | CHECK | Points to `s402-protocol/core.git` — ensure repo exists |
| exports | OK | 5 sub-paths, all with `import` + `types` |
| files | OK | Correct whitelist |
| engines | OK | `>=18` |
| sideEffects | OK | `false` |
| prepublishOnly | OK | build + typecheck + test |
| publishConfig | OK | `access: public` |

---

## Summary

| Priority | Total | Resolved | Remaining | Key remaining items |
|----------|-------|----------|-----------|---------------------|
| CRITICAL | 3 | 1 (C2) | 2 | C1 export inconsistency, C3 CJS ambiguity |
| HIGH | 7 | 6 (H1-H6) | 1 | H7 bundle size (acceptable for v0.1) |
| MEDIUM | 7 | 1 (M6) | 6 | Type/runtime mismatch, base64 perf, naming, Error.cause, direct-call validation, README |
| LOW | 5 | 0 | 5 | Cosmetic items |

**Overall**: Well-structured code with strong separation of concerns. Error handling is excellent (recovery hints for agents is great design). Trust boundary hardening complete (C2, H2, H3, H4, H5, H6 all resolved). Compat layer moved to opt-in (M6 resolved). Remaining items are low-risk.
