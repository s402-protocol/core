import { describe, it, expect } from 'vitest';
import {
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  detectProtocol,
  extractRequirementsFromResponse,
  s402Error,
  S402_VERSION,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402SettleResponse,
} from '../src/index.js';

const SAMPLE_REQUIREMENTS: s402PaymentRequirements = {
  s402Version: S402_VERSION,
  accepts: ['exact'],
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: '0xabc123',
};

const SAMPLE_PAYLOAD: s402ExactPayload = {
  s402Version: S402_VERSION,
  scheme: 'exact',
  payload: {
    transaction: 'dHhieXRlcw==',
    signature: 'c2lnbmF0dXJl',
  },
};

const SAMPLE_SETTLE: s402SettleResponse = {
  success: true,
  txDigest: 'ABC123',
  receiptId: '0xreceipt',
  finalityMs: 450,
};

describe('s402 HTTP encode/decode', () => {
  describe('payment requirements roundtrip', () => {
    it('encodes and decodes without loss', () => {
      const encoded = encodePaymentRequired(SAMPLE_REQUIREMENTS);
      expect(typeof encoded).toBe('string');

      const decoded = decodePaymentRequired(encoded);
      expect(decoded.s402Version).toBe('1');
      expect(decoded.network).toBe('sui:testnet');
      expect(decoded.amount).toBe('1000000000');
      expect(decoded.accepts).toEqual(['exact']);
    });
  });

  describe('payment payload roundtrip', () => {
    it('encodes and decodes without loss', () => {
      const encoded = encodePaymentPayload(SAMPLE_PAYLOAD);
      const decoded = decodePaymentPayload(encoded);

      expect(decoded.scheme).toBe('exact');
      expect(decoded.s402Version).toBe('1');
      if (decoded.scheme === 'exact') {
        expect(decoded.payload.transaction).toBe('dHhieXRlcw==');
      }
    });
  });

  describe('settle response roundtrip', () => {
    it('encodes and decodes without loss', () => {
      const encoded = encodeSettleResponse(SAMPLE_SETTLE);
      const decoded = decodeSettleResponse(encoded);

      expect(decoded.success).toBe(true);
      expect(decoded.txDigest).toBe('ABC123');
      expect(decoded.receiptId).toBe('0xreceipt');
      expect(decoded.finalityMs).toBe(450);
    });
  });

  describe('Unicode safety', () => {
    it('handles CJK characters in extra field', () => {
      const reqs: s402PaymentRequirements = {
        ...SAMPLE_REQUIREMENTS,
        extra: { description: '東京での支払い' },
      };
      const encoded = encodePaymentRequired(reqs);
      const decoded = decodePaymentRequired(encoded);
      expect((decoded.extra as Record<string, string>).description).toBe('東京での支払い');
    });

    it('handles emoji in settle response error', () => {
      const settle: s402SettleResponse = {
        success: false,
        error: 'Insufficient balance 💰 — recharge needed',
      };
      const encoded = encodeSettleResponse(settle);
      const decoded = decodeSettleResponse(encoded);
      expect(decoded.error).toBe('Insufficient balance 💰 — recharge needed');
    });

    it('handles mixed Unicode in payment payload', () => {
      const encoded = encodePaymentPayload(SAMPLE_PAYLOAD);
      const decoded = decodePaymentPayload(encoded);
      expect(decoded.scheme).toBe('exact');
    });
  });

  describe('malformed input handling', () => {
    it('decodePaymentRequired throws s402Error on invalid base64', () => {
      expect(() => decodePaymentRequired('!!!invalid!!!')).toThrow(s402Error);
    });

    it('decodePaymentRequired throws s402Error on non-JSON base64', () => {
      expect(() => decodePaymentRequired(btoa('not json'))).toThrow(s402Error);
    });

    it('decodePaymentPayload throws s402Error on garbage', () => {
      expect(() => decodePaymentPayload('')).toThrow(s402Error);
    });

    it('decodeSettleResponse throws s402Error on garbage', () => {
      expect(() => decodeSettleResponse('corrupted')).toThrow(s402Error);
    });

    it('thrown errors have INVALID_PAYLOAD code', () => {
      try {
        decodePaymentRequired('!!!');
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        expect((e as InstanceType<typeof s402Error>).code).toBe('INVALID_PAYLOAD');
        expect((e as InstanceType<typeof s402Error>).retryable).toBe(false);
      }
    });
  });

  describe('payload shape validation', () => {
    it('decodePaymentPayload rejects object missing scheme', () => {
      const bad = btoa(JSON.stringify({ payload: { transaction: 'tx', signature: 'sig' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('missing scheme');
    });

    it('decodePaymentPayload rejects object missing payload', () => {
      const bad = btoa(JSON.stringify({ scheme: 'exact' }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('missing payload');
    });

    it('decodePaymentPayload rejects non-object', () => {
      const bad = btoa(JSON.stringify('just a string'));
      expect(() => decodePaymentPayload(bad)).toThrow('not an object');
    });

    it('decodePaymentPayload rejects null', () => {
      const bad = btoa(JSON.stringify(null));
      expect(() => decodePaymentPayload(bad)).toThrow('not an object');
    });

    it('decodeSettleResponse rejects object missing success', () => {
      const bad = btoa(JSON.stringify({ txDigest: 'ABC' }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('success');
    });

    it('decodeSettleResponse rejects success as non-boolean', () => {
      const bad = btoa(JSON.stringify({ success: 'yes' }));
      expect(() => decodeSettleResponse(bad)).toThrow('success');
    });

    it('decodePaymentPayload rejects unknown scheme', () => {
      const bad = btoa(JSON.stringify({ scheme: 'bancruptcy', payload: { transaction: 'tx', signature: 'sig' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('Unknown payment scheme');
    });

    it('decodePaymentPayload accepts all four valid schemes', () => {
      for (const scheme of ['exact', 'stream', 'escrow', 'seal']) {
        const encoded = btoa(JSON.stringify({ scheme, payload: { transaction: 'tx', signature: 'sig' } }));
        const decoded = decodePaymentPayload(encoded);
        expect(decoded.scheme).toBe(scheme);
      }
    });

    it('decodePaymentPayload accepts valid payload', () => {
      const encoded = encodePaymentPayload(SAMPLE_PAYLOAD);
      const decoded = decodePaymentPayload(encoded);
      expect(decoded.scheme).toBe('exact');
    });

    it('decodeSettleResponse accepts valid response', () => {
      const encoded = encodeSettleResponse(SAMPLE_SETTLE);
      const decoded = decodeSettleResponse(encoded);
      expect(decoded.success).toBe(true);
    });
  });

  describe('requirements shape validation', () => {
    it('decodePaymentRequired rejects object missing required fields', () => {
      const bad = btoa(JSON.stringify({ s402Version: '1' }));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('Malformed payment requirements');
    });

    it('decodePaymentRequired rejects non-object', () => {
      const bad = btoa(JSON.stringify('just a string'));
      expect(() => decodePaymentRequired(bad)).toThrow('not an object');
    });

    it('decodePaymentRequired rejects null', () => {
      const bad = btoa(JSON.stringify(null));
      expect(() => decodePaymentRequired(bad)).toThrow('not an object');
    });

    it('decodePaymentRequired reports all missing fields', () => {
      const bad = btoa(JSON.stringify({ s402Version: '1' }));
      try {
        decodePaymentRequired(bad);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        const msg = (e as Error).message;
        expect(msg).toContain('accepts');
        expect(msg).toContain('network');
        expect(msg).toContain('asset');
        expect(msg).toContain('amount');
        expect(msg).toContain('payTo');
      }
    });

    it('decodePaymentRequired rejects wrong field types', () => {
      const bad = btoa(JSON.stringify({
        s402Version: '1',
        accepts: 'exact', // should be array
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: 1000, // should be string
        payTo: '0xabc',
      }));
      try {
        decodePaymentRequired(bad);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        const msg = (e as Error).message;
        expect(msg).toContain('accepts');
        expect(msg).toContain('amount');
      }
    });

    it('decodePaymentRequired accepts valid requirements', () => {
      const encoded = encodePaymentRequired(SAMPLE_REQUIREMENTS);
      const decoded = decodePaymentRequired(encoded);
      expect(decoded.amount).toBe('1000000000');
      expect(decoded.network).toBe('sui:testnet');
    });
  });

  describe('extractRequirementsFromResponse', () => {
    it('extracts requirements from valid 402 response', () => {
      const headers = new Headers();
      headers.set('payment-required', encodePaymentRequired(SAMPLE_REQUIREMENTS));
      const response = new Response(null, { status: 402, headers });

      const reqs = extractRequirementsFromResponse(response);
      expect(reqs).not.toBeNull();
      expect(reqs!.network).toBe('sui:testnet');
      expect(reqs!.amount).toBe('1000000000');
    });

    it('returns null for response without payment-required header', () => {
      const response = new Response(null, { status: 402 });
      expect(extractRequirementsFromResponse(response)).toBeNull();
    });

    it('returns null for response with invalid base64', () => {
      const headers = new Headers();
      headers.set('payment-required', '!!!garbage!!!');
      const response = new Response(null, { status: 402, headers });

      expect(extractRequirementsFromResponse(response)).toBeNull();
    });
  });

  describe('detectProtocol', () => {
    it('detects s402 from payment-required header', () => {
      const headers = new Headers();
      headers.set('payment-required', encodePaymentRequired(SAMPLE_REQUIREMENTS));
      expect(detectProtocol(headers)).toBe('s402');
    });

    it('detects x402 from x402Version field', () => {
      const x402Req = { x402Version: 1, scheme: 'exact', network: 'sui:testnet' };
      const headers = new Headers();
      headers.set('payment-required', btoa(JSON.stringify(x402Req)));
      expect(detectProtocol(headers)).toBe('x402');
    });

    it('returns unknown for missing header', () => {
      const headers = new Headers();
      expect(detectProtocol(headers)).toBe('unknown');
    });

    it('returns unknown for invalid base64', () => {
      const headers = new Headers();
      headers.set('payment-required', '!!!not-base64!!!');
      expect(detectProtocol(headers)).toBe('unknown');
    });
  });
});
