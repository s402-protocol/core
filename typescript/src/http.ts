/**
 * s402 HTTP Helpers — encode/decode for HTTP headers
 *
 * The `payment-required` document is an x402 V2 `PaymentRequired` envelope on
 * every route — same header name, same base64, same JSON an unmodified x402 V2
 * decoder reads (ADR-016). s402's own requirement fields ride inside each
 * `accepts[]` entry's `extra`; s402's envelope-level fields ride in
 * `extensions.s402`, and the PRESENCE of that key is what marks a 402 as an
 * s402-profile 402 rather than a plain x402 one.
 *
 * Uses Unicode-safe base64 (UTF-8 → base64) so the `extensions` field and error
 * messages can contain any characters. For ASCII-only content (the common case),
 * the output is identical to plain btoa/atob.
 */

import type {
  s402PaymentRequired,
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
  s402ResourceInfo,
} from './types.js';
import {
  S402_HEADERS,
  S402_WIRE_VERSION,
  S402_DEFAULT_MAX_TIMEOUT_SECONDS,
} from './types.js';
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

/**
 * Encode a 402 document for the `payment-required` header.
 *
 * Emits the x402 V2 `PaymentRequired` envelope. s402's per-requirement fields
 * are projected into each entry's `extra`; `mandate` and the wire version are
 * projected into `extensions.s402`.
 *
 * @param required - The 402 envelope: resource + one entry per offered scheme
 * @returns Base64-encoded JSON string for the HTTP header
 *
 * @example
 * ```ts
 * import { encodePaymentRequired } from 's402/http';
 *
 * const header = encodePaymentRequired({
 *   x402Version: 2,
 *   resource: { url: 'https://api.example.com/paid' },
 *   accepts: [{
 *     scheme: 'exact',
 *     network: 'sui:mainnet',
 *     asset: '0x2::sui::SUI',
 *     amount: '1000000',
 *     payTo: 'YOUR_ADDRESS',
 *   }],
 * });
 * response.headers.set('payment-required', header);
 * ```
 */
export function encodePaymentRequired(required: s402PaymentRequired): string {
  return toBase64(JSON.stringify(toRequirementsWire(required)));
}

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

/** x402 V2 `ResourceInfo` keys, per upstream `types/payments.ts` at the pin. */
const S402_RESOURCE_KEYS = ['url', 'description', 'mimeType', 'serviceName', 'tags', 'iconUrl'] as const;

/** x402 V2 `PaymentRequirements` keys — the shape of one `accepts[]` entry on the wire. */
const X402_REQUIREMENT_KEYS = ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra'] as const;

/**
 * s402's per-requirement fields, in the order the encoder writes them into an
 * entry's `extra`.
 *
 * x402 owns the six keys above; everything s402 adds to a single offer lives
 * here instead of at the top level, because the top level is x402's and a key
 * it does not know is a key its decoder may reject tomorrow. `extra` is the
 * slot x402's own family spec (#3145) names for method-specific fields.
 *
 * ⚠️ Order is load-bearing: the encoder writes passthrough keys first and then
 * these, so decode → re-encode is byte-identical.
 */
const S402_EXTRA_KEYS = [
  'facilitatorUrl', 'protocolFeeBps', 'protocolFeeAddress', 'receiptRequired',
  'settlementMode', 'expiresAt',
  'upto', 'settlementOverrides', 'prepaid', 'stream', 'escrow', 'unlock',
  'extensions',
] as const;

/** The `extensions` key s402's envelope-level fields live under. */
const S402_EXTENSION_KEY = 's402' as const;

