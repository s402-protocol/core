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
  encodeRequirementsBody,
  decodeRequirementsBody,
  encodeSettleResponse,
  decodeSettleResponse,
  toRequirementsWire,
  s402Error,
  s402Facilitator,
  S402_VERSION,
  type s402PaymentRequired,
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

/** One `accepts[]` entry — an offer of a single scheme. */
const validOffer = () =>
  fc.record({
    scheme: fc.constantFrom('exact', 'upto', 'stream', 'escrow', 'unlock', 'prepaid'),
    network: fc.constantFrom('sui:testnet', 'sui:mainnet', 'sui:devnet'),
    asset: fc.constantFrom('0x2::sui::SUI', '0xdba::usdc::USDC'),
    amount: fc.nat({ max: 1_000_000_000_000 }).map(n => String(n)),
    payTo: suiAddress(),
  });

/** The 402 DOCUMENT — an x402 V2 `PaymentRequired` envelope (wire v2). */
const validRequirements = () =>
  fc.record({
    x402Version: fc.constant(2 as const),
    resource: fc.record({
      url: fc.constantFrom('https://api.example.com/paid', 'https://x.test/resource'),
    }),
    accepts: fc.array(validOffer(), { minLength: 1, maxLength: 3 }),
  }) as fc.Arbitrary<s402PaymentRequired>;

/**
 * Project a document to the wire, adding fields to EVERY `accepts[]` entry's
 * `extra` — where s402's own per-requirement fields travel in wire v2.
 */
const withEntryExtra = (
  required: s402PaymentRequired,
  extra: Record<string, unknown>,
): Record<string, unknown> =>
  toRequirementsWire({
    ...required,
    accepts: required.accepts.map((entry) => ({ ...entry, extra: { ...(entry.extra ?? {}), ...extra } })),
  });

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
/**
 * The order the encoder puts offers on the wire: every `exact` first, the rest
 * in their original relative order. A round trip preserves every FIELD; it does
 * not promise to preserve the ORDER, because x402's client pays the first entry
 * it can handle and `exact` has to be that entry (ADR-016 rule 2).
 */
