/**
 * s402 Settlement Envelope — ADR-007
 *
 * Chain-agnostic typed response envelope for `/verify` and `/settle`.
 *
 * Replaces the legacy flat `s402SettleResponse` shape with a discriminated
 * union on `status` plus cryptographic binding fields (`txBinding`, `algs`,
 * `specDigest`, `facilitatorIds`) that close the request-swap,
 * cross-network-replay, and algorithm-silent-downgrade attacks.
 *
 * Media type: `application/vnd.s402.envelope+json` (vendor tree, structured suffix).
 *
 * Six of the eight client-side MUST checks from ADR-007 §"Client verification
 * obligations" live in `verifyEnvelope()` below: scheme-match, spec-digest,
 * network, algorithm acceptance, timestamp skew, and txBinding. The remaining
 * two — resource binding (check 5) and unlock-TX2 attestation (check 8) —
 * need request-intent and scheme-specific context this module cannot see;
 * they are the CALLER's obligation and are not enforced anywhere in s402
 * proper. `@sweefi/sdk` wraps this so application code never sees a bypass
 * path for the six that live here.
 */

import type { s402Scheme, s402PaymentRequirements, s402PaymentPayload } from './types.js';
import type { s402ErrorCodeType } from './errors.js';
import { s402Error } from './errors.js';
import { canonicalize } from './canonicalization.js';
import { MAX_BODY_BYTES } from './http.js';

// ══════════════════════════════════════════════════════════════
// Media types
// ══════════════════════════════════════════════════════════════

/** Content type for the settlement envelope wire format. */
export const S402_ENVELOPE_CONTENT_TYPE = 'application/vnd.s402.envelope+json' as const;

// ══════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════

/** SRI-compatible digest algorithm identifiers. See ADR-007. */
export type s402DigestAlg = 'sha256' | 'sha384' | 'sha512' | 'blake3';

/** Signature algorithm identifiers. See ADR-007. */
export type s402SigAlg = 'ed25519' | 'ed25519ph' | 'secp256k1' | 'ml-dsa-44';

/** Algorithm identifiers carried in every envelope for crypto-agility. */
export interface s402Algs {
  digest: s402DigestAlg;
  sig: s402SigAlg;
}

export interface s402EnvelopeBase {
  /** Protocol version — matches `s402-Version` header. */
  s402Version: string;
  /** Scheme name. */
  scheme: s402Scheme;
  /** Content-hash of the scheme spec this response was computed against (SRI form). */
  specDigest: string;
  /** Cryptographic request→response binding (SRI form). See `computeTxBinding`. */
  txBinding: string;
  /** Network identifier (e.g. "sui:mainnet"). Prevents cross-network replay. */
  network: string;
  /** Algorithm identifiers — enables migration without wire-break. */
  algs: s402Algs;
  /** ISO-8601 UTC millisecond timestamp. Client rejects if skew > 5 min. */
  timestamp: string;
  /** Facilitator identities that contributed to this envelope. */
  facilitatorIds?: string[];
}

export interface s402EnvelopeSettled extends s402EnvelopeBase {
  status: 'settled';
  settled: {
    /** Chain-specific settlement blob — opaque at protocol layer. */
    settlement: unknown;
    settledAt: string;
    /** Scheme-specific attestation (e.g., unlock TX2). Inline per ADR-008 S11. */
    attestation?: unknown;
  };
}

export interface s402EnvelopeVerified extends s402EnvelopeBase {
  status: 'verified';
  verified: Record<string, never>;
}

export interface s402EnvelopeRejected extends s402EnvelopeBase {
  status: 'rejected';
  rejected: { error: { code: s402ErrorCodeType; message: string } };
}

export interface s402EnvelopePending extends s402EnvelopeBase {
  status: 'pending';
  pending: { retryAfter?: number; reason: string };
}

export type s402Envelope =
  | s402EnvelopeSettled
  | s402EnvelopeVerified
  | s402EnvelopeRejected
  | s402EnvelopePending;

// ══════════════════════════════════════════════════════════════
// txBinding
// ══════════════════════════════════════════════════════════════

/**
 * Domain-separation prefix for txBinding digest inputs.
 * See `spec/canonicalization.md` §3.3 for the purpose registry.
 */
const TX_BINDING_PREFIX = 's402-txbinding-v1\0';

