import { describe, it, expect } from 'vitest';
import {
  s402Client,
  s402Error,
  S402_VERSION,
  type s402PaymentRequirements,
  type s402PaymentPayload,
} from '../src/index.js';
import type { s402ClientScheme } from '../src/scheme.js';

/** Minimal mock scheme that returns a canned payload */
function mockExactScheme(): s402ClientScheme {
  return {
    scheme: 'exact',
    async createPayment(requirements: s402PaymentRequirements): Promise<s402PaymentPayload> {
      return {
        s402Version: S402_VERSION,
        scheme: 'exact',
        payload: {
          transaction: `tx-for-${requirements.amount}`,
          signature: 'mock-sig',
        },
      };
    },
  };
}

function mockStreamScheme(): s402ClientScheme {
  return {
    scheme: 'stream',
    async createPayment(requirements: s402PaymentRequirements): Promise<s402PaymentPayload> {
      return {
        s402Version: S402_VERSION,
        scheme: 'stream',
        payload: {
          transaction: `stream-tx-${requirements.amount}`,
          signature: 'mock-sig',
        },
      };
    },
  };
}

const REQUIREMENTS: s402PaymentRequirements = {
  s402Version: S402_VERSION,
  accepts: ['exact'],
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0xrecipient',
};

describe('s402Client', () => {
  describe('register', () => {
    it('returns this for chaining', () => {
      const client = new s402Client();
      const result = client.register('sui:testnet', mockExactScheme());
      expect(result).toBe(client);
    });

    it('can register multiple schemes for the same network', () => {
      const client = new s402Client();
      client
        .register('sui:testnet', mockExactScheme())
        .register('sui:testnet', mockStreamScheme());

      expect(client.supports('sui:testnet', 'exact')).toBe(true);
      expect(client.supports('sui:testnet', 'stream')).toBe(true);
    });

    it('can register same scheme on different networks', () => {
      const client = new s402Client();
      client
        .register('sui:testnet', mockExactScheme())
        .register('sui:mainnet', mockExactScheme());

      expect(client.supports('sui:testnet', 'exact')).toBe(true);
      expect(client.supports('sui:mainnet', 'exact')).toBe(true);
    });
  });

  describe('supports', () => {
    it('returns false for unregistered network', () => {
      const client = new s402Client();
      expect(client.supports('sui:testnet', 'exact')).toBe(false);
    });

    it('returns false for unregistered scheme', () => {
      const client = new s402Client();
      client.register('sui:testnet', mockExactScheme());
      expect(client.supports('sui:testnet', 'stream')).toBe(false);
    });
  });

  describe('createPayment', () => {
    it('creates payment with registered scheme', async () => {
      const client = new s402Client();
      client.register('sui:testnet', mockExactScheme());

      const payload = await client.createPayment(REQUIREMENTS);
      expect(payload.scheme).toBe('exact');
      expect(payload.s402Version).toBe(S402_VERSION);
      if (payload.scheme === 'exact') {
        expect(payload.payload.transaction).toBe('tx-for-1000000');
      }
    });

    it('selects first matching scheme from accepts array', async () => {
      const client = new s402Client();
      client
        .register('sui:testnet', mockExactScheme())
        .register('sui:testnet', mockStreamScheme());

      // Server prefers stream, client has both → picks stream
      const streamFirst: s402PaymentRequirements = {
        ...REQUIREMENTS,
        accepts: ['stream', 'exact'],
      };
      const payload = await client.createPayment(streamFirst);
      expect(payload.scheme).toBe('stream');
    });

    it('skips unsupported schemes and picks next match', async () => {
      const client = new s402Client();
      client.register('sui:testnet', mockExactScheme());
      // No stream registered

      const streamFirst: s402PaymentRequirements = {
        ...REQUIREMENTS,
        accepts: ['stream', 'exact'],
      };
      const payload = await client.createPayment(streamFirst);
      // stream not available, falls back to exact
      expect(payload.scheme).toBe('exact');
    });

    it('throws NETWORK_MISMATCH for unregistered network', async () => {
      const client = new s402Client();
      client.register('sui:testnet', mockExactScheme());

      const mainnetReqs: s402PaymentRequirements = {
        ...REQUIREMENTS,
        network: 'sui:mainnet',
      };

      await expect(client.createPayment(mainnetReqs))
        .rejects.toThrow('No schemes registered for network');
    });

    it('throws SCHEME_NOT_SUPPORTED when no scheme matches', async () => {
      const client = new s402Client();
      client.register('sui:testnet', mockExactScheme());

      const streamOnly: s402PaymentRequirements = {
        ...REQUIREMENTS,
        accepts: ['stream'],
      };

      await expect(client.createPayment(streamOnly))
        .rejects.toThrow('No registered scheme matches');
    });

    it('accepts raw x402 V1 input (normalizes through compat)', async () => {
      const client = new s402Client();
      client.register('sui:testnet', mockExactScheme());

      // Pass raw x402 V1 format (maxAmountRequired, no s402Version)
      const rawX402 = {
        x402Version: 1,
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        maxAmountRequired: '500',
        payTo: '0xrecipient',
      };
      const payload = await client.createPayment(rawX402 as any);
      expect(payload.scheme).toBe('exact');
      if (payload.scheme === 'exact') {
        expect(payload.payload.transaction).toBe('tx-for-500');
      }
    });

    it('accepts raw x402 V2 input (normalizes through compat)', async () => {
      const client = new s402Client();
      client.register('sui:testnet', mockExactScheme());

      const rawX402V2 = {
        x402Version: 2,
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '750',
        payTo: '0xrecipient',
      };
      const payload = await client.createPayment(rawX402V2 as any);
      expect(payload.scheme).toBe('exact');
      if (payload.scheme === 'exact') {
        expect(payload.payload.transaction).toBe('tx-for-750');
      }
    });

    it('rejects malformed input through normalizeRequirements', async () => {
      const client = new s402Client();
      client.register('sui:testnet', mockExactScheme());

      await expect(client.createPayment({ garbage: true } as any))
        .rejects.toThrow(s402Error);
    });
  });
});
