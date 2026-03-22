---
description: Accept s402 HTTP 402 payments in Python with FastAPI, Flask, or any framework. Uses the official s402 Python package — zero manual base64.
---

# Accept s402 Payments in Python

s402 has an official Python package (`pip install s402`) with the same encode/decode/validate functions as the TypeScript reference. No manual base64 encoding, no hand-rolled validation.

## Install

```bash
pip install s402 fastapi uvicorn httpx
```

## Full Example (FastAPI)

```python
import time
from fastapi import FastAPI, Request, Response
from s402 import (
    encode_payment_required,
    decode_payment_payload,
    encode_settle_response,
    S402_HEADERS,
    S402Error,
)

app = FastAPI()

PAY_TO = "0xYOUR_ADDRESS_HERE"
PRICE = "1000000"  # 0.001 SUI


@app.get("/api/premium-data")
async def premium_data(request: Request):
    payment_header = request.headers.get(S402_HEADERS["PAYMENT"])

    if not payment_header:
        # No payment — return 402 with requirements
        requirements = {
            "s402Version": "1",
            "accepts": ["exact"],
            "network": "sui:testnet",
            "asset": "0x2::sui::SUI",
            "amount": PRICE,
            "payTo": PAY_TO,
            "expiresAt": int(time.time() * 1000) + 300_000,  # 5 minutes
        }
        return Response(
            content="Payment Required",
            status_code=402,
            headers={
                S402_HEADERS["PAYMENT_REQUIRED"]: encode_payment_required(requirements),
            },
        )

    # Decode and validate the payment (s402 handles validation + key stripping)
    try:
        payload = decode_payment_payload(payment_header)
    except S402Error as e:
        return Response(
            content=f'{{"error": "{e}", "code": "{e.code}", "retryable": {str(e.retryable).lower()}}}',
            status_code=400,
            media_type="application/json",
        )

    # In production: verify the transaction on-chain via Sui RPC
    # For this example: accept any valid-shaped payload
    settlement = {
        "success": True,
        "txDigest": "0x" + "f" * 64,
        "finalityMs": 390,
    }

    return Response(
        content='{"data": "Premium content you paid for!"}',
        status_code=200,
        media_type="application/json",
        headers={
            S402_HEADERS["PAYMENT_RESPONSE"]: encode_settle_response(settlement),
        },
    )
```

## Run It

```bash
uvicorn server:app --port 3402
```

## Test It

```bash
# Step 1: Hit the endpoint — get a 402
curl -i http://localhost:3402/api/premium-data

# Step 2: The client decodes requirements, builds a payment, retries
# (Use any s402 client — TypeScript, Python, or curl with manual headers)
```

## AI Agent Auto-Pay Client

A Python agent that handles the full 402 flow automatically:

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

    header = res.headers.get(S402_HEADERS["PAYMENT_REQUIRED"])
    if not header:
        raise S402Error("INVALID_PAYLOAD", "402 without payment-required header")

    requirements = decode_payment_required(header)
    payment = build_payment(requirements)

    return httpx.get(url, headers={
        S402_HEADERS["PAYMENT"]: encode_payment_payload(payment),
    })
```

## x402 Compatibility

The Python package includes the same x402 normalization as TypeScript:

```python
from s402.compat import normalize_requirements, is_s402, is_x402

# Auto-detect and normalize any format
requirements = normalize_requirements(raw_json_from_any_source)
# Always returns s402 format regardless of input (s402, x402 V1, or x402 V2)
```

## Production Hardening

The example above accepts any valid-shaped payload. For production:

- **Verify on-chain**: Call `sui_getTransactionBlock` to confirm the transaction exists, succeeded, and sent the correct amount to your address
- **Replay protection**: Track processed `txDigest` values to prevent reuse
- **Expiry enforcement**: Reject payments where `time.time() * 1000 > expiresAt`
- **HTTPS required**: Payment headers are base64-encoded, not encrypted

## Conformance

The Python implementation passes all [132 conformance test vectors](/guide/conformance) — the same vectors used by the TypeScript reference. The two implementations produce byte-identical wire output.

```bash
cd python
pip install -e ".[dev]"
pytest -v
# 132 passed
```
