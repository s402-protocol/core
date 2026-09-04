"""s402 Python Agent Client — auto-pays for jokes from the s402 joke API.

Demonstrates cross-language wire compatibility: this Python client
talks to the TypeScript joke-api server using the s402 protocol.

Usage:
  1. Start the TS server:  npx tsx examples/joke-api/server.ts  (in the s402 TS repo)
  2. Run this client:      python examples/agent_client.py

Requires: pip install httpx  (the only external dep — s402 itself has zero deps)
"""

import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# Use stdlib urllib so this example has zero deps beyond s402 itself
sys.path.insert(0, "src")

from s402 import (
    decode_payment_required,
    decode_settle_response,
    encode_payment_payload,
    S402_HEADERS,
    S402Error,
)

API_URL = "http://localhost:3402/joke"


def pick_offer(requirements: dict) -> dict:
    """Pick the first offer we can pay.

    A wire-v2 402 is a MENU: `accepts` holds one full requirement object per
    offered scheme, each with its own network, asset, amount and payTo. Walk it
    and take the first scheme this client implements — an offer naming a scheme
    we cannot pay is one we skip, not a reason to fail.
    """
    for offer in requirements["accepts"]:
        if offer["scheme"] == "exact":
            return offer
    raise S402Error(
        "SCHEME_NOT_SUPPORTED",
        f"No payable offer: server offered {[o['scheme'] for o in requirements['accepts']]}",
    )


def build_mock_payment(offer: dict) -> dict:
    """Build a mock payment payload for ONE offer (matches the TS mockExactClientScheme)."""
    return {
        "s402Version": "1",
        "scheme": offer["scheme"],
        "payload": {
            "transaction": f"mock-pay-{offer['amount']}-to-{offer['payTo']}",
            "signature": "mock-signature",
        },
    }


def get_joke() -> None:
    """Fetch a joke, auto-paying when the server returns 402."""

    # 1. Request the resource
    print("-> GET /joke")
    try:
        req = Request(API_URL)
        with urlopen(req) as res:
            print(f"<- {res.status} (unexpected — expected 402)")
            return
    except HTTPError as e:
        if e.code != 402:
            print(f"<- {e.code}: {e.read().decode()}")
            return
        response_headers = dict(e.headers)

    # 2. Decode the 402 requirements
    pr_header = response_headers.get(S402_HEADERS["PAYMENT_REQUIRED"])
    if not pr_header:
        print("  No payment-required header in 402 response")
        return

    try:
        requirements = decode_payment_required(pr_header)
    except S402Error as err:
        print(f"  Invalid requirements: {err}")
        return

    print("<- 402 Payment Required")
    print(f"   Resource: {requirements['resource'].get('url', '')}")
    print(f"   Schemes:  [{', '.join(o['scheme'] for o in requirements['accepts'])}]")

    # 3. Pick an offer we can pay, then build and send the payment
    try:
        offer = pick_offer(requirements)
    except S402Error as err:
        print(f"  {err}")
        return

    print(f"   Amount:   {offer['amount']} MIST")
    print(f"   Network:  {offer['network']}")

    payment = build_mock_payment(offer)
    payment_header = encode_payment_payload(payment)

    print(f"-> GET /joke + x-payment ({payment['scheme']})")
    req2 = Request(API_URL, headers={S402_HEADERS["PAYMENT"]: payment_header})
    with urlopen(req2) as res2:
        import json
        data = json.loads(res2.read().decode())

        receipt_header = res2.headers.get(S402_HEADERS["PAYMENT_RESPONSE"])
        receipt = decode_settle_response(receipt_header) if receipt_header else None

        print("<- 200 OK")
        print(f"   Joke: {data['joke']}")
        if receipt:
            print(f"   TX:   {receipt.get('txDigest')}")
            print(f"   Time: {receipt.get('finalityMs')}ms")


if __name__ == "__main__":
    print("\n--- s402 Python Agent Client ---\n")
    try:
        get_joke()
    except Exception as e:
        print(f"\nError: {e}")
        print("Is the TS joke server running? Start it with:")
        print("  npx tsx examples/joke-api/server.ts  (in the s402 TS repo)")
