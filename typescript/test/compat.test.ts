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
  fromS402V1Requirements,
  toX402Requirements,
  toX402Payload,
  toX402V2Requirements,
  toX402V2Envelope,
  isS402,
  isX402,
  isX402Envelope,
  normalizeRequirements,
  type x402PaymentRequirements,
  type x402PaymentRequiredEnvelope,
} from '../src/compat/x402.js';

const VALID_PAY_TO = '0x' + 'a'.repeat(64);

/** `resource` is mandatory on an x402 V2 envelope, so every V2 fixture carries one. */
const RESOURCE = { url: 'https://api.example.com/paid' };

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

// ONE `accepts[]` entry. Since wire v2 a requirement names a single scheme;
// offering several is what the envelope's `accepts[]` array is for.
const SAMPLE_S402: s402PaymentRequirements = {
  scheme: 'exact',
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: VALID_PAY_TO,
  facilitatorUrl: 'https://facilitator.example.com',
  protocolFeeBps: 50,
  receiptRequired: true,
};

describe('s402 compat layer', () => {
  describe('fromX402Requirements', () => {
    it('converts x402 V2 (amount) to s402 format', () => {
      const s402 = fromX402Requirements(SAMPLE_X402_V2);

      expect(s402.scheme).toBe('exact');
      expect(s402.network).toBe('sui:testnet');
      expect(s402.amount).toBe('1000000000');
      expect(s402.payTo).toBe('0xabc');
    });

    it('converts x402 V1 (maxAmountRequired) to s402 format', () => {
      const s402 = fromX402Requirements(SAMPLE_X402_V1);

      expect(s402.scheme).toBe('exact');
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
      expect('receiptRequired' in x402).toBe(false);
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

      // receiptRequired and protocolFeeBps are s402-only, so the x402 V1
      // projection drops them and they do not come back.
      expect(roundtripped.receiptRequired).toBeUndefined();
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
    it('expands the retired s402 v1 flat shape into an envelope', () => {
      const result = normalizeRequirements({ s402Version: '1', accepts: ['exact'], network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '100', payTo: VALID_PAY_TO });
      expect(result.x402Version).toBe(2);
      expect(result.accepts).toHaveLength(1);
      expect(result.accepts[0].scheme).toBe('exact');
    });

    it('converts x402 V2 requirements (amount)', () => {
      const result = normalizeRequirements({ x402Version: 2, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '100', payTo: VALID_PAY_TO });
      expect(result.x402Version).toBe(2);
      expect(result.accepts[0].scheme).toBe('exact');
      expect(result.accepts[0].amount).toBe('100');
    });

    it('converts x402 V1 requirements (maxAmountRequired)', () => {
      const result = normalizeRequirements({ x402Version: 1, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', maxAmountRequired: '500', payTo: VALID_PAY_TO });
      expect(result.x402Version).toBe(2);
      expect(result.accepts[0].scheme).toBe('exact');
      expect(result.accepts[0].amount).toBe('500');
    });

    it('throws s402Error on unknown format', () => {
      expect(() => normalizeRequirements({ foo: 'bar' })).toThrow(s402Error);
      expect(() => normalizeRequirements({ foo: 'bar' })).toThrow('Unrecognized');
    });

    it('throws s402Error on s402 object missing required fields', () => {
      expect(() => normalizeRequirements({ s402Version: '1' })).toThrow(s402Error);
      expect(() => normalizeRequirements({ s402Version: '1' })).toThrow('non-empty accepts array');
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
      expect(result.accepts[0].network).toBe('sui:testnet');
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
      expect(result.accepts[0].network).toBe('sui:testnet');
      expect((result as any).__proto__hack).toBeUndefined();
      expect((result.accepts[0] as any).__proto__hack).toBeUndefined();
      expect((result as any).unknownField).toBeUndefined();
      expect((result.accepts[0] as any).unknownField).toBeUndefined();
      // Known field 'extensions' should survive, on the entry it described
      expect(result.accepts[0].extensions).toEqual({ safe: true });
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
      expect(result.accepts[0].facilitatorUrl).toBe('https://example.com');
      expect(result.accepts[0].protocolFeeBps).toBe(50);
      expect(result.accepts[0].receiptRequired).toBe(true);
      expect(result.accepts[0].settlementMode).toBe('direct');
    });

    it('rejects empty accepts array in s402 format', () => {
      expect(() => normalizeRequirements({
        s402Version: '1', accepts: [], network: 'sui:testnet',
        asset: '0x2::sui::SUI', amount: '100', payTo: VALID_PAY_TO,
      })).toThrow('non-empty accepts array');
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
      })).toThrow('invalid amount');
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
      })).toThrow('invalid amount');
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
      expect(result.accepts[0].amount).toBe('999');
    });

    it('converts x402 V2 envelope (accepts array)', () => {
      const envelope = {
        x402Version: 2,
        resource: RESOURCE,
        accepts: [
          { scheme: 'exact', network: 'eip155:8453', asset: '0x2::sui::SUI', amount: '5000', payTo: '0xvendor' },
        ],
      };
      const result = normalizeRequirements(envelope as Record<string, unknown>);
      expect(result.x402Version).toBe(2);
      expect(result.accepts[0].scheme).toBe('exact');
      expect(result.accepts[0].amount).toBe('5000');
      expect(result.accepts[0].payTo).toBe('0xvendor');
    });

    it('converts x402 V2 envelope with multiple accepts (keeps every offer)', () => {
      // Wire v2 keeps the whole menu. Picking one is the CLIENT's job — the
      // decoder that discarded offers here made a payable entry unreachable.
      const envelope = {
        x402Version: 2,
        resource: RESOURCE,
        accepts: [
          { scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1000', payTo: '0xfirst' },
          { scheme: 'exact', network: 'eip155:1', asset: 'ETH', amount: '9999', payTo: '0xsecond' },
        ],
      };
      const result = normalizeRequirements(envelope as Record<string, unknown>);
      expect(result.accepts).toHaveLength(2);
      expect(result.accepts[0].amount).toBe('1000');
      expect(result.accepts[0].payTo).toBe('0xfirst');
      expect(result.accepts[1].amount).toBe('9999');
      expect(result.accepts[1].payTo).toBe('0xsecond');
    });

    it('gives a foreign x402 402 an expiresAt so S1 has something to read', () => {
      // No `extensions.s402` means the server never heard of s402; without a
      // derived expiry the facilitator's three staleness guards all skip.
      const now = 1_700_000_000_000;
      const result = normalizeRequirements({
        x402Version: 2,
        resource: RESOURCE,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1000', payTo: '0xfirst', maxTimeoutSeconds: 30 }],
      }, now);
      expect(result.accepts[0].expiresAt).toBe(now + 30_000);
    });

    it('leaves an s402-profile 402 expiry alone (it says what it means)', () => {
      const result = normalizeRequirements({
        x402Version: 2,
        resource: RESOURCE,
        accepts: [{ scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO, maxTimeoutSeconds: 30 }],
        extensions: { s402: { version: '2' } },
      }, 1_700_000_000_000);
      expect(result.accepts[0].expiresAt).toBeUndefined();
    });

    it('throws on x402 V2 envelope with empty accepts', () => {
      const envelope = { x402Version: 2, resource: RESOURCE, accepts: [] };
      expect(() => normalizeRequirements(envelope as Record<string, unknown>)).toThrow(s402Error);
      expect(() => normalizeRequirements(envelope as Record<string, unknown>)).toThrow('at least one requirement');
    });

    it('throws on an x402 V2 envelope with no resource', () => {
      const envelope = {
        x402Version: 2,
        accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '1000', payTo: '0xfirst' }],
      };
      expect(() => normalizeRequirements(envelope as Record<string, unknown>)).toThrow('missing resource');
    });
  });

  describe('x402 V2 envelope', () => {
    it('isX402Envelope detects envelope pattern', () => {
      expect(isX402Envelope({ x402Version: 2, accepts: [{}] })).toBe(true);
      expect(isX402Envelope({ x402Version: 1, scheme: 'exact' })).toBe(false);
      expect(isX402Envelope({ s402Version: '1', accepts: ['exact'] })).toBe(false);
    });

    it('fromX402Envelope decodes the envelope and keeps its resource', () => {
      const envelope: x402PaymentRequiredEnvelope = {
        x402Version: 2,
        accepts: [
          { x402Version: 2, scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '777', payTo: '0xtest' },
        ],
        resource: { url: '/api/data', mimeType: 'application/json' },
      };
      const result = fromX402Envelope(envelope);
      expect(result.x402Version).toBe(2);
      expect(result.resource).toEqual({ url: '/api/data', mimeType: 'application/json' });
      expect(result.accepts[0].amount).toBe('777');
      expect(result.accepts[0].network).toBe('sui:testnet');
      // `x402Version` on the inner requirement is a V1 carry-over — stripped.
      expect((result.accepts[0] as any).x402Version).toBeUndefined();
    });

    it('fromX402Envelope throws on empty accepts', () => {
      const envelope: x402PaymentRequiredEnvelope = {
        x402Version: 2,
        resource: RESOURCE,
        accepts: [],
      };
      expect(() => fromX402Envelope(envelope)).toThrow('at least one requirement');
    });

    it('fromX402Envelope rejects malformed inner requirement', () => {
      const envelope: x402PaymentRequiredEnvelope = {
        x402Version: 2,
        resource: RESOURCE,
        accepts: [
          { scheme: 'exact', network: 'sui:testnet' } as any, // missing asset, amount, payTo
        ],
      };
      expect(() => fromX402Envelope(envelope)).toThrow(s402Error);
      expect(() => fromX402Envelope(envelope)).toThrow('Malformed payment requirements: accepts[0]');
    });

    it('fromX402Envelope rejects non-numeric amount in inner requirement', () => {
      const envelope: x402PaymentRequiredEnvelope = {
        x402Version: 2,
        resource: RESOURCE,
        accepts: [
          { scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: 'not-a-number', payTo: '0xabc' } as any,
        ],
      };
      expect(() => fromX402Envelope(envelope)).toThrow('accepts[0]: invalid amount');
    });
  });

  // ══════════════════════════════════════════════════════════
  // fromS402V1Requirements — the retired flat shape, read-only
  // ══════════════════════════════════════════════════════════

  describe('fromS402V1Requirements', () => {
    const V1 = {
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000000000',
      payTo: VALID_PAY_TO,
    };

    it('decodes a v1 flat document into a wire-v2 envelope', () => {
      const result = fromS402V1Requirements(V1);
      expect(result.x402Version).toBe(2);
      expect(result.accepts).toHaveLength(1);
      expect(result.accepts[0].scheme).toBe('exact');
      expect(result.accepts[0].amount).toBe('1000000000');
      // `s402Version` does not survive — it is not a wire-v2 field.
      expect((result as any).s402Version).toBeUndefined();
    });

    it('expands one accepts[] entry per scheme, exact hoisted first', () => {
      const result = fromS402V1Requirements({ ...V1, accepts: ['prepaid', 'exact'] });
      expect(result.accepts.map((a) => a.scheme)).toEqual(['exact', 'prepaid']);
    });

    it('deduplicates repeated scheme names', () => {
      const result = fromS402V1Requirements({ ...V1, accepts: ['exact', 'prepaid', 'exact'] });
      expect(result.accepts.map((a) => a.scheme)).toEqual(['exact', 'prepaid']);
    });

    it('lands every per-requirement field on every expanded entry', () => {
      const result = fromS402V1Requirements({
        ...V1,
        accepts: ['exact', 'stream'],
        facilitatorUrl: 'https://facilitator.example.com',
        protocolFeeBps: 50,
        receiptRequired: true,
        settlementMode: 'direct',
        extensions: { custom: 'data' },
      });
      expect(result.accepts).toHaveLength(2);
      for (const entry of result.accepts) {
        expect(entry.network).toBe('sui:testnet');
        expect(entry.asset).toBe('0x2::sui::SUI');
        expect(entry.amount).toBe('1000000000');
        expect(entry.payTo).toBe(VALID_PAY_TO);
        expect(entry.facilitatorUrl).toBe('https://facilitator.example.com');
        expect(entry.protocolFeeBps).toBe(50);
        expect(entry.receiptRequired).toBe(true);
        expect(entry.settlementMode).toBe('direct');
        expect(entry.extensions).toEqual({ custom: 'data' });
      }
    });

    it('hoists mandate to the envelope (it authorizes the agent, not a price line)', () => {
      const result = fromS402V1Requirements({ ...V1, accepts: ['exact', 'upto'], mandate: { required: true, minPerTx: '100' } });
      expect(result.mandate).toEqual({ required: true, minPerTx: '100' });
      for (const entry of result.accepts) {
        expect((entry as any).mandate).toBeUndefined();
      }
    });

    it('uses the supplied resource, and an empty url when none is known', () => {
      expect(fromS402V1Requirements(V1).resource).toEqual({ url: '' });
      expect(fromS402V1Requirements(V1, { resource: RESOURCE }).resource).toEqual(RESOURCE);
    });

    it('strips unknown v1 keys at the trust boundary', () => {
      const result = fromS402V1Requirements({ ...V1, unknownField: 42, __proto__hack: 'malicious' });
      expect((result.accepts[0] as any).unknownField).toBeUndefined();
      expect((result.accepts[0] as any).__proto__hack).toBeUndefined();
    });

    it('rejects a document that is not the flat "1" shape', () => {
      expect(() => fromS402V1Requirements({ ...V1, s402Version: '2' })).toThrow(s402Error);
      expect(() => fromS402V1Requirements({ ...V1, s402Version: '2' })).toThrow('fromS402V1Requirements reads the flat "1" shape only');
      expect(() => fromS402V1Requirements(null as any)).toThrow('must be a plain object');
    });

    it('rejects an empty or non-string accepts list', () => {
      expect(() => fromS402V1Requirements({ ...V1, accepts: [] })).toThrow('non-empty accepts array');
      expect(() => fromS402V1Requirements({ ...V1, accepts: ['exact', 42] })).toThrow('expected a non-empty string');
    });

    it('runs the canonical wire validators over the expanded document', () => {
      expect(() => fromS402V1Requirements({ ...V1, amount: '007' })).toThrow('invalid amount');
      expect(() => fromS402V1Requirements({ ...V1, facilitatorUrl: 'file:///etc/passwd' }))
        .toThrow('facilitatorUrl must use https:// or http://');
      expect(() => fromS402V1Requirements({ ...V1, mandate: { required: 'yes' } }))
        .toThrow('mandate.required must be a boolean');
    });
  });

  describe('normalizeRequirements primitive guard', () => {
    it('throws s402Error on null input (not TypeError)', () => {
      expect(() => normalizeRequirements(null as any)).toThrow(s402Error);
      expect(() => normalizeRequirements(null as any)).toThrow('plain object');
    });

    it('throws s402Error on number input (not TypeError)', () => {
      expect(() => normalizeRequirements(42 as any)).toThrow(s402Error);
      expect(() => normalizeRequirements(42 as any)).toThrow('plain object');
    });

    it('throws s402Error on string input (not TypeError)', () => {
      expect(() => normalizeRequirements('hello' as any)).toThrow(s402Error);
      expect(() => normalizeRequirements('hello' as any)).toThrow('plain object');
    });

    it('throws s402Error on boolean input (not TypeError)', () => {
      expect(() => normalizeRequirements(true as any)).toThrow(s402Error);
      expect(() => normalizeRequirements(true as any)).toThrow('plain object');
    });

    it('throws s402Error on array input (not TypeError)', () => {
      expect(() => normalizeRequirements([] as any)).toThrow(s402Error);
      expect(() => normalizeRequirements([] as any)).toThrow('plain object');
    });

    it('throws s402Error on undefined input (not TypeError)', () => {
      expect(() => normalizeRequirements(undefined as any)).toThrow(s402Error);
      expect(() => normalizeRequirements(undefined as any)).toThrow('plain object');
    });
  });
});

