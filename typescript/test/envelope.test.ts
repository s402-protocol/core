/**
 * Tests for the s402 Settlement Envelope (ADR-007).
 *
 * Covers: envelope construction, wire encode/decode, shape validation,
 * txBinding canonicalization+determinism, client-side verification path.
 */

import { describe, it, expect } from 'vitest';
import {
  S402_ENVELOPE_CONTENT_TYPE,
  S402_VERSION,
  buildSettledEnvelope,
  buildVerifiedEnvelope,
  buildRejectedEnvelope,
  buildPendingEnvelope,
  computeTxBinding,
  encodeEnvelopeBody,
  decodeEnvelopeBody,
  validateEnvelopeShape,
  verifyEnvelope,
  constantTimeStringEqual,
  canonicalize,
  canonicalizeToString,
  type s402Envelope,
  type s402EnvelopeSettled,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type BuildEnvelopeContext,
} from '../src/index.js';

const REQUIREMENTS: s402PaymentRequirements = {
  s402Version: S402_VERSION,
  accepts: ['exact'],
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: '0xabc',
};

const PAYLOAD: s402ExactPayload = {
  s402Version: S402_VERSION,
  scheme: 'exact',
  payload: {
    transaction: 'dHhieXRlcw==',
    signature: 'c2lnbmF0dXJl',
  },
};

const CTX: BuildEnvelopeContext = {
  s402Version: S402_VERSION,
  scheme: 'exact',
  specDigest: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  network: 'sui:testnet',
  requirements: REQUIREMENTS,
  payload: PAYLOAD,
};

// ══════════════════════════════════════════════════════════════
// Media type
// ══════════════════════════════════════════════════════════════

describe('envelope: media type', () => {
  it('exports the vendor-tree media type per ADR-007', () => {
    expect(S402_ENVELOPE_CONTENT_TYPE).toBe('application/vnd.s402.envelope+json');
  });
});

// ══════════════════════════════════════════════════════════════
// Canonicalization
// ══════════════════════════════════════════════════════════════

describe('canonicalize: RFC 8785 JCS serialization', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalizeToString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalizeToString([3, 1, 2])).toBe('[3,1,2]');
  });

  it('skips undefined object members', () => {
    expect(canonicalizeToString({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('produces identical bytes for same value with different key order', () => {
    const a = canonicalize({ b: 1, a: 2, c: [1, 2, 3] });
    const b = canonicalize({ c: [1, 2, 3], a: 2, b: 1 });
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize(NaN)).toThrow(/non-finite/);
    expect(() => canonicalize(Infinity)).toThrow(/non-finite/);
  });

  it('rejects bigint', () => {
    expect(() => canonicalize(1n)).toThrow(/bigint/);
  });

  it('rejects cyclic values', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => canonicalize(o)).toThrow(/cyclic/);
  });

  it('escapes control characters correctly', () => {
    expect(canonicalizeToString('a\nb')).toBe('"a\\nb"');
    expect(canonicalizeToString('\u0001')).toBe('"\\u0001"');
  });

  it('renders zero as "0" (signed-zero normalization)', () => {
    expect(canonicalizeToString(-0)).toBe('0');
    expect(canonicalizeToString(0)).toBe('0');
  });
});

// ══════════════════════════════════════════════════════════════
// txBinding
// ══════════════════════════════════════════════════════════════

describe('computeTxBinding: domain-separated request→response binding', () => {
  it('produces SRI-style "sha256-<base64url-no-pad>" format', async () => {
    const binding = await computeTxBinding(REQUIREMENTS, PAYLOAD);
    expect(binding).toMatch(/^sha256-[A-Za-z0-9_-]+$/);
    expect(binding).not.toMatch(/=/);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await computeTxBinding(REQUIREMENTS, PAYLOAD);
    const b = await computeTxBinding(REQUIREMENTS, PAYLOAD);
    expect(a).toBe(b);
  });

  it('ignores key order in the inputs (JCS canonicalization)', async () => {
    const a = await computeTxBinding(REQUIREMENTS, PAYLOAD);
    const reorderedReqs = {
      payTo: REQUIREMENTS.payTo,
      amount: REQUIREMENTS.amount,
      asset: REQUIREMENTS.asset,
      network: REQUIREMENTS.network,
      accepts: REQUIREMENTS.accepts,
      s402Version: REQUIREMENTS.s402Version,
    } as s402PaymentRequirements;
    const b = await computeTxBinding(reorderedReqs, PAYLOAD);
    expect(a).toBe(b);
  });

  it('changes when requirements change', async () => {
    const a = await computeTxBinding(REQUIREMENTS, PAYLOAD);
    const b = await computeTxBinding({ ...REQUIREMENTS, amount: '2000000000' }, PAYLOAD);
    expect(a).not.toBe(b);
  });

  it('changes when payload changes', async () => {
    const a = await computeTxBinding(REQUIREMENTS, PAYLOAD);
    const b = await computeTxBinding(REQUIREMENTS, {
      ...PAYLOAD,
      payload: { ...PAYLOAD.payload, signature: 'ZGlmZmVyZW50' },
    });
    expect(a).not.toBe(b);
  });

  it('rejects unimplemented algorithms', async () => {
    await expect(
      computeTxBinding(REQUIREMENTS, PAYLOAD, 'blake3'),
    ).rejects.toThrow(/not implemented/);
  });
});

