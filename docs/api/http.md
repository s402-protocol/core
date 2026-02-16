# HTTP Helpers

Encode and decode s402 objects for HTTP transport. Wire-compatible with x402 — same header names, same base64 encoding.

```typescript
import {
  encodePaymentRequired,
  decodePaymentRequired,
  detectProtocol,
} from 's402/http';
```

## Encoding

All encoders convert an object → base64 string for use in HTTP headers. Uses Unicode-safe base64 (UTF-8 → base64), so the `extensions` field and error messages can contain any characters.

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

## Decoding

All decoders convert a base64 header string → typed object. They validate the shape of the decoded JSON and throw `s402Error` with code `INVALID_PAYLOAD` if the data is malformed.

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

Check that a string represents a canonical non-negative integer (valid for Sui MIST amounts). Rejects leading zeros (`"007"`), empty strings, negatives, and decimals. Accepts `"0"` as the only zero representation.

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

Used internally by `decodePaymentRequired()` to validate the `amount` field. Also useful for validating amounts in your own code before building payment requirements.

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

## Validation

### `validateRequirementsShape(obj)`

Validate that an unknown object has the shape of `s402PaymentRequirements`. Throws `s402Error` with code `INVALID_PAYLOAD` if required fields are missing or have wrong types. Used internally by `decodePaymentRequired()` — call directly when you have a pre-parsed JSON object.

```typescript
function validateRequirementsShape(obj: unknown): void;
```
