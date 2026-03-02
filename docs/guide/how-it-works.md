---
description: How s402 HTTP 402 payments work — the three-request flow, what the facilitator can and cannot do, direct settlement mode, and service discovery.
---

# How It Works

s402 adds a payment negotiation layer to standard HTTP. The flow is simple: a client requests a resource, the server says "pay me first", the client pays, and the server delivers.

## The HTTP 402 Flow

```
Agent                          Server                     Facilitator
  |                              |                            |
  |-- GET /api/premium-data ---->|                            |
  |                              |                            |
  |<---- 402 Payment Required ---|                            |
  |      (payment-required hdr)  |                            |
  |                              |                            |
  |  [read requirements]         |                            |
  |  [choose scheme]             |                            |
  |  [build PTB, sign]           |                            |
  |                              |                            |
  |-- GET /api/premium-data ---->|                            |
  |   (x-payment header)        |--- verify + settle ------->|
  |                              |<--- { success, txDigest } -|
  |<---- 200 + data ------------|                            |
  |      (payment-response hdr)  |                            |
```

### Step by Step

**1. Client requests a resource**

The client sends a normal HTTP request. No special headers needed.

```
GET /api/premium-data HTTP/1.1
Host: api.example.com
```

**2. Server responds with 402**

The server doesn't recognize a payment, so it responds with HTTP 402 and encodes its requirements in the `payment-required` header:

```
HTTP/1.1 402 Payment Required
payment-required: eyJzNDAyVmVyc2lvbiI6IjEiLC...  (base64 JSON)
```

The decoded requirements tell the client everything it needs:
- What schemes are accepted (`exact`, `prepaid`, etc.)
- Which network and asset (`sui:mainnet`, `0x2::sui::SUI`)
- How much to pay (`1000000` MIST = 0.001 SUI)
- Where to pay (`0xrecipient...`)
- When the offer expires (`expiresAt`)

**3. Client builds and signs a payment**

The client picks a scheme from the `accepts` array, builds a Sui Programmable Transaction Block (PTB), and signs it. The signed transaction is encoded in the `x-payment` header.

```
GET /api/premium-data HTTP/1.1
Host: api.example.com
x-payment: eyJzNDAyVmVyc2lvbiI6IjEiLCJzY2hlbWUiOiJleGFjdCI...
```

**4. Server forwards to facilitator**

The server sends the payment payload and original requirements to the facilitator for verification and settlement. The facilitator:
1. Validates the payload structure
2. Recovers the signer address
3. Dry-runs the transaction to verify it will succeed
4. Broadcasts the transaction to Sui
5. Returns the settlement result

**5. Server delivers the resource**

If settlement succeeded, the server delivers the resource with a `payment-response` header containing the transaction digest:

```
HTTP/1.1 200 OK
payment-response: eyJzdWNjZXNzIjp0cnVlLCJ0eERpZ2VzdCI6IjlHTlJZRDFS...
Content-Type: application/json

{ "data": "the premium content" }
```

### What the facilitator can and cannot do

The client sends a **fully signed, pre-built PTB** to the facilitator. The transaction is cryptographically locked at this point. Here is exactly what the facilitator can and cannot do:

| | Facilitator |
|---|---|
| Verify the transaction will succeed (dry-run) | ✅ Can |
| Broadcast the transaction to Sui | ✅ Can |
| Return the settlement result to the server | ✅ Can |
| Reject a payment that fails verification | ✅ Can |
| Change the payment amount | ❌ Cannot |
| Redirect funds to a different recipient | ❌ Cannot |
| Replay the signed transaction for a second payment | ❌ Cannot (Sui nonces prevent replay) |
| Silently fail without the server knowing | ❌ Cannot (settlement failure is an explicit typed error) |

The facilitator cannot steal or alter anything — it is a **delivery service for a pre-sealed package**, not a trusted custodian. This is why direct mode is possible: the same security properties hold whether the client hands the PTB to a facilitator or broadcasts it directly.

## Direct Settlement

For the `exact` scheme, the client can bypass the facilitator entirely by signing and broadcasting the transaction directly to Sui. This is useful when:

- No facilitator is available
- The client wants minimum latency
- The server trusts its own Sui node

Set `settlementMode: 'direct'` in the requirements to indicate support.

## Discovery

Servers can advertise s402 support at `/.well-known/s402.json`:

```json
{
  "s402Version": "1",
  "schemes": ["exact", "prepaid", "escrow", "stream", "unlock"],
  "networks": ["sui:mainnet"],
  "assets": ["0x2::sui::SUI"],
  "directSettlement": true,
  "mandateSupport": true,
  "protocolFeeBps": 50
}
```

This allows agents to discover payment capabilities before making their first request.
