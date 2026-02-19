# Accept s402 Payments in Python

s402 is language-agnostic. This example uses FastAPI, but the same pattern works in Flask, Django, or any Python HTTP framework. No SDK required — just base64, JSON, and one Sui RPC call.

## The 30-Second Version

An s402 server does three things:

1. **Return 402** with a `payment-required` header (base64 JSON)
2. **Decode** the `x-payment` header from the client's retry
3. **Verify** the Sui transaction via RPC

That's it. ~40 lines of code.

## Full Example (FastAPI)

```python
import base64, json, time
from fastapi import FastAPI, Request, Response
import httpx

app = FastAPI()

# Your Sui address — receives payments
PAY_TO = "0xYOUR_ADDRESS_HERE"
PRICE_MIST = "1000000"  # 0.001 SUI
SUI_RPC = "https://fullnode.testnet.sui.io:443"


def encode_b64_json(obj: dict) -> str:
    return base64.b64encode(json.dumps(obj).encode()).decode()


def decode_b64_json(b64: str) -> dict:
    return json.loads(base64.b64decode(b64))


def make_402() -> Response:
    """Return HTTP 402 with s402 payment requirements."""
    requirements = {
        "s402Version": "1",
        "accepts": ["exact"],
        "network": "sui:testnet",
        "asset": "0x2::sui::SUI",
        "amount": PRICE_MIST,
        "payTo": PAY_TO,
        "expiresAt": int(time.time() * 1000) + 300_000,  # 5 minutes
    }
    return Response(
        content=json.dumps({"error": "Payment Required"}),
        status_code=402,
        headers={"payment-required": encode_b64_json(requirements)},
        media_type="application/json",
    )


async def verify_sui_tx(tx_digest: str) -> bool:
    """Verify a transaction exists on Sui and was successful."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(SUI_RPC, json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sui_getTransactionBlock",
            "params": [tx_digest, {"showEffects": True, "showBalanceChanges": True}],
        })
    result = resp.json().get("result", {})
    status = result.get("effects", {}).get("status", {}).get("status")
    return status == "success"


@app.get("/api/premium-data")
async def premium_data(request: Request):
    # Check for payment
    payment_header = request.headers.get("x-payment")

    if not payment_header:
        return make_402()

    # Decode and verify payment
    payload = decode_b64_json(payment_header)
    tx_digest = payload.get("payload", {}).get("txDigest")

    if not tx_digest or not await verify_sui_tx(tx_digest):
        return Response(
            content=json.dumps({"error": "Payment verification failed"}),
            status_code=402,
            media_type="application/json",
        )

    # Payment verified — serve premium content
    return {"data": "This is premium data you paid for!", "txDigest": tx_digest}
```

## Run It

```bash
pip install fastapi uvicorn httpx
uvicorn server:app --port 3402
```

## Test It

```bash
# Step 1: Get the 402 response
curl -i http://localhost:3402/api/premium-data
# → 402 with payment-required header

# Step 2: Decode the requirements
curl -s http://localhost:3402/api/premium-data \
  | python3 -c "import sys,json; print(json.dumps(json.loads(sys.stdin.read()), indent=2))"
```

The client-side payment flow (building the Sui transaction, signing, retrying) is handled by [`@sweefi/cli`](https://www.npmjs.com/package/@sweefi/cli) or any s402 client.

## Production Hardening

The example above is minimal. For production, add:

- **Amount verification**: Check that the transaction actually sent the required amount to your address (inspect `balanceChanges` in the RPC response)
- **Replay protection**: Track processed `txDigest` values to prevent replaying the same payment
- **Expiry enforcement**: Reject payments made after `expiresAt`
- **HTTPS**: Required — payment headers are base64, not encrypted

## Key Takeaway

The server side of s402 is trivial in any language. The complexity lives in the _client_ (building Sui transactions) and the _protocol_ (types, encoding). Your server just decodes base64 and checks one RPC call.
