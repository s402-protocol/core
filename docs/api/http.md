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
function encodePaymentRequired(requirements: s402PaymentRequirements): string;
```

**Example:**

```typescript
const header = encodePaymentRequired({
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0xrecipient...',
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
function decodePaymentRequired(header: string): s402PaymentRequirements;
```

**Throws:** `s402Error` with code `INVALID_PAYLOAD` if:
- Base64 decoding fails
- JSON parsing fails
- `s402Version` is missing or not `'1'` (for x402 format, use [`normalizeRequirements()`](/api/compat#normalizerequirements-obj) instead)
- Required fields are missing (`accepts`, `network`, `asset`, `amount`, `payTo`)
- `amount` is not a valid non-negative integer string

### `decodePaymentPayload(header)`

Decode the `x-payment` header from a client request.

```typescript
function decodePaymentPayload(header: string): s402PaymentPayload;
```

**Throws:** `s402Error` with code `INVALID_PAYLOAD` if:
- Base64/JSON decoding fails
- `scheme` is missing or not one of the five valid schemes
- `payload` object is missing

> **Note:** `s402Version` is **not** required on payment payloads. Requirements include it, but payloads omit it for x402 wire compatibility — the scheme field is the discriminant.

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

Reads the `payment-required` header, decodes it, and checks for `s402Version` or `x402Version`.

**Example:**

```typescript
const response = await fetch(url);
if (response.status === 402) {
  const protocol = detectProtocol(response.headers);
  switch (protocol) {
    case 's402': // handle with s402 client
    case 'x402': // handle with x402 client or normalize
    case 'unknown': // raw 402, no payment protocol
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

Extract and decode payment requirements from a 402 `Response` object. Returns `null` if the header is missing or malformed (never throws).

```typescript
function extractRequirementsFromResponse(
  response: Response,
): s402PaymentRequirements | null;
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
function encodeRequirementsBody(requirements: s402PaymentRequirements): string;
```

**Example:**

```typescript
const body = encodeRequirementsBody({
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0xrecipient...',
});

res.status(402)
  .set('content-type', S402_CONTENT_TYPE)
  .send(body);
```

### `decodeRequirementsBody(body)`

Decode payment requirements from a JSON string (response body).

```typescript
function decodeRequirementsBody(body: string): s402PaymentRequirements;
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

Validate that an unknown object has the shape of `s402PaymentRequirements`. Throws `s402Error` with code `INVALID_PAYLOAD` if required fields are missing or have wrong types. Used internally by `decodePaymentRequired()` and `decodeRequirementsBody()` — call directly when you have a pre-parsed JSON object.

```typescript
function validateRequirementsShape(obj: unknown): void;
```
