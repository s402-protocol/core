# s402 Conformance Test Vectors

Machine-readable test vectors that define s402-compliant behavior. Use these to verify any s402 implementation — TypeScript, Go, Python, Rust, etc.

## Getting the Vectors

The vectors ship with the `s402` npm package:

```bash
npm pack s402
tar xzf s402-*.tgz
ls package/test/conformance/vectors/
```

Or clone the repo directly:

```bash
git clone https://github.com/s402-protocol/core.git
ls core/test/conformance/vectors/
```

## Vector Format

Each JSON file contains an array of test cases:

```json
[
  {
    "description": "Human-readable test name",
    "input": { ... },
    "expected": { ... },
    "shouldReject": false
  }
]
```

### Accept vectors (`shouldReject: false`)

The implementation MUST produce `expected` when given `input`.

### Reject vectors (`shouldReject: true`)

The implementation MUST reject the input with an error. The `expectedErrorCode` field indicates which error:

```json
{
  "description": "Rejects negative amount",
  "input": { "header": "base64-encoded-malformed-json" },
  "shouldReject": true,
  "expectedErrorCode": "INVALID_PAYLOAD"
}
```

## Vector Files

| File | Tests | Description |
|------|-------|-------------|
| `requirements-encode.json` | Encode | `s402PaymentRequirements` object → base64 header string |
| `requirements-decode.json` | Decode | base64 header string → `s402PaymentRequirements` object |
| `payload-encode.json` | Encode | `s402PaymentPayload` object → base64 header string |
| `payload-decode.json` | Decode | base64 header string → `s402PaymentPayload` object |
| `settle-encode.json` | Encode | `s402SettleResponse` object → base64 header string |
| `settle-decode.json` | Decode | base64 header string → `s402SettleResponse` object |
| `body-transport.json` | Both | Requirements/payload/settle via JSON body (no base64) |
| `compat-normalize.json` | Normalize | x402 V1/V2 input → normalized s402 output |
| `receipt-format.json` | Format | Receipt fields → `X-S402-Receipt` header string |
| `receipt-parse.json` | Parse | `X-S402-Receipt` header string → parsed receipt fields |
| `validation-reject.json` | Reject | Malformed inputs that MUST be rejected |
| `roundtrip.json` | Roundtrip | encode → decode → re-encode = identical output |

## Encoding Scheme

s402 uses **Unicode-safe base64** for HTTP header transport:

1. JSON-serialize the object: `JSON.stringify(obj)`
2. UTF-8 encode the string: `TextEncoder.encode(json)`
3. Base64 encode the bytes: `btoa(bytes.map(b => String.fromCharCode(b)).join(''))`

For ASCII-only content (the common case), this produces the same output as plain `btoa(json)`.

Body transport uses raw JSON (no base64).

## Receipt Header Format

The `X-S402-Receipt` header uses colon-separated fields:

```
v2:base64(signature):callNumber:timestampMs:base64(responseHash)
```

- `v2` — version prefix (always "v2" for signed receipts)
- `signature` — 64-byte Ed25519 signature, base64-encoded
- `callNumber` — sequential call number (1-indexed, bigint string)
- `timestampMs` — Unix timestamp in milliseconds (bigint string)
- `responseHash` — response body hash (typically SHA-256, 32 bytes), base64-encoded

In the vector JSON files, `signature` and `responseHash` are represented as arrays of byte values (0-255) since JSON has no binary type.

## Implementing in Another Language

1. Load the JSON vector files
2. For each vector where `shouldReject` is `false`:
   - Feed `input` to your encode/decode function
   - Compare the result to `expected`
3. For each vector where `shouldReject` is `true`:
   - Feed `input` to your decode function
   - Verify it throws/returns an error with the matching error code
4. For roundtrip vectors:
   - Verify `expected.identical` is `true`
   - Verify `expected.firstEncode === expected.reEncode`

### Key stripping on decode

All three decode functions (`decodePaymentRequired`, `decodePaymentPayload`, `decodeSettleResponse`) MUST strip unknown top-level keys. Only known fields should survive the decode. This is a defense-in-depth measure at the HTTP trust boundary.

**Requirements known top-level keys:** `s402Version`, `accepts`, `network`, `asset`, `amount`, `payTo`, `facilitatorUrl`, `mandate`, `protocolFeeBps`, `protocolFeeAddress`, `receiptRequired`, `settlementMode`, `expiresAt`, `stream`, `escrow`, `unlock`, `prepaid`, `extensions`.

**Requirements sub-object known keys** (also stripped of unknowns):
- `mandate`: `required`, `minPerTx`, `coinType`
- `stream`: `ratePerSecond`, `budgetCap`, `minDeposit`, `streamSetupUrl`
- `escrow`: `seller`, `arbiter`, `deadlineMs`
- `unlock`: `encryptionId`, `walrusBlobId`, `encryptionPackageId`
- `prepaid`: `ratePerCall`, `maxCalls`, `minDeposit`, `withdrawalDelayMs`, `providerPubkey`, `disputeWindowMs`

**Payload known top-level keys:** `s402Version`, `scheme`, `payload`.

**Payload inner keys** (per scheme):
- `exact`, `stream`, `escrow`: `transaction`, `signature`
- `unlock`: `transaction`, `signature`, `encryptionId`
- `prepaid`: `transaction`, `signature`, `ratePerCall`, `maxCalls`

**Settle response known keys:** `success`, `txDigest`, `receiptId`, `finalityMs`, `streamId`, `escrowId`, `balanceId`, `error`, `errorCode`.

### JSON key ordering

s402 vectors use JavaScript's `JSON.stringify()` key ordering (insertion order). Cross-language implementations MUST serialize keys in the same order as the vector files to produce identical base64 output. If your language's JSON serializer uses alphabetical ordering by default, you'll need ordered serialization (e.g., Go's `json.Marshal` on a struct with ordered fields, Python's `json.dumps` with `sort_keys=False`).

Note: **decode also reorders keys**. The decode functions iterate their allowlist in the order listed above, not the input order. If the input JSON has keys in a different order, the decoded output follows the allowlist order. This affects roundtrip tests — the re-encoded output uses the allowlist order, which may differ from the original input order.

### Header size limits

Implementations SHOULD enforce a maximum header size of **64 KiB** (`MAX_HEADER_BYTES = 65536`). Headers exceeding this limit indicate abuse or misconfiguration and SHOULD be rejected before base64 decoding.

### Rejection vector dispatch

Rejection vectors are dispatched in this precedence order:

1. If `expectedErrorCode` is `"RECEIPT_PARSE_ERROR"` → test `parseReceiptHeader`. Note: receipts throw a plain `Error`, not an `s402Error`, since receipts are a separate subsystem.
2. If `input.decodeAs` is `"payload"` → test `decodePaymentPayload`
3. If `input.decodeAs` is `"compat"` → test `normalizeRequirements` with the raw JSON (not base64)
4. Otherwise → test `decodePaymentRequired` (the default)

### Error codes

Rejection vectors use `expectedErrorCode` values from the s402 error code enum:

- `INVALID_PAYLOAD` — malformed or invalid input
- `RECEIPT_PARSE_ERROR` — malformed receipt header (vector convention for receipt-specific parsing errors)

## Regenerating Vectors

If you modify the s402 encoding logic, regenerate vectors:

```bash
npx tsx test/conformance/generate-vectors.ts
```

Then run the conformance tests to verify:

```bash
pnpm run test
```
