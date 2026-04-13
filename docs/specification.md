---
description: s402 Wire Format Specification v1 — the formal, field-by-field definition of the s402 HTTP 402 payment protocol. For implementors building in Go, Python, Rust, or any language.
---

# s402 Wire Format Specification

**Version**: 1 &nbsp;·&nbsp; **Status**: Draft &nbsp;·&nbsp; **Date**: March 2026

This document defines the s402 wire format — the exact encoding, field definitions, validation rules, and error semantics for the s402 HTTP 402 payment protocol. It is the authoritative reference for any implementation in any language.

The TypeScript reference implementation lives at [github.com/s402-protocol/core](https://github.com/s402-protocol/core). Machine-readable conformance test vectors ship in the npm package (161 vectors across 13 files).

## 1. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

| Term | Definition |
|------|-----------|
| **Resource Server** | The HTTP server that hosts paid resources and returns 402 responses. |
| **Client** | The HTTP client (typically an AI agent) that requests resources and submits payments. |
| **Facilitator** | A service that verifies and settles payment transactions on-chain on behalf of the Resource Server. Optional — direct settlement bypasses the Facilitator. |
| **Requirements** | The JSON object sent by the server in a 402 response describing what payment is needed. |
| **Payload** | The JSON object sent by the client containing a signed payment transaction. |
| **Scheme** | A payment pattern (exact, upto, prepaid, stream, escrow, unlock) defining the on-chain lifecycle. |
| **Base units** | The smallest denomination of a currency (e.g., MIST for SUI, wei for ETH, lamports for SOL). |

## 2. Protocol Overview

s402 uses the HTTP 402 status code to negotiate payment between a client and a server. The protocol has three phases:

```
Phase 1: Discovery
  Client  ─── GET /resource ──────────────>  Server
  Client  <── 402 + payment-required ──────  Server

Phase 2: Payment
  Client  ─── GET /resource + x-payment ──>  Server
  Server  ─── payload + requirements ──────>  Facilitator
  Server  <── settlement result ───────────  Facilitator

Phase 3: Delivery
  Client  <── 200 + payment-response ──────  Server
```

The presence of `s402Version` in the decoded requirements JSON distinguishes s402 from x402 and other 402 protocols.

## 3. Transport

### 3.1 Header Transport (default)

s402 uses three HTTP headers. All header names are lowercase per [RFC 9113 §8.2.1](https://www.rfc-editor.org/rfc/rfc9113#section-8.2.1).

| Header | Direction | Content |
|--------|-----------|---------|
| `payment-required` | Server → Client | Base64-encoded Payment Requirements JSON |
| `x-payment` | Client → Server | Base64-encoded Payment Payload JSON |
| `payment-response` | Server → Client | Base64-encoded Settlement Response JSON |

These header names are identical to x402 V1 for wire compatibility.

### 3.2 Encoding

Header transport uses **Unicode-safe base64** encoding:

1. JSON-serialize the object: `JSON.stringify(object)`
2. UTF-8 encode the string to bytes
3. Base64 encode the bytes using standard base64 (RFC 4648 §4)

For ASCII-only content (the common case), this produces identical output to applying base64 directly to the JSON string. The UTF-8 step ensures that Unicode characters in the `extensions` field or error messages survive the round-trip.

Implementations MUST decode in the reverse order: base64 decode → UTF-8 decode → JSON parse.

### 3.3 Header Size Limit

Implementations SHOULD enforce a maximum header size of **65,536 bytes** (64 KiB) on decoded headers. Headers exceeding this limit SHOULD be rejected before base64 decoding.

This is a defense-in-depth measure. Most HTTP servers enforce smaller limits (Node.js: 16 KiB, Cloudflare Workers: 128 KiB). A wire format library should not rely on runtime enforcement alone.

### 3.4 Body Transport (large payloads)

When a payment payload exceeds header size limits (e.g., complex DeFi PTBs exceeding 128 KiB after base64), implementations MAY use body transport instead.

- **Content-Type**: `application/s402+json`
- **Encoding**: Raw JSON (no base64)
- **Size limits**: Set by the application (Express default: 100 KiB, Nginx default: 1 MiB)

Implementations MUST apply the same validation and key-stripping rules to body-transported objects as to header-transported objects.

To detect which transport a request uses, check:
1. If `Content-Type` includes `application/s402+json` → body transport
2. If the `x-payment` header is present → header transport
3. Otherwise → unknown

### 3.5 Protocol Detection

To determine whether a 402 response uses s402 or x402:

1. Read the `payment-required` header
2. Base64 decode and JSON parse
3. If the decoded object contains `s402Version` → **s402**
4. If it contains `x402Version` → **x402**
5. Otherwise → **unknown**

## 4. Payment Requirements

The Payment Requirements object is sent by the Resource Server in the `payment-required` header of a 402 response. It describes what payment the server accepts.

### 4.1 Required Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `s402Version` | string | MUST be `"1"` | Protocol version. Distinguishes s402 from x402. |
| `accepts` | string[] | Non-empty array. Each entry MUST be a string. | Payment schemes the server accepts. SHOULD include `"exact"` for x402 compatibility. |
| `network` | string | Non-empty. No control characters (U+0000–U+001F, U+007F). | Network identifier. RECOMMENDED format: CAIP-2 style (e.g., `"sui:mainnet"`, `"eip155:8453"`, `"solana:mainnet-beta"`). |
| `asset` | string | Non-empty. No control characters. | Asset/coin type identifier. Format is chain-specific and opaque to s402 (e.g., `"0x2::sui::SUI"`, `"0xA0b8..."` for ERC-20). |
| `amount` | string | Canonical non-negative integer. See §4.3. | Payment amount in base units. |
| `payTo` | string | Non-empty. No control characters. | Recipient address. Format is chain-specific and opaque to s402. |

### 4.2 Optional Fields

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `facilitatorUrl` | string | Valid URL. Protocol MUST be `https:` or `http:`. No control characters. | URL of the Facilitator service. Omit for direct settlement. |
| `expiresAt` | number | Positive finite number. | Unix timestamp in milliseconds. Facilitators MUST reject requirements after this time. |
| `protocolFeeBps` | number | Integer, 0–10000. | Protocol fee in basis points. Advisory only — the authoritative fee is set by the Facilitator's on-chain config. |
| `protocolFeeAddress` | string | Non-empty. No control characters. | Address that receives the protocol fee. Advisory only. |
| `receiptRequired` | boolean | — | Whether the server requires an on-chain receipt. |
| `settlementMode` | string | `"facilitator"` or `"direct"` | Settlement mode preference. |
| `mandate` | object | See §4.5. | AP2 mandate requirements. |
| `upto` | object | See §4.6. | Upto-specific parameters. Present when `accepts` includes `"upto"`. |
| `settlementOverrides` | object | See §4.6. | Settlement overrides for upto scheme (server provides actual amount). |
| `stream` | object | See §4.7. | Stream-specific parameters. Present when `accepts` includes `"stream"`. |
| `escrow` | object | See §4.8. | Escrow-specific parameters. Present when `accepts` includes `"escrow"`. |
| `unlock` | object | See §4.9. | Unlock-specific parameters. Present when `accepts` includes `"unlock"`. |
| `prepaid` | object | See §4.10. | Prepaid-specific parameters. Present when `accepts` includes `"prepaid"`. |
| `extensions` | object | Opaque key-value bag. | Forward-compatible extensibility. Consumers MUST treat extension values as untrusted input. See §4.10. |

### 4.3 Amount Format

The `amount` field MUST be a **canonical non-negative integer string**:

- MUST match the regular expression `^(0|[1-9][0-9]*)$`
- MUST NOT have leading zeros (except the string `"0"` itself)
- MUST NOT contain decimals, negative signs, or whitespace
- MAY be arbitrarily large (no upper magnitude bound at the wire format level)

Examples of valid amounts: `"0"`, `"1"`, `"1000000"`, `"18446744073709551616"`

Examples of invalid amounts: `"-1"`, `"007"`, `"1.5"`, `"abc"`, `"1,000"`, `""`

::: info Chain-specific magnitude bounds
The wire format does not enforce chain-specific magnitude limits (e.g., u64 for Sui, u256 for Ethereum). Chain adapters SHOULD validate that amounts fit within their chain's native integer type before constructing transactions.
:::

### 4.4 Control Character Rejection

The following fields MUST NOT contain ASCII control characters (U+0000–U+001F) or the DEL character (U+007F):

- `network`
- `asset`
- `payTo`
- `facilitatorUrl`
- `protocolFeeAddress`

Control characters in these fields could enable HTTP header injection (CRLF) or log injection (null bytes). Implementations MUST reject requirements containing control characters in these fields with error code `INVALID_PAYLOAD`.

### 4.5 Mandate Sub-Object

Used for AP2 (Agent Payment Authorization) mandate requirements.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `required` | boolean | Yes | — | Whether a mandate is required (`true`) or optional (`false`). |
| `minPerTx` | string | No | Amount format (§4.3) | Minimum per-transaction spending limit the mandate must allow. |
| `coinType` | string | No | — | Coin type the mandate must authorize. Must match `asset`. |

### 4.6 Upto Sub-Object

Required when `accepts` includes `"upto"`.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `maxAmount` | string | Yes | Amount format (§4.3) | Maximum authorized amount in base units. Client deposits this; actual may be less. |
| `settlementDeadlineMs` | string | Yes | Amount format (§4.3). Must be in the future. | Deadline for settlement (ms since epoch). After this, payer can reclaim via `expire()`. |
| `estimatedAmount` | string | No | Amount format (§4.3). Must be ≤ `maxAmount`. | Server's estimated cost (advisory). Helps clients set a tight `settlementCeiling`. |
| `usageReportUrl` | string | No | — | URL where the client can query usage/metering data (informational). |

**Settlement Overrides Sub-Object** (used at settle-time):

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `actualAmount` | string | Yes | Amount format (§4.3). Must be ≤ `maxAmount`. | Actual amount to settle, based on observed usage. |

### 4.7 Stream Sub-Object

Required when `accepts` includes `"stream"`.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `ratePerSecond` | string | Yes | Amount format (§4.3) | Rate in base units per second. |
| `budgetCap` | string | Yes | Amount format (§4.3) | Maximum total budget in base units. |
| `minDeposit` | string | Yes | Amount format (§4.3) | Minimum initial deposit in base units. |
| `streamSetupUrl` | string | No | — | URL for stream status checks. |

### 4.8 Escrow Sub-Object

Required when `accepts` includes `"escrow"`.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `seller` | string | Yes | — | Seller/payee address. |
| `deadlineMs` | string | Yes | Amount format (§4.3) | Escrow deadline as Unix timestamp in milliseconds. |
| `arbiter` | string | No | — | Arbiter address for dispute resolution. |

### 4.9 Unlock Sub-Object

Required when `accepts` includes `"unlock"`.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `encryptionId` | string | Yes | — | Encryption key identifier for key servers. |
| `encryptedContentId` | string | Yes | — | Identifier for the encrypted content (e.g., Walrus blob ID, IPFS CID). |
| `encryptionServiceId` | string | Yes | — | Identifier for the encryption service or module (e.g., Sui package ID, EVM contract address). |

### 4.10 Prepaid Sub-Object

Required when `accepts` includes `"prepaid"`.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `ratePerCall` | string | Yes | Amount format (§4.3) | Maximum base units per API call (rate cap). |
| `minDeposit` | string | Yes | Amount format (§4.3) | Minimum deposit amount in base units. |
| `withdrawalDelayMs` | string | Yes | Amount format (§4.3). Value MUST be ≥ 60000 (1 min) and ≤ 604800000 (7 days). | Withdrawal delay in milliseconds. Agent must wait this long after the last provider claim before withdrawing remaining funds. |
| `maxCalls` | string | No | Amount format (§4.3) | Maximum number of API calls. Omit for unlimited. |
| `providerPubkey` | string | No | — | Provider's Ed25519 public key (hex, 32 bytes). Enables v0.2 signed receipt mode. |
| `disputeWindowMs` | string | No | — | Dispute window in milliseconds. Min 60000, max 86400000. |

**Pairing invariant**: `providerPubkey` and `disputeWindowMs` MUST both be present (v0.2 mode) or both absent (v0.1 mode). Implementations MUST reject requirements where only one is present.

### 4.11 Extensions Field

The `extensions` field is an opaque key-value bag for forward-compatible extensibility. Implementations:

- MUST pass `extensions` through without content validation
- MUST NOT use `extensions` for security-critical fields
- MUST treat extension values as untrusted input

Scheme implementations that consume specific extension keys SHOULD validate those keys independently.

The `extensions` field is intended as a proving ground for features that may be promoted to first-class typed fields in a future protocol version.

## 5. Payment Payload

The Payment Payload is sent by the client in the `x-payment` header (or request body for body transport). It contains a signed transaction for the selected payment scheme.

### 5.1 Common Fields

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `s402Version` | string | No | If present, MUST be `"1"` | Protocol version. Optional on payloads for x402 interop. |
| `scheme` | string | Yes | One of: `"exact"`, `"upto"`, `"stream"`, `"escrow"`, `"unlock"`, `"prepaid"` | The payment scheme being used. MUST be in the server's `accepts` array. |
| `payload` | object | Yes | Scheme-specific inner fields. See below. | The scheme-specific payment data. |

### 5.2 Payload Inner Fields by Scheme

**Exact** (`scheme: "exact"`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.transaction` | string | Yes | Base64-encoded signed transaction bytes. |
| `payload.signature` | string | Yes | Base64-encoded signature. |

**Upto** (`scheme: "upto"`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.transaction` | string | Yes | Base64-encoded signed deposit transaction (creates UptoDeposit on-chain). |
| `payload.signature` | string | Yes | Base64-encoded signature. |
| `payload.maxAmount` | string | Yes | Maximum authorized amount. Must match `requirements.upto.maxAmount`. |
| `payload.settlementCeiling` | string | No | Client-chosen settlement ceiling (on-chain enforced). Must be ≤ `maxAmount`. |

**Stream** (`scheme: "stream"`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.transaction` | string | Yes | Base64-encoded stream creation transaction. |
| `payload.signature` | string | Yes | Base64-encoded signature. |

**Escrow** (`scheme: "escrow"`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.transaction` | string | Yes | Base64-encoded escrow creation transaction. |
| `payload.signature` | string | Yes | Base64-encoded signature. |

**Unlock** (`scheme: "unlock"`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.transaction` | string | Yes | Base64-encoded escrow creation transaction (TX1 of two-stage flow). |
| `payload.signature` | string | Yes | Base64-encoded signature. |
| `payload.encryptionId` | string | Yes | Encryption key identifier. Must match requirements. |

**Prepaid** (`scheme: "prepaid"`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.transaction` | string | Yes | Base64-encoded deposit transaction. |
| `payload.signature` | string | Yes | Base64-encoded signature. |
| `payload.ratePerCall` | string | Yes | Committed rate per call. Must match requirements. |
| `payload.maxCalls` | string | No | Committed max calls cap. Must match requirements if present. |

## 6. Settlement Response

The Settlement Response is sent by the server in the `payment-response` header of the 200 response after successful payment, or in a non-200 response on failure.

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `success` | boolean | Yes | — | Whether settlement succeeded. |
| `txDigest` | string | No | — | On-chain transaction digest/hash. |
| `receiptId` | string | No | — | On-chain receipt object ID. |
| `finalityMs` | number | No | Finite number. | Time to finality in milliseconds. |
| `actualAmount` | string | No | — | Actual amount settled in base units (upto scheme). |
| `depositId` | string | No | — | UptoDeposit object ID (upto scheme). |
| `streamId` | string | No | — | Stream object ID (stream scheme). |
| `escrowId` | string | No | — | Escrow object ID (escrow scheme). |
| `balanceId` | string | No | — | PrepaidBalance object ID (prepaid scheme). |
| `error` | string | No | — | Human-readable error message (on failure). |
| `errorCode` | string | No | One of the codes in §8. | Machine-readable error code (on failure). |

## 7. Signed Usage Receipts

For the prepaid scheme (v0.2 mode), providers sign each API response with a receipt header. This enables cryptographic fraud proofs.

### 7.1 Receipt Header

| Header | Direction | Content |
|--------|-----------|---------|
| `X-S402-Receipt` | Server → Client | Colon-separated receipt fields |

### 7.2 Receipt Format

```
v2:<base64(signature)>:<callNumber>:<timestampMs>:<base64(responseHash)>
```

| Part | Type | Constraints | Description |
|------|------|-------------|-------------|
| Version | string | MUST be `"v2"` | Receipt format version. |
| Signature | base64 | Decoded length MUST be exactly 64 bytes | Ed25519 signature over the BCS-encoded receipt message. |
| Call number | integer string | Positive (> 0) | Sequential call number, 1-indexed. |
| Timestamp | integer string | Positive (> 0) | Unix timestamp in milliseconds when the response was generated. |
| Response hash | base64 | Decoded length MUST be exactly 32 bytes | SHA-256 hash of the response body. |

Implementations MUST reject receipts where:
- The header is empty
- The number of colon-separated parts is not exactly 5
- The version is not `"v2"`
- The call number or timestamp is not a valid positive integer
- The signature does not decode to exactly 64 bytes
- The response hash does not decode to exactly 32 bytes

## 8. Error Codes

Every s402 error carries three fields: `code` (machine-readable), `retryable` (boolean), and `suggestedAction` (human-readable guidance). This design enables autonomous agents to handle errors programmatically.

| Code | Retryable | Suggested Action |
|------|:---------:|-----------------|
| `INSUFFICIENT_BALANCE` | No | Top up wallet balance or try with a smaller amount |
| `MANDATE_EXPIRED` | No | Request a new mandate from the delegator |
| `MANDATE_LIMIT_EXCEEDED` | No | Request mandate increase or split across transactions |
| `STREAM_DEPLETED` | Yes | Top up the stream deposit |
| `ESCROW_DEADLINE_PASSED` | No | Create a new escrow with a later deadline |
| `UNLOCK_DECRYPTION_FAILED` | Yes | Re-request decryption key with a fresh session key |
| `FINALITY_TIMEOUT` | Yes | Transaction submitted but not confirmed — retry finality check |
| `FACILITATOR_UNAVAILABLE` | Yes | Fall back to direct settlement if signer is available |
| `INVALID_PAYLOAD` | No | Check payload format and re-sign the transaction |
| `SCHEME_NOT_SUPPORTED` | No | Use the "exact" scheme (always supported for x402 compat) |
| `NETWORK_MISMATCH` | No | Ensure client and server are on the same network |
| `SIGNATURE_INVALID` | No | Re-sign the transaction with the correct keypair |
| `REQUIREMENTS_EXPIRED` | Yes | Re-fetch payment requirements from the server |
| `VERIFICATION_FAILED` | No | Check payment amount and transaction structure |
| `SETTLEMENT_FAILED` | Yes | Transient RPC failure during settlement — retry in a few seconds |

## 9. Discovery

Servers MAY advertise s402 support at `/.well-known/s402.json`:

```json
{
  "s402Version": "1",
  "schemes": ["exact", "upto", "stream", "escrow", "unlock", "prepaid"],
  "networks": ["sui:mainnet"],
  "assets": ["0x2::sui::SUI"],
  "facilitatorUrl": "https://facilitator.example.com",
  "directSettlement": true,
  "mandateSupport": true,
  "protocolFeeBps": 50,
  "protocolFeeAddress": "0x..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `s402Version` | string | Yes | MUST be `"1"`. |
| `schemes` | string[] | Yes | Supported payment schemes. |
| `networks` | string[] | Yes | Supported network identifiers. |
| `assets` | string[] | Yes | Supported asset/coin type identifiers. |
| `facilitatorUrl` | string | No | Default Facilitator URL. |
| `directSettlement` | boolean | Yes | Whether direct settlement (no Facilitator) is supported. |
| `mandateSupport` | boolean | Yes | Whether AP2 mandates are supported. |
| `protocolFeeBps` | number | Yes | Default protocol fee in basis points (0–10000). |
| `protocolFeeAddress` | string | No | Address that receives the protocol fee. |

## 10. Key Stripping (Trust Boundary)

All three decode functions (requirements, payload, settlement response) MUST strip unknown top-level keys from decoded objects. Only the keys listed in this specification SHOULD survive decoding.

This is a defense-in-depth measure at the HTTP trust boundary — it prevents untrusted fields from propagating into application logic.

### 10.1 Known Requirements Keys

`s402Version`, `accepts`, `network`, `asset`, `amount`, `payTo`, `facilitatorUrl`, `mandate`, `protocolFeeBps`, `protocolFeeAddress`, `receiptRequired`, `settlementMode`, `expiresAt`, `upto`, `stream`, `escrow`, `unlock`, `prepaid`, `settlementOverrides`, `extensions`

Sub-object known keys:

- **mandate**: `required`, `minPerTx`, `coinType`
- **upto**: `maxAmount`, `settlementDeadlineMs`, `estimatedAmount`, `usageReportUrl`
- **settlementOverrides**: `actualAmount`
- **stream**: `ratePerSecond`, `budgetCap`, `minDeposit`, `streamSetupUrl`
- **escrow**: `seller`, `arbiter`, `deadlineMs`
- **unlock**: `encryptionId`, `encryptedContentId`, `encryptionServiceId`
- **prepaid**: `ratePerCall`, `maxCalls`, `minDeposit`, `withdrawalDelayMs`, `providerPubkey`, `disputeWindowMs`

### 10.2 Known Payload Keys

Top-level: `s402Version`, `scheme`, `payload`

Inner payload keys per scheme:

- **exact, stream, escrow**: `transaction`, `signature`
- **upto**: `transaction`, `signature`, `maxAmount`, `settlementCeiling`
- **unlock**: `transaction`, `signature`, `encryptionId`
- **prepaid**: `transaction`, `signature`, `ratePerCall`, `maxCalls`

### 10.3 Known Settlement Response Keys

`success`, `txDigest`, `receiptId`, `finalityMs`, `actualAmount`, `depositId`, `streamId`, `escrowId`, `balanceId`, `error`, `errorCode`

## 11. x402 Compatibility

s402 is wire-compatible with Coinbase's x402 V1 protocol on the `exact` scheme.

### 11.1 Header Names

s402 uses the same HTTP header names as x402 V1. An x402 V1 client sending an `exact` payment can interact with an s402 server without modification.

x402 V2 renamed the client header to `payment-signature`. Servers that need to accept x402 V2 clients SHOULD also check the `payment-signature` header.

### 11.2 Protocol Discrimination

The `s402Version` field in the decoded JSON distinguishes s402 from x402. x402 uses `x402Version` (an integer) instead.

### 11.3 Conversion

Implementations MAY provide bidirectional conversion between x402 and s402 formats:

- **x402 → s402**: Map x402's `scheme` to s402's `accepts` array. Use `amount` (V2) or `maxAmountRequired` (V1) for the amount field.
- **s402 → x402**: Only the `exact` scheme has an x402 equivalent. Other schemes (stream, escrow, unlock, prepaid) are s402-only.

Conversion MUST validate the `facilitatorUrl` field using the same protocol-only check (§4.2) to prevent SSRF via dangerous URL schemes.

## 12. Security Considerations

### 12.1 HTTPS Required

s402 payment data (requirements, payloads, settlement responses) travels in HTTP headers as base64-encoded JSON. Without TLS, this data is visible to any network observer. All production deployments MUST use HTTPS.

### 12.2 Requirements Expiration

Servers SHOULD set `expiresAt` on payment requirements to prevent replay of stale 402 responses. Facilitators MUST reject requirements where `Date.now() > expiresAt`.

### 12.3 Facilitator URL Validation

The `facilitatorUrl` field is validated for protocol only (`https:` or `http:`). Implementations that fetch the Facilitator URL MUST apply their own hostname and IP address restrictions (block RFC 1918 private addresses, link-local 169.254.x.x, loopback, cloud metadata endpoints) to prevent SSRF attacks.

### 12.4 Extensions Trust Boundary

The `extensions` field is an opaque bag. Implementations MUST NOT trust data in `extensions` for security-critical decisions. Security-critical data SHOULD use first-class typed fields with explicit validation.

### 12.5 Concurrent Payment Deduplication

Facilitators SHOULD deduplicate concurrent identical payment requests to prevent double resource access. Deduplication keys SHOULD be derived from the scheme name and transaction/signature fields, not from JSON serialization (which is not canonical).

### 12.6 Key Ordering in JSON

JSON key ordering is not guaranteed by the JSON specification. Implementations that serialize s402 objects MUST NOT depend on specific key ordering for correctness. However, for conformance vector compatibility, implementations SHOULD preserve insertion order as described in the [conformance test guide](/guide/conformance).

## 13. Conformance

An implementation is **s402-conformant** if it:

1. Correctly encodes and decodes all three message types (requirements, payload, settlement response) using the encoding specified in §3.2
2. Validates all required fields per §4.1, §5.1, and §6
3. Rejects malformed input with the appropriate error code from §8
4. Strips unknown keys on decode per §10
5. Passes the 161 machine-readable conformance test vectors shipped in the `s402` npm package

The conformance vectors cover: encode, decode, body transport, x402 compat normalization, receipt format/parse, settlement verification, validation rejection, key stripping, and roundtrip identity. See the [Conformance Vectors guide](/guide/conformance) for the vector format and implementation instructions.

---

*This specification is maintained at [s402-protocol.org/specification](https://s402-protocol.org/specification) and [github.com/s402-protocol/core](https://github.com/s402-protocol/core). Contributions and corrections are welcome via GitHub issues or pull requests.*
