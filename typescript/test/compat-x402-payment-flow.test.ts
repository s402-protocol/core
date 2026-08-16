/**
 * x402 §6.1 payment-flow conformance — DAN-846.
 *
 * §6.1 (merged 2026-08-08, #3053) makes `extra.paymentFlow` and
 * `extra.assetTransferMethod` protocol-reserved keys and defines three flows:
 *
 *   authorization (default)  verify → resource → settle → respond
 *   upfront                  settle → resource → respond          (no /verify)
 *   escrow                   settle → resource → settle → respond (no /verify)
 *
 * s402's pipeline is verify → resource → settle, which IS `authorization`.
 * `upfront` and `escrow` commit funds *before* the resource runs, so honouring
 * one of those requirements with s402's ordering would serve the resource
 * without finality. Today no upstream `exact` mechanism declares either — the
 * gap is latent, and this file is the tripwire for the day one does.
 *
 * Spec text quoted inline is from `specs/x402-specification-v2.md` §6.1 at
 * x402-foundation/x402 `foundation/main` @ 167a828e. Note the local checkout
 * may sit on a fork branch that predates §6.1 — read `foundation/main`, not HEAD.
 */
import { describe, it, expect } from 'vitest';
import {
  fromX402Requirements,
  toX402V2Requirements,
  toX402V2Envelope,
  type x402PaymentRequirements,
} from '../src/compat/x402.js';
import { s402Error } from '../src/errors.js';
import type { s402PaymentRequirements } from '../src/types.js';

/** A minimal, valid inbound x402 `exact` requirement. */
function inbound(extra?: Record<string, unknown>): x402PaymentRequirements {
  return {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount: '1000',
    payTo: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    maxTimeoutSeconds: 60,
    ...(extra === undefined ? {} : { extra }),
  };
}

const s402Requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact'],
  network: 'eip155:8453',
  asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amount: '1000',
  payTo: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
};

// ══════════════════════════════════════════════════════════════
// Inbound — the serve-without-finality gate
// ══════════════════════════════════════════════════════════════

describe('fromX402Requirements — payment flow', () => {
  it('accepts a requirement with no extra at all (pre-§6.1 counterparties)', () => {
    expect(fromX402Requirements(inbound()).accepts).toEqual(['exact']);
  });

  it('accepts an omitted paymentFlow — the mechanism default', () => {
    // §6.1: "Omitting extra.assetTransferMethod or extra.paymentFlow means the
    // mechanism default when resolving… When the resolved payment flow is not
    // `authorization`, accepts[].extra.paymentFlow MUST be present." So for a
    // conformant counterparty, absence proves the flow IS authorization.
    expect(fromX402Requirements(inbound({})).accepts).toEqual(['exact']);
    expect(fromX402Requirements(inbound({ assetTransferMethod: 'eip3009' })).accepts).toEqual(['exact']);
  });

  it('accepts an explicit authorization flow', () => {
    // §6.1: "`authorization` MAY be omitted or explicit."
    expect(fromX402Requirements(inbound({ paymentFlow: 'authorization' })).accepts).toEqual(['exact']);
  });

  it('rejects upfront — settle happens before the resource', () => {
    expect(() => fromX402Requirements(inbound({ paymentFlow: 'upfront' }))).toThrow(s402Error);
    expect(() => fromX402Requirements(inbound({ paymentFlow: 'upfront' }))).toThrow(/upfront/);
  });

  it('rejects escrow — two settles around the resource', () => {
    expect(() => fromX402Requirements(inbound({ paymentFlow: 'escrow' }))).toThrow(s402Error);
    expect(() => fromX402Requirements(inbound({ paymentFlow: 'escrow' }))).toThrow(/escrow/);
  });

  it('rejects an unrecognised flow string', () => {
    // §6.1: "Clients MUST NOT construct a payment for a paymentFlow they do not
    // recognize."
    expect(() => fromX402Requirements(inbound({ paymentFlow: 'lightning-hold' }))).toThrow(s402Error);
  });

  it('rejects a non-string paymentFlow rather than coercing it', () => {
    expect(() => fromX402Requirements(inbound({ paymentFlow: 42 }))).toThrow(s402Error);
    expect(() => fromX402Requirements(inbound({ paymentFlow: null }))).toThrow(s402Error);
  });

  it('distinguishes "not supported by us" from "not defined by the spec"', () => {
    // The operator's next move differs: an unsupported-but-defined flow is a
    // deliberate s402 limit; an undefined one means upstream moved and our
    // drift check should have caught it. One message for both would send half
    // of readers to the wrong place.
    let supported = '';
    let unknown = '';
    try { fromX402Requirements(inbound({ paymentFlow: 'escrow' })); } catch (e) { supported = (e as Error).message; }
    try { fromX402Requirements(inbound({ paymentFlow: 'nonesuch' })); } catch (e) { unknown = (e as Error).message; }
    expect(supported).not.toBe(unknown);
  });

  it('uses SCHEME_NOT_SUPPORTED, matching the sibling scheme gate', () => {
    try {
      fromX402Requirements(inbound({ paymentFlow: 'upfront' }));
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(s402Error);
      expect((e as s402Error).code).toBe('SCHEME_NOT_SUPPORTED');
    }
  });

  it('still rejects a non-exact scheme first', () => {
    // The scheme gate must stay the outer check — an `upto` requirement is
    // rejected as a scheme, not as a flow, whatever its extra says.
    const upto = { ...inbound({ paymentFlow: 'escrow' }), scheme: 'upto' };
    expect(() => fromX402Requirements(upto)).toThrow(/scheme/i);
  });
});

