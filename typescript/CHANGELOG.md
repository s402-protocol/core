# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-06-28

The transport-abstraction release (ADR-011): **one seam, three carriers — HTTP, MCP, and A2A.**
`s402` now speaks the surfaces agents actually use, with opt-in x402 inbound bridges for each,
the protocol core staying chain-agnostic (S7) and x402-free throughout. Purely additive.

### Added

- **Transport abstraction (`PaymentTransport`) — ADR-011, Chunk 1a-i.** A chain-agnostic seam that maps the canonical `{ PaymentRequirements, PaymentPayload, SettleResponse }` to a carrier's out-of-band metadata slot, so payment can ride any carrier (HTTP today; MCP `_meta` and A2A task-state next). Motivated by x402 V2 moving all protocol data into headers and defining `transports-v2/` for HTTP/MCP/A2A — this is the seam that lets s402 match and then leapfrog that (x402 has only an A2A *spec*, no impl).
  - `PaymentTransport<TFrame>` interface + `httpTransport` (`src/transport.ts`). `TFrame` is the carrier-native container — `Headers` for HTTP; the `_meta` record for MCP; task metadata for A2A.
  - **Stateful-ready by design (ADR-011 blind-spot review):** every method threads an optional `PaymentCarrierContext` (`correlationId` + lifecycle `status`) so the *stateful* A2A carrier (task lifecycle: `input-required → completed/failed`, `taskId` correlation) becomes a thin adapter rather than forcing an interface break later. HTTP ignores `correlationId` (no wire slot) and *derives* `status`; A2A populates both.
  - New barrel exports: `httpTransport`, and types `PaymentTransport`, `PaymentCarrierContext`, `PaymentStatus`, `Decoded`.
  - **10 unit tests** at `test/transport.test.ts` proving `httpTransport` is byte-identical to the raw `http.ts` codec (encode equivalence + roundtrip), correct status derivation, null-on-absent, case-insensitive reads, and trust-boundary error propagation.
- **x402 inbound payload bridge — `fromX402PayloadHeaders()` in `s402/compat/x402` (ADR-011, Chunk 1a-ii).** The opt-in inbound half of "s402 servers transparently accept x402 clients" (ADR-005): reads an x402 payload header — `PAYMENT-SIGNATURE` (x402 V2) or `X-PAYMENT` (V1) — base64-decodes it, and normalizes the shape to an s402 payload via `fromX402Payload`. Returns `null` when absent so callers fall back to the native `x-payment` path. Lives in the **opt-in compat layer**, keeping the protocol core x402-free (AGENTS.md). **8 unit tests** at `test/compat-x402-inbound.test.ts` (V1/V2 normalization, case-insensitive read, header preference, null-on-absent, malformed/non-object/no-s402-equivalent rejection).
  - **ALL-CAPS emit was rejected**, not deferred: the Fetch `Headers` API byte-lowercases field names and HTTP/2 (RFC 9113 §8.2.1) requires lowercase — so uppercase emit is a no-op/spec violation. Lowercase emit is correct by design. Outbound interop is already covered: `payment-response` matches x402 V2's `PAYMENT-RESPONSE` case-insensitively.
