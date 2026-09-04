/**
 * ADR-016 rework loop 2 — the findings from the pre-merge review, each as a
 * test that fails on the code as it stood when the review ran.
 *
 * These are grouped by the review's item numbers so a reader can go from the
 * Linear packet to the assertion that pins the fix. Where an item already had
 * a natural home in another file, the test lives there instead and is named in
 * a comment here.
 */
import { describe, it, expect } from 'vitest';
import {
  toX402V2Envelope,
  normalizeRequirements,
} from '../src/compat/x402.js';
import {
  encodePaymentRequired,
} from '../src/http.js';
import type { s402PaymentRequirements } from '../src/types.js';

const NETWORK = 'sui:mainnet';
const ASSET = '0x2::sui::SUI';
const PAY_TO = '0x' + 'b'.repeat(64);
const URL_ = 'https://s402.test/paid';

const offer = (over: Partial<s402PaymentRequirements> = {}): s402PaymentRequirements => ({
  scheme: 'exact',
  network: NETWORK,
  asset: ASSET,
  amount: '1000',
  payTo: PAY_TO,
  ...over,
});

// ── Item 1 ────────────────────────────────────────────────────────────────

describe('item 1: the hand-assembled envelope publishes the mandate it was given', () => {
  it('writes extensions.s402 with the mandate, byte-identical to the header encoder', () => {
    const mandate = { required: true, minPerTx: '500' } as const;
    const required = {
      x402Version: 2 as const,
      resource: { url: URL_ },
      accepts: [offer({ mandate })],
    };

    const byHand = toX402V2Envelope(required.accepts, { url: URL_ });
    const byEncoder = JSON.parse(atob(encodePaymentRequired(required)));

    expect(byHand.extensions?.s402).toEqual({ version: '2', mandate });
    expect(JSON.stringify(byHand)).toBe(JSON.stringify(byEncoder));
  });

  it('applies an `extra` override without stamping it on offers that did not ask', () => {
    const env = toX402V2Envelope(
      [offer({ scheme: 'exact' }), offer({ scheme: 'prepaid', amount: '2000' })],
      { url: URL_ },
      { extra: { name: 'USD Coin' } },
    );
    // The override is documented as applying to every entry; what must NOT
    // happen is one entry's own `extra` leaking onto its neighbour.
    expect(env.accepts[0].extra).toEqual({ name: 'USD Coin' });
    expect(env.accepts[1].extra).toEqual({ name: 'USD Coin' });
  });
});

// ── Item 3 ────────────────────────────────────────────────────────────────

describe('item 3: an unnameable paymentFlow is refused on the V2 path too', () => {
  it('rejects an `exact` offer whose extra.paymentFlow this build cannot name', () => {
    expect(() => normalizeRequirements({
      x402Version: 2,
      resource: { url: URL_ },
      accepts: [{
        scheme: 'exact', network: NETWORK, asset: ASSET, amount: '1000',
        payTo: PAY_TO, maxTimeoutSeconds: 60,
        extra: { paymentFlow: 'auth-capture' },
      }],
    })).toThrow(/paymentFlow/);
  });

  it('still accepts the two flows the spec names, and an absent one', () => {
    for (const paymentFlow of ['authorization', 'upfront', undefined]) {
      const extra = paymentFlow === undefined ? {} : { paymentFlow };
      const out = normalizeRequirements({
        x402Version: 2,
        resource: { url: URL_ },
        accepts: [{
          scheme: 'exact', network: NETWORK, asset: ASSET, amount: '1000',
          payTo: PAY_TO, maxTimeoutSeconds: 60, extra,
        }],
      });
      expect(out.accepts).toHaveLength(1);
    }
  });

  it('leaves a FOREIGN scheme\'s paymentFlow alone — that entry is one we skip, not one we grade', () => {
    const out = normalizeRequirements({
      x402Version: 2,
      resource: { url: URL_ },
      accepts: [
        { scheme: 'exact', network: NETWORK, asset: ASSET, amount: '1000', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: {} },
        { scheme: 'auth-capture', network: NETWORK, asset: ASSET, amount: '1', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { paymentFlow: 'escrow' } },
      ],
    });
    expect(out.accepts).toHaveLength(2);
  });
});
