/**
 * Adversarial tests — attack scenarios that must fail
 *
 * Each test simulates a specific attack vector and proves the defense holds.
 * These go beyond MC/DC by testing realistic attack patterns, not just
 * individual condition flips.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  decodePaymentRequired,
  encodePaymentRequired,
  s402Error,
  s402Facilitator,
  S402_VERSION,
  S402_WIRE_VERSION,
  isValidAmount,
  type s402PaymentRequired,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402FacilitatorScheme,
} from '../src/index.js';
import { validateRequirementsShape, pickRequirementsFields } from '../src/http.js';
import { parseReceiptHeader } from '../src/receipts.js';

const VALID_PAY_TO = '0x' + 'a'.repeat(64);
const RESOURCE_URL = 'https://api.example.com/paid';

/** One valid `accepts[]` entry, in memory — what the facilitator is handed. */
const VALID_REQUIREMENTS: s402PaymentRequirements = {
  scheme: 'exact',
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: VALID_PAY_TO,
};

/** The six keys x402 owns on one `accepts[]` entry. Everything else is s402's. */
const ENTRY_KEYS = new Set(['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds']);

/** Keys that belong to the envelope itself, above the `accepts[]` list. */
const ENVELOPE_KEYS = new Set(['x402Version', 'resource', 'accepts', 'extensions', 'error']);

/**
 * Build the wire envelope a flat attack payload describes.
 *
 * Each attack below still targets the field it always did; wire v2 only moved
 * where that field travels. The six x402 keys stay on `accepts[0]`; `mandate`
 * goes to `extensions.s402.mandate`; envelope keys stay at envelope level;
 * every s402-only field drops into `accepts[0].extra`.
 */
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  const envelope: Record<string, unknown> = { x402Version: 2, resource: { url: RESOURCE_URL } };
  const s402Ext: Record<string, unknown> = { version: S402_WIRE_VERSION };

  for (const [key, value] of Object.entries({ ...VALID_REQUIREMENTS, ...overrides })) {
    if (ENTRY_KEYS.has(key)) entry[key] = value;
    else if (key === 'mandate') s402Ext.mandate = value;
    else if (ENVELOPE_KEYS.has(key)) envelope[key] = value;
    else extra[key] = value;
  }

  if (Object.keys(extra).length > 0) entry.extra = extra;
  if (!('accepts' in envelope)) envelope.accepts = [entry];
  if (envelope.extensions === undefined) envelope.extensions = { s402: s402Ext };
  return envelope;
}

/** Validate the envelope a flat attack payload describes. */
function wireValidate(overrides: Record<string, unknown> = {}): void {
  validateRequirementsShape(wire(overrides));
}

/** The same fixture as an in-memory 402 document, for the encode → decode paths. */
function doc(overrides: Partial<s402PaymentRequirements> = {}, envelope: Partial<s402PaymentRequired> = {}): s402PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [{ ...VALID_REQUIREMENTS, ...overrides }],
    ...envelope,
  };
}

const VALID_PAYLOAD: s402ExactPayload = {
  s402Version: S402_VERSION,
  scheme: 'exact',
  payload: { transaction: 'dHhieXRlcw==', signature: 'c2lnbmF0dXJl' },
};

function createMockScheme(): s402FacilitatorScheme {
  return {
    scheme: 'exact',
    verify: vi.fn().mockResolvedValue({ valid: true }),
    settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'ABC123' }),
  };
}

// ══════════════════════════════════════════════════════════════
// ATK-1: Header injection via control characters
// ══════════════════════════════════════════════════════════════

