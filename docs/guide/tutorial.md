---
description: Build a working s402 payment flow in 5 minutes. Server + client, copy-paste-run.
---

# Tutorial: Your First Payment Flow

Build a complete HTTP 402 payment flow in 5 minutes. No Sui connection needed — we'll use in-memory mocks to demonstrate the full protocol.

## What You'll Build

```
Client                    Server
  |--- GET /joke -------->|
  |<-- 402 "pay me" ------|
  |                       |
  |  (build mock payment) |
  |--- GET + payment ---->|
  |<-- 200 + joke --------|
```

A joke API that requires payment. The client gets a 402, builds a payment, retries, and gets the joke.

## Prerequisites

```bash
mkdir s402-demo && cd s402-demo
npm init -y
npm install s402
```

> **Node.js >= 18 required** (for native `fetch` and `Headers`).

## Step 1: The Server

Create `server.ts`:

```typescript
import {
  encodePaymentRequired,
  decodePaymentPayload,
  encodeSettleResponse,
  S402_HEADERS,
  type s402PaymentRequirements,
  type s402SettleResponse,
} from 's402';

const PORT = 3402;
const PRICE = '1000000'; // 0.001 SUI

const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: PRICE,
  payTo: '0x' + 'a'.repeat(64), // demo address
  expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
};

const jokes = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'There are 10 kinds of people: those who understand binary and those who don\'t.',
  'A SQL query walks into a bar, sees two tables, and asks: "Can I JOIN you?"',
];

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    if (new URL(req.url).pathname !== '/joke') {
      return new Response('Not found', { status: 404 });
    }

    // Check for payment header
    const paymentHeader = req.headers.get(S402_HEADERS.PAYMENT);
    if (!paymentHeader) {
      // No payment — send 402
      return new Response('Payment Required', {
        status: 402,
        headers: {
          [S402_HEADERS.PAYMENT_REQUIRED]: encodePaymentRequired(requirements),
        },
      });
    }

    // Verify payment (in production, forward to a facilitator)
    try {
      const payload = decodePaymentPayload(paymentHeader);

      // In production: facilitator.process(payload, requirements)
      // For this demo, we accept any valid-shaped payload
      const settlement: s402SettleResponse = {
        success: true,
        txDigest: '0x' + 'f'.repeat(64),
        finalityMs: 390,
      };

      const joke = jokes[Math.floor(Math.random() * jokes.length)];

      return new Response(JSON.stringify({ joke }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          [S402_HEADERS.PAYMENT_RESPONSE]: encodeSettleResponse(settlement),
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
  },
});

console.log(`Joke API running on http://localhost:${PORT}/joke`);
console.log(`Price: ${PRICE} MIST (0.001 SUI)`);
```

## Step 2: The Client

Create `client.ts`:

```typescript
import {
  extractRequirementsFromResponse,
  encodePaymentPayload,
  decodeSettleResponse,
  S402_HEADERS,
  type s402ExactPayload,
} from 's402';

const API_URL = 'http://localhost:3402/joke';

async function getJoke() {
  // 1. Request the resource
  console.log('→ GET /joke');
  const res = await fetch(API_URL);

  if (res.status !== 402) {
    console.log('  Unexpected status:', res.status);
    return;
  }

  // 2. Read the 402 requirements
  const requirements = extractRequirementsFromResponse(res);
  if (!requirements) {
    console.log('  No payment requirements in response');
    return;
  }

  console.log('← 402 Payment Required');
  console.log(`  Schemes: [${requirements.accepts.join(', ')}]`);
  console.log(`  Amount: ${requirements.amount} MIST`);
  console.log(`  Network: ${requirements.network}`);
  console.log(`  Pay to: ${requirements.payTo}`);

  // 3. Build a payment payload
  //    In production: use @mysten/sui to build a real PTB and sign it.
  //    For this demo: a mock payload that satisfies the protocol shape.
  const payment: s402ExactPayload = {
    s402Version: '1',
    scheme: 'exact',
    payload: {
      transaction: btoa('mock-signed-ptb-bytes'),  // would be real PTB
      signature: btoa('mock-ed25519-signature'),    // would be real sig
    },
  };

  // 4. Retry with payment
  console.log('→ GET /joke + x-payment header');
  const paidRes = await fetch(API_URL, {
    headers: {
      [S402_HEADERS.PAYMENT]: encodePaymentPayload(payment),
    },
  });

  if (paidRes.status === 200) {
    // 5. Read the joke and settlement receipt
    const data = await paidRes.json();
    const receiptHeader = paidRes.headers.get(S402_HEADERS.PAYMENT_RESPONSE);
    const receipt = receiptHeader ? decodeSettleResponse(receiptHeader) : null;

    console.log('← 200 OK');
    console.log(`  Joke: ${data.joke}`);
    if (receipt) {
      console.log(`  TX Digest: ${receipt.txDigest}`);
      console.log(`  Finality: ${receipt.finalityMs}ms`);
    }
  } else {
    console.log('← Error:', paidRes.status, await paidRes.text());
  }
}

getJoke();
```

## Step 3: Run It

In one terminal, start the server:

```bash
npx tsx server.ts
# or: bun server.ts
```

In another terminal, run the client:

```bash
npx tsx client.ts
```

You should see:

```
→ GET /joke
← 402 Payment Required
  Schemes: [exact]
  Amount: 1000000 MIST
  Network: sui:testnet
  Pay to: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
→ GET /joke + x-payment header
← 200 OK
  Joke: Why do programmers prefer dark mode? Because light attracts bugs.
  TX Digest: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
  Finality: 390ms
```

## What Just Happened

1. **Client** sent a normal GET request
2. **Server** responded with HTTP 402 + payment requirements in the `payment-required` header
3. **Client** decoded the requirements, saw it accepts `exact`, built a payment payload
4. **Client** retried the request with the signed payload in the `x-payment` header
5. **Server** decoded the payment, verified it (mocked here), settled it, and returned the joke with a receipt in the `payment-response` header

This is the complete s402 protocol flow. In production, step 3 uses the Sui SDK to build a real PTB, and step 5 uses a facilitator to verify and broadcast on-chain.

## Making It Real

To connect this to Sui, replace the mock payment in `client.ts` with real Sui SDK code:

```typescript
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Build a real payment
const tx = new Transaction();
const [coin] = tx.splitCoins(tx.gas, [requirements.amount]);
tx.transferObjects([coin], requirements.payTo);

const keypair = /* your keypair */;
const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io' });
const signed = await client.signTransaction({ transaction: tx, signer: keypair });

const payment: s402ExactPayload = {
  s402Version: '1',
  scheme: 'exact',
  payload: {
    transaction: signed.bytes,   // base64 TX bytes
    signature: signed.signature,  // base64 signature
  },
};
```

And replace the mock verification in `server.ts` with a real facilitator that broadcasts the TX on-chain.

## Next Steps

- **[Which Scheme Do I Need?](/guide/which-scheme)** — pick the right scheme for your use case
- **[Error Handling](/api/errors)** — handle failures gracefully
- **[Security Model](/security)** — understand the trust boundaries
- **[API Reference](/api/)** — full type and function reference
