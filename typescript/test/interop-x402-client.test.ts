import { describe, it, expect } from 'vitest';
// The REAL upstream client, pinned at the version that ships from the x402 HEAD
// named in `X402_UPSTREAM_PIN`. Nothing in this file re-implements x402 — if
// the test passes, an unmodified `@x402/fetch` consumer got paid content from
// an s402 gate. If x402 changes its wire behavior, this test changes with it.
import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import type { SchemeNetworkClient, PaymentRequirements } from '@x402/core/types';
import { wrapFetchWithPayment } from '@x402/fetch';
import {
  s402ResourceServer,
  s402Facilitator,
  S402_VERSION,
  type s402ServerScheme,
  type s402FacilitatorScheme,
  type s402PaymentRequirements,
  type s402RouteConfig,
  type s402ExactPayload,
} from '../src/index.js';
import { s402Gate } from '../src/gate.js';

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
// server using this scheme with zero modifications." This is that sentence,
// executed. Three legs, each one a wire boundary the x402 client crosses:
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
      x402: { resource: { url: URL_, description: 'paid content', mimeType: 'application/json' } },
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
      x402: { resource: { url: URL_ } },
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

  it('without the x402 option the 402 stays s402-native (no wire change for existing servers)', async () => {
    const server = buildServer('x');
    const gate = s402Gate({
      server,
      requirements: server.buildRequirements({ schemes: ['exact'], price: PRICE, network: NETWORK, payTo: PAY_TO, asset: ASSET }),
    });
    const res = await gate(async () => Response.json({}))(new Request(URL_));
    const decoded = JSON.parse(atob(res.headers.get('payment-required')!));
    expect(decoded.s402Version).toBe(S402_VERSION);
    expect(decoded.x402Version).toBeUndefined();
    expect(decoded.accepts).toEqual(['exact']);
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
});
