/**
 * DAN-854 — `recipient` is REQUIRED per METHOD, not across the whole
 * blockchain-method set.
 *
 * The defect: `fromMppChargeChallenge` rejected every Charge request lacking
 * `recipient`, citing the charge-intent spec. That spec lists `recipient` under
 * OPTIONAL Fields and only notes, parenthetically, that a method spec MAY
 * elevate it. The elevation is per-method — and Lightning exercises the
 * mechanism in the opposite direction.
 *
 * Requirement levels read from tempoxyz/mpp-specs @ f9506cd, each from that
 * method's own Shared Fields table or field list:
 *
 *   evm        REQUIRED   specs/methods/evm/draft-evm-charge-00.md:264
 *   tempo      REQUIRED   specs/methods/tempo/draft-tempo-charge-00.md:155
 *   stellar    REQUIRED   specs/methods/stellar/draft-stellar-charge-00.md:258
 *   solana     REQUIRED   specs/methods/solana/draft-solana-charge-00.md
 *   lightning  OPTIONAL   specs/methods/lightning/draft-lightning-charge-00.md:206
 *
 * Lightning is the lone exception among the five, which is exactly why a
 * blanket rule survived review: it is correct four times out of five.
 */
import { describe, it, expect } from 'vitest';
import { fromMppChargeChallenge, type MppChallenge } from '../src/compat/mpp.js';
import { s402Error } from '../src/errors.js';

function base64url(input: string): string {
  const b64 = Buffer.from(input, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function challenge(method: string, request: unknown): MppChallenge {
  return {
    id: 'kM9xPqWvT2nJrHsY4aDfEb',
    realm: 'api.example.com',
    method,
    intent: 'charge',
    request: base64url(JSON.stringify(request)),
  } as MppChallenge;
}

/**
 * draft-lightning-charge-00.md § Examples, "Decoded `request`", VERBATIM.
 * Note what is absent: there is no `recipient` key. That is the whole ticket.
 */
const LIGHTNING_SPEC_EXAMPLE = {
  amount: '100',
  currency: 'sat',
  description: 'Weather report for 94107',
  methodDetails: {
    invoice: 'lnbc1u1p...',
    paymentHash: 'bc230847...',
    network: 'mainnet',
  },
};

describe('DAN-854 · lightning: recipient is OPTIONAL', () => {
  it("accepts the Lightning spec's own charge example, unmodified", () => {
    expect(() => fromMppChargeChallenge(challenge('lightning', LIGHTNING_SPEC_EXAMPLE)))
      .not.toThrow();
  });

  it('maps payTo to the BOLT11 invoice, which the spec calls authoritative', () => {
    // draft-lightning-charge-00.md:231-234 — `invoice` is REQUIRED and "This
    // field is authoritative; all other payment parameters are derived from
    // it", with the payee "implied by the BOLT11 invoice". So the invoice is
    // the honest payment destination when `recipient` is absent.
    const req = fromMppChargeChallenge(challenge('lightning', LIGHTNING_SPEC_EXAMPLE));
    expect(req.payTo).toBe('lnbc1u1p...');
  });

  it('NEVER emits an empty payTo — an unpayable destination must throw instead', () => {
    // The failure mode this ticket explicitly forbids. Without `recipient` AND
    // without `invoice` there is no destination, and silently emitting "" would
    // produce requirements that look valid and can never be settled.
    const noDestination = { amount: '100', currency: 'sat', methodDetails: { network: 'mainnet' } };
    expect(() => fromMppChargeChallenge(challenge('lightning', noDestination)))
      .toThrow(s402Error);
  });

  it('still prefers an explicit recipient when Lightning supplies one', () => {
    // The non-canonical shape. `recipient` is OPTIONAL, not forbidden, so a
    // request carrying one must not have it silently discarded in favour of the
    // invoice.
    const withRecipient = { ...LIGHTNING_SPEC_EXAMPLE, recipient: '03abc...node' };
    const req = fromMppChargeChallenge(challenge('lightning', withRecipient));
    expect(req.payTo).toBe('03abc...node');
  });
});

describe('DAN-854 · methods whose own spec makes recipient REQUIRED', () => {
  const REQUIRED_METHODS: Array<[string, Record<string, unknown>]> = [
    ['evm', { amount: '1000000', currency: '0xA0b86991c62181', methodDetails: { chainId: 8453 } }],
    ['tempo', { amount: '1000000', currency: '0x20c0000000000000', methodDetails: { chainId: 42431 } }],
    ['solana', { amount: '1000000', currency: 'EPjFWdd5AufqSSqeM2q', methodDetails: {} }],
    ['stellar', { amount: '10000000', currency: 'CBIELTK6YBZJU5UP2WWQ', methodDetails: {} }],
  ];

  for (const [method, request] of REQUIRED_METHODS) {
    it(`${method}: rejects a charge with no recipient`, () => {
      expect(() => fromMppChargeChallenge(challenge(method, request))).toThrow(s402Error);
    });
  }

  it('names the METHOD spec as the authority, not the charge-intent spec', () => {
    // Criterion 3. The old message read "required by charge-intent spec for
    // blockchain methods" — citing, as the authority for a per-method rule, the
    // one document that lists the field as OPTIONAL. A wrong reason is what the
    // next agent acts on.
    let message = '';
    try {
      fromMppChargeChallenge(challenge('evm', REQUIRED_METHODS[0][1]));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('evm');
    expect(message).not.toContain('charge-intent spec');
  });
});