/** ASCII record separator (U+001E) — unambiguous delimiter between canonical blobs. */
const RECORD_SEPARATOR = 0x1e;

/**
 * Compute the `txBinding` value for a request pair.
 *
 * ```
 * txBinding = "sha256-" || base64url_no_pad(
 *   sha256(
 *     "s402-txbinding-v1\0"
 *     || JCS(requirements)
 *     || 0x1E
 *     || JCS(payload)
 *   )
 * )
 * ```
 *
 * Clients recompute this locally from their OWN `{requirements, payload}` and
 * compare to `envelope.txBinding` using a constant-time primitive. See S14.
 */
export async function computeTxBinding(
  requirements: s402PaymentRequirements,
  payload: s402PaymentPayload,
  alg: s402DigestAlg = 'sha256',
): Promise<string> {
  if (alg !== 'sha256') {
    throw new s402Error('S402_UNKNOWN_ALGORITHM',
      `txBinding digest algorithm "${alg}" is not implemented in this build`);
  }
  const prefixBytes = new TextEncoder().encode(TX_BINDING_PREFIX);
  const reqBytes = canonicalize(requirements);
  const payloadBytes = canonicalize(payload);

  const input = new Uint8Array(
    prefixBytes.length + reqBytes.length + 1 + payloadBytes.length,
  );
  let offset = 0;
  input.set(prefixBytes, offset); offset += prefixBytes.length;
  input.set(reqBytes, offset); offset += reqBytes.length;
  input[offset] = RECORD_SEPARATOR; offset += 1;
  input.set(payloadBytes, offset);

  const digestBuffer = await crypto.subtle.digest('SHA-256', input);
  return `sha256-${toBase64UrlNoPad(new Uint8Array(digestBuffer))}`;
}

