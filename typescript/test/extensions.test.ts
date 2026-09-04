import { describe, it, expect, vi } from 'vitest';
import {
  s402ExtensionRegistry,
  getExtensionData,
  setExtensionData,
  runExtensionHooks,
  type s402FacilitatorExtension,
  type s402Extension,
  s402Facilitator,
  S402_VERSION,
  s402Error,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402FacilitatorScheme,
} from '../src/index.js';

// ── Test fixtures ──────────────────────────────────

const REQUIREMENTS: s402PaymentRequirements = {
  scheme: 'exact',
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

function createMockScheme(): s402FacilitatorScheme {
  return {
    scheme: 'exact',
    verify: vi.fn().mockResolvedValue({ valid: true, payerAddress: '0xpayer' }),
    settle: vi.fn().mockResolvedValue({ success: true, txDigest: 'ABC123' }),
  };
}

function createExtension(
  key: string,
  overrides?: Partial<s402FacilitatorExtension>,
): s402FacilitatorExtension {
  return {
    key,
    version: '1.0.0',
    critical: false,
    ...overrides,
  };
}

// ── Extension data helpers ─────────────────────────

describe('getExtensionData', () => {
  it('returns typed data for existing key', () => {
    const extensions = { 'org.s402.test': { foo: 'bar' } };
    const data = getExtensionData<{ foo: string }>(extensions, 'org.s402.test');
    expect(data).toEqual({ foo: 'bar' });
  });

  it('returns undefined for missing key', () => {
    const data = getExtensionData<string>({ other: 'val' }, 'org.s402.test');
    expect(data).toBeUndefined();
  });

  it('returns undefined for undefined extensions', () => {
    const data = getExtensionData<string>(undefined, 'org.s402.test');
    expect(data).toBeUndefined();
  });
});

describe('setExtensionData', () => {
  it('creates a new extensions object when undefined', () => {
    const result = setExtensionData(undefined, 'org.s402.test', { a: 1 });
    expect(result).toEqual({ 'org.s402.test': { a: 1 } });
  });

  it('preserves existing data when adding', () => {
    const existing = { 'org.s402.other': 'val' };
    const result = setExtensionData(existing, 'org.s402.test', 42);
    expect(result).toEqual({ 'org.s402.other': 'val', 'org.s402.test': 42 });
  });

  it('does not mutate the original', () => {
    const existing = { 'org.s402.other': 'val' };
    setExtensionData(existing, 'org.s402.test', 42);
    expect(existing).toEqual({ 'org.s402.other': 'val' });
  });
});

// ── Extension registry ─────────────────────────────

describe('s402ExtensionRegistry', () => {
  it('registers and retrieves extensions', () => {
    const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
    const ext = createExtension('org.s402.test');
    registry.register(ext);
    expect(registry.get('org.s402.test')).toBe(ext);
    expect(registry.size).toBe(1);
  });

  it('rejects duplicate keys', () => {
    const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
    registry.register(createExtension('org.s402.test'));
    expect(() => registry.register(createExtension('org.s402.test'))).toThrow(s402Error);
  });

  it('sorts extensions without dependencies in registration order', () => {
    const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
    registry.register(createExtension('alpha'));
    registry.register(createExtension('beta'));
    registry.register(createExtension('gamma'));
    const sorted = registry.sorted();
    expect(sorted.map(e => e.key)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('sorts extensions respecting dependsOn', () => {
    const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
    registry.register(createExtension('auth'));
    registry.register(createExtension('analytics', { dependsOn: ['auth'] }));
    const sorted = registry.sorted();
    expect(sorted.map(e => e.key)).toEqual(['auth', 'analytics']);
  });

  it('handles diamond dependencies', () => {
    const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
    // D depends on B and C; both B and C depend on A
    registry.register(createExtension('A'));
    registry.register(createExtension('B', { dependsOn: ['A'] }));
    registry.register(createExtension('C', { dependsOn: ['A'] }));
    registry.register(createExtension('D', { dependsOn: ['B', 'C'] }));
    const sorted = registry.sorted();
    const keys = sorted.map(e => e.key);
    // A must come before B and C; B and C must come before D
    expect(keys.indexOf('A')).toBeLessThan(keys.indexOf('B'));
    expect(keys.indexOf('A')).toBeLessThan(keys.indexOf('C'));
    expect(keys.indexOf('B')).toBeLessThan(keys.indexOf('D'));
    expect(keys.indexOf('C')).toBeLessThan(keys.indexOf('D'));
  });

  it('throws on dependency cycle', () => {
    const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
    registry.register(createExtension('A', { dependsOn: ['B'] }));
    registry.register(createExtension('B', { dependsOn: ['A'] }));
    // Cycle is detected when sorted() is called (lazily)
    expect(() => registry.sorted()).toThrow(/cycle/i);
  });

  it('throws on missing dependency', () => {
    const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
    registry.register(createExtension('A', { dependsOn: ['nonexistent'] }));
    // Missing dependency detected when sorted() is called (lazily)
    expect(() => registry.sorted()).toThrow(/nonexistent/);
  });

  it('caches sorted result until new registration', () => {
    const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
    registry.register(createExtension('A'));
    const first = registry.sorted();
    const second = registry.sorted();
    expect(first).toBe(second); // same reference = cached
  });
});

// ── runExtensionHooks ──────────────────────────────

describe('runExtensionHooks', () => {
  it('runs hooks in order', async () => {
    const order: string[] = [];
    const extensions: s402Extension[] = [
      { key: 'A', version: '1', critical: false },
      { key: 'B', version: '1', critical: false },
    ];
    await runExtensionHooks(extensions, 'test', async (ext) => {
      order.push(ext.key);
    });
    expect(order).toEqual(['A', 'B']);
  });

  it('critical extension failure throws s402Error', async () => {
    const extensions: s402Extension[] = [
      { key: 'crit', version: '1', critical: true },
    ];
    await expect(
      runExtensionHooks(extensions, 'test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(s402Error);
  });

  it('advisory extension failure calls error handler and continues', async () => {
    const errorHandler = vi.fn();
    const order: string[] = [];
    const extensions: s402Extension[] = [
      { key: 'advisory', version: '1', critical: false },
      { key: 'after', version: '1', critical: false },
    ];
    await runExtensionHooks(
      extensions,
      'test',
      async (ext) => {
        if (ext.key === 'advisory') throw new Error('non-critical');
        order.push(ext.key);
      },
      errorHandler,
    );
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(order).toEqual(['after']); // second extension still ran
  });

  it('critical failure stops further extensions from running', async () => {
    const order: string[] = [];
    const extensions: s402Extension[] = [
      { key: 'crit', version: '1', critical: true },
      { key: 'after', version: '1', critical: false },
    ];
    await expect(
      runExtensionHooks(extensions, 'test', async (ext) => {
        order.push(ext.key);
        if (ext.key === 'crit') throw new Error('block');
      }),
    ).rejects.toThrow();
    expect(order).toEqual(['crit']); // 'after' never ran
  });
});

// ── Facilitator integration ────────────────────────

describe('s402Facilitator extension integration', () => {
  it('beforeVerify hook blocks process when critical', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    facilitator.registerExtension(createExtension('org.s402.blocker', {
      critical: true,
      beforeVerify: vi.fn().mockRejectedValue(new Error('rate limited')),
    }));

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('EXTENSION_FAILED');
    expect(result.error).toContain('rate limited');
  });

  it('advisory beforeVerify failure does not block', async () => {
    const errorHandler = vi.fn();
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    facilitator.onExtensionError(errorHandler);
    facilitator.registerExtension(createExtension('org.s402.advisory', {
      critical: false,
      beforeVerify: vi.fn().mockRejectedValue(new Error('analytics down')),
    }));

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(true);
    expect(errorHandler).toHaveBeenCalledOnce();
  });

  it('afterVerify hook fires after successful verify', async () => {
    const afterVerify = vi.fn().mockResolvedValue(undefined);
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    facilitator.registerExtension(createExtension('org.s402.logger', {
      afterVerify,
    }));

    await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(afterVerify).toHaveBeenCalledOnce();
    // afterVerify receives the verify result
    expect(afterVerify.mock.calls[0][1]).toEqual({ valid: true, payerAddress: '0xpayer' });
  });

  it('beforeSettle hook fires even with skipVerify', async () => {
    const beforeSettle = vi.fn().mockResolvedValue(undefined);
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    facilitator.registerExtension(createExtension('org.s402.fraud', {
      beforeSettle,
    }));

    await facilitator.process(PAYLOAD, REQUIREMENTS, { skipVerify: true });
    expect(beforeSettle).toHaveBeenCalledOnce();
  });

  it('afterSettle hook fires after successful settlement', async () => {
    const afterSettle = vi.fn().mockResolvedValue(undefined);
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    facilitator.registerExtension(createExtension('org.s402.analytics', {
      afterSettle,
    }));

    await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(afterSettle).toHaveBeenCalledOnce();
    expect(afterSettle.mock.calls[0][1]).toEqual({ success: true, txDigest: 'ABC123' });
  });

  it('afterSettle failure does not change successful result', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    facilitator.registerExtension(createExtension('org.s402.bad-analytics', {
      critical: true,
      afterSettle: vi.fn().mockRejectedValue(new Error('analytics crash')),
    }));

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);
    // Settlement succeeded; afterSettle failure must NOT change the result
    expect(result.success).toBe(true);
    expect(result.txDigest).toBe('ABC123');
  });

  it('hooks fire in dependency order', async () => {
    const order: string[] = [];
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    facilitator.registerExtension(createExtension('dep', {
      beforeVerify: vi.fn().mockImplementation(async () => { order.push('dep'); }),
    }));
    facilitator.registerExtension(createExtension('consumer', {
      dependsOn: ['dep'],
      beforeVerify: vi.fn().mockImplementation(async () => { order.push('consumer'); }),
    }));

    await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(order).toEqual(['dep', 'consumer']);
  });

  it('no extensions = zero overhead (no hook calls)', async () => {
    const mockScheme = createMockScheme();
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', mockScheme);

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(true);
    // Only verify + settle should have been called — no extension overhead
    expect(mockScheme.verify).toHaveBeenCalledOnce();
    expect(mockScheme.settle).toHaveBeenCalledOnce();
  });

  it('registerExtension returns this for chaining', () => {
    const facilitator = new s402Facilitator();
    const result = facilitator.registerExtension(createExtension('A'));
    expect(result).toBe(facilitator);
  });

  it('registerExtension rejects duplicate keys', () => {
    const facilitator = new s402Facilitator();
    facilitator.registerExtension(createExtension('A'));
    expect(() => facilitator.registerExtension(createExtension('A'))).toThrow(s402Error);
  });

  it('skipVerify=true skips beforeVerify and afterVerify hooks', async () => {
    const beforeVerify = vi.fn().mockResolvedValue(undefined);
    const afterVerify = vi.fn().mockResolvedValue(undefined);
    const beforeSettle = vi.fn().mockResolvedValue(undefined);
    const afterSettle = vi.fn().mockResolvedValue(undefined);

    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    facilitator.registerExtension(createExtension('org.s402.all-hooks', {
      beforeVerify, afterVerify, beforeSettle, afterSettle,
    }));

    await facilitator.process(PAYLOAD, REQUIREMENTS, { skipVerify: true });
    expect(beforeVerify).not.toHaveBeenCalled();
    expect(afterVerify).not.toHaveBeenCalled();
    expect(beforeSettle).toHaveBeenCalledOnce();
    expect(afterSettle).toHaveBeenCalledOnce();
  });

  it('all 4 hooks fire in order on normal process', async () => {
    const order: string[] = [];
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    facilitator.registerExtension(createExtension('org.s402.lifecycle', {
      beforeVerify: vi.fn().mockImplementation(async () => { order.push('beforeVerify'); }),
      afterVerify: vi.fn().mockImplementation(async () => { order.push('afterVerify'); }),
      beforeSettle: vi.fn().mockImplementation(async () => { order.push('beforeSettle'); }),
      afterSettle: vi.fn().mockImplementation(async () => { order.push('afterSettle'); }),
    }));

    await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(order).toEqual(['beforeVerify', 'afterVerify', 'beforeSettle', 'afterSettle']);
  });

  it('afterVerify does not fire when verify fails', async () => {
    const afterVerify = vi.fn().mockResolvedValue(undefined);
    const mockScheme = createMockScheme();
    (mockScheme.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: false, invalidReason: 'bad' });

    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', mockScheme);
    facilitator.registerExtension(createExtension('org.s402.logger', { afterVerify }));

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(afterVerify).not.toHaveBeenCalled();
  });

  it('afterSettle does not fire when settle fails', async () => {
    const afterSettle = vi.fn().mockResolvedValue(undefined);
    const mockScheme = createMockScheme();
    (mockScheme.settle as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'RPC fail' });

    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', mockScheme);
    facilitator.registerExtension(createExtension('org.s402.analytics', { afterSettle }));

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(afterSettle).not.toHaveBeenCalled();
  });

  it('critical beforeSettle blocks settlement', async () => {
    const mockScheme = createMockScheme();
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', mockScheme);
    facilitator.registerExtension(createExtension('org.s402.fraud', {
      critical: true,
      beforeSettle: vi.fn().mockRejectedValue(new Error('fraud detected')),
    }));

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('EXTENSION_FAILED');
    expect(result.error).toContain('fraud detected');
    expect(mockScheme.settle).not.toHaveBeenCalled();
  });

  it('advisory failure without error handler does not throw', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    // No onExtensionError handler registered
    facilitator.registerExtension(createExtension('org.s402.optional', {
      critical: false,
      beforeVerify: vi.fn().mockRejectedValue(new Error('no handler')),
    }));

    // Should not throw — advisory failure silently continues
    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(true);
  });
});
