import { describe, it, expect } from 'vitest';
import { a2aTransport, S402_A2A_KEYS } from '../src/index.js';
import { parseWwwAuthenticatePayment, decodeMppCredential } from '../src/compat/mpp.js';
import { pickPayloadFields, toRequirementsWire } from '../src/http.js';
import type { s402PaymentRequired } from '../src/index.js';

// Regression tests for the pre-publish security review (2026-06-28).
// Each block pins one finding so it can never silently regress.

// The A2A frame carries the WIRE envelope (wire v2) — the same document the
// `payment-required` header carries, projected through toRequirementsWire.
const required: s402PaymentRequired = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/paid' },
  accepts: [{
    scheme: 'exact',
    network: 'sui:testnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xabc',
  }],
};
const reqs = toRequirementsWire(required);

const base64url = (s: string): string =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('Security hardening — pre-publish review fixes', () => {
  // ── Finding #1: A2A status decode must never return a prototype-chain member ──
  describe('#1 A2A status: untrusted prototype keys fall back, never leak a function/object', () => {
    for (const evil of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      it(`status="${evil}" → derives fallback 'required', stays a string`, () => {
        const frame = { [S402_A2A_KEYS.REQUIRED]: reqs, [S402_A2A_KEYS.STATUS]: evil };
        const decoded = a2aTransport.decodeRequirements(frame)!;
        expect(decoded.ctx.status).toBe('required');
        expect(typeof decoded.ctx.status).toBe('string');
      });
    }
    it('a valid explicit status is still read (not over-rejected)', () => {
      const frame = { [S402_A2A_KEYS.REQUIRED]: reqs, [S402_A2A_KEYS.STATUS]: 'payment-submitted' };
      expect(a2aTransport.decodeRequirements(frame)!.ctx.status).toBe('submitted');
    });
  });

  // ── Finding #2: MPP must reject an empty challenge id (replay-ambiguous) ──
  describe('#2 MPP: empty required auth-params are rejected', () => {
    it('parseWwwAuthenticatePayment rejects an empty id', () => {
      expect(() =>
        parseWwwAuthenticatePayment('Payment id="", realm="s402", method="evm", intent="charge", request="e30"'),
      ).toThrow();
    });
    it('decodeMppCredential rejects an empty challenge id', () => {
      const cred = { challenge: { id: '', realm: 's402', method: 'evm', intent: 'charge', request: 'e30' }, payload: {} };
      expect(() => decodeMppCredential(`Payment ${base64url(JSON.stringify(cred))}`)).toThrow();
    });
    it('a non-empty id still parses', () => {
      expect(
        parseWwwAuthenticatePayment('Payment id="abc", realm="s402", method="evm", intent="charge", request="e30"'),
      ).not.toBeNull();
    });
  });

  // ── Finding #4: pickPayloadFields must not crash on a prototype-key scheme ──
  describe('#4 pickPayloadFields: untrusted scheme key does not throw a raw TypeError', () => {
    for (const evil of ['constructor', '__proto__', 'toString']) {
      it(`scheme="${evil}" is handled safely (returns, no throw)`, () => {
        expect(() =>
          pickPayloadFields({ s402Version: '1', scheme: evil, payload: { transaction: 't', signature: 's' } }),
        ).not.toThrow();
      });
    }
    it('a known scheme still strips unknown inner keys', () => {
      const picked = pickPayloadFields({
        s402Version: '1',
        scheme: 'exact',
        payload: { transaction: 't', signature: 's', evil: 'x' },
      });
      expect('evil' in (picked.payload as Record<string, unknown>)).toBe(false);
    });
  });
});