- **MCP transport (`mcpTransport`) — payment in the JSON-RPC `_meta` slot (ADR-011, Chunk 1a-iii).** `s402` now speaks MCP, the surface agents actually use. `mcpTransport` (`PaymentTransport<McpMetaFrame>`) maps the canonical objects to/from `_meta['s402/payment']` as **structured JSON** (MCP's idiom — not base64), validated through the SAME canonical `validate*Shape`/`pick*Fields` as the HTTP path, so untrusted MCP input crosses the identical trust boundary. **Zero MCP-SDK dependency** — it is pure object-mapping; the SDK wiring lives in the Sui-aware `@sweefi/mcp` that consumes it. New barrel exports: `mcpTransport`, `S402_MCP_META_KEY`, type `McpMetaFrame`. Two private validators (`validatePayloadShape`, `validateSettleShape`) are now exported from `s402/http` so non-HTTP carriers reuse them.
  - **x402-over-MCP inbound bridge — `fromX402PayloadMeta()` in `s402/compat/x402`.** The MCP analogue of `fromX402PayloadHeaders`: reads `_meta['x402/payment']` and normalizes via `fromX402Payload`. Opt-in, in compat, keeping core `mcpTransport` x402-free.
  - **12 unit tests** at `test/mcp-transport.test.ts` (round-trips, status derivation, null-on-absent, wrong-decoder rejection, unknown-key stripping, x402 bridge).
  - Cross-language MCP conformance vectors are **deferred to a follow-up** (Chunk 1a-iv) — covered by TS unit tests for now; the language-agnostic JSON vectors touch the generator + Python runner.
- **A2A transport (`a2aTransport`) — payment on the Agent-to-Agent task lifecycle (ADR-011, Chunk 2). The leapfrog: x402 has only an A2A *spec*; s402 now ships the implementation.** `a2aTransport` (`PaymentTransport<A2aMetadataFrame>`) maps the canonical objects onto A2A task/message `metadata` under `s402.payment.*` keys (`status`, `required`, `payload`, `receipts`, `correlationId`), mirroring x402's `x402.payment.*` convention. A2A is fully stateful, so — unlike HTTP/MCP — the lifecycle **status is carried explicitly and READ back** (not derived), and `ctx.correlationId` threads the `taskId`. Settlement uses A2A's plural `receipts` array. Validation routes through the same canonical `validate*Shape`/`pick*Fields` — identical trust boundary across all three carriers. New barrel exports: `a2aTransport`, `S402_A2A_KEYS`, type `A2aMetadataFrame`.
  - **x402-over-A2A inbound bridge — `fromX402PayloadA2A()` in `s402/compat/x402`.** Completes the opt-in x402-inbound trio (HTTP · MCP · A2A); reads `metadata['x402.payment.payload']` and normalizes via `fromX402Payload`. Core `a2aTransport` stays x402-free.
  - **13 unit tests** at `test/a2a-transport.test.ts`, including the defining check that A2A *reads* the explicit status rather than deriving it.
- **Cross-language conformance vectors for the MCP + A2A carriers (ADR-011, Chunk 1a-iv).** `spec/vectors/transport-carriers.json` — 6 vectors (3 MCP + 3 A2A) pinning the wire contract (encoded frame + decoded value + carrier status/correlation) for other-language implementations. A new `Conformance: transport-carriers` block in the TS runner validates them; the Python runner is untouched (it loads only named files), so it stays green until a Python codec exists.

### Fixed

- **Conformance vector generator restored.** `test/conformance/generate-vectors.ts` imported `../../src/compat.js`, which moved to `compat/x402.js` in the 0.7.0 compat reorg — the generator had been broken/unrunnable since (nothing in CI exercises it; only the runner reads the committed vectors). Fixed the import; regenerating now reproduces the existing vectors byte-for-byte (confirming no committed drift) plus the new transport file. See `LESSONS.md`.

### Security

Pre-publish adversarial review (2026-06-28) hardened three trust-boundary issues before the 0.8.0 publish (regression tests in `test/security-hardening.test.ts`):

- **A2A status decode** (`transport.ts`) — `a2aStatus` indexed a plain enum object with an attacker-controlled key, so a malicious A2A peer sending `s402.payment.status: "constructor"` (or `__proto__` / `toString` / …) got back an inherited prototype member (a function/object) instead of a `PaymentStatus`. Now `hasOwnProperty`-guarded.
- **MPP empty challenge id** (`compat/mpp.ts`) — `parseWwwAuthenticatePayment` and `decodeMppCredential` accepted an empty `id` (`typeof "" === 'string'`); MPP hardened `id` to MUST-be-non-empty (an empty id is replay-ambiguous). Now rejected for all required auth-params.
- **`pickPayloadFields`** (`http.ts`) — the exported helper indexed the scheme map with an untrusted key; `scheme: "constructor"` threw a raw `TypeError` on a direct call. Now `hasOwnProperty`-guarded.
- **Defense-in-depth:** 64KB size cap added to the MPP base64url decoder (mirrors the HTTP header cap).
- **`s402Gate` now verifies BEFORE serving (security-first default).** The payment is cryptographically verified before the protected handler runs; an invalid payment is rejected with a 402 and the handler **never executes** (no compute, no side effects). `verifyBeforeServe: false` opts into optimistic serve-then-settle for idempotent / side-effect-free handlers. Previously the handler ran before verification (body was withheld on failure, but side effects executed) — that was the highest-severity finding in the pre-publish review. Regression tests in `test/gate.test.ts` prove the handler does not run on an invalid payment.

### Changed

- **1098 tests across 28 files** (was 1032 at 0.7.0). The transport refactor (1a-i) is **behavior-preserving**: `httpTransport` delegates to the existing `http.ts` `encode*/decode*` functions and `S402_HEADERS` — same header names, same base64 — so all pre-existing tests pass unchanged as the regression proof. Chunks 1a-ii (x402 HTTP inbound bridge), 1a-iii (`mcpTransport` + x402 `_meta` bridge), and 2 (`a2aTransport` + x402 A2A bridge) are purely additive; no core wire change. The two newly-exported validators are additive to `s402/http`. **One seam, three carriers: HTTP, MCP, A2A.**

### Compatibility

- **Purely additive.** No changes to existing types, scheme interfaces, wire format, or conformance vectors. `httpTransport` is opt-in; the root barrel adds exports but changes no existing ones.

## [0.7.0] - 2026-04-22

### Added

- **`s402/compat-l402` — L402 read-path interop (DAN-344).** New entry point for consuming Lightning Labs' L402 (formerly LSAT) challenges as native s402 types. L402 is the oldest 402 dialect in production — shipping this turns the "universal read" positioning pillar from aspirational into airtight.
  - `parseWwwAuthenticateL402(header)` — RFC 9110 auth-params parser accepting both `L402` and legacy `LSAT` auth-schemes (canonicalized to `L402` in output). Handles quoted-string + unquoted-token forms. Enforces required `macaroon` and `invoice` params.
  - `decodeBolt11Summary(invoice)` — partial BOLT-11 decoder over the human-readable part only. Extracts network (`lightning:mainnet|testnet|regtest|signet`) and amount (converting m/u/n/p multipliers to millisatoshi with BigInt arithmetic). Rejects pico-BTC amounts not divisible by 10.
  - `fromL402Challenge(challenge)` — translates an L402 challenge into `s402PaymentRequirements` with `scheme: 'exact'`, `asset: 'lightning:msat'`, sentinel `payTo: 'lightning:invoice'` (real destination lives in the invoice). Surfaces macaroon + invoice in `extensions.l402` for retry construction. Rejects amountless invoices as spec violations. Stamps a conservative `expiresAt = now + 60s` so that **S1 (stale payment rejection) stays load-bearing** for L402-derived requirements — the real BOLT-11 expiry tag is not decoded in v0.7 (scope deferral); the 60s floor guards against stale-invoice replay, with the tradeoff that long-expiry invoices trigger a re-fetch after 60s.
  - **Signet prefix support**: recognizes both the canonical current-BOLT-11 prefix (`lntbs`, core-lightning + recent LND) and the legacy prefix (`lnsb`, older LND emissions). Both canonicalize to `lightning:signet` in the parsed output.
- **~20 unit tests** at `test/compat-l402.test.ts` covering all four multiplier classes, all four network prefixes, LSAT/L402 alias handling, amountless invoices, malformed HRPs, and end-to-end header-to-requirements flows.
- **Positioning document** at `docs/positioning.md` — canonical three-pillar USP: expressiveness (6 schemes), universal read (every 402 dialect), on-chain enforcement (Move invariants). Single source of truth for landing page, pitch, and grant copy.
- **Universal 402 Absorption** project tracker on Linear ([project link](https://linear.app/dannydevs/project/universal-402-absorption-f6e181082db4)) with child issues DAN-344 (L402), DAN-345 (MPP Session), DAN-346 (MPP write path), DAN-347 (Google AP2), DAN-348 (IETF reference impl), DAN-349 (ERC-7824 watch).

### Scope (intentionally deferred)

- **L402 write path** — emitting L402 challenges requires a Lightning node to mint BOLT-11 invoices; out of scope for a wire-format library. Teams that need emission should keep Aperture in the path.
- **Macaroon caveat decoding** — passed through opaque in v0.7; caveat introspection delegated to `node-macaroon` or equivalent.
- **Full BOLT-11 tagged-field decoding** — node pubkey, routing hints, payment hash, description. Lightning wallets already decode these; we do not duplicate their work.
- **BOLT-12 offers** — newer offer-based protocol, spec still evolving.

### Changed

- `docs/integrations.md` — added L402 compat-layer row (✅ v0.7).
- `docs/guide/upgrade-l402.md` — new migration guide covering consumption, coexistence via `Accept-Payment`, BOLT-11 multiplier table, and honest comparison with L402.

### Breaking

- **Minimum Node.js bumped to 20** (from 18). Node 18 reached end-of-life April 2025; `envelope.ts`'s `computeTxBinding` relies on `globalThis.crypto.subtle` which is only available unflagged in Node 19+. `engines.node` updated to `>=20`, CI matrix dropped Node 18, README/docs updated. Node 20 and Node 22 remain fully supported.

### Compatibility

- **Non-compat consumers are additive.** No changes to existing types, scheme interfaces, wire format, or conformance vectors.
- **Compat sub-path exports reorganized**: all three compat layers now live under `s402/compat/*` for symmetry and clearer intent.
  - `s402/compat` → **`s402/compat/x402`** (breaking rename — x402 is now explicit, not the unlabeled default)
  - `s402/compat-mpp` → **`s402/compat/mpp`**
  - `s402/compat-l402` → **`s402/compat/l402`** (new in this release; shipped under the new path from day one)
  - Source tree moved from flat `src/compat.ts`, `src/compat-mpp.ts`, `src/compat-l402.ts` to `src/compat/x402.ts`, `src/compat/mpp.ts`, `src/compat/l402.ts`. Pre-1.0 minor bump licenses the rename; no backward-compat aliases shipped — consumers update imports once.
  - **Migration**: find-replace `'s402/compat'` → `'s402/compat/x402'`, `'s402/compat-mpp'` → `'s402/compat/mpp'`, `'s402/compat-l402'` → `'s402/compat/l402'`. Exported symbol names are unchanged.
- Root `s402` entry still pulls no compat bundle — compat layers remain opt-in.

## [0.6.0] - 2026-04-19

### Added

- **`s402/compat-mpp` — MPP read-path interop (DAN-339).** New entry point for consuming Stripe/Tempo Machine Payment Protocol 402 responses as native s402 types. All parsing is grounded against the actual MPP spec drafts in `tempoxyz/mpp-specs` (draft-httpauth-payment-00, draft-payment-intent-charge-00), not hearsay.
  - `parseWwwAuthenticatePayment(header)` — RFC 9110 auth-params parser for `WWW-Authenticate: Payment`. Handles quoted-string escapes, unquoted tokens, enforces required `id`/`realm`/`method`/`intent`/`request`, preserves optional `digest`/`expires`/`description`/`opaque`.
  - `parseMppAcceptPayment(header)` — method/intent pair grammar with wildcards on either side (`tempo/charge`, `tempo/*`, `*/session`, `*/*`) and q-values per core spec §6.1. Stable sort by descending q, preserves client order on ties.
  - `matchMppRange(range, method, intent)` — specificity scoring (exact=2, one-wild=1, all-wild=0, no-match=−1) for the "prefer most specific matching range" rule.
  - `decodeMppChargeRequest(challenge)` — decodes the base64url JCS `request` blob for the charge intent. Validates `amount` as non-negative integer, requires `currency`, preserves `methodDetails` untouched.
  - `decodeMppCredential(authorizationHeader)` — base64url-nopad `Authorization: Payment <...>` decoder with trust-boundary shape validation on `challenge` and `payload`.
  - `fromMppChargeChallenge(challenge, now?)` — translates blockchain-method Charge challenges (`tempo`/`evm`/`solana`/`lightning`/`stellar`) into `s402PaymentRequirements` with `scheme: 'exact'`. Resolves network via `eip155:{chainId}` / `tempo:{chainId}` conventions, carries challenge provenance into `extensions.mpp` for downstream routing, rejects processor-based methods (Stripe/card have no payTo in the Charge request), rejects expired challenges.
- **40 spec-grounded unit tests** at `test/compat-mpp.test.ts` drawn from the spec's own §5.1.4 / §6.1 / §Request Schema fixtures.
- **ADR-005 — Interop When Possible, Superset When Wise.** The governing strategic principle behind the compat layer: absorb x402/MPP as payment-in formats where their design is legitimate; superset them on primitives their business models forbid. See `docs/adr/005-interop-superset-principle.md`.

### Scope (intentionally deferred to v0.7+)

- Session intent (cumulative voucher ↔ Prepaid translation shim)
- Method-specific credential-tier dispatch (EVM `permit2`/`authorization`/`transaction`/`hash`; Tempo `transaction`/`hash`/`proof`)
- HMAC-SHA256 challenge-binding verification (server-side, needs secret)
- Write path — emitting MPP-shaped `WWW-Authenticate: Payment` challenges from an s402 server

### Changed

- **956 tests across 21 files** (was 916). The 40 new compat-mpp tests join 30 unit + 6 live-server integration tests for `Accept-Payment` that shipped earlier in the 0.5 dev cycle.
- Migration guide (`docs/guide/upgrade-mpp.md`) updated to reference real exported APIs rather than placeholder code.
- `docs/integrations.md` compat-layer table updated: MPP Charge (read) is 🟡 v0.3, MPP `Accept-Payment` is ✅ Production, MPP Charge (write) and Session remain 📋 roadmap.

### Compatibility

- **Purely additive.** No changes to existing types, scheme interfaces, wire format, or conformance vectors. Existing 0.5.x consumers require no code changes.
- **New sub-path export**: `s402/compat-mpp` sits alongside the existing `s402/compat` (x402 interop). Both are opt-in — importing from the root `s402` entry does not pull the compat bundles.

## [0.5.0] - 2026-04-12

### Added

- **`upto` scheme V2 features (DAN-284).** Two new fields close x402's upto overcharge vulnerability:
  - `estimatedAmount` on `s402UptoExtra` — server's advisory cost estimate so clients can set tight ceilings
  - `settlementCeiling` on `s402UptoPayload` — client-chosen, on-chain-enforced cap. Move contract rejects `actualAmount > settlementCeiling`. Must satisfy `1 <= settlementCeiling <= maxAmount`. See ADR-003 §Decision 3 and §Decision 8.
- **Extension system (DAN-285, ADR-004).** Typed, lifecycle-aware plugin architecture:
  - Three actor-specific interfaces: `s402ClientExtension`, `s402ServerExtension`, `s402FacilitatorExtension`
  - Four facilitator hooks in pipeline order: `beforeVerify` → `afterVerify` → `beforeSettle` → `afterSettle`
  - `s402ExtensionRegistry` with dependency ordering via Kahn's topological sort
  - Critical vs advisory error handling: `critical: true` extensions throw, advisory extensions log and continue
  - `getExtensionData<T>()` / `setExtensionData()` type-safe helpers
  - `./extensions` sub-path export added to package.json
- **`skipVerify` option on `process()`.** New `s402ProcessOptions` interface with `skipVerify?: boolean`. Eliminates the verify() dry-run RPC round-trip (~200-400ms) for chains where failed transactions cost zero gas (Sui PTBs). All pre-flight checks (expiration, scheme-mismatch, dedup) still run.
- **`EXTENSION_FAILED` error code** — `retryable: false`, for critical extension pipeline failures.
- **154 conformance test vectors** (was ~130). New vectors for: upto requirements with estimatedAmount, upto payloads with settlementCeiling, settle responses with actualAmount/depositId, V2 rejection vectors, upto roundtrips, mandate.minPerTx validation.

### Fixed

- **Settle response type validation (M1).** `validateSettleShape` now rejects non-string `actualAmount` and `depositId` — a malicious facilitator could previously inject numeric types that passed through to consumer code.
- **Prepaid payload amount validation (M2).** `ratePerCall` and `maxCalls` in payload now validated with `isValidAmount()`, matching the requirements-side validation. Previously only type-checked as strings.
- **Mandate minPerTx amount validation (L1).** `mandate.minPerTx` now validated with `isValidAmount()` for consistency with other amount fields.
- **afterSettle error observability.** Catch block now forwards to `extensionErrorHandler` instead of silently swallowing critical extension errors (the settlement result is still never changed — tx is already on-chain).
- **Stale comment in validatePayloadShape.** Updated to document upto's scheme-specific inner keys alongside prepaid and unlock.

### Changed

- **831 tests across 17 files** (was 798). New coverage: standalone verify/settle guard tests, V2 validation edge cases, settle response type checks, prepaid amount validation, extension system integration.
- Conformance README updated with `estimatedAmount` in upto sub-object keys and `settlementCeiling` in payload inner keys.

## [0.4.0] - 2026-04-11

### Changed
- **BREAKING: `verifySettlement` is now required on `s402ClientScheme` (DAN-280).** The `?` was removed — every scheme implementation MUST provide `verifySettlement()`. Schemes that cannot verify locally (e.g. unlock-TX2) should return `{ verified: false, reason: '...' }`. All 5 SweeFi adapters already implement this method; only custom third-party implementations that relied on the optional marker will need updating.
- Updated JSDoc: `@since 0.4.0 — required (was optional in 0.3.0)`
- `mockExactClientScheme()` in `test-utils.ts` now includes `verifySettlement()` returning `{ verified: false }` with reason `'mock scheme'`

### Added
- **S8 conformance test vectors (DAN-282).** `spec/vectors/settlement-verification.json` — 7 chain-agnostic test vectors covering the `verifySettlement` interface contract: matching digest, mismatched digest (malicious facilitator), settle failed, missing txDigest, invalid base64, stream scheme, and non-verifiable scheme. Each vector includes `expectedShape`, `invariants`, and implementation `notes`.

### Compatibility
- **BREAKING for 0.3.x consumers**: implementations that omitted `verifySettlement` will now fail type-checking. Add a stub returning `{ verified: false, expectedDigest: '', actualDigest: null, reason: 'not implemented' }` to restore compilation.
- Wire format: unchanged from v0.3.0.

## [0.3.0] - 2026-04-11

This release closes the facilitator causal-binding hole identified in the April 2026 scale-fragility review, and establishes s402 as a pure chain-agnostic protocol repo (no Sui code anywhere). Chain-specific implementations now live in downstream adapter repos — the canonical Sui reference is `@sweefi/sui` in the SweeFi monorepo.

### Added

- **`verifySettlement` — client-side causal-binding check (S8 Facilitator Accountability).** New optional method on `s402ClientScheme`. For all client-signed schemes (`exact`, `stream`, `escrow`, `unlock` TX1), this is a **local, offline comparison**: derive the expected transaction digest from the signed BCS bytes and compare to `SettleResponse.txDigest`. No RPC call required. Closes the causal-binding hole where a malicious facilitator could substitute an unrelated-but-real transaction digest — that digest would correspond to different signed bytes the client never produced, and the check would reject it. Interface-only in this release; concrete implementations land in `@sweefi/sui` per ADR-002. See `typescript/src/scheme.ts` and `INVARIANTS.md` § S8 for the full contract and copy-paste implementation template.
- **`s402SettlementVerification` type** — return shape for `verifySettlement`: `{ verified, expectedDigest, actualDigest, reason? }`.
- **`DIGEST_MISMATCH` error code** — `retryable: false`, with a `suggestedAction` warning callers NOT to retry on mismatch. Retrying is dangerous: the signed bytes may have already landed on-chain under the *expected* digest (the facilitator may simply be lying about what it broadcast), and a fresh retry would double-pay. The correct failure mode is to mark the payment as non-settled and stop trusting the facilitator. See `typescript/src/errors.ts`.
- **S8. Facilitator Accountability** — first-class safety invariant alongside S1–S7. Full statement, formal proof for the `exact` scheme on Sui (by blake2b-256 collision resistance), per-scheme scope table, and a copy-paste implementation template for downstream Sui adapters now live in `INVARIANTS.md` § S8. The Allium behavioral spec is at `spec/allium/s8-facilitator-accountability.allium`.
- **ADR-001 — Protocol Boundaries.** Documents four decisions from the scale-fragility council: (1) facilitator trust boundary sealed by client-side digest verification, (2) receipt cardinality is a non-guarantee at the protocol layer, (3) scheme cap at five with burden-of-proof for any new scheme, (4) extension hygiene rules. See `docs/adr/001-protocol-boundaries.md`.
- **ADR-002 — s402 is a pure protocol repo.** Decides that this repo contains NO chain-specific code at any path — not in `typescript/src/`, not in a sibling package, not anywhere. All Sui-specific implementation moves to SweeFi. Corollary: the S7 chain-agnostic boundary is now enforced repo-wide, not just inside `src/`. See `docs/adr/002-s402-is-pure-protocol.md`.

### Removed

- **`mcp-server/` directory deleted.** The Sui-specific MCP server that previously shipped in this repo has been relocated to `@sweefi/mcp` (canonical implementation in the SweeFi repo) per ADR-002. **This does not affect the npm `s402` package** — `mcp-server` was a separate consumer of this package, not part of it. Users who were installing from the repo directly should migrate to `npx @sweefi/mcp`; a forthcoming `npm deprecate s402-mcp` will redirect the legacy standalone package to the new name.

### Changed

- **S7 scope strengthened to repo-level.** `INVARIANTS.md` § S7 scope note now reads: "chain-specific code lives in downstream implementation repos (e.g. `@sweefi/sui` for the Sui implementation) which consume this package from npm and add chain validation on top. Per ADR-002, the s402 repo itself contains NO chain-specific imports at the repo level — the protocol-pure boundary is enforced repo-wide, not just inside `src/`."
- **`INVARIANTS.md` Sui references rewritten as downstream pointers.** Prior revisions of the S8 proof block referenced a reference implementation at `mcp-server/src/sui-exact.ts`. That path no longer exists; the proof block now points at `sweefi/packages/sui/src/s402/exact/client.ts` as the canonical Sui adapter per ADR-002.
- **Demo API distribution surfaces** (`demo-api/public/index.html` served at `demo.s402-protocol.org`, and `demo-api/src/server.ts`) now reference `@sweefi/mcp` with the correct `SUI_PRIVATE_KEY` / `SUI_NETWORK` environment variables, matching SweeFi's documented `mcpServers` config shape. Outside the npm package scope but noted here for consumers browsing the monorepo.

### Compatibility

- **TypeScript type compatibility**: `verifySettlement` is optional on `s402ClientScheme`, and `DIGEST_MISMATCH` is a purely additive enum member. Existing adapter implementations compile unchanged against `^0.3.0`.
- **Wire format**: unchanged from v0.2.3. The 132 conformance test vectors in `test/conformance/vectors/` still pass byte-for-byte against v0.3.0.
- **Minor-bump rationale**: the 0.2.3 → 0.3.0 jump reflects the semantic significance of adding a new safety invariant (S8) and the repo-level architectural decisions (ADR-001/002), not a breaking wire-format change. Under semver 0.x, minor bumps are treated as breaking by `^0.x.y` ranges — consumers should expect to opt-in explicitly.

## [0.2.1] - 2026-03-02

### Added

- **Conformance test vectors ship in npm package** — 133 machine-readable JSON test vectors across 12 files now included via `test/conformance/vectors`. Cross-language implementors (Go, Python, Rust) can `npm pack s402` to get the vectors without cloning the repo.
- **API stability declaration** — `API-STABILITY.md` classifies all 83 exports as stable, experimental, or internal.

### Fixed

- Barrel export JSDoc updated to chain-agnostic wording (was "Sui-native").

## [0.2.0] - 2026-03-01

### Added

- **Receipt HTTP helpers** — `s402/receipts` sub-path export with `formatReceiptHeader()`, `parseReceiptHeader()`, `S402_RECEIPT_HEADER`. Chain-agnostic receipt wire format (`v2:base64(sig):callNumber:timestampMs:base64(hash)`) for v0.2 signed usage receipts.
- **S7 chain-agnostic boundary invariant** — formal safety invariant enforced by `test/boundary.test.ts`. Greps `src/` for chain-specific patterns (Sui address regex, Solana base58, Ethereum imports) and fails the build if any are found.
- **v0.2 prepaid type extensions** — `providerPubkey` and `disputeWindowMs` fields on `s402PrepaidExtra` for signed receipt mode.
- **Body transport** — `application/s402+json` content type for large payloads that don't fit in HTTP headers.
- **Formal safety invariants** (S1-S7) documented in AGENTS.md.

### Fixed

- **Chain-agnostic payTo/protocolFeeAddress validation** — removed Sui-specific address regex (`/^0x[0-9a-fA-F]{64}$/`) from `http.ts`. Replaced with chain-agnostic checks (non-empty string, no control characters). Chain-specific validation belongs in `@sweefi/sui`.
- **x402 compat validation parity** — `normalizeRequirements()` now runs `validateRequirementsShape()` on x402 conversion output, ensuring identical validation regardless of input format.
- **Prepaid pairing invariant enforcement** — `providerPubkey` and `disputeWindowMs` must both be present (v0.2) or both absent (v0.1). Was documented in JSDoc but not enforced at wire decode.
- **Receipt BigInt coercion** — `parseReceiptHeader()` rejects empty strings and whitespace-only strings that JavaScript's `BigInt()` would silently coerce to `0n`.
- **Removed Sui default for `asset`** — `s402RouteConfig.asset` is now required (was optional with `'0x2::sui::SUI'` default). Chain-specific defaults don't belong in the protocol layer.

### Changed

- **BREAKING**: `s402RouteConfig.asset` is now required (was optional).
- JSDoc on `s402PaymentRequirements` updated to chain-agnostic wording (network, asset, amount fields).
- **Conformance test suite** — 133 machine-readable JSON test vectors across 12 files for cross-language implementation verification. Covers encode/decode, body transport, compat normalization, receipt format/parse, validation rejection, key-stripping, and roundtrip identity. Vectors ship in the npm package.
- **API stability declaration** — `API-STABILITY.md` classifies all 83 exports as stable/experimental/internal.
- 405 tests across 12 suites (was 207 at v0.1.0).

## [0.1.8] - 2026-02-27

### Added

- Body transport (`application/s402+json`) for large payloads
- v0.2 prepaid type extensions (`providerPubkey`, `disputeWindowMs`)
- `FUNDING.yml` and cross-linked SweeFi in README

## [0.1.7] - 2026-02-25

### Added

- Formal safety invariants (Lamport-style proofs)
- `isValidU64Amount()` magnitude checks

## [0.1.6] - 2026-02-19

### Fixed

- **Security audit patches** (15 true positives, H-1 through M-6, L-2):
  - H-1: `process()` wraps `resolveScheme`/`verify`/`settle` in try/catch — unhandled rejections no longer crash server middleware; returns `{success: false}` instead
  - H-2: In-flight dedup `Set` on `process()` — concurrent identical payloads can no longer both reach `scheme.settle()`
  - H-3: `Promise.race()` timeouts — 5s for verify, 15s for settle — prevents hanging RPC calls from exhausting the event loop
  - M-1: `facilitatorUrl` in x402 compat now validated via `new URL()` — rejects `javascript:`, `file://`, and other non-http(s) schemes (SSRF guard)
  - M-2: `isValidAmount` → `isValidU64Amount` on decode — rejects amounts above u64 max at the wire boundary
  - M-5: Settle catch returns `SETTLEMENT_FAILED` (`retryable: true`) instead of `VERIFICATION_FAILED` (`retryable: false`) — agents can now retry on transient RPC failures
  - M-6: `payTo` validation tightened from `startsWith('0x')` to full Sui address regex `/^0x[0-9a-fA-F]{64}$/` — rejects `'0x'` alone and non-hex chars
  - L-2: `expiresAt` guard extended to reject `<= 0` — negative timestamps and zero are now invalid at decode time

## [0.1.5] - 2026-02-19

### Changed

- Author updated to SweeInc brand name
- Renamed `@sweepay/*` → `@sweefi/*` across all documentation

## [0.1.4] - 2026-02-18

_Version bump for npm publish after license change._

## [0.1.3] - 2026-02-18

### Changed

- License changed from MIT to Apache-2.0
- Documentation consolidated (removed codebase-tour, added complete guide)
- Updated tagline to "HTTP 402 payment protocol"

### Added

- CI and npm version badges to README

## [0.1.2] - 2026-02-16

### Added

- CI workflow (GitHub Actions) with tag-based npm releases
- Separate build job for Node 22

## [0.1.1] - 2026-02-16

### Fixed

- Facilitator `verify()` and `settle()` now have the same defense-in-depth guards as `process()`:
  - Reject non-number `expiresAt` values (prevents silent bypass with string types)
  - Reject payload schemes not in `requirements.accepts` (scheme-mismatch guard)
- `protocolFeeBps` validation now requires an integer (rejects `50.5`)
- Sub-object fields (stream, escrow, unlock, prepaid, mandate) are now stripped of unknown keys at the trust boundary, matching the top-level field stripping behavior
- `process()` now catches exceptions thrown by `scheme.settle()` and returns them as error results instead of propagating unhandled

### Added

- `isValidU64Amount()` — validates amount strings fit in a Sui u64 (format + magnitude check). The existing `isValidAmount()` remains format-only for chain-agnostic use.

## [0.1.0] - 2026-02-15

### Added

- Five payment scheme types: exact, prepaid, escrow, unlock, stream
- HTTP header encoding/decoding (base64 JSON wire format)
- Client, server, and facilitator scheme registries
- Optional x402 compat layer (`s402/compat`) — normalizes V1 and V2 formats
- Typed error codes with `retryable` flag and `suggestedAction` for agent self-recovery
- Sub-path exports: `s402/types`, `s402/http`, `s402/compat`, `s402/errors`
- Property-based fuzz testing via fast-check
- 207 tests, zero runtime dependencies

[0.8.0]: https://github.com/s402-protocol/core/compare/v0.7.0...v0.8.0
[0.4.0]: https://github.com/s402-protocol/core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/s402-protocol/core/compare/v0.2.3...v0.3.0
[0.2.1]: https://github.com/s402-protocol/core/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/s402-protocol/core/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/s402-protocol/core/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/s402-protocol/core/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/s402-protocol/core/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/s402-protocol/core/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/s402-protocol/core/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/s402-protocol/core/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/s402-protocol/core/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/s402-protocol/core/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/s402-protocol/core/releases/tag/v0.1.0