describe('adversarial: header injection via control characters', () => {
  // Control characters in identifier fields can enable HTTP header injection (CRLF)
  // or log injection (null bytes). s402 blocks ALL control chars in:
  // scheme, network, asset, payTo, facilitatorUrl, protocolFeeAddress

  const CONTROL_CHARS = [
    ['\x00', 'null byte'],
    ['\x01', 'SOH'],
    ['\x0a', 'newline (\\n)'],
    ['\x0d', 'carriage return (\\r)'],
    ['\x09', 'tab'],
    ['\x1f', 'US (last C0 control)'],
    ['\x7f', 'DEL'],
  ] as const;

  for (const [char, label] of CONTROL_CHARS) {
    it(`rejects ${label} in scheme`, () => {
      expect(() => wireValidate({ scheme: `exact${char}` })).toThrow('control characters');
    });

    it(`rejects ${label} in network`, () => {
      expect(() => wireValidate({ network: `sui${char}:testnet` })).toThrow('control characters');
    });

    it(`rejects ${label} in asset`, () => {
      expect(() => wireValidate({ asset: `0x2::sui${char}::SUI` })).toThrow('control characters');
    });

    it(`rejects ${label} in payTo`, () => {
      expect(() => wireValidate({ payTo: `0xabc${char}def` })).toThrow('control characters');
    });

    it(`rejects ${label} in facilitatorUrl`, () => {
      expect(() => wireValidate({ facilitatorUrl: `https://evil.com${char}/path` })).toThrow('control characters');
    });

    it(`rejects ${label} in protocolFeeAddress`, () => {
      expect(() => wireValidate({ protocolFeeAddress: `0xfee${char}addr` })).toThrow('control characters');
    });
  }

  it('rejects CRLF injection attempt in facilitatorUrl', () => {
    expect(() => wireValidate({
      facilitatorUrl: 'https://evil.com\r\nX-Injected: true\r\nX-Attack: works',
    })).toThrow('control characters');
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-2: TOCTOU — requirements expire between verify and settle
// ══════════════════════════════════════════════════════════════

describe('adversarial: TOCTOU — expiry between verify and settle', () => {
  it('process() re-checks expiry after verify (simulated clock advancement)', async () => {
    // Requirements expire in 50ms. Verify takes 100ms.
    // After verify completes, requirements should be expired.
    const expiresAt = Date.now() + 50;

    const scheme: s402FacilitatorScheme = {
      scheme: 'exact',
      verify: vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ valid: true }), 100))
      ),
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'X' }),
    };

    const f = new s402Facilitator();
    f.register('sui:testnet', scheme);

    const result = await f.process(VALID_PAYLOAD, { ...VALID_REQUIREMENTS, expiresAt });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
    expect(result.error).toContain('expired during verification');
    // settle() should NOT have been called
    expect(scheme.settle).not.toHaveBeenCalled();
  });

  it('process() allows settle when requirements are still valid after verify', async () => {
    const expiresAt = Date.now() + 5000; // 5 seconds — plenty of time

    const scheme: s402FacilitatorScheme = {
      scheme: 'exact',
      verify: vi.fn().mockResolvedValue({ valid: true }),
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'Y' }),
    };

    const f = new s402Facilitator();
    f.register('sui:testnet', scheme);

    const result = await f.process(VALID_PAYLOAD, { ...VALID_REQUIREMENTS, expiresAt });

    expect(result.success).toBe(true);
    expect(scheme.settle).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-3: Prototype pollution escalation
// ══════════════════════════════════════════════════════════════

