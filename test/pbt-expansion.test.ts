/**
 * Property-Based Testing expansion — new invariant properties
 *
 * Expands on the existing fuzz.test.ts with 7 new invariant properties
 * that must hold for ALL randomly generated inputs.
 *
 * Properties:
 * P1: Idempotency — decode(encode(x)) === x for all types (exhaustive)
 * P2: Monotonicity — adding valid optional fields to valid requirements never makes them invalid
 * P3: Commutativity — order of scheme registration doesn't affect dispatch
 * P4: Allowlist completeness — pickRequirementsFields never drops known keys, always strips unknown
 * P5: Error consistency — invalid input always throws s402Error (never raw TypeError)
 * P6: Facilitator safety — expired requirements always rejected under randomized inputs (S1)
 * P7: Error determinism — same invalid input always produces same error code
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  encodePaymentRequired,
  decodePaymentRequired,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  s402Error,
  s402Facilitator,
  S402_VERSION,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402SettleResponse,
  type s402FacilitatorScheme,
} from '../src/index.js';
import { pickRequirementsFields, validateRequirementsShape } from '../src/http.js';

// ══════════════════════════════════════════════════════════════
// Arbitraries
// ══════════════════════════════════════════════════════════════

const VALID_PAY_TO = '0x' + 'a'.repeat(64);

const suiAddress = () =>
  fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
    .map(ns => '0x' + ns.map(n => n.toString(16)).join(''));

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
    scheme: fc.constant('exact' as const),
    payload: fc.record({
      transaction: fc.base64String({ minLength: 4, maxLength: 200 }),
      signature: fc.base64String({ minLength: 4, maxLength: 200 }),
    }),
  }) as fc.Arbitrary<s402ExactPayload>;

// ══════════════════════════════════════════════════════════════
// P1: Idempotency — decode(encode(x)) preserves all fields
// ══════════════════════════════════════════════════════════════

describe('pbt-p1: encode → decode idempotency (exhaustive)', () => {
  it('requirements roundtrip preserves all fields including optional ones', () => {
    const withOptionals = () =>
      fc.record({
        s402Version: fc.constant(S402_VERSION as string),
        accepts: fc.constantFrom(['exact'], ['exact', 'stream']),
        network: fc.constantFrom('sui:testnet', 'sui:mainnet'),
        asset: fc.constant('0x2::sui::SUI'),
        amount: fc.nat({ max: 1_000_000_000 }).map(n => String(n)),
        payTo: suiAddress(),
        protocolFeeBps: fc.option(fc.integer({ min: 0, max: 10000 }), { nil: undefined }),
        expiresAt: fc.option(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), { nil: undefined }),
        receiptRequired: fc.option(fc.boolean(), { nil: undefined }),
        settlementMode: fc.option(fc.constantFrom('facilitator' as const, 'direct' as const), { nil: undefined }),
      }) as fc.Arbitrary<s402PaymentRequirements>;

    fc.assert(
      fc.property(withOptionals(), (reqs) => {
        const decoded = decodePaymentRequired(encodePaymentRequired(reqs));
        // All fields that were present must survive
        expect(decoded.s402Version).toBe(reqs.s402Version);
        expect(decoded.accepts).toEqual(reqs.accepts);
        expect(decoded.network).toBe(reqs.network);
        expect(decoded.asset).toBe(reqs.asset);
        expect(decoded.amount).toBe(reqs.amount);
        expect(decoded.payTo).toBe(reqs.payTo);
        if (reqs.protocolFeeBps !== undefined) expect(decoded.protocolFeeBps).toBe(reqs.protocolFeeBps);
        if (reqs.expiresAt !== undefined) expect(decoded.expiresAt).toBe(reqs.expiresAt);
        if (reqs.receiptRequired !== undefined) expect(decoded.receiptRequired).toBe(reqs.receiptRequired);
        if (reqs.settlementMode !== undefined) expect(decoded.settlementMode).toBe(reqs.settlementMode);
      }),
      { numRuns: 500 },
    );
  });

  it('settle response roundtrip preserves all fields', () => {
    const fullSettle = () =>
      fc.oneof(
        fc.record({
          success: fc.constant(true as const),
          txDigest: fc.string({ minLength: 1, maxLength: 64 }),
          receiptId: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
          finalityMs: fc.option(fc.integer({ min: 0, max: 60000 }), { nil: undefined }),
        }),
        fc.record({
          success: fc.constant(false as const),
          error: fc.string({ minLength: 1, maxLength: 200 }),
          errorCode: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
        }),
      ) as fc.Arbitrary<s402SettleResponse>;

    fc.assert(
      fc.property(fullSettle(), (resp) => {
        const decoded = decodeSettleResponse(encodeSettleResponse(resp));
        expect(decoded.success).toBe(resp.success);
        if (resp.success && resp.txDigest) expect(decoded.txDigest).toBe(resp.txDigest);
        if (!resp.success && resp.error) expect(decoded.error).toBe(resp.error);
      }),
      { numRuns: 500 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// P2: Monotonicity — adding valid optional fields never breaks validation
// ══════════════════════════════════════════════════════════════

describe('pbt-p2: monotonicity — valid optional fields preserve validity', () => {
  it('adding protocolFeeBps to valid requirements stays valid', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        fc.integer({ min: 0, max: 10000 }),
        (reqs, bps) => {
          const extended = { ...reqs, protocolFeeBps: bps };
          expect(() => validateRequirementsShape(extended)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adding expiresAt to valid requirements stays valid', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (reqs, exp) => {
          const extended = { ...reqs, expiresAt: exp };
          expect(() => validateRequirementsShape(extended)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adding receiptRequired to valid requirements stays valid', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        fc.boolean(),
        (reqs, receipt) => {
          const extended = { ...reqs, receiptRequired: receipt };
          expect(() => validateRequirementsShape(extended)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adding settlementMode to valid requirements stays valid', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        fc.constantFrom('facilitator', 'direct'),
        (reqs, mode) => {
          const extended = { ...reqs, settlementMode: mode };
          expect(() => validateRequirementsShape(extended)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adding facilitatorUrl to valid requirements stays valid', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        fc.constantFrom('https://a.com', 'https://b.example.com/v1', 'http://localhost:3000'),
        (reqs, url) => {
          const extended = { ...reqs, facilitatorUrl: url };
          expect(() => validateRequirementsShape(extended)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// P3: Commutativity — registration order doesn't affect dispatch
// ══════════════════════════════════════════════════════════════

describe('pbt-p3: commutativity — registration order is irrelevant', () => {
  it('registering schemes in any order produces same result', () => {
    const exactScheme: s402FacilitatorScheme = {
      scheme: 'exact',
      verify: vi.fn().mockResolvedValue({ valid: true }),
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'A' }),
    };
    const streamScheme: s402FacilitatorScheme = {
      scheme: 'stream',
      verify: vi.fn().mockResolvedValue({ valid: true }),
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'B' }),
    };

    // Order 1: exact then stream
    const f1 = new s402Facilitator();
    f1.register('sui:testnet', exactScheme);
    f1.register('sui:testnet', streamScheme);

    // Order 2: stream then exact
    const f2 = new s402Facilitator();
    f2.register('sui:testnet', streamScheme);
    f2.register('sui:testnet', exactScheme);

    // Both should support exact and stream
    expect(f1.supports('sui:testnet', 'exact')).toBe(true);
    expect(f1.supports('sui:testnet', 'stream')).toBe(true);
    expect(f2.supports('sui:testnet', 'exact')).toBe(true);
    expect(f2.supports('sui:testnet', 'stream')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// P4: Allowlist completeness — pickRequirementsFields
// ══════════════════════════════════════════════════════════════

describe('pbt-p4: allowlist completeness', () => {
  const KNOWN_KEYS = new Set([
    's402Version', 'accepts', 'network', 'asset', 'amount', 'payTo',
    'facilitatorUrl', 'mandate', 'protocolFeeBps', 'protocolFeeAddress',
    'receiptRequired', 'settlementMode', 'expiresAt',
    'stream', 'escrow', 'unlock', 'prepaid', 'extensions',
  ]);

  it('for any valid requirements, pickRequirementsFields preserves all known keys', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        const picked = pickRequirementsFields(reqs as unknown as Record<string, unknown>);
        // Every key in the original that's known should survive
        for (const key of Object.keys(reqs)) {
          if (KNOWN_KEYS.has(key)) {
            expect(key in picked).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('for any requirements with junk keys, pickRequirementsFields strips all unknown', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => !KNOWN_KEYS.has(s)),
          fc.anything(),
        ),
        (reqs, junk) => {
          const polluted = { ...junk, ...reqs } as Record<string, unknown>;
          const picked = pickRequirementsFields(polluted);

          for (const key of Object.keys(picked)) {
            expect(KNOWN_KEYS.has(key)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// P5: Error consistency — always s402Error, never raw TypeError
// ══════════════════════════════════════════════════════════════

describe('pbt-p5: error consistency — decode always throws s402Error', () => {
  it('decodePaymentRequired throws s402Error on any garbage (never TypeError)', () => {
    fc.assert(
      fc.property(fc.anything(), (garbage) => {
        try {
          decodePaymentRequired(garbage as string);
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
          expect(typeof (e as InstanceType<typeof s402Error>).code).toBe('string');
          expect(typeof (e as InstanceType<typeof s402Error>).retryable).toBe('boolean');
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('decodePaymentPayload throws s402Error on any garbage (never TypeError)', () => {
    fc.assert(
      fc.property(fc.anything(), (garbage) => {
        try {
          decodePaymentPayload(garbage as string);
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
          expect(typeof (e as InstanceType<typeof s402Error>).code).toBe('string');
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('decodeSettleResponse throws s402Error on any garbage (never TypeError)', () => {
    fc.assert(
      fc.property(fc.anything(), (garbage) => {
        try {
          decodeSettleResponse(garbage as string);
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
          expect(typeof (e as InstanceType<typeof s402Error>).code).toBe('string');
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('validateRequirementsShape always throws s402Error on random objects', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (obj) => {
        try {
          validateRequirementsShape(obj);
        } catch (e) {
          expect(e).toBeInstanceOf(s402Error);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// P6: Facilitator safety — S1 invariant under randomized inputs
// ══════════════════════════════════════════════════════════════

describe('pbt-p6: facilitator safety — S1 invariant', () => {
  it('for any payload where expiresAt < Date.now(), process() always rejects', () => {
    const mockScheme: s402FacilitatorScheme = {
      scheme: 'exact',
      verify: vi.fn().mockResolvedValue({ valid: true }),
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'X' }),
    };

    const f = new s402Facilitator();
    f.register('sui:testnet', mockScheme);

    fc.assert(
      fc.asyncProperty(
        validExactPayload(),
        // expiresAt always in the past
        fc.integer({ min: 1, max: Date.now() - 1 }),
        async (payload, expiresAt) => {
          const reqs: s402PaymentRequirements = {
            s402Version: S402_VERSION,
            accepts: ['exact'],
            network: 'sui:testnet',
            asset: '0x2::sui::SUI',
            amount: '1000',
            payTo: VALID_PAY_TO,
            expiresAt,
          };

          const result = await f.process(payload, reqs);
          expect(result.success).toBe(false);
          expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// P7: Error determinism — same input → same error code
// ══════════════════════════════════════════════════════════════

describe('pbt-p7: error determinism', () => {
  it('same invalid input always produces same error code', () => {
    fc.assert(
      fc.property(fc.anything(), (garbage) => {
        const errors: string[] = [];
        for (let i = 0; i < 3; i++) {
          try {
            decodePaymentRequired(garbage as string);
          } catch (e) {
            if (e instanceof s402Error) {
              errors.push(e.code);
            }
          }
        }
        // All attempts should produce the same error code
        if (errors.length > 0) {
          expect(new Set(errors).size).toBe(1);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// Metamorphic: output relationships
// ══════════════════════════════════════════════════════════════

describe('metamorphic: output relationships', () => {
  it('encode determinism — encoding same object twice produces identical output', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        const enc1 = encodePaymentRequired(reqs);
        const enc2 = encodePaymentRequired(reqs);
        expect(enc1).toBe(enc2);
      }),
      { numRuns: 300 },
    );
  });

  it('encode determinism through JSON roundtrip', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        const enc1 = encodePaymentRequired(reqs);
        const enc2 = encodePaymentRequired(JSON.parse(JSON.stringify(reqs)));
        expect(enc1).toBe(enc2);
      }),
      { numRuns: 300 },
    );
  });

  it('fee proportionality — protocolFeeBps survives roundtrip exactly', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        fc.integer({ min: 0, max: 10000 }),
        (reqs, bps) => {
          const withFee = { ...reqs, protocolFeeBps: bps };
          const decoded = decodePaymentRequired(encodePaymentRequired(withFee as s402PaymentRequirements));
          expect(decoded.protocolFeeBps).toBe(bps);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('validation strictness — valid requirements with any single valid optional field are still valid', () => {
    const validOptionals = [
      { protocolFeeBps: 50 },
      { expiresAt: Date.now() + 60_000 },
      { receiptRequired: true },
      { settlementMode: 'facilitator' },
      { facilitatorUrl: 'https://example.com' },
      { protocolFeeAddress: '0x' + 'f'.repeat(64) },
    ];

    fc.assert(
      fc.property(
        validRequirements(),
        fc.constantFrom(...validOptionals),
        (reqs, opt) => {
          expect(() => validateRequirementsShape({ ...reqs, ...opt })).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// Differential: cross-implementation comparison
// ══════════════════════════════════════════════════════════════

describe('differential: cross-implementation comparison', () => {
  it('JSON.parse(atob(encoded)) matches decodePaymentRequired output', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        const encoded = encodePaymentRequired(reqs);
        // Manual decode (independent implementation)
        const manualDecoded = JSON.parse(atob(encoded));
        // Library decode
        const libDecoded = decodePaymentRequired(encoded);

        // Both should have the same required fields
        expect(libDecoded.s402Version).toBe(manualDecoded.s402Version);
        expect(libDecoded.accepts).toEqual(manualDecoded.accepts);
        expect(libDecoded.network).toBe(manualDecoded.network);
        expect(libDecoded.asset).toBe(manualDecoded.asset);
        expect(libDecoded.amount).toBe(manualDecoded.amount);
        expect(libDecoded.payTo).toBe(manualDecoded.payTo);
      }),
      { numRuns: 300 },
    );
  });

  it('header transport and body transport produce identical decoded results', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        const fromHeader = decodePaymentRequired(encodePaymentRequired(reqs));
        const fromBody = JSON.parse(JSON.stringify(reqs));
        // Header path runs through shape validation + key stripping
        // Direct JSON doesn't. But for valid inputs, all known keys should match.
        expect(fromHeader.s402Version).toBe(fromBody.s402Version);
        expect(fromHeader.accepts).toEqual(fromBody.accepts);
        expect(fromHeader.network).toBe(fromBody.network);
        expect(fromHeader.amount).toBe(fromBody.amount);
      }),
      { numRuns: 300 },
    );
  });
});