function expectedOrder<T extends { scheme: string }>(accepts: readonly T[]): T[] {
  const exact = accepts.filter((o) => o.scheme === 'exact');
  return exact.length === 0 || exact.length === accepts.length
    ? [...accepts]
    : [...exact, ...accepts.filter((o) => o.scheme !== 'exact')];
}

  it('requirements roundtrip preserves all fields including optional ones', () => {
    // The optional s402 fields are per-requirement: they ride in each
    // `accepts[]` entry's `extra` on the wire and are lifted back on decode.
    const offerWithOptionals = () =>
      fc.record({
        scheme: fc.constantFrom('exact', 'stream'),
        network: fc.constantFrom('sui:testnet', 'sui:mainnet'),
        asset: fc.constant('0x2::sui::SUI'),
        amount: fc.nat({ max: 1_000_000_000 }).map(n => String(n)),
        payTo: suiAddress(),
        protocolFeeBps: fc.option(fc.integer({ min: 0, max: 10000 }), { nil: undefined }),
        expiresAt: fc.option(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), { nil: undefined }),
        receiptRequired: fc.option(fc.boolean(), { nil: undefined }),
        settlementMode: fc.option(fc.constantFrom('facilitator' as const, 'direct' as const), { nil: undefined }),
      });

    const withOptionals = () =>
      fc.record({
        x402Version: fc.constant(2 as const),
        resource: fc.record({ url: fc.constant('https://api.example.com/paid') }),
        accepts: fc.array(offerWithOptionals(), { minLength: 1, maxLength: 2 }),
      }) as fc.Arbitrary<s402PaymentRequired>;

    fc.assert(
      fc.property(withOptionals(), (reqs) => {
        const decoded = decodePaymentRequired(encodePaymentRequired(reqs));
        // All fields that were present must survive
        expect(decoded.x402Version).toBe(2);
        expect(decoded.resource.url).toBe(reqs.resource.url);
        expect(decoded.accepts).toHaveLength(reqs.accepts.length);
        expectedOrder(reqs.accepts).forEach((offer, i) => {
          const entry = decoded.accepts[i];
          expect(entry.scheme).toBe(offer.scheme);
          expect(entry.network).toBe(offer.network);
          expect(entry.asset).toBe(offer.asset);
          expect(entry.amount).toBe(offer.amount);
          expect(entry.payTo).toBe(offer.payTo);
          if (offer.protocolFeeBps !== undefined) expect(entry.protocolFeeBps).toBe(offer.protocolFeeBps);
          if (offer.expiresAt !== undefined) expect(entry.expiresAt).toBe(offer.expiresAt);
          if (offer.receiptRequired !== undefined) expect(entry.receiptRequired).toBe(offer.receiptRequired);
          if (offer.settlementMode !== undefined) expect(entry.settlementMode).toBe(offer.settlementMode);
        });
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
          expect(() => validateRequirementsShape(withEntryExtra(reqs, { protocolFeeBps: bps }))).not.toThrow();
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
          expect(() => validateRequirementsShape(withEntryExtra(reqs, { expiresAt: exp }))).not.toThrow();
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
          expect(() => validateRequirementsShape(withEntryExtra(reqs, { receiptRequired: receipt }))).not.toThrow();
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
          expect(() => validateRequirementsShape(withEntryExtra(reqs, { settlementMode: mode }))).not.toThrow();
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
          expect(() => validateRequirementsShape(withEntryExtra(reqs, { facilitatorUrl: url }))).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adding maxTimeoutSeconds to an accepts[] entry stays valid', () => {
    // maxTimeoutSeconds is x402's own key, so it stays at the TOP of the entry
    // rather than moving into `extra` — the one optional that did not descend.
    fc.assert(
      fc.property(
        validRequirements(),
        // 1, not 0: x402 V2 requires a POSITIVE timeout, and a zero-second
        // offer used to decode with no `expiresAt` at all.
        fc.integer({ min: 1, max: 3600 }),
        (reqs, timeout) => {
          const wire = toRequirementsWire({
            ...reqs,
            accepts: reqs.accepts.map((entry) => ({ ...entry, maxTimeoutSeconds: timeout })),
          });
          expect(() => validateRequirementsShape(wire)).not.toThrow();
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
  // Wire v2 gave the allowlist three levels instead of one. The envelope, an
  // `accepts[]` entry and `resource` each have their own known-key set and each
  // still strips what it does not name. The one deliberate hole is an entry's
  // `extra`: x402 owns that bag, its keys are open by spec, so unknown keys
  // there are KEPT (a whitelist at that boundary is exactly where the next
  // upstream field would go missing without erroring).
  const KNOWN_ENVELOPE_KEYS = new Set(['x402Version', 'resource', 'accepts', 'error', 'extensions', 'mandate']);
  const KNOWN_RESOURCE_KEYS = new Set(['url', 'description', 'mimeType', 'serviceName', 'tags', 'iconUrl']);
  const KNOWN_ENTRY_KEYS = new Set([
    'scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra',
    'facilitatorUrl', 'protocolFeeBps', 'protocolFeeAddress',
    'receiptRequired', 'settlementMode', 'expiresAt',
    'upto', 'settlementOverrides', 'prepaid', 'stream', 'escrow', 'unlock', 'extensions',
  ]);

  const junkFor = (known: Set<string>) =>
    fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }).filter(k => !known.has(k)), fc.anything());

  it('for any valid requirements, pickRequirementsFields preserves all known keys', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        const picked = pickRequirementsFields(toRequirementsWire(reqs));
        // Every key in the original that's known should survive, at its level
        for (const key of Object.keys(reqs)) {
          if (KNOWN_ENVELOPE_KEYS.has(key)) expect(key in picked).toBe(true);
        }
        for (const key of Object.keys(reqs.resource)) {
          if (KNOWN_RESOURCE_KEYS.has(key)) expect(key in picked.resource).toBe(true);
        }
        expect(picked.accepts).toHaveLength(reqs.accepts.length);
        reqs.accepts.forEach((offer, i) => {
          for (const key of Object.keys(offer)) {
            if (KNOWN_ENTRY_KEYS.has(key)) expect(key in picked.accepts[i]).toBe(true);
          }
        });
      }),
      { numRuns: 300 },
    );
  });

  it('for any requirements with junk keys, pickRequirementsFields strips all unknown', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        junkFor(KNOWN_ENVELOPE_KEYS),
        junkFor(KNOWN_ENTRY_KEYS),
        junkFor(KNOWN_RESOURCE_KEYS),
        (reqs, envJunk, entryJunk, resourceJunk) => {
          const wire = toRequirementsWire(reqs);
          const polluted: Record<string, unknown> = {
            ...envJunk,
            ...wire,
            resource: { ...resourceJunk, ...(wire.resource as Record<string, unknown>) },
            accepts: (wire.accepts as Record<string, unknown>[]).map(e => ({ ...entryJunk, ...e })),
          };
          const picked = pickRequirementsFields(polluted);

          for (const key of Object.keys(picked)) {
            expect(KNOWN_ENVELOPE_KEYS.has(key)).toBe(true);
          }
          for (const key of Object.keys(picked.resource)) {
            expect(KNOWN_RESOURCE_KEYS.has(key)).toBe(true);
          }
          for (const entry of picked.accepts) {
            for (const key of Object.keys(entry)) {
              expect(KNOWN_ENTRY_KEYS.has(key)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('unknown keys inside an accepts[] entry\'s `extra` are KEPT, not stripped', () => {
    fc.assert(
      fc.property(
        validRequirements(),
        junkFor(KNOWN_ENTRY_KEYS),
        (reqs, foreign) => {
          const wire = toRequirementsWire(reqs);
          const polluted: Record<string, unknown> = {
            ...wire,
            accepts: (wire.accepts as Record<string, unknown>[]).map(e => ({
              ...e,
              extra: { ...(e.extra as Record<string, unknown>), ...foreign },
            })),
          };
          const picked = pickRequirementsFields(polluted);

          for (const entry of picked.accepts) {
            for (const key of Object.keys(foreign)) {
              expect(entry.extra?.[key]).toEqual(foreign[key]);
            }
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
          // `process` takes ONE `accepts[]` entry — the offer the payload matched.
          const reqs: s402PaymentRequirements = {
            scheme: 'exact',
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
          const withFee: s402PaymentRequired = {
            ...reqs,
            accepts: reqs.accepts.map((entry) => ({ ...entry, protocolFeeBps: bps })),
          };
          const decoded = decodePaymentRequired(encodePaymentRequired(withFee));
          for (const entry of decoded.accepts) {
            expect(entry.protocolFeeBps).toBe(bps);
          }
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
          expect(() => validateRequirementsShape(withEntryExtra(reqs, opt))).not.toThrow();
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
        // Manual decode (independent implementation) — this is the raw WIRE,
        // so an entry's s402 fields are still down inside its `extra`.
        const manualDecoded = JSON.parse(atob(encoded));
        // Library decode
        const libDecoded = decodePaymentRequired(encoded);

        // Both should have the same required fields
        expect(libDecoded.x402Version).toBe(manualDecoded.x402Version);
        expect(libDecoded.resource.url).toBe(manualDecoded.resource.url);
        expect(libDecoded.accepts).toHaveLength(manualDecoded.accepts.length);
        manualDecoded.accepts.forEach((wireEntry: Record<string, unknown>, i: number) => {
          const entry = libDecoded.accepts[i];
          expect(entry.scheme).toBe(wireEntry.scheme);
          expect(entry.network).toBe(wireEntry.network);
          expect(entry.asset).toBe(wireEntry.asset);
          expect(entry.amount).toBe(wireEntry.amount);
          expect(entry.payTo).toBe(wireEntry.payTo);
          expect(entry.maxTimeoutSeconds).toBe(wireEntry.maxTimeoutSeconds);
        });
        // The s402 profile marker is on the envelope, under `extensions.s402`.
        expect(manualDecoded.extensions.s402.version).toBe('2');
      }),
      { numRuns: 300 },
    );
  });

  it('header transport and body transport produce identical decoded results', () => {
    fc.assert(
      fc.property(validRequirements(), (reqs) => {
        // Same envelope, two carriers: base64 header and raw JSON body. Both
        // run the same shape validation and the same key stripping.
        const fromHeader = decodePaymentRequired(encodePaymentRequired(reqs));
        const fromBody = decodeRequirementsBody(encodeRequirementsBody(reqs));
        expect(fromHeader).toEqual(fromBody);
      }),
      { numRuns: 300 },
    );
  });
});
