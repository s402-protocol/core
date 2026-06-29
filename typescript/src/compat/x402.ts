/**
 * s402 ↔ x402 Compatibility Layer
 *
 * Enables bidirectional interop:
 *   - x402 clients can talk to s402 servers (via "exact" scheme)
 *   - s402 clients can talk to x402 servers (graceful degradation)
 *
 * Roundtrip: fromX402(toX402(s402)) preserves all x402 fields.
 * s402-only fields (mandate, stream, escrow, unlock extensions) are stripped.
 */

import type { s402PaymentRequirements, s402ExactPayload, s402PaymentPayload } from '../types.js';
import { S402_VERSION } from '../types.js';
import { s402Error } from '../errors.js';
import { isValidAmount, validateRequirementsShape, pickRequirementsFields } from '../http.js';

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
export function fromX402Requirements(x402: x402PaymentRequirements, now?: number): s402PaymentRequirements {
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
  // M-1: Validate facilitatorUrl to prevent SSRF via dangerous URL schemes (file://, etc.)
  if (x402.facilitatorUrl !== undefined) {
    try {
      const url = new URL(x402.facilitatorUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new s402Error('INVALID_PAYLOAD',
          `facilitatorUrl must use https:// or http://, got "${url.protocol}"`);
      }
      if (url.username || url.password) {
        throw new s402Error('INVALID_PAYLOAD',
          'facilitatorUrl must not contain embedded credentials (user:password@)');
      }
    } catch (e) {
      if (e instanceof s402Error) throw e;
      throw new s402Error('INVALID_PAYLOAD', 'facilitatorUrl is not a valid URL');
    }
  }
  // Compute expiresAt from x402's maxTimeoutSeconds to preserve S1 (Stale Payment Rejection).
  // Without this, inbound x402 traffic would bypass all three S1 expiration layers because
  // expiresAt would be undefined (the null-check guards in facilitator.process() would skip).
  const expiresAt = x402.maxTimeoutSeconds != null && x402.maxTimeoutSeconds > 0
    ? (now ?? Date.now()) + x402.maxTimeoutSeconds * 1000
    : undefined;

  return {
    s402Version: S402_VERSION,
    accepts: ['exact'],
    network: x402.network,
    asset: x402.asset,
    amount,
    payTo: x402.payTo,
    facilitatorUrl: x402.facilitatorUrl,
    expiresAt,
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
// Inbound from HTTP headers (server intake — opt-in x402 acceptance)
// ══════════════════════════════════════════════════════════════

/**
 * x402 inbound payload header names, in preference order. x402 V2 uses
 * `PAYMENT-SIGNATURE`; x402 V1 used `X-PAYMENT`. Read case-insensitively — HTTP
 * field names are case-insensitive (RFC 9110 §5.1), and HTTP/2 mandates lowercase
 * on the wire (RFC 9113 §8.2.1), so a `Headers` lookup matches any client casing.
 */
const X402_PAYLOAD_HEADERS = ['payment-signature', 'x-payment'] as const;

/** Defense-in-depth header size cap, mirroring `http.ts` MAX_HEADER_BYTES (64KB). */
const MAX_X402_HEADER_BYTES = 64 * 1024;

/** Unicode-safe standard-base64 → parsed JSON (x402 encodes header JSON as standard base64). */
function decodeBase64Json(b64: string): unknown {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Server-intake bridge: extract an **x402** payment payload from a request's
 * headers and normalize it to an **s402** payload.
 *
 * This is the inbound half of "s402 servers transparently accept x402 clients"
 * (ADR-005). It lives in the OPT-IN `s402/compat/x402` layer — NOT the core —
 * so the s402 protocol core stays x402-free (AGENTS.md: "x402 compat is opt-in;
 * core has no x402 dependency"). The companion fact: s402's *outbound* settlement
 * header (`payment-response`) already matches x402 V2's `PAYMENT-RESPONSE`
 * case-insensitively, so no emit change is needed to be read by x402 clients.
 *
 * Reads the x402 payload header — `PAYMENT-SIGNATURE` (x402 V2) or `X-PAYMENT`
 * (x402 V1) — base64-decodes the JSON, and runs {@link fromX402Payload}. The
 * realistic interop path is an x402 **Sui** client whose `payload` carries
 * `{ transaction, signature }`; EVM-shaped authorization payloads have no s402
 * equivalent and are rejected by `fromX402Payload`.
 *
 * @param headers - The inbound request headers.
 * @returns The normalized s402 payload, or `null` if no x402 payload header is
 *   present (so callers can fall back to the native s402 `x-payment` path).
 * @throws {s402Error} `INVALID_PAYLOAD` if a header IS present but oversized,
 *   not base64-JSON, or not a valid x402 payload object.
 *
 * @example Server intake — prefer native s402, fall back to x402
 * ```ts
 * import { decodePaymentPayload } from 's402/http';
 * import { fromX402PayloadHeaders } from 's402/compat/x402';
 *
 * const native = request.headers.get('x-payment');
 * const payload = native
 *   ? decodePaymentPayload(native)                  // s402-native client
 *   : fromX402PayloadHeaders(request.headers);      // x402 client (or null)
 * ```
 */
export function fromX402PayloadHeaders(headers: Headers): s402PaymentPayload | null {
  let raw: string | null = null;
  for (const name of X402_PAYLOAD_HEADERS) {
    const value = headers.get(name);
    if (value != null) { raw = value; break; }
  }
  if (raw == null) return null;
  if (raw.length > MAX_X402_HEADER_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `x402 payment header exceeds maximum size (${raw.length} > ${MAX_X402_HEADER_BYTES})`);
  }
  let decoded: unknown;
  try {
    decoded = decodeBase64Json(raw);
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to decode x402 payment header: ${e instanceof Error ? e.message : 'invalid base64 or JSON'}`);
  }
  if (decoded == null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 payment payload must be a JSON object');
  }
  return fromX402Payload(decoded as x402PaymentPayload);
}

/**
 * x402's MCP `_meta` key. x402's MCP transport places the payment object at
 * `_meta['x402/payment']` (its `MCP_PAYMENT_META_KEY`). s402's native key is
 * `s402/payment` (see `S402_MCP_META_KEY` in `transport.ts`).
 */
const X402_MCP_META_KEY = 'x402/payment' as const;

/**
 * Server-intake bridge (MCP): extract an **x402** payment payload from a
 * JSON-RPC message `_meta` record and normalize it to an **s402** payload. The
 * MCP analogue of {@link fromX402PayloadHeaders}, and the opt-in inbound half of
 * x402-over-MCP interop — kept in compat so the core `mcpTransport` stays
 * x402-free (AGENTS.md), symmetric with how the HTTP x402 inbound is handled.
 *
 * Reads `_meta['x402/payment']` (x402's MCP key), which carries the payment
 * object as structured JSON — not base64 — per MCP's idiom, and runs
 * {@link fromX402Payload}. Returns `null` when the key is absent so callers can
 * fall back to the native `_meta['s402/payment']` path.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the key is present but not a valid
 *   x402 payload object (e.g. missing `payload.transaction`/`signature`).
 */
export function fromX402PayloadMeta(meta: Record<string, unknown>): s402PaymentPayload | null {
  const raw = meta[X402_MCP_META_KEY];
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 _meta payment payload must be a JSON object');
  }
  return fromX402Payload(raw as x402PaymentPayload);
}

/** x402's A2A payload metadata key (`x402.payment.payload` on the task/message metadata). */
const X402_A2A_PAYLOAD_KEY = 'x402.payment.payload' as const;

/**
 * Server-intake bridge (A2A): extract an **x402** payment payload from an A2A
 * task/message `metadata` record and normalize it to an **s402** payload. The
 * A2A analogue of {@link fromX402PayloadHeaders} / {@link fromX402PayloadMeta},
 * completing the opt-in x402-inbound trio (HTTP · MCP · A2A) — kept in compat so
 * the core `a2aTransport` stays x402-free (AGENTS.md).
 *
 * Reads `metadata['x402.payment.payload']` (x402's A2A key), which carries the
 * payment object as structured JSON, and runs {@link fromX402Payload}. Returns
 * `null` when absent so callers can fall back to the native `s402.payment.payload`
 * path.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the key is present but not a valid
 *   x402 payload object.
 */
export function fromX402PayloadA2A(metadata: Record<string, unknown>): s402PaymentPayload | null {
  const raw = metadata[X402_A2A_PAYLOAD_KEY];
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 A2A payment payload must be a JSON object');
  }
  return fromX402Payload(raw as x402PaymentPayload);
}

// ══════════════════════════════════════════════════════════════
// Convert s402 → x402
// ══════════════════════════════════════════════════════════════

/**
 * Convert outbound s402 requirements to x402 V1 wire format.
 * Strips s402-only fields (mandate, upto, prepaid, stream, escrow, unlock extensions).
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
// V2 wire types and write path
// ══════════════════════════════════════════════════════════════

/**
 * x402 V2 ResourceInfo per upstream `@x402/core/types/payments.ts`.
 *
 * Replaces V1's inline `resource: string` + `description: string` on each
 * requirement. V2 hoists resource metadata to the `PaymentRequired` envelope
 * level (one ResourceInfo per envelope, not per requirement).
 */
export interface x402V2ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/**
 * x402 V2 PaymentRequirements per upstream `@x402/core/types/payments.ts` HEAD
 * as of 2026-05-12. Compared to our V1-superset {@link x402PaymentRequirements}:
 *
 *   - `x402Version` is REMOVED (moved to envelope level)
 *   - `maxAmountRequired` is REMOVED (alias dropped; only `amount`)
 *   - `resource` / `description` REMOVED (moved to envelope's ResourceInfo)
 *   - `extra: Record<string, unknown>` is REQUIRED (was optional/absent in V1)
 *   - `facilitatorUrl` not in upstream V2 — kept as our extension in V1
 *   - `maxTimeoutSeconds` is REQUIRED in V2 (was optional in V1)
 */
export interface x402V2PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/**
 * x402 V2 PaymentRequired envelope per upstream. Wraps an `accepts` array of
 * {@link x402V2PaymentRequirements}. `resource` is REQUIRED on the V2 envelope.
 */
export interface x402V2PaymentRequired {
  x402Version: number;
  resource: x402V2ResourceInfo;
  accepts: x402V2PaymentRequirements[];
  error?: string;
  extensions?: Record<string, unknown>;
}

/**
 * Convert outbound s402 requirements to x402 V2 wire format.
 *
 * Differs from {@link toX402Requirements} (V1 emitter):
 *   - Does NOT emit `x402Version` (lives on envelope in V2)
 *   - Does NOT emit `maxAmountRequired` or `resource`/`description`
 *   - Emits required `extra: Record<string, unknown>` (defaults to `{}`)
 *   - `maxTimeoutSeconds` is REQUIRED in output (defaults to 60s)
 *
 * **Scheme constraint:** Only translates `s402.accepts === ['exact']` to x402
 * `'exact'`. Other s402 schemes (upto, prepaid, stream, escrow, unlock) do NOT
 * have direct x402 wire-format equivalents; this function throws rather than
 * silently downgrade them. Use a Sui-native s402 path or extend this function
 * with explicit per-scheme mapping if you need non-exact emission.
 *
 * **EVM EIP-3009 callers:** The default `extra: {}` is wire-shape-correct but
 * not signing-correct for real EVM tokens. To sign a real Permit2 authorization,
 * `extra` must include `name` (token name) and `version` (token version) for
 * the EIP-712 domain. Pass these via `options.extra` when emitting requirements
 * a real EVM facilitator will attempt to verify.
 *
 * Use this when emitting to consumers of x402 v2.x SDKs (the current upstream).
 * V1 emission via {@link toX402Requirements} remains supported for legacy
 * facilitators.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if `s402.accepts` does not include 'exact'
 *   as the first entry.
 */
export function toX402V2Requirements(
  s402: s402PaymentRequirements,
  options?: { maxTimeoutSeconds?: number; extra?: Record<string, unknown> },
): x402V2PaymentRequirements {
  if (!s402.accepts || s402.accepts.length === 0 || s402.accepts[0] !== 'exact') {
    throw new s402Error('INVALID_PAYLOAD',
      `toX402V2Requirements only translates s402.accepts[0] === 'exact'; got ${JSON.stringify(s402.accepts)}. ` +
      `Other s402 schemes (upto, prepaid, stream, escrow, unlock) have no direct x402 wire-format equivalent.`);
  }
  return {
    scheme: 'exact',
    network: s402.network,
    asset: s402.asset,
    amount: s402.amount,
    payTo: s402.payTo,
    maxTimeoutSeconds: options?.maxTimeoutSeconds ?? 60,
    extra: options?.extra ?? {},
  };
}

/**
 * Wrap an s402 requirement in an x402 V2 `PaymentRequired` envelope. The
 * envelope hoists `x402Version` and `resource` (ResourceInfo) above the
 * per-requirement layer.
 *
 * @param s402 - The s402 requirement to lift into V2 format.
 * @param resource - ResourceInfo describing the resource being paid for.
 *   REQUIRED in V2 envelopes per upstream spec.
 * @param options - Optional overrides for timeout, extra fields, and
 *   envelope-level extensions.
 */
export function toX402V2Envelope(
  s402: s402PaymentRequirements,
  resource: x402V2ResourceInfo,
  options?: {
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
    error?: string;
  },
): x402V2PaymentRequired {
  if (!resource || typeof resource.url !== 'string' || resource.url.length === 0) {
    throw new s402Error('INVALID_PAYLOAD',
      'x402 V2 envelope requires a non-empty resource.url (ResourceInfo.url is mandatory per the x402 V2 spec)');
  }
  const req = toX402V2Requirements(s402, {
    maxTimeoutSeconds: options?.maxTimeoutSeconds,
    extra: options?.extra,
  });
  const envelope: x402V2PaymentRequired = {
    x402Version: 2,
    resource,
    accepts: [req],
  };
  if (options?.extensions) envelope.extensions = options.extensions;
  if (options?.error) envelope.error = options.error;
  return envelope;
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
export function fromX402Envelope(envelope: x402PaymentRequiredEnvelope, now?: number): s402PaymentRequirements {
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
  return fromX402Requirements(req, now);
}

/**
 * Auto-detect and normalize: if x402, convert to s402. If already s402, validate and pass through.
 * Handles x402 V1 (flat), x402 V2 (envelope with accepts array), and s402 formats.
 * Validates required fields to catch malformed/malicious payloads at the trust boundary.
 *
 * Returns a clean object with only known s402 fields — unknown top-level keys are stripped.
 *
 * @param obj - Raw decoded JSON (could be s402, x402 V1, or x402 V2 envelope)
 * @returns Validated s402PaymentRequirements
 * @throws {s402Error} `INVALID_PAYLOAD` if the format is unrecognized or malformed
 *
 * @example
 * ```ts
 * import { normalizeRequirements } from 's402/compat/x402';
 *
 * // Works with any format — auto-detects s402 vs x402
 * const rawJson = JSON.parse(atob(header));
 * const requirements = normalizeRequirements(rawJson);
 * // Always returns s402PaymentRequirements regardless of input format
 * ```
 */
export function normalizeRequirements(
  obj: Record<string, unknown>,
  now?: number,
): s402PaymentRequirements {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Payment requirements must be a plain object, got ${obj === null ? 'null' : Array.isArray(obj) ? 'array' : typeof obj}`);
  }
  if (isS402(obj)) {
    // Delegate to the canonical validator in http.ts — single source of truth.
    validateRequirementsShape(obj);
    return pickRequirementsFields(obj);
  }
  // x402 V2 envelope: { x402Version, accepts: [{scheme, network, ...}, ...] }
  if (isX402Envelope(obj)) {
    const result = fromX402Envelope(obj as unknown as x402PaymentRequiredEnvelope, now);
    // Validate the normalized output with the same checks as native s402 decode
    // (payTo format, control chars, u64 bounds) — prevents weaker x402 validation
    // from producing an s402PaymentRequirements that would fail native validation.
    const record = result as unknown as Record<string, unknown>;
    validateRequirementsShape(record);
    return pickRequirementsFields(record);
  }
  // x402 V1 flat: { x402Version, scheme, network, amount/maxAmountRequired, ... }
  if (isX402(obj)) {
    validateX402Shape(obj);
    const result = fromX402Requirements(obj as unknown as x402PaymentRequirements, now);
    const record = result as unknown as Record<string, unknown>;
    validateRequirementsShape(record);
    return pickRequirementsFields(record);
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
