---
description: HTTP encoding and decoding helpers for s402. Supports header transport (x402-compatible) and body transport for large payloads.
---

# HTTP Helpers

Encode and decode s402 objects for HTTP transport. Supports two transport modes: **header transport** (base64-encoded JSON in HTTP headers, wire-compatible with x402) and **body transport** (raw JSON in the request/response body, for large payloads).

```typescript
import {
  encodePaymentRequired,
  decodePaymentRequired,
  detectProtocol,
} from 's402/http';
```

## Header Transport — Encoding

All header encoders convert an object → base64 string for use in HTTP headers. Uses Unicode-safe base64 (UTF-8 → base64), so the `extensions` field and error messages can contain any characters.

### `encodePaymentRequired(requirements)`

Encode payment requirements for the `payment-required` response header.

```typescript
function encodePaymentRequired(required: s402PaymentRequired): string;
```

Takes the 402 **document** — an x402 V2 `PaymentRequired` envelope — not one
requirement. `resource` is mandatory and its `url` must be non-empty, and each
`accepts[]` entry is one offered scheme.

The encoder validates what it is about to publish against the schema the pinned
`@x402/core` will parse it with, and throws `s402Error` (`INVALID_PAYLOAD`)
rather than emitting a 402 an x402 client cannot read. A non-CAIP-2 `network`,
a `maxTimeoutSeconds` of zero, an empty `resource.url`, a `serviceName` over 32
printable-ASCII characters, more than five `tags`, or an `iconUrl` over 2048
characters all fail here.

**Example:**

```typescript
const header = encodePaymentRequired({
  x402Version: 2,
  resource: { url: 'https://api.example.com/paid' },
  accepts: [{
    scheme: 'exact',
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xrecipient...',
  }],
});

res.status(402).set('payment-required', header).end();
```

### `encodePaymentPayload(payload)`

Encode a payment payload for the `x-payment` request header.

```typescript
function encodePaymentPayload(payload: s402PaymentPayload): string;
```

### `encodeSettleResponse(response)`

Encode a settlement response for the `payment-response` header.

```typescript
function encodeSettleResponse(response: s402SettleResponse): string;
```

## Header Transport — Decoding

All header decoders convert a base64 header string → typed object. They validate the shape of the decoded JSON and throw `s402Error` with code `INVALID_PAYLOAD` if the data is malformed.

### `decodePaymentRequired(header)`

Decode the `payment-required` header from a 402 response.

```typescript
function decodePaymentRequired(header: string, now?: number): s402PaymentRequired;
```

Works on a **plain x402 V2 402** as well as an s402-profile one: the only
difference between them is the presence of `extensions.s402`, and its absence is
not an error. What comes back is payable either way.