/** Known keys for each sub-object type — used to strip extra keys at the trust boundary. */
const S402_SUB_OBJECT_KEYS: Record<string, Set<string>> = {
  mandate: new Set(['required', 'minPerTx', 'coinType']),
  upto: new Set(['maxAmount', 'settlementDeadlineMs', 'usageReportUrl', 'estimatedAmount']),
  settlementOverrides: new Set(['actualAmount']),
  prepaid: new Set(['ratePerCall', 'maxCalls', 'minDeposit', 'withdrawalDelayMs', 'providerPubkey', 'disputeWindowMs']),
  stream: new Set(['ratePerSecond', 'budgetCap', 'minDeposit', 'streamSetupUrl']),
  escrow: new Set(['seller', 'arbiter', 'deadlineMs']),
  unlock: new Set(['packageId', 'keyServers', 'threshold', 'contentDigest']),
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

/** True for a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// ══════════════════════════════════════════════════════════════
// Wire projection — s402 fields ↔ x402's `extra` / `extensions`
// ══════════════════════════════════════════════════════════════

/** Project one s402 requirement into an x402 V2 `PaymentRequirements`. */
function toWireRequirement(req: s402PaymentRequirements): Record<string, unknown> {
  // Passthrough first, named s402 keys after: a key s402 names always wins over
  // a same-named key that arrived in `extra` from somewhere else.
  const extra: Record<string, unknown> = { ...(req.extra ?? {}) };
  for (const key of S402_EXTRA_KEYS) {
    const value = (req as unknown as Record<string, unknown>)[key];
    if (value !== undefined) extra[key] = value;
  }
  return {
    scheme: req.scheme,
    network: req.network,
    asset: req.asset,
    amount: req.amount,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds ?? S402_DEFAULT_MAX_TIMEOUT_SECONDS,
    extra,
  };
}

/**
 * Project a 402 document into the x402 V2 `PaymentRequired` envelope it is.
 *
 * Exported so non-HTTP carriers (the MCP `_meta` and A2A `metadata` codecs in
 * `transport.ts`) put the SAME document on their wire that the header carries —
 * one projection, not three.
 */
export function toRequirementsWire(required: s402PaymentRequired): Record<string, unknown> {
  const resource: Record<string, unknown> = {};
  for (const key of S402_RESOURCE_KEYS) {
    const value = (required.resource ?? {} as s402ResourceInfo)[key];
    if (value !== undefined) resource[key] = value;
  }

  const rest: Record<string, unknown> = { ...(required.extensions ?? {}) };
  const carried = isPlainObject(rest[S402_EXTENSION_KEY]) ? rest[S402_EXTENSION_KEY] as Record<string, unknown> : {};
  delete rest[S402_EXTENSION_KEY];
  const s402Ext: Record<string, unknown> = { version: S402_WIRE_VERSION };
  if (required.mandate !== undefined) s402Ext.mandate = required.mandate;
  for (const [k, v] of Object.entries(carried)) {
    if (k !== 'version' && k !== 'mandate') s402Ext[k] = v;
  }

  const out: Record<string, unknown> = { x402Version: 2 };
  if (required.error !== undefined) out.error = required.error;
  out.resource = resource;
  out.accepts = (required.accepts ?? []).map(toWireRequirement);
  out.extensions = { ...rest, [S402_EXTENSION_KEY]: s402Ext };
  return out;
}

/**
 * Lift one wire `accepts[]` entry back to the flat s402 requirement.
 *
 * Unrecognized `extra` keys are KEPT (in `extra`), not stripped. x402's `extra`
 * is an open bag by spec — `paymentFlow` and the EIP-712 `name` / `version`
 * live there — and a whitelist at this boundary is exactly where the next
 * upstream field would go missing without erroring (LESSONS, 2026-08-31).
 */
function fromWireRequirement(raw: Record<string, unknown>): s402PaymentRequirements {
  const out: Record<string, unknown> = {};
  for (const key of X402_REQUIREMENT_KEYS) {
    if (key !== 'extra' && key in raw) out[key] = raw[key];
  }
  const extra: Record<string, unknown> = isPlainObject(raw.extra) ? { ...raw.extra } : {};
  for (const key of S402_EXTRA_KEYS) {
    if (!(key in extra)) continue;
    out[key] = key in S402_SUB_OBJECT_KEYS ? pickSubObjectFields(key, extra[key]) : extra[key];
    delete extra[key];
  }
  if (Object.keys(extra).length > 0) out.extra = extra;
  return out as unknown as s402PaymentRequirements;
}

/**
 * Return a clean 402 document with only known fields — the wire envelope lifted
 * into s402's shape, with unknown envelope/entry/resource keys stripped.
 *
 * Kept under its historical name because it is the same trust boundary it
 * always was; what changed is the document it guards.
 */
export function pickRequirementsFields(obj: Record<string, unknown>): s402PaymentRequired {
  const out: Record<string, unknown> = { x402Version: 2 };
  if (obj.error !== undefined) out.error = obj.error;

  const resource: Record<string, unknown> = {};
  const rawResource = isPlainObject(obj.resource) ? obj.resource : {};
  for (const key of S402_RESOURCE_KEYS) {
    if (key in rawResource) resource[key] = rawResource[key];
  }
  out.resource = resource;

  const accepts = Array.isArray(obj.accepts) ? obj.accepts : [];
  out.accepts = accepts.map((entry) => fromWireRequirement(isPlainObject(entry) ? entry : {}));

  const extensions: Record<string, unknown> = isPlainObject(obj.extensions) ? { ...obj.extensions } : {};
  const s402Ext = isPlainObject(extensions[S402_EXTENSION_KEY])
    ? { ...(extensions[S402_EXTENSION_KEY] as Record<string, unknown>) }
    : undefined;
  if (s402Ext) {
    delete extensions[S402_EXTENSION_KEY];
    if (s402Ext.mandate !== undefined) out.mandate = pickSubObjectFields('mandate', s402Ext.mandate);
    delete s402Ext.version;
    delete s402Ext.mandate;
    if (Object.keys(s402Ext).length > 0) extensions[S402_EXTENSION_KEY] = s402Ext;
  }
  if (Object.keys(extensions).length > 0) out.extensions = extensions;

  return out as unknown as s402PaymentRequired;
}

/**
 * Decode the 402 document from the `payment-required` header.
 * Validates shape, strips unknown keys, enforces size limit (64KB).
 *
 * Works on a PLAIN x402 V2 402 as well as an s402-profile one: the only
 * difference between them is the presence of `extensions.s402`, and its absence
 * is not an error. What comes back is payable either way.
 *
 * @param header - Base64-encoded JSON string from the HTTP header
 * @returns Validated s402 402 document
 * @throws {s402Error} `INVALID_PAYLOAD` on oversized header, invalid base64/JSON, or malformed shape
 *
 * @example
 * ```ts
 * import { decodePaymentRequired } from 's402/http';
 *
 * const required = decodePaymentRequired(response.headers.get('payment-required')!);
 * console.log(required.accepts.map((a) => a.scheme)); // ['exact', 'prepaid']
 * console.log(required.accepts[0].amount);            // '1000000'
 * ```
 */
export function decodePaymentRequired(header: string): s402PaymentRequired {
  if (typeof header !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `payment-required header must be a string, got ${typeof header}`);
  }
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
 * upto adds maxAmount + settlementCeiling, prepaid adds ratePerCall + maxCalls,
 * unlock adds encryptionId.
 */
const S402_PAYLOAD_INNER_KEYS: Record<string, Set<string>> = {
  exact: new Set(['transaction', 'signature']),
  upto: new Set(['transaction', 'signature', 'maxAmount', 'settlementCeiling']),
  prepaid: new Set(['transaction', 'signature', 'ratePerCall', 'maxCalls']),
  stream: new Set(['transaction', 'signature']),
  escrow: new Set(['transaction', 'signature']),
  unlock: new Set(['transaction', 'signature']),
};

/** Return a clean payload object with only known s402 payload fields. */
export function pickPayloadFields(obj: Record<string, unknown>): s402PaymentPayload {
  const result: Record<string, unknown> = {};
  for (const key of S402_PAYLOAD_TOP_KEYS) {
    if (key in obj) result[key] = obj[key];
  }
  // Strip unknown inner payload fields based on scheme
  if (result.payload && typeof result.payload === 'object' && typeof result.scheme === 'string') {
    // hasOwnProperty guard: `result.scheme` is untrusted. A bare index would
    // walk the prototype chain (scheme='constructor' → the Object constructor,
    // truthy, then `for...of` on it throws a raw TypeError). Internal callers
    // run validatePayloadShape first, but this helper is exported via s402/http.
    const allowedInner = Object.prototype.hasOwnProperty.call(S402_PAYLOAD_INNER_KEYS, result.scheme)
      ? S402_PAYLOAD_INNER_KEYS[result.scheme]
      : undefined;
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

/**
 * Decode payment payload from the `x-payment` header.
 * Validates shape, strips unknown keys, enforces size limit (64KB).
 *
 * @param header - Base64-encoded JSON string from the HTTP header
 * @returns Validated s402 payment payload
 * @throws {s402Error} `INVALID_PAYLOAD` on oversized header, invalid base64/JSON, or malformed shape
 *
 * @example
 * ```ts
 * import { decodePaymentPayload, S402_HEADERS } from 's402/http';
 *
 * const header = request.headers.get(S402_HEADERS.PAYMENT)!;
 * const payload = decodePaymentPayload(header);
 * console.log(payload.scheme); // 'exact'
 * ```
 */
export function decodePaymentPayload(header: string): s402PaymentPayload {
  if (typeof header !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `x-payment header must be a string, got ${typeof header}`);
  }
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
  'actualAmount', 'depositId', 'balanceId', 'streamId', 'escrowId',
  'error', 'errorCode',
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
  if (typeof header !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `payment-response header must be a string, got ${typeof header}`);
  }
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
const VALID_SCHEMES = new Set<string>(['exact', 'upto', 'prepaid', 'stream', 'escrow', 'unlock']);

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
  if (typeof obj.minPerTx === 'string' && !isValidAmount(obj.minPerTx)) {
    throw new s402Error('INVALID_PAYLOAD',
      `mandate.minPerTx must be a non-negative integer string, got "${obj.minPerTx}"`);
  }
  assertOptionalString(obj, 'coinType', 'mandate');
}

/**
 * Validate upto sub-object (usage-based variable settlement).
 */
export function validateUptoShape(value: unknown): void {
  assertPlainObject(value, 'upto');
  const obj = value as Record<string, unknown>;
  assertString(obj, 'maxAmount', 'upto');
  if (typeof obj.maxAmount === 'string' && !isValidAmount(obj.maxAmount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `upto.maxAmount must be a non-negative integer string, got "${obj.maxAmount}"`);
  }
  assertString(obj, 'settlementDeadlineMs', 'upto');
  if (typeof obj.settlementDeadlineMs === 'string' && !isValidAmount(obj.settlementDeadlineMs)) {
    throw new s402Error('INVALID_PAYLOAD',
      `upto.settlementDeadlineMs must be a non-negative integer string (Unix timestamp ms), got "${obj.settlementDeadlineMs}"`);
  }
  assertOptionalString(obj, 'usageReportUrl', 'upto');
  assertOptionalString(obj, 'estimatedAmount', 'upto');
  if (typeof obj.estimatedAmount === 'string') {
    if (!isValidAmount(obj.estimatedAmount)) {
      throw new s402Error('INVALID_PAYLOAD',
        `upto.estimatedAmount must be a non-negative integer string, got "${obj.estimatedAmount}"`);
    }
    // estimatedAmount must be <= maxAmount (server can't estimate more than the ceiling)
    if (typeof obj.maxAmount === 'string' && isValidAmount(obj.maxAmount)) {
      const est = BigInt(obj.estimatedAmount);
      const max = BigInt(obj.maxAmount);
      if (est > max) {
        throw new s402Error('INVALID_PAYLOAD',
          `upto.estimatedAmount (${obj.estimatedAmount}) must be <= maxAmount (${obj.maxAmount})`);
      }
    }
  }
}

/**
 * Validate settlementOverrides sub-object.
 */
export function validateSettlementOverridesShape(value: unknown): void {
  assertPlainObject(value, 'settlementOverrides');
  const obj = value as Record<string, unknown>;
  assertString(obj, 'actualAmount', 'settlementOverrides');
  if (typeof obj.actualAmount === 'string' && !isValidAmount(obj.actualAmount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `settlementOverrides.actualAmount must be a non-negative integer string, got "${obj.actualAmount}"`);
  }
}

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
 * Validate unlock sub-object (pay-to-decrypt, single-transaction).
 */
export function validateUnlockShape(value: unknown): void {
  assertPlainObject(value, 'unlock');
  const obj = value as Record<string, unknown>;
  assertString(obj, 'packageId', 'unlock');
  assertOptionalString(obj, 'contentDigest', 'unlock');
  if (typeof obj.threshold !== 'number' || !Number.isInteger(obj.threshold) || obj.threshold < 1) {
    throw new s402Error('INVALID_PAYLOAD',
      `unlock.threshold must be a positive integer, got ${typeof obj.threshold}`);
  }
  if (!Array.isArray(obj.keyServers) || obj.keyServers.length === 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `unlock.keyServers must be a non-empty array, got ${typeof obj.keyServers}`);
  }
  for (const ks of obj.keyServers) {
    assertPlainObject(ks, 'unlock.keyServers[]');
    assertString(ks as Record<string, unknown>, 'objectId', 'unlock.keyServers[]');
    if (typeof (ks as Record<string, unknown>).weight !== 'number') {
      throw new s402Error('INVALID_PAYLOAD',
        `unlock.keyServers[].weight must be a number, got ${typeof (ks as Record<string, unknown>).weight}`);
    }
  }
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
  if (typeof obj.withdrawalDelayMs === 'string') {
    if (!isValidAmount(obj.withdrawalDelayMs)) {
      throw new s402Error('INVALID_PAYLOAD',
        `prepaid.withdrawalDelayMs must be a non-negative integer string (milliseconds), got "${obj.withdrawalDelayMs}"`);
    }
    const delayMs = BigInt(obj.withdrawalDelayMs);
    if (delayMs < 60_000n || delayMs > 604_800_000n) {
      throw new s402Error('INVALID_PAYLOAD',
        `prepaid.withdrawalDelayMs must be between 60000 (1 min) and 604800000 (7 days), got "${obj.withdrawalDelayMs}"`);
    }
  }
  assertOptionalString(obj, 'maxCalls', 'prepaid');
  assertOptionalString(obj, 'providerPubkey', 'prepaid');
  assertOptionalString(obj, 'disputeWindowMs', 'prepaid');
  // Pairing invariant: providerPubkey and disputeWindowMs must both be present or both absent.
  const hasPubkey = typeof obj.providerPubkey === 'string';
  const hasWindow = typeof obj.disputeWindowMs === 'string';
  if (hasPubkey !== hasWindow) {
    throw new s402Error('INVALID_PAYLOAD',
      `prepaid: providerPubkey and disputeWindowMs must both be present (v0.2) or both absent (v0.1), got ${hasPubkey ? 'providerPubkey only' : 'disputeWindowMs only'}`);
  }
}

