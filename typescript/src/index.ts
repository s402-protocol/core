/**
 * s402 — Chain-agnostic HTTP 402 protocol
 *
 * Six payment schemes: exact, upto, prepaid, stream, escrow, unlock.
 * AP2 mandate support. Direct settlement. On-chain receipts.
 * Wire-compatible with x402. Zero runtime dependencies.
 * Optional x402 compat layer available via 's402/compat/x402'.
 *
 * @packageDocumentation
 */

// Types
export type {
  s402Scheme,
  s402SettlementMode,
  s402PaymentRequirements,
  // Scheme-specific extras (ordered by tier)
  s402UptoExtra,
  s402SettlementOverrides,
  s402PrepaidExtra,
  s402StreamExtra,
  s402EscrowExtra,
  s402UnlockExtra,
  s402KeyServerRef,
  s402UnlockFulfillment,
  // Mandate
  s402MandateRequirements,
  s402Mandate,
  // Payment payloads (ordered by tier)
  s402PaymentPayloadBase,
  s402ExactPayload,
  s402UptoPayload,
  s402PrepaidPayload,
  s402StreamPayload,
  s402EscrowPayload,
  s402UnlockPayload,
  s402PaymentPayload,
  // Responses
  s402SettleResponse,
  s402VerifyResponse,
  // Discovery & session
  s402Discovery,
  s402PaymentSession,
  s402ServiceEntry,
  s402RegistryQuery,
} from './types.js';
export { S402_VERSION, S402_HEADERS } from './types.js';

// Scheme interfaces
export type {
  s402ClientScheme,
  s402ServerScheme,
  s402FacilitatorScheme,
  s402DirectScheme,
  s402RouteConfig,
  s402SettlementVerification,
} from './scheme.js';

// Client
export { s402Client } from './client.js';

// Server
export { s402ResourceServer } from './server.js';

// Facilitator
export { s402Facilitator } from './facilitator.js';
export type { s402ProcessOptions } from './facilitator.js';

// HTTP helpers — header transport (base64-encoded JSON in HTTP headers)
export {
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  detectProtocol,
  extractRequirementsFromResponse,
  isValidAmount,
  isValidU64Amount,
  validateRequirementsShape,
} from './http.js';

// HTTP helpers — body transport (raw JSON, 1 MB cap for defense-in-depth)
export {
  S402_CONTENT_TYPE,
  MAX_BODY_BYTES,
  encodeRequirementsBody,
  decodeRequirementsBody,
  encodePayloadBody,
  decodePayloadBody,
  encodeSettleBody,
  decodeSettleBody,
  detectTransport,
} from './http.js';

// Transport abstraction (ADR-011) — one seam, any carrier: HTTP, MCP, and A2A.
export { httpTransport, mcpTransport, a2aTransport, S402_MCP_META_KEY, S402_A2A_KEYS } from './transport.js';
export type {
  PaymentTransport,
  PaymentCarrierContext,
  PaymentStatus,
  Decoded,
  McpMetaFrame,
  A2aMetadataFrame,
} from './transport.js';

// Settlement envelope (ADR-007) — chain-agnostic, typed response format.
export {
  S402_ENVELOPE_CONTENT_TYPE,
  computeTxBinding,
  buildSettledEnvelope,
  buildVerifiedEnvelope,
  buildRejectedEnvelope,
  buildPendingEnvelope,
  encodeEnvelopeBody,
  decodeEnvelopeBody,
  validateEnvelopeShape,
  verifyEnvelope,
  constantTimeStringEqual,
} from './envelope.js';
export type {
  s402Envelope,
  s402EnvelopeBase,
  s402EnvelopeSettled,
  s402EnvelopeVerified,
  s402EnvelopeRejected,
  s402EnvelopePending,
  s402Algs,
  s402DigestAlg,
  s402SigAlg,
  BuildEnvelopeContext,
  VerifyEnvelopeOptions,
} from './envelope.js';

// Canonicalization helpers (RFC 8785 JCS — primarily used internally for txBinding).
export { canonicalize, canonicalizeToString } from './canonicalization.js';
export type { JsonValue } from './canonicalization.js';
// Internal validators (validateSubObjects, validateMandateShape, validate*Shape,
// pickRequirementsFields) are available via 's402/http' for advanced use cases.

// Compatibility — available via 's402/compat/x402' sub-path import.
// Not re-exported here to keep the main barrel focused on s402-native APIs.
// import { normalizeRequirements, fromX402Requirements } from 's402/compat/x402';

// Accept-Payment content negotiation (RFC 7231-style q-values)
export {
  parseAcceptPayment,
  formatAcceptPayment,
  selectBestScheme,
} from './accept-payment.js';
export type { AcceptPaymentEntry } from './accept-payment.js';

// Receipt HTTP helpers (v0.2 signed usage receipts)
export { formatReceiptHeader, parseReceiptHeader, S402_RECEIPT_HEADER } from './receipts.js';
export type { s402Receipt, s402ReceiptSigner, s402ReceiptVerifier } from './receipts.js';

// Extensions
export type {
  s402Extension,
  s402ClientExtension,
  s402ServerExtension,
  s402FacilitatorExtension,
  s402ExtensionErrorHandler,
} from './extensions.js';
export {
  s402ExtensionRegistry,
  getExtensionData,
  setExtensionData,
  runExtensionHooks,
} from './extensions.js';

// Errors
export {
  s402ErrorCode,
  s402Error,
  createS402Error,
} from './errors.js';
export type { s402ErrorCodeType, s402ErrorInfo } from './errors.js';
