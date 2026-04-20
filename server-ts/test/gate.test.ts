import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  s402ResourceServer,
  s402Facilitator,
  encodePaymentPayload,
  decodeSettleResponse,
  S402_HEADERS,
  S402_VERSION,
  type s402ServerScheme,
  type s402FacilitatorScheme,
  type s402PaymentRequirements,
  type s402RouteConfig,
  type s402PaymentPayload,
  type s402ExactPayload,
} from 's402';
import { s402Gate } from '../src/index.js';

// ── Test fixtures ─────────────────────────────────────────────────────────

const NETWORK = 'sui:testnet';
const PAY_TO = '0x' + 'a'.repeat(64);

function mockServerScheme(): s402ServerScheme {
  return {
    scheme: 'exact',
    buildRequirements(config: s402RouteConfig): s402PaymentRequirements {
      return {
        s402Version: S402_VERSION,
        accepts: [...new Set([...config.schemes, 'exact' as const])],
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
    const gate = s402Gate({ server, requirements });
    const handler = gate(async () => Response.json({ data: 'should not see this' }));

    const res = await handler(new Request('http://test/api/paid'));

    expect(res.status).toBe(402);
    expect(res.headers.get(S402_HEADERS.PAYMENT_REQUIRED)).toBeTruthy();
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: string; accepts: string[] };
    expect(body.error).toBe('Payment Required');
    expect(body.accepts).toContain('exact');
  });

  it('includes s402Version + amount + network in default 402 body', async () => {
    const gate = s402Gate({ server, requirements });
    const handler = gate(async () => Response.json({ data: 'nope' }));

    const res = await handler(new Request('http://test/api/paid'));
    const body = (await res.json()) as {
      s402Version: string;
      amount: string;
      network: string;
    };
    expect(body.s402Version).toBe(S402_VERSION);
    expect(body.amount).toBe('1000000');
    expect(body.network).toBe(NETWORK);
  });

  it('invokes on402 customizer when provided', async () => {
    const gate = s402Gate({
      server,
      requirements,
      on402: (_req, reqs) =>
        new Response(`custom 402 for ${reqs.amount}`, { status: 402 }),
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
    const gate = s402Gate({ server, requirements });
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
    const gate = s402Gate({ server, requirements });
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
    const gate = s402Gate({ server, requirements });
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
    const gate = s402Gate({ server, requirements });
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
    const gate = s402Gate({ server, requirements, onError });
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
          s402Version: S402_VERSION,
          accepts: ['exact'],
          network: NETWORK,
          asset: '0x2::sui::SUI',
          amount: new URL(request.url).pathname.endsWith('/premium') ? '5000000' : '1000000',
          payTo: PAY_TO,
        };
      },
    });
    const handler = gate(async () => Response.json({ data: 'should 402' }));

    const cheap = (await (await handler(new Request('http://test/api/basic'))).json()) as {
      amount: string;
    };
    const premium = (await (await handler(new Request('http://test/api/premium'))).json()) as {
      amount: string;
    };

    expect(cheap.amount).toBe('1000000');
    expect(premium.amount).toBe('5000000');
    expect(calls).toEqual(['/api/basic', '/api/premium']);
  });
});

describe('s402Gate — .check() escape hatch', () => {
  it('returns accepted:false + response when no payment header', async () => {
    const server = buildServer();
    const requirements = buildRequirements(server);
    const gate = s402Gate({ server, requirements });

    const result = await gate.check(new Request('http://test/api/paid'));

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.response.status).toBe(402);
    }
  });

  it('returns accepted:true + settle() when payment is valid', async () => {
    const server = buildServer();
    const requirements = buildRequirements(server);
    const gate = s402Gate({ server, requirements });

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
    const gate = s402Gate({ server, requirements });

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
