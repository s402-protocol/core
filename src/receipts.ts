/**
 * s402 Receipt HTTP Helpers — chain-agnostic receipt header format/parse.
 *
 * Providers sign each API response with Ed25519. The signature, call number,
 * timestamp, and response hash are transported as a single HTTP header:
 *
 *   X-S402-Receipt: v2:base64(signature):callNumber:timestampMs:base64(responseHash)
 *
 * This module handles the header wire format ONLY. It does not:
 * - Construct BCS messages (chain-specific — see @sweefi/sui receipts.ts)
 * - Generate Ed25519 keys (implementations provide their own)
 * - Accumulate receipts (client-side concern — see @sweefi/sui ReceiptAccumulator)
 *
 * Zero runtime dependencies. Uses built-in btoa/atob.
 *
 * @see docs/schemes/prepaid.md — v0.2 spec
 */

// ── Types ────────────────────────────────────────────

/** Receipt data extracted from an HTTP header. */
export interface s402Receipt {
  /** Header version — always 'v2' for signed receipts. */
  version: 'v2';
  /** 64-byte Ed25519 signature over the BCS-encoded receipt message. */
  signature: Uint8Array;
  /** Sequential call number (1-indexed). */
  callNumber: bigint;
  /** Unix timestamp in milliseconds when the response was generated. */
  timestampMs: bigint;
  /** Hash of the response body (typically SHA-256, 32 bytes). */
  responseHash: Uint8Array;
}

/** Signing function — implementations inject their own Ed25519 signer. */
export type s402ReceiptSigner = (message: Uint8Array) => Promise<Uint8Array>;

/** Verification function — implementations inject their own Ed25519 verifier. */
export type s402ReceiptVerifier = (message: Uint8Array, signature: Uint8Array) => Promise<boolean>;

// ── Constants ────────────────────────────────────────

/** HTTP header name for s402 signed usage receipts. */
export const S402_RECEIPT_HEADER = 'X-S402-Receipt';

const HEADER_VERSION = 'v2';

// ── Base64 helpers (binary ↔ base64, no npm deps) ───

/** Encode a Uint8Array to base64 using built-in btoa. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a base64 string to Uint8Array using built-in atob. Throws Error on invalid base64. */
function base64ToUint8(b64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new Error(`Invalid base64: "${b64.slice(0, 20)}${b64.length > 20 ? '...' : ''}"`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Public API ───────────────────────────────────────

/**
 * Encode receipt fields into the `X-S402-Receipt` HTTP header value.
 *
 * Format: `v2:base64(signature):callNumber:timestampMs:base64(responseHash)`
 *
 * @param receipt - Receipt fields to encode
 * @returns Header string ready for HTTP response
 */
export function formatReceiptHeader(receipt: {
  signature: Uint8Array;
  callNumber: bigint;
  timestampMs: bigint;
  responseHash: Uint8Array;
}): string {
  return [
    HEADER_VERSION,
    uint8ToBase64(receipt.signature),
    receipt.callNumber.toString(),
    receipt.timestampMs.toString(),
    uint8ToBase64(receipt.responseHash),
  ].join(':');
}

/**
 * Decode an `X-S402-Receipt` header value back into typed fields.
 *
 * @param header - Raw header value string
 * @returns Parsed receipt with typed fields
 * @throws On empty string, wrong number of parts, or unknown version
 */
export function parseReceiptHeader(header: string): s402Receipt {
  if (!header) {
    throw new Error('Empty receipt header');
  }

  const parts = header.split(':');
  if (parts.length !== 5) {
    throw new Error(
      `Malformed receipt header: expected 5 colon-separated parts, got ${parts.length}`,
    );
  }

  const [version, sigB64, callNumberStr, timestampMsStr, hashB64] = parts;

  if (version !== HEADER_VERSION) {
    throw new Error(
      `Unknown receipt header version: "${version}" (expected "${HEADER_VERSION}")`,
    );
  }

  let callNumber: bigint;
  let timestampMs: bigint;
  try {
    callNumber = BigInt(callNumberStr);
  } catch {
    throw new Error(`Invalid receipt callNumber: not a valid integer "${callNumberStr}"`);
  }
  try {
    timestampMs = BigInt(timestampMsStr);
  } catch {
    throw new Error(`Invalid receipt timestampMs: not a valid integer "${timestampMsStr}"`);
  }
  if (callNumber <= 0n) {
    throw new Error(`Invalid receipt callNumber: must be positive, got ${callNumber}`);
  }
  if (timestampMs <= 0n) {
    throw new Error(`Invalid receipt timestampMs: must be positive, got ${timestampMs}`);
  }

  return {
    version: 'v2',
    signature: base64ToUint8(sigB64),
    callNumber,
    timestampMs,
    responseHash: base64ToUint8(hashB64),
  };
}