**Throws:** `s402Error` with code `INVALID_PAYLOAD` if:
- Base64 decoding fails
- JSON parsing fails
- `x402Version` is missing, or is not `2` (an s402 402 IS an x402 V2 envelope). A
  document carrying `s402Version` is the **retired flat v1 shape** — reading it
  is [`fromS402V1Requirements()`](/api/compat)'s job, and an x402 **V1** flat 402
  is [`normalizeRequirements()`](/api/compat#normalizerequirements-obj)'s.
- `resource` is missing, or `resource.url` is not a string
- `accepts` is missing, is not an array, or is empty
- An entry is missing `scheme`, `network`, `asset`, `amount` or `payTo`, or its
  `network` is not CAIP-2, or its `maxTimeoutSeconds` is not positive
- `amount` is not a valid non-negative integer string

### `decodePaymentPayload(header)`

Decode the `x-payment` header from a client request.

```typescript
function decodePaymentPayload(header: string): s402PaymentPayload;
```

**Throws:** `s402Error` with code `INVALID_PAYLOAD` if:
- Base64/JSON decoding fails
- `scheme` is missing or not one of the six valid schemes
- `payload` object is missing

> **Note:** `s402Version` is **not** required on payment payloads, and since wire
> v2 it does not appear on a 402 at all — the 402's version lives in
> `extensions.s402.version`. A payload may also carry an optional `network`,
> naming which `accepts[]` entry it is paying; `s402Client` fills it in, and a
> gate offering the same scheme on two networks needs it to tell them apart.

### `decodeSettleResponse(header)`

Decode the `payment-response` header from the server's 200 response.

```typescript
function decodeSettleResponse(header: string): s402SettleResponse;
```

**Throws:** `s402Error` with code `INVALID_PAYLOAD` if `success` is not a boolean.

## Protocol Detection

### `detectProtocol(headers)`

Detect whether a 402 response uses s402, x402, or an unknown protocol.

```typescript
function detectProtocol(headers: Headers): 's402' | 'x402' | 'unknown';
```

Reads the `payment-required` header and decodes it. Since wire v2 both protocols
share one envelope, so what separates them is the presence of **`extensions.s402`**
— not a version field. The retired flat 402, which carries `s402Version` and no
extensions, is also reported as `'s402'`: it is still ours to read, and calling it
`'unknown'` would make a server mid-upgrade indistinguishable from a free route.

`'x402'` names the **absence of s402's extensions**, never "not for us" — a plain
x402 402 is payable by an s402 client.

**Example:**

```typescript
const response = await fetch(url);
if (response.status === 402) {
  const protocol = detectProtocol(response.headers);
  switch (protocol) {
    case 's402': // an s402-profile 402 (or the retired flat shape)
    case 'x402': // a plain x402 402 — still payable, just no s402 extensions
    case 'unknown': // no payment-required header, or an unreadable one
  }
}
```

### `isValidAmount(s)`

Check that a string represents a canonical non-negative integer (format check only). Rejects leading zeros (`"007"`), empty strings, negatives, and decimals. Accepts `"0"` as the only zero representation.

```typescript
function isValidAmount(s: string): boolean;
```

```typescript
isValidAmount('1000000');  // true
isValidAmount('0');        // true
isValidAmount('007');      // false (leading zero)
isValidAmount('-1');       // false
isValidAmount('1.5');      // false
isValidAmount('');         // false
```

Used internally by `decodePaymentRequired()` to validate the `amount` field. Also useful for validating amounts in your own code before building payment requirements. **Note:** This is a format-only check — it does not enforce magnitude limits. For Sui, use `isValidU64Amount()` which also verifies the value fits in a u64.

### `isValidU64Amount(s)`

Check that a string represents a valid Sui u64 amount: canonical non-negative integer format **and** magnitude ≤ 2^64 − 1 (`18446744073709551615`).

```typescript
function isValidU64Amount(s: string): boolean;
```

```typescript
isValidU64Amount('1000000');                 // true
isValidU64Amount('18446744073709551615');     // true  (u64 max)
isValidU64Amount('18446744073709551616');     // false (u64 max + 1)
isValidU64Amount('99999999999999999999999');  // false (too large)
```

Use this when building Sui-specific scheme implementations to reject amounts that would overflow on-chain.

### `extractRequirementsFromResponse(response)`

Extract and decode the 402 document from a `Response`. Returns `null` if the
header is missing or unreadable (never throws).

Reads three shapes: s402's wire v2, a plain x402 V2 402 (the same envelope), and
the **retired s402 v1 flat 402** from a server that has not upgraded yet. That
last one matters during a rolling upgrade — returning `null` for it is
indistinguishable from "no payment required", so the client would neither pay nor
error. An x402 **V1** flat 402 is not read here; use
[`normalizeRequirements()`](/api/compat#normalizerequirements-obj).

```typescript
function extractRequirementsFromResponse(
  response: Response,
): s402PaymentRequired | null;
```

**Example:**

```typescript
const response = await fetch(url);
if (response.status === 402) {
  const requirements = extractRequirementsFromResponse(response);
  if (requirements) {
    const payment = await client.createPayment(requirements);
    // retry with payment...
  }
}
```

## Body Transport

Header transport encodes s402 objects as base64 in HTTP headers. This works for small payments, but headers are limited by infrastructure you don't control (Nginx: 4–8KB, Node.js: 16KB). Body transport uses raw JSON in the request/response body — no base64, no size limit — enabling large PTBs (128KB+) that cannot fit in headers.

Body transport uses the same validators and field-stripping as header transport. Both paths produce identical decoded objects.

```typescript
import {
  S402_CONTENT_TYPE,
  encodeRequirementsBody,
  decodeRequirementsBody,
  detectTransport,
} from 's402/http';
```

### `S402_CONTENT_TYPE`

```typescript
const S402_CONTENT_TYPE = 'application/s402+json' as const;
```

The MIME type for s402 body transport. Set this as the `Content-Type` header when sending or responding with body-encoded s402 data.

### `encodeRequirementsBody(requirements)`

Encode payment requirements as a JSON string for use in a response body.

```typescript
function encodeRequirementsBody(required: s402PaymentRequired): string;
```

The same envelope the header carries, and validated the same way on the way out.

**Example:**

```typescript
const body = encodeRequirementsBody({
  x402Version: 2,
  resource: { url: 'https://api.example.com/paid' },
  accepts: [{
    scheme: 'exact',
    network: 'sui:mainnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xrecipient...',
  }],
});

res.status(402)
  .set('content-type', S402_CONTENT_TYPE)
  .send(body);
```

### `decodeRequirementsBody(body)`

Decode payment requirements from a JSON string (response body).

```typescript
function decodeRequirementsBody(body: string, now?: number): s402PaymentRequired;
```

**Throws:** `s402Error` with code `INVALID_PAYLOAD` — same validation as `decodePaymentRequired()`.

### `encodePayloadBody(payload)`

Encode a payment payload as a JSON string for use in a request body.

```typescript
function encodePayloadBody(payload: s402PaymentPayload): string;
```

### `decodePayloadBody(body)`

Decode a payment payload from a JSON string (request body).

```typescript
function decodePayloadBody(body: string): s402PaymentPayload;
```

**Throws:** `s402Error` with code `INVALID_PAYLOAD` — same validation as `decodePaymentPayload()`.

### `encodeSettleBody(response)`

Encode a settlement response as a JSON string for use in a response body.

```typescript
function encodeSettleBody(response: s402SettleResponse): string;
```

### `decodeSettleBody(body)`

Decode a settlement response from a JSON string (response body).

```typescript
function decodeSettleBody(body: string): s402SettleResponse;
```

**Throws:** `s402Error` with code `INVALID_PAYLOAD` — same validation as `decodeSettleResponse()`.

### `detectTransport(request)`

Detect whether an incoming request uses header or body transport.

```typescript
function detectTransport(request: { headers: Headers }): 'header' | 'body' | 'unknown';
```

Checks `Content-Type` for `application/s402+json` (body transport), then falls back to checking for the `x-payment` header (header transport). When both are present, body transport takes priority.

**Example:**

```typescript
const transport = detectTransport(request);
switch (transport) {
  case 'body': {
    const payload = decodePayloadBody(await request.text());
    break;
  }
  case 'header': {
    const payload = decodePaymentPayload(request.headers.get('x-payment')!);
    break;
  }
  case 'unknown':
    return new Response('No payment provided', { status: 400 });
}
```

### When to Use Which Transport

| Scenario | Transport | Why |
|----------|-----------|-----|
| Simple exact payments | Header | Small payload, fewer moving parts |
| Prepaid deposits | Either | Depends on PTB size |
| Complex DeFi PTBs (128KB+) | Body | Cannot fit in headers |
| x402 compatibility | Header | x402 only supports header transport |

## Validation

### `validateRequirementsShape(obj)`

Validate that an unknown object is a well-formed 402 **wire envelope** —
`{ x402Version: 2, resource, accepts: [...] }` — not the lifted in-memory view.
Everything s402 adds is checked where it actually travels: inside each entry's
`extra`, and inside `extensions.s402`. Throws `s402Error` with code
`INVALID_PAYLOAD`.

Used internally by `decodePaymentRequired()`, `decodeRequirementsBody()` and both
encoders — call it directly when you have a pre-parsed JSON object.

```typescript
function validateRequirementsShape(
  obj: unknown,
  options?: {
    /** Held to upstream's own V2 schema: `resource.url` must be non-empty. */
    emitting?: boolean;
    /**
     * Lifted out of a retired flat shape (x402 V1, s402 v1), which predate
     * x402 V2's CAIP-2 `network` rule. Skips that one check. Such a document
     * can be READ and cannot be re-emitted.
     */
    liftedFromLegacy?: boolean;
  },
): void;
```