// ══════════════════════════════════════════════════════════════
// x402 V2 write path: toX402V2Requirements + toX402V2Envelope
// ══════════════════════════════════════════════════════════════

describe('toX402V2Requirements (write path)', () => {
  const SAMPLE_S402: s402PaymentRequirements = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x' + 'd'.repeat(40),
    amount: '10000',
    payTo: '0x' + 'a'.repeat(40),
  };

  it('emits V2 shape with required extra field and no V1 carry-over', () => {
    const v2 = toX402V2Requirements(SAMPLE_S402);
    expect(v2).toEqual({
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x' + 'd'.repeat(40),
      amount: '10000',
      payTo: '0x' + 'a'.repeat(40),
      maxTimeoutSeconds: 60,
      extra: {},
    });
    expect('x402Version' in v2).toBe(false);
    expect('maxAmountRequired' in v2).toBe(false);
    expect('resource' in v2).toBe(false);
    expect('description' in v2).toBe(false);
  });

  it('defaults maxTimeoutSeconds to 60 and extra to empty object', () => {
    const v2 = toX402V2Requirements(SAMPLE_S402);
    expect(v2.maxTimeoutSeconds).toBe(60);
    expect(v2.extra).toEqual({});
  });

  it('respects custom maxTimeoutSeconds + extra overrides', () => {
    const v2 = toX402V2Requirements(SAMPLE_S402, {
      maxTimeoutSeconds: 120,
      extra: { permit2Address: '0x' + 'b'.repeat(40) },
    });
    expect(v2.maxTimeoutSeconds).toBe(120);
    expect(v2.extra).toEqual({ permit2Address: '0x' + 'b'.repeat(40) });
  });

  it('projects a non-exact scheme instead of refusing it', () => {
    // Wire v2 made every s402 scheme expressible as an x402 requirement. An
    // x402 client with no `prepaid` handler skips the entry — which is what
    // `accepts[]` is FOR — so refusing to emit it was the stricter error.
    const prepaidS402: s402PaymentRequirements = {
      ...SAMPLE_S402,
      scheme: 'prepaid',
      prepaid: { ratePerCall: '100', minDeposit: '1000', withdrawalDelayMs: '86400000' },
    };
    const v2 = toX402V2Requirements(prepaidS402);
    expect(v2.scheme).toBe('prepaid');
    expect(v2.amount).toBe('10000');
    expect(v2.extra.prepaid).toEqual({ ratePerCall: '100', minDeposit: '1000', withdrawalDelayMs: '86400000' });
  });

  it('projects a foreign scheme name verbatim (Postel)', () => {
    const foreign = toX402V2Requirements({ ...SAMPLE_S402, scheme: 'auth-capture' });
    expect(foreign.scheme).toBe('auth-capture');
  });

  it('routes s402-only fields into extra, never onto the entry itself', () => {
    const v2 = toX402V2Requirements({
      ...SAMPLE_S402,
      facilitatorUrl: 'https://facilitator.example.com',
      protocolFeeBps: 50,
      expiresAt: 1_700_000_000_000,
      extensions: { custom: 'data' },
    });
    expect(Object.keys(v2).sort()).toEqual(
      ['amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme'],
    );
    expect(v2.extra).toEqual({
      facilitatorUrl: 'https://facilitator.example.com',
      protocolFeeBps: 50,
      expiresAt: 1_700_000_000_000,
      extensions: { custom: 'data' },
    });
  });
});

