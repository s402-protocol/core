# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/s402-protocol/core/releases/tag/v0.1.0
