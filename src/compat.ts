/**
 * s402 ↔ x402 Compatibility Layer
 *
 * Enables bidirectional interop:
 *   - x402 clients can talk to s402 servers (via "exact" scheme)
 *   - s402 clients can talk to x402 servers (graceful degradation)
 *
 * Roundtrip: fromX402(toX402(s402)) preserves all x402 fields.
 * s402-only fields (mandate, stream, escrow, unlock extras) are stripped.
 */

import type { s402PaymentRequirements, s402ExactPayload, s402PaymentPayload } from './types.js';
import { S402_VERSION } from './types.js';
import { s402Error } from './errors.js';
import { isValidAmount, validateSubObjects, validateRequirementsShape, pickRequirementsFields } from './http.js';

// ══════════════════════════════════════════════════════════════
// x402 types (minimal — just what we need for conversion)
// ══════════════════════════════════════════════════════════════

/**
 * x402 PaymentRequirements shape — supports both V1 and V2 wire formats.
 *
 * V1 wire format uses `maxAmountRequired`; V2 uses `amount`.
 * Both versions require `maxTimeoutSeconds`.
 * V1 includes resource metadata (`resource`, `description`, `mimeType`) inline;
 * V2 hoists these to the `PaymentRequired` envelope.
 */
export interface x402PaymentRequirements {
  x402Version: number;
  scheme: string;
  network: string;
  asset: string;
  /** V2 amount field (base units). */
  amount?: string;
  /** V1 amount field (renamed to `amount` in V2). */
  maxAmountRequired?: string;
  payTo: string;
  /** Required in x402. Seconds the facilitator will wait before rejecting. */
  maxTimeoutSeconds?: number;
  /** V1-only: resource URL. V2 moves this to the PaymentRequired envelope. */
  resource?: string;
  /** V1-only: human-readable description. */
  description?: string;
  facilitatorUrl?: string;
  extensions?: Record<string, unknown>;
}

/**
 * x402 V2 PaymentRequired envelope — wraps an array of requirements.
 * In V2, `x402Version` lives on this envelope, not on individual requirements.
 * Resource metadata and extensions are also at the envelope level.
 */
export interface x402PaymentRequiredEnvelope {
  x402Version: number;
  accepts: x402PaymentRequirements[];
  resource?: { url?: string; mimeType?: string; description?: string };
  extensions?: Record<string, unknown>;
  error?: string;
}

/** Minimal x402 PaymentPayload shape */
export interface x402PaymentPayload {
  x402Version: number;
  scheme: string;
  payload: {
    transaction: string;
    signature: string;
  };
}

// ══════════════════════════════════════════════════════════════
// Convert x402 → s402
// ══════════════════════════════════════════════════════════════

/**
 * Convert inbound x402 requirements to s402 format.
 * Handles both V1 (`maxAmountRequired`) and V2 (`amount`) wire formats.
 * Maps x402's single scheme to s402's accepts array.
 */
