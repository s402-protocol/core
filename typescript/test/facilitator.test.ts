import { describe, it, expect, vi } from 'vitest';
import {
  s402Facilitator,
  s402ResourceServer,
  S402_VERSION,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402FacilitatorScheme,
  type s402ServerScheme,
} from '../src/index.js';

// ONE `accepts[]` entry: a requirement offers a single scheme in wire v2.
const REQUIREMENTS: s402PaymentRequirements = {
  scheme: 'exact',
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: '0xabc',
};

/** The resource the buildPaymentRequired() tests below are paying for. */
const RESOURCE = { url: 'https://api.example.com/paid' };

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

describe('s402Facilitator utilities', () => {
  it('supports() returns true for registered scheme', () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    expect(facilitator.supports('sui:testnet', 'exact')).toBe(true);
  });

  it('supports() returns false for unregistered', () => {
    const facilitator = new s402Facilitator();
    expect(facilitator.supports('sui:testnet', 'exact')).toBe(false);
  });

  it('supportedSchemes() lists registered schemes', () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());
    expect(facilitator.supportedSchemes('sui:testnet')).toEqual(['exact']);
  });

  it('supportedSchemes() returns empty for unknown network', () => {
    const facilitator = new s402Facilitator();
    expect(facilitator.supportedSchemes('sui:mainnet')).toEqual([]);
  });
});

describe('s402Facilitator', () => {
  it('process() rejects expired requirements', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const expiredReqs: s402PaymentRequirements = {
      ...REQUIREMENTS,
      expiresAt: Date.now() - 1000, // 1 second ago
    };

    const result = await facilitator.process(PAYLOAD, expiredReqs);

    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
  });

  it('process() allows non-expired requirements', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const futureReqs: s402PaymentRequirements = {
      ...REQUIREMENTS,
      expiresAt: Date.now() + 60_000, // 1 minute from now
    };

    const result = await facilitator.process(PAYLOAD, futureReqs);

    expect(result.success).toBe(true);
    expect(result.txDigest).toBe('ABC123');
  });

  it('process() allows requirements without expiresAt', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);

    expect(result.success).toBe(true);
  });

  it('process() returns error when verify fails', async () => {
    const mockScheme = createMockScheme();
    (mockScheme.verify as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
      invalidReason: 'Bad signature',
    });

    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', mockScheme);

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Bad signature');
    expect(result.errorCode).toBe('VERIFICATION_FAILED');
  });

  it('returns failure on unregistered network (H-1: no unhandled rejection)', async () => {
    const facilitator = new s402Facilitator();

    const result = await facilitator.process(PAYLOAD, { ...REQUIREMENTS, network: 'eth:mainnet' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('eth:mainnet');
    expect(result.errorCode).toBe('NETWORK_MISMATCH');
  });

  it('process() rejects non-numeric expiresAt (type-safety)', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    // String expiresAt would silently bypass: Date.now() > "never" === false
    const badReqs = {
      ...REQUIREMENTS,
      expiresAt: 'never' as unknown as number,
    };

    const result = await facilitator.process(PAYLOAD, badReqs);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_PAYLOAD');
    expect(result.error).toContain('Invalid expiresAt');
  });

  it('process() rejects NaN expiresAt', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const badReqs = {
      ...REQUIREMENTS,
      expiresAt: NaN,
    };

    const result = await facilitator.process(PAYLOAD, badReqs);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_PAYLOAD');
  });

  it('returns error when payload scheme not in requirements.accepts', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const, payload: PAYLOAD.payload };

    const result = await facilitator.process(streamPayload, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCHEME_NOT_SUPPORTED');
    expect(result.error).toContain('stream');
    expect(result.error).toContain('exact');
  });
});

describe('s402Facilitator skipVerify (V6)', () => {
  it('process({ skipVerify: true }) skips verify and goes straight to settle', async () => {
    const mockScheme = createMockScheme();
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', mockScheme);

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS, { skipVerify: true });

    expect(result.success).toBe(true);
    expect(result.txDigest).toBe('ABC123');
    // verify should NOT have been called
    expect(mockScheme.verify).not.toHaveBeenCalled();
    // settle SHOULD have been called
    expect(mockScheme.settle).toHaveBeenCalledOnce();
  });

  it('process({ skipVerify: true }) still rejects expired requirements', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const expiredReqs: s402PaymentRequirements = {
      ...REQUIREMENTS,
      expiresAt: Date.now() - 1000,
    };

    const result = await facilitator.process(PAYLOAD, expiredReqs, { skipVerify: true });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
  });

  it('process({ skipVerify: true }) still rejects scheme mismatch', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const, payload: PAYLOAD.payload };
    const result = await facilitator.process(streamPayload, REQUIREMENTS, { skipVerify: true });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCHEME_NOT_SUPPORTED');
  });

  it('process({ skipVerify: true }) still returns settle failures', async () => {
    const mockScheme = createMockScheme();
    (mockScheme.settle as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('RPC timeout'));
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', mockScheme);

    const result = await facilitator.process(PAYLOAD, REQUIREMENTS, { skipVerify: true });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SETTLEMENT_FAILED');
    expect(result.error).toContain('RPC timeout');
  });

  it('process() without options still calls verify (backwards compat)', async () => {
    const mockScheme = createMockScheme();
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', mockScheme);

    await facilitator.process(PAYLOAD, REQUIREMENTS);
    expect(mockScheme.verify).toHaveBeenCalledOnce();
    expect(mockScheme.settle).toHaveBeenCalledOnce();
  });
});

