/**
 * s402 — Sui-native HTTP 402 protocol
 *
 * Wire-compatible with x402, architecturally superior via Sui's atomic PTBs.
 * Five payment schemes: exact, stream, escrow, seal, prepaid.
 * AP2 mandate support. Direct settlement. On-chain receipts.
 *
 * @packageDocumentation
 */

// Types
export type {
  s402Scheme,
  s402SettlementMode,
  s402PaymentRequirements,
  s402StreamExtra,
  s402EscrowExtra,
  s402SealExtra,
  s402PrepaidExtra,
  s402MandateRequirements,
  s402Mandate,
  s402PaymentPayloadBase,
  s402ExactPayload,
  s402StreamPayload,
  s402EscrowPayload,
  s402SealPayload,
  s402PrepaidPayload,
  s402PaymentPayload,
  s402SettleResponse,
  s402VerifyResponse,
  s402Discovery,
} from './types.js';
export { S402_VERSION, S402_HEADERS } from './types.js';

// Scheme interfaces
export type {
  s402ClientScheme,
  s402ServerScheme,
  s402FacilitatorScheme,
  s402DirectScheme,
  s402RouteConfig,
} from './scheme.js';

// Client
export { s402Client } from './client.js';

// Server
export { s402ResourceServer } from './server.js';

// Facilitator
export { s402Facilitator } from './facilitator.js';

// HTTP helpers
export {
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  detectProtocol,
  extractRequirementsFromResponse,
} from './http.js';

// Compatibility
export {
  fromX402Requirements,
  fromX402Payload,
  fromX402Envelope,
  toX402Requirements,
  toX402Payload,
  isS402,
  isX402,
  isX402Envelope,
  normalizeRequirements,
} from './compat.js';
export type { x402PaymentRequirements, x402PaymentRequiredEnvelope, x402PaymentPayload } from './compat.js';

// Errors
export {
  s402ErrorCode,
  s402Error,
  createS402Error,
} from './errors.js';
export type { s402ErrorCodeType, s402ErrorInfo } from './errors.js';