/**
 * Validate all optional sub-objects on a requirements record.
 * Called from validateRequirementsShape during wire decode and compat normalization.
 *
 * The record here is one `accepts[]` entry's `extra`, where the sub-objects
 * live on the wire — not the entry itself.
 */
export function validateSubObjects(record: Record<string, unknown>): void {
  // ⚠️ `mandate` is deliberately NOT in this list. It is envelope-level since
  // wire v2 and is validated at `extensions.s402.mandate`. A `mandate` key
  // inside an entry's `extra` belongs to whoever put it there — s402 does not
  // own that address — and validating it would let an unrelated foreign key
  // take down an otherwise payable 402, against the open-bag rule this file
  // argues for two comments above.
  if (record.upto !== undefined) validateUptoShape(record.upto);
  if (record.settlementOverrides !== undefined) validateSettlementOverridesShape(record.settlementOverrides);
  if (record.prepaid !== undefined) validatePrepaidShape(record.prepaid);
  if (record.stream !== undefined) validateStreamShape(record.stream);
  if (record.escrow !== undefined) validateEscrowShape(record.escrow);
  if (record.unlock !== undefined) validateUnlockShape(record.unlock);
}

/**
 * Validate the s402 fields carried inside one `accepts[]` entry's `extra`.
 *
 * Every check here was a top-level check before wire v2. It moved one level
 * down with the fields it guards; none of it was relaxed.
 */
