/**
 * s402 HTTP Helpers — encode/decode for HTTP headers
 *
 * Wire-compatible with x402: same header names, same base64 encoding.
 * The presence of `s402Version` in the decoded JSON distinguishes s402 from x402.
 *
 * Uses Unicode-safe base64 (UTF-8 → base64) so the `extensions` field and error
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

/** Encode payment payload for the `x-payment` header */
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

/**
 * Maximum base64 header size (64KB). Defense-in-depth against oversized payloads.
 * Most HTTP servers enforce smaller limits (Node: 16KB, CF Workers: 128KB),
 * but a wire format library should not rely on runtime enforcement.
 */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Known top-level keys on s402PaymentRequirements.
 * Single source of truth — compat.ts imports pickRequirementsFields from here.
 * Used by decodePaymentRequired to strip unknown keys at the HTTP trust boundary.
 */
const S402_REQUIREMENTS_KEYS = new Set([
  's402Version', 'accepts', 'network', 'asset', 'amount', 'payTo',
  'facilitatorUrl', 'mandate', 'protocolFeeBps', 'protocolFeeAddress',
  'receiptRequired', 'settlementMode', 'expiresAt',
  'stream', 'escrow', 'unlock', 'prepaid', 'extensions',
]);

/** Return a clean object with only known s402 requirement fields. */
export function pickRequirementsFields(obj: Record<string, unknown>): s402PaymentRequirements {
  const result: Record<string, unknown> = {};
  for (const key of S402_REQUIREMENTS_KEYS) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result as unknown as s402PaymentRequirements;
}

/** Decode payment requirements from the `payment-required` header */
export function decodePaymentRequired(header: string): s402PaymentRequirements {
  if (header.length > MAX_HEADER_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `payment-required header exceeds maximum size (${header.length} > ${MAX_HEADER_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(header));
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to decode payment-required header: ${e instanceof Error ? e.message : 'invalid base64 or JSON'}`);
  }
  validateRequirementsShape(parsed);
  return pickRequirementsFields(parsed as Record<string, unknown>);
}

/** Decode payment payload from the `x-payment` header */
export function decodePaymentPayload(header: string): s402PaymentPayload {
  if (header.length > MAX_HEADER_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `x-payment header exceeds maximum size (${header.length} > ${MAX_HEADER_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(header));
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to decode x-payment header: ${e instanceof Error ? e.message : 'invalid base64 or JSON'}`);
  }
  validatePayloadShape(parsed);
  return parsed as s402PaymentPayload;
}

/** Decode settlement response from the `payment-response` header */
export function decodeSettleResponse(header: string): s402SettleResponse {
  if (header.length > MAX_HEADER_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `payment-response header exceeds maximum size (${header.length} > ${MAX_HEADER_BYTES})`);
  }
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
const VALID_SCHEMES = new Set<string>(['exact', 'stream', 'escrow', 'unlock', 'prepaid']);

/**
 * Check that a string represents a canonical non-negative integer (valid for Sui MIST amounts).
 * Rejects leading zeros ("007"), empty strings, negatives, decimals.
 * Accepts "0" as the only zero representation.
 */
export function isValidAmount(s: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(s);
}

// ══════════════════════════════════════════════════════════════
// Sub-object validators (shared between http.ts and compat.ts)
// ══════════════════════════════════════════════════════════════

/** Helper: assert obj is a plain object (not null/array/primitive). */
function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new s402Error('INVALID_PAYLOAD',
      `${label} must be a plain object, got ${Array.isArray(value) ? 'array' : typeof value}`);
  }
}

/** Helper: assert field is a string. */
function assertString(obj: Record<string, unknown>, field: string, label: string): void {
  if (typeof obj[field] !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `${label}.${field} must be a string, got ${typeof obj[field]}`);
  }
}

/** Helper: assert optional field is a string if present. */
function assertOptionalString(obj: Record<string, unknown>, field: string, label: string): void {
  if (obj[field] !== undefined && typeof obj[field] !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `${label}.${field} must be a string if provided, got ${typeof obj[field]}`);
  }
}

/**
 * Validate mandate requirements sub-object.
 * Mandate is protocol-level (used for authorization decisions), so we validate fully.
 */
export function validateMandateShape(value: unknown): void {
  assertPlainObject(value, 'mandate');
  const obj = value as Record<string, unknown>;
  if (typeof obj.required !== 'boolean') {
    throw new s402Error('INVALID_PAYLOAD',
      `mandate.required must be a boolean, got ${typeof obj.required}`);
  }
  assertOptionalString(obj, 'minPerTx', 'mandate');
  assertOptionalString(obj, 'coinType', 'mandate');
}

/**
 * Validate stream sub-object.
 * Checks required fields are present and correctly typed.
 */
export function validateStreamShape(value: unknown): void {
  assertPlainObject(value, 'stream');
  const obj = value as Record<string, unknown>;
  assertString(obj, 'ratePerSecond', 'stream');
  assertString(obj, 'budgetCap', 'stream');
  assertString(obj, 'minDeposit', 'stream');
  assertOptionalString(obj, 'streamSetupUrl', 'stream');
}

/**
 * Validate escrow sub-object.
 */
export function validateEscrowShape(value: unknown): void {
  assertPlainObject(value, 'escrow');
  const obj = value as Record<string, unknown>;
  assertString(obj, 'seller', 'escrow');
  assertString(obj, 'deadlineMs', 'escrow');
  assertOptionalString(obj, 'arbiter', 'escrow');
}

/**
 * Validate unlock sub-object (pay-to-decrypt encrypted content).
 */
export function validateUnlockShape(value: unknown): void {
  assertPlainObject(value, 'unlock');
  const obj = value as Record<string, unknown>;
  assertString(obj, 'encryptionId', 'unlock');
  assertString(obj, 'walrusBlobId', 'unlock');
  assertString(obj, 'encryptionPackageId', 'unlock');
}

