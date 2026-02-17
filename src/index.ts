/**
 * s402 — Sui-native HTTP 402 protocol
 *
 * Atomic settlement via Sui's PTBs.
 * Five payment schemes: exact, stream, escrow, unlock, prepaid.
 * AP2 mandate support. Direct settlement. On-chain receipts.
 * Optional x402 compat layer available via 's402/compat'.
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
  s402UnlockExtra,
  s402PrepaidExtra,
  s402MandateRequirements,
  s402Mandate,
  s402PaymentPayloadBase,
  s402ExactPayload,
  s402StreamPayload,
  s402EscrowPayload,
  s402UnlockPayload,
  s402PrepaidPayload,
  s402PaymentPayload,
  s402SettleResponse,
  s402VerifyResponse,
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
  isValidAmount,
  validateRequirementsShape,
} from './http.js';
// Internal validators (validateSubObjects, validateMandateShape, validate*Shape,
// pickRequirementsFields) are available via 's402/http' for advanced use cases.

// Compatibility — available via 's402/compat' sub-path import.
// Not re-exported here to keep the main barrel focused on s402-native APIs.
// import { normalizeRequirements, fromX402Requirements } from 's402/compat';

// Errors
export {
  s402ErrorCode,
  s402Error,
  createS402Error,
} from './errors.js';
export type { s402ErrorCodeType, s402ErrorInfo } from './errors.js';