export function fromX402Requirements(x402: x402PaymentRequirements): s402PaymentRequirements {
  // V1 uses maxAmountRequired, V2 uses amount
  const amount = x402.amount ?? x402.maxAmountRequired;
  if (!amount) {
    throw new s402Error('INVALID_PAYLOAD',
      'x402 requirements missing both "amount" (V2) and "maxAmountRequired" (V1)');
  }
  if (!isValidAmount(amount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Invalid amount "${amount}": must be a non-negative integer string`);
  }
  return {
    s402Version: S402_VERSION,
    accepts: ['exact'],
    network: x402.network,
    asset: x402.asset,
    amount,
    payTo: x402.payTo,
    facilitatorUrl: x402.facilitatorUrl,
    extensions: x402.extensions,
  };
}

/**
 * Convert inbound x402 payment payload to s402 format.
 * Validates that required fields are present and correctly typed.
 */
export function fromX402Payload(x402: x402PaymentPayload): s402ExactPayload {
  if (x402.payload == null || typeof x402.payload !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'x402 payload missing or not an object');
  }
  if (typeof x402.payload.transaction !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `x402 payload.transaction must be a string, got ${typeof x402.payload.transaction}`);
  }
  if (typeof x402.payload.signature !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `x402 payload.signature must be a string, got ${typeof x402.payload.signature}`);
  }
  return {
    s402Version: S402_VERSION,
    scheme: 'exact',
    payload: {
      transaction: x402.payload.transaction,
      signature: x402.payload.signature,
    },
  };
}

// ══════════════════════════════════════════════════════════════
// Convert s402 → x402
// ══════════════════════════════════════════════════════════════

/**
 * Convert outbound s402 requirements to x402 V1 wire format.
 * Strips s402-only fields (mandate, stream, escrow, unlock extras).
 * Only works for "exact" scheme — other schemes have no x402 equivalent.
 *
 * Includes both `maxAmountRequired` (V1) and `amount` (V2) for maximum interop.
 * Includes `maxTimeoutSeconds` (required in x402, defaults to 60s).
 * V1 metadata fields (`resource`, `description`) default to empty strings.
 */
export function toX402Requirements(
  s402: s402PaymentRequirements,
  overrides?: { maxTimeoutSeconds?: number; resource?: string; description?: string },
): x402PaymentRequirements {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: s402.network,
    asset: s402.asset,
    amount: s402.amount,
    maxAmountRequired: s402.amount,
    payTo: s402.payTo,
    facilitatorUrl: s402.facilitatorUrl,
    maxTimeoutSeconds: overrides?.maxTimeoutSeconds ?? 60,
    resource: overrides?.resource ?? '',
    description: overrides?.description ?? '',
    extensions: s402.extensions,
  };
}

/**
 * Convert outbound s402 payload to x402 format.
 * Only works for exact scheme payloads.
 */
export function toX402Payload(s402: s402PaymentPayload): x402PaymentPayload | null {
  if (s402.scheme !== 'exact') return null;

  const exact = s402 as s402ExactPayload;
  return {
    x402Version: 1,
    scheme: 'exact',
    payload: {
      transaction: exact.payload.transaction,
      signature: exact.payload.signature,
    },
  };
}

// ══════════════════════════════════════════════════════════════
// Detection helpers
// ══════════════════════════════════════════════════════════════

/**
 * Check if a decoded JSON object is s402 format.
 */
export function isS402(obj: Record<string, unknown>): boolean {
  return 's402Version' in obj;
}

/**
 * Check if a decoded JSON object is x402 format (V1 flat or V2 envelope).
 */
export function isX402(obj: Record<string, unknown>): boolean {
  return 'x402Version' in obj && !('s402Version' in obj);
}

/**
 * Check if a decoded JSON object is an x402 V2 envelope (has `accepts` array).
 * V2 envelopes wrap requirements in an `accepts` array instead of flat fields.
 */
export function isX402Envelope(obj: Record<string, unknown>): boolean {
  return 'x402Version' in obj && Array.isArray(obj.accepts) && !('s402Version' in obj);
}

/**
 * Convert an x402 V2 envelope to s402 format.
 * Picks the first requirement from the `accepts` array.
 * Copies `x402Version` from the envelope onto the requirement for downstream processing.
 */
export function fromX402Envelope(envelope: x402PaymentRequiredEnvelope): s402PaymentRequirements {
  if (!envelope.accepts || envelope.accepts.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 V2 envelope has empty accepts array');
  }
  // Pick the first requirement and attach x402Version from the envelope
  const req: x402PaymentRequirements = {
    ...envelope.accepts[0],
    x402Version: envelope.x402Version,
  };
  // Validate the inner requirement — the V1 flat path does this via normalizeRequirements,
  // but the V2 envelope path was missing this check.
  validateX402Shape(req as unknown as Record<string, unknown>);
  return fromX402Requirements(req);
}

/**
 * Auto-detect and normalize: if x402, convert to s402. If already s402, validate and pass through.
 * Handles x402 V1 (flat), x402 V2 (envelope with accepts array), and s402 formats.
 * Validates required fields to catch malformed/malicious payloads at the trust boundary.
 *
 * Returns a clean object with only known s402 fields — unknown top-level keys are stripped.
 */
export function normalizeRequirements(
  obj: Record<string, unknown>,
): s402PaymentRequirements {
  if (isS402(obj)) {
    // Delegate to the canonical validator in http.ts — single source of truth.
    validateRequirementsShape(obj);
    return pickRequirementsFields(obj);
  }
  // x402 V2 envelope: { x402Version, accepts: [{scheme, network, ...}, ...] }
  if (isX402Envelope(obj)) {
    return fromX402Envelope(obj as unknown as x402PaymentRequiredEnvelope);
  }
  // x402 V1 flat: { x402Version, scheme, network, amount/maxAmountRequired, ... }
  if (isX402(obj)) {
    validateX402Shape(obj);
    return fromX402Requirements(obj as unknown as x402PaymentRequirements);
  }
  throw new s402Error('INVALID_PAYLOAD', 'Unrecognized payment requirements format: missing s402Version or x402Version');
}

/** Validate that an x402 object has required fields (supports V1 and V2). */
function validateX402Shape(obj: Record<string, unknown>): void {
  const missing: string[] = [];
  if (typeof obj.scheme !== 'string') missing.push('scheme (string)');
  if (typeof obj.network !== 'string') missing.push('network (string)');
  if (typeof obj.asset !== 'string') missing.push('asset (string)');
  if (typeof obj.payTo !== 'string') missing.push('payTo (string)');
  // V1 uses maxAmountRequired, V2 uses amount — one must be present
  if (typeof obj.amount !== 'string' && typeof obj.maxAmountRequired !== 'string') {
    missing.push('amount or maxAmountRequired (string)');
  } else {
    // Validate numeric format of whichever amount field is present
    const amt = (typeof obj.amount === 'string' ? obj.amount : obj.maxAmountRequired) as string;
    if (!isValidAmount(amt)) {
      throw new s402Error('INVALID_PAYLOAD',
        `Invalid amount "${amt}": must be a non-negative integer string`);
    }
  }
  if (missing.length > 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed x402 requirements: missing or invalid fields: ${missing.join(', ')}`);
  }
}
