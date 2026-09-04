import { describe, it, expect } from 'vitest';
// The REAL upstream client, pinned at the version that ships from the x402 HEAD
// named in `X402_UPSTREAM_PIN`. Nothing in this file re-implements x402 — if
// the test passes, an unmodified `@x402/fetch` consumer got paid content from
// an s402 gate. If x402 changes its wire behavior, this test changes with it.
import { x402Client } from '@x402/core/client';
import { parsePaymentRequired } from '@x402/core/schemas';
import { x402HTTPClient } from '@x402/core/http';
import type { SchemeNetworkClient, PaymentRequirements } from '@x402/core/types';
import { wrapFetchWithPayment } from '@x402/fetch';
import {
  s402Client,
  s402ResourceServer,
  s402Facilitator,
  decodePaymentRequired,
  detectProtocol,
  S402_VERSION,
  S402_WIRE_VERSION,
  type s402ServerScheme,
  type s402FacilitatorScheme,
  type s402PaymentRequirements,
  type s402RouteConfig,
  type s402ExactPayload,
} from '../src/index.js';
import { s402Gate } from '../src/gate.js';
import { s402Error } from '../src/errors.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const NETWORK = 'sui:testnet';
const PAY_TO = '0x' + 'a'.repeat(64);
const ASSET = '0x2::sui::SUI';
const PRICE = '1000000';
const URL_ = 'https://s402.test/paid';

/** The transaction string the mock facilitator will accept as "paid". */
const paidTx = (amount: string, payTo: string) => `mock-pay-${amount}-to-${payTo}`;

