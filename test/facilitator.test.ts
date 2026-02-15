import { describe, it, expect, vi } from 'vitest';
import {
  s402Facilitator,
  s402ResourceServer,
  S402_VERSION,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402FacilitatorScheme,
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

  it('throws on unregistered network', async () => {
    const facilitator = new s402Facilitator();

    await expect(
      facilitator.process(PAYLOAD, { ...REQUIREMENTS, network: 'eth:mainnet' }),
    ).rejects.toThrow('eth:mainnet');
  });

  it('throws on unsupported scheme', async () => {
    const facilitator = new s402Facilitator();
    facilitator.register('sui:testnet', createMockScheme());

    const streamPayload = { ...PAYLOAD, scheme: 'stream' as const, payload: PAYLOAD.payload };

    await expect(
      facilitator.process(streamPayload, REQUIREMENTS),
    ).rejects.toThrow('stream');
  });
});

describe('s402ResourceServer.buildRequirements()', () => {
  it('builds generic requirements with exact always in accepts', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['stream'],
      price: '5000000',
      network: 'sui:testnet',
      payTo: '0xrecipient',
    });

    expect(reqs.s402Version).toBe(S402_VERSION);
    expect(reqs.accepts).toContain('exact');
    expect(reqs.accepts).toContain('stream');
    expect(reqs.amount).toBe('5000000');
    expect(reqs.payTo).toBe('0xrecipient');
    expect(reqs.network).toBe('sui:testnet');
  });

  it('defaults asset to SUI', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['exact'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
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

  it('includes mandate config when provided', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['exact'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      mandate: { required: true, minPerTx: '500' },
    });

    expect(reqs.mandate).toEqual({ required: true, minPerTx: '500' });
  });

  it('includes stream/escrow/seal extras', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['stream'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
      stream: { ratePerSecond: '100', budgetCap: '10000', minDeposit: '1000' },
    });

    expect(reqs.stream?.ratePerSecond).toBe('100');
  });

  it('deduplicates exact in accepts', () => {
    const server = new s402ResourceServer();
    const reqs = server.buildRequirements({
      schemes: ['exact', 'stream', 'exact'],
      price: '1000',
      network: 'sui:testnet',
      payTo: '0x1',
    });

    const exactCount = reqs.accepts.filter(s => s === 'exact').length;
    expect(exactCount).toBe(1);
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