function validateExtraFields(extra: Record<string, unknown>, where: string): void {
  if (extra.protocolFeeBps !== undefined) {
    if (typeof extra.protocolFeeBps !== 'number' || !Number.isFinite(extra.protocolFeeBps) || !Number.isInteger(extra.protocolFeeBps) || extra.protocolFeeBps < 0 || extra.protocolFeeBps > 10000) {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: protocolFeeBps must be an integer between 0 and 10000, got ${extra.protocolFeeBps}`);
    }
  }
  if (extra.expiresAt !== undefined) {
    if (typeof extra.expiresAt !== 'number' || !Number.isFinite(extra.expiresAt) || extra.expiresAt <= 0) {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: expiresAt must be a positive finite number (Unix timestamp ms), got ${extra.expiresAt}`);
    }
  }
  if (extra.protocolFeeAddress !== undefined) {
    if (typeof extra.protocolFeeAddress !== 'string' || extra.protocolFeeAddress.length === 0) {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: protocolFeeAddress must be a non-empty string, got ${JSON.stringify(extra.protocolFeeAddress)}`);
    }
    if (/[\x00-\x1f\x7f]/.test(extra.protocolFeeAddress)) {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: protocolFeeAddress contains control characters`);
    }
  }
  if (extra.facilitatorUrl !== undefined) {
    if (typeof extra.facilitatorUrl !== 'string') {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: facilitatorUrl must be a string, got ${typeof extra.facilitatorUrl}`);
    }
    // Reject control characters (CRLF injection, null bytes) — defense-in-depth
    if (/[\x00-\x1f\x7f]/.test(extra.facilitatorUrl)) {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: facilitatorUrl contains control characters (potential header injection)`);
    }
    // M-1: Validate URL scheme to prevent SSRF via dangerous protocols (file://, gopher://, etc.)
    try {
      const url = new URL(extra.facilitatorUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new s402Error('INVALID_PAYLOAD',
          `${where}: facilitatorUrl must use https:// or http://, got "${url.protocol}"`);
      }
      // Reject embedded credentials — they leak via logs, error messages, and Referrer headers.
      // RFC 3986 §3.2.1 deprecated userinfo in HTTP(S) URIs.
      if (url.username || url.password) {
        throw new s402Error('INVALID_PAYLOAD',
          `${where}: facilitatorUrl must not contain embedded credentials (user:password@)`);
      }
    } catch (e) {
      if (e instanceof s402Error) throw e;
      throw new s402Error('INVALID_PAYLOAD', `${where}: facilitatorUrl is not a valid URL`);
    }
  }
  if (extra.settlementMode !== undefined) {
    if (extra.settlementMode !== 'facilitator' && extra.settlementMode !== 'direct') {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: settlementMode must be "facilitator" or "direct", got ${JSON.stringify(extra.settlementMode)}`);
    }
  }
  if (extra.receiptRequired !== undefined) {
    if (typeof extra.receiptRequired !== 'boolean') {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: receiptRequired must be a boolean, got ${typeof extra.receiptRequired}`);
    }
  }
  if (extra.extensions !== undefined && !isPlainObject(extra.extensions)) {
    throw new s402Error('INVALID_PAYLOAD',
      `${where}: extra.extensions must be a plain object`);
  }
  validateSubObjects(extra);
}

