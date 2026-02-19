import { describe, it, expect } from 'vitest';
import {
  s402Error,
  S402_VERSION,
  type s402PaymentRequirements,
  type s402ExactPayload,
} from '../src/index.js';
import {
  fromX402Requirements,
  fromX402Payload,
  fromX402Envelope,
  toX402Requirements,
  toX402Payload,
  isS402,
  isX402,
  isX402Envelope,
  normalizeRequirements,
  type x402PaymentRequirements,
  type x402PaymentRequiredEnvelope,
} from '../src/compat.js';

const VALID_PAY_TO = '0x' + 'a'.repeat(64);

// x402 V2 format (uses `amount`)
const SAMPLE_X402_V2: x402PaymentRequirements = {
  x402Version: 2,
  scheme: 'exact',
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: '0xabc',
};

// x402 V1 format (uses `maxAmountRequired`)
const SAMPLE_X402_V1: x402PaymentRequirements = {
  x402Version: 1,
  scheme: 'exact',
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  maxAmountRequired: '1000000000',
  payTo: '0xabc',
  resource: 'https://api.example.com/data',
  description: 'API access',
};

const SAMPLE_S402: s402PaymentRequirements = {
  s402Version: S402_VERSION,
  accepts: ['exact', 'stream'],
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: VALID_PAY_TO,
  facilitatorUrl: 'https://facilitator.example.com',
  protocolFeeBps: 50,
  mandate: { required: true },
};

