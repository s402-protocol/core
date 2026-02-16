# Codebase Tour

A guided walk through the s402 codebase. No prior blockchain or TypeScript knowledge required — we start with the intuition and go deeper from there.

## The Problem s402 Solves

Every time you buy something online, there's an invisible mess behind the scenes. You give Spotify your credit card. Spotify talks to Stripe. Stripe talks to your bank. Your bank talks to Visa. Visa talks to Spotify's bank. Everyone takes a cut. It takes days to settle. And none of it was built for machines — it was built for humans clicking buttons.

Now imagine a world where AI agents browse the internet on your behalf. An agent wants to buy access to a weather API, a research paper, and a premium data feed — all in the same second. It can't type in a credit card number. It can't set up a Stripe account. It needs a way to say "here's money" as naturally as it says "here's my request."

That's what s402 does. It turns payment into an HTTP header — the same kind of thing your browser already sends with every web request. The agent asks for something. The server says "pay me." The agent pays. The server delivers. All in a single request-response cycle, no billing portal required.

## The Flow: What Actually Happens

Think of buying a coffee at a cafe:

1. **You**: "I'll have an espresso."
2. **Barista**: "That's $4." *(the menu/price)*
3. **You**: Hand over $4.
4. **Barista**: Makes your espresso and hands it over.

s402 is the same conversation, happening over HTTP:

1. **Agent**: `GET /api/weather-data` *(just a normal web request)*
2. **Server**: `402 Payment Required` — and in a special header, the "menu": *"I accept these payment methods, on this blockchain, for this much, to this address."*
3. **Agent**: Same request again, but now with a payment header: *"Here's a signed transaction that sends you the money."*
4. **Server**: Forwards the payment to a payment processor, confirms it went through, and delivers the data.

That's the entire protocol. Everything else — the five payment schemes, the security layer, the error codes — is details on top of this core exchange.

In software terms, those four steps use three HTTP headers to carry payment data back and forth:

| Header | Who Sends It | What's Inside |
|--------|-------------|---------------|
| `payment-required` | Server → Agent | "Here's what I need" (price, accepted payment methods, address) |
| `x-payment` | Agent → Server | "Here's my payment" (a signed blockchain transaction) |
| `payment-response` | Server → Agent | "Payment confirmed" (transaction ID, receipt) |

The contents of each header are just JSON, encoded in base64 so they fit in a standard HTTP header. Nothing exotic — any programming language that can make web requests can participate.

## The Three Roles

In the coffee shop analogy, there were only two people: you and the barista. But in real payment systems, there's always a third party. When you swipe a credit card, the barista doesn't verify your card — the card terminal talks to a payment processor (Visa, Square, etc.) that handles the money.

s402 has the same three roles:

**The Client** (you, the customer) — the program that wants to buy something. Could be an AI agent, a mobile app, or a simple script.

**The Resource Server** (the barista) — the website or API selling something. It knows the price and what payment methods it accepts, but it doesn't handle money directly.

**The Facilitator** (the payment processor) — the service that actually verifies the payment is legitimate and broadcasts it to the blockchain. This way the server doesn't need to run its own blockchain node or hold any private keys.

Why three roles instead of two? Because separation of concerns makes everyone's job simpler. The server focuses on serving content. The facilitator focuses on moving money. Nobody does both.

There's also a fourth mode: **direct settlement**, where an agent holds its own keys and handles payment end-to-end — no facilitator needed. Think of it as paying with exact change instead of swiping a card. This is defined as `s402DirectScheme` in the codebase, and it's designed for self-sovereign AI agents that can sign their own transactions.

In the codebase, each role is a class:

```typescript
// The customer — picks a payment method and signs a transaction
const client = new s402Client();

// The shop — knows the price, sends the bill, delivers the goods
const server = new s402ResourceServer();

// The payment processor — verifies and broadcasts transactions
const facilitator = new s402Facilitator();
```

Each class is small (70-155 lines) because it only does one job. The client picks a payment method. The server builds a price tag. The facilitator verifies and settles. None of them know how the others work internally.

## The Plugin System: "What Payment Methods Do You Accept?"

When you walk into a store in a foreign country, you check: "Do they take Visa? Apple Pay? Cash?" If you only have cash and they only take cards, no transaction happens.

