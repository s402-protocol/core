import { describe, it, expect } from 'vitest';
import {
  x402PayloadDialect,
  toX402SettleResponse,
  encodeX402SettleResponse,
  encodeX402V2Envelope,
  toX402V2Envelope,
  X402_UPSTREAM_PIN,
} from '../src/compat/x402.js';
import { S402_VERSION, type s402SettleResponse } from '../src/index.js';
// Upstream's own decoders: if these read what we encode, an x402 client will.
import { decodePaymentResponseHeader, decodePaymentRequiredHeader } from '@x402/core/http';

const enc = (obj: unknown) => btoa(JSON.stringify(obj));

describe('x402PayloadDialect — which dialect did the client address us in?', () => {
  it('PAYMENT-SIGNATURE → x402 (V2), regardless of casing', () => {
    expect(x402PayloadDialect(new Headers({ 'PAYMENT-SIGNATURE': enc({ x402Version: 2 }) }))).toBe('x402');
    expect(x402PayloadDialect(new Headers({ 'payment-signature': 'AAAA' }))).toBe('x402');
  });

  it('X-PAYMENT carrying x402Version → x402 (V1)', () => {
    const v1 = { x402Version: 1, scheme: 'exact', payload: { transaction: 't', signature: 's' } };
    expect(x402PayloadDialect(new Headers({ 'x-payment': enc(v1) }))).toBe('x402');
  });

  it('X-PAYMENT carrying a native s402 payload → null (s402)', () => {
    const native = { s402Version: S402_VERSION, scheme: 'exact', payload: { transaction: 't', signature: 's' } };
    expect(x402PayloadDialect(new Headers({ 'x-payment': enc(native) }))).toBeNull();
  });

  it('no payment header → null', () => {
    expect(x402PayloadDialect(new Headers())).toBeNull();
  });

  it('a malformed X-PAYMENT is not classified — the native decoder owns that error', () => {
    expect(x402PayloadDialect(new Headers({ 'x-payment': '%%%not-base64%%%' }))).toBeNull();
    expect(x402PayloadDialect(new Headers({ 'x-payment': btoa('not json') }))).toBeNull();
  });

  it('an oversized X-PAYMENT is not decoded for classification', () => {
    const huge = 'A'.repeat(64 * 1024 + 4);
    expect(x402PayloadDialect(new Headers({ 'x-payment': huge }))).toBeNull();
  });
});

describe('toX402SettleResponse — the receipt in x402\'s dialect', () => {
  it('maps txDigest → transaction and adds network; keeps s402 fields alongside', () => {
    const s402: s402SettleResponse = { success: true, txDigest: 'D1', receiptId: 'R1', finalityMs: 42 };
    const out = toX402SettleResponse(s402, 'sui:testnet');
    expect(out).toEqual({
      success: true,
      transaction: 'D1',
      network: 'sui:testnet',
      txDigest: 'D1',
      receiptId: 'R1',
      finalityMs: 42,
    });
  });

  it('a failure with no digest carries transaction: "" — x402 requires the field', () => {
    const s402: s402SettleResponse = { success: false, error: 'insufficient funds', errorCode: 'INSUFFICIENT_BALANCE' };
    const out = toX402SettleResponse(s402, 'sui:testnet');
    expect(out.success).toBe(false);
    expect(out.transaction).toBe('');
    expect(out.errorReason).toBe('INSUFFICIENT_BALANCE');
    expect(out.errorMessage).toBe('insufficient funds');
    expect(out).not.toHaveProperty('txDigest');
  });

  it('actualAmount (upto) → amount, kept under both names', () => {
    const out = toX402SettleResponse({ success: true, txDigest: 'D', actualAmount: '750' }, 'sui:mainnet');
    expect(out.amount).toBe('750');
    expect(out.actualAmount).toBe('750');
  });

  it('encodes to a header upstream\'s decodePaymentResponseHeader reads back', () => {
    const header = encodeX402SettleResponse(toX402SettleResponse({ success: true, txDigest: 'Δ-digest' }, 'sui:testnet'));
    const decoded = decodePaymentResponseHeader(header);
    expect(decoded.success).toBe(true);
    expect(decoded.transaction).toBe('Δ-digest');
    expect(decoded.network).toBe('sui:testnet');
  });
});

describe('encodeX402V2Envelope — the 402 in x402\'s dialect', () => {
  it('encodes to a header upstream\'s decodePaymentRequiredHeader reads back', () => {
    const envelope = toX402V2Envelope(
      { scheme: 'exact', network: 'sui:testnet', asset: '0x2::sui::SUI', amount: '1', payTo: '0x' + 'a'.repeat(64) },
      { url: 'https://s402.test/r', description: 'ünïcode is fine' },
    );
    const decoded = decodePaymentRequiredHeader(encodeX402V2Envelope(envelope));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.description).toBe('ünïcode is fine');
    expect(decoded.accepts[0].scheme).toBe('exact');
  });
});

describe('X402_UPSTREAM_PIN — the compat layer knows which x402 it was audited against', () => {
  it('names a full sha, a date, and the npm version under test', () => {
    expect(X402_UPSTREAM_PIN.repo).toBe('x402-foundation/x402');
    expect(X402_UPSTREAM_PIN.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(X402_UPSTREAM_PIN.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the @x402 packages the interop tests run against are the version the pin names', async () => {
    const pkg = (await import('../package.json')).default as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['@x402/core']).toBe(X402_UPSTREAM_PIN.npmVersion);
    expect(pkg.devDependencies['@x402/fetch']).toBe(X402_UPSTREAM_PIN.npmVersion);
  });
});
