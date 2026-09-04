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
import { s402ResourceServer } from '../src/server.js';
import { s402Facilitator } from '../src/facilitator.js';
import { s402Gate } from '../src/gate.js';

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

// ── Items 2 and 10 ────────────────────────────────────────────────────────

describe('items 2 & 10: which offer a payment settles against', () => {
  const OTHER = 'eip155:8453';
  const EVM_PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';

  function gateOver(accepts: s402PaymentRequirements[]) {
    const server = new s402ResourceServer();
    const facilitator = new s402Facilitator();
    for (const net of [NETWORK, OTHER]) {
      server.register(net, { scheme: 'exact', buildRequirements: () => accepts[0] });
      facilitator.register(net, {
        scheme: 'exact',
        async verify() { return { valid: true as const, payerAddress: '0xpayer' }; },
        async settle() { return { success: true as const, txDigest: 'D', finalityMs: 1 }; },
      });
    }
    server.setFacilitator(facilitator);
    return s402Gate({ server, requirements: accepts, resource: { url: URL_ } });
  }

  const twoNetworks: s402PaymentRequirements[] = [
    offer({ network: NETWORK, amount: '1000' }),
    offer({ network: OTHER, asset: 'USDC', amount: '2000', payTo: EVM_PAY_TO }),
  ];

  it('item 2: an s402-native payment naming its network settles, on a route offering two', async () => {
    const gate = gateOver(twoNetworks);
    const result = await gate.check(new Request(URL_, {
      headers: {
        'x-payment': btoa(JSON.stringify({
          s402Version: '1', scheme: 'exact', network: OTHER,
          payload: { transaction: 'tx', signature: 'sig' },
        })),
      },
    }));
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.requirements.network).toBe(OTHER);
  });

  it('item 2: a payment that names no network is not refused when the offers agree on price', async () => {
    // Two entries, same scheme, same economics — a menu that lists one dish
    // twice. There is nothing to disambiguate, so refusing was pure pedantry.
    const gate = gateOver([offer({ amount: '1000' }), offer({ amount: '1000' })]);
    const result = await gate.check(new Request(URL_, {
      headers: { 'x-payment': btoa(JSON.stringify({ s402Version: '1', scheme: 'exact', payload: { transaction: 'tx', signature: 'sig' } })) },
    }));
    expect(result.accepted).toBe(true);
  });

  it('item 2: a payment that names no network on offers that DIFFER is still refused, and the message does not send the payer to another protocol', async () => {
    const gate = gateOver(twoNetworks);
    const res = await gate(async () => Response.json({}))(new Request(URL_, {
      headers: { 'x-payment': btoa(JSON.stringify({ s402Version: '1', scheme: 'exact', payload: { transaction: 'tx', signature: 'sig' } })) },
    }));
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string };
    expect(body.error).not.toMatch(/x402/i);
    expect(body.error).toMatch(/network/i);
  });

  it('item 10: an `accepted` whose payTo is checksummed differently still matches', async () => {
    const gate = gateOver(twoNetworks);
    const result = await gate.check(new Request(URL_, {
      headers: {
        'PAYMENT-SIGNATURE': btoa(JSON.stringify({
          x402Version: 2,
          accepted: {
            scheme: 'exact', network: OTHER, asset: 'usdc',
            amount: '2000', payTo: EVM_PAY_TO.toLowerCase(),
            maxTimeoutSeconds: 60, extra: {},
          },
          payload: { transaction: 'tx', signature: 'sig' },
        })),
      },
    }));
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.requirements.payTo).toBe(EVM_PAY_TO);
  });

  it('item 10: an `accepted` truncated to { scheme, network } — the shape the type allows — still matches', async () => {
    const gate = gateOver(twoNetworks);
    const result = await gate.check(new Request(URL_, {
      headers: {
        'PAYMENT-SIGNATURE': btoa(JSON.stringify({
          x402Version: 2,
          accepted: { scheme: 'exact', network: OTHER },
          payload: { transaction: 'tx', signature: 'sig' },
        })),
      },
    }));
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.requirements.network).toBe(OTHER);
  });

  it('item 10: a wrong PRICE is still refused — the fallback must not become a way past the price check', async () => {
    const gate = gateOver(twoNetworks);
    const res = await gate(async () => Response.json({ data: 'must not see' }))(new Request(URL_, {
      headers: {
        'PAYMENT-SIGNATURE': btoa(JSON.stringify({
          x402Version: 2,
          accepted: { scheme: 'exact', network: OTHER, asset: 'USDC', amount: '1', payTo: EVM_PAY_TO, maxTimeoutSeconds: 60, extra: {} },
          payload: { transaction: 'tx', signature: 'sig' },
        })),
      },
    }));
    expect(res.status).toBe(402);
    expect((await res.json() as { errorCode: string }).errorCode).toBe('SCHEME_NOT_SUPPORTED');
  });
});