function toBase64UrlNoPad(bytes: Uint8Array): string {
  // btoa takes a binary string; construct it from the byte values.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ══════════════════════════════════════════════════════════════
// Envelope construction (facilitator/server-side)
// ══════════════════════════════════════════════════════════════

export interface BuildEnvelopeContext {
  s402Version: string;
  scheme: s402Scheme;
  specDigest: string;
  network: string;
  requirements: s402PaymentRequirements;
  payload: s402PaymentPayload;
  algs?: s402Algs;
  facilitatorIds?: string[];
  timestamp?: string;
}

export async function buildSettledEnvelope(
  ctx: BuildEnvelopeContext,
  settled: s402EnvelopeSettled['settled'],
): Promise<s402EnvelopeSettled> {
  const base = await buildBase(ctx);
  return { ...base, status: 'settled', settled };
}

export async function buildVerifiedEnvelope(
  ctx: BuildEnvelopeContext,
): Promise<s402EnvelopeVerified> {
  const base = await buildBase(ctx);
  return { ...base, status: 'verified', verified: {} };
}

export async function buildRejectedEnvelope(
  ctx: BuildEnvelopeContext,
  error: { code: s402ErrorCodeType; message: string },
): Promise<s402EnvelopeRejected> {
  const base = await buildBase(ctx);
  return { ...base, status: 'rejected', rejected: { error } };
}

export async function buildPendingEnvelope(
  ctx: BuildEnvelopeContext,
  pending: s402EnvelopePending['pending'],
): Promise<s402EnvelopePending> {
  const base = await buildBase(ctx);
  return { ...base, status: 'pending', pending };
}

async function buildBase(ctx: BuildEnvelopeContext): Promise<s402EnvelopeBase> {
  const algs: s402Algs = ctx.algs ?? { digest: 'sha256', sig: 'ed25519' };
  const txBinding = await computeTxBinding(ctx.requirements, ctx.payload, algs.digest);
  return {
    s402Version: ctx.s402Version,
    scheme: ctx.scheme,
    specDigest: ctx.specDigest,
    txBinding,
    network: ctx.network,
    algs,
    timestamp: ctx.timestamp ?? new Date().toISOString(),
    facilitatorIds: ctx.facilitatorIds,
  };
}

// ══════════════════════════════════════════════════════════════
// Wire format (encode/decode)
// ══════════════════════════════════════════════════════════════

export function encodeEnvelopeBody(envelope: s402Envelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelopeBody(body: string): s402Envelope {
  if (typeof body !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 envelope body must be a string, got ${typeof body}`);
  }
  if (body.length > MAX_BODY_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 envelope body exceeds maximum size (${body.length} > ${MAX_BODY_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to parse s402 envelope: ${e instanceof Error ? e.message : 'invalid JSON'}`);
  }
  validateEnvelopeShape(parsed);
  return parsed as s402Envelope;
}

const VALID_STATUSES = new Set(['settled', 'verified', 'rejected', 'pending']);
const VALID_DIGEST_ALGS = new Set<s402DigestAlg>(['sha256', 'sha384', 'sha512', 'blake3']);
const VALID_SIG_ALGS = new Set<s402SigAlg>(['ed25519', 'ed25519ph', 'secp256k1', 'ml-dsa-44']);

export function validateEnvelopeShape(v: unknown): asserts v is s402Envelope {
  if (v === null || typeof v !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'envelope must be an object');
  }
  const e = v as Record<string, unknown>;

  requireString(e, 's402Version');
  requireString(e, 'scheme');
  requireString(e, 'specDigest');
  requireString(e, 'txBinding');
  requireString(e, 'network');
  requireString(e, 'timestamp');

  const status = e.status;
  if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
    throw new s402Error('INVALID_PAYLOAD',
      `envelope.status must be one of settled|verified|rejected|pending, got ${String(status)}`);
  }

  const algs = e.algs;
  if (algs === null || typeof algs !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'envelope.algs must be an object');
  }
  const a = algs as Record<string, unknown>;
  if (typeof a.digest !== 'string' || !VALID_DIGEST_ALGS.has(a.digest as s402DigestAlg)) {
    throw new s402Error('S402_UNKNOWN_ALGORITHM',
      `envelope.algs.digest "${String(a.digest)}" is not recognized`);
  }
  if (typeof a.sig !== 'string' || !VALID_SIG_ALGS.has(a.sig as s402SigAlg)) {
    throw new s402Error('S402_UNKNOWN_ALGORITHM',
      `envelope.algs.sig "${String(a.sig)}" is not recognized`);
  }

  if (e.facilitatorIds !== undefined) {
    if (!Array.isArray(e.facilitatorIds)) {
      throw new s402Error('INVALID_PAYLOAD', 'envelope.facilitatorIds must be an array if present');
    }
    for (const id of e.facilitatorIds) {
      if (typeof id !== 'string') {
        throw new s402Error('INVALID_PAYLOAD', 'envelope.facilitatorIds entries must be strings');
      }
    }
  }

  // Discriminator-specific payload presence — shape-only, not deep.
  switch (status) {
    case 'settled':
      if (e.settled === null || typeof e.settled !== 'object') {
        throw new s402Error('INVALID_PAYLOAD', 'envelope.settled must be an object');
      }
      requireString(e.settled as Record<string, unknown>, 'settledAt');
      break;
    case 'verified':
      if (e.verified === null || typeof e.verified !== 'object') {
        throw new s402Error('INVALID_PAYLOAD', 'envelope.verified must be an object');
      }
      break;
    case 'rejected': {
      if (e.rejected === null || typeof e.rejected !== 'object') {
        throw new s402Error('INVALID_PAYLOAD', 'envelope.rejected must be an object');
      }
      const rej = e.rejected as Record<string, unknown>;
      if (rej.error === null || typeof rej.error !== 'object') {
        throw new s402Error('INVALID_PAYLOAD', 'envelope.rejected.error must be an object');
      }
      requireString(rej.error as Record<string, unknown>, 'code');
      requireString(rej.error as Record<string, unknown>, 'message');
      break;
    }
    case 'pending': {
      if (e.pending === null || typeof e.pending !== 'object') {
        throw new s402Error('INVALID_PAYLOAD', 'envelope.pending must be an object');
      }
      requireString(e.pending as Record<string, unknown>, 'reason');
      break;
    }
  }
}

function requireString(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== 'string' || obj[key] === '') {
    throw new s402Error('INVALID_PAYLOAD',
      `envelope field "${key}" must be a non-empty string`);
  }
}

// ══════════════════════════════════════════════════════════════
// Client-side verification (ADR-007 §"Client verification obligations")
// ══════════════════════════════════════════════════════════════