s402 works the same way. The server advertises which payment methods (called **schemes**) it accepts. The client checks which ones it knows how to use. If there's a match, payment happens. If not, the client gets a clear error.

The way this matching works in code is through a **registry** — each actor keeps a list of payment methods it supports, organized by blockchain network:

```typescript
// "I can pay with the 'exact' method on Sui mainnet"
client.register('sui:mainnet', exactScheme);

// "I can also pay with the 'prepaid' method on Sui mainnet"
client.register('sui:mainnet', prepaidScheme);

// "On testnet, I only support 'exact'"
client.register('sui:testnet', exactScheme);
```

When the server says "I accept prepaid or exact," the client walks through that list and picks the first one it recognizes:

```typescript
// Server says: "I accept these payment methods"
for (const method of requirements.accepts) {

  // Client checks: "Do I know how to use this one?"
  const scheme = mySchemes.get(method);

  if (scheme) {
    // "Yes — here's my payment"
    return scheme.createPayment(requirements);
  }
}

// "Sorry, I can't pay you with any of those methods"
throw new s402Error('SCHEME_NOT_SUPPORTED');
```

This design has a nice property: you only install the payment methods you actually need. If you only use the simple one-shot payment, you don't carry the code for streaming payments or escrow. And adding a new payment method to the protocol doesn't require changing any existing code — you just write a new plugin and register it.

## The Five Payment Schemes

Why does s402 have five payment methods instead of just one? Because different transactions have fundamentally different shapes. Buying a coffee is not the same as renting an apartment, which is not the same as subscribing to Netflix.

Each of the five schemes handles a different real-world payment pattern:

### Exact — Buying a Coffee

```
Pay once → get the thing → done
```

The simplest case. You pay the exact amount, once, and receive the goods. One blockchain transaction. Think: buying a single API call, downloading a file, unlocking a one-time resource.

**Cost**: ~$0.007 per transaction on Sui.

### Prepaid — A Prepaid Phone Plan

```
Load $50 onto your account → make calls all month → carrier charges against your balance
```

You deposit money upfront into an on-chain account. Then you make hundreds or thousands of API calls with zero gas fees — the server just tracks your usage off-chain and periodically claims from your deposit.

**Cost**: ~$0.014 total for 1,000 calls. That's **500x cheaper** than paying per call with exact.

Why so cheap? Because instead of running a blockchain transaction for every API call, you only run two: one to deposit, one to claim. Everything in between is just the server checking "does this agent still have balance?"

### Stream — A Running Taxi Meter

```
Start the meter → it ticks every second → stop the meter → pay what you owe
```

You open a payment stream with a rate (e.g., $0.001 per second) and a budget cap. The stream runs as long as you're using the service. When you're done, the server claims what you owe.

Perfect for: AI inference (pay per second of compute), video streaming, real-time data feeds, or any service billed by time.

### Escrow — Buying Something on Amazon

```
Money is held by a neutral third party → seller delivers → buyer confirms → money released
```

You lock your payment in a smart contract. The seller sees the money is there but can't touch it yet. Once you confirm delivery, the money is released. If the seller never delivers, the money is automatically refunded after a deadline — and *anyone* can trigger that refund, not just you. No human arbitrator needed for the simple case.

For disputes, an optional third-party arbiter can step in.

### Unlock — Buying a Key to a Locked Box

```
Pay → receive a receipt → use the receipt to decrypt the content
```

The content (a file, a dataset, an article) is stored encrypted on the network. You pay, and in return you get a cryptographic receipt that lets you decrypt it. The encryption system won't give you the decryption key unless it can see your payment receipt on the blockchain.

