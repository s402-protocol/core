import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  s402ResourceServer,
  s402Facilitator,
  encodePaymentPayload,
  decodeSettleResponse,
  S402_HEADERS,
  S402_VERSION,
  S402_WIRE_VERSION,
  s402Error,
  type s402ServerScheme,
  type s402FacilitatorScheme,
  type s402PaymentRequirements,
  type s402RouteConfig,
  type s402PaymentPayload,
  type s402ExactPayload,
} from '../src/index.js';
import { s402Gate } from '../src/gate.js';

// ── Test fixtures ─────────────────────────────────────────────────────────

const NETWORK = 'sui:testnet';
const PAY_TO = '0x' + 'a'.repeat(64);
/** x402's V2 envelope requires a resource, so every gate does too (ADR-016). */
const RESOURCE = { url: 'https://test/api/paid' };

function mockServerScheme(): s402ServerScheme {
  return {
    scheme: 'exact',
    buildRequirements(config: s402RouteConfig): s402PaymentRequirements {
      return {
        scheme: 'exact',
        network: config.network,
        asset: config.asset,
        amount: config.price,
        payTo: config.payTo,
      };
    },
  };
}

function mockFacilitatorScheme(): s402FacilitatorScheme {
  return {
    scheme: 'exact',
    async verify(payload, requirements) {
      if (payload.scheme !== 'exact') {
        return { valid: false as const, invalidReason: 'scheme mismatch' };
      }
      const exact = payload as s402ExactPayload;
      const expected = `mock-pay-${requirements.amount}-to-${requirements.payTo}`;
      if (exact.payload.transaction !== expected) {
        return { valid: false as const, invalidReason: 'transaction mismatch' };
      }
      return { valid: true as const, payerAddress: '0xpayer' };
    },
    async settle() {
      return {
        success: true as const,
        txDigest: 'mock-tx-' + Math.random().toString(36).slice(2, 10),
        finalityMs: 50,
      };
    },
  };
}

function buildServer() {
  const server = new s402ResourceServer();
  server.register(NETWORK, mockServerScheme());
  const facilitator = new s402Facilitator();
  facilitator.register(NETWORK, mockFacilitatorScheme());
  server.setFacilitator(facilitator);
  return server;
}

function buildRequirements(server: s402ResourceServer): s402PaymentRequirements {
  return server.buildRequirements({
    schemes: ['exact'],
    price: '1000000',
    network: NETWORK,
    payTo: PAY_TO,
    asset: '0x2::sui::SUI',
  });
}

function buildValidPayment(requirements: s402PaymentRequirements): string {
  const payload: s402ExactPayload = {
    s402Version: S402_VERSION,
    scheme: 'exact',
    payload: {
      transaction: `mock-pay-${requirements.amount}-to-${requirements.payTo}`,
      signature: '0xmock-sig',
    },
  };
  return encodePaymentPayload(payload as unknown as s402PaymentPayload);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('s402Gate — 402 flow', () => {
  let server: s402ResourceServer;
  let requirements: s402PaymentRequirements;

  beforeEach(() => {
    server = buildServer();
    requirements = buildRequirements(server);
  });

  it('responds 402 with payment-required header when no payment header present', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'should not see this' }));

    const res = await handler(new Request('http://test/api/paid'));

    expect(res.status).toBe(402);
    expect(res.headers.get(S402_HEADERS.PAYMENT_REQUIRED)).toBeTruthy();
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      x402Version: number;
      error: string;
      resource: { url: string };
      accepts: Array<{ scheme: string }>;
    };
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe('Payment Required');
    expect(body.resource.url).toBe(RESOURCE.url);
    expect(body.accepts.map((a) => a.scheme)).toContain('exact');
  });

  it('carries the wire version, amount and network in the default 402 body', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(new Request('http://test/api/paid'));
    const body = (await res.json()) as {
      accepts: Array<{ amount: string; network: string; extra: Record<string, unknown> }>;
      extensions: { s402: { version: string } };
    };
    // The s402 version lives in extensions.s402 now, not at the top level —
    // the top level is x402's, and every key on it is x402's to define.
    expect(body.extensions.s402.version).toBe(S402_WIRE_VERSION);
    expect(body.accepts[0].amount).toBe('1000000');
    expect(body.accepts[0].network).toBe(NETWORK);
  });

  it('invokes on402 customizer when provided', async () => {
    const gate = s402Gate({
      server,
      requirements,
      resource: RESOURCE,
      on402: (_req, required) =>
        new Response(`custom 402 for ${required.accepts[0].amount}`, { status: 402 }),
    });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(new Request('http://test/api/paid'));
    expect(res.status).toBe(402);
    expect(await res.text()).toBe('custom 402 for 1000000');
  });
});