function serverScheme(): s402ServerScheme {
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

function facilitatorScheme(digest: string): s402FacilitatorScheme {
  return {
    scheme: 'exact',
    async verify(payload, requirements) {
      if (payload.scheme !== 'exact') return { valid: false as const, invalidReason: 'scheme mismatch' };
      const tx = (payload as s402ExactPayload).payload.transaction;
      if (tx !== paidTx(requirements.amount, requirements.payTo)) {
        return { valid: false as const, invalidReason: 'transaction mismatch' };
      }
      return { valid: true as const, payerAddress: '0xpayer' };
    },
    async settle() {
      return { success: true as const, txDigest: digest, finalityMs: 50 };
    },
  };
}

function buildServer(digest: string) {
  const server = new s402ResourceServer();
  server.register(NETWORK, serverScheme());
  const facilitator = new s402Facilitator();
  facilitator.register(NETWORK, facilitatorScheme(digest));
  server.setFacilitator(facilitator);
  return server;
}

/**
 * A minimal x402 scheme client for Sui. This stands where `@x402/sui` (x402
 * PR #3082, unmerged at the pinned HEAD) would stand: it produces the
 * `{ transaction, signature }` payload the Sui `exact` scheme carries. It is
 * the one piece a real deployment supplies; everything else is upstream code.
 */
function suiExactClient(): SchemeNetworkClient {
  return {
    scheme: 'exact',
    async createPaymentPayload(x402Version: number, req: PaymentRequirements) {
      return {
        x402Version,
        payload: { transaction: paidTx(req.amount, req.payTo), signature: 'sig' },
      };
    },
  };
}

/** The prepaid counterpart of {@link suiExactClient}, for the ordering test. */
function suiPrepaidClient(): SchemeNetworkClient {
  return {
    scheme: 'prepaid',
    async createPaymentPayload(x402Version: number, req: PaymentRequirements) {
      return {
        x402Version,
        payload: { transaction: `mock-prepaid-${req.amount}`, signature: 'sig' },
      };
    },
  };
}

/** An unmodified x402 client: `x402Client` + `wrapFetchWithPayment`, straight from upstream. */
function x402Fetch(fetchImpl: typeof globalThis.fetch) {
  const client = new x402Client()
    .register(NETWORK, suiExactClient())
    // Default spend controls only allow upstream's default-asset table, which
    // has no Sui entry. Disabling them is a client CONFIG choice, not a modification.
    .setSpendControls(false);
  return { client, http: new x402HTTPClient(client), fetchWithPay: wrapFetchWithPayment(fetchImpl, client) };
}

/** Route `fetch` calls in-process to a Web-Fetch handler. */
function inProcess(handler: (r: Request) => Response | Promise<Response>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof globalThis.fetch;
}

// ── The claim under test ──────────────────────────────────────────────────
//
// README (and docs/api/compat.md) say: "An x402 client can talk to an s402
// server with zero modifications — no client changes and no server options."
// This is that sentence, executed. Three legs, each a wire boundary the x402
// client crosses:
//
//   1. the 402 — the client must be able to READ s402's payment requirements
//   2. the payment — s402 must ACCEPT the header and payload shape x402 sends
//   3. the receipt — the client must be able to READ s402's settlement result

describe('an unmodified x402 client pays an s402 gate', () => {
  it('gets paid content in one wrapped fetch (all three legs)', async () => {
    const DIGEST = 'D1G3ST';
    const server = buildServer(DIGEST);
    let handlerRuns = 0;
    const gate = s402Gate({
      server,
      requirements: server.buildRequirements({ schemes: ['exact'], price: PRICE, network: NETWORK, payTo: PAY_TO, asset: ASSET }),
      resource: { url: URL_, description: 'paid content', mimeType: 'application/json' },
    });
    const handler = gate(async () => { handlerRuns++; return Response.json({ data: 'paid' }); });

    const { http, fetchWithPay } = x402Fetch(inProcess(handler));

    // Leg 1 + 2: one call, upstream's own retry-with-payment loop.
    const res = await fetchWithPay(URL_);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'paid' });
    expect(handlerRuns).toBe(1);

    // Leg 3: the receipt reads as an x402 SettleResponse to upstream's own decoder.
    const settle = http.getPaymentSettleResponse((n) => res.headers.get(n));
    expect(settle.success).toBe(true);
    expect(settle.transaction).toBe(DIGEST);
    expect(settle.network).toBe(NETWORK);
  });

  it('the 402 itself is a valid x402 V2 PaymentRequired to upstream\'s decoder', async () => {
    const server = buildServer('x');
    const gate = s402Gate({
      server,
      requirements: server.buildRequirements({ schemes: ['exact'], price: PRICE, network: NETWORK, payTo: PAY_TO, asset: ASSET }),
      resource: { url: URL_ },
    });
    const res = await gate(async () => Response.json({}))(new Request(URL_));
    expect(res.status).toBe(402);

    const { http } = x402Fetch(inProcess(async () => res));
    const pr = http.getPaymentRequiredResponse((n) => res.headers.get(n), await res.clone().json());
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe(URL_);
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', network: NETWORK, asset: ASSET, amount: PRICE, payTo: PAY_TO });
    expect(typeof pr.accepts[0].maxTimeoutSeconds).toBe('number');
    expect(pr.accepts[0].extra).toEqual({});
  });

  it('there is no second grammar: the 402 is an x402 envelope with no server option set', async () => {
    // ADR-016's invariant, stated as an absence. The gate below sets nothing
    // beyond what any s402 route needs, and what comes back on the wire is
    // still x402's document — there is no `accepts` of strings anywhere.
    const server = buildServer('x');
    const gate = s402Gate({
      server,
      requirements: server.buildRequirements({ schemes: ['exact'], price: PRICE, network: NETWORK, payTo: PAY_TO, asset: ASSET }),
      resource: { url: URL_ },
    });
    const res = await gate(async () => Response.json({}))(new Request(URL_));
    const decoded = JSON.parse(atob(res.headers.get('payment-required')!));

    expect(decoded.x402Version).toBe(2);
    expect(decoded.s402Version).toBeUndefined();
    expect(decoded.accepts).toEqual([{
      scheme: 'exact', network: NETWORK, asset: ASSET, amount: PRICE, payTo: PAY_TO,
      maxTimeoutSeconds: 60, extra: {},
    }]);
    // s402's own marker rides in extensions, where x402 leaves room for it.
    expect(decoded.extensions.s402).toEqual({ version: S402_WIRE_VERSION });
    // …and the body says the same thing, for a V1 client that reads only that.
    expect(await res.clone().json()).toEqual(decoded);
  });

  it('offers exact FIRST alongside prepaid, and the upstream client picks exact', async () => {
    // x402's client pays the first `accepts[]` entry it has a handler for. This
    // client has handlers for BOTH, so the only thing that can decide is order
    // — which is why `exact` is first whenever it is offered.
    const DIGEST = 'D4';
    const server = buildServer(DIGEST);
    const gate = s402Gate({
      server,
      requirements: server.buildPaymentRequired(
        { schemes: ['prepaid'], price: PRICE, network: NETWORK, payTo: PAY_TO, asset: ASSET },
        { url: URL_ },
      ).accepts,
      resource: { url: URL_ },
    });
    const handler = gate(async () => Response.json({ data: 'paid' }));

    let paidScheme: string | undefined;
    const observe = inProcess(async (request) => {
      const signature = request.headers.get('PAYMENT-SIGNATURE');
      if (signature) paidScheme = JSON.parse(atob(signature)).accepted?.scheme;
      return handler(request);
    });

    const client = new x402Client()
      .register(NETWORK, suiExactClient())
      .register(NETWORK, suiPrepaidClient())
      .setSpendControls(false);
    const http = new x402HTTPClient(client);

    // The 402 reads as a two-offer PaymentRequired to upstream's own decoder.
    const challenge = await observe(URL_);
    const pr = http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.clone().json());
    expect(pr.accepts.map((a) => a.scheme)).toEqual(['exact', 'prepaid']);
    expect(pr.accepts[0].network).toBe(NETWORK);

    const res = await wrapFetchWithPayment(observe, client)(URL_);
    expect(res.status).toBe(200);
    expect(paidScheme).toBe('exact');
  });

  it('a plain x402 402 — no s402 extensions at all — decodes into something payable', async () => {
    // The other direction of the same claim: an s402 client reaching a server
    // that has never heard of s402 gets requirements it can act on. Nothing of
    // ours produced this document.
    const plain = {
      x402Version: 2,
      resource: { url: 'https://x402.example.com/paid' },
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amount: '10000',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
      }],
    };

    const NOW = 1_700_000_000_000;
    const decoded = decodePaymentRequired(btoa(JSON.stringify(plain)), NOW);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.mandate).toBeUndefined();
    expect(decoded.extensions).toBeUndefined();
    expect(decoded.accepts[0]).toEqual({
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amount: '10000',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 300,
      // Derived, not copied: a 402 with no `extensions.s402` says nothing about
      // expiry, and an undefined `expiresAt` walks past every S1 guard.
      expiresAt: NOW + 300_000,
      // x402's own `extra` keys survive; the bag is theirs and open by spec.
      extra: { name: 'USD Coin', version: '2' },
    });
    // `detectProtocol` calls it x402 — that names the absence of s402's
    // extensions, never "not for us".
    const headers = new Headers({ 'payment-required': btoa(JSON.stringify(plain)) });
    expect(detectProtocol(headers)).toBe('x402');

    // And an s402 client pays it: the offer goes straight into createPayment.
    const client = new s402Client().register('eip155:8453', {
      scheme: 'exact',
      async createPayment(requirements) {
        return {
          s402Version: S402_VERSION,
          scheme: 'exact' as const,
          payload: { transaction: paidTx(requirements.amount, requirements.payTo), signature: 'sig' },
        };
      },
      verifySettlement: () => ({ verified: false, expectedDigest: '', actualDigest: null }),
    });
    const payload = await client.createPayment(decoded);
    expect(payload.scheme).toBe('exact');
  });

  it('an x402 V2 payload under PAYMENT-SIGNATURE is accepted even when the 402 was s402-native', async () => {
    // Intake is unconditional (ADR-013): a client that already knows the
    // requirements (e.g. from a normalized 402) must be able to pay in x402's
    // V2 dialect regardless of how THIS server emits its 402.
    const DIGEST = 'D2';
    const server = buildServer(DIGEST);
    const gate = s402Gate({
      server,
      requirements: server.buildRequirements({ schemes: ['exact'], price: PRICE, network: NETWORK, payTo: PAY_TO, asset: ASSET }),
      resource: { url: URL_ },
    });
    const handler = gate(async () => Response.json({ data: 'paid' }));

    const v2Payload = {
      x402Version: 2,
      resource: { url: URL_ },
      accepted: { scheme: 'exact', network: NETWORK, asset: ASSET, amount: PRICE, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: {} },
      payload: { transaction: paidTx(PRICE, PAY_TO), signature: 'sig' },
    };
    const res = await handler(new Request(URL_, { headers: { 'PAYMENT-SIGNATURE': btoa(JSON.stringify(v2Payload)) } }));
    expect(res.status).toBe(200);

    // Addressed in x402's dialect → answered in x402's dialect.
    const settle = JSON.parse(atob(res.headers.get('payment-response')!));
    expect(settle).toMatchObject({ success: true, transaction: DIGEST, network: NETWORK });
  });

  it('an s402-native payment still gets an s402-native receipt (dialect echo, not a global change)', async () => {
    const DIGEST = 'D3';
    const server = buildServer(DIGEST);
    const gate = s402Gate({
      server,
      requirements: server.buildRequirements({ schemes: ['exact'], price: PRICE, network: NETWORK, payTo: PAY_TO, asset: ASSET }),
      resource: { url: URL_ },
    });
    const handler = gate(async () => Response.json({ data: 'paid' }));
    const native = { s402Version: S402_VERSION, scheme: 'exact', payload: { transaction: paidTx(PRICE, PAY_TO), signature: 'sig' } };
    const res = await handler(new Request(URL_, { headers: { 'x-payment': btoa(JSON.stringify(native)) } }));
    expect(res.status).toBe(200);
    const settle = JSON.parse(atob(res.headers.get('payment-response')!));
    expect(settle.txDigest).toBe(DIGEST);
    expect(settle.transaction).toBeUndefined();
    expect(settle.network).toBeUndefined();
  });

  it('pays the offer its `accepted` names, not the first one on the menu', async () => {
    // Two `exact` offers at DIFFERENT prices. Upstream's client has a handler
    // for the second network only, so it picks offer 1 and its `accepted`
    // carries that offer in full. The gate must settle against THAT one — the
    // mock facilitator only accepts `mock-pay-<amount>-to-<payTo>` for the
    // amount on the requirement it is handed, so a 200 is the assertion.
    const OTHER = 'sui:mainnet';
    const DIGEST = 'D5';
    const server = buildServer(DIGEST);
    const gate = s402Gate({
      server,
      requirements: [
        { scheme: 'exact', network: OTHER, asset: ASSET, amount: '9999999', payTo: PAY_TO },
        { scheme: 'exact', network: NETWORK, asset: ASSET, amount: PRICE, payTo: PAY_TO },
      ],
      resource: { url: URL_ },
    });
    const handler = gate(async () => Response.json({ data: 'paid' }));

    const { http, fetchWithPay } = x402Fetch(inProcess(handler));

    const challenge = await handler(new Request(URL_));
    const pr = http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.clone().json());
    expect(pr.accepts.map((a) => a.network)).toEqual([OTHER, NETWORK]);

    const res = await fetchWithPay(URL_);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'paid' });

    const settle = http.getPaymentSettleResponse((n) => res.headers.get(n));
    expect(settle.network).toBe(NETWORK);
  });

  it('refuses a payment naming an offer the route never made', async () => {
    const server = buildServer('D6');
    const gate = s402Gate({
      server,
      requirements: server.buildRequirements({ schemes: ['exact'], price: PRICE, network: NETWORK, payTo: PAY_TO, asset: ASSET }),
      resource: { url: URL_ },
    });
    const handler = gate(async () => Response.json({ data: 'should not see this' }));

    // Everything matches the real offer except the price. Under a
    // scheme-name-only match with an `accepts[0]` fallback, this settled.
    const forged = {
      x402Version: 2,
      accepted: { scheme: 'exact', network: NETWORK, asset: ASSET, amount: '1', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: {} },
      payload: { transaction: paidTx('1', PAY_TO), signature: 'sig' },
    };
    const res = await handler(new Request(URL_, { headers: { 'PAYMENT-SIGNATURE': btoa(JSON.stringify(forged)) } }));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('SCHEME_NOT_SUPPORTED');
  });
});

