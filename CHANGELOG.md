# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.6]: https://github.com/s402-protocol/core/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/s402-protocol/core/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/s402-protocol/core/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/s402-protocol/core/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/s402-protocol/core/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/s402-protocol/core/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/s402-protocol/core/releases/tag/v0.1.0