describe('s402Gate — accept + settle flow', () => {
  let server: s402ResourceServer;
  let requirements: s402PaymentRequirements;

  beforeEach(() => {
    server = buildServer();
    requirements = buildRequirements(server);
  });

  it('runs the downstream handler when payment is valid and attaches x-payment-response', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'paid content' }));

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildValidPayment(requirements) },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: string };
    expect(body.data).toBe('paid content');

    const responseHeader = res.headers.get(S402_HEADERS.PAYMENT_RESPONSE);
    expect(responseHeader).toBeTruthy();
    const settled = decodeSettleResponse(responseHeader!);
    expect(settled.success).toBe(true);
    if (settled.success) expect(settled.txDigest).toMatch(/^mock-tx-/);
  });

  it('preserves downstream response status and existing headers', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(
      async () =>
        new Response('created', {
          status: 201,
          headers: { 'x-custom': 'keep-me', 'content-type': 'text/plain' },
        }),
    );

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildValidPayment(requirements) },
      }),
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('x-custom')).toBe('keep-me');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get(S402_HEADERS.PAYMENT_RESPONSE)).toBeTruthy();
    expect(await res.text()).toBe('created');
  });

  it('returns 402 with decoded-payload-invalid error when payment header is malformed', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: 'not-base64-at-all!!' },
      }),
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; errorCode: string };
    expect(body.errorCode).toBe('INVALID_PAYLOAD');
    expect(body.error).toMatch(/Invalid payment payload/i);
  });

  it('surfaces facilitator verify failures through the default error response', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    // Build a syntactically valid payload whose transaction field does NOT match.
    const badPayload: s402ExactPayload = {
      s402Version: S402_VERSION,
      scheme: 'exact',
      payload: { transaction: 'wrong-tx', signature: '0xmock-sig' },
    };

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: {
          [S402_HEADERS.PAYMENT]: encodePaymentPayload(badPayload as unknown as s402PaymentPayload),
        },
      }),
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/transaction mismatch/i);
  });

  it('invokes onError customizer when settlement fails', async () => {
    const onError = vi.fn(
      (_req: Request, err: { message: string; code?: string }) =>
        new Response(`custom err ${err.code}`, { status: 400 }),
    );
    const gate = s402Gate({ server, requirements, resource: RESOURCE, onError });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: 'not-base64!!' },
      }),
    );

    expect(onError).toHaveBeenCalledOnce();
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('custom err INVALID_PAYLOAD');
  });
});

describe('s402Gate — dynamic requirements', () => {
  it('evaluates requirements per-request when function is provided', async () => {
    const server = buildServer();
    const calls: string[] = [];

    const gate = s402Gate({
      server,
      requirements: (request) => {
        calls.push(new URL(request.url).pathname);
        return {
          scheme: 'exact' as const,
          network: NETWORK,
          asset: '0x2::sui::SUI',
          amount: new URL(request.url).pathname.endsWith('/premium') ? '5000000' : '1000000',
          payTo: PAY_TO,
        };
      },
      resource: RESOURCE,
    });
    const handler = gate(async () => Response.json({ data: 'should 402' }));

    const cheap = (await (await handler(new Request('http://test/api/basic'))).json()) as {
      accepts: Array<{ amount: string }>;
    };
    const premium = (await (await handler(new Request('http://test/api/premium'))).json()) as {
      accepts: Array<{ amount: string }>;
    };

    expect(cheap.accepts[0].amount).toBe('1000000');
    expect(premium.accepts[0].amount).toBe('5000000');
    expect(calls).toEqual(['/api/basic', '/api/premium']);
  });
});

