# s402

[![CI](https://github.com/s402-protocol/s402-python/actions/workflows/ci.yml/badge.svg)](https://github.com/s402-protocol/s402-python/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/s402.svg)](https://pypi.org/project/s402/)

Python implementation of the [s402 wire format specification](https://s402-protocol.org/specification). Chain-agnostic HTTP 402 payment protocol for AI agent commerce. Zero dependencies. Passes all 132 conformance test vectors from the [TypeScript reference](https://github.com/s402-protocol/core).

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

```python
from s402 import encode_payment_required

def handle_request(request):
    requirements = {
        "s402Version": "1",
        "accepts": ["exact"],
        "network": "sui:mainnet",
        "asset": "0x2::sui::SUI",
        "amount": "1000000",  # 0.001 SUI
        "payTo": "0xYOUR_ADDRESS",
    }
    return Response(
        status_code=402,
        headers={"payment-required": encode_payment_required(requirements)},
    )
```

## Decode & Validate

```python
from s402 import decode_payment_required, decode_payment_payload, S402Error

# Decode payment requirements (validates + strips unknown keys)
try:
    requirements = decode_payment_required(header_value)
    print(requirements["accepts"])  # ['exact', 'prepaid']
    print(requirements["amount"])   # '1000000'
except S402Error as e:
    print(e.code)             # 'INVALID_PAYLOAD'
    print(e.retryable)        # False
    print(e.suggested_action) # 'Check payload format...'
```

## x402 Compatibility

```python
from s402.compat import normalize_requirements, is_s402, is_x402

# Auto-detect and normalize any format (s402 or x402 V1/V2)
requirements = normalize_requirements(raw_json_from_any_source)
# Always returns s402 format regardless of input
```

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

Passes all 132 machine-readable test vectors from the TypeScript reference implementation. These vectors cover encode, decode, body transport, x402 compat, receipts, validation rejection, key stripping, and roundtrip identity.

```bash
pytest -v
```

## API

| Function | Description |
|----------|-------------|
| `encode_payment_required(req)` | Requirements dict → base64 header string |
| `decode_payment_required(header)` | Base64 header → validated requirements dict |
| `encode_payment_payload(payload)` | Payload dict → base64 header string |
| `decode_payment_payload(header)` | Base64 header → validated payload dict |
| `encode_settle_response(resp)` | Settle dict → base64 header string |
| `decode_settle_response(header)` | Base64 header → validated settle dict |
| `detect_protocol(headers)` | Returns `"s402"`, `"x402"`, or `"unknown"` |
| `normalize_requirements(obj)` | Auto-detect s402/x402, return s402 format |
| `is_valid_amount(s)` | Check canonical non-negative integer string |
| `format_receipt_header(...)` | Build `X-S402-Receipt` header value |
| `parse_receipt_header(header)` | Parse `X-S402-Receipt` header value |

Body transport variants: `encode_requirements_body`, `decode_requirements_body`, `encode_payload_body`, `decode_payload_body`, `encode_settle_body`, `decode_settle_body`.

## Links

- [Wire Format Specification](https://s402-protocol.org/specification) — field-by-field protocol definition
- [TypeScript reference](https://github.com/s402-protocol/core) — the reference implementation (736 tests)
- [Conformance vectors](https://github.com/s402-protocol/core/tree/main/test/conformance) — 132 machine-readable test vectors
- [s402-protocol.org](https://s402-protocol.org) — docs, guides, whitepaper

## License

Apache-2.0