/** Validate one `accepts[]` entry as it arrived on the wire. */
function validateRequirementEntry(entry: unknown, index: number): void {
  const where = `accepts[${index}]`;
  if (!isPlainObject(entry)) {
    throw new s402Error('INVALID_PAYLOAD', `${where} is not an object`);
  }

  const missing: string[] = [];
  // Postel: the scheme name is NOT checked against s402's six. An x402 server
  // may offer `auth-capture`; a scheme we cannot pay is one we SKIP, and a
  // decoder that refuses the whole 402 over it turns a menu into a rejection.
  if (typeof entry.scheme !== 'string' || entry.scheme.length === 0) missing.push('scheme (non-empty string)');
  if (typeof entry.network !== 'string') missing.push('network (string)');
  if (typeof entry.asset !== 'string') missing.push('asset (string)');
  if (typeof entry.amount !== 'string') {
    missing.push('amount (string)');
  } else if (!isValidAmount(entry.amount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `${where}: invalid amount "${entry.amount}": must be a non-negative integer string`);
  }
  if (typeof entry.payTo !== 'string') {
    missing.push('payTo (string)');
  } else if (entry.payTo.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', `${where}: payTo must be a non-empty string`);
  }
  if (missing.length > 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed payment requirements: ${where} missing ${missing.join(', ')}`);
  }

  // Reject control characters in protocol-semantic identifier fields.
  // These feed into Map keys, error messages, and downstream logs — null bytes
  // and CRLF are never legitimate in scheme/network/asset/address identifiers.
  for (const field of ['scheme', 'network', 'asset', 'payTo'] as const) {
    if (/[\x00-\x1f\x7f]/.test(entry[field] as string)) {
      throw new s402Error('INVALID_PAYLOAD', `${where}: ${field} contains control characters`);
    }
  }

  if (entry.maxTimeoutSeconds !== undefined) {
    if (typeof entry.maxTimeoutSeconds !== 'number' || !Number.isFinite(entry.maxTimeoutSeconds) || entry.maxTimeoutSeconds < 0) {
      throw new s402Error('INVALID_PAYLOAD',
        `${where}: maxTimeoutSeconds must be a non-negative finite number, got ${JSON.stringify(entry.maxTimeoutSeconds)}`);
    }
  }

  if (entry.extra !== undefined) {
    if (!isPlainObject(entry.extra)) {
      throw new s402Error('INVALID_PAYLOAD', `${where}: extra must be a plain object`);
    }
    validateExtraFields(entry.extra, where);
  }
}

/**
 * Validate that a decoded 402 document has the required shape.
 *
 * Takes the WIRE envelope — `{ x402Version: 2, resource, accepts: [...] }` —
 * not the lifted s402 view. Everything s402 adds is validated where it actually
 * travels: inside each entry's `extra`, and inside `extensions.s402`.
 */
export function validateRequirementsShape(obj: unknown): void {
  if (obj == null || typeof obj !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'Payment requirements is not an object');
  }
  const record = obj as Record<string, unknown>;

  // Version gate. The flat s402 v1 shape (`s402Version` + `accepts: string[]`)
  // is no longer emitted by anything and is not decoded here — reading it is an
  // intake obligation (ADR-013) discharged in compat, not a wire format.
  if (record.x402Version === undefined) {
    if (record.s402Version !== undefined) {
      throw new s402Error('INVALID_PAYLOAD',
        'This is the s402 v1 flat requirements shape, retired in wire v2. ' +
        'Use fromS402V1Requirements() or normalizeRequirements() from s402/compat/x402.');
    }
    throw new s402Error('INVALID_PAYLOAD',
      'Missing x402Version. An s402 402 is an x402 V2 PaymentRequired envelope.');
  }
  if (record.x402Version !== 2) {
    throw new s402Error('INVALID_PAYLOAD',
      `Unsupported x402Version ${JSON.stringify(record.x402Version)}. ` +
      'The s402 wire is x402 V2; use normalizeRequirements() from s402/compat/x402 for V1.');
  }

  // `resource` is mandatory on an x402 V2 envelope. Emission requires a
  // non-empty url (see toX402V2Envelope); decode only requires the field to be
  // there and to be a string, so a peer with an empty url is still readable.
  if (!isPlainObject(record.resource)) {
    throw new s402Error('INVALID_PAYLOAD',
      'Malformed payment requirements: missing resource (object with a url)');
  }
  if (typeof (record.resource as Record<string, unknown>).url !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      'Malformed payment requirements: resource.url must be a string');
  }

  if (!Array.isArray(record.accepts)) {
    throw new s402Error('INVALID_PAYLOAD',
      'Malformed payment requirements: missing accepts (array of requirement objects)');
  }
  // Empty accepts is semantically invalid — the client cannot match any offer.
  if (record.accepts.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'accepts array must contain at least one requirement');
  }
  record.accepts.forEach(validateRequirementEntry);

  if (record.error !== undefined && typeof record.error !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `error must be a string, got ${typeof record.error}`);
  }

  if (record.extensions !== undefined) {
    if (!isPlainObject(record.extensions)) {
      throw new s402Error('INVALID_PAYLOAD', 'extensions must be a plain object');
    }
    const s402Ext = (record.extensions as Record<string, unknown>)[S402_EXTENSION_KEY];
    if (s402Ext !== undefined) {
      if (!isPlainObject(s402Ext)) {
        throw new s402Error('INVALID_PAYLOAD', 'extensions.s402 must be a plain object');
      }
      // ADR-006 version negotiation: the number is here, and a version this
      // build does not implement is refused rather than half-read.
      if (s402Ext.version !== undefined && s402Ext.version !== S402_WIRE_VERSION) {
        throw new s402Error('INVALID_PAYLOAD',
          `Unsupported s402 wire version ${JSON.stringify(s402Ext.version)}. This library supports version "${S402_WIRE_VERSION}".`);
      }
      if (s402Ext.mandate !== undefined) validateMandateShape(s402Ext.mandate);
    }
  }
}

/**
 * Validate that a decoded payment payload has the required shape.
 *
 * Exported so non-HTTP carriers (e.g. the MCP `_meta` codec in `transport.ts`)
 * can validate an already-parsed payload object through the SAME canonical
 * trust-boundary check the HTTP path uses — no duplicated validation logic.
 */
export function validatePayloadShape(obj: unknown): void {
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

  // Scheme-specific inner fields.
  // unlock carries only transaction + signature (as exact) — the generic checks above
  // suffice; the encryption identity travels in the fulfillment, not the payload.
  if (record.scheme === 'upto') {
    if (typeof inner.maxAmount !== 'string') {
      throw new s402Error('INVALID_PAYLOAD',
        `upto payload requires maxAmount (string), got ${typeof inner.maxAmount}`);
    }
    if (!isValidAmount(inner.maxAmount)) {
      throw new s402Error('INVALID_PAYLOAD',
        `upto payload maxAmount must be a non-negative integer string, got "${inner.maxAmount}"`);
    }
    if (inner.settlementCeiling !== undefined) {
      if (typeof inner.settlementCeiling !== 'string') {
        throw new s402Error('INVALID_PAYLOAD',
          `upto payload settlementCeiling must be a string if provided, got ${typeof inner.settlementCeiling}`);
      }
      if (!isValidAmount(inner.settlementCeiling)) {
        throw new s402Error('INVALID_PAYLOAD',
          `upto payload settlementCeiling must be a non-negative integer string, got "${inner.settlementCeiling}"`);
      }
      const ceiling = BigInt(inner.settlementCeiling);
      if (ceiling < 1n) {
        throw new s402Error('INVALID_PAYLOAD',
          `upto payload settlementCeiling must be >= 1, got "${inner.settlementCeiling}"`);
      }
      const max = BigInt(inner.maxAmount);
      if (ceiling > max) {
        throw new s402Error('INVALID_PAYLOAD',
          `upto payload settlementCeiling (${inner.settlementCeiling}) must be <= maxAmount (${inner.maxAmount})`);
      }
    }
  }
  if (record.scheme === 'prepaid') {
    if (typeof inner.ratePerCall !== 'string') {
      throw new s402Error('INVALID_PAYLOAD',
        `prepaid payload requires ratePerCall (string), got ${typeof inner.ratePerCall}`);
    }
    if (!isValidAmount(inner.ratePerCall)) {
      throw new s402Error('INVALID_PAYLOAD',
        `prepaid payload ratePerCall must be a non-negative integer string, got "${inner.ratePerCall}"`);
    }
    if (inner.maxCalls !== undefined) {
      if (typeof inner.maxCalls !== 'string') {
        throw new s402Error('INVALID_PAYLOAD',
          `prepaid payload maxCalls must be a string if provided, got ${typeof inner.maxCalls}`);
      }
      if (!isValidAmount(inner.maxCalls)) {
        throw new s402Error('INVALID_PAYLOAD',
          `prepaid payload maxCalls must be a non-negative integer string, got "${inner.maxCalls}"`);
      }
    }
  }
}

/**
 * Validate that a decoded settle response has the required shape.
 *
 * Exported so non-HTTP carriers (e.g. the MCP `_meta` codec in `transport.ts`)
 * can validate an already-parsed settle object through the SAME canonical
 * trust-boundary check the HTTP path uses — no duplicated validation logic.
 */
export function validateSettleShape(obj: unknown): void {
  if (obj == null || typeof obj !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'Settle response is not an object');
  }
  const record = obj as Record<string, unknown>;
  if (typeof record.success !== 'boolean') {
    throw new s402Error('INVALID_PAYLOAD',
      'Malformed settle response: missing or invalid "success" (boolean)');
  }
  // Validate optional fields have correct types when present.
  // These arrive from facilitator RPCs (trust boundary) — wrong types would
  // pass through pickSettleResponseFields and violate s402SettleResponse's interface.
  if (record.txDigest !== undefined && typeof record.txDigest !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: txDigest must be a string, got ${typeof record.txDigest}`);
  }
  if (record.receiptId !== undefined && typeof record.receiptId !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: receiptId must be a string, got ${typeof record.receiptId}`);
  }
  if (record.finalityMs !== undefined && (typeof record.finalityMs !== 'number' || !Number.isFinite(record.finalityMs))) {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: finalityMs must be a finite number, got ${typeof record.finalityMs}`);
  }
  if (record.streamId !== undefined && typeof record.streamId !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: streamId must be a string, got ${typeof record.streamId}`);
  }
  if (record.escrowId !== undefined && typeof record.escrowId !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: escrowId must be a string, got ${typeof record.escrowId}`);
  }
  if (record.balanceId !== undefined && typeof record.balanceId !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: balanceId must be a string, got ${typeof record.balanceId}`);
  }
  if (record.actualAmount !== undefined && typeof record.actualAmount !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: actualAmount must be a string, got ${typeof record.actualAmount}`);
  }
  if (record.depositId !== undefined && typeof record.depositId !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: depositId must be a string, got ${typeof record.depositId}`);
  }
  if (record.error !== undefined && typeof record.error !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: error must be a string, got ${typeof record.error}`);
  }
  if (record.errorCode !== undefined && typeof record.errorCode !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed settle response: errorCode must be a string, got ${typeof record.errorCode}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Body transport (JSON — no base64, no header size limit)
//
// Header transport uses base64-encoded JSON in HTTP headers.
// Body transport uses raw JSON in the request/response body.
//
// Why both? Headers are limited by infrastructure you don't control:
//   - Nginx: 4-8KB default (ALL headers)
//   - Node.js: 16KB default
//   - Sui max PTB: 128KB → ~170KB base64 (CANNOT fit in headers)
// Body limits are set by YOUR application (Express: 100KB default,
// Nginx: 1MB default, easily configurable).
//
// Use header transport for small payments (< 8KB).
// Use body transport for large/complex DeFi PTBs.
// ══════════════════════════════════════════════════════════════

/**
 * Content type for s402 JSON body transport.
 *
 * Covers generic s402 request/response bodies (payload, requirements, legacy
 * settle). The settlement envelope (ADR-007) has its own more specific media
 * type — see `S402_ENVELOPE_CONTENT_TYPE` in `./envelope`.
 */
export const S402_CONTENT_TYPE = 'application/s402+json' as const;

/**
 * Maximum body size (1 MB). Defense-in-depth against oversized JSON payloads.
 * Bigger than MAX_HEADER_BYTES (64KB) because body transport is designed for
 * large PTBs; still bounded so a malicious client can't exhaust memory via
 * JSON.parse. Hosts should also enforce their own limits upstream (Express
 * `limit`, Nginx `client_max_body_size`), but a wire format library should
 * not rely on runtime enforcement.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Encode the 402 document as a JSON string (for the response body).
 *
 * Same envelope as the header carries. Upstream's own resource server puts the
 * envelope in both places, and an x402 V1 client reads only the body.
 */
export function encodeRequirementsBody(required: s402PaymentRequired): string {
  return JSON.stringify(toRequirementsWire(required));
}

/** Decode the 402 document from a JSON string (from the response body) */
export function decodeRequirementsBody(body: string): s402PaymentRequired {
  if (typeof body !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 requirements body must be a string, got ${typeof body}`);
  }
  if (body.length > MAX_BODY_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 requirements body exceeds maximum size (${body.length} > ${MAX_BODY_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to parse s402 requirements body: ${e instanceof Error ? e.message : 'invalid JSON'}`);
  }
  validateRequirementsShape(parsed);
  return pickRequirementsFields(parsed as Record<string, unknown>);
}

