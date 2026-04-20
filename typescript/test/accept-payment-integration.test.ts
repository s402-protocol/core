/**
 * End-to-end integration for the Accept-Payment coexistence pattern.
 *
 * Runs a live Node HTTP server that:
 *   - advertises its supported schemes via `Accept-Payment` on 402 responses
 *   - reads the client's `Accept-Payment` header and negotiates a scheme
 *   - returns 406 Not Acceptable when no overlap exists
 *
 * Exercises the exact pattern documented in guide/upgrade-mpp.md using only
 * the APIs shipped in `s402` today (no speculative compat modules).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  parseAcceptPayment,
  selectBestScheme,
  formatAcceptPayment,
  S402_HEADERS,
} from '../src/index.js';

const SUPPORTED = ['s402/exact', 's402/prepaid'] as const;
const ACCEPT_PAYMENT = formatAcceptPayment(
  SUPPORTED.map((scheme) => ({ scheme, q: 1 })),
);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const preferred = parseAcceptPayment(
      req.headers[S402_HEADERS.ACCEPT_PAYMENT] as string | undefined,
    );
    const chosen = selectBestScheme(preferred, SUPPORTED);

    if (preferred.length > 0 && chosen === null) {
      res.writeHead(406, {
        [S402_HEADERS.ACCEPT_PAYMENT]: ACCEPT_PAYMENT,
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'Not Acceptable', serverSchemes: [...SUPPORTED] }));
      return;
    }

    res.writeHead(402, {
      [S402_HEADERS.ACCEPT_PAYMENT]: ACCEPT_PAYMENT,
      'x-chosen-scheme': chosen ?? '',
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ error: 'Payment Required', chosen }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Accept-Payment coexistence — live server', () => {
  it('advertises supported schemes on 402 responses', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(402);
    expect(res.headers.get('accept-payment')).toBe('s402/exact, s402/prepaid');
  });

  it('picks the client\'s highest-q matching scheme', async () => {
    const res = await fetch(baseUrl, {
      headers: { 'accept-payment': 's402/prepaid;q=0.9, s402/exact;q=0.5' },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('x-chosen-scheme')).toBe('s402/prepaid');
  });

  it('respects server preference when client lists equal q-values', async () => {
    const res = await fetch(baseUrl, {
      headers: { 'accept-payment': 's402/prepaid, s402/exact' },
    });
    expect(res.status).toBe(402);
    // Client preferred 's402/prepaid' first (q=1, listed first) — server supports it.
    expect(res.headers.get('x-chosen-scheme')).toBe('s402/prepaid');
  });

  it('returns 406 when no overlap exists', async () => {
    const res = await fetch(baseUrl, {
      headers: { 'accept-payment': 'tempo/charge, stripe/lightning' },
    });
    expect(res.status).toBe(406);
    const body = await res.json();
    expect(body.serverSchemes).toEqual(['s402/exact', 's402/prepaid']);
    expect(res.headers.get('accept-payment')).toBe('s402/exact, s402/prepaid');
  });

  it('skips q=0 rejections and picks the next match', async () => {
    const res = await fetch(baseUrl, {
      headers: { 'accept-payment': 's402/prepaid;q=0, s402/exact' },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('x-chosen-scheme')).toBe('s402/exact');
  });

  it('falls back to server default when client omits Accept-Payment', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(402);
    expect(res.headers.get('x-chosen-scheme')).toBe('s402/exact');
  });
});
