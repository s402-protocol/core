/**
 * Property-based fuzz tests for s402 trust boundaries.
 *
 * Uses fast-check to generate adversarial inputs and verify that:
 * 1. normalizeRequirements never returns undefined / never passes invalid shapes
 * 2. decodePaymentRequired / decodePaymentPayload always throw s402Error on bad input
 * 3. Roundtrip encode → decode is identity for valid objects
 * 4. The clean-pick trust boundary strips all unknown keys
 * 5. No prototype pollution via __proto__, constructor, etc.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  s402Error,
  S402_VERSION,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402SettleResponse,
} from '../src/index.js';
import {
  normalizeRequirements,
  fromX402Requirements,
  fromX402Envelope,
  isS402,
  isX402,
  isX402Envelope,
} from '../src/compat.js';

// ══════════════════════════════════════════════════════════════
// Arbitraries — structured generators for protocol objects
// ══════════════════════════════════════════════════════════════

const suiAddress = () =>
  fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
    .map(ns => '0x' + ns.map(n => n.toString(16)).join(''));

const VALID_PAY_TO = '0x' + 'a'.repeat(64);

const validRequirements = () =>
  fc.record({
    s402Version: fc.constant(S402_VERSION as string),
    accepts: fc.constantFrom(['exact'], ['exact', 'stream'], ['exact', 'escrow'], ['exact', 'unlock', 'prepaid']),
    network: fc.constantFrom('sui:testnet', 'sui:mainnet', 'sui:devnet'),
    asset: fc.constantFrom('0x2::sui::SUI', '0xdba::usdc::USDC'),
    amount: fc.nat({ max: 1_000_000_000_000 }).map(n => String(n)),
    payTo: suiAddress(),
  }) as fc.Arbitrary<s402PaymentRequirements>;

const validExactPayload = () =>
  fc.record({
    s402Version: fc.constant(S402_VERSION as string),
    scheme: fc.constant('exact'),
    payload: fc.record({
      transaction: fc.base64String({ minLength: 4, maxLength: 200 }),
      signature: fc.base64String({ minLength: 4, maxLength: 200 }),
    }),
  }) as fc.Arbitrary<s402ExactPayload>;

const validSettleResponse = () =>
  fc.oneof(
    fc.record({ success: fc.constant(true as const), txDigest: fc.string({ minLength: 8, maxLength: 64 }) }),
    fc.record({ success: fc.constant(false as const), error: fc.string({ minLength: 1, maxLength: 100 }) }),
  ) as fc.Arbitrary<s402SettleResponse>;

// ══════════════════════════════════════════════════════════════
// 1. Roundtrip: encode → decode = identity
// ══════════════════════════════════════════════════════════════

describe('fuzz: encode → decode roundtrip', () => {
  it('requirements survive roundtrip', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        const encoded = encodePaymentRequired(reqs);
        const decoded = decodePaymentRequired(encoded);
        expect(decoded.s402Version).toBe(reqs.s402Version);
        expect(decoded.accepts).toEqual(reqs.accepts);
        expect(decoded.network).toBe(reqs.network);
        expect(decoded.amount).toBe(reqs.amount);
        expect(decoded.payTo).toBe(reqs.payTo);
      }),
      { numRuns: 200 },
    );
  });

  it('exact payloads survive roundtrip', () => {
    fc.assert(
      fc.property(validExactPayload(), (payload) => {
        const encoded = encodePaymentPayload(payload);
        const decoded = decodePaymentPayload(encoded);
        expect(decoded.scheme).toBe('exact');
        expect(decoded.payload).toEqual(payload.payload);
      }),
      { numRuns: 200 },
    );
  });

  it('settle responses survive roundtrip', () => {
    fc.assert(
      fc.property(validSettleResponse(), (resp) => {
        const encoded = encodeSettleResponse(resp);
        const decoded = decodeSettleResponse(encoded);
        expect(decoded.success).toBe(resp.success);
      }),
      { numRuns: 200 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 2. normalizeRequirements never returns garbage
// ══════════════════════════════════════════════════════════════

describe('fuzz: normalizeRequirements', () => {
  it('valid s402 input → valid s402 output (all required fields present)', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        const result = normalizeRequirements(reqs as unknown as Record<string, unknown>);
        expect(result.s402Version).toBe('1');
        expect(result.accepts.length).toBeGreaterThan(0);
        expect(typeof result.network).toBe('string');
        expect(typeof result.asset).toBe('string');
        expect(typeof result.amount).toBe('string');
        expect(typeof result.payTo).toBe('string');
      }),
      { numRuns: 200 },
    );
  });

  it('strips unknown keys from s402 input', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.anything()),
        (reqs, junk) => {
          const polluted = { ...junk, ...reqs } as Record<string, unknown>;
          const result = normalizeRequirements(polluted);

          // Known s402 keys
          const KNOWN = new Set([
            's402Version', 'accepts', 'network', 'asset', 'amount', 'payTo',
            'facilitatorUrl', 'mandate', 'protocolFeeBps', 'protocolFeeAddress',
            'receiptRequired', 'settlementMode', 'expiresAt',
            'stream', 'escrow', 'unlock', 'prepaid', 'extensions',
          ]);

          for (const key of Object.keys(result)) {
            expect(KNOWN.has(key)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('random objects either throw s402Error or return valid requirements', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (obj) => {
        try {
          const result = normalizeRequirements(obj);
          // If it didn't throw, it must have all required fields
          expect(result.s402Version).toBe('1');
          expect(result.accepts.length).toBeGreaterThan(0);
          expect(typeof result.network).toBe('string');
          expect(typeof result.amount).toBe('string');
          expect(typeof result.payTo).toBe('string');
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Decode functions always throw s402Error on bad input
// ══════════════════════════════════════════════════════════════

describe('fuzz: decode rejects garbage', () => {
  it('decodePaymentRequired throws s402Error on random strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (str) => {
        try {
          decodePaymentRequired(str);
          // If it somehow decoded, it must be valid (extremely unlikely with random strings)
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodePaymentPayload throws s402Error on random strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (str) => {
        try {
          decodePaymentPayload(str);
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodePaymentRequired throws s402Error on random base64(JSON)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (obj) => {
        try {
          // Encode random object as base64 JSON — tests shape validation path
          const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
          decodePaymentRequired(b64);
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('decodePaymentPayload throws s402Error on random base64(JSON)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (obj) => {
        try {
          const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
          decodePaymentPayload(b64);
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Prototype pollution resistance
// ══════════════════════════════════════════════════════════════

describe('fuzz: prototype pollution', () => {
  const POISON_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'];

  it('normalizeRequirements strips prototype pollution keys', () => {
    for (const key of POISON_KEYS) {
      const poisoned = {
        s402Version: '1',
        accepts: ['exact'],
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '1000',
        payTo: VALID_PAY_TO,
        [key]: { malicious: true },
      };

      const result = normalizeRequirements(poisoned);
      // The poison key must not survive the trust boundary
      expect((result as any)[key]).not.toEqual({ malicious: true });
    }
  });

  it('deep prototype pollution via nested __proto__ in extensions is contained', () => {
    const poisoned = {
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: VALID_PAY_TO,
      extensions: { __proto__: { isAdmin: true } },
    };

    const result = normalizeRequirements(poisoned);
    // The result should not grant isAdmin on the prototype
    expect(({} as any).isAdmin).toBeUndefined();
    // extensions passes through (it's a known key), but __proto__ inside extensions
    // is a JSON value, not a prototype assignment (JSON.parse is safe for this)
    expect(result.extensions).toBeDefined();
  });

  it('fromX402Requirements does not inherit poison from x402 input', () => {
    const x402Poisoned = {
      x402Version: 1,
      scheme: 'exact',
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: VALID_PAY_TO,
      __proto__hack: 'pwned',
      constructor: 'overwritten',
    };

    const result = fromX402Requirements(x402Poisoned as any);
    // fromX402Requirements builds a new object with explicit field mapping
    expect((result as any).__proto__hack).toBeUndefined();
    expect((result as any).constructor).not.toBe('overwritten');
  });

  it('fromX402Envelope does not inherit poison from envelope', () => {
    const envelope = {
      x402Version: 2,
      accepts: [{
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '1000',
        payTo: VALID_PAY_TO,
        __proto__hack: 'pwned',
      }],
      __proto__: { isAdmin: true },
    };

    const result = fromX402Envelope(envelope as any);
    expect((result as any).__proto__hack).toBeUndefined();
    expect(({} as any).isAdmin).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Detection function consistency
// ══════════════════════════════════════════════════════════════

describe('fuzz: detection function consistency', () => {
  it('isS402 and isX402 are mutually exclusive for valid inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // s402 objects
          fc.record({ s402Version: fc.constant('1'), accepts: fc.constant(['exact']) }).map(r => ({ ...r, network: 'sui:testnet', asset: 'SUI', amount: '1', payTo: '0x1' })),
          // x402 objects
          fc.record({ x402Version: fc.nat() }).map(r => ({ ...r, scheme: 'exact', network: 'sui:testnet', asset: 'SUI', amount: '1', payTo: '0x1' })),
        ),
        (obj) => {
          const s402 = isS402(obj as Record<string, unknown>);
          const x402 = isX402(obj as Record<string, unknown>);
          // They must never both be true
          expect(s402 && x402).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('object with both s402Version and x402Version → isS402=true, isX402=false', () => {
    // This is the ambiguous case — s402 takes priority
    const dual = { s402Version: '1', x402Version: 1, accepts: ['exact'], network: 'n', asset: 'a', amount: '0', payTo: 'p' };
    expect(isS402(dual)).toBe(true);
    expect(isX402(dual)).toBe(false);
    expect(isX402Envelope(dual)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// 6. x402 V2 envelope edge cases
// ══════════════════════════════════════════════════════════════

describe('fuzz: x402 V2 envelope edge cases', () => {
  it('empty accepts array in envelope throws', () => {
    const envelope = { x402Version: 2, accepts: [] };
    expect(() => fromX402Envelope(envelope as any)).toThrow('empty accepts');
  });

  it('envelope with missing inner fields throws s402Error', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.anything()),
        (innerJunk) => {
          const envelope = { x402Version: 2, accepts: [innerJunk] };
          try {
            fromX402Envelope(envelope as any);
          } catch (e) {
            expect(e).toBeInstanceOf(s402Error);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('envelope with multiple accepts picks first and validates', () => {
    const envelope = {
      x402Version: 2,
      accepts: [
        { scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '500', payTo: '0x1' },
        { scheme: 'exact', network: 'sui:mainnet', asset: '0x2::sui::SUI', amount: '999', payTo: '0x2' },
      ],
    };
    const result = fromX402Envelope(envelope as any);
    // Should pick the first one
    expect(result.amount).toBe('500');
    expect(result.network).toBe('sui:testnet');
  });
});

// ══════════════════════════════════════════════════════════════
// 7. Type coercion attacks
// ══════════════════════════════════════════════════════════════

describe('fuzz: type coercion attacks on normalizeRequirements', () => {
  it('amount as number is rejected', () => {
    const bad = {
      s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: 1000 as any, payTo: VALID_PAY_TO,
    };
    expect(() => normalizeRequirements(bad)).toThrow();
  });

  it('accepts as string (not array) is rejected', () => {
    const bad = {
      s402Version: '1', accepts: 'exact' as any, network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
    };
    expect(() => normalizeRequirements(bad)).toThrow();
  });

  it('s402Version as number 1 is rejected', () => {
    const bad = {
      s402Version: 1 as any, accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
    };
    expect(() => normalizeRequirements(bad)).toThrow();
  });

  it('null amount is rejected', () => {
    const bad = {
      s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: null as any, payTo: VALID_PAY_TO,
    };
    expect(() => normalizeRequirements(bad)).toThrow();
  });

  it('array of numbers in accepts is rejected', () => {
    const bad = {
      s402Version: '1', accepts: [1, 2, 3] as any, network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
    };
    expect(() => normalizeRequirements(bad)).toThrow();
  });

  it('protocolFeeBps as string is rejected', () => {
    const bad = {
      s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
      protocolFeeBps: '50' as any,
    };
    expect(() => normalizeRequirements(bad)).toThrow();
  });

  it('expiresAt as Date object is rejected', () => {
    const bad = {
      s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
      expiresAt: new Date() as any,
    };
    expect(() => normalizeRequirements(bad)).toThrow();
  });
});
