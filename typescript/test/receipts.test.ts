import { describe, it, expect } from 'vitest';
import {
  formatReceiptHeader,
  parseReceiptHeader,
  S402_RECEIPT_HEADER,
} from '../src/index.js';

// ── Test fixtures ────────────────────────────────────

/** 64-byte Ed25519 signature (deterministic test data) */
const SAMPLE_SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SAMPLE_SIGNATURE[i] = i;

/** 32-byte SHA-256 hash */
const SAMPLE_HASH = new Uint8Array(32);
for (let i = 0; i < 32; i++) SAMPLE_HASH[i] = 0xff - i;

const SAMPLE_RECEIPT = {
  signature: SAMPLE_SIGNATURE,
  callNumber: 42n,
  timestampMs: 1709251200000n, // 2024-03-01T00:00:00.000Z
  responseHash: SAMPLE_HASH,
};

// ── Tests ────────────────────────────────────────────

describe('S402_RECEIPT_HEADER', () => {
  it('is X-S402-Receipt', () => {
    expect(S402_RECEIPT_HEADER).toBe('X-S402-Receipt');
  });
});

describe('formatReceiptHeader', () => {
  it('produces a v2: prefixed string with 5 colon-separated parts', () => {
    const header = formatReceiptHeader(SAMPLE_RECEIPT);
    expect(header.startsWith('v2:')).toBe(true);
    expect(header.split(':').length).toBe(5);
  });

  it('encodes callNumber and timestampMs as plain decimal strings', () => {
    const header = formatReceiptHeader(SAMPLE_RECEIPT);
    const parts = header.split(':');
    expect(parts[2]).toBe('42');
    expect(parts[3]).toBe('1709251200000');
  });
});

describe('parseReceiptHeader', () => {
  it('round-trips correctly with formatReceiptHeader', () => {
    const header = formatReceiptHeader(SAMPLE_RECEIPT);
    const parsed = parseReceiptHeader(header);

    expect(parsed.version).toBe('v2');
    expect(parsed.callNumber).toBe(42n);
    expect(parsed.timestampMs).toBe(1709251200000n);
    expect(parsed.signature).toEqual(SAMPLE_SIGNATURE);
    expect(parsed.responseHash).toEqual(SAMPLE_HASH);
  });

  it('throws on empty string', () => {
    expect(() => parseReceiptHeader('')).toThrow('Empty receipt header');
  });

  it('throws on wrong number of parts', () => {
    expect(() => parseReceiptHeader('v2:only:three')).toThrow(
      'expected 5 colon-separated parts, got 3',
    );
    expect(() => parseReceiptHeader('v2:a:b:c:d:e')).toThrow(
      'expected 5 colon-separated parts, got 6',
    );
  });

  it('throws on unknown version prefix', () => {
    const header = formatReceiptHeader(SAMPLE_RECEIPT);
    const tampered = 'v99' + header.slice(2);
    expect(() => parseReceiptHeader(tampered)).toThrow('Unknown receipt header version: "v99"');
  });

  it('correctly decodes base64 signature and responseHash', () => {
    const header = formatReceiptHeader(SAMPLE_RECEIPT);
    const parsed = parseReceiptHeader(header);

    // Verify byte-for-byte equality
    expect(parsed.signature.length).toBe(64);
    expect(parsed.responseHash.length).toBe(32);
    for (let i = 0; i < 64; i++) {
      expect(parsed.signature[i]).toBe(i);
    }
    for (let i = 0; i < 32; i++) {
      expect(parsed.responseHash[i]).toBe(0xff - i);
    }
  });

  it('handles large callNumber and timestampMs as bigint', () => {
    const largeReceipt = {
      ...SAMPLE_RECEIPT,
      callNumber: 2n ** 53n + 1n, // Beyond Number.MAX_SAFE_INTEGER
      timestampMs: 2n ** 62n,
    };
    const header = formatReceiptHeader(largeReceipt);
    const parsed = parseReceiptHeader(header);

    expect(parsed.callNumber).toBe(2n ** 53n + 1n);
    expect(parsed.timestampMs).toBe(2n ** 62n);
    // Prove bigint preserves precision that Number cannot
    // Number(2^53 + 1) === Number(2^53) due to float64 precision loss
    expect(Number(2n ** 53n + 1n)).toBe(Number(2n ** 53n)); // Numbers lose precision here
    expect(parsed.callNumber).not.toBe(2n ** 53n);          // But bigint preserves it
  });

  it('header size fits within HTTP header limits (8KB)', () => {
    // Worst case: max u64 callNumber + timestampMs, 64-byte sig, 32-byte hash
    const maxReceipt = {
      signature: new Uint8Array(64).fill(0xff),
      callNumber: 2n ** 64n - 1n, // max u64: 18446744073709551615
      timestampMs: 2n ** 64n - 1n,
      responseHash: new Uint8Array(32).fill(0xff),
    };
    const header = formatReceiptHeader(maxReceipt);
    const fullHeader = `${S402_RECEIPT_HEADER}: ${header}`;

    // v2 (2) + base64(64 bytes) (88) + 20 digit u64 + 20 digit u64 + base64(32 bytes) (44) + colons (4) + header name (15) + ": " (2) ≈ 195 bytes
    expect(fullHeader.length).toBeLessThan(8192);
    // Sanity: should be well under 300 bytes even at maximum
    expect(fullHeader.length).toBeLessThan(300);
  });
});