/**
 * Validate prepaid sub-object.
 */
export function validatePrepaidShape(value: unknown): void {
  assertPlainObject(value, 'prepaid');
  const obj = value as Record<string, unknown>;
  assertString(obj, 'ratePerCall', 'prepaid');
  assertString(obj, 'minDeposit', 'prepaid');
  assertString(obj, 'withdrawalDelayMs', 'prepaid');
  assertOptionalString(obj, 'maxCalls', 'prepaid');
}

/**
 * Validate all optional sub-objects on a requirements record.
 * Called from validateRequirementsShape during wire decode and compat normalization.
 */
export function validateSubObjects(record: Record<string, unknown>): void {
  if (record.mandate !== undefined) validateMandateShape(record.mandate);
  if (record.stream !== undefined) validateStreamShape(record.stream);
  if (record.escrow !== undefined) validateEscrowShape(record.escrow);
  if (record.unlock !== undefined) validateUnlockShape(record.unlock);
  if (record.prepaid !== undefined) validatePrepaidShape(record.prepaid);
}

/** Validate that decoded payment requirements have the required shape. */
export function validateRequirementsShape(obj: unknown): void {
  if (obj == null || typeof obj !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'Payment requirements is not an object');
  }
  const record = obj as Record<string, unknown>;

  // Version gate — s402Version is required for s402 wire format.
  // (x402 format should go through normalizeRequirements in compat.ts instead.)
  if (record.s402Version === undefined) {
    throw new s402Error('INVALID_PAYLOAD',
      'Missing s402Version. For x402 format, use normalizeRequirements() from s402/compat.');
  }
  if (record.s402Version !== '1') {
    throw new s402Error('INVALID_PAYLOAD',
      `Unsupported s402 version "${record.s402Version}". This library supports version "1".`);
  }

  const missing: string[] = [];
  if (!Array.isArray(record.accepts)) missing.push('accepts (array)');
  if (typeof record.network !== 'string') missing.push('network (string)');
  if (typeof record.asset !== 'string') missing.push('asset (string)');
  if (typeof record.amount !== 'string') {
    missing.push('amount (string)');
  } else if (!isValidAmount(record.amount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Invalid amount "${record.amount}": must be a non-negative integer string`);
  }
  if (typeof record.payTo !== 'string') missing.push('payTo (string)');
  if (missing.length > 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed payment requirements: missing ${missing.join(', ')}`);
  }

  // Empty accepts is semantically invalid — client cannot match any scheme
  if (Array.isArray(record.accepts) && (record.accepts as unknown[]).length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'accepts array must contain at least one scheme');
  }

  // Structural check: accepts entries must be strings.
  // We do NOT reject unknown scheme names here — the accepts array is a
  // capability advertisement, and newer servers may include schemes this
  // library doesn't know about yet. Clients should ignore unsupported
  // schemes and pick one they can handle (Postel's Law).
  const accepts = record.accepts as unknown[];
  for (const scheme of accepts) {
    if (typeof scheme !== 'string') {
      throw new s402Error('INVALID_PAYLOAD',
        `Invalid entry in accepts array: expected string, got ${typeof scheme}`);
    }
  }

  // Optional field validation
  if (record.protocolFeeBps !== undefined) {
    if (typeof record.protocolFeeBps !== 'number' || !Number.isFinite(record.protocolFeeBps) || record.protocolFeeBps < 0 || record.protocolFeeBps > 10000) {
      throw new s402Error('INVALID_PAYLOAD',
        `protocolFeeBps must be a finite number between 0 and 10000, got ${record.protocolFeeBps}`);
    }
  }
  if (record.expiresAt !== undefined) {
    if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) {
      throw new s402Error('INVALID_PAYLOAD',
        `expiresAt must be a finite number (Unix timestamp ms), got ${typeof record.expiresAt}`);
    }
  }

  // Sub-object structural validation
  validateSubObjects(record);
}

/** Validate that a decoded payment payload has the required shape. */
function validatePayloadShape(obj: unknown): void {
  if (obj == null || typeof obj !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'Payment payload is not an object');
  }
  const record = obj as Record<string, unknown>;

  // Version gate — reject payloads claiming an unsupported protocol version.
  // Note: s402Version is NOT required on payloads (x402 payloads omit it).
  if (record.s402Version !== undefined && record.s402Version !== '1') {
    throw new s402Error('INVALID_PAYLOAD',
      `Unsupported s402 version "${record.s402Version}" in payment payload. This library supports version "1".`);
  }

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

  // Inner payload field validation — all schemes require transaction + signature as strings.
  const inner = record.payload as Record<string, unknown>;
  if (typeof inner.transaction !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `payload.transaction must be a string, got ${typeof inner.transaction}`);
  }
  if (typeof inner.signature !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `payload.signature must be a string, got ${typeof inner.signature}`);
  }

  // Scheme-specific inner fields
  if (record.scheme === 'unlock' && typeof inner.encryptionId !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `unlock payload requires encryptionId (string), got ${typeof inner.encryptionId}`);
  }
  if (record.scheme === 'prepaid' && typeof inner.ratePerCall !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `prepaid payload requires ratePerCall (string), got ${typeof inner.ratePerCall}`);
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
    if (decoded != null && typeof decoded === 'object' && 's402Version' in decoded) return 's402';
    if (decoded != null && typeof decoded === 'object' && 'x402Version' in decoded) return 'x402';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Extract s402 payment requirements from a 402 Response.
 * Returns null if the header is missing, malformed, or not s402 format.
 * For x402 responses, decode the header manually and use normalizeRequirements().
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
