/**
 * Unit tests for s402/compat-l402 — L402 (Lightning Labs) read-path interop.
 *
 * BOLT-11 vectors are drawn from the canonical BOLT-11 test vectors in the
 * Lightning bolts repo (bolts/11-payment-encoding.md) — these have been
 * implementation-stable since 2018 and ship with c-lightning, lnd, eclair.
 *
 * L402 challenge fixtures are constructed to match Aperture's on-the-wire
 * output (observed in production Lightning Labs deployments).
 */
import { describe, it, expect } from 'vitest';
import {
  parseWwwAuthenticateL402,
  decodeBolt11Summary,
  fromL402Challenge,
  type L402Challenge,
} from '../src/compat-l402.js';
import { s402Error } from '../src/errors.js';

// A representative (synthetic) BOLT-11 invoice body. Real BOLT-11 invoices are
// ~200+ chars of bech32 — for HRP decoding we only need a valid HRP + separator
// + at least one bech32 char, so this suffices for test coverage.
const SAMPLE_MACAROON =
  'AGIAJEemVQUTEyNCR0exk7ek90Cg==';  // arbitrary base64 opaque blob

// BOLT-11 HRPs covering all four multiplier classes. `1` is the bech32
// separator; we append a short bech32-legal body so the regex matches without
// requiring full bech32 validation.
const INV_2500_UBTC = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqq';      // 2500 μBTC = 250_000_000 msat
const INV_1500_NBTC = 'lnbc1500n1pvjluezpp5qqqsyqcyq5rqwzqfqqq';      // 1500 nBTC = 150_000 msat
const INV_20M_BTC   = 'lnbc20m1pvjluezpp5qqqsyqcyq5rqwzqfqqq';        // 20 mBTC = 2_000_000_000 msat
const INV_10P_BTC   = 'lnbc10p1pvjluezpp5qqqsyqcyq5rqwzqfqqq';        // 10 pBTC = 1 msat
const INV_AMOUNTLESS = 'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqq';          // no amount
const INV_TESTNET   = 'lntb25u1pvjluezpp5qqqsyqcyq5rqwzqfqqq';        // testnet
const INV_REGTEST   = 'lnbcrt500u1pvjluezpp5qqqsyqcyq5rqwzqfqqq';     // regtest
const INV_SIGNET    = 'lnsb25u1pvjluezpp5qqqsyqcyq5rqwzqfqqq';        // signet

