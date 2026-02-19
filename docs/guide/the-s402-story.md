# The s402 Story: From a 27-Year-Old Promise to the Future of Internet Payments

> A progressive guide to understanding s402 — from "explain like I'm 10" through to enterprise architecture. Whether you're a founder pitching to a board, a junior engineer reading your first TypeScript, or a staff architect evaluating protocol design, there's a chapter here for you.

---

## Table of Contents

- [Chapter 1: The Big Idea](#chapter-1-the-big-idea) — *Anyone can read this*
- [Chapter 2: The Business Case](#chapter-2-the-business-case) — *Founders, PMs, and C-suite*
- [Chapter 3: How It Works](#chapter-3-how-it-works) — *Junior engineers and curious developers*
- [Chapter 4: The Code, Annotated](#chapter-4-the-code-annotated) — *Mid-level TypeScript engineers*
- [Chapter 5: Architecture Deep Dive](#chapter-5-architecture-deep-dive) — *Senior engineers*
- [Chapter 6: Design Decisions & Trade-offs](#chapter-6-design-decisions--trade-offs) — *Staff+ / Principal / Architects*
- [Sources & Citations](#sources--citations)

---

## Chapter 1: The Big Idea

*Read time: 5 minutes. No code. No jargon.*

### The internet has a missing feature

Imagine you walk into a library. You can browse the shelves, read any book, use the computers — all free. That's the internet today. Almost everything is free, paid for by ads or subscriptions.

But what if some things *should* cost a tiny amount? What if an AI assistant could pay 1/10th of a penny to look something up for you? What if a robot could pay another robot for data, without a human entering credit card numbers?

In 1997 — **twenty-nine years ago** — the people who designed the internet's plumbing actually planned for this. They created a special code called **HTTP 402: Payment Required**. It was meant to be the internet's way of saying: *"This costs money. Here's how to pay."*

But in 1997, there was no good way to send tiny payments over the internet. No digital wallets. No cryptocurrency. So the code was marked **"reserved for future use"** and sat there, unused, in every web browser and every web server on the planet. For nearly three decades.

> "This status code is reserved for future use."
> — [RFC 2068, Section 10.4.3](https://www.rfc-editor.org/rfc/rfc2068.html) (January 1997)

### The future finally arrived

In 2025, Coinbase — one of the biggest cryptocurrency companies — built a protocol called [x402](https://www.coinbase.com/developer-platform/discover/launches/x402) that finally gave HTTP 402 a purpose. x402 lets websites charge for content using stablecoin payments on blockchains like Base and Solana. It processed [over 100 million payments](https://www.x402.org/) in its first few months.

x402 proved the concept works. But it was built for one specific blockchain family (EVM — Ethereum and its cousins) and one payment model (pay per request). It's like building a toll road with only one lane.

**s402** is what happens when you redesign that toll road for a blockchain called [Sui](https://sui.io), which can do things Ethereum simply can't:

- **Atomic transactions**: Instead of "verify... wait... settle" (two steps with a gap), Sui can do both in a single transaction that either fully succeeds or fully fails. No gap. No risk.
- **Sub-second finality**: Sui confirms transactions in ~400 milliseconds. Ethereum takes 12+ seconds. That's the difference between a conversation and a phone call with long pauses.
- **Five payment models**: Not just "pay once per request," but also subscriptions (prepaid), escrow (safe trades), streaming (pay per second), and pay-to-decrypt (buy encrypted content).

### Why does this matter?

AI agents are coming. [McKinsey projects](https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-agentic-commerce-opportunity-how-ai-agents-are-ushering-in-a-new-era-for-consumers-and-merchants) the global agentic commerce market will reach **$3–5 trillion by 2030**. These agents will need to pay for things — API calls, data, compute — automatically, without a human clicking "buy." They need a payment protocol that's:

1. **Fast** (sub-second, not minutes)
2. **Cheap** (fractions of a penny, not dollars of gas fees)
3. **Programmable** (smart enough for agents, not just humans)
4. **Built into HTTP** (the language the internet already speaks)

That's s402.

---

## Chapter 2: The Business Case

*Read time: 10 minutes. For founders, board presentations, and anyone evaluating "why not just use x402?"*

### The x402 story: proof of concept, then reality

Coinbase launched x402 in May 2025. It was a landmark moment — the first serious attempt to activate HTTP 402 at scale. Within months, it had processed over 100 million payments and $24 million in volume. Cloudflare announced integration. The x402 Foundation was formed. [Stripe even added x402 crypto payment support for AI agents on Base.](https://capwolf.com/stripe-enables-ai-agents-with-x402-crypto-payments-on-base/)

Then reality set in. By February 2026, x402's daily transaction volume had dropped from ~731,000/day to ~57,000/day — a **decline of more than 92%** from the peak, according to [Artemis analytics data reported by BeInCrypto](https://beincrypto.com/x402-transactions-drop-in-feb/). The "Infrastructure & Utilities" segment — services like x402secure.com, agentlisa.ai, and pay.codenut.ai — saw activity drop more than 80%.

This doesn't mean x402 failed. It means the first wave of hype settled, and what remains is a foundation that needs better economics to scale.

### The economics problem x402 can't solve

Here's the fundamental issue: **per-call settlement scales gas linearly with call volume, creating overhead that grows with usage.**

Consider an AI agent making 1,000 API calls at $0.001 each ($1.00 total value). With x402's per-call settlement (figures use February 2026 spot rates: Base at 0.012 Gwei / ETH ~$2,000):

| Cost | Amount |
|------|--------|
| API usage (1,000 calls × $0.001) | $1.00 |
| Gas fees (1,000 × ~$0.0016/tx on Base) | **~$1.60** |
| **Total** | **~$2.60** |

*Gas on Base is highly volatile with ETH price. At $4,000 ETH and higher congestion, this figure rises to $6–13. For low-value high-frequency calls, gas overhead regularly exceeds API value.*

x402 also runs on Solana (via the x402 Foundation), where gas is ~$0.00025/tx — making 1,000 calls cost ~$0.25 in gas. That is significantly cheaper than Base. But it still scales linearly: 10,000 calls = $2.50, 100,000 calls = $25. The per-call settlement model has a structural ceiling regardless of which chain x402 runs on.

s402's Prepaid scheme breaks this linearity with a fixed 2-transaction cost regardless of call count.

### How s402 solves this: the Prepaid scheme

s402's Prepaid scheme on Sui flips the model:

| Cost | Amount |
|------|--------|
| API usage (1,000 calls × $0.001) | $1.00 |
| Gas: 1 deposit TX | $0.007 |
| Gas: 1 claim TX | $0.007 |
| **Total** | **$1.014** |

That's **$0.014 in gas** for 1,000 calls instead of $7.00. The agent deposits once, uses the API 1,000 times off-chain, and the provider claims once. Two on-chain transactions instead of 1,000.

This is only possible because of Sui's architecture:
- **Shared objects** enable the on-chain Balance that both parties can interact with
- **PTBs** make the deposit and claim atomic (no partial failures)
- **Sub-second finality** means deposits confirm instantly

### s402 vs x402: the full comparison

| Dimension | x402 V1 (Base) | x402 V2 (Multi-chain) | s402 (Sui) |
|-----------|----------------|----------------------|------------|
| **Chains** | Base, Ethereum | Base, Solana, ACH, cards | Sui |
| **Settlement** | Two-step (temporal gap) | Two-step + deferred Extensions | Atomic (single PTB) |
| **Finality** | ~2s (Base) | ~2s Base / ~400ms Solana opt. | ~400ms |
| **Payment models** | Exact only | Exact + session/deferred (app-layer) | Five: protocol-enforced on-chain |
| **On-chain usage enforcement** | No | No | Yes (Move contract) |
| **Gas / 1K calls (Exact)** | ~$1.60 (volatile) | ~$0.25 (Solana) | ~$7.00 |
| **Gas / 1K calls (session model)** | n/a (state channels: ~$0.014, off-protocol) | Application-layer | **$0.014 (Prepaid, on-chain enforced)** |
| **Agent authorization** | None | None | AP2-aligned mandate delegation |
| **Direct settlement** | No | No | Yes |
| **Receipts** | Off-chain | Off-chain | On-chain NFT proofs |
| **x402 compatibility** | Native | Native | Full (via `s402/compat` layer) |

*Note: x402 V2 (December 2025) is a significant evolution — multi-chain support, formalized Extensions, and backing from Google, Cloudflare, and Visa via the x402 Foundation. s402's differentiation is on-chain contract enforcement of payment caps and Sui's PTB atomicity, not "more schemes" alone.*

### Why not just build a Sui adapter for x402?

This is the most common question. The answer is architectural:

1. **x402's type system assumes one scheme.** x402's `PaymentRequirements` has a single `scheme` field. s402 has an `accepts` array because the server needs to advertise *multiple* schemes — "I accept exact payments, prepaid deposits, or streams."

2. **x402's verification model doesn't support PTBs.** x402 separates verify and settle into two distinct operations with a temporal gap. Sui's PTBs can atomically verify and settle in one transaction. Wrapping PTBs in x402's two-step model throws away Sui's biggest advantage.

3. **x402 has no concept of ongoing payment relationships.** Streams, prepaid balances, and escrows are stateful — they exist on-chain beyond a single request/response. x402's model is stateless per-request.

4. **Compatibility is already solved.** s402's `exact` scheme *is* x402. The wire format is identical. An x402 client can talk to an s402 server out of the box. The `s402/compat` layer handles format normalization in both directions. Building a "Sui adapter for x402" would give you less capability, not more.

### The ecosystem vision

s402 is the **protocol layer** — it defines what goes over the wire. It's the foundation for:

- **SweePay**: The reference implementation. Sui-specific scheme implementations, SDK, and developer tools.
- **SweeWorld**: The marketplace. Where services advertise their s402 endpoints and agents discover them.

```
┌──────────────────────────────────────────────┐
│              SweeWorld (Discovery)            │
│          Agents find services to pay for      │
├──────────────────────────────────────────────┤
│              SweePay (Implementation)         │
│     Sui-specific: PTB builders, gas station,  │
│     scheme implementations, SDK              │
├──────────────────────────────────────────────┤
│               s402 (Protocol)                │  ← You are here
│    Wire format, types, HTTP encoding,         │
│    scheme interfaces, error model            │
├──────────────────────────────────────────────┤
│                Sui (Blockchain)              │
│    PTBs, object model, sub-second finality   │
└──────────────────────────────────────────────┘
```

---

## Chapter 3: How It Works

*Read time: 15 minutes. For junior engineers and anyone who wants to understand the payment flow step by step.*

### The three actors

Every s402 payment involves three participants:

```
┌─────────┐         ┌─────────────────┐         ┌──────────────┐
│  Client  │ ◄─────► │ Resource Server  │ ◄─────► │  Facilitator │
│ (payer)  │  HTTP   │  (the website)  │  HTTP   │ (the bank)   │
└─────────┘         └─────────────────┘         └──────────────┘
```

Think of it like buying coffee:

- **Client**: You (the customer). You have a wallet with money in it.
- **Resource Server**: The coffee shop. It has something you want (data, an API, content).
- **Facilitator**: The payment processor (like Square or Stripe). It verifies your payment is legit and actually moves the money.

There's also an optional fourth mode: **Direct Settlement**, where the client is sophisticated enough to settle the payment themselves (like paying cash directly — no card processor needed).

### The payment flow (step by step)

Let's trace a simple "exact" payment — the most basic scheme:

**Step 1: Client requests a resource**

```
Client → Server: GET /api/weather?city=tokyo
```

Just a normal HTTP request. The client wants weather data.

**Step 2: Server says "that'll cost you"**

```
Server → Client: HTTP 402 Payment Required
  Header: payment-required: eyJzNDAyVmVyc2lvbiI6IjEi...  (base64 JSON)
```

The server responds with status code 402. The `payment-required` header contains the **payment requirements** — a JSON object encoded as base64. Decoded, it looks like:

```json
{
  "s402Version": "1",
  "accepts": ["exact"],
  "network": "sui:mainnet",
  "asset": "0x2::sui::SUI",
  "amount": "1000000",
  "payTo": "0xCAFE...",
  "facilitatorUrl": "https://pay.example.com",
  "expiresAt": 1739750400000
}
```

This tells the client: *"I accept exact payments on Sui mainnet. Send 1,000,000 MIST (0.001 SUI) to address 0xCAFE. Use this facilitator. You have until this timestamp."*

**Step 3: Client builds and signs a payment**

The client (or its wallet) builds a Sui transaction that transfers 1,000,000 MIST to 0xCAFE, signs it, and encodes the result:

```json
{
  "s402Version": "1",
  "scheme": "exact",
  "payload": {
    "transaction": "AAAB...",
    "signature": "AAAC..."
  }
}
```

**Step 4: Client retries with payment attached**

```
Client → Server: GET /api/weather?city=tokyo
  Header: x-payment: eyJzNDAyVmVyc2lvbiI6IjEiLC...  (base64 of the above)
```

Same request, but now with the `x-payment` header containing the signed payment.

**Step 5: Server sends payment to facilitator**

The server decodes the payment header and forwards it to the facilitator:

```
Server → Facilitator: POST /settle
  Body: { payload, requirements }
```

**Step 6: Facilitator verifies and settles (atomically)**

The facilitator:
1. Checks the requirements haven't expired
2. Checks the scheme matches what's accepted
3. Calls the scheme's `verify()` — checks the signature, does a dry-run simulation
4. Checks expiration *again* (in case verification took too long)
5. Calls the scheme's `settle()` — broadcasts the transaction to Sui

On Sui, steps 3-5 happen in a **single Programmable Transaction Block (PTB)**. Either everything succeeds, or nothing does. There's no state where "verification passed but settlement failed."

**Step 7: Server returns the resource**

```
Server → Client: HTTP 200 OK
  Header: payment-response: eyJzdWNjZXNzIjp0cnVl...
  Body: { "city": "tokyo", "temp": 22, "condition": "sunny" }
```

The `payment-response` header contains the settlement result:

```json
{
  "success": true,
  "txDigest": "8Hn3kF...",
  "finalityMs": 380
}
```

Done. The whole exchange took less than a second.

### The five payment schemes

s402 doesn't just do one-shot payments. It supports five different payment *shapes*, each designed for a different economic relationship:

| Scheme | When to use it | Real-world analogy |
|--------|---------------|-------------------|
| **Exact** | One-time purchase | Buying a coffee |
| **Prepaid** | High-frequency API access | A subway card you load with credit |
| **Escrow** | Trustless commerce | An eBay purchase with buyer protection |
| **Unlock** | Pay-to-decrypt content | Buying a movie on iTunes |
| **Stream** | Continuous access | A taxi meter running while you ride |

Each scheme has its own verification logic. The facilitator doesn't use shared code between schemes — it **dispatches** to the right scheme's implementation. This is a critical design choice (more on this in Chapter 5).

### The wire format

All s402 data travels in HTTP headers as **base64-encoded JSON**. This is the same format x402 uses, which is what makes them wire-compatible.

```
 Raw JSON object                    Base64 string in header
┌─────────────────┐    encode     ┌─────────────────────────┐
│ { "s402Version": │ ──────────►  │ eyJzNDAyVmVyc2lvbiI6... │
│   "1", ...      }│              │                         │
└─────────────────┘    decode     └─────────────────────────┘
                     ◄──────────
```

Three headers carry s402 data:

| Header | Direction | What it carries |
|--------|-----------|----------------|
| `payment-required` | Server → Client | Payment requirements (in 402 response) |
| `x-payment` | Client → Server | Signed payment payload (in retry request) |
| `payment-response` | Server → Client | Settlement result (in 200 response) |

### The error model

When something goes wrong, s402 doesn't just say "error." Every error includes three pieces of information:

```typescript
{
  code: "INSUFFICIENT_BALANCE",     // What went wrong
  retryable: false,                 // Should the client try again?
  suggestedAction: "Top up wallet"  // What should the client DO?
}
```

This is designed for **AI agents** that need to self-recover. An agent doesn't need a human to read an error message — it needs a machine-readable code, a boolean "try again?", and a recovery hint.

---

## Chapter 4: The Code, Annotated

*Read time: 20 minutes. For mid-level TypeScript engineers who want to understand the actual implementation.*

### Project structure

```
src/
├── types.ts        # Every type in the protocol (the "spec")
├── http.ts         # Encode/decode for HTTP headers + validators
├── scheme.ts       # Interfaces that scheme implementations must fulfill
├── client.ts       # Client-side scheme registry
├── server.ts       # Server-side requirement builder
├── facilitator.ts  # Payment dispatcher (verify + settle)
├── compat.ts       # x402 ↔ s402 conversion (opt-in)
├── errors.ts       # Typed errors with recovery hints
└── index.ts        # Barrel export (re-exports everything)
```

Zero runtime dependencies. The entire package is pure TypeScript type definitions + encoding logic. No Sui SDK, no crypto libraries, no HTTP framework.

### The type system (types.ts)

The type system is the heart of s402. Let's walk through it piece by piece.

**Payment schemes — a union type:**

```typescript
// A "union type" means a value can be one of several options.
// Think of it like a dropdown menu — you pick exactly one.
//
// This defines the five payment schemes s402 supports.
// The `type` keyword means this exists only at compile time —
// it disappears completely when TypeScript compiles to JavaScript.
export type s402Scheme = 'exact' | 'stream' | 'escrow' | 'unlock' | 'prepaid';
```

**Payment requirements — what the server sends in a 402 response:**

```typescript
// An `interface` defines the shape of an object.
// Every field listed here is something you'll find in the JSON
// that travels in the `payment-required` HTTP header.
export interface s402PaymentRequirements {

  // === Required fields (every 402 response has these) ===

  s402Version: typeof S402_VERSION;   // Always "1". The `typeof` means
                                       // TypeScript enforces it's literally "1",
                                       // not just any string.

  accepts: s402Scheme[];               // Array of schemes the server accepts.
                                       // e.g., ["exact", "stream"]
                                       // The [] means "array of".

  network: string;                     // Which Sui network. e.g., "sui:mainnet"
  asset: string;                       // Which coin. e.g., "0x2::sui::SUI"
  amount: string;                      // How much, in base units. String to avoid
                                       // JavaScript number precision issues.
                                       // "1000000" = 0.001 SUI (in MIST)
  payTo: string;                       // Recipient's Sui address.

  // === Optional fields (the ? means "might not be present") ===

  facilitatorUrl?: string;             // Where to send the payment for settlement.
                                       // Omit for direct settlement.

  mandate?: s402MandateRequirements;   // Agent spending authorization (AP2).
  protocolFeeBps?: number;             // Fee in basis points. 100 bps = 1%.
  expiresAt?: number;                  // Unix timestamp (milliseconds).
                                       // Facilitator MUST reject after this time.

  // === Scheme-specific sub-objects ===
  // Only the relevant one is populated based on which scheme is used.

  stream?: s402StreamExtra;            // Stream-specific config
  escrow?: s402EscrowExtra;            // Escrow-specific config
  unlock?: s402UnlockExtra;            // Unlock-specific config
  prepaid?: s402PrepaidExtra;          // Prepaid-specific config

  // === Forward-compatible extension bag ===

  extensions?: Record<string, unknown>;
  // Record<string, unknown> means "an object where keys are strings
  // and values can be anything." This is the escape hatch for future
  // protocol extensions without breaking existing code.
}
```

**Payment payloads — the discriminated union:**

This is one of the most elegant patterns in the codebase. Each payment scheme has a different payload shape, but they all share a common base:

```typescript
// The "base" that every payload shares.
export interface s402PaymentPayloadBase {
  s402Version: typeof S402_VERSION;    // Protocol version
  scheme: s402Scheme;                   // Which scheme this payload is for
}

// Exact payment: just a signed transaction.
export interface s402ExactPayload extends s402PaymentPayloadBase {
  scheme: 'exact';                      // Literal "exact" — not just any scheme.
                                        // This is what makes it a "discriminated union."
  payload: {
    transaction: string;                // Base64-encoded signed TX bytes
    signature: string;                  // Base64-encoded signature
  };
}

// Prepaid payment: deposit TX + rate commitment.
export interface s402PrepaidPayload extends s402PaymentPayloadBase {
  scheme: 'prepaid';
  payload: {
    transaction: string;
    signature: string;
    ratePerCall: string;                // How much per API call (must match requirements)
    maxCalls?: string;                  // Max calls cap (must match requirements)
  };
}

// ... (similar for stream, escrow, unlock)

// The "discriminated union" — TypeScript can narrow the type
// based on the `scheme` field:
export type s402PaymentPayload =
  | s402ExactPayload
  | s402StreamPayload
  | s402EscrowPayload
  | s402UnlockPayload
  | s402PrepaidPayload;

// Why this matters: when you check `payload.scheme === 'prepaid'`,
// TypeScript automatically knows `payload.payload.ratePerCall` exists.
// No casting needed. No runtime type checks. The type system does it.
```

### HTTP encoding (http.ts)

The encode/decode functions are the trust boundary. Everything that enters from the network passes through these functions.

**Encoding (outbound — trusted):**

```typescript
// Encoding is simple: JSON.stringify → UTF-8 → base64.
// We use TextEncoder for Unicode safety (handles emoji, CJK, etc.)
export function encodePaymentRequired(
  requirements: s402PaymentRequirements
): string {
  // JSON.stringify converts the object to a JSON string.
  // TextEncoder converts the string to UTF-8 bytes.
  // btoa() converts bytes to base64 (the format HTTP headers use).
  const json = JSON.stringify(requirements);
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes));
}
```

**Decoding (inbound — UNTRUSTED):**

```typescript
// Decoding is where ALL the validation happens.
// Data from HTTP headers is untrusted until proven otherwise.
export function decodePaymentRequired(header: string): s402PaymentRequirements {
  // Step 1: Base64 → bytes → string
  let json: string;
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch {
    throw new s402Error('INVALID_PAYLOAD', 'Failed to decode base64 header');
  }

  // Step 2: String → object
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new s402Error('INVALID_PAYLOAD', 'Failed to parse JSON from header');
  }

  // Step 3: Validate shape (this is where the trust boundary enforcement lives)
  validateRequirementsShape(obj);

  // Step 4: Strip unknown fields (defense-in-depth)
  return pickRequirementsFields(obj as Record<string, unknown>);
}
```

**Field stripping — the trust boundary:**

```typescript
// This is a critical security pattern: "allowlist, don't blocklist."
// Instead of removing known-bad fields, we only KEEP known-good fields.
// If an attacker adds "maliciousField": "exploit", it's silently dropped.

const S402_REQUIREMENTS_KEYS = new Set([
  's402Version', 'accepts', 'network', 'asset', 'amount', 'payTo',
  'facilitatorUrl', 'mandate', 'protocolFeeBps', 'protocolFeeAddress',
  'receiptRequired', 'settlementMode', 'expiresAt',
  'stream', 'escrow', 'unlock', 'prepaid', 'extensions',
]);

export function pickRequirementsFields(
  obj: Record<string, unknown>
): s402PaymentRequirements {
  const result: Record<string, unknown> = {};

  // Only copy fields that are in the allowlist.
  // Everything else is dropped.
  for (const key of S402_REQUIREMENTS_KEYS) {
    if (key in obj) {
      // Sub-objects (stream, escrow, etc.) get their own allowlist too.
      // Defense-in-depth: strip unknown keys at EVERY level, not just the top.
      if (key in S402_SUB_OBJECT_KEYS) {
        result[key] = pickSubObjectFields(key, obj[key]);
      } else {
        result[key] = obj[key];
      }
    }
  }

  return result as unknown as s402PaymentRequirements;
}
```

### The Facilitator (facilitator.ts)

The facilitator is the orchestration layer. It doesn't know how to verify or settle — it *dispatches* to the right scheme implementation.

```typescript
export class s402Facilitator {
  // A Map of Maps: network → scheme → implementation.
  // e.g., "sui:mainnet" → "exact" → ExactFacilitatorScheme
  private schemes = new Map<string, Map<s402Scheme, s402FacilitatorScheme>>();

  // Register a scheme implementation for a specific network.
  register(network: string, scheme: s402FacilitatorScheme): this {
    if (!this.schemes.has(network)) {
      this.schemes.set(network, new Map());
    }
    this.schemes.get(network)!.set(scheme.scheme, scheme);
    return this;  // Returns `this` for method chaining:
                  // facilitator.register(...).register(...)
  }

  // The main entry point: verify + settle with all guards.
  async process(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402SettleResponse> {

    // ── Guard 1: Reject expired requirements ──
    // The type check (typeof !== 'number') defends against a sneaky attack:
    // JSON.parse('{"expiresAt": "never"}') would make `Date.now() > "never"`
    // evaluate to FALSE in JavaScript, silently bypassing the expiration check.
    if (requirements.expiresAt != null) {
      if (typeof requirements.expiresAt !== 'number'
          || !Number.isFinite(requirements.expiresAt)) {
        return {
          success: false,
          error: `Invalid expiresAt: expected number, got ${typeof requirements.expiresAt}`,
          errorCode: 'INVALID_PAYLOAD',
        };
      }
      if (Date.now() > requirements.expiresAt) {
        return {
          success: false,
          error: `Requirements expired at ${new Date(requirements.expiresAt).toISOString()}`,
          errorCode: 'REQUIREMENTS_EXPIRED',
        };
      }
    }

    // ── Guard 2: Scheme mismatch check ──
    // Prevents a client from claiming to use "exact" when the server
    // only accepts "prepaid." Without this, the wrong scheme handler
    // would run, likely failing with a confusing error.
    if (requirements.accepts && requirements.accepts.length > 0) {
      if (!requirements.accepts.includes(payload.scheme)) {
        return {
          success: false,
          error: `Scheme "${payload.scheme}" not accepted. Accepted: [${requirements.accepts.join(', ')}]`,
          errorCode: 'SCHEME_NOT_SUPPORTED',
        };
      }
    }

    // ── Dispatch to scheme implementation ──
    const scheme = this.resolveScheme(payload.scheme, requirements.network);

    // Verify first (dry-run, no on-chain effect)
    const verifyResult = await scheme.verify(payload, requirements);
    if (!verifyResult.valid) {
      return {
        success: false,
        error: verifyResult.invalidReason ?? 'Verification failed',
        errorCode: 'VERIFICATION_FAILED',
      };
    }

    // ── Guard 3: Latency re-check ──
    // If verification took a long time (slow RPC, network issues),
    // the requirements might have expired during verification.
    // Check again before spending gas on a doomed transaction.
    if (typeof requirements.expiresAt === 'number'
        && Date.now() > requirements.expiresAt) {
      return {
        success: false,
        error: 'Requirements expired during verification',
        errorCode: 'REQUIREMENTS_EXPIRED',
      };
    }

    // Settle (broadcast to Sui) — wrapped in try/catch so
    // exceptions from the scheme implementation return clean
    // error results instead of crashing the facilitator.
    try {
      return await scheme.settle(payload, requirements);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : 'Settlement failed',
        errorCode: 'VERIFICATION_FAILED',
      };
    }
  }
}
```

### The Error System (errors.ts)

Every error code is designed for **programmatic consumption** — by AI agents, retry logic, and monitoring systems.

```typescript
// The error codes are defined as a `const` object.
// The `as const` makes TypeScript treat each value as a literal type,
// not just `string`. This means you get autocomplete and type-checking.
export const s402ErrorCode = {
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MANDATE_EXPIRED: 'MANDATE_EXPIRED',
  FINALITY_TIMEOUT: 'FINALITY_TIMEOUT',
  FACILITATOR_UNAVAILABLE: 'FACILITATOR_UNAVAILABLE',
  // ... 10 more codes
} as const;

// Every error code has a recovery hint.
// The agent doesn't need to parse error messages —
// it reads the hint and acts on it.
const ERROR_HINTS: Record<s402ErrorCodeType, { retryable: boolean; suggestedAction: string }> = {
  INSUFFICIENT_BALANCE: {
    retryable: false,   // Don't retry — it will fail again.
    suggestedAction: 'Top up wallet balance or try with a smaller amount',
  },
  FINALITY_TIMEOUT: {
    retryable: true,    // The TX was submitted but not confirmed yet.
    suggestedAction: 'Transaction submitted but not confirmed — retry finality check',
  },
  FACILITATOR_UNAVAILABLE: {
    retryable: true,    // Try again, or fall back to direct settlement.
    suggestedAction: 'Fall back to direct settlement if signer is available',
  },
  // ...
};

// The error class extends JavaScript's built-in Error,
// adding code, retryable, and suggestedAction.
export class s402Error extends Error {
  readonly code: s402ErrorCodeType;
  readonly retryable: boolean;
  readonly suggestedAction: string;

  // `toJSON()` means this error serializes cleanly for APIs.
  // No stack traces leaking to clients.
  toJSON(): s402ErrorInfo {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      suggestedAction: this.suggestedAction,
    };
  }
}
```

---

## Chapter 5: Architecture Deep Dive

*Read time: 15 minutes. For senior engineers evaluating the protocol design.*

### Separation of concerns

The s402 package has a strict responsibility boundary: **it is the wire format, not the settlement engine.**

```
s402 handles:                         s402 does NOT handle:
─────────────                         ─────────────────────
✓ Type definitions                    ✗ Cryptographic signature verification
✓ HTTP header encoding/decoding       ✗ On-chain balance checks
✓ Shape validation at trust boundary  ✗ Transaction broadcasting
✓ Scheme dispatching                  ✗ RPC calls to Sui
✓ Error codes with recovery hints     ✗ Key management
✓ x402 format conversion              ✗ Rate limiting
```

This separation means:
1. The core package has **zero runtime dependencies** (36KB total build)
2. It can be audited independently of chain-specific code
3. Different chains could implement s402 schemes using their own SDKs

### The scheme registry pattern

Each actor (client, server, facilitator) has a registry that maps `(network, scheme) → implementation`:

```
Map<string, Map<s402Scheme, Implementation>>
    │                │              │
    │                │              └── The actual verify/settle/createPayment logic
    │                └── "exact", "prepaid", "stream", etc.
    └── "sui:mainnet", "sui:testnet", etc.
```

Why a two-level map? Because the same scheme (e.g., "exact") might have different implementations on different networks. A testnet implementation might skip finality waits; a mainnet implementation might add extra safety checks.

The registry pattern also means s402 is a **plugin system**. You don't subclass anything. You implement an interface and register it:

```typescript
// Implementing a scheme is just fulfilling an interface.
// No base classes, no inheritance, no framework lock-in.
const myExactScheme: s402FacilitatorScheme = {
  scheme: 'exact',
  async verify(payload, requirements) { /* ... */ },
  async settle(payload, requirements) { /* ... */ },
};

facilitator.register('sui:mainnet', myExactScheme);
```

### Trust boundary model

```
 Untrusted                   Trust Boundary                  Trusted
─────────────────────────────────┬────────────────────────────────────
 HTTP headers (base64 JSON)      │  Decoded, validated, field-stripped
 Network responses               │  Scheme implementations
 User-provided config            │  Internal function calls
```

The trust boundary is enforced by the decode functions. The key principle: **allowlist, don't blocklist.**

- `pickRequirementsFields()` — only copies known fields from the decoded object
- `pickSubObjectFields()` — strips unknown keys from scheme-specific sub-objects
- `pickPayloadFields()` — same for payment payloads
- `pickSettleResponseFields()` — same for settlement responses

After passing through a decode function, TypeScript types can be trusted. Before that, everything is `unknown`.

### Expiration guard pattern

The facilitator checks `expiresAt` **three times** in the `process()` flow:

1. **Before verification**: Don't waste RPC calls on expired requirements
2. **Type check**: Reject string/NaN values that would bypass `Date.now() > expiresAt`
3. **After verification**: Don't waste gas if requirements expired during the dry-run

This is NOT a TOCTOU (time-of-check-to-time-of-use) fix — Sui's PTBs are atomic. This is a **gas optimization**: if you already know the requirements are stale, don't broadcast a transaction that the server will reject anyway.

### x402 compatibility layer

The compat layer (`s402/compat`) is an **adapter pattern** that handles three input formats:

```
x402 V1 (flat)           normalizeRequirements()
  { x402Version: 1,    ─────────────────────────►  { s402Version: "1",
    scheme: "exact",                                   accepts: ["exact"],
    maxAmountRequired: "1000000" }                     amount: "1000000" }

x402 V2 (envelope)       normalizeRequirements()
  { x402Version: 2,    ─────────────────────────►  { s402Version: "1",
    accepts: [{...}] }                                accepts: ["exact"],
                                                       amount: "1000000" }

s402 (native)             normalizeRequirements()
  { s402Version: "1",  ─────────────────────────►  { s402Version: "1",
    accepts: ["exact", "stream"] }                    accepts: ["exact", "stream"] }
```

The key property: **s402 → x402 → s402 roundtrip preserves all x402 fields.** s402-only fields (mandate, stream extras, etc.) are stripped when converting to x402, because x402 has no concept of them.

---

## Chapter 6: Design Decisions & Trade-offs

*Read time: 15 minutes. For staff/principal engineers and architects evaluating the protocol at a systems level.*

### Decision 1: String amounts, not numbers

All monetary values in s402 are strings: `"1000000"`, not `1000000`.

**Why:** JavaScript's `Number` type uses IEEE 754 doubles, which lose precision above 2^53 (9,007,199,254,740,992). Sui's u64 max is 2^64 − 1 (18,446,744,073,709,551,615). A naive `JSON.parse` of `{"amount": 18446744073709551615}` silently rounds to `18446744073709552000` — a different amount.

**Trade-off:** String amounts require explicit parsing when doing arithmetic. The `isValidAmount()` function validates format (canonical non-negative integer string), and `isValidU64Amount()` validates both format and magnitude for Sui-specific use cases.

### Decision 2: Discriminated unions, not class hierarchies

Payment payloads use TypeScript's discriminated union pattern instead of class inheritance:

```typescript
// Discriminated union (what s402 does):
type Payload = ExactPayload | StreamPayload | PrepaidPayload;

// Class hierarchy (what s402 doesn't do):
class Payload { ... }
class ExactPayload extends Payload { ... }
class StreamPayload extends Payload { ... }
```

**Why:** Discriminated unions are:
1. **Serialization-friendly** — they're plain objects, not class instances. `JSON.parse()` produces them directly.
2. **Exhaustiveness-checked** — TypeScript ensures you handle every scheme in switch statements.
3. **Zero runtime overhead** — no prototype chains, no `instanceof` checks.

**Trade-off:** You can't add methods to the payloads themselves. Behavior lives in the scheme implementations, not the data types. This is intentional — data and behavior are separate in s402.

### Decision 3: Scheme-specific verification (no shared logic)

Each scheme has its own `verify()` method. The facilitator does NOT have generic verification code.

**Why:** Verification is fundamentally different per scheme:
- **Exact**: recover signer from signature → dry-run simulation → check balance
- **Stream**: validate stream creation PTB → check deposit ≥ minDeposit → check rate
- **Escrow**: validate escrow PTB → check deadline → check arbiter address
- **Prepaid**: validate deposit PTB → check committed rate matches requirements

Sharing logic would require either:
1. A "God function" with scheme-specific branches (unmaintainable)
2. A base class with overrides (constrains future schemes)

The dispatch pattern keeps each scheme self-contained. Adding a sixth scheme means implementing one interface, not modifying shared verification code.

### Decision 4: Zero runtime dependencies

The `s402` package has no `dependencies` in package.json. Not even the Sui SDK.

**Why:**
1. **Supply chain security** — no transitive dependencies means no `node_modules` attack surface in production. The entire build is your code and nothing else.
2. **Auditability** — the entire package is ~800 lines of TypeScript. A security auditor can read the whole thing in an afternoon.
3. **Bundle size** — 36KB total. No tree-shaking needed because there's nothing to shake.
4. **Flexibility** — consumers bring their own Sui SDK version. No peer dependency conflicts.

**Trade-off:** s402 can't do anything chain-specific. It can't verify signatures, check balances, or broadcast transactions. All of that lives in scheme implementations (like the upcoming `@sweefi/sui`). This is the correct layering — the protocol layer should not know about chain internals.

### Decision 5: Optional x402 compatibility

The compat layer is a sub-path import (`s402/compat`), not part of the main barrel export.

**Why:** Most s402 consumers will never need x402 conversion. Including it in the main export would:
1. Increase the mental surface area ("what are all these x402 types?")
2. Suggest that x402 interop is a first-class concern (it's a migration aid)
3. Export types that have no meaning in a Sui-native context

**Trade-off:** Consumers who need compat must add a second import. This is a conscious choice — the main API should be clean and focused on s402-native usage.

### Decision 6: Errors as data, not exceptions (in the facilitator)

The facilitator's `process()`, `verify()`, and `settle()` methods return result objects instead of throwing:

```typescript
// Returns { success: false, error: "...", errorCode: "..." }
// instead of throwing an Error
return {
  success: false,
  error: 'Requirements expired',
  errorCode: 'REQUIREMENTS_EXPIRED',
};
```

**Why:** In a payment system, "failure" is a normal outcome, not an exceptional one. Expired requirements, insufficient balance, scheme mismatches — these are expected states, not bugs. Using return values:
1. Forces callers to handle the failure path (can't accidentally ignore a returned object the way you can forget to catch an exception)
2. Makes the type system enforce error handling (`result.success` must be checked)
3. Keeps the control flow linear (no try/catch nesting)

The one exception: `resolveScheme()` throws `s402Error` for missing scheme implementations. This is a programmer error (misconfigured facilitator), not a runtime payment failure. Errors-as-exceptions for bugs, errors-as-values for expected failures.

---

## Sources & Citations

### HTTP 402 History
- [RFC 2068 — HTTP/1.1 (January 1997)](https://www.rfc-editor.org/rfc/rfc2068.html) — Original specification reserving status code 402
- [MDN Web Docs — 402 Payment Required](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/402) — Current status and history

### x402 Protocol
- [x402.org — Official site](https://www.x402.org/) — Protocol documentation and statistics (100M+ payments)
- [Coinbase — Introducing x402](https://www.coinbase.com/developer-platform/discover/launches/x402) — Launch announcement (May 2025)
- [x402 V2 Launch](https://www.x402.org/writing/x402-v2-launch) — V2 modularity, wallet hooks, Bazaar discovery
- [BeInCrypto — x402 Trading Volume Drops 92%](https://beincrypto.com/x402-transactions-drop-in-feb/) — Transaction decline from 731K/day to 57K/day
- [BeInCrypto — x402 Trading Volume Falls](https://beincrypto.com/x402-trading-volume-falls-ecosystem-growth/) — Infrastructure & Utilities segment decline
- [Yahoo Finance — Is x402 Losing Steam?](https://finance.yahoo.com/news/x402-crypto-ecosystem-losing-steam-095357952.html) — Ecosystem analysis
- [Stripe enables AI agents with x402 on Base](https://capwolf.com/stripe-enables-ai-agents-with-x402-crypto-payments-on-base/) — Stripe integration

### Sui Blockchain
- [Sui Documentation — Programmable Transaction Blocks](https://docs.sui.io/concepts/transactions/prog-txn-blocks) — PTB architecture and atomicity
- [Sui Documentation — Building PTBs](https://docs.sui.io/guides/developer/sui-101/building-ptb) — Developer guide

### Agent Economy
- [McKinsey — The Agentic Commerce Opportunity](https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-agentic-commerce-opportunity-how-ai-agents-are-ushering-in-a-new-era-for-consumers-and-merchants) — $3–5 trillion market projection by 2030
- [FinTech Brain Food — The Agentic Payments Map](https://www.fintechbrainfood.com/p/the-agentic-payments-map) — Landscape overview
- [Circle — Machine-to-Machine Micropayments](https://www.circle.com/blog/enabling-machine-to-machine-micropayments-with-gateway-and-usdc) — Infrastructure perspective
- [FinTech Weekly — Agentic Commerce Needs Stablecoins](https://www.fintechweekly.com/magazine/articles/agentic-commerce-stablecoins-micropayments-ai-payments) — Economic analysis

---

*s402 is an open protocol maintained by [Swee Group LLC](https://s402-protocol.org). The future of internet payments isn't a single protocol — it's the right protocol for each chain. x402 for EVM. s402 for Sui.*