describe('s402Gate — .check() escape hatch', () => {
  it('returns accepted:false + response when no payment header', async () => {
    const server = buildServer();
    const requirements = buildRequirements(server);
    const gate = s402Gate({ server, requirements, resource: RESOURCE });

    const result = await gate.check(new Request('http://test/api/paid'));

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.response.status).toBe(402);
    }
  });

  it('returns accepted:true + settle() when payment is valid', async () => {
    const server = buildServer();
    const requirements = buildRequirements(server);
    const gate = s402Gate({ server, requirements, resource: RESOURCE });

    const result = await gate.check(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildValidPayment(requirements) },
      }),
    );

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.payload.scheme).toBe('exact');
      expect(result.requirements.amount).toBe('1000000');
      const settled = await result.settle();
      expect(settled.success).toBe(true);
    }
  });

  it('throws if settle() is called twice on the same check result', async () => {
    const server = buildServer();
    const requirements = buildRequirements(server);
    const gate = s402Gate({ server, requirements, resource: RESOURCE });

    const result = await gate.check(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildValidPayment(requirements) },
      }),
    );

    if (!result.accepted) throw new Error('expected accepted');
    await result.settle();
    await expect(result.settle()).rejects.toThrow(/settle\(\) called more than once/);
  });
});

describe('s402Gate — HTTP hygiene', () => {
  let server: s402ResourceServer;
  let requirements: s402PaymentRequirements;

  beforeEach(() => {
    server = buildServer();
    requirements = buildRequirements(server);
  });

  it('default 402 sets cache-control: no-store and exposes s402 headers via CORS', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(new Request('http://test/api/paid'));

    expect(res.status).toBe(402);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const expose = res.headers.get('access-control-expose-headers') ?? '';
    expect(expose.toLowerCase()).toContain(S402_HEADERS.PAYMENT_REQUIRED);
    expect(expose.toLowerCase()).toContain(S402_HEADERS.PAYMENT_RESPONSE);
  });

  it('default error response sets cache-control: no-store and CORS expose', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: 'not-base64!!' },
      }),
    );

    expect(res.status).toBe(402);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-expose-headers')?.toLowerCase())
      .toContain(S402_HEADERS.PAYMENT_REQUIRED);
  });

  it('200 response after settlement exposes x-payment-response via CORS', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'paid content' }));

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildValidPayment(requirements) },
      }),
    );

    expect(res.status).toBe(200);
    const expose = res.headers.get('access-control-expose-headers') ?? '';
    expect(expose.toLowerCase()).toContain(S402_HEADERS.PAYMENT_RESPONSE);
  });

  it('merges CORS expose header when downstream handler already set one', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(
      async () =>
        new Response('ok', {
          status: 200,
          headers: { 'access-control-expose-headers': 'x-custom' },
        }),
    );

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildValidPayment(requirements) },
      }),
    );

    const expose = res.headers.get('access-control-expose-headers') ?? '';
    expect(expose).toContain('x-custom');
    expect(expose.toLowerCase()).toContain(S402_HEADERS.PAYMENT_RESPONSE);
  });

  it('on402 custom response gains cache-control + nosniff + CORS expose when absent', async () => {
    const gate = s402Gate({
      server,
      requirements,
      resource: RESOURCE,
      on402: () => new Response('custom', { status: 402 }),
    });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(new Request('http://test/api/paid'));

    expect(res.status).toBe(402);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-expose-headers')?.toLowerCase())
      .toContain(S402_HEADERS.PAYMENT_REQUIRED);
  });

  it('respects cache-control set by custom on402 (does not override)', async () => {
    const gate = s402Gate({
      server,
      requirements,
      resource: RESOURCE,
      on402: () =>
        new Response('custom', {
          status: 402,
          headers: { 'cache-control': 'private, max-age=5' },
        }),
    });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(new Request('http://test/api/paid'));

    expect(res.headers.get('cache-control')).toBe('private, max-age=5');
  });
});

describe('s402Gate — x402 wire compatibility (superset at the payment layer)', () => {
  let server: s402ResourceServer;
  let requirements: s402PaymentRequirements;

  beforeEach(() => {
    server = buildServer();
    requirements = buildRequirements(server);
  });

  // An x402 client sends its payment in x402 wire format: `x402Version`, no
  // `s402Version`. For the `exact` scheme this is shape-identical to s402, and
  // s402's payload validation treats the version field as optional — so it is
  // accepted with no config (the wire-level superset claim, proven at the gate).
  function buildX402Payment(reqs: s402PaymentRequirements): string {
    const x402Payload = {
      x402Version: 1,
      scheme: 'exact',
      payload: {
        transaction: `mock-pay-${reqs.amount}-to-${reqs.payTo}`,
        signature: '0xmock-sig',
      },
    };
    return btoa(JSON.stringify(x402Payload));
  }

  it('accepts and settles an x402 exact payment with no special config', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'paid via x402' }));

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildX402Payment(requirements) },
      }),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: string }).data).toBe('paid via x402');
    expect(res.headers.get(S402_HEADERS.PAYMENT_RESPONSE)).toBeTruthy();
  });

  it('still rejects a payment that is neither s402 nor x402', async () => {
    const gate = s402Gate({ server, requirements, resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: btoa(JSON.stringify({ foo: 'bar' })) },
      }),
    );

    expect(res.status).toBe(402);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('INVALID_PAYLOAD');
  });
});