describe('parseWwwAuthenticateL402', () => {
  it('returns null for absent / non-L402 headers', () => {
    expect(parseWwwAuthenticateL402(null)).toBeNull();
    expect(parseWwwAuthenticateL402(undefined)).toBeNull();
    expect(parseWwwAuthenticateL402('')).toBeNull();
    expect(parseWwwAuthenticateL402('Basic realm="x"')).toBeNull();
    expect(parseWwwAuthenticateL402('Bearer token="abc"')).toBeNull();
    expect(parseWwwAuthenticateL402('Payment method="tempo"')).toBeNull();
  });

  it('parses an L402 challenge with quoted params', () => {
    const header = `L402 macaroon="${SAMPLE_MACAROON}", invoice="${INV_2500_UBTC}"`;
    const challenge = parseWwwAuthenticateL402(header)!;
    expect(challenge.scheme).toBe('L402');
    expect(challenge.macaroon).toBe(SAMPLE_MACAROON);
    expect(challenge.invoice).toBe(INV_2500_UBTC);
  });

  it('canonicalizes legacy LSAT scheme to L402', () => {
    const header = `LSAT macaroon="${SAMPLE_MACAROON}", invoice="${INV_2500_UBTC}"`;
    const challenge = parseWwwAuthenticateL402(header)!;
    expect(challenge.scheme).toBe('L402');
  });

  it('accepts unquoted token-style auth-params (Aperture quirk)', () => {
    const simpleMac = 'AGIAJEemVQUTEyNCR0exk7ek90Cg';
    const header = `L402 macaroon=${simpleMac}, invoice=${INV_2500_UBTC}`;
    const challenge = parseWwwAuthenticateL402(header)!;
    expect(challenge.macaroon).toBe(simpleMac);
    expect(challenge.invoice).toBe(INV_2500_UBTC);
  });

  it('is case-insensitive on the scheme name', () => {
    const header = `l402 macaroon="${SAMPLE_MACAROON}", invoice="${INV_2500_UBTC}"`;
    expect(parseWwwAuthenticateL402(header)).not.toBeNull();
    const header2 = `Lsat macaroon="${SAMPLE_MACAROON}", invoice="${INV_2500_UBTC}"`;
    expect(parseWwwAuthenticateL402(header2)).not.toBeNull();
  });

  it('handles param order independence', () => {
    const header = `L402 invoice="${INV_2500_UBTC}", macaroon="${SAMPLE_MACAROON}"`;
    const challenge = parseWwwAuthenticateL402(header)!;
    expect(challenge.macaroon).toBe(SAMPLE_MACAROON);
    expect(challenge.invoice).toBe(INV_2500_UBTC);
  });

  it('throws INVALID_PAYLOAD when L402 has no auth-params', () => {
    expect(() => parseWwwAuthenticateL402('L402')).toThrow(s402Error);
    expect(() => parseWwwAuthenticateL402('L402   ')).toThrow(/missing auth-params/);
  });

  it('throws INVALID_PAYLOAD when macaroon is missing', () => {
    expect(() => parseWwwAuthenticateL402(`L402 invoice="${INV_2500_UBTC}"`))
      .toThrow(/missing "macaroon"/);
  });

  it('throws INVALID_PAYLOAD when invoice is missing', () => {
    expect(() => parseWwwAuthenticateL402(`L402 macaroon="${SAMPLE_MACAROON}"`))
      .toThrow(/missing "invoice"/);
  });

  it('throws on malformed auth-param grammar', () => {
    expect(() => parseWwwAuthenticateL402('L402 macaroon')).toThrow(s402Error);
    expect(() => parseWwwAuthenticateL402('L402 =value')).toThrow(s402Error);
  });
});

describe('decodeBolt11Summary — BOLT-11 HRP decoding', () => {
  it('decodes a 2500 μBTC mainnet invoice to 250_000_000 msat', () => {
    const summary = decodeBolt11Summary(INV_2500_UBTC);
    expect(summary.network).toBe('lightning:mainnet');
    expect(summary.amountMsat).toBe('250000000');
  });

  it('decodes a 1500 nBTC mainnet invoice to 150_000 msat', () => {
    const summary = decodeBolt11Summary(INV_1500_NBTC);
    expect(summary.network).toBe('lightning:mainnet');
    expect(summary.amountMsat).toBe('150000');
  });

  it('decodes a 20 mBTC mainnet invoice to 2_000_000_000 msat', () => {
    const summary = decodeBolt11Summary(INV_20M_BTC);
    expect(summary.network).toBe('lightning:mainnet');
    expect(summary.amountMsat).toBe('2000000000');
  });

  it('decodes a 10 pBTC mainnet invoice to 1 msat (minimum divisible)', () => {
    const summary = decodeBolt11Summary(INV_10P_BTC);
    expect(summary.amountMsat).toBe('1');
  });

  it('returns amountMsat=null for amountless invoices', () => {
    const summary = decodeBolt11Summary(INV_AMOUNTLESS);
    expect(summary.network).toBe('lightning:mainnet');
    expect(summary.amountMsat).toBeNull();
  });

  it('recognizes testnet (lntb) prefix', () => {
    expect(decodeBolt11Summary(INV_TESTNET).network).toBe('lightning:testnet');
  });

  it('recognizes regtest (lnbcrt) prefix', () => {
    expect(decodeBolt11Summary(INV_REGTEST).network).toBe('lightning:regtest');
  });

  it('recognizes signet (lnsb) prefix', () => {
    expect(decodeBolt11Summary(INV_SIGNET).network).toBe('lightning:signet');
  });

  it('is case-insensitive on the invoice string', () => {
    const summary = decodeBolt11Summary(INV_2500_UBTC.toUpperCase());
    expect(summary.network).toBe('lightning:mainnet');
    expect(summary.amountMsat).toBe('250000000');
  });

  it('throws INVALID_PAYLOAD on malformed HRP', () => {
    expect(() => decodeBolt11Summary('')).toThrow(s402Error);
    expect(() => decodeBolt11Summary('not-an-invoice')).toThrow(/BOLT-11 HRP/);
    expect(() => decodeBolt11Summary('lnXY25u1pvjluezpp5qqqsyqcyq5rqwzqfqqq')).toThrow(s402Error);
  });

  it('rejects pico-BTC amounts that are not multiples of 10', () => {
    const invBadPico = 'lnbc5p1pvjluezpp5qqqsyqcyq5rqwzqfqqq';
    expect(() => decodeBolt11Summary(invBadPico)).toThrow(/multiple of 10/);
  });

  it('handles very large amounts via BigInt arithmetic', () => {
    const largeInvoice = 'lnbc1000000m1pvjluezpp5qqqsyqcyq5rqwzqfqqq';
    const summary = decodeBolt11Summary(largeInvoice);
    expect(summary.amountMsat).toBe('100000000000000');
  });
});

