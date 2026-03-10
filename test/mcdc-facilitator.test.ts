/**
 * MC/DC (Modified Condition/Decision Coverage) tests for s402Facilitator
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONDITION MAP — facilitator.process() (facilitator.ts)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * C1:  requirements.expiresAt != null                  → enter expiry checks
 * C2:  typeof expiresAt !== 'number' || !isFinite()    → INVALID_PAYLOAD
 * C3:  Date.now() > expiresAt                          → REQUIREMENTS_EXPIRED
 * C4:  requirements.accepts exists && length > 0       → enter scheme check
 * C5:  !accepts.includes(payload.scheme)               → SCHEME_NOT_SUPPORTED
 * C6:  resolveScheme throws s402Error                  → return error
 * C7:  resolveScheme throws non-s402Error              → SCHEME_NOT_SUPPORTED
 * C8:  inFlight.has(dedupeKey)                         → INVALID_PAYLOAD (duplicate)
 * C9:  verify throws                                   → VERIFICATION_FAILED
 * C10: verifyResult.valid === false                    → VERIFICATION_FAILED
 * C11: post-verify expiresAt check (TOCTOU guard)     → REQUIREMENTS_EXPIRED
 * C12: settle throws                                   → SETTLEMENT_FAILED
 * C13: all passes → settle succeeds                    → success
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Also covers MC/DC for verify() and settle() standalone methods.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  s402Facilitator,
  S402_VERSION,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402FacilitatorScheme,
} from '../src/index.js';

// ══════════════════════════════════════════════════════════════
// Fixtures
// ══════════════════════════════════════════════════════════════

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

function createMockScheme(overrides: Partial<s402FacilitatorScheme> = {}): s402FacilitatorScheme {
  return {
    scheme: 'exact',
    verify: vi.fn().mockResolvedValue({ valid: true, payerAddress: '0xpayer' }),
    settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'ABC123' }),
    ...overrides,
  };
}

function createFacilitator(scheme = createMockScheme()): s402Facilitator {
  const f = new s402Facilitator();
  f.register('sui:testnet', scheme);
  return f;
}

// ══════════════════════════════════════════════════════════════
// MC/DC: process() — Happy Path
// ══════════════════════════════════════════════════════════════

describe('mcdc: facilitator.process() — happy path', () => {
  it('mcdc-hp: valid payload + requirements → success', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(true);
    expect(result.txDigest).toBe('ABC123');
  });

  it('mcdc-hp: valid with future expiresAt → success', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, { ...REQUIREMENTS, expiresAt: Date.now() + 60_000 });
    expect(result.success).toBe(true);
  });

  it('mcdc-hp: requirements without expiresAt → success (no expiry check)', async () => {
    const f = createFacilitator();
    const { expiresAt: _, ...noExpiry } = REQUIREMENTS;
    const result = await f.process(PAYLOAD, noExpiry as s402PaymentRequirements);
    expect(result.success).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: process() — Isolation Tests
// ══════════════════════════════════════════════════════════════

describe('mcdc: facilitator.process() — isolation tests', () => {
  // C2: typeof expiresAt !== 'number' || !isFinite
  it('mcdc-mc2a: rejects string expiresAt', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, {
      ...REQUIREMENTS,
      expiresAt: 'never' as unknown as number,
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_PAYLOAD');
    expect(result.error).toContain('Invalid expiresAt');
  });

  it('mcdc-mc2b: rejects NaN expiresAt', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, { ...REQUIREMENTS, expiresAt: NaN });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_PAYLOAD');
  });

  it('mcdc-mc2c: rejects Infinity expiresAt', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, { ...REQUIREMENTS, expiresAt: Infinity });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_PAYLOAD');
  });

  it('mcdc-mc2d: rejects boolean expiresAt', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, {
      ...REQUIREMENTS,
      expiresAt: true as unknown as number,
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_PAYLOAD');
  });

  // C3: Date.now() > expiresAt (expired)
  it('mcdc-mc3a: rejects requirements expired 1ms ago', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, { ...REQUIREMENTS, expiresAt: Date.now() - 1 });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
  });

  it('mcdc-mc3b: rejects requirements expired 1 hour ago', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, { ...REQUIREMENTS, expiresAt: Date.now() - 3_600_000 });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
  });

  // C5: payload scheme not in accepts
  it('mcdc-mc5a: rejects scheme not in accepts', async () => {
    const f = createFacilitator();
    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const, payload: PAYLOAD.payload };
    const result = await f.process(streamPayload, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCHEME_NOT_SUPPORTED');
    expect(result.error).toContain('stream');
    expect(result.error).toContain('exact');
  });

  it('mcdc-mc5b: accepts scheme in multi-scheme accepts', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, { ...REQUIREMENTS, accepts: ['exact', 'stream'] });
    expect(result.success).toBe(true);
  });

  // C6: resolveScheme throws s402Error (unregistered network)
  it('mcdc-mc6: rejects unregistered network', async () => {
    const f = createFacilitator();
    const result = await f.process(PAYLOAD, { ...REQUIREMENTS, network: 'eth:mainnet' });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('NETWORK_MISMATCH');
  });

  // C7: resolveScheme throws for unregistered scheme on registered network
  it('mcdc-mc7: rejects unregistered scheme on registered network', async () => {
    const f = createFacilitator();
    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const };
    const result = await f.process(streamPayload, { ...REQUIREMENTS, accepts: ['exact', 'stream'] });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCHEME_NOT_SUPPORTED');
  });

  // C8: duplicate in-flight dedup
  it('mcdc-mc8: rejects duplicate concurrent request', async () => {
    // Create a scheme that takes time to verify
    const scheme = createMockScheme({
      verify: vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ valid: true }), 100))),
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'X' }),
    });
    const f = createFacilitator(scheme);

    // Fire two identical requests concurrently
    const [r1, r2] = await Promise.all([
      f.process(PAYLOAD, REQUIREMENTS),
      f.process(PAYLOAD, REQUIREMENTS),
    ]);

    // Exactly one should succeed, one should be rejected as duplicate
    const results = [r1, r2];
    const successes = results.filter(r => r.success);
    const dupes = results.filter(r => !r.success && r.error?.includes('Duplicate'));
    expect(successes.length).toBe(1);
    expect(dupes.length).toBe(1);
  });

  it('mcdc-mc8b: dedup key is cleaned up after completion (can resubmit)', async () => {
    const f = createFacilitator();

    const r1 = await f.process(PAYLOAD, REQUIREMENTS);
    expect(r1.success).toBe(true);

    // Same payload should work again after first completes
    const r2 = await f.process(PAYLOAD, REQUIREMENTS);
    expect(r2.success).toBe(true);
  });

  // C9: verify throws
  it('mcdc-mc9a: handles verify throwing Error', async () => {
    const scheme = createMockScheme({
      verify: vi.fn().mockRejectedValue(new Error('RPC connection refused')),
    });
    const f = createFacilitator(scheme);
    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VERIFICATION_FAILED');
    expect(result.error).toContain('RPC connection refused');
  });

  it('mcdc-mc9b: handles verify throwing non-Error', async () => {
    const scheme = createMockScheme({
      verify: vi.fn().mockRejectedValue('string error'),
    });
    const f = createFacilitator(scheme);
    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VERIFICATION_FAILED');
  });

  // C10: verify returns valid=false
  it('mcdc-mc10a: handles verify returning invalid with reason', async () => {
    const scheme = createMockScheme({
      verify: vi.fn().mockResolvedValue({ valid: false, invalidReason: 'Bad signature' }),
    });
    const f = createFacilitator(scheme);
    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VERIFICATION_FAILED');
    expect(result.error).toBe('Bad signature');
  });

  it('mcdc-mc10b: handles verify returning invalid without reason', async () => {
    const scheme = createMockScheme({
      verify: vi.fn().mockResolvedValue({ valid: false }),
    });
    const f = createFacilitator(scheme);
    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VERIFICATION_FAILED');
    expect(result.error).toBe('Payment verification failed');
  });

  // C11: TOCTOU — requirements expire between verify and settle
  it('mcdc-mc11: rejects when requirements expire during verification (TOCTOU guard)', async () => {
    // Set expiresAt to 50ms in the future — verify takes 100ms, so it expires between verify and settle
    const expiresAt = Date.now() + 50;
    const scheme = createMockScheme({
      verify: vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ valid: true }), 100))
      ),
    });
    const f = createFacilitator(scheme);
    const result = await f.process(PAYLOAD, { ...REQUIREMENTS, expiresAt });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
    expect(result.error).toContain('expired during verification');
  });

  // C12: settle throws
  it('mcdc-mc12a: handles settle throwing Error', async () => {
    const scheme = createMockScheme({
      settle: vi.fn().mockRejectedValue(new Error('Gas budget exhausted')),
    });
    const f = createFacilitator(scheme);
    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SETTLEMENT_FAILED');
    expect(result.error).toContain('Gas budget exhausted');
  });

  it('mcdc-mc12b: handles settle throwing non-Error', async () => {
    const scheme = createMockScheme({
      settle: vi.fn().mockRejectedValue({ code: 'unknown' }),
    });
    const f = createFacilitator(scheme);
    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SETTLEMENT_FAILED');
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: verify() standalone
// ══════════════════════════════════════════════════════════════

describe('mcdc: facilitator.verify() — isolation tests', () => {
  it('mcdc-hp: valid verify returns valid=true', async () => {
    const f = createFacilitator();
    const result = await f.verify(PAYLOAD, REQUIREMENTS);
    expect(result.valid).toBe(true);
  });

  it('mcdc-mc1: verify rejects string expiresAt', async () => {
    const f = createFacilitator();
    const result = await f.verify(PAYLOAD, {
      ...REQUIREMENTS,
      expiresAt: 'soon' as unknown as number,
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('Invalid expiresAt');
  });

  it('mcdc-mc2: verify rejects expired requirements', async () => {
    const f = createFacilitator();
    const result = await f.verify(PAYLOAD, { ...REQUIREMENTS, expiresAt: Date.now() - 1000 });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('expired');
  });

  it('mcdc-mc3: verify rejects scheme not in accepts', async () => {
    const f = createFacilitator();
    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const };
    const result = await f.verify(streamPayload, REQUIREMENTS);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('not accepted');
  });

  it('mcdc-mc4: verify handles unregistered network gracefully', async () => {
    const f = createFacilitator();
    const result = await f.verify(PAYLOAD, { ...REQUIREMENTS, network: 'sol:mainnet' });
    expect(result.valid).toBe(false);
  });

  it('mcdc-mc5: verify handles scheme throwing non-s402Error', async () => {
    const f = new s402Facilitator();
    const result = await f.verify(PAYLOAD, REQUIREMENTS);
    expect(result.valid).toBe(false);
  });

  it('mcdc-mc6: verify accepts when expiresAt is undefined (no expiry)', async () => {
    const f = createFacilitator();
    const { expiresAt: _, ...noExpiry } = REQUIREMENTS;
    const result = await f.verify(PAYLOAD, noExpiry as s402PaymentRequirements);
    expect(result.valid).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: settle() standalone
// ══════════════════════════════════════════════════════════════

describe('mcdc: facilitator.settle() — isolation tests', () => {
  it('mcdc-hp: valid settle returns success', async () => {
    const f = createFacilitator();
    const result = await f.settle(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(true);
    expect(result.txDigest).toBe('ABC123');
  });

  it('mcdc-mc1: settle rejects string expiresAt', async () => {
    const f = createFacilitator();
    const result = await f.settle(PAYLOAD, {
      ...REQUIREMENTS,
      expiresAt: 'never' as unknown as number,
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_PAYLOAD');
  });

  it('mcdc-mc2: settle rejects expired requirements', async () => {
    const f = createFacilitator();
    const result = await f.settle(PAYLOAD, { ...REQUIREMENTS, expiresAt: Date.now() - 1000 });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
  });

  it('mcdc-mc3: settle rejects scheme not in accepts', async () => {
    const f = createFacilitator();
    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const };
    const result = await f.settle(streamPayload, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCHEME_NOT_SUPPORTED');
  });

  it('mcdc-mc4: settle handles unregistered network', async () => {
    const f = createFacilitator();
    const result = await f.settle(PAYLOAD, { ...REQUIREMENTS, network: 'sol:mainnet' });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('NETWORK_MISMATCH');
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: Timeout behavior (H-3)
// ══════════════════════════════════════════════════════════════

describe('mcdc: facilitator.process() — timeout behavior', () => {
  it('mcdc-timeout1: verify timeout (5s) triggers VERIFICATION_FAILED', async () => {
    const scheme = createMockScheme({
      verify: vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
    });
    const f = createFacilitator(scheme);

    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VERIFICATION_FAILED');
    expect(result.error).toContain('timed out');
  }, 10_000);

  it('mcdc-timeout2: settle timeout (15s) triggers SETTLEMENT_FAILED', async () => {
    const scheme = createMockScheme({
      verify: vi.fn().mockResolvedValue({ valid: true }),
      settle: vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
    });
    const f = createFacilitator(scheme);

    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SETTLEMENT_FAILED');
    expect(result.error).toContain('timed out');
  }, 20_000);
});

// ══════════════════════════════════════════════════════════════
// MC/DC: Registration and dispatch
// ══════════════════════════════════════════════════════════════

describe('mcdc: facilitator registration', () => {
  it('register is chainable', () => {
    const f = new s402Facilitator();
    const result = f.register('sui:testnet', createMockScheme());
    expect(result).toBe(f);
  });

  it('supports multiple networks', async () => {
    const f = new s402Facilitator();
    f.register('sui:testnet', createMockScheme());
    f.register('sui:mainnet', createMockScheme());

    expect(f.supports('sui:testnet', 'exact')).toBe(true);
    expect(f.supports('sui:mainnet', 'exact')).toBe(true);
    expect(f.supports('eth:mainnet', 'exact')).toBe(false);
  });

  it('supports multiple schemes on same network', () => {
    const f = new s402Facilitator();
    f.register('sui:testnet', createMockScheme());
    f.register('sui:testnet', { ...createMockScheme(), scheme: 'stream' });

    expect(f.supportedSchemes('sui:testnet')).toEqual(['exact', 'stream']);
  });

  it('later registration overwrites earlier for same network+scheme', async () => {
    const scheme1 = createMockScheme({
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'FIRST' }),
    });
    const scheme2 = createMockScheme({
      settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'SECOND' }),
    });

    const f = new s402Facilitator();
    f.register('sui:testnet', scheme1);
    f.register('sui:testnet', scheme2);

    const result = await f.process(PAYLOAD, REQUIREMENTS);
    expect(result.txDigest).toBe('SECOND');
  });
});

// ══════════════════════════════════════════════════════════════
// Dedup cleanup: inFlight Set does not leak
// ══════════════════════════════════════════════════════════════

describe('mcdc: facilitator dedup cleanup', () => {
  it('dedup key removed after verify failure', async () => {
    const scheme = createMockScheme({
      verify: vi.fn().mockResolvedValue({ valid: false, invalidReason: 'bad' }),
    });
    const f = createFacilitator(scheme);

    await f.process(PAYLOAD, REQUIREMENTS);
    // Should be able to resubmit (key was cleaned up in finally block)
    const r2 = await f.process(PAYLOAD, REQUIREMENTS);
    expect(r2.success).toBe(false); // still fails verify, but NOT duplicate
    expect(r2.errorCode).toBe('VERIFICATION_FAILED');
  });

  it('dedup key removed after settle failure', async () => {
    const scheme = createMockScheme({
      settle: vi.fn().mockRejectedValue(new Error('gas')),
    });
    const f = createFacilitator(scheme);

    await f.process(PAYLOAD, REQUIREMENTS);
    const r2 = await f.process(PAYLOAD, REQUIREMENTS);
    expect(r2.errorCode).toBe('SETTLEMENT_FAILED'); // NOT duplicate
  });

  it('dedup key removed after expiry rejection', async () => {
    const f = createFacilitator();
    const expired = { ...REQUIREMENTS, expiresAt: Date.now() - 1000 };

    await f.process(PAYLOAD, expired);
    // Different payload should also work (but we test same payload resubmission)
    const r2 = await f.process(PAYLOAD, expired);
    expect(r2.errorCode).toBe('REQUIREMENTS_EXPIRED'); // NOT duplicate
  });
});
