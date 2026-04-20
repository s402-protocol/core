# @sweefi/server

Framework-agnostic s402 middleware. `s402Gate()` turns ~120 lines of 402-handshake boilerplate into one.

```bash
pnpm add @sweefi/server s402
```

> **ESM-only.** Requires Node.js ≥18. Works anywhere the Web Fetch API works: Hono, Next.js Route Handlers, Bun, Deno, Cloudflare Workers.

## The shape

`s402Gate()` returns a middleware — a function that wraps your route handler. The wrapper does the full 402 dance: reads the `x-payment` header, sends 402 with encoded requirements if missing, runs verify+settle if present, and attaches the `x-payment-response` settlement receipt to your handler's response.

```ts
import { s402Gate } from '@sweefi/server';
import { s402ResourceServer, s402Facilitator } from 's402';

const server = new s402ResourceServer();
server.register('sui:mainnet', mySuiScheme());
const facilitator = new s402Facilitator();
facilitator.register('sui:mainnet', mySuiFacilitatorScheme());
server.setFacilitator(facilitator);

const requirements = server.buildRequirements({
  schemes: ['exact'],
  price: '1000000',
  network: 'sui:mainnet',
  payTo: MY_ADDRESS,
  asset: '0x2::sui::SUI',
});

const gate = s402Gate({ server, requirements });
```

## Hono

```ts
app.get('/api/paid', (c) =>
  gate(async () => Response.json({ data: 'hello, paid world' }))(c.req.raw),
);
```

## Next.js App Router

```ts
// app/api/paid/route.ts
export const GET = gate(async () => Response.json({ data: 'paid content' }));
```

## Bun / Cloudflare Workers / Deno

```ts
Bun.serve({
  fetch: gate(async () => Response.json({ ok: true })),
});
```

## Dynamic requirements

Pass a function for per-request pricing, auth-aware tiers, or path routing:

```ts
const gate = s402Gate({
  server,
  requirements: (req) => buildRequirementsFor(new URL(req.url).pathname),
});
```

## Customizing 402 and error responses

```ts
const gate = s402Gate({
  server,
  requirements,
  on402: (req, reqs) =>
    Response.json({ custom: '402', amount: reqs.amount }, { status: 402 }),
  onError: (req, err) =>
    Response.json({ error: err.message, code: err.code }, { status: 402 }),
});
```

## Escape hatch: `.check()`

When you need to own the request/response lifecycle (e.g. gating a WebSocket upgrade, a streaming SSE handler, or a non-Fetch framework), use `.check()`:

```ts
const result = await gate.check(request);
if (!result.accepted) return result.response;

// Do whatever work you need — you've already confirmed a valid payment is present.
await doTheWork(result.payload);

// Settle exactly once, at the moment you're committed to delivery.
const settled = await result.settle();
if (!settled.success) return errorResponseFrom(settled);

response.headers.set('x-payment-response', encodeSettleResponse(settled));
return response;
```

`settle()` may be called at most once; a second call throws.

## Why framework-agnostic

Hono, Next.js, Bun, Deno, and Cloudflare Workers all speak Web Fetch `Request`/`Response`. One middleware, every host. Express — still on Node `IncomingMessage` / `ServerResponse` — needs a thin adapter; use `.check()` plus `encodePaymentRequired` / `encodeSettleResponse` from `s402` directly.

## License

Apache-2.0
