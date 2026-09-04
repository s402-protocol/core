/**
 * s402 ↔ x402 INTAKE of two upstream changes that landed after the
 * 2026-08-14 baseline. Both are read-path only, by decision:
 *
 *   D2 · x402 #3083 (`6dba93ed`) specified `settlement_pending`, and
 *        `230e6a9a..94f9951a` shipped the reference implementation
 *        (`x402ResourceServer.ts`: SETTLEMENT_PENDING_REASON +
 *        settleWithPendingRetry). It is NON-TERMINAL: broadcast succeeded,
 *        confirmation could not be established, the tx hash rides along so the
 *        caller reconciles on chain. **Reading it as a failure is the retry
 *        that double-pays**, which is the single reason this file exists.
 *
 *   D3 · x402 #3240 / #3267 gave `exact` an `upfront` payment flow, signalled
 *        by `accepts[].extra.paymentFlow`. `exact` is the only scheme s402
 *        accepts inbound, so the scheme the whole interop claim rests on just
 *        acquired a second mode — and s402's intake type had no `extra` field
 *        at all, so it could not see which mode it was in.
 *
 * s402's own emission is deliberately unchanged in both cases. See
 * docs/adr/013-x402-intake-compatibility.md.
 */
import { describe, it, expect } from 'vitest';
import {
  fromX402SettleResponse,
  fromX402SettleResponseHeaders,
  X402_SETTLEMENT_PENDING,
  x402PaymentFlowOf,
  fromX402Requirements,
  fromX402Envelope,
  type x402SettleResponse,
} from '../src/compat/x402.js';
import { s402Error } from '../src/errors.js';

const enc = (obj: unknown): string => btoa(JSON.stringify(obj));

// ══════════════════════════════════════════════════════════════
// D2 — settlement_pending is non-terminal
// ══════════════════════════════════════════════════════════════

describe('fromX402SettleResponse — settlement_pending is not a failure', () => {
  const pending: x402SettleResponse = {
    success: false,
    errorReason: 'settlement_pending',
    transaction: '0xdeadbeef',
    network: 'base-sepolia',
    payer: '0x857b',
  };

  it('classifies settlement_pending as pending, never failed', () => {
    const out = fromX402SettleResponse(pending);
    expect(out.state).toBe('pending');
    if (out.state !== 'pending') throw new Error('unreachable');
    expect(out.transaction).toBe('0xdeadbeef');
    expect(out.reason).toBe(X402_SETTLEMENT_PENDING);
  });

  it('says a pending outcome must not be retried as a fresh payment', () => {
    const out = fromX402SettleResponse(pending);
    expect(out.retryable).toBe(false);
  });

  it('still classifies an ordinary success:false as failed', () => {
    const out = fromX402SettleResponse({
      success: false, errorReason: 'insufficient_funds', transaction: '', network: 'base-sepolia',
    });
    expect(out.state).toBe('failed');
    expect(out.retryable).toBe(true);
  });

  it('classifies success:true as settled', () => {
    const out = fromX402SettleResponse({ success: true, transaction: '0xabc', network: 'sui:testnet' });
    expect(out.state).toBe('settled');
    if (out.state !== 'settled') throw new Error('unreachable');
    expect(out.transaction).toBe('0xabc');
  });

  it('keeps pending non-terminal even when the tx hash is missing, which the spec forbids', () => {
    // "MUST be non-empty when errorReason is settlement_pending" — so an empty
    // hash is an upstream spec violation. It is still NOT a licence to retry:
    // the broadcast may have landed and we simply cannot name it.
    const out = fromX402SettleResponse({
      success: false, errorReason: 'settlement_pending', transaction: '', network: 'base-sepolia',
    });
    expect(out.state).toBe('pending');
    expect(out.retryable).toBe(false);
  });

  it('reads a settle response out of PAYMENT-RESPONSE and X-PAYMENT-RESPONSE', () => {
    expect(fromX402SettleResponseHeaders(new Headers({ 'payment-response': enc(pending) }))?.state)
      .toBe('pending');
    expect(fromX402SettleResponseHeaders(new Headers({ 'x-payment-response': enc(pending) }))?.state)
      .toBe('pending');
  });

  it('returns null when neither header is present', () => {
    expect(fromX402SettleResponseHeaders(new Headers())).toBeNull();
  });

  it('rejects a malformed settle response rather than guessing', () => {
    expect(() => fromX402SettleResponseHeaders(new Headers({ 'payment-response': 'not-base64-json' })))
      .toThrow(s402Error);
    expect(() => fromX402SettleResponse({ transaction: 'x' } as unknown as x402SettleResponse))
      .toThrow(/success/);
  });
});

// ══════════════════════════════════════════════════════════════
// D3 — the exact scheme's payment flow
// ══════════════════════════════════════════════════════════════

