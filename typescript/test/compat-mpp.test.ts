/**
 * Unit tests for s402/compat/mpp — MPP read-path interop.
 *
 * Fixtures are drawn from the actual MPP spec drafts in tempoxyz/mpp-specs:
 *   - specs/core/draft-httpauth-payment-00.md (§5.1 challenge, §5.2 credential, §6.1 Accept-Payment)
 *   - specs/intents/draft-payment-intent-charge-00.md (§Request Schema)
 */
import { describe, it, expect } from 'vitest';
import {
  parseWwwAuthenticatePayment,
  parseMppAcceptPayment,
  matchMppRange,
  decodeMppChargeRequest,
  decodeMppCredential,
  fromMppChargeChallenge,
  type MppChallenge,
} from '../src/compat/mpp.js';
import { s402Error } from '../src/errors.js';

function base64url(input: string): string {
  const b64 = Buffer.from(input, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TEMPO_CHARGE_REQUEST_JSON = JSON.stringify({
  amount: '1000000',
  currency: '0x20c0000000000000000000000000000000000000',
  recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
  methodDetails: { chainId: 42431, feePayer: true },
});

const TEMPO_REQUEST_B64 = base64url(TEMPO_CHARGE_REQUEST_JSON);

describe('parseWwwAuthenticatePayment', () => {
  it('returns null for missing / non-Payment headers', () => {
    expect(parseWwwAuthenticatePayment(null)).toBeNull();
    expect(parseWwwAuthenticatePayment(undefined)).toBeNull();
    expect(parseWwwAuthenticatePayment('')).toBeNull();
    expect(parseWwwAuthenticatePayment('Basic realm="x"')).toBeNull();
    expect(parseWwwAuthenticatePayment('Bearer token="abc"')).toBeNull();
  });

  it('parses the canonical spec §5.1.4 example', () => {
    const header =
      'Payment id="x7Tg2pLqR9mKvNwY3hBcZa", ' +
      'realm="api.example.com", ' +
      'method="example", ' +
      'intent="charge", ' +
      'expires="2025-01-15T12:05:00Z", ' +
      'request="eyJhbW91bnQiOiIxMDAwIn0"';
    const challenge = parseWwwAuthenticatePayment(header)!;
    expect(challenge.id).toBe('x7Tg2pLqR9mKvNwY3hBcZa');
    expect(challenge.realm).toBe('api.example.com');
    expect(challenge.method).toBe('example');
    expect(challenge.intent).toBe('charge');
    expect(challenge.expires).toBe('2025-01-15T12:05:00Z');
    expect(challenge.request).toBe('eyJhbW91bnQiOiIxMDAwIn0');
  });

  it('lowercases method per spec §5.1.1', () => {
    const header = 'Payment id="a", realm="r", method="TEMPO", intent="charge", request="e30"';
    expect(parseWwwAuthenticatePayment(header)!.method).toBe('tempo');
  });

  it('accepts unquoted token values', () => {
    const header = 'Payment id=abc, realm=api.example.com, method=tempo, intent=charge, request=e30';
    const challenge = parseWwwAuthenticatePayment(header)!;
    expect(challenge.id).toBe('abc');
    expect(challenge.method).toBe('tempo');
  });

  it('preserves optional digest and opaque params', () => {
    const header =
      'Payment id="a", realm="r", method="evm", intent="charge", request="e30", ' +
      'digest="sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:", ' +
      'opaque="eyJwaV9pZCI6InBpXzEyMyJ9", ' +
      'description="Premium API access"';
    const challenge = parseWwwAuthenticatePayment(header)!;
    expect(challenge.digest).toContain('sha-256=');
    expect(challenge.opaque).toBe('eyJwaV9pZCI6InBpXzEyMyJ9');
    expect(challenge.description).toBe('Premium API access');
  });

  it('preserves escaped quotes in quoted-string values', () => {
    const header = 'Payment id="a", realm="r", method="tempo", intent="charge", request="e30", description="say \\"hi\\""';
    expect(parseWwwAuthenticatePayment(header)!.description).toBe('say "hi"');
  });

  it('throws on missing required params', () => {
    expect(() =>
      parseWwwAuthenticatePayment('Payment id="a", realm="r"'),
    ).toThrow(s402Error);
    expect(() =>
      parseWwwAuthenticatePayment('Payment '),
    ).toThrow(/missing auth-params/);
  });

  it('throws on malformed auth-params', () => {
    expect(() => parseWwwAuthenticatePayment('Payment id')).toThrow(/Missing "="/);
    expect(() => parseWwwAuthenticatePayment('Payment id="unterm')).toThrow(/Unterminated/);
  });
});

describe('parseMppAcceptPayment', () => {
  it('parses the canonical §6.1 examples', () => {
    const result = parseMppAcceptPayment(
      'tempo/charge, tempo/session, stripe/charge;q=0.5, solana/charge;q=0.3',
    );
    expect(result).toEqual([
      { method: 'tempo', intent: 'charge', q: 1 },
      { method: 'tempo', intent: 'session', q: 1 },
      { method: 'stripe', intent: 'charge', q: 0.5 },
      { method: 'solana', intent: 'charge', q: 0.3 },
    ]);
  });

  it('preserves q=0 entries for rejection signaling', () => {
    const result = parseMppAcceptPayment('tempo/charge, tempo/session;q=0, solana/charge');
    const session = result.find((r) => r.intent === 'session');
    expect(session?.q).toBe(0);
  });

  it('accepts wildcards on either side', () => {
    const result = parseMppAcceptPayment('tempo/*, */session;q=0.3');
    expect(result).toContainEqual({ method: 'tempo', intent: '*', q: 1 });
    expect(result).toContainEqual({ method: '*', intent: 'session', q: 0.3 });
  });

  it('stable-sorts by descending q, preserving client order on ties', () => {
    const result = parseMppAcceptPayment('tempo/charge, stripe/charge;q=0.5, solana/charge, evm/charge');
    expect(result.map((r) => `${r.method}/${r.intent}`)).toEqual([
      'tempo/charge',
      'solana/charge',
      'evm/charge',
      'stripe/charge',
    ]);
  });

  it('lowercases tokens', () => {
    const result = parseMppAcceptPayment('TEMPO/Charge');
    expect(result).toEqual([{ method: 'tempo', intent: 'charge', q: 1 }]);
  });

  it('drops malformed entries silently', () => {
    const result = parseMppAcceptPayment('tempo/charge, no-slash, tempo/, /charge, tempo/charge;q=5');
    expect(result).toEqual([{ method: 'tempo', intent: 'charge', q: 1 }]);
  });

  it('returns empty array for null / empty input', () => {
    expect(parseMppAcceptPayment(null)).toEqual([]);
    expect(parseMppAcceptPayment(undefined)).toEqual([]);
    expect(parseMppAcceptPayment('')).toEqual([]);
  });

  it('enforces method-id = 1*LOWERALPHA grammar', () => {
    expect(parseMppAcceptPayment('tempo1/charge')).toEqual([]);
    expect(parseMppAcceptPayment('tempo-net/charge')).toEqual([]);
  });
});

describe('matchMppRange', () => {
  const tempoCharge = { method: 'tempo', intent: 'charge', q: 1 } as const;
  const tempoStar = { method: 'tempo', intent: '*', q: 1 } as const;
  const starStar = { method: '*', intent: '*', q: 1 } as const;

  it('scores exact matches 2, one-wildcard 1, all-wildcard 0', () => {
    expect(matchMppRange(tempoCharge, 'tempo', 'charge')).toBe(2);
    expect(matchMppRange(tempoStar, 'tempo', 'charge')).toBe(1);
    expect(matchMppRange(starStar, 'tempo', 'charge')).toBe(0);
  });

  it('returns -1 on mismatch', () => {
    expect(matchMppRange(tempoCharge, 'stripe', 'charge')).toBe(-1);
    expect(matchMppRange(tempoCharge, 'tempo', 'session')).toBe(-1);
  });

  it('is case-insensitive on method', () => {
    expect(matchMppRange(tempoCharge, 'TEMPO', 'charge')).toBe(2);
  });
});

describe('decodeMppChargeRequest', () => {
  const base: MppChallenge = {
    id: 'x',
    realm: 'r',
    method: 'tempo',
    intent: 'charge',
    request: TEMPO_REQUEST_B64,
  };

  it('decodes the Tempo blockchain example from §Request Schema', () => {
    const req = decodeMppChargeRequest(base);
    expect(req.amount).toBe('1000000');
    expect(req.currency).toBe('0x20c0000000000000000000000000000000000000');
    expect(req.recipient).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00');
    expect(req.methodDetails).toEqual({ chainId: 42431, feePayer: true });
  });

  it('decodes the Stripe processor example (no recipient)', () => {
    const stripeReq = base64url(JSON.stringify({
      amount: '5000',
      currency: 'usd',
      description: 'Premium API access',
      externalId: 'order_12345',
      methodDetails: { networkId: 'profile_123', paymentMethodTypes: ['card', 'link'] },
    }));
    const req = decodeMppChargeRequest({ ...base, method: 'stripe', request: stripeReq });
    expect(req.amount).toBe('5000');
    expect(req.currency).toBe('usd');
    expect(req.recipient).toBeUndefined();
    expect(req.externalId).toBe('order_12345');
  });

  it('rejects non-charge intents', () => {
    expect(() =>
      decodeMppChargeRequest({ ...base, intent: 'session' }),
    ).toThrow(/intent="charge"/);
  });

  it('rejects missing required fields', () => {
    const bad = base64url(JSON.stringify({ amount: '100' }));
    expect(() =>
      decodeMppChargeRequest({ ...base, request: bad }),
    ).toThrow(/currency/);
  });

  it('rejects non-integer amounts', () => {
    const bad = base64url(JSON.stringify({ amount: '1.5', currency: 'usd' }));
    expect(() =>
      decodeMppChargeRequest({ ...base, request: bad }),
    ).toThrow(/non-negative integer/);
  });

  it('rejects invalid base64url', () => {
    expect(() =>
      decodeMppChargeRequest({ ...base, request: 'not valid!' }),
    ).toThrow(/base64url/);
  });

  it('rejects non-object JSON', () => {
    const arr = base64url(JSON.stringify([1, 2, 3]));
    expect(() =>
      decodeMppChargeRequest({ ...base, request: arr }),
    ).toThrow(/JSON object/);
  });
});

describe('decodeMppCredential', () => {
  const validCredential = {
    challenge: {
      id: 'x7Tg2pLqR9mKvNwY3hBcZa',
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: TEMPO_REQUEST_B64,
      expires: '2025-01-15T12:05:00Z',
    },
    source: 'did:example:alice',
    payload: { proof: '0xabc123' },
  };

  it('decodes a well-formed credential', () => {
    const header = `Payment ${base64url(JSON.stringify(validCredential))}`;
    const decoded = decodeMppCredential(header);
    expect(decoded.challenge.id).toBe('x7Tg2pLqR9mKvNwY3hBcZa');
    expect(decoded.source).toBe('did:example:alice');
    expect(decoded.payload).toEqual({ proof: '0xabc123' });
  });

  it('lowercases echoed method (trust-boundary normalization)', () => {
    const mixedCase = { ...validCredential, challenge: { ...validCredential.challenge, method: 'TEMPO' } };
    const header = `Payment ${base64url(JSON.stringify(mixedCase))}`;
    expect(decodeMppCredential(header).challenge.method).toBe('tempo');
  });

  it('rejects wrong auth-scheme', () => {
    expect(() => decodeMppCredential('Bearer xyz')).toThrow(/Authorization header/);
    expect(() => decodeMppCredential('')).toThrow(/missing/);
  });

  it('rejects credentials with missing challenge echo', () => {
    const bad = { payload: { proof: 'x' } };
    const header = `Payment ${base64url(JSON.stringify(bad))}`;
    expect(() => decodeMppCredential(header)).toThrow(/challenge/);
  });

  it('rejects credentials with missing payload', () => {
    const bad = { challenge: validCredential.challenge };
    const header = `Payment ${base64url(JSON.stringify(bad))}`;
    expect(() => decodeMppCredential(header)).toThrow(/payload/);
  });
});

describe('fromMppChargeChallenge', () => {
  const FUTURE = new Date(Date.UTC(2099, 0, 15, 12, 5, 0)).toISOString();
  const baseChallenge: MppChallenge = {
    id: 'abc',
    realm: 'api.example.com',
    method: 'tempo',
    intent: 'charge',
    request: TEMPO_REQUEST_B64,
    expires: FUTURE,
  };

  it('translates a Tempo Charge into s402 exact requirements', () => {
    const req = fromMppChargeChallenge(baseChallenge);
    expect(req.s402Version).toBe('1');
    expect(req.accepts).toEqual(['exact']);
    expect(req.network).toBe('tempo:42431');
    expect(req.asset).toBe('0x20c0000000000000000000000000000000000000');
    expect(req.amount).toBe('1000000');
    expect(req.payTo).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00');
    expect(req.expiresAt).toBe(Date.parse(FUTURE));
  });

  it('carries challenge provenance into extensions for downstream routing', () => {
    const req = fromMppChargeChallenge(baseChallenge);
    expect(req.extensions).toEqual({
      mpp: {
        challengeId: 'abc',
        method: 'tempo',
        intent: 'charge',
        realm: 'api.example.com',
      },
    });
  });

  it('resolves EVM chain ids via eip155:{chainId}', () => {
    const evmReq = base64url(JSON.stringify({
      amount: '1000',
      currency: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
      methodDetails: { chainId: 8453 },
    }));
    const req = fromMppChargeChallenge({ ...baseChallenge, method: 'evm', request: evmReq });
    expect(req.network).toBe('eip155:8453');
  });

  it('rejects processor-based methods (Stripe Charge has no payTo)', () => {
    const stripeReq = base64url(JSON.stringify({
      amount: '5000',
      currency: 'usd',
      methodDetails: { networkId: 'profile_123' },
    }));
    expect(() =>
      fromMppChargeChallenge({ ...baseChallenge, method: 'stripe', request: stripeReq }),
    ).toThrow(/processor-based/);
  });

  it('rejects blockchain Charge missing recipient', () => {
    const bad = base64url(JSON.stringify({
      amount: '1000',
      currency: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      methodDetails: { chainId: 8453 },
    }));
    expect(() =>
      fromMppChargeChallenge({ ...baseChallenge, method: 'evm', request: bad }),
    ).toThrow(/recipient/);
  });

  it('rejects expired challenges', () => {
    const pastChallenge = { ...baseChallenge, expires: '2020-01-01T00:00:00Z' };
    expect(() => fromMppChargeChallenge(pastChallenge)).toThrow(/expired/);
  });

  it('accepts an injected now clock for deterministic tests', () => {
    const now = Date.parse('2099-01-01T00:00:00Z');
    const req = fromMppChargeChallenge(baseChallenge, now);
    expect(req.expiresAt).toBeGreaterThan(now);
  });

  it('rejects unparseable expires', () => {
    expect(() =>
      fromMppChargeChallenge({ ...baseChallenge, expires: 'yesterday' }),
    ).toThrow(/RFC 3339/);
  });

  it('rejects non-charge intents defensively', () => {
    expect(() =>
      fromMppChargeChallenge({ ...baseChallenge, intent: 'session' }),
    ).toThrow(/intent="charge"/);
  });
});
