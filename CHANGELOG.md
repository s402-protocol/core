# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