export interface VerifyEnvelopeOptions {
  /** The original request the client sent. `txBinding` is recomputed from these. */
  originalRequest: {
    requirements: s402PaymentRequirements;
    payload: s402PaymentPayload;
  };
  /** Scheme-digest the client pinned or discovered. */
  expectedSpecDigest: string;
  /** Digest algorithms the client accepts. Reject anything outside this set. */
  acceptedDigestAlgs?: s402DigestAlg[];
  /** Signature algorithms the client accepts. Reject anything outside this set. */
  acceptedSigAlgs?: s402SigAlg[];
  /** Max acceptable skew between envelope.timestamp and local clock, in ms. */
  maxTimestampSkewMs?: number;
  /** Override clock for testing. */
  now?: () => number;
}

/**
 * Perform the ADR-007 client-side MUST checks. Throws on any failure.
 *
 * Scheme-match, spec-digest, network, txBinding (constant-time), timestamp,
 * and algorithm acceptance. Resource-binding and unlock-attestation checks
 * live in higher layers (they need request-intent + scheme-specific context).
 */
export async function verifyEnvelope(
  envelope: s402Envelope,
  options: VerifyEnvelopeOptions,
): Promise<void> {
  const {
    originalRequest,
    expectedSpecDigest,
    acceptedDigestAlgs = ['sha256'],
    acceptedSigAlgs = ['ed25519'],
    maxTimestampSkewMs = 5 * 60 * 1000,
    now = Date.now,
  } = options;

  // 1. Scheme match — envelope.scheme must equal BOTH the payload's scheme and
  // the one scheme these requirements offer. (Before wire v2 the requirement
  // carried a list; the 402 envelope's `accepts[]` is where a list lives now.)
  if (envelope.scheme !== originalRequest.payload.scheme) {
    throw new s402Error('INVALID_PAYLOAD',
      `envelope.scheme "${envelope.scheme}" does not match payload scheme "${originalRequest.payload.scheme}"`);
  }
  if (originalRequest.requirements.scheme !== envelope.scheme) {
    throw new s402Error('SCHEME_NOT_SUPPORTED',
      `envelope.scheme "${envelope.scheme}" is not the scheme these requirements offer ` +
      `("${originalRequest.requirements.scheme}")`);
  }
  // 2. Spec-digest match
  if (envelope.specDigest !== expectedSpecDigest) {
    throw new s402Error('DIGEST_MISMATCH',
      `envelope.specDigest does not match expected scheme-digest`);
  }
  // 3. Network match
  if (envelope.network !== originalRequest.requirements.network) {
    throw new s402Error('NETWORK_MISMATCH',
      `envelope.network "${envelope.network}" does not match request network "${originalRequest.requirements.network}"`);
  }
  // 4. Algorithm acceptance
  if (!acceptedDigestAlgs.includes(envelope.algs.digest)) {
    throw new s402Error('S402_UNKNOWN_ALGORITHM',
      `envelope.algs.digest "${envelope.algs.digest}" is not in accepted set`);
  }
  if (!acceptedSigAlgs.includes(envelope.algs.sig)) {
    throw new s402Error('S402_UNKNOWN_ALGORITHM',
      `envelope.algs.sig "${envelope.algs.sig}" is not in accepted set`);
  }
  // 5. Timestamp skew
  const envTs = Date.parse(envelope.timestamp);
  if (!Number.isFinite(envTs)) {
    throw new s402Error('INVALID_PAYLOAD',
      `envelope.timestamp "${envelope.timestamp}" is not a valid ISO-8601 date`);
  }
  if (Math.abs(envTs - now()) > maxTimestampSkewMs) {
    throw new s402Error('INVALID_PAYLOAD',
      `envelope.timestamp skew exceeds ${maxTimestampSkewMs}ms`);
  }
  // 6. txBinding match (constant-time comparison per S14)
  const expectedTxBinding = await computeTxBinding(
    originalRequest.requirements,
    originalRequest.payload,
    envelope.algs.digest,
  );
  if (!constantTimeStringEqual(envelope.txBinding, expectedTxBinding)) {
    throw new s402Error('S402_TX_BINDING_MISMATCH',
      `envelope.txBinding does not match locally recomputed binding`);
  }
}

/**
 * Constant-time string equality — S14 invariant.
 *
 * Compares every character regardless of mismatches, so the time-to-answer
 * does not leak digest prefix information. Lengths are compared first (their
 * difference is not secret — a mismatched length means the response is
 * definitely not ours).
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
