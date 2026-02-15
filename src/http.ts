/**
 * s402 HTTP Helpers — encode/decode for HTTP headers
 *
 * Wire-compatible with x402: same header names, same base64 encoding.
 * The presence of `s402Version` in the decoded JSON distinguishes s402 from x402.
 *
 * Uses Unicode-safe base64 (UTF-8 → base64) so the `extra` field and error
 * messages can contain any characters. For ASCII-only content (the common case),
 * the output is identical to plain btoa/atob.
 */

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
} from './types.js';
import { S402_HEADERS } from './types.js';
import { s402Error } from './errors.js';

// ══════════════════════════════════════════════════════════════
// Unicode-safe base64 helpers
// ══════════════════════════════════════════════════════════════

/** Encode a UTF-8 string to base64. Safe for any Unicode content. */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode base64 to a UTF-8 string. Safe for any Unicode content. */
function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ══════════════════════════════════════════════════════════════
// Encode (object → base64 string for HTTP header)
// ══════════════════════════════════════════════════════════════

/** Encode payment requirements for the `payment-required` header */
export function encodePaymentRequired(requirements: s402PaymentRequirements): string {
  return toBase64(JSON.stringify(requirements));
}

/** Encode payment payload for the `X-PAYMENT` header */
export function encodePaymentPayload(payload: s402PaymentPayload): string {
  return toBase64(JSON.stringify(payload));
}

/** Encode settlement response for the `payment-response` header */
export function encodeSettleResponse(response: s402SettleResponse): string {
  return toBase64(JSON.stringify(response));
}

// ══════════════════════════════════════════════════════════════
// Decode (base64 string from HTTP header → object)
// ══════════════════════════════════════════════════════════════

/** Decode payment requirements from the `payment-required` header */
export function decodePaymentRequired(header: string): s402PaymentRequirements {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(header));
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to decode payment-required header: ${e instanceof Error ? e.message : 'invalid base64 or JSON'}`);
  }
  validateRequirementsShape(parsed);
  return parsed as s402PaymentRequirements;
}

/** Decode payment payload from the `X-PAYMENT` header */
export function decodePaymentPayload(header: string): s402PaymentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(header));
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to decode X-PAYMENT header: ${e instanceof Error ? e.message : 'invalid base64 or JSON'}`);
  }
  validatePayloadShape(parsed);
  return parsed as s402PaymentPayload;
}

/** Decode settlement response from the `payment-response` header */
export function decodeSettleResponse(header: string): s402SettleResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(header));
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to decode payment-response header: ${e instanceof Error ? e.message : 'invalid base64 or JSON'}`);
  }
  validateSettleShape(parsed);
  return parsed as s402SettleResponse;
}

// ══════════════════════════════════════════════════════════════
// Shape validators (trust boundary — untrusted network input)
// ══════════════════════════════════════════════════════════════

/** Valid s402 payment scheme values */
const VALID_SCHEMES = new Set<string>(['exact', 'stream', 'escrow', 'seal', 'prepaid']);

/** Validate that decoded payment requirements have the required shape. */
function validateRequirementsShape(obj: unknown): void {
  if (obj == null || typeof obj !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'Payment requirements is not an object');
  }
  const record = obj as Record<string, unknown>;
  const missing: string[] = [];
  if (!Array.isArray(record.accepts)) missing.push('accepts (array)');
  if (typeof record.network !== 'string') missing.push('network (string)');
  if (typeof record.asset !== 'string') missing.push('asset (string)');
  if (typeof record.amount !== 'string') missing.push('amount (string)');
  if (typeof record.payTo !== 'string') missing.push('payTo (string)');
  if (missing.length > 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed payment requirements: missing ${missing.join(', ')}`);
  }
}

/** Validate that a decoded payment payload has the required shape. */
function validatePayloadShape(obj: unknown): void {
  if (obj == null || typeof obj !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'Payment payload is not an object');
  }
  const record = obj as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof record.scheme !== 'string') {
    missing.push('scheme');
  } else if (!VALID_SCHEMES.has(record.scheme)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Unknown payment scheme "${record.scheme}". Valid: ${[...VALID_SCHEMES].join(', ')}`);
  }
  if (record.payload == null || typeof record.payload !== 'object') missing.push('payload');
  if (missing.length > 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed payment payload: missing ${missing.join(', ')}`);
  }
}

/** Validate that a decoded settle response has the required shape. */
function validateSettleShape(obj: unknown): void {
  if (obj == null || typeof obj !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'Settle response is not an object');
  }
  const record = obj as Record<string, unknown>;
  if (typeof record.success !== 'boolean') {
    throw new s402Error('INVALID_PAYLOAD',
      'Malformed settle response: missing or invalid "success" (boolean)');
  }
}

// ══════════════════════════════════════════════════════════════
// Protocol detection
// ══════════════════════════════════════════════════════════════

/**
 * Detect whether a 402 response uses s402 or x402 protocol.
 *
 * Check: decode the `payment-required` header and look for `s402Version`.
 * If present → s402. If absent → x402 (or raw 402).
 */
export function detectProtocol(headers: Headers): 's402' | 'x402' | 'unknown' {
  const paymentRequired = headers.get(S402_HEADERS.PAYMENT_REQUIRED);
  if (!paymentRequired) return 'unknown';

  try {
    const decoded = JSON.parse(fromBase64(paymentRequired));
    if (decoded.s402Version) return 's402';
    if (decoded.x402Version) return 'x402';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Extract payment requirements from a 402 Response.
 * Works with both s402 and x402 responses.
 */
export function extractRequirementsFromResponse(response: Response): s402PaymentRequirements | null {
  const header = response.headers.get(S402_HEADERS.PAYMENT_REQUIRED);
  if (!header) return null;

  try {
    return decodePaymentRequired(header);
  } catch {
    return null;
  }
}