// ══════════════════════════════════════════════════════════════
// Envelope builders
// ══════════════════════════════════════════════════════════════

describe('build*Envelope: facilitator-side construction', () => {
  it('buildSettledEnvelope produces a valid settled envelope', async () => {
    const env = await buildSettledEnvelope(CTX, {
      settlement: { txDigest: 'ABC' },
      settledAt: '2026-04-19T00:00:00.000Z',
    });
    expect(env.status).toBe('settled');
    expect(env.scheme).toBe('exact');
    expect(env.network).toBe('sui:testnet');
    expect(env.algs.digest).toBe('sha256');
    expect(env.algs.sig).toBe('ed25519');
    expect(env.txBinding).toMatch(/^sha256-/);
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('buildVerifiedEnvelope produces a verified envelope', async () => {
    const env = await buildVerifiedEnvelope(CTX);
    expect(env.status).toBe('verified');
    expect(env.verified).toEqual({});
  });

  it('buildRejectedEnvelope carries a typed error', async () => {
    const env = await buildRejectedEnvelope(CTX, {
      code: 'INSUFFICIENT_BALANCE',
      message: 'Not enough coins',
    });
    expect(env.status).toBe('rejected');
    expect(env.rejected.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('buildPendingEnvelope carries a retryAfter hint', async () => {
    const env = await buildPendingEnvelope(CTX, { retryAfter: 3000, reason: 'RPC lag' });
    expect(env.status).toBe('pending');
    expect(env.pending.retryAfter).toBe(3000);
  });

  it('accepts a caller-supplied timestamp (useful for tests and reproducibility)', async () => {
    const env = await buildVerifiedEnvelope({
      ...CTX,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(env.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('propagates facilitatorIds when provided', async () => {
    const env = await buildVerifiedEnvelope({
      ...CTX,
      facilitatorIds: ['ed25519-ABC'],
    });
    expect(env.facilitatorIds).toEqual(['ed25519-ABC']);
  });
});

// ══════════════════════════════════════════════════════════════
// Wire encode/decode
// ══════════════════════════════════════════════════════════════

describe('encodeEnvelopeBody / decodeEnvelopeBody', () => {
  it('round-trips a settled envelope', async () => {
    const env = await buildSettledEnvelope(CTX, {
      settlement: { txDigest: 'X' },
      settledAt: '2026-04-19T00:00:00.000Z',
    });
    const wire = encodeEnvelopeBody(env);
    const decoded = decodeEnvelopeBody(wire) as s402EnvelopeSettled;
    expect(decoded).toEqual(env);
  });

  it('rejects non-string input', () => {
    expect(() => decodeEnvelopeBody(42 as unknown as string)).toThrow(/must be a string/);
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeEnvelopeBody('not json')).toThrow(/parse/);
  });

  it('rejects oversized body (> 1 MB)', () => {
    const huge = 'A'.repeat(1024 * 1024 + 1);
    expect(() => decodeEnvelopeBody(huge)).toThrow(/exceeds maximum size/);
  });
});

// ══════════════════════════════════════════════════════════════
// Shape validation (discriminator-aware)
// ══════════════════════════════════════════════════════════════

describe('validateEnvelopeShape', () => {
  it('rejects missing status', () => {
    expect(() => validateEnvelopeShape({ s402Version: '1', scheme: 'exact' }))
      .toThrow();
  });

  it('rejects unknown status', () => {
    expect(() => validateEnvelopeShape({
      s402Version: '1',
      scheme: 'exact',
      specDigest: 'sha256-X',
      txBinding: 'sha256-Y',
      network: 'sui:testnet',
      timestamp: '2026-01-01T00:00:00.000Z',
      algs: { digest: 'sha256', sig: 'ed25519' },
      status: 'bogus',
    })).toThrow(/status/);
  });

  it('rejects unknown digest algorithm with S402_UNKNOWN_ALGORITHM', () => {
    try {
      validateEnvelopeShape({
        s402Version: '1',
        scheme: 'exact',
        specDigest: 'sha256-X',
        txBinding: 'sha256-Y',
        network: 'sui:testnet',
        timestamp: '2026-01-01T00:00:00.000Z',
        algs: { digest: 'md5', sig: 'ed25519' },
        status: 'verified',
        verified: {},
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as { code: string }).code).toBe('S402_UNKNOWN_ALGORITHM');
    }
  });

  it('accepts a well-formed verified envelope', () => {
    expect(() => validateEnvelopeShape({
      s402Version: '1',
      scheme: 'exact',
      specDigest: 'sha256-X',
      txBinding: 'sha256-Y',
      network: 'sui:testnet',
      timestamp: '2026-01-01T00:00:00.000Z',
      algs: { digest: 'sha256', sig: 'ed25519' },
      status: 'verified',
      verified: {},
    })).not.toThrow();
  });

  it('requires settled.settledAt on settled envelopes', () => {
    expect(() => validateEnvelopeShape({
      s402Version: '1',
      scheme: 'exact',
      specDigest: 'sha256-X',
      txBinding: 'sha256-Y',
      network: 'sui:testnet',
      timestamp: '2026-01-01T00:00:00.000Z',
      algs: { digest: 'sha256', sig: 'ed25519' },
      status: 'settled',
      settled: { settlement: {} },
    })).toThrow(/settledAt/);
  });
});

// ══════════════════════════════════════════════════════════════
// Client-side verification (ADR-007 MUST checks)
// ══════════════════════════════════════════════════════════════

describe('verifyEnvelope: client-side MUST checks', () => {
  async function goodEnvelope(): Promise<s402Envelope> {
    return buildSettledEnvelope(CTX, {
      settlement: { txDigest: 'X' },
      settledAt: new Date().toISOString(),
    });
  }

  it('passes when all checks succeed', async () => {
    const env = await goodEnvelope();
    await expect(verifyEnvelope(env, {
      originalRequest: { requirements: REQUIREMENTS, payload: PAYLOAD },
      expectedSpecDigest: CTX.specDigest,
    })).resolves.toBeUndefined();
  });

  it('rejects scheme mismatch', async () => {
    const env = await goodEnvelope();
    await expect(verifyEnvelope(env, {
      originalRequest: {
        requirements: REQUIREMENTS,
        payload: { ...PAYLOAD, scheme: 'prepaid' } as unknown as typeof PAYLOAD,
      },
      expectedSpecDigest: CTX.specDigest,
    })).rejects.toThrow(/scheme/);
  });

  it('rejects specDigest mismatch with DIGEST_MISMATCH', async () => {
    const env = await goodEnvelope();
    try {
      await verifyEnvelope(env, {
        originalRequest: { requirements: REQUIREMENTS, payload: PAYLOAD },
        expectedSpecDigest: 'sha256-DIFFERENT',
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as { code: string }).code).toBe('DIGEST_MISMATCH');
    }
  });

  it('rejects network mismatch', async () => {
    const env = await goodEnvelope();
    await expect(verifyEnvelope(env, {
      originalRequest: {
        requirements: { ...REQUIREMENTS, network: 'sui:mainnet' },
        payload: PAYLOAD,
      },
      expectedSpecDigest: CTX.specDigest,
    })).rejects.toThrow(/network/i);
  });

  it('rejects txBinding mismatch with S402_TX_BINDING_MISMATCH', async () => {
    const env = await goodEnvelope();
    try {
      await verifyEnvelope(env, {
        originalRequest: {
          // Different requirements.amount → different binding
          requirements: { ...REQUIREMENTS, amount: '999' },
          payload: PAYLOAD,
        },
        expectedSpecDigest: CTX.specDigest,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as { code: string }).code).toBe('S402_TX_BINDING_MISMATCH');
    }
  });

  it('rejects algorithm not in accepted set', async () => {
    const env = await goodEnvelope();
    try {
      await verifyEnvelope(env, {
        originalRequest: { requirements: REQUIREMENTS, payload: PAYLOAD },
        expectedSpecDigest: CTX.specDigest,
        acceptedSigAlgs: ['secp256k1'], // envelope uses ed25519
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as { code: string }).code).toBe('S402_UNKNOWN_ALGORITHM');
    }
  });

  it('rejects timestamp skew beyond tolerance', async () => {
    const env = await buildSettledEnvelope(
      { ...CTX, timestamp: '2020-01-01T00:00:00.000Z' },
      { settlement: {}, settledAt: '2020-01-01T00:00:00.000Z' },
    );
    await expect(verifyEnvelope(env, {
      originalRequest: { requirements: REQUIREMENTS, payload: PAYLOAD },
      expectedSpecDigest: CTX.specDigest,
    })).rejects.toThrow(/skew/);
  });
});

// ══════════════════════════════════════════════════════════════
// Constant-time compare
// ══════════════════════════════════════════════════════════════

describe('constantTimeStringEqual (S14)', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeStringEqual('sha256-ABC', 'sha256-ABC')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(constantTimeStringEqual('sha256-ABC', 'sha256-XYZ')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(constantTimeStringEqual('sha256-ABC', 'sha256-ABCD')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(constantTimeStringEqual('', '')).toBe(true);
  });
});