describe('s402Facilitator timer cleanup', () => {
  it('process() clears verify timeout after fast resolution (no timer leak)', async () => {
    const facilitator = new s402Facilitator();
    const mockScheme = createMockScheme();
    // Verify resolves instantly — the 5s timeout timer should be cleared
    (mockScheme.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: true });
    (mockScheme.settle as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, txDigest: 'X' });
    facilitator.register('sui:testnet', mockScheme);

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    await facilitator.process(PAYLOAD, REQUIREMENTS);

    // Both verify and settle timers should be cleared (2 calls)
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    clearTimeoutSpy.mockRestore();
  });

  it('process() clears settle timeout even when settle rejects', async () => {
    const facilitator = new s402Facilitator();
    const mockScheme = createMockScheme();
    (mockScheme.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: true });
    (mockScheme.settle as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('RPC failed'));
    facilitator.register('sui:testnet', mockScheme);

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const result = await facilitator.process(PAYLOAD, REQUIREMENTS);

    expect(result.success).toBe(false);
    // Both timers should still be cleared (verify succeeded, settle failed)
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    clearTimeoutSpy.mockRestore();
  });
});

describe('s402Facilitator verify/settle expiration (A-25)', () => {
  it('verify() rejects expired requirements', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const expiredReqs: s402PaymentRequirements = {
      ...REQUIREMENTS,
      expiresAt: Date.now() - 1000,
    };

    const result = await facilitator.verify(PAYLOAD, expiredReqs);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('expired');
  });

  it('verify() allows non-expired requirements', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const futureReqs: s402PaymentRequirements = {
      ...REQUIREMENTS,
      expiresAt: Date.now() + 60_000,
    };

    const result = await facilitator.verify(PAYLOAD, futureReqs);
    expect(result.valid).toBe(true);
  });

  it('settle() rejects expired requirements', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const expiredReqs: s402PaymentRequirements = {
      ...REQUIREMENTS,
      expiresAt: Date.now() - 1000,
    };

    const result = await facilitator.settle(PAYLOAD, expiredReqs);
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
  });

  it('settle() allows non-expired requirements', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const result = await facilitator.settle(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(true);
  });
});

describe('s402Facilitator standalone verify/settle guards', () => {
  it('verify() returns invalid for unregistered network', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const result = await facilitator.verify(PAYLOAD, { ...REQUIREMENTS, network: 'eth:mainnet' });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('eth:mainnet');
  });

  it('verify() returns invalid for scheme mismatch', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const, payload: { transaction: 'tx', signature: 'sig' } };
    const result = await facilitator.verify(streamPayload, REQUIREMENTS);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('not accepted');
  });

  it('settle() returns failure for unregistered network', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const result = await facilitator.settle(PAYLOAD, { ...REQUIREMENTS, network: 'eth:mainnet' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('eth:mainnet');
  });

  it('settle() returns failure for scheme mismatch', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const, payload: { transaction: 'tx', signature: 'sig' } };
    const result = await facilitator.settle(streamPayload, REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SCHEME_NOT_SUPPORTED');
  });

  it('verify() rejects non-number expiresAt', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const result = await facilitator.verify(PAYLOAD, { ...REQUIREMENTS, expiresAt: 'never' as unknown as number });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('Invalid expiresAt');
  });

  it('settle() rejects non-number expiresAt', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const result = await facilitator.settle(PAYLOAD, { ...REQUIREMENTS, expiresAt: 'never' as unknown as number });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_PAYLOAD');
  });
});

