# s402

[![CI](https://github.com/s402-protocol/s402-python/actions/workflows/ci.yml/badge.svg)](https://github.com/s402-protocol/s402-python/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/s402.svg)](https://pypi.org/project/s402/)

Python implementation of the [s402 wire format specification](https://s402-protocol.org/specification). Chain-agnostic HTTP 402 payment protocol for AI agent commerce. Zero dependencies. Passes the conformance test vectors from the [TypeScript reference](https://github.com/s402-protocol/core).

> **Wire v2 (0.2.0) is a breaking change.** The `payment-required` header now carries an x402 V2 `PaymentRequired` envelope — `{ x402Version: 2, resource, accepts: [...] }`, one full requirement object per offered scheme — instead of the flat v1 shape with `accepts: ["exact"]`. An unmodified x402 client can pay an s402 server with no server flag. See [CHANGELOG.md](CHANGELOG.md) for the migration.

```bash
pip install s402
```

> **Python >= 3.10 required.** Zero runtime dependencies.

## AI Agent Auto-Pay (httpx)

The most common use case: an AI agent that automatically pays when it hits a 402.

```python
import httpx
from s402 import (
    decode_payment_required,
    encode_payment_payload,
    S402_HEADERS,
    S402Error,
)

def agent_fetch(url: str, build_payment) -> httpx.Response:
    """Fetch a URL, auto-paying if the server returns 402."""
    res = httpx.get(url)

    if res.status_code != 402:
        return res

    # 1. Decode what the server wants
    header = res.headers.get(S402_HEADERS["PAYMENT_REQUIRED"])
    if not header:
        raise S402Error("INVALID_PAYLOAD", "402 response missing payment-required header")
    requirements = decode_payment_required(header)

    # 2. Build a payment (you bring the chain SDK)
    payment = build_payment(requirements)

    # 3. Retry with payment attached
    return httpx.get(url, headers={
        S402_HEADERS["PAYMENT"]: encode_payment_payload(payment),
    })
```

This is the complete client-side integration. The `build_payment` callback is where you use your chain SDK (Sui, Ethereum, Solana) to construct and sign a transaction.

## Server: Return a 402

`accepts` is a menu: one entry per scheme you offer, each with its own network, asset, amount and `payTo`. List `exact` first — an x402 client pays the first entry it has a handler for.

```python
from s402 import encode_payment_required

def handle_request(request):
    requirements = {
        "x402Version": 2,
        "resource": {"url": "https://api.example.com/paid"},
        "accepts": [
            {
                "scheme": "exact",
                "network": "sui:mainnet",
                "asset": "0x2::sui::SUI",
                "amount": "1000000",  # 0.001 SUI
                "payTo": "0xYOUR_ADDRESS",
            },
        ],
    }
    return Response(
        status_code=402,
        headers={"payment-required": encode_payment_required(requirements)},
    )
```

s402's own per-requirement fields (`facilitatorUrl`, `expiresAt`, fee fields, scheme sub-objects) go on the entry and are projected into its `extra` on the wire. `mandate` goes on the envelope and is projected into `extensions.s402`.

## Decode & Validate

```python
from s402 import decode_payment_required, decode_payment_payload, S402Error

# Decode the 402 document (validates + strips unknown keys)
try:
    requirements = decode_payment_required(header_value)
    print([o["scheme"] for o in requirements["accepts"]])  # ['exact', 'prepaid']
    print(requirements["accepts"][0]["amount"])            # '1000000'
except S402Error as e:
    print(e.code)             # 'INVALID_PAYLOAD'
    print(e.retryable)        # False
    print(e.suggested_action) # 'Check payload format...'
```

## x402 Compatibility

Since wire v2 an s402 402 IS an x402 V2 envelope, so the x402 direction is the native decode path. What is left to convert are the two retired flat shapes.

```python
from s402.compat import normalize_requirements, from_s402_v1_requirements

# Auto-detect and normalize any era: x402 V2 / s402 wire v2, x402 V1, s402 v1
requirements = normalize_requirements(raw_json_from_any_source)

# Or read our own retired shape directly (intake obligation — nothing emits it)
requirements = from_s402_v1_requirements(old_flat_402, resource={"url": fetched_url})
```

A 402 with no `extensions.s402` is a plain x402 402 from a server that has never heard of s402. It decodes and is payable; each offer we could pay gets an `expiresAt` derived from its `maxTimeoutSeconds`, so stale-payment rejection still applies. Pass `now=` to make that derivation deterministic in tests.

## Receipts (Prepaid v0.2)

```python
from s402.receipts import format_receipt_header, parse_receipt_header

# Format a signed receipt header
header = format_receipt_header(
    signature=sig_bytes,       # 64-byte Ed25519
    call_number=42,
    timestamp_ms=1700000000000,
    response_hash=hash_bytes,  # 32-byte SHA-256
)

# Parse it back
receipt = parse_receipt_header(header)
print(receipt["call_number"])  # 42
```

## Conformance

Passes the machine-readable test vectors from the TypeScript reference implementation, which is the spec. They cover encode, decode, body transport, x402 compat, receipts, validation rejection, key stripping, and roundtrip identity.

```bash
pytest -v
```

## API

| Function | Description |
|----------|-------------|
| `encode_payment_required(req)` | Requirements dict → base64 header string |
| `decode_payment_required(header, now=None)` | Base64 header → validated 402 document |
| `encode_payment_payload(payload)` | Payload dict → base64 header string |
| `decode_payment_payload(header)` | Base64 header → validated payload dict |
| `encode_settle_response(resp)` | Settle dict → base64 header string |
| `decode_settle_response(header)` | Base64 header → validated settle dict |
| `detect_protocol(headers)` | Returns `"s402"`, `"x402"`, or `"unknown"` |
| `normalize_requirements(obj, now=None)` | Auto-detect any era of 402, return the wire-v2 shape |
| `from_s402_v1_requirements(v1, resource=None)` | Read the retired s402 v1 flat shape |
| `to_requirements_wire(req)` | Project a 402 document into the x402 V2 envelope |
| `is_valid_amount(s)` | Check canonical non-negative integer string |
| `format_receipt_header(...)` | Build `X-S402-Receipt` header value |
| `parse_receipt_header(header)` | Parse `X-S402-Receipt` header value |

Body transport variants: `encode_requirements_body`, `decode_requirements_body`, `encode_payload_body`, `decode_payload_body`, `encode_settle_body`, `decode_settle_body`.

## Links

- [Wire Format Specification](https://s402-protocol.org/specification) — field-by-field protocol definition
- [TypeScript reference](https://github.com/s402-protocol/core) — the reference implementation (736 tests)
- [Conformance vectors](https://github.com/s402-protocol/core/tree/main/spec/vectors) — machine-readable test vectors
- [s402-protocol.org](https://s402-protocol.org) — docs, guides, whitepaper

## License

Apache-2.0
