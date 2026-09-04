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
  isValidAmount,
  isValidU64Amount,
  S402_CONTENT_TYPE,
  encodeRequirementsBody,
  decodeRequirementsBody,
  encodePayloadBody,
  decodePayloadBody,
  encodeSettleBody,
  decodeSettleBody,
  detectTransport,
  s402Error,
  S402_VERSION,
  type s402PaymentRequired,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402SettleResponse,
} from '../src/index.js';

const VALID_PAY_TO = '0x' + 'a'.repeat(64);

const RESOURCE_URL = 'https://api.example.com/paid';

/** One `accepts[]` entry — the offer of a single scheme. */
const SAMPLE_OFFER: s402PaymentRequirements = {
  scheme: 'exact',
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: VALID_PAY_TO,
};

/** The 402 document: an x402 V2 `PaymentRequired` envelope (ADR-016). */
const SAMPLE_REQUIREMENTS: s402PaymentRequired = {
  x402Version: 2,
  resource: { url: RESOURCE_URL },
  accepts: [SAMPLE_OFFER],
};

/**
 * Hand-build the WIRE envelope, the way a peer would put it on the network.
 *
 * `flat` names entry fields by their in-memory names; the x402-owned six stay
 * on the entry and everything s402 adds is routed into that entry's `extra`,
 * which is where it actually travels. `env` overrides envelope-level keys.
 */
const ENTRY_KEYS = ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds'];
function wire(
  flat: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({
    scheme: 'exact',
    network: 'sui:testnet',
    asset: '0x2::sui::SUI',
    amount: '1000000000',
    payTo: VALID_PAY_TO,
    ...flat,
  })) {
    (ENTRY_KEYS.includes(k) ? entry : extra)[k] = v;
  }
  entry.extra = extra;
  return {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [entry],
    extensions: { s402: { version: '2' } },
    ...env,
  };
}

/** The same wire envelope, base64'd for a `payment-required` header. */
const wireHeader = (
  flat: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
): string => btoa(JSON.stringify(wire(flat, env)));

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

describe('isValidAmount barrel export', () => {
  it('is exported from the s402 barrel', () => {
    expect(typeof isValidAmount).toBe('function');
  });

  it('validates canonical non-negative integers', () => {
    expect(isValidAmount('0')).toBe(true);
    expect(isValidAmount('1000000000')).toBe(true);
    expect(isValidAmount('18446744073709551615')).toBe(true); // u64 max
    expect(isValidAmount('-1')).toBe(false);
    expect(isValidAmount('007')).toBe(false);
    expect(isValidAmount('abc')).toBe(false);
    expect(isValidAmount('')).toBe(false);
    expect(isValidAmount('1.5')).toBe(false);
  });
});

describe('isValidU64Amount boundary values', () => {
  it('accepts exact u64 max (2^64 - 1)', () => {
    expect(isValidU64Amount('18446744073709551615')).toBe(true);
  });

  it('rejects u64 max + 1', () => {
    expect(isValidU64Amount('18446744073709551616')).toBe(false);
  });

  it('rejects u64 max - 1 digit length but lexicographically greater', () => {
    // 20-digit number starting with '2' > u64 max starting with '1'
    expect(isValidU64Amount('20000000000000000000')).toBe(false);
  });

  it('accepts u64 max - 1', () => {
    expect(isValidU64Amount('18446744073709551614')).toBe(true);
  });

  it('accepts zero', () => {
    expect(isValidU64Amount('0')).toBe(true);
  });

  it('rejects negative numbers', () => {
    expect(isValidU64Amount('-1')).toBe(false);
  });

  it('rejects values longer than 20 digits', () => {
    expect(isValidU64Amount('184467440737095516150')).toBe(false); // 21 digits
  });
});