describe('s402Gate — verify-before-serve (security-first default)', () => {
  let server: s402ResourceServer;
  let requirements: s402PaymentRequirements;

  beforeEach(() => {
    server = buildServer();
    requirements = buildRequirements(server);
  });

  function buildInvalidPayment(): string {
    // Syntactically valid payload, but the transaction won't verify (mock checks it).
    const bad: s402ExactPayload = {
      s402Version: S402_VERSION,
      scheme: 'exact',
      payload: { transaction: 'wrong-tx', signature: '0xmock-sig' },
    };
    return encodePaymentPayload(bad as unknown as s402PaymentPayload);
  }

  it('DEFAULT: rejects an invalid payment WITHOUT running the protected handler', async () => {
    const handler = vi.fn(async () => Response.json({ data: 'must not run' }));
    const gate = s402Gate({ server, requirements, resource: RESOURCE });

    const res = await gate(handler)(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildInvalidPayment() },
      }),
    );

    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled(); // ← the security property: no compute, no side effects
    const body = (await res.json()) as { errorCode: string; error: string };
    expect(body.errorCode).toBe('VERIFICATION_FAILED');
    expect(body.error).toMatch(/transaction mismatch/i);
  });

  it('DEFAULT: runs the handler only after the payment verifies', async () => {
    const handler = vi.fn(async () => Response.json({ data: 'paid' }));
    const gate = s402Gate({ server, requirements, resource: RESOURCE });

    const res = await gate(handler)(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildValidPayment(requirements) },
      }),
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('verifyBeforeServe:false (optimistic opt-out): handler RUNS before verify; body withheld on failure', async () => {
    const handler = vi.fn(async () => Response.json({ data: 'ran optimistically' }));
    const gate = s402Gate({ server, requirements, resource: RESOURCE, verifyBeforeServe: false });

    const res = await gate(handler)(
      new Request('http://test/api/paid', {
        headers: { [S402_HEADERS.PAYMENT]: buildInvalidPayment() },
      }),
    );

    expect(handler).toHaveBeenCalledOnce(); // optimistic: handler ran before verification
    expect(res.status).toBe(402); // settlement failed → error surfaced
    const body = (await res.json()) as { data?: string };
    expect(body.data).toBeUndefined(); // paywalled content still withheld
  });
});