// ── Item 12: the invariant, checked with upstream's own parser ────────────
//
// The tests above drive `@x402/fetch`, whose header decoder only `JSON.parse`s
// what it is given — so for the whole life of ADR-016 the named ratchet could
// not have caught a 402 that violated the invariant. `parsePaymentRequired` is
// upstream's schema, and these are the configurations that got past everything
// else: each one type-checks as `S402GateOptions`, and each one used to produce
// a header the pinned `@x402/core` refuses.

describe('every 402 the gate emits parses under the pinned @x402/core schema', () => {
  const gateFor = (over: Partial<Parameters<typeof s402Gate>[0]>) => s402Gate({
    server: buildServer('x'),
    requirements: { scheme: 'exact', network: NETWORK, asset: ASSET, amount: PRICE, payTo: PAY_TO },
    resource: { url: URL_ },
    ...over,
  } as Parameters<typeof s402Gate>[0]);

  it('the ordinary case parses, and the parse is a real check (a hand-broken document fails it)', async () => {
    const res = await gateFor({})(async () => Response.json({}))(new Request(URL_));
    const emitted = JSON.parse(atob(res.headers.get('payment-required')!));
    expect(parsePaymentRequired(emitted).success).toBe(true);

    // The negative control. Without it, `success: true` above could mean the
    // parser accepts everything — which is exactly the hole `@x402/fetch` left.
    expect(parsePaymentRequired({ ...emitted, resource: { url: '' } }).success).toBe(false);
    expect(parsePaymentRequired({ ...emitted, accepts: [] }).success).toBe(false);
  });

  const REFUSED: Array<[string, Partial<Parameters<typeof s402Gate>[0]>]> = [
    ['an empty resource.url', { resource: { url: '' } }],
    ['a zero maxTimeoutSeconds', { requirements: { scheme: 'exact', network: NETWORK, asset: ASSET, amount: PRICE, payTo: PAY_TO, maxTimeoutSeconds: 0 } }],
    ['a network that is not CAIP-2', { requirements: { scheme: 'exact', network: 'base-sepolia', asset: ASSET, amount: PRICE, payTo: PAY_TO } }],
    ['a non-ASCII serviceName', { resource: { url: URL_, serviceName: 'Café Paiement ☕' } }],
    ['a serviceName over 32 characters', { resource: { url: URL_, serviceName: 'x'.repeat(33) } }],
    ['six tags where upstream caps at five', { resource: { url: URL_, tags: ['a', 'b', 'c', 'd', 'e', 'f'] } }],
    ['an iconUrl over 2048 characters', { resource: { url: URL_, iconUrl: 'https://x/' + 'y'.repeat(2100) } }],
    ['an empty payTo', { requirements: { scheme: 'exact', network: NETWORK, asset: ASSET, amount: PRICE, payTo: '' } }],
    ['an empty asset', { requirements: { scheme: 'exact', network: NETWORK, asset: '', amount: PRICE, payTo: PAY_TO } }],
    ['an amount that is a number, not a string', { requirements: { scheme: 'exact', network: NETWORK, asset: ASSET, amount: 1000 as unknown as string, payTo: PAY_TO } }],
  ];

  for (const [label, over] of REFUSED) {
    it(`refuses to emit a 402 with ${label} rather than publishing one upstream cannot read`, async () => {
      const handler = gateFor(over)(async () => Response.json({}));
      await expect(handler(new Request(URL_))).rejects.toThrow(s402Error);
    });
  }

  it('a resource omitted entirely is refused too (x402 V2 requires one)', async () => {
    const handler = gateFor({ resource: undefined as unknown as { url: string } })(async () => Response.json({}));
    await expect(handler(new Request(URL_))).rejects.toThrow(s402Error);
  });

  it('and the body carries the same document the header does, so both are checked', async () => {
    const res = await gateFor({})(async () => Response.json({}))(new Request(URL_));
    const fromHeader = JSON.parse(atob(res.headers.get('payment-required')!));
    const fromBody = await res.clone().json();
    expect(fromBody).toEqual(fromHeader);
    expect(parsePaymentRequired(fromBody).success).toBe(true);
  });
});
