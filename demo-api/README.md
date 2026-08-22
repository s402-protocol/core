# s402 demo API

A paid HTTP endpoint, running on your machine, with **no wallet, no keys and no network**.

It answers the one question protocol types cannot: *what does a 402 exchange actually look like
over the wire?* Payment verification is stubbed with in-file mock schemes — this demonstrates the
**protocol handshake**, not settlement.

## Run it

```bash
pnpm install                          # from the repo root
pnpm --filter s402-demo-api dev
```

Then, in another terminal:

```bash
curl -i http://localhost:3402/api/joke
```

**Expected — verified 2026-08-22:**

```
HTTP/1.1 402 Payment Required
payment-required: eyJzNDAyVmVyc2lvbiI6IjEiLCJhY2NlcHRzIjpbImV4YWN0Il0s…
```

That header is the entire protocol surface a client needs. Decode it:

```bash
curl -sD- -o/dev/null http://localhost:3402/api/joke \
  | grep -i '^payment-required:' | sed 's/^[^:]*: *//' | tr -d '\r' \
  | base64 -d | python3 -m json.tool
```

```json
{
  "s402Version": "1",
  "accepts": ["exact"],
  "network": "sui:testnet",
  "asset": "0x2::sui::SUI",
  "amount": "1000000",
  "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

## What is here

| Route | Price | Paid? |
|---|---|---|
| `/` | — | Browser UI |
| `/api/catalog` | — | Free — lists every endpoint and its price |
| `/api/stats` | — | Free |
| `/api/joke` | 0.001 SUI | **402** |
| `/api/wisdom` | 0.005 SUI | **402** |
| `/api/alpha` | see catalog | **402** |

## What this proves, and what it does not

**Proves:** the server helpers build a well-formed 402, and the header encoding survives a real
HTTP round trip to a real client.

**Does not prove:** that anyone got paid. The facilitator here is a mock that approves
everything, and `payTo` is 64 a's — deliberately not a real address. Settlement needs
[`@sweefi/sui`](https://www.npmjs.com/package/@sweefi/sui) and a chain.

## Configuration

All optional; the defaults run standalone.

| Env var | Default |
|---|---|
| `PORT` | `3402` |
| `S402_NETWORK` | `sui:testnet` |
| `S402_PAY_TO` | `0x` + 64 × `a` |

## Smaller demo

To see the wire format and the conformance vectors without starting a server, run `pnpm demo`
from the repo root instead. It is faster and covers the encoder, the x402 compat layer, and all
167 vectors.
