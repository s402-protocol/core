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
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
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

/** Known keys for each sub-object type — used to strip extra keys at the trust boundary. */
const S402_SUB_OBJECT_KEYS: Record<string, Set<string>> = {
  mandate: new Set(['required', 'minPerTx', 'coinType']),
  stream: new Set(['ratePerSecond', 'budgetCap', 'minDeposit', 'streamSetupUrl']),
  escrow: new Set(['seller', 'arbiter', 'deadlineMs']),
  unlock: new Set(['encryptionId', 'walrusBlobId', 'encryptionPackageId']),
  prepaid: new Set(['ratePerCall', 'maxCalls', 'minDeposit', 'withdrawalDelayMs']),
};

/** Strip unknown keys from a sub-object, returning a clean copy. */
function pickSubObjectFields(key: string, value: unknown): unknown {
  const allowedKeys = S402_SUB_OBJECT_KEYS[key];
  if (!allowedKeys || value == null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const k of allowedKeys) {
    if (k in obj) clean[k] = obj[k];
  }
  return clean;
}

/** Return a clean object with only known s402 requirement fields. */
export function pickRequirementsFields(obj: Record<string, unknown>): s402PaymentRequirements {
  const result: Record<string, unknown> = {};
  for (const key of S402_REQUIREMENTS_KEYS) {
    if (key in obj) {
      // Strip unknown keys from scheme-specific sub-objects (defense-in-depth)
      if (key in S402_SUB_OBJECT_KEYS) {
        result[key] = pickSubObjectFields(key, obj[key]);
      } else {
        result[key] = obj[key];
      }
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

/**
 * Known top-level keys on s402PaymentPayload.
 * Used by decodePaymentPayload to strip unknown keys at the HTTP trust boundary.
 */
const S402_PAYLOAD_TOP_KEYS = new Set(['s402Version', 'scheme', 'payload']);

/**
 * Known inner payload keys per scheme. All schemes share transaction + signature;
 * unlock adds encryptionId, prepaid adds ratePerCall + maxCalls.
 */
const S402_PAYLOAD_INNER_KEYS: Record<string, Set<string>> = {
  exact: new Set(['transaction', 'signature']),
  stream: new Set(['transaction', 'signature']),
  escrow: new Set(['transaction', 'signature']),
  unlock: new Set(['transaction', 'signature', 'encryptionId']),
  prepaid: new Set(['transaction', 'signature', 'ratePerCall', 'maxCalls']),
};

/** Return a clean payload object with only known s402 payload fields. */
export function pickPayloadFields(obj: Record<string, unknown>): s402PaymentPayload {
  const result: Record<string, unknown> = {};
  for (const key of S402_PAYLOAD_TOP_KEYS) {
    if (key in obj) result[key] = obj[key];
  }
  // Strip unknown inner payload fields based on scheme
  if (result.payload && typeof result.payload === 'object' && typeof result.scheme === 'string') {
    const allowedInner = S402_PAYLOAD_INNER_KEYS[result.scheme];
    if (allowedInner) {
      const inner = result.payload as Record<string, unknown>;
      const cleanInner: Record<string, unknown> = {};
      for (const key of allowedInner) {
        if (key in inner) cleanInner[key] = inner[key];
      }
      result.payload = cleanInner;
    }
  }
  return result as unknown as s402PaymentPayload;
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
  return pickPayloadFields(parsed as Record<string, unknown>);
}

/**
 * Known top-level keys on s402SettleResponse.
 * Used by decodeSettleResponse to strip unknown keys at the HTTP trust boundary.
 */
const S402_SETTLE_RESPONSE_KEYS = new Set([
  'success', 'txDigest', 'receiptId', 'finalityMs',
  'streamId', 'escrowId', 'balanceId', 'error', 'errorCode',
]);

/** Return a clean settle response with only known s402 fields. */
export function pickSettleResponseFields(obj: Record<string, unknown>): s402SettleResponse {
  const result: Record<string, unknown> = {};
  for (const key of S402_SETTLE_RESPONSE_KEYS) {
    if (key in obj) result[key] = obj[key];
  }
  return result as unknown as s402SettleResponse;
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
  return pickSettleResponseFields(parsed as Record<string, unknown>);
}

// ══════════════════════════════════════════════════════════════
// Shape validators (trust boundary — untrusted network input)
// ══════════════════════════════════════════════════════════════

/** Valid s402 payment scheme values */
const VALID_SCHEMES = new Set<string>(['exact', 'stream', 'escrow', 'unlock', 'prepaid']);

/**
 * Check that a string represents a canonical non-negative integer.
 * Rejects leading zeros ("007"), empty strings, negatives, decimals.
 * Accepts "0" as the only zero representation.
 *
 * NOTE: This is a **format-only** check — it validates the string is a well-formed
 * non-negative integer but does NOT enforce magnitude bounds. Arbitrarily large
 * integers (e.g. 100+ digits) pass this check. For Sui-specific u64 validation,
 * use `isValidU64Amount()` which also checks that the value fits in a u64.
 *
 * A-13 (Semantic gap): "0" passes validation because it's a valid u64 on-chain.
 * However, amount="0" in payment requirements is semantically ambiguous — it could
 * mean "free" or be a misconfiguration. The s402 wire format intentionally allows it
 * (some schemes like prepaid use amount="0" for deposit-based flows). Resource servers
 * that want to reject zero-amount payments should check this in their business logic,
 * not at the protocol level.
 */
export function isValidAmount(s: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(s);
}

/** Maximum value representable as a Sui u64: 2^64 - 1 */
const U64_MAX = '18446744073709551615';

/**
 * Check that a string represents a valid Sui u64 amount.
 * Like `isValidAmount` but also rejects values exceeding u64 max (2^64 - 1).
 *
 * Use this in scheme implementations that target Sui's u64 amounts (MIST, etc.).
 * The wire-format validator uses `isValidAmount` (format-only) to stay chain-agnostic.
 */
export function isValidU64Amount(s: string): boolean {
  if (!isValidAmount(s)) return false;
  if (s.length > U64_MAX.length) return false;
  if (s.length < U64_MAX.length) return true;
  return s <= U64_MAX; // lexicographic comparison works for same-length digit strings
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
  if (typeof obj.ratePerSecond === 'string' && !isValidAmount(obj.ratePerSecond)) {
    throw new s402Error('INVALID_PAYLOAD',
      `stream.ratePerSecond must be a non-negative integer string, got "${obj.ratePerSecond}"`);
  }
  assertString(obj, 'budgetCap', 'stream');
  if (typeof obj.budgetCap === 'string' && !isValidAmount(obj.budgetCap)) {
    throw new s402Error('INVALID_PAYLOAD',
      `stream.budgetCap must be a non-negative integer string, got "${obj.budgetCap}"`);
  }
  assertString(obj, 'minDeposit', 'stream');
  if (typeof obj.minDeposit === 'string' && !isValidAmount(obj.minDeposit)) {
    throw new s402Error('INVALID_PAYLOAD',
      `stream.minDeposit must be a non-negative integer string, got "${obj.minDeposit}"`);
  }
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
  // A-09: Validate deadlineMs is a non-negative integer string (same as amount format).
  // A bare "must be a string" error for a deadline field is confusing — make it specific.
  if (typeof obj.deadlineMs === 'string' && !isValidAmount(obj.deadlineMs)) {
    throw new s402Error('INVALID_PAYLOAD',
      `escrow.deadlineMs must be a non-negative integer string (Unix timestamp ms), got "${obj.deadlineMs}"`);
  }
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
  if (typeof obj.ratePerCall === 'string' && !isValidAmount(obj.ratePerCall)) {
    throw new s402Error('INVALID_PAYLOAD',
      `prepaid.ratePerCall must be a non-negative integer string, got "${obj.ratePerCall}"`);
  }
  assertString(obj, 'minDeposit', 'prepaid');
  if (typeof obj.minDeposit === 'string' && !isValidAmount(obj.minDeposit)) {
    throw new s402Error('INVALID_PAYLOAD',
      `prepaid.minDeposit must be a non-negative integer string, got "${obj.minDeposit}"`);
  }
  assertString(obj, 'withdrawalDelayMs', 'prepaid');
  if (typeof obj.withdrawalDelayMs === 'string' && !isValidAmount(obj.withdrawalDelayMs)) {
    throw new s402Error('INVALID_PAYLOAD',
      `prepaid.withdrawalDelayMs must be a non-negative integer string (milliseconds), got "${obj.withdrawalDelayMs}"`);
  }
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
  } else if (!isValidU64Amount(record.amount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Invalid amount "${record.amount}": must be a non-negative integer string within u64 range`);
  }
  if (typeof record.payTo !== 'string') {
    missing.push('payTo (string)');
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(record.payTo as string)) {
    // M-6: Enforce Sui address format — 0x + exactly 64 hex chars (32 bytes).
    // Rejects "0x" alone, non-hex chars, and wrong-length addresses.
    throw new s402Error('INVALID_PAYLOAD',
      `payTo must be a 32-byte Sui address (0x + 64 hex chars), got "${(record.payTo as string).substring(0, 20)}..."`);
  }
  if (missing.length > 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed payment requirements: missing ${missing.join(', ')}`);
  }

  // Reject control characters in protocol-semantic identifier fields.
  // These feed into Map keys, error messages, and downstream logs — null bytes
  // and CRLF are never legitimate in network/asset identifiers.
  if (/[\x00-\x1f\x7f]/.test(record.network as string)) {
    throw new s402Error('INVALID_PAYLOAD',
      'network contains control characters');
  }
  if (/[\x00-\x1f\x7f]/.test(record.asset as string)) {
    throw new s402Error('INVALID_PAYLOAD',
      'asset contains control characters');
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
    if (typeof record.protocolFeeBps !== 'number' || !Number.isFinite(record.protocolFeeBps) || !Number.isInteger(record.protocolFeeBps) || record.protocolFeeBps < 0 || record.protocolFeeBps > 10000) {
      throw new s402Error('INVALID_PAYLOAD',
        `protocolFeeBps must be an integer between 0 and 10000, got ${record.protocolFeeBps}`);
    }
  }
  if (record.expiresAt !== undefined) {
    if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt) || record.expiresAt <= 0) {
      throw new s402Error('INVALID_PAYLOAD',
        `expiresAt must be a positive finite number (Unix timestamp ms), got ${record.expiresAt}`);
    }
  }
  if (record.protocolFeeAddress !== undefined) {
    if (typeof record.protocolFeeAddress !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(record.protocolFeeAddress)) {
      throw new s402Error('INVALID_PAYLOAD',
        `protocolFeeAddress must be a 32-byte Sui address (0x + 64 hex chars), got "${String(record.protocolFeeAddress).substring(0, 20)}..."`);
    }
  }
  if (record.facilitatorUrl !== undefined) {
    if (typeof record.facilitatorUrl !== 'string') {
      throw new s402Error('INVALID_PAYLOAD',
        `facilitatorUrl must be a string, got ${typeof record.facilitatorUrl}`);
    }
    // Reject control characters (CRLF injection, null bytes) — defense-in-depth
    if (/[\x00-\x1f\x7f]/.test(record.facilitatorUrl)) {
      throw new s402Error('INVALID_PAYLOAD',
        'facilitatorUrl contains control characters (potential header injection)');
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

  // D-08: Reject oversized headers before parsing (defense-in-depth)
  if (paymentRequired.length > MAX_HEADER_BYTES) return 'unknown';

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