describe('adversarial: prototype pollution', () => {
  it('__proto__.isAdmin = true does not affect Object prototype', () => {
    const poisoned = doc({}, {
      extensions: {
        __proto__: { isAdmin: true },
      },
    });

    // JSON.parse is safe for __proto__ — it creates a data property, not a prototype mutation.
    // But we verify it here explicitly.
    const encoded = encodePaymentRequired(poisoned);
    decodePaymentRequired(encoded);

    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, 'isAdmin')).toBe(false);
  });

  it('__proto__ at envelope level is stripped by pickRequirementsFields', () => {
    // Pointed at the ENVELOPE, which still strips. An entry's `extra` no longer
    // does — x402 owns that bag and an unknown key there is kept verbatim — so
    // an allowlist assertion aimed at `extra` would now be asserting the
    // opposite of the design (ADR-016 §Postel).
    const poisoned = {
      ...wire(),
      __proto__hack: { evil: true },
      constructor: 'overwritten',
    };

    const clean = pickRequirementsFields(poisoned as unknown as Record<string, unknown>);
    expect((clean as unknown as Record<string, unknown>).__proto__hack).toBeUndefined();
    // constructor should be the normal Object constructor, not overwritten
    expect(typeof clean.constructor).toBe('function');
  });

  it('__proto__ inside an accepts[] entry is stripped by pickRequirementsFields', () => {
    const poisoned = wire({
      accepts: [{ ...VALID_REQUIREMENTS, __proto__hack: { evil: true }, constructor: 'overwritten' }],
    });

    const clean = pickRequirementsFields(poisoned);
    const entry = clean.accepts[0] as unknown as Record<string, unknown>;
    expect(entry.__proto__hack).toBeUndefined();
    expect(typeof (clean.accepts[0] as object).constructor).toBe('function');
  });

  it('nested __proto__ in sub-objects does not escape', () => {
    const poisoned = wire({
      mandate: {
        required: true,
        __proto__: { isAdmin: true },
      },
    });

    validateRequirementsShape(poisoned);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-4: Integer overflow via amount
// ══════════════════════════════════════════════════════════════

describe('adversarial: amount format validation (S7: chain-agnostic — format only, no magnitude bounds)', () => {
  it('accepts amount exceeding u64 max — magnitude bounds belong in chain adapters', () => {
    // Wire format validates format only. 23-digit integer is a valid non-negative integer string.
    expect(() => wireValidate({ amount: '99999999999999999999999' })).not.toThrow(); // 23 digits
  });

  it('accepts amount at u64 max + 1 — needed for u256 chains (EVM)', () => {
    expect(() => wireValidate({ amount: '18446744073709551616' })).not.toThrow(); // u64 max + 1
  });

  it('accepts amount at exactly u64 max', () => {
    expect(() => wireValidate({ amount: '18446744073709551615' })).not.toThrow();
  });

  it('accepts 100-digit number — valid non-negative integer string', () => {
    // EVM u256 max is 78 digits. Even larger amounts are valid format.
    // Chain adapters enforce their own magnitude bounds.
    expect(() => wireValidate({ amount: '1' + '0'.repeat(99) })).not.toThrow(); // 10^99
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-5: Unicode normalization attack
// ══════════════════════════════════════════════════════════════

describe('adversarial: unicode normalization', () => {
  // Two visually identical strings that differ in Unicode normalization (NFC vs NFD).
  // s402 should treat them as DISTINCT because it's chain-agnostic and doesn't normalize.

  it('treats NFC and NFD forms as distinct (no normalization)', () => {
    // 'é' can be represented as:
    //   NFC: U+00E9 (single codepoint)
    //   NFD: U+0065 U+0301 (e + combining accent)
    const nfc = '\u00e9'; // é (single)
    const nfd = '\u0065\u0301'; // é (decomposed)

    // They look the same but are different strings
    expect(nfc).not.toBe(nfd);

    // s402 treats them as different — no normalization
    const encoded1 = encodePaymentRequired(doc({ network: `sui:${nfc}` }));
    const encoded2 = encodePaymentRequired(doc({ network: `sui:${nfd}` }));

    expect(encoded1).not.toBe(encoded2);

    const decoded1 = decodePaymentRequired(encoded1);
    const decoded2 = decodePaymentRequired(encoded2);

    expect(decoded1.accepts[0].network).not.toBe(decoded2.accepts[0].network);
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-6: ReDoS — regex denial-of-service
// ══════════════════════════════════════════════════════════════

describe('adversarial: ReDoS resistance', () => {
  it('isValidAmount regex handles 100KB numeric string without catastrophic backtracking', () => {
    // The regex /^(0|[1-9][0-9]*)$/ has no nested quantifiers, so it should be O(n).
    // This test verifies that empirically by timing it.
    const hugeNumber = '1' + '0'.repeat(100_000); // 100KB number

    const start = performance.now();
    const result = isValidAmount(hugeNumber);
    const elapsed = performance.now() - start;

    // It should be valid (it's a valid integer string)
    expect(result).toBe(true);
    // And it should complete in under 100ms (linear regex on 100KB)
    expect(elapsed).toBeLessThan(100);
  });

  it('rejects 100KB non-numeric string quickly', () => {
    const hugeInvalid = 'a'.repeat(100_000);

    const start = performance.now();
    const result = isValidAmount(hugeInvalid);
    const elapsed = performance.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-7: Facilitator starvation — concurrent process() calls
// ══════════════════════════════════════════════════════════════

describe('adversarial: facilitator starvation', () => {
  it('100 concurrent process() calls with different payloads all complete', async () => {
    const scheme: s402FacilitatorScheme = {
      scheme: 'exact',
      verify: vi.fn().mockResolvedValue({ valid: true }),
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'X' }),
    };

    const f = new s402Facilitator();
    f.register('sui:testnet', scheme);

    // Generate 100 different payloads (different transactions avoid dedup)
    const payloads = Array.from({ length: 100 }, (_, i) => ({
      ...VALID_PAYLOAD,
      payload: { transaction: `tx${i}`, signature: `sig${i}` },
    }));

    const results = await Promise.all(
      payloads.map(p => f.process(p, VALID_REQUIREMENTS))
    );

    // All should succeed (different payloads, no dedup)
    expect(results.every(r => r.success)).toBe(true);
  });

  it('100 concurrent identical payloads: pipeline runs once, all 100 share the result', async () => {
    // New dedup semantics (v0.6.0): concurrent duplicates share the in-flight promise
    // instead of receiving a "Duplicate" error. This prevents retrying clients from
    // seeing spurious errors while still guaranteeing exactly-once execution.
    const verifyMock = vi.fn().mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve({ valid: true }), 50))
    );
    const settleMock = vi.fn().mockResolvedValue({ success: true, txDigest: 'X' });
    const scheme: s402FacilitatorScheme = {
      scheme: 'exact',
      verify: verifyMock,
      settle: settleMock,
    };

    const f = new s402Facilitator();
    f.register('sui:testnet', scheme);

    const results = await Promise.all(
      Array.from({ length: 100 }, () => f.process(VALID_PAYLOAD, VALID_REQUIREMENTS))
    );

    // All 100 callers observe the same success result
    expect(results.every(r => r.success && r.txDigest === 'X')).toBe(true);
    // Pipeline executed exactly once (no duplicate on-chain work)
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(settleMock).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-8: Empty accepts array
// ══════════════════════════════════════════════════════════════

describe('adversarial: empty accepts array', () => {
  it('validateRequirementsShape rejects empty accepts', () => {
    expect(() => wireValidate({ accepts: [] })).toThrow('at least one requirement');
  });

  it('facilitator gives a graceful scheme mismatch, not index-out-of-bounds', async () => {
    // The cross-check is now `requirements.scheme !== payload.scheme` — one
    // entry offers one scheme, so there is no list to index into and no empty
    // list to fall off the end of. A mismatch is answered, not thrown.
    const f = new s402Facilitator();
    f.register('sui:testnet', createMockScheme());

    const result = await f.process(VALID_PAYLOAD, { ...VALID_REQUIREMENTS, scheme: 'escrow' });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCHEME_NOT_SUPPORTED');
    expect(result.error).toContain('is not accepted by these requirements');
  });

  it('a requirement naming no scheme at all still resolves, it does not crash', async () => {
    // The v1 reading of an empty accepts list — "any scheme is fine" — survives
    // as a requirement with no `scheme`: the cross-check is skipped and
    // resolveScheme decides.
    const f = new s402Facilitator();
    f.register('sui:testnet', createMockScheme());

    const { scheme: _omitted, ...noScheme } = VALID_REQUIREMENTS;
    const result = await f.process(VALID_PAYLOAD, noScheme as s402PaymentRequirements);

    expect(result.success).toBe(true);
  });

  it('decode path rejects empty accepts before it reaches the client', () => {
    const encoded = btoa(JSON.stringify(wire({ accepts: [] })));
    expect(() => decodePaymentRequired(encoded)).toThrow('at least one requirement');
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-9: Receipt header injection attempts
// ══════════════════════════════════════════════════════════════

describe('adversarial: receipt header parsing', () => {
  it('rejects receipt with extra colon-separated parts (injection attempt)', () => {
    expect(() => parseReceiptHeader('v2:sig:1:1234:hash:extra')).toThrow('expected 5');
  });

  it('rejects receipt with fewer parts', () => {
    expect(() => parseReceiptHeader('v2:sig:1')).toThrow('expected 5');
  });

  it('rejects receipt with negative callNumber', () => {
    // Create a valid-looking receipt with negative callNumber
    const sig = btoa(String.fromCharCode(...new Array(64).fill(65))); // 64 bytes
    const hash = btoa(String.fromCharCode(...new Array(32).fill(66))); // 32 bytes
    expect(() => parseReceiptHeader(`v2:${sig}:-1:1234567890:${hash}`)).toThrow('must be positive');
  });

  it('rejects receipt with zero callNumber', () => {
    const sig = btoa(String.fromCharCode(...new Array(64).fill(65)));
    const hash = btoa(String.fromCharCode(...new Array(32).fill(66)));
    expect(() => parseReceiptHeader(`v2:${sig}:0:1234567890:${hash}`)).toThrow('must be positive');
  });

  it('rejects receipt with non-integer callNumber', () => {
    const sig = btoa(String.fromCharCode(...new Array(64).fill(65)));
    const hash = btoa(String.fromCharCode(...new Array(32).fill(66)));
    expect(() => parseReceiptHeader(`v2:${sig}:abc:1234567890:${hash}`)).toThrow('not a valid integer');
  });

  it('rejects receipt with wrong signature length', () => {
    const shortSig = btoa(String.fromCharCode(...new Array(32).fill(65))); // 32 bytes, needs 64
    const hash = btoa(String.fromCharCode(...new Array(32).fill(66)));
    expect(() => parseReceiptHeader(`v2:${shortSig}:1:1234567890:${hash}`)).toThrow('64 bytes');
  });

  it('rejects receipt with wrong hash length', () => {
    const sig = btoa(String.fromCharCode(...new Array(64).fill(65)));
    const shortHash = btoa(String.fromCharCode(...new Array(16).fill(66))); // 16 bytes, needs 32
    expect(() => parseReceiptHeader(`v2:${sig}:1:1234567890:${shortHash}`)).toThrow('32 bytes');
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-10: Unknown key stripping (allowlist enforcement)
//
// Wire v2 draws the allowlist at three levels — the envelope, an `accepts[]`
// entry, and `resource`. It deliberately stops at an entry's `extra`, which
// x402 owns and keeps open; that exemption is asserted here too, so a future
// allowlist creeping into `extra` fails loudly instead of silently eating an
// upstream field.
// ══════════════════════════════════════════════════════════════

describe('adversarial: unknown key stripping', () => {
  it('strips all unknown envelope-level keys', () => {
    const poisoned = {
      ...wire(),
      malicious: 'injected',
      isAdmin: true,
      __proto__hack: 'pwned',
      role: 'superuser',
    };

    const clean = pickRequirementsFields(poisoned as unknown as Record<string, unknown>);

    expect((clean as unknown as Record<string, unknown>).malicious).toBeUndefined();
    expect((clean as unknown as Record<string, unknown>).isAdmin).toBeUndefined();
    expect((clean as unknown as Record<string, unknown>).__proto__hack).toBeUndefined();
    expect((clean as unknown as Record<string, unknown>).role).toBeUndefined();
  });

  it('strips unknown keys from inside an accepts[] entry', () => {
    const poisoned = wire({
      accepts: [{ ...VALID_REQUIREMENTS, malicious: 'injected', isAdmin: true, role: 'superuser' }],
    });

    const entry = pickRequirementsFields(poisoned).accepts[0] as unknown as Record<string, unknown>;

    expect(entry.scheme).toBe('exact');
    expect(entry.malicious).toBeUndefined();
    expect(entry.isAdmin).toBeUndefined();
    expect(entry.role).toBeUndefined();
  });

  it('strips unknown keys from resource', () => {
    const poisoned = wire({ resource: { url: RESOURCE_URL, malicious: 'injected' } });

    const resource = pickRequirementsFields(poisoned).resource as unknown as Record<string, unknown>;

    expect(resource.url).toBe(RESOURCE_URL);
    expect(resource.malicious).toBeUndefined();
  });

  it('KEEPS unknown keys inside an entry extra — x402 owns that bag', () => {
    // The one place the allowlist deliberately does not apply. x402's `extra`
    // is an open bag by spec (`paymentFlow`, the EIP-712 `name`/`version`), and
    // dropping a key we do not recognise there is how the next upstream field
    // goes missing without erroring.
    const poisoned = wire({
      accepts: [{ ...VALID_REQUIREMENTS, extra: { paymentFlow: 'authorize-capture', name: 'USDC' } }],
    });

    const extra = pickRequirementsFields(poisoned).accepts[0].extra as Record<string, unknown>;

    expect(extra.paymentFlow).toBe('authorize-capture');
    expect(extra.name).toBe('USDC');
  });

  it('strips unknown keys from sub-objects (mandate, stream, etc.)', () => {
    const poisoned = wire({
      mandate: {
        required: true,
        malicious: 'injected',
        isAdmin: true,
      },
      stream: {
        ratePerSecond: '100',
        budgetCap: '10000',
        minDeposit: '1000',
        evil: 'payload',
      },
    });

    const clean = pickRequirementsFields(poisoned);
    const mandate = clean.mandate as unknown as Record<string, unknown>;
    const stream = clean.accepts[0].stream as unknown as Record<string, unknown>;

    expect(mandate.required).toBe(true);
    expect(mandate.malicious).toBeUndefined();
    expect(mandate.isAdmin).toBeUndefined();

    expect(stream.ratePerSecond).toBe('100');
    expect(stream.evil).toBeUndefined();
  });

  it('preserves extensions at both levels (opaque pass-through)', () => {
    const reqs = wire({
      extensions: { custom: 'data', nested: { deep: true }, s402: { version: S402_WIRE_VERSION } },
      accepts: [{ ...VALID_REQUIREMENTS, extra: { extensions: { perEntry: 'data' } } }],
    });

    const clean = pickRequirementsFields(reqs);
    expect((clean.extensions as Record<string, unknown>).custom).toBe('data');
    expect((clean.extensions as Record<string, unknown>).nested).toEqual({ deep: true });
    expect(clean.accepts[0].extensions).toEqual({ perEntry: 'data' });
  });
});

// ══════════════════════════════════════════════════════════════
// ATK-11: SSRF via facilitatorUrl (M-1 patch verification)
// ══════════════════════════════════════════════════════════════

describe('adversarial: SSRF via facilitatorUrl', () => {
  const SSRF_URLS = [
    'file:///etc/passwd',
    'file:///proc/self/environ',
    'gopher://evil.com:6379/_FLUSHALL',
    'ftp://internal.host/sensitive',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(document.cookie)',
  ];

  for (const url of SSRF_URLS) {
    it(`rejects SSRF URL: ${url.slice(0, 40)}...`, () => {
      expect(() => wireValidate({ facilitatorUrl: url })).toThrow(s402Error);
    });
  }

  it('accepts valid https URL', () => {
    expect(() => wireValidate({ facilitatorUrl: 'https://facilitator.example.com/v1/settle' })).not.toThrow();
  });

  it('accepts valid http URL (for dev/testing)', () => {
    expect(() => wireValidate({ facilitatorUrl: 'http://localhost:3000/settle' })).not.toThrow();
  });
});
