import { describe, it, expect } from 'vitest';
import { fromX402PayloadHeaders } from '../src/compat/x402.js';
import { S402_VERSION } from '../src/index.js';

/** Encode an object the way x402 encodes a payment header: standard base64 of JSON. */
const enc = (obj: unknown): string => btoa(JSON.stringify(obj));

describe('fromX402PayloadHeaders — opt-in x402 inbound bridge (ADR-011 Chunk 1a-ii)', () => {
  it('normalizes an x402 V1 payload sent under X-PAYMENT', () => {
    const x402v1 = { x402Version: 1, scheme: 'exact', payload: { transaction: 'tx_v1', signature: 'sig_v1' } };
    const headers = new Headers({ 'x-payment': enc(x402v1) });
    expect(fromX402PayloadHeaders(headers)).toEqual({
      s402Version: S402_VERSION,
      scheme: 'exact',
      payload: { transaction: 'tx_v1', signature: 'sig_v1' },
    });
  });

  it('normalizes an x402 V2 (Sui-shaped) payload sent under PAYMENT-SIGNATURE', () => {
    const x402v2 = {
      x402Version: 2,
      accepted: { scheme: 'exact', network: 'sui:testnet' },
      payload: { transaction: 'tx_v2', signature: 'sig_v2' },
    };
    const headers = new Headers({ 'payment-signature': enc(x402v2) });
    expect(fromX402PayloadHeaders(headers)).toEqual({
      s402Version: S402_VERSION,
      scheme: 'exact',
      payload: { transaction: 'tx_v2', signature: 'sig_v2' },
    });
  });

  it('reads PAYMENT-SIGNATURE case-insensitively (HTTP/2 + Headers normalization)', () => {
    const x402 = { x402Version: 2, payload: { transaction: 't', signature: 's' } };
    const headers = new Headers({ 'PAYMENT-SIGNATURE': enc(x402) });
    expect(fromX402PayloadHeaders(headers)).not.toBeNull();
  });

  it('prefers PAYMENT-SIGNATURE over X-PAYMENT when both are present', () => {
    const sig = { x402Version: 2, payload: { transaction: 'from_sig', signature: 's' } };
    const xp = { x402Version: 1, scheme: 'exact', payload: { transaction: 'from_xp', signature: 's' } };
    const headers = new Headers({ 'payment-signature': enc(sig), 'x-payment': enc(xp) });
    expect(fromX402PayloadHeaders(headers)!.payload.transaction).toBe('from_sig');
  });

  it('returns null when no x402 payload header is present (caller falls back to native s402)', () => {
    expect(fromX402PayloadHeaders(new Headers())).toBeNull();
  });

  it('an empty PAYMENT-SIGNATURE is not a payment — it must not throw INVALID_PAYLOAD', () => {
    expect(fromX402PayloadHeaders(new Headers({ 'payment-signature': '' }))).toBeNull();
  });

  it('an empty PAYMENT-SIGNATURE does not shadow a valid X-PAYMENT', () => {
    const xp = { x402Version: 1, scheme: 'exact', payload: { transaction: 'tx_v1', signature: 'sig_v1' } };
    const headers = new Headers({ 'payment-signature': '', 'x-payment': enc(xp) });
    expect(fromX402PayloadHeaders(headers)!.payload.transaction).toBe('tx_v1');
  });

  it('throws on a present-but-malformed header (not base64/JSON)', () => {
    const headers = new Headers({ 'payment-signature': 'not-base64-json!!!' });
    expect(() => fromX402PayloadHeaders(headers)).toThrow();
  });

  it('throws when the decoded payload is not an object', () => {
    const headers = new Headers({ 'payment-signature': enc([1, 2, 3]) });
    expect(() => fromX402PayloadHeaders(headers)).toThrow();
  });

  it('throws when the x402 payload lacks transaction/signature (e.g. EVM authorization shape has no s402 equivalent)', () => {
    const evm = { x402Version: 2, payload: { signature: 'sig', authorization: { from: '0x', to: '0x', value: '1' } } };
    const headers = new Headers({ 'payment-signature': enc(evm) });
    expect(() => fromX402PayloadHeaders(headers)).toThrow();
  });
});
