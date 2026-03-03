# s402 v0.2.x API Stability Declaration

This document classifies every export of `s402@0.2.x` by stability level.

| Level | Meaning |
|-------|---------|
| **Stable** | Will not break within 0.2.x. Safe for production use. |
| **Experimental** | New in 0.2.0. API shape may change in 0.3.0. |
| **Internal** | Available via sub-path import but not part of the public API. May change or be removed without notice. |

---

## Stable

These exports are battle-tested (405 tests including 133-vector conformance suite + security audit) and core to the protocol.

| Export | Sub-path | Kind |
|--------|----------|------|
| `s402PaymentRequirements` | `s402/types` | type |
| `s402Scheme` | `s402/types` | type |
| `s402SettlementMode` | `s402/types` | type |
| `s402StreamExtra` | `s402/types` | type |
| `s402EscrowExtra` | `s402/types` | type |
| `s402UnlockExtra` | `s402/types` | type |
| `s402PrepaidExtra` | `s402/types` | type |
| `s402MandateRequirements` | `s402/types` | type |
| `s402Mandate` | `s402/types` | type |
| `s402PaymentPayloadBase` | `s402/types` | type |
| `s402ExactPayload` | `s402/types` | type |
| `s402StreamPayload` | `s402/types` | type |
| `s402EscrowPayload` | `s402/types` | type |
| `s402UnlockPayload` | `s402/types` | type |
| `s402PrepaidPayload` | `s402/types` | type |
| `s402PaymentPayload` | `s402/types` | type |
| `s402SettleResponse` | `s402/types` | type |
| `s402VerifyResponse` | `s402/types` | type |
| `s402Discovery` | `s402/types` | type |
| `s402PaymentSession` | `s402/types` | type |
| `s402ServiceEntry` | `s402/types` | type |
| `s402RegistryQuery` | `s402/types` | type |
| `S402_VERSION` | `s402/types` | const |
| `S402_HEADERS` | `s402/types` | const |
| `encodePaymentRequired` | `s402/http` | function |
| `decodePaymentRequired` | `s402/http` | function |
| `encodePaymentPayload` | `s402/http` | function |
| `decodePaymentPayload` | `s402/http` | function |
| `encodeSettleResponse` | `s402/http` | function |
| `decodeSettleResponse` | `s402/http` | function |
| `detectProtocol` | `s402/http` | function |
| `extractRequirementsFromResponse` | `s402/http` | function |
| `isValidAmount` | `s402/http` | function |
| `validateRequirementsShape` | `s402/http` | function |
| `s402Client` | `s402` | class |
| `s402ResourceServer` | `s402` | class |
| `s402Facilitator` | `s402` | class |
| `s402ClientScheme` | `s402` | type |
| `s402ServerScheme` | `s402` | type |
| `s402FacilitatorScheme` | `s402` | type |
| `s402RouteConfig` | `s402` | type |
| `s402Error` | `s402/errors` | class |
| `s402ErrorCode` | `s402/errors` | const |
| `createS402Error` | `s402/errors` | function |
| `s402ErrorCodeType` | `s402/errors` | type |
| `s402ErrorInfo` | `s402/errors` | type |
| `normalizeRequirements` | `s402/compat` | function |
| `fromX402Requirements` | `s402/compat` | function |
| `fromX402Payload` | `s402/compat` | function |
| `toX402Requirements` | `s402/compat` | function |
| `toX402Payload` | `s402/compat` | function |
| `isS402` | `s402/compat` | function |
| `isX402` | `s402/compat` | function |
| `isX402Envelope` | `s402/compat` | function |
| `fromX402Envelope` | `s402/compat` | function |
| `x402PaymentRequirements` | `s402/compat` | type |
| `x402PaymentRequiredEnvelope` | `s402/compat` | type |
| `x402PaymentPayload` | `s402/compat` | type |

## Experimental

New in 0.2.0. API may change in 0.3.0.

| Export | Sub-path | Kind | Notes |
|--------|----------|------|-------|
| `formatReceiptHeader` | `s402/receipts` | function | v0.2 receipt wire format |
| `parseReceiptHeader` | `s402/receipts` | function | v0.2 receipt wire format |
| `S402_RECEIPT_HEADER` | `s402/receipts` | const | Header name for receipts |
| `s402Receipt` | `s402/receipts` | type | Receipt data shape |
| `s402ReceiptSigner` | `s402/receipts` | type | Signing function signature |
| `s402ReceiptVerifier` | `s402/receipts` | type | Verification function signature |
| `S402_CONTENT_TYPE` | `s402/http` | const | Body transport content type |
| `encodeRequirementsBody` | `s402/http` | function | Body transport encode |
| `decodeRequirementsBody` | `s402/http` | function | Body transport decode |
| `encodePayloadBody` | `s402/http` | function | Body transport encode |
| `decodePayloadBody` | `s402/http` | function | Body transport decode |
| `encodeSettleBody` | `s402/http` | function | Body transport encode |
| `decodeSettleBody` | `s402/http` | function | Body transport decode |
| `detectTransport` | `s402/http` | function | Header vs body transport detection |
| `isValidU64Amount` | `s402/http` | function | Sui-specific u64 magnitude check — may move to `@sweefi/sui` in 0.3.0 |
| `s402DirectScheme` | `s402` | type | Direct settlement interface |

## Internal

Exported from `s402/http` sub-path but **not** from the barrel (`s402`). Not part of the public API.

| Export | Sub-path | Kind | Notes |
|--------|----------|------|-------|
| `pickRequirementsFields` | `s402/http` | function | Key-stripping at trust boundary |
| `pickPayloadFields` | `s402/http` | function | Key-stripping at trust boundary |
| `pickSettleResponseFields` | `s402/http` | function | Key-stripping at trust boundary |
| `validateMandateShape` | `s402/http` | function | Sub-object validator |
| `validateStreamShape` | `s402/http` | function | Sub-object validator |
| `validateEscrowShape` | `s402/http` | function | Sub-object validator |
| `validateUnlockShape` | `s402/http` | function | Sub-object validator |
| `validatePrepaidShape` | `s402/http` | function | Sub-object validator |
| `validateSubObjects` | `s402/http` | function | Sub-object validator dispatcher |