describe('toX402V2Envelope (write path)', () => {
  const SAMPLE_S402: s402PaymentRequirements = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x' + 'd'.repeat(40),
    amount: '10000',
    payTo: '0x' + 'a'.repeat(40),
  };

  it('wraps the requirement in a PaymentRequired envelope with x402Version=2', () => {
    const envelope = toX402V2Envelope(SAMPLE_S402, {
      url: 'mcp://tool/summarize',
      description: 'Document summarizer',
    });
    expect(envelope.x402Version).toBe(2);
    expect(envelope.resource).toEqual({
      url: 'mcp://tool/summarize',
      description: 'Document summarizer',
    });
    expect(envelope.accepts).toHaveLength(1);
    expect(envelope.accepts[0].scheme).toBe('exact');
    expect(envelope.accepts[0].extra).toEqual({});
  });

  it('includes optional extensions and error when provided', () => {
    const envelope = toX402V2Envelope(
      SAMPLE_S402,
      { url: 'mcp://tool/summarize' },
      {
        extensions: { sep2007: { multiRail: true } },
        error: 'Optional error string',
      },
    );
    expect(envelope.extensions).toEqual({ sep2007: { multiRail: true } });
    expect(envelope.error).toBe('Optional error string');
  });

  it('accepts an array of offers, one accepts[] entry each, order preserved', () => {
    const envelope = toX402V2Envelope(
      [SAMPLE_S402, { ...SAMPLE_S402, scheme: 'prepaid', payTo: '0x' + 'b'.repeat(40) }],
      { url: 'mcp://tool/summarize' },
    );
    expect(envelope.accepts).toHaveLength(2);
    expect(envelope.accepts.map((a) => a.scheme)).toEqual(['exact', 'prepaid']);
    expect(envelope.accepts[1].payTo).toBe('0x' + 'b'.repeat(40));
  });

  it('requires a non-empty resource.url (mandatory on a V2 envelope)', () => {
    expect(() => toX402V2Envelope(SAMPLE_S402, { url: '' })).toThrow(s402Error);
    expect(() => toX402V2Envelope(SAMPLE_S402, { url: '' })).toThrow('non-empty resource.url');
  });

  it('roundtrips via fromX402Envelope to preserve s402 fields', () => {
    const envelope = toX402V2Envelope(SAMPLE_S402, { url: 'mcp://tool/summarize' });
    const recovered = fromX402Envelope(envelope as unknown as x402PaymentRequiredEnvelope);
    expect(recovered.accepts[0].network).toBe(SAMPLE_S402.network);
    expect(recovered.accepts[0].asset).toBe(SAMPLE_S402.asset);
    expect(recovered.accepts[0].amount).toBe(SAMPLE_S402.amount);
    expect(recovered.accepts[0].payTo).toBe(SAMPLE_S402.payTo);
  });

  it('omits extensions / error when not provided (no undefined keys leak)', () => {
    const envelope = toX402V2Envelope(SAMPLE_S402, { url: 'mcp://tool/summarize' });
    expect('extensions' in envelope).toBe(false);
    expect('error' in envelope).toBe(false);
  });
});
