# Changelog

All notable changes to the `s402` Python package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-09-04

Wire v2. The 402 document is an x402 V2 `PaymentRequired` envelope, always
(ADR-016). **This is a breaking change to the wire format and to this package's
public API.** An unmodified x402 client can now pay an s402 server with no
server flag, and one 402 can offer several schemes, networks and assets.

### Changed

- **`payment-required` carries `{ x402Version: 2, resource, accepts: [...], extensions }`.**
  `accepts` is a list of full requirement objects — one per offered scheme, each
  with its own `scheme`, `network`, `asset`, `amount`, `payTo` and
  `maxTimeoutSeconds` — where it used to be a list of scheme *name strings*
  beside one shared price line. `exact` is sorted to the front on encode, because
  an x402 client pays the first entry it has a handler for.
- **`encode_payment_required()` and `encode_requirements_body()` now project
  before serializing.** They take the 402 document in its flat in-memory form
  and emit the envelope: s402's per-requirement fields (`facilitatorUrl`,
  `expiresAt`, `protocolFeeBps`, `protocolFeeAddress`, `receiptRequired`,
  `settlementMode`, and the scheme sub-objects) are written into that entry's
  `extra`, and `mandate` plus the wire version into `extensions.s402`. They
  previously serialized the dict unchanged.
- **`decode_payment_required()` and `decode_requirements_body()` take an optional
  `now`** (epoch ms) and return the envelope lifted back to the flat per-entry
  form. A plain x402 402 — one with no `extensions.s402` — decodes and is
  payable; each offer whose scheme we implement gets an `expiresAt` derived from
  its `maxTimeoutSeconds`, so stale-payment rejection is not bypassed by inbound
  x402 traffic. `now` makes that derivation deterministic.
- **`validate_requirements_shape()` validates the WIRE envelope**, not the lifted
  view. `resource.url` is required; `accepts` must be a non-empty array of
  objects; s402's own field checks moved down one level into each entry's
  `extra`, with none of them relaxed. A document carrying `s402Version` is
  refused here by name and pointed at compat.
- **`pick_requirements_fields(obj, now=None)`** returns the lifted 402 document.
  Unknown envelope, entry and resource keys are stripped; unknown keys inside an
  entry's `extra` are KEPT, because x402's `extra` is an open bag by spec and a
  whitelist there is where the next upstream field would vanish silently.
- **`detect_protocol()` reads `extensions.s402`**, not `s402Version`. Presence of
  that extension is what makes a 402 an s402-profile 402; its absence makes it a
  plain x402 402 that an s402 client still pays.
- **`from_x402_requirements()` returns ONE `accepts[]` entry**, not a whole 402
  document, and now rejects any inbound scheme other than `exact` with
  `SCHEME_NOT_SUPPORTED` rather than silently relabeling it. Build the envelope
  with `normalize_requirements()`.
- A `mandate` is envelope-level. It is validated at `extensions.s402.mandate`,
  copied onto every offer on decode for the schemes that read it, and reconciled
  on encode — two offers declaring *different* mandates is now an error, since a
  mandate authorizes the agent rather than one price line.
- The bundled `examples/agent_client.py` walks `accepts` and picks an offer it
  can pay, instead of reading `amount` and `payTo` off the top level.

### Added

- `from_s402_v1_requirements(v1, resource=None)` — decodes the retired s402 v1
  flat shape into a wire-v2 402, expanding its `accepts` scheme names into one
  entry each, `exact` first, and hoisting `mandate` to the envelope. Reading what
  a peer said is an obligation (ADR-013); nothing emits v1.
- `to_requirements_wire(required)` — the single projection both the header and
  the body encoder use, exported so other carriers put the same document on their
  wire.
- `apply_foreign_expiry(required, now=None)` and `resolve_mandate(accepts, envelope_mandate=None)`.
- `x402_payment_flow_of(req)` — reads `extra.paymentFlow`; absent means
  `authorization`, and an unrecognized value raises rather than being guessed.
- Constants `S402_WIRE_VERSION` (`"2"`), `S402_DEFAULT_MAX_TIMEOUT_SECONDS` (60),
  and `S402_EXTENSION_KEY` (`"s402"`).

### Removed

- Emission of the s402 v1 flat shape. Nothing in this package writes
  `s402Version` onto a 402 any more; it survives only as an intake path in
  `s402.compat` and as the version field on a payment *payload*, which is
  unchanged at `"1"`.

### Migration

```python
# Before (v1 flat)
requirements = {
    "s402Version": "1",
    "accepts": ["exact"],
    "network": "sui:mainnet",
    "asset": "0x2::sui::SUI",
    "amount": "1000000",
    "payTo": "0xYOUR_ADDRESS",
}

# After (wire v2) — `resource` is mandatory, `accepts` is one entry per scheme
requirements = {
    "x402Version": 2,
    "resource": {"url": "https://api.example.com/paid"},
    "accepts": [
        {
            "scheme": "exact",
            "network": "sui:mainnet",
            "asset": "0x2::sui::SUI",
            "amount": "1000000",
            "payTo": "0xYOUR_ADDRESS",
        },
    ],
}

# Reading a decoded 402: the price lives on an offer, not at the top level
offer = requirements["accepts"][0]      # was requirements["amount"]
amount = offer["amount"]

# Holding a v1 document from an older peer? Read it, do not re-emit it.
from s402.compat import from_s402_v1_requirements
requirements = from_s402_v1_requirements(old_402, resource={"url": fetched_url})
```