describe('s402 compat layer', () => {
  describe('fromX402Requirements', () => {
    it('converts x402 V2 (amount) to s402 format', () => {
      const s402 = fromX402Requirements(SAMPLE_X402_V2);

      expect(s402.s402Version).toBe('1');
      expect(s402.accepts).toEqual(['exact']);
      expect(s402.network).toBe('sui:testnet');
      expect(s402.amount).toBe('1000000000');
      expect(s402.payTo).toBe('0xabc');
    });

    it('converts x402 V1 (maxAmountRequired) to s402 format', () => {
      const s402 = fromX402Requirements(SAMPLE_X402_V1);

      expect(s402.s402Version).toBe('1');
      expect(s402.accepts).toEqual(['exact']);
      expect(s402.amount).toBe('1000000000');
      expect(s402.payTo).toBe('0xabc');
    });

    it('throws on x402 missing both amount and maxAmountRequired', () => {
      const broken = { x402Version: 1, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', payTo: '0xabc' };
      expect(() => fromX402Requirements(broken as any)).toThrow(s402Error);
      expect(() => fromX402Requirements(broken as any)).toThrow('missing both');
    });

    it('rejects non-numeric amount', () => {
      const bad = { x402Version: 1, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: 'abc', payTo: '0xabc' };
      expect(() => fromX402Requirements(bad as any)).toThrow(s402Error);
      expect(() => fromX402Requirements(bad as any)).toThrow('Invalid amount');
    });

    it('rejects negative maxAmountRequired', () => {
      const bad = { x402Version: 1, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', maxAmountRequired: '-100', payTo: '0xabc' };
      expect(() => fromX402Requirements(bad as any)).toThrow('Invalid amount');
    });

    it('prefers amount over maxAmountRequired when both present', () => {
      const both: x402PaymentRequirements = {
        x402Version: 2,
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '200',
        maxAmountRequired: '100',
        payTo: '0xabc',
      };
      const s402 = fromX402Requirements(both);
      expect(s402.amount).toBe('200');
    });
  });

  describe('toX402Requirements', () => {
    it('converts s402 to x402 V1 format with maxAmountRequired', () => {
      const x402 = toX402Requirements(SAMPLE_S402);

      expect(x402.x402Version).toBe(1);
      expect(x402.scheme).toBe('exact');
      expect(x402.network).toBe('sui:testnet');
      // Both V1 (maxAmountRequired) and V2 (amount) for maximum interop
      expect(x402.maxAmountRequired).toBe('1000000000');
      expect(x402.amount).toBe('1000000000');
      // Required V1 fields default
      expect(x402.maxTimeoutSeconds).toBe(60);
      expect(x402.resource).toBe('');
      expect(x402.description).toBe('');
      // facilitatorUrl is preserved (it exists in x402 V1 schema)
      expect(x402.facilitatorUrl).toBe('https://facilitator.example.com');
      // s402-only fields should NOT be present
      expect('mandate' in x402).toBe(false);
      expect('protocolFeeBps' in x402).toBe(false);
      expect('accepts' in x402).toBe(false);
    });

    it('accepts overrides for x402 V1 fields', () => {
      const x402 = toX402Requirements(SAMPLE_S402, {
        maxTimeoutSeconds: 30,
        resource: '/api/data',
        description: 'Premium API access',
      });

      expect(x402.maxTimeoutSeconds).toBe(30);
      expect(x402.resource).toBe('/api/data');
      expect(x402.description).toBe('Premium API access');
      // Other fields unchanged
      expect(x402.amount).toBe('1000000000');
    });
  });

  describe('roundtrip', () => {
    it('fromX402(toX402(s402)) preserves x402-compatible fields', () => {
      const x402 = toX402Requirements(SAMPLE_S402);
      const roundtripped = fromX402Requirements(x402);

      expect(roundtripped.network).toBe(SAMPLE_S402.network);
      expect(roundtripped.asset).toBe(SAMPLE_S402.asset);
      expect(roundtripped.amount).toBe(SAMPLE_S402.amount);
      expect(roundtripped.payTo).toBe(SAMPLE_S402.payTo);
      // facilitatorUrl is preserved through the roundtrip (it exists in x402 V1 schema)
      expect(roundtripped.facilitatorUrl).toBe(SAMPLE_S402.facilitatorUrl);
    });

    it('roundtrip strips s402-only fields', () => {
      const x402 = toX402Requirements(SAMPLE_S402);
      const roundtripped = fromX402Requirements(x402);

      // mandate was s402-only, gets stripped in x402 conversion
      expect(roundtripped.mandate).toBeUndefined();
      expect(roundtripped.protocolFeeBps).toBeUndefined();
    });
  });

  describe('payload conversion', () => {
    it('fromX402Payload converts to s402 exact payload', () => {
      const x402Payload = {
        x402Version: 1,
        scheme: 'exact',
        payload: { transaction: 'txbytes', signature: 'sig' },
      };
      const s402 = fromX402Payload(x402Payload);

      expect(s402.s402Version).toBe('1');
      expect(s402.scheme).toBe('exact');
      expect(s402.payload.transaction).toBe('txbytes');
    });

    it('toX402Payload converts exact payload', () => {
      const s402Payload: s402ExactPayload = {
        s402Version: S402_VERSION,
        scheme: 'exact',
        payload: { transaction: 'txbytes', signature: 'sig' },
      };
      const x402 = toX402Payload(s402Payload);

      expect(x402).not.toBeNull();
      expect(x402!.x402Version).toBe(1);
      expect(x402!.payload.transaction).toBe('txbytes');
    });

    it('toX402Payload returns null for non-exact schemes', () => {
      const streamPayload = {
        s402Version: S402_VERSION as typeof S402_VERSION,
        scheme: 'stream' as const,
        payload: { transaction: 'tx', signature: 'sig' },
      };
      expect(toX402Payload(streamPayload)).toBeNull();
    });
  });

  describe('detection helpers', () => {
    it('isS402 detects s402 objects', () => {
      expect(isS402({ s402Version: '1' })).toBe(true);
      expect(isS402({ x402Version: 1 })).toBe(false);
      expect(isS402({})).toBe(false);
    });

    it('isX402 detects x402 objects', () => {
      expect(isX402({ x402Version: 1 })).toBe(true);
      expect(isX402({ s402Version: '1' })).toBe(false);
      // Object with both fields is s402 (superset)
      expect(isX402({ x402Version: 1, s402Version: '1' })).toBe(false);
    });
  });

  describe('normalizeRequirements', () => {
    it('passes through s402 requirements', () => {
      const result = normalizeRequirements({ s402Version: '1', accepts: ['exact'], network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '100', payTo: VALID_PAY_TO });
      expect(result.s402Version).toBe('1');
    });

    it('converts x402 V2 requirements (amount)', () => {
      const result = normalizeRequirements({ x402Version: 2, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '100', payTo: VALID_PAY_TO });
      expect(result.s402Version).toBe('1');
      expect(result.accepts).toEqual(['exact']);
      expect(result.amount).toBe('100');
    });

    it('converts x402 V1 requirements (maxAmountRequired)', () => {
      const result = normalizeRequirements({ x402Version: 1, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', maxAmountRequired: '500', payTo: VALID_PAY_TO });
      expect(result.s402Version).toBe('1');
      expect(result.accepts).toEqual(['exact']);
      expect(result.amount).toBe('500');
    });

    it('throws s402Error on unknown format', () => {
      expect(() => normalizeRequirements({ foo: 'bar' })).toThrow(s402Error);
      expect(() => normalizeRequirements({ foo: 'bar' })).toThrow('Unrecognized');
    });

    it('throws s402Error on s402 object missing required fields', () => {
      expect(() => normalizeRequirements({ s402Version: '1' })).toThrow(s402Error);
      expect(() => normalizeRequirements({ s402Version: '1' })).toThrow('missing');
    });

    it('throws s402Error listing all missing fields', () => {
      try {
        normalizeRequirements({ s402Version: '1', accepts: ['exact'] });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        const msg = (e as InstanceType<typeof s402Error>).message;
        expect(msg).toContain('network');
        expect(msg).toContain('asset');
        expect(msg).toContain('amount');
        expect(msg).toContain('payTo');
      }
    });

    it('accepts valid s402 object with all required fields', () => {
      const result = normalizeRequirements({
        s402Version: '1',
        accepts: ['exact'],
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '100',
        payTo: VALID_PAY_TO,
      });
      expect(result.network).toBe('sui:testnet');
    });

    it('strips unknown top-level keys from s402 input (trust boundary)', () => {
      const result = normalizeRequirements({
        s402Version: '1',
        accepts: ['exact'],
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '100',
        payTo: VALID_PAY_TO,
        __proto__hack: 'malicious',
        unknownField: 42,
        extensions: { safe: true },
      });
      expect(result.network).toBe('sui:testnet');
      expect((result as any).__proto__hack).toBeUndefined();
      expect((result as any).unknownField).toBeUndefined();
      // Known field 'extensions' should survive
      expect(result.extensions).toEqual({ safe: true });
    });

    it('preserves all known optional fields through normalization', () => {
      const result = normalizeRequirements({
        s402Version: '1',
        accepts: ['exact'],
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '100',
        payTo: VALID_PAY_TO,
        facilitatorUrl: 'https://example.com',
        protocolFeeBps: 50,
        expiresAt: Date.now() + 60000,
        receiptRequired: true,
        settlementMode: 'direct',
      });
      expect(result.facilitatorUrl).toBe('https://example.com');
      expect(result.protocolFeeBps).toBe(50);
      expect(result.receiptRequired).toBe(true);
      expect(result.settlementMode).toBe('direct');
    });

    it('rejects empty accepts array in s402 format', () => {
      expect(() => normalizeRequirements({
        s402Version: '1', accepts: [], network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: '100', payTo: VALID_PAY_TO,
      })).toThrow('at least one scheme');
    });

    it('rejects protocolFeeBps > 10000 in s402 format', () => {
      expect(() => normalizeRequirements({
        s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: '100', payTo: VALID_PAY_TO,
        protocolFeeBps: 99999,
      })).toThrow('protocolFeeBps');
    });

    it('rejects string expiresAt in s402 format', () => {
      expect(() => normalizeRequirements({
        s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: '100', payTo: VALID_PAY_TO,
        expiresAt: 'never',
      })).toThrow('expiresAt must be a positive finite number');
    });

    it('throws s402Error on x402 object missing required fields', () => {
      expect(() => normalizeRequirements({ x402Version: 1 })).toThrow(s402Error);
      expect(() => normalizeRequirements({ x402Version: 1 })).toThrow('Malformed x402');
    });

    it('throws s402Error listing all missing x402 fields', () => {
      try {
        normalizeRequirements({ x402Version: 1, scheme: 'exact' });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        const msg = (e as InstanceType<typeof s402Error>).message;
        expect(msg).toContain('network');
        expect(msg).toContain('asset');
        expect(msg).toContain('payTo');
        expect(msg).toContain('amount or maxAmountRequired');
      }
    });

    it('rejects s402 with non-numeric amount', () => {
      expect(() => normalizeRequirements({
        s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: 'hello', payTo: VALID_PAY_TO,
      })).toThrow(s402Error);
      expect(() => normalizeRequirements({
        s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: 'hello', payTo: VALID_PAY_TO,
      })).toThrow('Invalid amount');
    });

    it('rejects x402 with non-numeric amount', () => {
      expect(() => normalizeRequirements({
        x402Version: 1, scheme: 'exact', network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: '-50', payTo: VALID_PAY_TO,
      })).toThrow(s402Error);
      expect(() => normalizeRequirements({
        x402Version: 1, scheme: 'exact', network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: '-50', payTo: VALID_PAY_TO,
      })).toThrow('Invalid amount');
    });

    it('rejects s402 with leading zeros in amount', () => {
      expect(() => normalizeRequirements({
        s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: '007', payTo: VALID_PAY_TO,
      })).toThrow('Invalid amount');
    });

    it('rejects x402 with leading zeros in amount', () => {
      expect(() => normalizeRequirements({
        x402Version: 1, scheme: 'exact', network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: '0100', payTo: VALID_PAY_TO,
      })).toThrow('Invalid amount');
    });

    it('accepts x402 V1 with only maxAmountRequired (no amount)', () => {
      const result = normalizeRequirements({
        x402Version: 1,
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        maxAmountRequired: '999',
        payTo: VALID_PAY_TO,
      });
      expect(result.amount).toBe('999');
    });

    it('converts x402 V2 envelope (accepts array)', () => {
      const envelope = {
        x402Version: 2,
        accepts: [
          { scheme: 'exact', network: 'eip155:8453', asset: '0x2::sui::SUI', amount: '5000', payTo: '0xvendor' },
        ],
      };
      const result = normalizeRequirements(envelope as Record<string, unknown>);
      expect(result.s402Version).toBe('1');
      expect(result.accepts).toEqual(['exact']);
      expect(result.amount).toBe('5000');
      expect(result.payTo).toBe('0xvendor');
    });

    it('converts x402 V2 envelope with multiple accepts (picks first)', () => {
      const envelope = {
        x402Version: 2,
        accepts: [
          { scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1000', payTo: '0xfirst' },
          { scheme: 'exact', network: 'eip155:1', asset: 'ETH', amount: '9999', payTo: '0xsecond' },
        ],
      };
      const result = normalizeRequirements(envelope as Record<string, unknown>);
      expect(result.amount).toBe('1000');
      expect(result.payTo).toBe('0xfirst');
    });

    it('throws on x402 V2 envelope with empty accepts', () => {
      const envelope = { x402Version: 2, accepts: [] };
      expect(() => normalizeRequirements(envelope as Record<string, unknown>)).toThrow(s402Error);
      expect(() => normalizeRequirements(envelope as Record<string, unknown>)).toThrow('empty accepts');
    });
  });

  describe('x402 V2 envelope', () => {
    it('isX402Envelope detects envelope pattern', () => {
      expect(isX402Envelope({ x402Version: 2, accepts: [{}] })).toBe(true);
      expect(isX402Envelope({ x402Version: 1, scheme: 'exact' })).toBe(false);
      expect(isX402Envelope({ s402Version: '1', accepts: ['exact'] })).toBe(false);
    });

    it('fromX402Envelope extracts first requirement', () => {
      const envelope: x402PaymentRequiredEnvelope = {
        x402Version: 2,
        accepts: [
          { x402Version: 2, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '777', payTo: '0xtest' },
        ],
        resource: { url: '/api/data', mimeType: 'application/json' },
      };
      const result = fromX402Envelope(envelope);
      expect(result.s402Version).toBe('1');
      expect(result.amount).toBe('777');
      expect(result.network).toBe('sui:testnet');
    });

    it('fromX402Envelope throws on empty accepts', () => {
      const envelope: x402PaymentRequiredEnvelope = {
        x402Version: 2,
        accepts: [],
      };
      expect(() => fromX402Envelope(envelope)).toThrow('empty accepts');
    });

    it('fromX402Envelope rejects malformed inner requirement', () => {
      const envelope: x402PaymentRequiredEnvelope = {
        x402Version: 2,
        accepts: [
          { scheme: 'exact', network: 'sui:testnet' } as any, // missing asset, amount, payTo
        ],
      };
      expect(() => fromX402Envelope(envelope)).toThrow(s402Error);
      expect(() => fromX402Envelope(envelope)).toThrow('Malformed x402');
    });

    it('fromX402Envelope rejects non-numeric amount in inner requirement', () => {
      const envelope: x402PaymentRequiredEnvelope = {
        x402Version: 2,
        accepts: [
          { scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: 'not-a-number', payTo: '0xabc' } as any,
        ],
      };
      expect(() => fromX402Envelope(envelope)).toThrow('Invalid amount');
    });
  });
});