describe('fromL402Challenge — L402 → s402 translation', () => {
  const baseChallenge: L402Challenge = {
    scheme: 'L402',
    macaroon: SAMPLE_MACAROON,
    invoice: INV_2500_UBTC,
  };

  it('translates a mainnet L402 challenge to s402 requirements', () => {
    const requirements = fromL402Challenge(baseChallenge);
    expect(requirements.s402Version).toBe('1');
    expect(requirements.accepts).toEqual(['exact']);
    expect(requirements.network).toBe('lightning:mainnet');
    expect(requirements.asset).toBe('lightning:msat');
    expect(requirements.amount).toBe('250000000');
    expect(requirements.payTo).toBe('lightning:invoice');
  });

  it('surfaces macaroon + invoice in extensions.l402 for the retry', () => {
    const requirements = fromL402Challenge(baseChallenge);
    const ext = (requirements.extensions as { l402: { macaroon: string; invoice: string } }).l402;
    expect(ext.macaroon).toBe(SAMPLE_MACAROON);
    expect(ext.invoice).toBe(INV_2500_UBTC);
  });

  it('propagates network from invoice prefix across all four networks', () => {
    expect(fromL402Challenge({ ...baseChallenge, invoice: INV_TESTNET }).network)
      .toBe('lightning:testnet');
    expect(fromL402Challenge({ ...baseChallenge, invoice: INV_REGTEST }).network)
      .toBe('lightning:regtest');
    expect(fromL402Challenge({ ...baseChallenge, invoice: INV_SIGNET }).network)
      .toBe('lightning:signet');
  });

  it('rejects amountless invoices (L402 spec violation)', () => {
    expect(() => fromL402Challenge({ ...baseChallenge, invoice: INV_AMOUNTLESS }))
      .toThrow(/amountless/);
  });

  it('propagates INVALID_PAYLOAD from decodeBolt11Summary on malformed invoice', () => {
    expect(() => fromL402Challenge({ ...baseChallenge, invoice: 'garbage' }))
      .toThrow(s402Error);
  });
});

describe('end-to-end — WWW-Authenticate header → s402 requirements', () => {
  it('parses and translates a canonical Aperture-shape L402 challenge', () => {
    const header = `L402 macaroon="${SAMPLE_MACAROON}", invoice="${INV_2500_UBTC}"`;
    const challenge = parseWwwAuthenticateL402(header)!;
    const requirements = fromL402Challenge(challenge);
    expect(requirements.network).toBe('lightning:mainnet');
    expect(requirements.amount).toBe('250000000');
    expect(requirements.asset).toBe('lightning:msat');
  });

  it('works through the legacy LSAT scheme identically', () => {
    const header = `LSAT macaroon="${SAMPLE_MACAROON}", invoice="${INV_20M_BTC}"`;
    const challenge = parseWwwAuthenticateL402(header)!;
    const requirements = fromL402Challenge(challenge);
    expect(requirements.network).toBe('lightning:mainnet');
    expect(requirements.amount).toBe('2000000000');
  });
});