describe('s402Gate — which offer a payment settles against', () => {
  // A 402 may offer several entries. Choosing the wrong one is not a cosmetic
  // bug: the entries differ in PRICE. Settling a payment for entry 1 against
  // entry 0 charges the wrong amount, on the wrong network, to the wrong payee.
  const OFFER_A: s402PaymentRequirements = {
    scheme: 'exact', network: NETWORK, asset: '0x2::sui::SUI',
    amount: '1000000', payTo: PAY_TO,
  };
  const OFFER_B: s402PaymentRequirements = {
    scheme: 'exact', network: NETWORK, asset: '0x2::usdc::USDC',
    amount: '5000000', payTo: PAY_TO,
  };

  const x402Header = (accepted: Record<string, unknown>, amount: string) =>
    btoa(JSON.stringify({
      x402Version: 2,
      accepted,
      payload: { transaction: `mock-pay-${amount}-to-${PAY_TO}`, signature: '0xmock-sig' },
    }));

  const wireOffer = (offer: s402PaymentRequirements) => ({
    scheme: offer.scheme, network: offer.network, asset: offer.asset,
    amount: offer.amount, payTo: offer.payTo, maxTimeoutSeconds: 60, extra: {},
  });

  it('settles an x402 payment against the entry its `accepted` names, not the first', async () => {
    const server = buildServer();
    const gate = s402Gate({ server, requirements: [OFFER_A, OFFER_B], resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'paid' }));

    // The mock facilitator only accepts `mock-pay-<amount>-to-<payTo>` for the
    // amount on the requirement it is handed — so a 200 here IS the assertion
    // that entry 1 was selected.
    const res = await handler(new Request('http://test/api/paid', {
      headers: { 'PAYMENT-SIGNATURE': x402Header(wireOffer(OFFER_B), OFFER_B.amount) },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'paid' });
  });

  it('refuses an x402 payment whose `accepted` matches no offer — never falls back', async () => {
    const server = buildServer();
    const gate = s402Gate({ server, requirements: [OFFER_A, OFFER_B], resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'should not see this' }));

    // Same scheme and network as OFFER_A, but a price nobody offered. Under the
    // old `?? accepts[0]` fallback this settled against OFFER_A.
    const forged = { ...wireOffer(OFFER_A), amount: '1' };
    const res = await handler(new Request('http://test/api/paid', {
      headers: { 'PAYMENT-SIGNATURE': x402Header(forged, '1') },
    }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('SCHEME_NOT_SUPPORTED');
  });

  it('refuses a native payment when two offers share its scheme and it cannot disambiguate', async () => {
    const server = buildServer();
    const gate = s402Gate({ server, requirements: [OFFER_A, OFFER_B], resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'should not see this' }));

    const res = await handler(new Request('http://test/api/paid', {
      headers: { [S402_HEADERS.PAYMENT]: buildValidPayment(OFFER_B) },
    }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; errorCode: string };
    expect(body.errorCode).toBe('INVALID_PAYLOAD');
    expect(body.error).toMatch(/ambiguous/i);
  });

  it('refuses a payment naming a scheme no entry offers', async () => {
    const server = buildServer();
    const gate = s402Gate({ server, requirements: [OFFER_A], resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'should not see this' }));

    const payload = {
      s402Version: S402_VERSION, scheme: 'stream',
      payload: { transaction: 'dHg=', signature: 'c2ln' },
    };
    const res = await handler(new Request('http://test/api/paid', {
      headers: { [S402_HEADERS.PAYMENT]: btoa(JSON.stringify(payload)) },
    }));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('SCHEME_NOT_SUPPORTED');
  });
});

describe('s402Gate — a 402 with no offers is a misconfiguration, not a response', () => {
  it('refuses an empty requirements array at construction', () => {
    const server = buildServer();
    expect(() => s402Gate({ server, requirements: [], resource: RESOURCE })).toThrow(s402Error);
    expect(() => s402Gate({ server, requirements: [], resource: RESOURCE }))
      .toThrow(/at least one/i);
  });

  it('refuses an empty array returned by a dynamic requirements function', async () => {
    const server = buildServer();
    const gate = s402Gate({ server, requirements: () => [], resource: RESOURCE });
    const handler = gate(async () => Response.json({ data: 'nope' }));
    await expect(handler(new Request('http://test/api/paid'))).rejects.toThrow(/at least one/i);
  });
});

describe('s402Gate — a mandate disagreement is a misconfiguration, not a per-request error', () => {
  const withMandate = (required: boolean): s402PaymentRequirements => ({
    scheme: required ? 'exact' : 'prepaid',
    network: NETWORK, asset: '0x2::sui::SUI', amount: '1000000', payTo: PAY_TO,
    mandate: { required },
  });

  it('throws at construction when two static offers disagree', () => {
    // A mandate authorizes the AGENT, so two answers on one 402 is a question
    // the wire has no slot for. The encoder catches it — but the encoder runs
    // on every 402, so an operator who got this wrong learns about it once per
    // request forever instead of once, at boot.
    const server = buildServer();
    expect(() => s402Gate({
      server,
      requirements: [withMandate(true), withMandate(false)],
      resource: RESOURCE,
    })).toThrow(s402Error);
    expect(() => s402Gate({
      server,
      requirements: [withMandate(true), withMandate(false)],
      resource: RESOURCE,
    })).toThrow(/mandate/i);
  });

  it('accepts static offers whose mandates differ only in key order', () => {
    const server = buildServer();
    expect(() => s402Gate({
      server,
      requirements: [
        { ...withMandate(true), mandate: { required: true, minPerTx: '5' } },
        { ...withMandate(true), scheme: 'prepaid', mandate: { minPerTx: '5', required: true } },
      ],
      resource: RESOURCE,
    })).not.toThrow();
  });

  it('still catches a dynamic disagreement at 402 time — the encoder is the backstop', () => {
    const server = buildServer();
    const gate = s402Gate({
      server,
      requirements: () => [withMandate(true), withMandate(false)],
      resource: RESOURCE,
    });
    const handler = gate(async () => Response.json({ data: 'nope' }));
    return expect(handler(new Request('http://test/api/paid'))).rejects.toThrow(/mandate/i);
  });
});
