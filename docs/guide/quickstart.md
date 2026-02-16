# Quick Start

## Install

```bash
npm install s402
```

> **ESM-only.** Requires Node.js >= 18. CommonJS `require()` is not supported.

## Sub-path Imports

s402 provides focused sub-paths so you only import what you need:

```typescript
import { ... } from 's402';           // Everything
import type { ... } from 's402/types'; // Types + constants only (zero runtime)
import { ... } from 's402/http';       // HTTP encode/decode
import { ... } from 's402/compat';     // x402 interop
import { ... } from 's402/errors';     // Error types
```

## Types Only (Most Common)

Most consumers only need the TypeScript types — for building servers, clients, or facilitators:

```typescript
import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
  s402Scheme,
} from 's402';
```

This imports nothing at runtime. Zero bytes in your bundle.

## Build a 402 Response (Server)

When a client requests a paid resource, respond with HTTP 402 and the payment requirements:

```typescript
import {
  encodePaymentRequired,
  type s402PaymentRequirements,
} from 's402';

function handleRequest(req: Request): Response {
  const requirements: s402PaymentRequirements = {
    s402Version: '1',
    accepts: ['exact', 'prepaid'],
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '1000000', // 0.001 SUI
    payTo: '0xYOUR_ADDRESS',
    expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute window
  };

  return new Response('Payment Required', {
    status: 402,
    headers: {
      'payment-required': encodePaymentRequired(requirements),
    },
  });
}
```

## Read a 402 Response (Client)

When you receive a 402, decode the requirements and decide how to pay:

```typescript
import {
  decodePaymentRequired,
  detectProtocol,
  S402_HEADERS,
} from 's402';

const response = await fetch('https://api.example.com/premium-data');

if (response.status === 402) {
  // Auto-detect: is this s402 or x402?
  const protocol = detectProtocol(response.headers);
  console.log(protocol); // 's402' | 'x402' | 'unknown'

  // Decode the requirements
  const header = response.headers.get(S402_HEADERS.PAYMENT_REQUIRED)!;
  const requirements = decodePaymentRequired(header);

  console.log(requirements.accepts); // ['exact', 'prepaid']
  console.log(requirements.amount);  // '1000000'
  console.log(requirements.network); // 'sui:mainnet'

  // Now build a payment using @mysten/sui or your own PTB builder
}
```

## Handle Errors

Every s402 error tells the client what went wrong and what to do about it:

```typescript
import { s402Error } from 's402';

try {
  await facilitator.settle(payload, requirements);
} catch (e) {
  if (e instanceof s402Error) {
    console.log(e.code);            // 'INSUFFICIENT_BALANCE'
    console.log(e.retryable);       // false
    console.log(e.suggestedAction); // 'Top up wallet balance...'

    // AI agents can use these fields to self-recover
    if (e.retryable) {
      // automatic retry logic
    }
  }
}
```

## x402 Interop

s402 can read and convert x402 payment requirements bidirectionally:

```typescript
import {
  normalizeRequirements,
  isS402,
  isX402,
  toX402Requirements,
  fromX402Requirements,
} from 's402/compat';

// Auto-normalize: works with s402 or x402 (V1 or V2) format
const requirements = normalizeRequirements(rawJsonFromAnySource);

// Convert for legacy x402 clients
const x402Reqs = toX402Requirements(s402Requirements);
```

## What's Next?

- **[How It Works](/guide/how-it-works)** — the full HTTP flow, step by step
- **[Payment Schemes](/schemes/exact)** — choose the right scheme for your use case
- **[s402 vs x402](/comparison)** — understand the differences
- **[API Reference](/api/)** — full type and function reference
