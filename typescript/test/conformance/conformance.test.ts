/**
 * s402 Conformance Test Runner
 *
 * Loads JSON test vector files and validates s402's implementation against them.
 * The vector files are the PRODUCT — this runner just proves s402 passes its own spec.
 *
 * Other implementations (Go, Python, Rust) can use the same JSON vectors
 * to verify conformance without this TypeScript runner.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  encodeRequirementsBody,
  decodeRequirementsBody,
  encodePayloadBody,
  decodePayloadBody,
  encodeSettleBody,
  decodeSettleBody,
} from '../../src/http.js';

import { normalizeRequirements } from '../../src/compat/x402.js';
import { formatReceiptHeader, parseReceiptHeader } from '../../src/receipts.js';
import { s402Error } from '../../src/errors.js';
import { mcpTransport, a2aTransport } from '../../src/transport.js';
import type { PaymentStatus, PaymentTransport } from '../../src/transport.js';

import type {
  s402PaymentRequirements,
  s402PaymentRequired,
  s402PaymentPayload,
  s402SettleResponse,
} from '../../src/types.js';

// ── Helpers ──────────────────────────────────────

const VECTORS_DIR = join(import.meta.dirname, '..', '..', '..', 'spec', 'vectors');

interface TestVector {
  description: string;
  input: Record<string, unknown>;
  expected?: Record<string, unknown>;
  shouldReject: boolean;
  expectedErrorCode?: string;
}

function loadVectors(filename: string): TestVector[] {
  const path = join(VECTORS_DIR, filename);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ── Requirements encode ──────────────────────────

describe('Conformance: requirements-encode', () => {
  const vectors = loadVectors('requirements-encode.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const input = v.input as unknown as s402PaymentRequired;
      const result = encodePaymentRequired(input);
      expect(result).toBe((v.expected as { header: string }).header);
    });
  }
});

// ── Requirements decode ──────────────────────────

describe('Conformance: requirements-decode', () => {
  const vectors = loadVectors('requirements-decode.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
  });

  for (const v of vectors) {
    it(v.description, () => {
      // `now` is present only on vectors decoding a document with no
      // `extensions.s402`, where `expiresAt` is derived rather than read.
      const { header, now } = v.input as { header: string; now?: number };
      const result = decodePaymentRequired(header, now);
      expect(result).toEqual(v.expected);
    });
  }
});

// ── Payload encode ───────────────────────────────

describe('Conformance: payload-encode', () => {
  const vectors = loadVectors('payload-encode.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const input = v.input as unknown as s402PaymentPayload;
      const result = encodePaymentPayload(input);
      expect(result).toBe((v.expected as { header: string }).header);
    });
  }
});

// ── Payload decode ───────────────────────────────

describe('Conformance: payload-decode', () => {
  const vectors = loadVectors('payload-decode.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const header = (v.input as { header: string }).header;
      const result = decodePaymentPayload(header);
      expect(result).toEqual(v.expected);
    });
  }
});

// ── Settle encode ────────────────────────────────

describe('Conformance: settle-encode', () => {
  const vectors = loadVectors('settle-encode.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const input = v.input as unknown as s402SettleResponse;
      const result = encodeSettleResponse(input);
      expect(result).toBe((v.expected as { header: string }).header);
    });
  }
});

// ── Settle decode ────────────────────────────────

describe('Conformance: settle-decode', () => {
  const vectors = loadVectors('settle-decode.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const header = (v.input as { header: string }).header;
      const result = decodeSettleResponse(header);
      expect(result).toEqual(v.expected);
    });
  }
});

// ── Body transport ───────────────────────────────

describe('Conformance: body-transport', () => {
  const vectors = loadVectors('body-transport.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(4);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const { type, value } = v.input as { type: string; value: unknown };
      const expected = v.expected as { body: string; decoded: unknown };

      if (type === 'requirements') {
        const body = encodeRequirementsBody(value as s402PaymentRequired);
        expect(body).toBe(expected.body);
        const decoded = decodeRequirementsBody(body);
        expect(decoded).toEqual(expected.decoded);
      } else if (type === 'payload') {
        const body = encodePayloadBody(value as s402PaymentPayload);
        expect(body).toBe(expected.body);
        const decoded = decodePayloadBody(body);
        expect(decoded).toEqual(expected.decoded);
      } else if (type === 'settle') {
        const body = encodeSettleBody(value as s402SettleResponse);
        expect(body).toBe(expected.body);
        const decoded = decodeSettleBody(body);
        expect(decoded).toEqual(expected.decoded);
      } else {
        expect.fail(`Unknown body transport type: "${type}"`);
      }
    });
  }
});

// ── Compat normalize ─────────────────────────────

describe('Conformance: compat-normalize', () => {
  const vectors = loadVectors('compat-normalize.json');
  // Fixed reference timestamp matching the generator — ensures deterministic expiresAt
  const COMPAT_REFERENCE_NOW = 1700000000000;

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const result = normalizeRequirements(v.input as Record<string, unknown>, COMPAT_REFERENCE_NOW);
      expect(result).toEqual(v.expected);
    });
  }
});

// ── Receipt format ───────────────────────────────

describe('Conformance: receipt-format', () => {
  const vectors = loadVectors('receipt-format.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const input = v.input as {
        signature: number[];
        callNumber: string;
        timestampMs: string;
        responseHash: number[];
      };
      const result = formatReceiptHeader({
        signature: new Uint8Array(input.signature),
        callNumber: BigInt(input.callNumber),
        timestampMs: BigInt(input.timestampMs),
        responseHash: new Uint8Array(input.responseHash),
      });
      expect(result).toBe((v.expected as { header: string }).header);
    });
  }
});

// ── Receipt parse ────────────────────────────────

describe('Conformance: receipt-parse', () => {
  const vectors = loadVectors('receipt-parse.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(4);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const header = (v.input as { header: string }).header;
      const result = parseReceiptHeader(header);
      const expected = v.expected as {
        version: string;
        signature: number[];
        callNumber: string;
        timestampMs: string;
        responseHash: number[];
      };
      expect(result.version).toBe(expected.version);
      expect(Array.from(result.signature)).toEqual(expected.signature);
      expect(result.callNumber.toString()).toBe(expected.callNumber);
      expect(result.timestampMs.toString()).toBe(expected.timestampMs);
      expect(Array.from(result.responseHash)).toEqual(expected.responseHash);
    });
  }
});

// ── Validation rejection ─────────────────────────

describe('Conformance: validation-reject', () => {
  const vectors = loadVectors('validation-reject.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
  });

  for (const v of vectors) {
    it(v.description, () => {
      expect(v.shouldReject).toBe(true);

      const input = v.input as { header: string; decodeAs?: string };

      // Receipt rejection vectors use parseReceiptHeader
      if (v.expectedErrorCode === 'RECEIPT_PARSE_ERROR') {
        expect(() => parseReceiptHeader(input.header)).toThrow();
        return;
      }

      // Payload rejection vectors use decodePaymentPayload
      if (input.decodeAs === 'payload') {
        expect(() => decodePaymentPayload(input.header)).toThrow(s402Error);
        try {
          decodePaymentPayload(input.header);
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
          expect((e as s402Error).code).toBe(v.expectedErrorCode);
        }
        return;
      }

      // Compat rejection vectors use normalizeRequirements
      if (input.decodeAs === 'compat') {
        expect(() => normalizeRequirements(JSON.parse(input.header))).toThrow(s402Error);
        try {
          normalizeRequirements(JSON.parse(input.header));
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
          expect((e as s402Error).code).toBe(v.expectedErrorCode);
        }
        return;
      }

      // All other rejection vectors use decodePaymentRequired.
      // Use expect().toThrow() to avoid the try/catch antipattern where
      // expect.fail()'s AssertionError gets caught by the outer catch.
      expect(() => decodePaymentRequired(input.header)).toThrow(s402Error);

      // Also verify the specific error code
      try {
        decodePaymentRequired(input.header);
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        expect((e as s402Error).code).toBe(v.expectedErrorCode);
      }
    });
  }
});

// ── Roundtrip ────────────────────────────────────

describe('Conformance: roundtrip', () => {
  const vectors = loadVectors('roundtrip.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const input = v.input as { type: string; transport: string; value: unknown };
      const expected = v.expected as {
        firstEncode: string;
        reEncode: string;
        identical: boolean;
      };

      // Cross-language conformance: verify stored values match
      expect(expected.identical).toBe(true);
      expect(expected.firstEncode).toBe(expected.reEncode);

      // TypeScript runner: actually execute encode → decode → re-encode
      if (input.type === 'requirements' && input.transport === 'header') {
        const encoded = encodePaymentRequired(input.value as s402PaymentRequired);
        const decoded = decodePaymentRequired(encoded);
        const reEncoded = encodePaymentRequired(decoded);
        expect(encoded).toBe(expected.firstEncode);
        expect(reEncoded).toBe(encoded);
      } else if (input.type === 'requirements' && input.transport === 'body') {
        const encoded = encodeRequirementsBody(input.value as s402PaymentRequired);
        const decoded = decodeRequirementsBody(encoded);
        const reEncoded = encodeRequirementsBody(decoded);
        expect(encoded).toBe(expected.firstEncode);
        expect(reEncoded).toBe(encoded);
      } else if (input.type === 'payload' && input.transport === 'header') {
        const encoded = encodePaymentPayload(input.value as s402PaymentPayload);
        const decoded = decodePaymentPayload(encoded);
        const reEncoded = encodePaymentPayload(decoded);
        expect(encoded).toBe(expected.firstEncode);
        expect(reEncoded).toBe(encoded);
      } else if (input.type === 'payload' && input.transport === 'body') {
        const encoded = encodePayloadBody(input.value as s402PaymentPayload);
        const decoded = decodePayloadBody(encoded);
        const reEncoded = encodePayloadBody(decoded);
        expect(encoded).toBe(expected.firstEncode);
        expect(reEncoded).toBe(encoded);
      } else if (input.type === 'settle' && input.transport === 'header') {
        const encoded = encodeSettleResponse(input.value as s402SettleResponse);
        const decoded = decodeSettleResponse(encoded);
        const reEncoded = encodeSettleResponse(decoded);
        expect(encoded).toBe(expected.firstEncode);
        expect(reEncoded).toBe(encoded);
      } else if (input.type === 'settle' && input.transport === 'body') {
        const encoded = encodeSettleBody(input.value as s402SettleResponse);
        const decoded = decodeSettleBody(encoded);
        const reEncoded = encodeSettleBody(decoded);
        expect(encoded).toBe(expected.firstEncode);
        expect(reEncoded).toBe(encoded);
      } else {
        expect.fail(`Unknown roundtrip type/transport: "${input.type}/${input.transport}"`);
      }
    });
  }
});

// ── Transport carriers (MCP + A2A) ───────────────
// Cross-language contract for the non-HTTP carriers (ADR-011). HTTP is covered
// by the header/body vectors above. The Python runner does not load this file
// (no MCP/A2A codec yet) — the contract exists for when other languages add them.

describe('Conformance: transport-carriers', () => {
  const vectors = loadVectors('transport-carriers.json');

  it(`loaded ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
  });

  for (const v of vectors) {
    it(v.description, () => {
      const input = v.input as {
        type: 'requirements' | 'payload' | 'settle';
        carrier: 'mcp' | 'a2a';
        value: Record<string, unknown>;
        correlationId?: string;
      };
      const expected = v.expected as {
        encoded: Record<string, unknown>;
        status: PaymentStatus;
        correlationId?: string;
      };
      const transport: PaymentTransport<Record<string, unknown>> =
        input.carrier === 'mcp' ? mcpTransport : a2aTransport;
      const ctx = input.correlationId ? { correlationId: input.correlationId } : undefined;

      let frame: Record<string, unknown>;
      let decoded;
      if (input.type === 'requirements') {
        frame = transport.encodeRequirements(input.value as unknown as s402PaymentRequired, ctx);
        decoded = transport.decodeRequirements(frame);
      } else if (input.type === 'payload') {
        frame = transport.encodePayload(input.value as unknown as s402PaymentPayload, ctx);
        decoded = transport.decodePayload(frame);
      } else {
        frame = transport.encodeSettlement(input.value as unknown as s402SettleResponse, ctx);
        decoded = transport.decodeSettlement(frame);
      }

      // Encode matches the committed wire contract; decode round-trips value + carrier context.
      expect(frame).toEqual(expected.encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.value).toEqual(input.value);
      expect(decoded!.ctx.status).toBe(expected.status);
      expect(decoded!.ctx.correlationId).toBe(expected.correlationId);
    });
  }
});

// ── Meta: vector file completeness ───────────────

describe('Conformance: meta', () => {
  it('all expected vector files exist', () => {
    const expectedFiles = [
      'requirements-encode.json',
      'requirements-decode.json',
      'payload-encode.json',
      'payload-decode.json',
      'settle-encode.json',
      'settle-decode.json',
      'body-transport.json',
      'compat-normalize.json',
      'receipt-format.json',
      'receipt-parse.json',
      'validation-reject.json',
      'roundtrip.json',
      'transport-carriers.json',
    ];
    const actual = readdirSync(VECTORS_DIR).filter(f => f.endsWith('.json'));
    for (const file of expectedFiles) {
      expect(actual).toContain(file);
    }
  });

  it('total vectors meet minimum threshold (64)', () => {
    const files = readdirSync(VECTORS_DIR).filter(f => f.endsWith('.json'));
    let total = 0;
    for (const file of files) {
      const vectors = JSON.parse(readFileSync(join(VECTORS_DIR, file), 'utf-8'));
      total += vectors.length;
    }
    expect(total).toBeGreaterThanOrEqual(64);
  });
});