describe('x402PaymentFlowOf — exact gained an upfront flow', () => {
  // `x402PaymentFlowOf` reads only `extra`; the rest is here so the fixture
  // reads like the requirement it stands for.
  const base = {
    x402Version: 2, scheme: 'exact', network: 'sui:testnet',
    asset: 'USDC', amount: '1000', payTo: '0xabc', maxTimeoutSeconds: 60,
    extra: undefined as Record<string, unknown> | undefined,
  };

  it('reads an absent flow as authorization, which is what absence means', () => {
    expect(x402PaymentFlowOf(base)).toBe('authorization');
    expect(x402PaymentFlowOf({ ...base, extra: {} })).toBe('authorization');
  });

  it('reads an explicit upfront flow', () => {
    expect(x402PaymentFlowOf({ ...base, extra: { paymentFlow: 'upfront' } })).toBe('upfront');
  });

  it('carries extra through intake so the flow is readable at all', () => {
    const s402 = fromX402Requirements({ ...base, extra: { paymentFlow: 'upfront' } });
    expect(s402.amount).toBe('1000');
    // The requirement round-trips; the flow is read off the x402 object, not
    // smuggled into s402's own wire format.
    expect(x402PaymentFlowOf({ ...base, extra: { paymentFlow: 'upfront' } })).toBe('upfront');
  });

  it('refuses a flow it has never heard of rather than assuming authorization', () => {
    expect(() => x402PaymentFlowOf({ ...base, extra: { paymentFlow: 'someday' } }))
      .toThrow(/paymentFlow/);
    expect(() => fromX402Requirements({ ...base, extra: { paymentFlow: 'someday' } }))
      .toThrow(/paymentFlow/);
  });

  it('sees the flow through a V2 envelope', () => {
    const envelope = {
      x402Version: 2,
      resource: { url: 'https://example.com/x' },
      accepts: [{ ...base, extra: { paymentFlow: 'upfront' } }],
    };
    expect(x402PaymentFlowOf(envelope.accepts[0])).toBe('upfront');
    // fromX402Envelope returns the 402 DOCUMENT now — the price lives on the entry.
    expect(fromX402Envelope(envelope).accepts[0].amount).toBe('1000');
  });
});

// ══════════════════════════════════════════════════════════════
// The `payment-response` header name is shared with native s402
// ══════════════════════════════════════════════════════════════

describe('fromX402SettleResponseHeaders — PAYMENT-RESPONSE is also s402\'s own header name', () => {
  // S402_HEADERS.PAYMENT_RESPONSE is byte-identical to x402 V2's PAYMENT-RESPONSE,
  // so the header name alone cannot say which dialect answered. The body can:
  // a native receipt carries `txDigest`/`receiptId`, an x402 one `transaction`/`network`.
  it('returns null for a native s402 receipt so the caller falls back to the native decoder', () => {
    const native = { success: true, txDigest: 'D1', receiptId: 'R1', finalityMs: 42 };
    expect(fromX402SettleResponseHeaders(new Headers({ 'payment-response': enc(native) }))).toBeNull();
  });

  it('returns null for a native s402 failure receipt (error/errorCode, not errorReason)', () => {
    const native = { success: false, error: 'insufficient funds', errorCode: 'INSUFFICIENT_BALANCE' };
    expect(fromX402SettleResponseHeaders(new Headers({ 'payment-response': enc(native) }))).toBeNull();
  });

  it('still classifies a genuine x402 settle response under the same header name', () => {
    const out = fromX402SettleResponseHeaders(
      new Headers({ 'payment-response': enc({ success: true, transaction: '0xabc', network: 'base-sepolia' }) }),
    );
    expect(out?.state).toBe('settled');
    expect(out?.transaction).toBe('0xabc');
  });

  it('a body with no dialect marker at all falls back to the native path', () => {
    expect(fromX402SettleResponseHeaders(new Headers({ 'payment-response': enc({ success: true }) }))).toBeNull();
  });

  it('X-PAYMENT-RESPONSE is x402-only, so it needs no disambiguation', () => {
    expect(fromX402SettleResponseHeaders(new Headers({ 'x-payment-response': enc({ success: true }) }))?.state)
      .toBe('settled');
  });
});

describe('fromX402SettleResponse — a failure holding a broadcast hash is not retryable', () => {
  it('does not invite a second payment when the first one has a transaction hash', () => {
    const out = fromX402SettleResponse({
      success: false, errorReason: 'unexpected_settle_error',
      transaction: '0xbroadcast', network: 'base-sepolia',
    });
    expect(out.state).toBe('failed');
    expect(out.transaction).toBe('0xbroadcast');
    expect(out.retryable).toBe(false);
  });

  it('keeps retryable true when nothing was broadcast', () => {
    const out = fromX402SettleResponse({
      success: false, errorReason: 'insufficient_funds', transaction: '', network: 'base-sepolia',
    });
    expect(out.state).toBe('failed');
    expect(out.retryable).toBe(true);
  });
});