describe('s402ResourceServer.buildRequirements()', () => {
  it('builds ONE generic entry for the config\'s first scheme', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['stream'],
      price: '5000000',
      network: 'sui:testnet',
      payTo: '0xrecipient',
      asset: '0x2::sui::SUI',
    });

    // Wire v2: an entry names ONE scheme and carries no `accepts` of its own.
    // Offering several is `buildPaymentRequired`'s job, tested below.
    expect(reqs.scheme).toBe('stream');
    expect('accepts' in reqs).toBe(false);
    expect(reqs.amount).toBe('5000000');
    expect(reqs.payTo).toBe('0xrecipient');
    expect(reqs.network).toBe('sui:testnet');
  });

  it('builds the entry for an explicitly requested scheme', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['stream'],
      price: '5000000',
      network: 'sui:testnet',
      payTo: '0xrecipient',
      asset: '0x2::sui::SUI',
    }, 'exact');

    expect(reqs.scheme).toBe('exact');
  });

  it('passes through asset without chain-specific defaults', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['exact'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
    });

    expect(reqs.asset).toBe('0x2::sui::SUI');
  });

  it('uses provided asset', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['exact'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0xdba::usdc::USDC',
    });

    expect(reqs.asset).toBe('0xdba::usdc::USDC');
  });

  it('leaves mandate off the entry — it is envelope-level now', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['exact'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
      mandate: { required: true, minPerTx: '500' },
    });

    // A mandate authorizes the AGENT, not one price line, so it cannot differ
    // per entry. buildPaymentRequired() hoists it to the envelope.
    expect('mandate' in reqs).toBe(false);
  });

  it('includes stream/escrow/unlock extensions', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['stream'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
      stream: { ratePerSecond: '100', budgetCap: '10000', minDeposit: '1000' },
    });

    expect(reqs.stream?.ratePerSecond).toBe('100');
  });

  it('overrides the scheme a scheme impl names on its own entry', () => {
    const server = new s402ResourceServer();
    const streamServerScheme: s402ServerScheme = {
      scheme: 'stream',
      buildRequirements(config) {
        return {
          scheme: 'escrow', // deliberately names the wrong scheme
          network: config.network,
          asset: config.asset,
          amount: config.price,
          payTo: config.payTo,
        };
      },
    };
    server.register('sui:testnet', streamServerScheme);

    const reqs = server.buildRequirements({
      schemes: ['stream'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
    });

    // A scheme implementation owns its extras; it does not get to change which
    // scheme the entry is for.
    expect(reqs.scheme).toBe('stream');
  });

  it('buildRequirements rejects invalid price', () => {
    const server = new s402ResourceServer();
    expect(() => server.buildRequirements({
      schemes: ['exact'],
      price: 'abc',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
    })).toThrow('Invalid price');
  });

  it('buildRequirements rejects negative price', () => {
    const server = new s402ResourceServer();
    expect(() => server.buildRequirements({
      schemes: ['exact'],
      price: '-100',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
    })).toThrow('Invalid price');
  });

});

describe('s402ResourceServer.buildPaymentRequired()', () => {
  it('wraps one accepts[] entry per offered scheme, exact always and first', () => {
    const server = new s402ResourceServer();
    const required = server.buildPaymentRequired({
      schemes: ['stream'],
      price: '5000000',
      network: 'sui:testnet',
      payTo: '0xrecipient',
      asset: '0x2::sui::SUI',
    }, RESOURCE);

    expect(required.x402Version).toBe(2);
    expect(required.resource).toEqual(RESOURCE);
    // exact FIRST: an x402 client pays the first entry it has a handler for.
    expect(required.accepts.map((a) => a.scheme)).toEqual(['exact', 'stream']);
    expect(required.accepts[0].amount).toBe('5000000');
    expect(required.accepts[0].payTo).toBe('0xrecipient');
    expect(required.accepts[0].network).toBe('sui:testnet');
  });

  it('deduplicates exact across the accepts[] entries', () => {
    const server = new s402ResourceServer();
    const required = server.buildPaymentRequired({
      schemes: ['exact', 'stream', 'exact'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
    }, RESOURCE);

    const exactCount = required.accepts.filter((a) => a.scheme === 'exact').length;
    expect(exactCount).toBe(1);
    expect(required.accepts.map((a) => a.scheme)).toEqual(['exact', 'stream']);
  });

  it('hoists the mandate to the envelope, off every entry', () => {
    const server = new s402ResourceServer();
    const required = server.buildPaymentRequired({
      schemes: ['stream'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
      mandate: { required: true, minPerTx: '500' },
    }, RESOURCE);

    expect(required.mandate).toEqual({ required: true, minPerTx: '500' });
    for (const entry of required.accepts) {
      expect('mandate' in entry).toBe(false);
    }
  });

  it('omits mandate entirely when the route does not configure one', () => {
    const server = new s402ResourceServer();
    const required = server.buildPaymentRequired({
      schemes: ['exact'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
    }, RESOURCE);

    expect(required.mandate).toBeUndefined();
  });

  it('rejects an invalid price before it reaches the wire', () => {
    const server = new s402ResourceServer();
    expect(() => server.buildPaymentRequired({
      schemes: ['exact'],
      price: 'abc',
      network: 'sui:testnet',
      payTo: '0x1',
      asset: '0x2::sui::SUI',
    }, RESOURCE)).toThrow('Invalid price');
  });
});

describe('s402ResourceServer.process()', () => {
  it('delegates to facilitator.process() with expiration guard', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const server = new s402ResourceServer();
    server.setFacilitator(facilitator);

    const result = await server.process(PAYLOAD, REQUIREMENTS);
    expect(result.success).toBe(true);
    expect(result.txDigest).toBe('ABC123');
  });

  it('rejects expired requirements via process()', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const server = new s402ResourceServer();
    server.setFacilitator(facilitator);

    const expiredReqs: s402PaymentRequirements = {
      ...REQUIREMENTS,
      expiresAt: Date.now() - 1000,
    };

    const result = await server.process(PAYLOAD, expiredReqs);
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('throws when no facilitator configured', async () => {
    const server = new s402ResourceServer();

    await expect(
      server.process(PAYLOAD, REQUIREMENTS),
    ).rejects.toThrow('No facilitator configured');
  });
});