// ══════════════════════════════════════════════════════════════
// assetTransferMethod — reserved key, NO global vocabulary
// ══════════════════════════════════════════════════════════════

describe('assetTransferMethod is carried, not adjudicated', () => {
  it('accepts any assetTransferMethod string, including ones we have never seen', () => {
    // §6.1 is explicit: "Allowed assetTransferMethod string values are
    // mechanism-defined; this protocol reserves the key name, not a global ATM
    // vocabulary." There is no set to validate against. Enumerating one here
    // would reject conformant counterparties using any mechanism we had not
    // hard-coded — eip3009, permit2, sequence, ticketSequence, and whatever
    // ships next. Rejecting an unknown ATM would be a bug, not a check.
    for (const atm of ['eip3009', 'permit2', 'sequence', 'ticketSequence', 'something-invented-tomorrow']) {
      expect(fromX402Requirements(inbound({ assetTransferMethod: atm })).accepts).toEqual(['exact']);
    }
  });

  it('still applies the flow gate when an assetTransferMethod is present', () => {
    expect(() =>
      fromX402Requirements(inbound({ assetTransferMethod: 'permit2', paymentFlow: 'upfront' })),
    ).toThrow(s402Error);
  });
});

// ══════════════════════════════════════════════════════════════
// Outbound — never construct a payment for a flow we do not honour
// ══════════════════════════════════════════════════════════════

describe('toX402V2Requirements — payment flow', () => {
  it('emits an empty extra when none is supplied', () => {
    expect(toX402V2Requirements(s402Requirements).extra).toEqual({});
  });

  it('passes through an explicit authorization flow', () => {
    const req = toX402V2Requirements(s402Requirements, { extra: { paymentFlow: 'authorization' } });
    expect(req.extra).toEqual({ paymentFlow: 'authorization' });
  });

  it('refuses to emit upfront or escrow', () => {
    for (const flow of ['upfront', 'escrow']) {
      expect(() => toX402V2Requirements(s402Requirements, { extra: { paymentFlow: flow } }))
        .toThrow(s402Error);
    }
  });

  it('refuses to emit an unrecognised flow', () => {
    expect(() => toX402V2Requirements(s402Requirements, { extra: { paymentFlow: 'made-up' } }))
      .toThrow(s402Error);
  });

  it('preserves unrelated extra keys (EIP-712 domain name/version)', () => {
    // The EVM EIP-3009 path documented on this function passes name/version
    // through extra — the flow gate must not disturb it.
    const req = toX402V2Requirements(s402Requirements, {
      extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
    });
    expect(req.extra).toEqual({ name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' });
  });
});

describe('toX402V2Envelope — inherits the gate by delegation', () => {
  const resource = { url: 'https://api.example.com/weather' };

  it('emits normally for an authorization flow', () => {
    const env = toX402V2Envelope(s402Requirements, resource, { extra: { paymentFlow: 'authorization' } });
    expect(env.accepts).toHaveLength(1);
  });

  it('refuses an unsupported flow through the envelope path too', () => {
    // toX402V2Envelope calls toX402V2Requirements rather than building its own
    // literal, so one gate covers both emit paths. This test exists to keep
    // that delegation true — if someone inlines the literal, this goes red.
    expect(() => toX402V2Envelope(s402Requirements, resource, { extra: { paymentFlow: 'escrow' } }))
      .toThrow(s402Error);
  });
});