/** Encode payment payload as JSON string (for request body) */
export function encodePayloadBody(payload: s402PaymentPayload): string {
  return JSON.stringify(payload);
}

/** Decode payment payload from JSON string (from request body) */
export function decodePayloadBody(body: string): s402PaymentPayload {
  if (typeof body !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 payload body must be a string, got ${typeof body}`);
  }
  if (body.length > MAX_BODY_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 payload body exceeds maximum size (${body.length} > ${MAX_BODY_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to parse s402 payload body: ${e instanceof Error ? e.message : 'invalid JSON'}`);
  }
  validatePayloadShape(parsed);
  return pickPayloadFields(parsed as Record<string, unknown>);
}

/** Encode settlement response as JSON string (for response body) */
export function encodeSettleBody(response: s402SettleResponse): string {
  return JSON.stringify(response);
}

/** Decode settlement response from JSON string (from response body) */
export function decodeSettleBody(body: string): s402SettleResponse {
  if (typeof body !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 settle body must be a string, got ${typeof body}`);
  }
  if (body.length > MAX_BODY_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 settle body exceeds maximum size (${body.length} > ${MAX_BODY_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to parse s402 settle body: ${e instanceof Error ? e.message : 'invalid JSON'}`);
  }
  validateSettleShape(parsed);
  return pickSettleResponseFields(parsed as Record<string, unknown>);
}