This is the most Sui-native scheme — it integrates with SEAL (Sui's encryption and access library) and Walrus (decentralized storage). The payment and the decryption are cryptographically linked.

::: info Why exactly five?
Each scheme has a fundamentally different lifecycle that can't be faked with any other. Exact is one-and-done. Prepaid inverts who initiates claims. Stream uses time as the billing unit. Escrow has conditional release with a deadline. Unlock is entangled with an encryption key. "Auction" was considered as a sixth but decomposes into price discovery (not a payment) + settlement (just exact). Five is the irreducible set.
:::

## The Wire Format: How Data Travels

The data that moves between client, server, and facilitator is just **JSON**, encoded as **base64** so it fits in standard HTTP headers.

Base64 is a way to represent any data as plain text characters (A-Z, a-z, 0-9, +, /). You've seen it before if you've ever looked at a long string of letters in a URL or email attachment — that's base64.

So when the server sends payment requirements, the actual HTTP header looks like:

```
payment-required: eyJzNDAyVmVyc2lvbiI6IjEiLCJhY2NlcHRz...
```

Which decodes to readable JSON:

```json
{
  "s402Version": "1",
  "accepts": ["exact", "prepaid"],
  "network": "sui:mainnet",
  "asset": "0x2::sui::SUI",
  "amount": "1000000",
  "payTo": "0xabc123..."
}
```

The encoding and decoding is handled by helper functions:

```typescript
// Server encodes requirements into the header
const header = encodePaymentRequired(requirements);

// Client decodes requirements from the header
const requirements = decodePaymentRequired(header);
```

These functions handle all the edge cases: Unicode characters in extension fields, oversized payloads, malformed base64, invalid JSON. If anything is wrong, you get a clear error instead of garbage data.

## Security: The Trust Boundary

Here's a question that matters a lot when money is involved: **what happens when someone sends you garbage?**

The data in those HTTP headers comes from the open internet. Anyone can send anything. A malicious actor could send:
- A negative payment amount (`"-1000"`)
- An amount with a sneaky decimal (`"1.5"`)
- An expiration time that's actually a string (`"never"`)
- Extra fields designed to confuse your code (`"__proto__": "gotcha"`)

s402 validates everything at the moment it enters the system — the **trust boundary**. This happens during decoding, before any business logic runs:

```typescript
// When data arrives from the internet, it passes through 5 checks:
//
// 1. SIZE CHECK — reject payloads over 64KB
//    (don't even try to parse something massive)
//
// 2. DECODE — base64 → JSON
//    (catch corrupted or fake base64)
//
// 3. SHAPE CHECK — are the required fields present and the right type?
//    (is "amount" actually a string? is "accepts" actually an array?)
//
// 4. VALUE CHECK — are the values valid?
//    (is the amount a real number? no negatives, no leading zeros,
//     no decimals — only clean integers like "1000000")
//
// 5. KEY STRIP — remove any unknown fields
//    (only keep the 18 fields the protocol defines,
//     drop everything else including injection attempts)
```

After data passes this gauntlet, the rest of the code can trust it. This is why the validation code is the longest file in the project (428 lines in `http.ts`) — it's the wall between the untrusted internet and your money.

::: info Why amounts are strings, not numbers
JavaScript numbers lose precision above 2^53. Sui balances can be up to 2^64. The string `"18446744073709551615"` (u64 max) is exact. The number `18446744073709551615` becomes `18446744073709552000`. For money, "close enough" is not enough. All amounts in s402 are strings, validated with a strict regex: `^(0|[1-9][0-9]*)$`.
:::

## Error Handling: Designed for Machines

When something goes wrong in a typical API, you get an error message like "Payment failed." That's fine for a human who can read it and figure out what to do. But an AI agent can't "figure out" what to do from a sentence — it needs structured instructions.

Every s402 error has three parts:

| Field | What It Tells You | Example |
|-------|-------------------|---------|
| `code` | What went wrong (machine-readable) | `STREAM_DEPLETED` |
| `retryable` | Should you try again? | `true` |
| `suggestedAction` | What to do about it | `"Top up the stream deposit"` |

An agent receiving `FACILITATOR_UNAVAILABLE` with `retryable: true` knows to retry or fall back to direct settlement. An agent receiving `SIGNATURE_INVALID` with `retryable: false` knows it needs to rebuild and re-sign the transaction.

There are 14 error codes covering every failure mode: expired requirements, insufficient balance, scheme not supported, network mismatch, mandate exceeded, and more. Each one has a specific recovery hint so agents can self-heal without human intervention.

## The Facilitator: Where Money Actually Moves

The facilitator is the most critical piece — it's the one that actually puts transactions on the blockchain. Its main method, `process()`, follows a careful sequence:

**Step 1: Is this offer still valid?**

Before doing any work, check if the server's payment requirements have expired. If the expiration field says "valid until 3:00 PM" and it's now 3:01 PM, reject immediately. No point verifying a payment for an expired offer.

There's a subtle defense here: the expiration field should be a number (a timestamp), but since it comes from the internet, it might be a string like `"never"`. In JavaScript, comparing `Date.now() > "never"` silently returns `false` — it wouldn't expire. So the facilitator type-checks the field before comparing.

**Step 2: Is this payment legitimate?**

Dispatch to the appropriate payment scheme's verification logic. For a simple exact payment, this means: recover the signer's identity from the signature, simulate the transaction, check that the amount and recipient are correct. For a streaming payment, it's a different check entirely: is the deposit sufficient? Is the rate valid?

Each scheme has its own verification — because what "legitimate" means depends on the payment type.

**Step 3: Are we still on time?**

Check the expiration *again*. Why twice? Because Step 2 (verification/simulation) might take half a second. If the offer expired during that time, broadcasting the payment would waste blockchain gas fees for a transaction the server will reject anyway.

**Step 4: Settle.**

Broadcast the transaction to the blockchain and return the result.

```typescript
// Simplified from facilitator.ts — see source for full implementation

async process(payload, requirements) {

  // Step 1: Is this offer still valid?
  // Type-check first — "never" and NaN would silently bypass the comparison
  if (requirements.expiresAt != null) {
    if (typeof requirements.expiresAt !== 'number')
      return { success: false, errorCode: 'INVALID_PAYLOAD' };
    if (Date.now() > requirements.expiresAt)
      return { success: false, errorCode: 'REQUIREMENTS_EXPIRED' };
  }

  // Step 2: Is this payment legitimate?
  // Each scheme defines its own verification logic
  const scheme = this.resolveScheme(payload.scheme, requirements.network);
  const verification = await scheme.verify(payload, requirements);
  if (!verification.valid)
    return { success: false, errorCode: 'VERIFICATION_FAILED' };

  // Step 3: Are we still on time?
  // Verification may have taken 500ms — don't waste gas on a stale offer
  if (typeof requirements.expiresAt === 'number' && Date.now() > requirements.expiresAt)
    return { success: false, errorCode: 'REQUIREMENTS_EXPIRED' };

  // Step 4: Broadcast the transaction and return the result
  return scheme.settle(payload, requirements);
}
```

## x402 Compatibility: The Migration Layer

You might have heard of [x402](https://github.com/coinbase/x402), Coinbase's HTTP 402 protocol for EVM chains. s402 can talk to x402 servers and vice versa — but this compatibility is a minor convenience feature, not a core concern.

Here's why: x402 only supports one payment scheme (equivalent to s402's "exact"). s402 has five. Building your protocol around x402 compatibility would be like designing a Swiss Army knife around the constraint that it must also work as a butter knife. The butter knife capability is there, but it's not the point.

In practice, the compatibility story is simple:
- Every s402 server always includes "exact" in its accepted schemes — so x402 clients can always pay
- If you encounter an x402 server, there's an optional converter that translates its format to s402's format

The converter ships as a separate import (`s402/compat`) — if you never use it, it's not included in your code. The core protocol is aware of x402 (it can detect x402 responses and always includes `exact` for backward compatibility), but no core logic depends on it.

## What's in the Package, What's Not

The s402 npm package is intentionally narrow. It defines the **protocol** — the wire format, the types, the validation, the dispatch logic. It does *not* include:

**Included** (the protocol):
- Type definitions for all payment data
- Encode/decode functions for HTTP headers
- Client, Server, and Facilitator classes with the plugin system
- Validation for all trust boundary data
- Error codes with recovery hints
- Optional x402 compatibility converter

**Not included** (the implementation):
- No Sui SDK — actual transaction building lives in separate packages
- No smart contracts — the on-chain logic is a separate repository
- No HTTP framework — no Express/Hono middleware baked in
- No key management — how you sign transactions is your business

This separation means the protocol layer is small (1,769 lines), has zero dependencies, and is auditable in an afternoon. The Sui-specific implementation code that actually builds and signs transactions is a separate concern, plugged in through the scheme interfaces.

## The Numbers

| Metric | Value |
|--------|-------|
| Source code | 1,769 lines across 9 files |
| Tests | 207 across 9 suites |
| Dependencies | 0 (production) |
| Bundle size | ~8 KB gzipped |
| Payment schemes | 5 |
| Error codes | 14, each with recovery hints |
| Security audits | 2 passes, property-based fuzz testing |

The entire protocol fits in less code than most React components.