describe('s402 HTTP encode/decode', () => {
  describe('payment requirements roundtrip', () => {
    it('encodes and decodes without loss', () => {
      const encoded = encodePaymentRequired(SAMPLE_REQUIREMENTS);
      expect(typeof encoded).toBe('string');

      const decoded = decodePaymentRequired(encoded);
      expect(decoded.x402Version).toBe(2);
      expect(decoded.resource.url).toBe(RESOURCE_URL);
      expect(decoded.accepts).toHaveLength(1);
      expect(decoded.accepts[0].scheme).toBe('exact');
      expect(decoded.accepts[0].network).toBe('sui:testnet');
      expect(decoded.accepts[0].amount).toBe('1000000000');
    });

    it('marks the 402 as an s402-profile 402 via extensions.s402', () => {
      const parsed = JSON.parse(atob(encodePaymentRequired(SAMPLE_REQUIREMENTS)));
      expect(parsed.extensions.s402).toEqual({ version: '2' });
      // The retired flat shape is gone from the wire entirely.
      expect('s402Version' in parsed).toBe(false);
      expect(parsed.accepts[0].scheme).toBe('exact');
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
    it('handles CJK characters in extensions field', () => {
      const reqs: s402PaymentRequired = {
        ...SAMPLE_REQUIREMENTS,
        accepts: [{ ...SAMPLE_OFFER, extensions: { description: '東京での支払い' } }],
      };
      const encoded = encodePaymentRequired(reqs);
      const decoded = decodePaymentRequired(encoded);
      expect((decoded.accepts[0].extensions as Record<string, string>).description).toBe('東京での支払い');
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

    it('decodePaymentRequired rejects oversized header', () => {
      const huge = 'A'.repeat(65 * 1024); // > 64KB
      expect(() => decodePaymentRequired(huge)).toThrow(s402Error);
      expect(() => decodePaymentRequired(huge)).toThrow('exceeds maximum size');
    });

    it('decodePaymentPayload rejects oversized header', () => {
      const huge = 'A'.repeat(65 * 1024);
      expect(() => decodePaymentPayload(huge)).toThrow('exceeds maximum size');
    });

    it('decodeSettleResponse rejects oversized header', () => {
      const huge = 'A'.repeat(65 * 1024);
      expect(() => decodeSettleResponse(huge)).toThrow('exceeds maximum size');
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

    it('decodeSettleResponse rejects non-string txDigest', () => {
      const bad = btoa(JSON.stringify({ success: true, txDigest: 42 }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('txDigest must be a string');
    });

    it('decodeSettleResponse rejects non-string receiptId', () => {
      const bad = btoa(JSON.stringify({ success: true, receiptId: true }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('receiptId must be a string');
    });

    it('decodeSettleResponse rejects non-number finalityMs', () => {
      const bad = btoa(JSON.stringify({ success: true, finalityMs: 'fast' }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('finalityMs must be a finite number');
    });

    it('decodeSettleResponse rejects NaN finalityMs', () => {
      // JSON.stringify(NaN) becomes null, so test Infinity which becomes null too.
      // Instead, test via body transport where we can inject post-parse.
      const bad = btoa(JSON.stringify({ success: true, finalityMs: null }));
      // null is not a number, so this should fail. But JSON null → null, typeof null !== 'number'.
      // The guard checks typeof !== 'number', null passes that. But null !== undefined so it enters the check.
      expect(() => decodeSettleResponse(bad)).toThrow('finalityMs must be a finite number');
    });

    it('decodeSettleResponse rejects non-string streamId', () => {
      const bad = btoa(JSON.stringify({ success: true, streamId: 123 }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('streamId must be a string');
    });

    it('decodeSettleResponse rejects non-string escrowId', () => {
      const bad = btoa(JSON.stringify({ success: true, escrowId: [] }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('escrowId must be a string');
    });

    it('decodeSettleResponse rejects non-string balanceId', () => {
      const bad = btoa(JSON.stringify({ success: true, balanceId: {} }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('balanceId must be a string');
    });

    it('decodeSettleResponse rejects non-string error field', () => {
      const bad = btoa(JSON.stringify({ success: false, error: 404 }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('error must be a string');
    });

    it('decodeSettleResponse rejects non-string errorCode', () => {
      const bad = btoa(JSON.stringify({ success: false, error: 'fail', errorCode: 123 }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('errorCode must be a string');
    });

    it('decodeSettleResponse rejects non-string actualAmount', () => {
      const bad = btoa(JSON.stringify({ success: true, txDigest: 'ABC', actualAmount: 42 }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('actualAmount must be a string');
    });

    it('decodeSettleResponse rejects non-string depositId', () => {
      const bad = btoa(JSON.stringify({ success: true, txDigest: 'ABC', depositId: 99 }));
      expect(() => decodeSettleResponse(bad)).toThrow(s402Error);
      expect(() => decodeSettleResponse(bad)).toThrow('depositId must be a string');
    });

    it('decodeSettleResponse still accepts valid optional fields', () => {
      const good = btoa(JSON.stringify({
        success: true,
        txDigest: 'ABC123',
        receiptId: '0xreceipt',
        finalityMs: 450,
        actualAmount: '7500000',
        depositId: '0xdeposit123',
        streamId: '0xstream',
        escrowId: '0xescrow',
        balanceId: '0xbalance',
      }));
      const decoded = decodeSettleResponse(good);
      expect(decoded.success).toBe(true);
      expect(decoded.txDigest).toBe('ABC123');
      expect(decoded.finalityMs).toBe(450);
      expect(decoded.actualAmount).toBe('7500000');
      expect(decoded.depositId).toBe('0xdeposit123');
    });

    it('decodePaymentPayload rejects unknown scheme', () => {
      const bad = btoa(JSON.stringify({ scheme: 'bancruptcy', payload: { transaction: 'tx', signature: 'sig' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('Unknown payment scheme');
    });

    it('decodePaymentPayload accepts all six valid schemes', () => {
      for (const scheme of ['exact', 'upto', 'prepaid', 'stream', 'escrow', 'unlock']) {
        const schemeFields: Record<string, string> = {};
        if (scheme === 'upto') schemeFields.maxAmount = '5000000';
        if (scheme === 'unlock') schemeFields.encryptionId = 'enc123';
        if (scheme === 'prepaid') schemeFields.ratePerCall = '100';
        const encoded = btoa(JSON.stringify({ scheme, payload: { transaction: 'tx', signature: 'sig', ...schemeFields } }));
        const decoded = decodePaymentPayload(encoded);
        expect(decoded.scheme).toBe(scheme);
      }
    });

    it('decodePaymentPayload rejects non-string transaction', () => {
      const bad = btoa(JSON.stringify({ scheme: 'exact', payload: { transaction: 42, signature: 'sig' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('payload.transaction must be a string');
    });

    it('decodePaymentPayload rejects non-string signature', () => {
      const bad = btoa(JSON.stringify({ scheme: 'exact', payload: { transaction: 'tx', signature: null } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('payload.signature must be a string');
    });

    it('decodePaymentPayload accepts unlock payload with only transaction + signature', () => {
      const ok = btoa(JSON.stringify({ scheme: 'unlock', payload: { transaction: 'tx', signature: 'sig' } }));
      expect(() => decodePaymentPayload(ok)).not.toThrow();
    });

    it('decodePaymentPayload rejects prepaid payload without ratePerCall', () => {
      const bad = btoa(JSON.stringify({ scheme: 'prepaid', payload: { transaction: 'tx', signature: 'sig' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('prepaid payload requires ratePerCall');
    });

    it('decodePaymentPayload rejects prepaid payload with non-string maxCalls', () => {
      const bad = btoa(JSON.stringify({ scheme: 'prepaid', payload: { transaction: 'tx', signature: 'sig', ratePerCall: '100', maxCalls: 42 } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('maxCalls must be a string');
    });

    it('decodePaymentPayload accepts prepaid payload with string maxCalls', () => {
      const good = btoa(JSON.stringify({ scheme: 'prepaid', payload: { transaction: 'tx', signature: 'sig', ratePerCall: '100', maxCalls: '500' } }));
      const decoded = decodePaymentPayload(good);
      expect(decoded.scheme).toBe('prepaid');
    });

    it('decodePaymentPayload accepts prepaid payload without maxCalls', () => {
      const good = btoa(JSON.stringify({ scheme: 'prepaid', payload: { transaction: 'tx', signature: 'sig', ratePerCall: '100' } }));
      const decoded = decodePaymentPayload(good);
      expect(decoded.scheme).toBe('prepaid');
    });

    it('decodePaymentPayload rejects prepaid payload with negative ratePerCall', () => {
      const bad = btoa(JSON.stringify({ scheme: 'prepaid', payload: { transaction: 'tx', signature: 'sig', ratePerCall: '-5' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('ratePerCall must be a non-negative integer string');
    });

    it('decodePaymentPayload rejects prepaid payload with leading-zero ratePerCall', () => {
      const bad = btoa(JSON.stringify({ scheme: 'prepaid', payload: { transaction: 'tx', signature: 'sig', ratePerCall: '007' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('ratePerCall must be a non-negative integer string');
    });

    it('decodePaymentPayload rejects prepaid payload with non-numeric maxCalls', () => {
      const bad = btoa(JSON.stringify({ scheme: 'prepaid', payload: { transaction: 'tx', signature: 'sig', ratePerCall: '100', maxCalls: 'abc' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('maxCalls must be a non-negative integer string');
    });

    it('decodePaymentPayload accepts valid payload', () => {
      const encoded = encodePaymentPayload(SAMPLE_PAYLOAD);
      const decoded = decodePaymentPayload(encoded);
      expect(decoded.scheme).toBe('exact');
    });

    it('decodePaymentPayload rejects unsupported s402Version', () => {
      const bad = btoa(JSON.stringify({ s402Version: '99', scheme: 'exact', payload: { transaction: 'tx', signature: 'sig' } }));
      expect(() => decodePaymentPayload(bad)).toThrow(s402Error);
      expect(() => decodePaymentPayload(bad)).toThrow('Unsupported s402 version');
    });

    it('decodePaymentPayload accepts payload without s402Version (x402 compat)', () => {
      const encoded = btoa(JSON.stringify({ scheme: 'exact', payload: { transaction: 'tx', signature: 'sig' } }));
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
      const bad = btoa(JSON.stringify({ x402Version: 2, resource: { url: RESOURCE_URL } }));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('Malformed payment requirements');
    });

    it('decodePaymentRequired rejects an envelope with no resource', () => {
      const bad = btoa(JSON.stringify({ x402Version: 2, accepts: [{ ...SAMPLE_OFFER }] }));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('missing resource');
    });

    it('decodePaymentRequired rejects a non-string resource.url', () => {
      const bad = btoa(JSON.stringify(wire({}, { resource: { url: 42 } })));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('resource.url must be a string');
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
      const bad = btoa(JSON.stringify({
        x402Version: 2,
        resource: { url: RESOURCE_URL },
        accepts: [{}],
      }));
      try {
        decodePaymentRequired(bad);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        const msg = (e as Error).message;
        expect(msg).toContain('accepts[0]');
        expect(msg).toContain('scheme');
        expect(msg).toContain('network');
        expect(msg).toContain('asset');
        expect(msg).toContain('amount');
        expect(msg).toContain('payTo');
      }
    });

    it('decodePaymentRequired rejects wrong field types', () => {
      const bad = btoa(JSON.stringify(wire({
        scheme: 42,   // should be a string
        amount: 1000, // should be a string
      })));
      try {
        decodePaymentRequired(bad);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        const msg = (e as Error).message;
        expect(msg).toContain('scheme');
        expect(msg).toContain('amount');
      }
    });

    it('decodePaymentRequired rejects unsupported s402 wire version', () => {
      const bad = btoa(JSON.stringify(wire({}, { extensions: { s402: { version: '99' } } })));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('Unsupported s402 wire version');
    });

    it('decodePaymentRequired rejects unsupported x402Version', () => {
      const bad = btoa(JSON.stringify(wire({}, { x402Version: 1 })));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('Unsupported x402Version');
    });

    it('decodePaymentRequired rejects non-plain extensions', () => {
      const bad = btoa(JSON.stringify(wire({}, { extensions: ['nope'] })));
      expect(() => decodePaymentRequired(bad)).toThrow('extensions must be a plain object');
    });

    it('decodePaymentRequired rejects non-plain extensions.s402', () => {
      const bad = btoa(JSON.stringify(wire({}, { extensions: { s402: 'nope' } })));
      expect(() => decodePaymentRequired(bad)).toThrow('extensions.s402 must be a plain object');
    });

    it('decodePaymentRequired rejects non-numeric amount', () => {
      const bad = wireHeader({ amount: 'hello' });
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('invalid amount');
    });

    it('decodePaymentRequired rejects negative amount', () => {
      const bad = wireHeader({ amount: '-100' });
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('invalid amount');
    });

    it('decodePaymentRequired rejects leading zeros in amount', () => {
      const bad = wireHeader({ amount: '007' });
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('invalid amount');
    });

    it('decodePaymentRequired rejects empty payTo', () => {
      const bad = wireHeader({ payTo: '' });
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('payTo must be a non-empty string');
    });

    it('decodePaymentRequired rejects control characters in identifier fields', () => {
      for (const field of ['scheme', 'network', 'asset', 'payTo']) {
        const bad = wireHeader({ [field]: 'bad\u0000value' });
        expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
        expect(() => decodePaymentRequired(bad)).toThrow(`accepts[0]: ${field} contains control characters`);
      }
    });

    it('decodePaymentRequired rejects a negative maxTimeoutSeconds', () => {
      const bad = wireHeader({ maxTimeoutSeconds: -1 });
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('maxTimeoutSeconds must be a non-negative finite number');
    });

    it('decodePaymentRequired rejects a non-object extra', () => {
      const bad = btoa(JSON.stringify({
        x402Version: 2,
        resource: { url: RESOURCE_URL },
        accepts: [{ ...SAMPLE_OFFER, extra: 'nope' }],
      }));
      expect(() => decodePaymentRequired(bad)).toThrow('accepts[0]: extra must be a plain object');
    });

    it('decodePaymentRequired accepts zero amount', () => {
      const decoded = decodePaymentRequired(wireHeader({ amount: '0' }));
      expect(decoded.accepts[0].amount).toBe('0');
    });

    it('decodePaymentRequired accepts unknown scheme names in accepts (forward compat)', () => {
      // Postel: a scheme this build cannot pay is one a client SKIPS. The
      // decoder refusing the whole 402 over it would turn a menu into a
      // rejection.
      const envelope = wire();
      (envelope.accepts as unknown[]).push({ ...SAMPLE_OFFER, scheme: 'futureScheme', extra: {} });
      const decoded = decodePaymentRequired(btoa(JSON.stringify(envelope)));
      expect(decoded.accepts.map((a) => a.scheme)).toEqual(['exact', 'futureScheme']);
    });

    it('decodePaymentRequired rejects non-object entries in accepts array', () => {
      const envelope = wire();
      (envelope.accepts as unknown[]).push(42);
      const bad = btoa(JSON.stringify(envelope));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('accepts[1] is not an object');
    });

    it('decodePaymentRequired accepts valid requirements', () => {
      const encoded = encodePaymentRequired(SAMPLE_REQUIREMENTS);
      const decoded = decodePaymentRequired(encoded);
      expect(decoded.accepts[0].amount).toBe('1000000000');
      expect(decoded.accepts[0].network).toBe('sui:testnet');
    });

    it('decodePaymentRequired rejects object without x402Version', () => {
      const bad = btoa(JSON.stringify({
        resource: { url: RESOURCE_URL },
        accepts: [SAMPLE_OFFER],
      }));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('Missing x402Version');
    });

    it('decodePaymentRequired rejects the retired s402 v1 flat shape', () => {
      // The flat `{ s402Version, accepts: string[], network, … }` document is
      // no longer a wire format; reading it is compat's job, not the codec's.
      const bad = btoa(JSON.stringify({
        s402Version: '1',
        accepts: ['exact'],
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '1000',
        payTo: VALID_PAY_TO,
      }));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('retired in wire v2');
      expect(() => decodePaymentRequired(bad)).toThrow('fromS402V1Requirements()');
    });

    it('decodePaymentRequired rejects empty accepts array', () => {
      const bad = btoa(JSON.stringify({
        x402Version: 2,
        resource: { url: RESOURCE_URL },
        accepts: [],
      }));
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('at least one requirement');
    });

    it('decodePaymentRequired rejects protocolFeeBps > 10000', () => {
      const bad = wireHeader({ protocolFeeBps: 50000 });
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('protocolFeeBps');
    });

    it('decodePaymentRequired rejects negative protocolFeeBps', () => {
      expect(() => decodePaymentRequired(wireHeader({ protocolFeeBps: -1 }))).toThrow('protocolFeeBps');
    });

    it('decodePaymentRequired rejects non-numeric expiresAt', () => {
      const bad = wireHeader({ expiresAt: 'never' });
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('expiresAt must be a positive finite number');
    });

    it('decodePaymentRequired rejects a facilitatorUrl with a dangerous scheme', () => {
      const bad = wireHeader({ facilitatorUrl: 'file:///etc/passwd' });
      expect(() => decodePaymentRequired(bad)).toThrow(s402Error);
      expect(() => decodePaymentRequired(bad)).toThrow('facilitatorUrl must use https:// or http://');
    });

    it('decodePaymentRequired accepts valid protocolFeeBps and expiresAt', () => {
      const decoded = decodePaymentRequired(wireHeader({
        protocolFeeBps: 50,
        expiresAt: Date.now() + 60000,
      }));
      expect(decoded.accepts[0].protocolFeeBps).toBe(50);
      expect(typeof decoded.accepts[0].expiresAt).toBe('number');
    });

    it('decodePaymentRequired keeps unknown keys inside an entry extra (x402 owns that bag)', () => {
      const decoded = decodePaymentRequired(wireHeader({ paymentFlow: 'upfront', name: 'USDC' }));
      expect(decoded.accepts[0].extra).toEqual({ paymentFlow: 'upfront', name: 'USDC' });
    });

    it('decodePaymentRequired strips unknown keys at the envelope, entry and resource levels', () => {
      const envelope = wire();
      (envelope.accepts as Record<string, unknown>[])[0].rogue = 'injected';
      (envelope.resource as Record<string, unknown>).rogue = 'injected';
      envelope.rogue = 'injected';
      const decoded = decodePaymentRequired(btoa(JSON.stringify(envelope)));
      expect((decoded as unknown as Record<string, unknown>).rogue).toBeUndefined();
      expect((decoded.accepts[0] as unknown as Record<string, unknown>).rogue).toBeUndefined();
      expect((decoded.resource as unknown as Record<string, unknown>).rogue).toBeUndefined();
    });

    it('decodePaymentRequired lifts the envelope mandate out of extensions.s402', () => {
      const bad = wireHeader({}, { extensions: { s402: { version: '2', mandate: { required: 'yes' } } } });
      expect(() => decodePaymentRequired(bad)).toThrow('mandate.required must be a boolean');

      const decoded = decodePaymentRequired(
        wireHeader({}, { extensions: { s402: { version: '2', mandate: { required: true } } } }),
      );
      expect(decoded.mandate).toEqual({ required: true });
    });
  });

  describe('extractRequirementsFromResponse', () => {
    it('extracts requirements from valid 402 response', () => {
      const headers = new Headers();
      headers.set('payment-required', encodePaymentRequired(SAMPLE_REQUIREMENTS));
      const response = new Response(null, { status: 402, headers });

      const reqs = extractRequirementsFromResponse(response);
      expect(reqs).not.toBeNull();
      expect(reqs!.resource.url).toBe(RESOURCE_URL);
      expect(reqs!.accepts[0].network).toBe('sui:testnet');
      expect(reqs!.accepts[0].amount).toBe('1000000000');
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

    it('detects x402 for a plain V2 envelope with no extensions.s402', () => {
      // Same envelope shape s402 emits; only `extensions.s402` separates them,
      // and its absence means "no s402 extensions on it" — never "not payable".
      const headers = new Headers();
      headers.set('payment-required', btoa(JSON.stringify(wire({}, { extensions: { sep2007: {} } }))));
      expect(detectProtocol(headers)).toBe('x402');
    });

    it('returns unknown when neither marker is present', () => {
      const headers = new Headers();
      headers.set('payment-required', btoa(JSON.stringify({ accepts: [], resource: { url: RESOURCE_URL } })));
      expect(detectProtocol(headers)).toBe('unknown');
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

// ══════════════════════════════════════════════════════════════
// Body transport (JSON — no base64, 1 MB cap for defense-in-depth)
// ══════════════════════════════════════════════════════════════

describe('s402 body transport', () => {
  describe('S402_CONTENT_TYPE', () => {
    it('is application/s402+json', () => {
      expect(S402_CONTENT_TYPE).toBe('application/s402+json');
    });
  });

  describe('requirements body roundtrip', () => {
    it('encodes and decodes without loss', () => {
      const json = encodeRequirementsBody(SAMPLE_REQUIREMENTS);
      expect(typeof json).toBe('string');
      const decoded = decodeRequirementsBody(json);
      expect(decoded.x402Version).toBe(2);
      expect(decoded.resource.url).toBe(RESOURCE_URL);
      expect(decoded.accepts[0].scheme).toBe('exact');
      expect(decoded.accepts[0].network).toBe('sui:testnet');
      expect(decoded.accepts[0].amount).toBe('1000000000');
    });

    it('produces valid JSON (not base64)', () => {
      const json = encodeRequirementsBody(SAMPLE_REQUIREMENTS);
      const parsed = JSON.parse(json);
      expect(parsed.x402Version).toBe(2);
      expect(parsed.extensions.s402.version).toBe('2');
    });

    it('preserves all fields including optional ones', () => {
      const full: s402PaymentRequired = {
        ...SAMPLE_REQUIREMENTS,
        accepts: [{
          ...SAMPLE_OFFER,
          facilitatorUrl: 'https://facilitator.example.com',
          protocolFeeBps: 50,
          expiresAt: Date.now() + 60000,
          extensions: { custom: 'data' },
        }],
        mandate: { required: true },
      };
      const decoded = decodeRequirementsBody(encodeRequirementsBody(full));
      expect(decoded.accepts[0].facilitatorUrl).toBe('https://facilitator.example.com');
      expect(decoded.accepts[0].protocolFeeBps).toBe(50);
      expect((decoded.accepts[0].extensions as Record<string, string>).custom).toBe('data');
      expect(decoded.mandate).toEqual({ required: true });
    });

    it('carries one accepts[] entry per offered scheme', () => {
      const multi: s402PaymentRequired = {
        ...SAMPLE_REQUIREMENTS,
        accepts: [
          SAMPLE_OFFER,
          { ...SAMPLE_OFFER, scheme: 'prepaid', prepaid: { ratePerCall: '100', minDeposit: '1000', withdrawalDelayMs: '86400000' } },
        ],
      };
      const decoded = decodeRequirementsBody(encodeRequirementsBody(multi));
      expect(decoded.accepts.map((a) => a.scheme)).toEqual(['exact', 'prepaid']);
      expect(decoded.accepts[1].prepaid!.ratePerCall).toBe('100');
      // Each entry names ONE scheme — there is no scheme list anywhere else.
      expect('accepts' in decoded.accepts[0]).toBe(false);
    });
  });

  describe('payload body roundtrip', () => {
    it('encodes and decodes without loss', () => {
      const json = encodePayloadBody(SAMPLE_PAYLOAD);
      const decoded = decodePayloadBody(json);
      expect(decoded.scheme).toBe('exact');
      if (decoded.scheme === 'exact') {
        expect(decoded.payload.transaction).toBe('dHhieXRlcw==');
        expect(decoded.payload.signature).toBe('c2lnbmF0dXJl');
      }
    });

    it('handles large payloads that would exceed header limits', () => {
      // 200KB transaction — would NOT fit in a 64KB header but is fine in body
      const largeTx = 'A'.repeat(200 * 1024);
      const payload: s402ExactPayload = {
        s402Version: S402_VERSION,
        scheme: 'exact',
        payload: { transaction: largeTx, signature: 'sig' },
      };
      const json = encodePayloadBody(payload);
      const decoded = decodePayloadBody(json);
      expect(decoded.scheme).toBe('exact');
      if (decoded.scheme === 'exact') {
        expect(decoded.payload.transaction).toBe(largeTx);
      }
    });
  });

  describe('settle body roundtrip', () => {
    it('encodes and decodes without loss', () => {
      const json = encodeSettleBody(SAMPLE_SETTLE);
      const decoded = decodeSettleBody(json);
      expect(decoded.success).toBe(true);
      expect(decoded.txDigest).toBe('ABC123');
      expect(decoded.receiptId).toBe('0xreceipt');
      expect(decoded.finalityMs).toBe(450);
    });

    it('handles error responses', () => {
      const errorResponse: s402SettleResponse = {
        success: false,
        error: 'Insufficient balance',
        errorCode: 'INSUFFICIENT_BALANCE',
      };
      const decoded = decodeSettleBody(encodeSettleBody(errorResponse));
      expect(decoded.success).toBe(false);
      expect(decoded.error).toBe('Insufficient balance');
    });
  });

  describe('body decode validation (same validators as header path)', () => {
    it('decodeRequirementsBody rejects invalid JSON', () => {
      expect(() => decodeRequirementsBody('not json {')).toThrow(s402Error);
      expect(() => decodeRequirementsBody('not json {')).toThrow('Failed to parse');
    });

    it('decodeRequirementsBody rejects missing x402Version', () => {
      const json = JSON.stringify({ resource: { url: RESOURCE_URL }, accepts: [SAMPLE_OFFER] });
      expect(() => decodeRequirementsBody(json)).toThrow(s402Error);
      expect(() => decodeRequirementsBody(json)).toThrow('Missing x402Version');
    });

    it('decodePayloadBody rejects invalid JSON', () => {
      expect(() => decodePayloadBody('')).toThrow(s402Error);
    });

    it('decodePayloadBody rejects missing scheme', () => {
      const json = JSON.stringify({ payload: { transaction: 'tx', signature: 'sig' } });
      expect(() => decodePayloadBody(json)).toThrow(s402Error);
      expect(() => decodePayloadBody(json)).toThrow('missing scheme');
    });

    it('decodeSettleBody rejects invalid JSON', () => {
      expect(() => decodeSettleBody('{{{')).toThrow(s402Error);
    });

    it('decodeSettleBody rejects missing success field', () => {
      const json = JSON.stringify({ txDigest: 'ABC' });
      expect(() => decodeSettleBody(json)).toThrow(s402Error);
      expect(() => decodeSettleBody(json)).toThrow('success');
    });

    it('decodeRequirementsBody strips unknown fields (same as header path)', () => {
      const json = JSON.stringify({
        ...wire(),
        malicious: 'injected',
        __proto__: { evil: true },
      });
      const decoded = decodeRequirementsBody(json);
      expect((decoded as unknown as Record<string, unknown>).malicious).toBeUndefined();
    });

    it('decodeRequirementsBody rejects oversized body (> 1 MB)', () => {
      const huge = 'A'.repeat(1024 * 1024 + 1);
      expect(() => decodeRequirementsBody(huge)).toThrow(s402Error);
      expect(() => decodeRequirementsBody(huge)).toThrow('exceeds maximum size');
    });

    it('decodePayloadBody rejects oversized body (> 1 MB)', () => {
      const huge = 'A'.repeat(1024 * 1024 + 1);
      expect(() => decodePayloadBody(huge)).toThrow('exceeds maximum size');
    });

    it('decodeSettleBody rejects oversized body (> 1 MB)', () => {
      const huge = 'A'.repeat(1024 * 1024 + 1);
      expect(() => decodeSettleBody(huge)).toThrow('exceeds maximum size');
    });
  });

  describe('detectTransport', () => {
    it('detects body transport from content-type', () => {
      const headers = new Headers();
      headers.set('content-type', 'application/s402+json');
      expect(detectTransport({ headers })).toBe('body');
    });

    it('detects body transport with charset parameter', () => {
      const headers = new Headers();
      headers.set('content-type', 'application/s402+json; charset=utf-8');
      expect(detectTransport({ headers })).toBe('body');
    });

    it('detects header transport from x-payment header', () => {
      const headers = new Headers();
      headers.set('x-payment', encodePaymentPayload(SAMPLE_PAYLOAD));
      expect(detectTransport({ headers })).toBe('header');
    });

    it('returns unknown when neither present', () => {
      const headers = new Headers();
      expect(detectTransport({ headers })).toBe('unknown');
    });

    it('prefers body transport when both are present', () => {
      const headers = new Headers();
      headers.set('content-type', 'application/s402+json');
      headers.set('x-payment', encodePaymentPayload(SAMPLE_PAYLOAD));
      expect(detectTransport({ headers })).toBe('body');
    });
  });

  describe('header vs body equivalence', () => {
    it('both transports produce same decoded requirements', () => {
      const fromHeader = decodePaymentRequired(encodePaymentRequired(SAMPLE_REQUIREMENTS));
      const fromBody = decodeRequirementsBody(encodeRequirementsBody(SAMPLE_REQUIREMENTS));
      expect(fromHeader).toEqual(fromBody);
    });

    it('both transports produce same decoded payload', () => {
      const fromHeader = decodePaymentPayload(encodePaymentPayload(SAMPLE_PAYLOAD));
      const fromBody = decodePayloadBody(encodePayloadBody(SAMPLE_PAYLOAD));
      expect(fromHeader).toEqual(fromBody);
    });

    it('both transports produce same decoded settle response', () => {
      const fromHeader = decodeSettleResponse(encodeSettleResponse(SAMPLE_SETTLE));
      const fromBody = decodeSettleBody(encodeSettleBody(SAMPLE_SETTLE));
      expect(fromHeader).toEqual(fromBody);
    });
  });
});

// ── V2: estimatedAmount + settlementCeiling validation ──

describe('V2: upto.estimatedAmount validation', () => {
  /**
   * `exact` first, then the `upto` offer — one `accepts[]` entry per scheme,
   * with the upto sub-object riding inside that entry's `extra` where it now
   * travels.
   */
  function makeUptoRequirements(uptoOverrides: Record<string, unknown> = {}): string {
    const offer = {
      scheme: 'exact',
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000000',
      payTo: VALID_PAY_TO,
    };
    return btoa(JSON.stringify({
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [
        { ...offer, extra: {} },
        {
          ...offer,
          scheme: 'upto',
          extra: {
            upto: {
              maxAmount: '5000000',
              settlementDeadlineMs: '1700000000000',
              ...uptoOverrides,
            },
          },
        },
      ],
      extensions: { s402: { version: '2' } },
    }));
  }

  /** The `upto` offer is the second entry. */
  const UPTO_ENTRY = 1;

  it('valid estimatedAmount roundtrips', () => {
    const header = makeUptoRequirements({ estimatedAmount: '3000000' });
    const decoded = decodePaymentRequired(header);
    expect(decoded.accepts[UPTO_ENTRY].upto!.estimatedAmount).toBe('3000000');
  });

  it('estimatedAmount = maxAmount passes (boundary)', () => {
    const header = makeUptoRequirements({ estimatedAmount: '5000000' });
    const decoded = decodePaymentRequired(header);
    expect(decoded.accepts[UPTO_ENTRY].upto!.estimatedAmount).toBe('5000000');
  });

  it('estimatedAmount = "0" passes (valid advisory)', () => {
    const header = makeUptoRequirements({ estimatedAmount: '0' });
    const decoded = decodePaymentRequired(header);
    expect(decoded.accepts[UPTO_ENTRY].upto!.estimatedAmount).toBe('0');
  });

  it('estimatedAmount absent passes', () => {
    const header = makeUptoRequirements({});
    const decoded = decodePaymentRequired(header);
    expect(decoded.accepts[UPTO_ENTRY].upto!.estimatedAmount).toBeUndefined();
  });

  it('rejects non-string estimatedAmount', () => {
    const header = makeUptoRequirements({ estimatedAmount: 42 });
    expect(() => decodePaymentRequired(header)).toThrow(s402Error);
    expect(() => decodePaymentRequired(header)).toThrow('estimatedAmount must be a string');
  });

  it('rejects non-numeric string estimatedAmount', () => {
    const header = makeUptoRequirements({ estimatedAmount: 'abc' });
    expect(() => decodePaymentRequired(header)).toThrow(s402Error);
    expect(() => decodePaymentRequired(header)).toThrow('non-negative integer string');
  });

  it('rejects estimatedAmount > maxAmount', () => {
    const header = makeUptoRequirements({ estimatedAmount: '9999999' });
    expect(() => decodePaymentRequired(header)).toThrow(s402Error);
    expect(() => decodePaymentRequired(header)).toThrow('must be <= maxAmount');
  });
});

describe('V2: upto payload.settlementCeiling validation', () => {
  function makeUptoPayload(innerOverrides: Record<string, unknown> = {}): string {
    return btoa(JSON.stringify({
      s402Version: '1',
      scheme: 'upto',
      payload: {
        transaction: 'dHhieXRlcw==',
        signature: 'c2lnbmF0dXJl',
        maxAmount: '5000000',
        ...innerOverrides,
      },
    }));
  }

  it('valid settlementCeiling roundtrips', () => {
    const header = makeUptoPayload({ settlementCeiling: '3000000' });
    const decoded = decodePaymentPayload(header);
    expect((decoded as any).payload.settlementCeiling).toBe('3000000');
  });

  it('settlementCeiling = maxAmount passes (boundary)', () => {
    const header = makeUptoPayload({ settlementCeiling: '5000000' });
    const decoded = decodePaymentPayload(header);
    expect((decoded as any).payload.settlementCeiling).toBe('5000000');
  });

  it('settlementCeiling = "1" passes (minimum boundary)', () => {
    const header = makeUptoPayload({ settlementCeiling: '1' });
    const decoded = decodePaymentPayload(header);
    expect((decoded as any).payload.settlementCeiling).toBe('1');
  });

  it('settlementCeiling absent passes (backwards compat)', () => {
    const header = makeUptoPayload({});
    const decoded = decodePaymentPayload(header);
    expect((decoded as any).payload.settlementCeiling).toBeUndefined();
  });

  it('rejects non-string settlementCeiling', () => {
    const header = makeUptoPayload({ settlementCeiling: 500 });
    expect(() => decodePaymentPayload(header)).toThrow(s402Error);
    expect(() => decodePaymentPayload(header)).toThrow('must be a string');
  });

  it('rejects non-numeric string settlementCeiling', () => {
    const header = makeUptoPayload({ settlementCeiling: 'abc' });
    expect(() => decodePaymentPayload(header)).toThrow(s402Error);
    expect(() => decodePaymentPayload(header)).toThrow('non-negative integer string');
  });

  it('rejects settlementCeiling = "0"', () => {
    const header = makeUptoPayload({ settlementCeiling: '0' });
    expect(() => decodePaymentPayload(header)).toThrow(s402Error);
    expect(() => decodePaymentPayload(header)).toThrow('must be >= 1');
  });

  it('rejects settlementCeiling > maxAmount', () => {
    const header = makeUptoPayload({ settlementCeiling: '9999999' });
    expect(() => decodePaymentPayload(header)).toThrow(s402Error);
    expect(() => decodePaymentPayload(header)).toThrow('must be <= maxAmount');
  });

  it('upto payload requires maxAmount', () => {
    const header = btoa(JSON.stringify({
      s402Version: '1',
      scheme: 'upto',
      payload: {
        transaction: 'dHhieXRlcw==',
        signature: 'c2lnbmF0dXJl',
      },
    }));
    expect(() => decodePaymentPayload(header)).toThrow(s402Error);
    expect(() => decodePaymentPayload(header)).toThrow('maxAmount');
  });
});

describe('decodePaymentRequired — `extra` is x402\'s bag, not ours', () => {
  it('does not validate a `mandate` key inside an entry extra', () => {
    // `mandate` is envelope-level since wire v2. A key by that name inside an
    // entry's `extra` belongs to whoever put it there — validating it would let
    // an unrelated foreign key take down an otherwise payable 402.
    const header = wireHeader({ mandate: { required: 'not a boolean', anything: 1 } });
    const decoded = decodePaymentRequired(header);
    expect(decoded.mandate).toBeUndefined();
    expect(decoded.accepts[0].extra).toEqual({ mandate: { required: 'not a boolean', anything: 1 } });
  });

  it('still validates the mandate that IS ours, at extensions.s402.mandate', () => {
    const bad = {
      x402Version: 2,
      resource: { url: 'https://api.example.com/paid' },
      accepts: [{ ...SAMPLE_OFFER, extra: {} }],
      extensions: { s402: { version: '2', mandate: { required: 'not a boolean' } } },
    };
    expect(() => decodePaymentRequired(btoa(JSON.stringify(bad)))).toThrow(/required must be a boolean/);
  });
});

describe('mandate survives the round trip (it is a field, not a note)', () => {
  it('carries a requirement-level mandate through encode → decode', () => {
    const doc: s402PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [{ ...SAMPLE_OFFER, mandate: { required: true, minPerTx: '100000' } }],
    };
    const decoded = decodePaymentRequired(encodePaymentRequired(doc));
    expect(decoded.accepts[0].mandate).toEqual({ required: true, minPerTx: '100000' });
    expect(decoded.mandate).toEqual({ required: true, minPerTx: '100000' });
  });

  it('puts it where the wire says it goes — extensions.s402.mandate, not the entry', () => {
    const doc: s402PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [{ ...SAMPLE_OFFER, mandate: { required: true } }],
    };
    const wire = JSON.parse(atob(encodePaymentRequired(doc)));
    expect(wire.extensions.s402.mandate).toEqual({ required: true });
    expect(wire.accepts[0].mandate).toBeUndefined();
    expect(wire.accepts[0].extra.mandate).toBeUndefined();
  });

  it('refuses to emit two entries that disagree about the mandate', () => {
    const doc: s402PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [
        { ...SAMPLE_OFFER, mandate: { required: true } },
        { ...SAMPLE_OFFER, scheme: 'prepaid', mandate: { required: false } },
      ],
    };
    // A mandate authorizes the AGENT, not one price line. Two answers on one
    // 402 is a question the wire has no slot for — better to refuse than to
    // silently publish one of them.
    expect(() => encodePaymentRequired(doc)).toThrow(/mandate/i);
  });

  it('projects the envelope mandate back onto every entry on decode', () => {
    const doc: s402PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      mandate: { required: true, minPerTx: '500' },
      accepts: [SAMPLE_OFFER, { ...SAMPLE_OFFER, scheme: 'prepaid' }],
    };
    const decoded = decodePaymentRequired(encodePaymentRequired(doc));
    expect(decoded.accepts.map((a) => a.mandate)).toEqual([
      { required: true, minPerTx: '500' },
      { required: true, minPerTx: '500' },
    ]);
  });
});

describe("a foreign scheme's `extra` is not ours to validate", () => {
  it('decodes a 402 whose foreign entry carries an s402-shaped key in another shape', () => {
    // x402 ships `auth-capture`. If that scheme ever puts an `escrow` key in
    // its own `extra`, s402's escrow validator would reject the WHOLE 402 —
    // including the `exact` entry we can pay. One unreadable offer must not
    // make an entire menu unreadable.
    const doc = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [
        { ...SAMPLE_OFFER, maxTimeoutSeconds: 60, extra: {} },
        {
          scheme: 'auth-capture', network: 'eip155:8453', asset: '0xUSDC',
          amount: '10000', payTo: '0xabc', maxTimeoutSeconds: 300,
          extra: { escrow: 'foo', expiresAt: 'whenever', upto: 42 },
        },
      ],
    };
    const decoded = decodePaymentRequired(btoa(JSON.stringify(doc)));
    expect(decoded.accepts).toHaveLength(2);

    // The exact entry is intact and payable.
    expect(decoded.accepts[0].scheme).toBe('exact');
    expect(decoded.accepts[0].amount).toBe(SAMPLE_OFFER.amount);

    // The foreign entry's extra rides through verbatim — nothing lifted,
    // nothing validated, nothing dropped.
    expect(decoded.accepts[1].extra).toEqual({ escrow: 'foo', expiresAt: 'whenever', upto: 42 });
    expect(decoded.accepts[1].expiresAt).toBeUndefined();
    expect(decoded.accepts[1].escrow).toBeUndefined();
  });

  it('still validates those keys on an entry whose scheme IS ours', () => {
    const doc = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [{ ...SAMPLE_OFFER, maxTimeoutSeconds: 60, extra: { escrow: 'foo' } }],
    };
    expect(() => decodePaymentRequired(btoa(JSON.stringify(doc)))).toThrow(/must be a plain object/);
  });
});

describe('a plain x402 402 gets an expiry, on every decode path', () => {
  const PLAIN = {
    x402Version: 2,
    resource: { url: 'https://x402.example.com/paid' },
    accepts: [{
      scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC',
      amount: '10000', payTo: '0xabc', maxTimeoutSeconds: 300, extra: {},
    }],
  };
  const NOW = 1_700_000_000_000;

  it('derives expiresAt from maxTimeoutSeconds in decodePaymentRequired', () => {
    // Without this, inbound x402 traffic bypasses all three S1 stale-payment
    // layers: the facilitator's expiry guards skip an undefined `expiresAt`.
    const decoded = decodePaymentRequired(btoa(JSON.stringify(PLAIN)), NOW);
    expect(decoded.accepts[0].expiresAt).toBe(NOW + 300_000);
  });

  it('derives it in decodeRequirementsBody too', () => {
    const decoded = decodeRequirementsBody(JSON.stringify(PLAIN), NOW);
    expect(decoded.accepts[0].expiresAt).toBe(NOW + 300_000);
  });

  it('leaves our own documents alone — silence about expiry is an answer', () => {
    const ours = encodePaymentRequired({
      x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [SAMPLE_OFFER],
    });
    expect(decodePaymentRequired(ours, NOW).accepts[0].expiresAt).toBeUndefined();
  });

  it('never overwrites an expiry the peer stated', () => {
    const stated = {
      ...PLAIN,
      accepts: [{ ...PLAIN.accepts[0], extra: { expiresAt: 42 } }],
    };
    expect(decodePaymentRequired(btoa(JSON.stringify(stated)), NOW).accepts[0].expiresAt).toBe(42);
  });
});

describe('exact is listed first — enforced, not documented', () => {
  it('stable-sorts exact entries to the front on the way to the wire', () => {
    const doc: s402PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [
        { ...SAMPLE_OFFER, scheme: 'prepaid' },
        { ...SAMPLE_OFFER, scheme: 'stream' },
        { ...SAMPLE_OFFER, scheme: 'exact' },
      ],
    };
    // x402's client pays the first entry it has a handler for. An `exact` entry
    // listed third is an entry an x402 client walks past.
    const wire = JSON.parse(atob(encodePaymentRequired(doc)));
    expect(wire.accepts.map((a: { scheme: string }) => a.scheme)).toEqual(['exact', 'prepaid', 'stream']);
  });

  it('leaves the order of everything else alone', () => {
    const doc: s402PaymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [
        { ...SAMPLE_OFFER, scheme: 'stream' },
        { ...SAMPLE_OFFER, scheme: 'prepaid' },
        { ...SAMPLE_OFFER, scheme: 'escrow' },
      ],
    };
    const wire = JSON.parse(atob(encodePaymentRequired(doc)));
    expect(wire.accepts.map((a: { scheme: string }) => a.scheme)).toEqual(['stream', 'prepaid', 'escrow']);
  });
});