/**
 * Detect transport mode from an incoming request.
 *
 * Checks Content-Type for body transport (generic `application/s402+json`
 * OR the envelope-specific `application/vnd.s402.envelope+json`), then falls
 * back to header detection.
 * Returns 'body' if either s402 body media type is present.
 * Returns 'header' if x-payment header is present.
 * Returns 'unknown' otherwise.
 */
export function detectTransport(request: { headers: Headers }): 'header' | 'body' | 'unknown' {
  const contentType = request.headers.get('content-type');
  if (contentType?.includes(S402_CONTENT_TYPE)) return 'body';
  if (contentType?.includes('application/vnd.s402.envelope+json')) return 'body';
  if (request.headers.get(S402_HEADERS.PAYMENT)) return 'header';
  return 'unknown';
}

// ══════════════════════════════════════════════════════════════
// Protocol detection
// ══════════════════════════════════════════════════════════════

/**
 * Detect whether a 402 response is an s402-profile 402 or a plain x402 one.
 *
 * Both are x402 V2 envelopes; what separates them is `extensions.s402`. That
 * key's PRESENCE is the marker (ADR-016 rule 4) — not `s402Version`, which no
 * longer appears on a 402 at all.
 *
 * Note what this does NOT decide: a plain x402 402 is still payable by an s402
 * client. `'x402'` here means "no s402 extensions on it", never "not for us".
 */
export function detectProtocol(headers: Headers): 's402' | 'x402' | 'unknown' {
  const paymentRequired = headers.get(S402_HEADERS.PAYMENT_REQUIRED);
  if (!paymentRequired) return 'unknown';

  // D-08: Reject oversized headers before parsing (defense-in-depth)
  if (paymentRequired.length > MAX_HEADER_BYTES) return 'unknown';

  try {
    const decoded = JSON.parse(fromBase64(paymentRequired));
    if (!isPlainObject(decoded)) return 'unknown';
    const extensions = decoded.extensions;
    if (isPlainObject(extensions) && isPlainObject(extensions[S402_EXTENSION_KEY])) return 's402';
    if ('x402Version' in decoded) return 'x402';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Extract the 402 document from a Response.
 * Returns null if the header is missing or malformed.
 *
 * Plain x402 V2 402s come back too — they are the same envelope. Only an x402
 * V1 402 (flat requirements, `x402Version: 1`) needs `normalizeRequirements()`.
 *
 * @param response - Fetch API Response object (status should be 402)
 * @returns The parsed 402 document, or null if the header is absent/unreadable
 *
 * @example
 * ```ts
 * import { extractRequirementsFromResponse } from 's402/http';
 *
 * const res = await fetch(url);
 * if (res.status === 402) {
 *   const required = extractRequirementsFromResponse(res);
 *   if (required) {
 *     // Build and send payment
 *   }
 * }
 * ```
 */
export function extractRequirementsFromResponse(response: Response): s402PaymentRequired | null {
  const header = response.headers.get(S402_HEADERS.PAYMENT_REQUIRED);
  if (!header) return null;

  try {
    return decodePaymentRequired(header);
  } catch {
    return null;
  }
}
