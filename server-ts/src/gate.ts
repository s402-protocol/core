/**
 * s402Gate — framework-agnostic payment gate for s402-protected routes.
 *
 * Returns a middleware that:
 *   1. Reads the `x-payment` header from the incoming `Request`.
 *   2. If absent → responds `402 Payment Required` with encoded requirements.
 *   3. If present → decodes, runs server.process() (verify + settle), then
 *      invokes the downstream handler and attaches the `x-payment-response`
 *      header to its `Response` so the client sees the settlement receipt.
 *
 * Signature is pure Web Fetch: `(Request) => Promise<Response>`. This works
 * natively in Hono (via `c.req.raw`), Next.js Route Handlers, Bun, Deno, and
 * Cloudflare Workers. For callers that need the raw gate result — e.g. to
 * thread settlement through a non-Fetch framework — use `.check()`.
 */

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
} from 's402';
import {
  encodePaymentRequired,
  decodePaymentPayload,
  encodeSettleResponse,
  S402_HEADERS,
} from 's402';
import type { s402ResourceServer } from 's402';

/** A Web Fetch-style handler. */
export type S402GateHandler = (request: Request) => Response | Promise<Response>;

/** Middleware shape: takes a downstream handler, returns a wrapped handler. */
export type S402Middleware = (next: S402GateHandler) => S402GateHandler;

/** Options for {@link s402Gate}. */
export interface S402GateOptions {
  /** Configured s402 resource server (with facilitator + schemes registered). */
  server: s402ResourceServer;

  /**
   * Payment requirements for the gated route. May be a static object or a
   * function called per-request (e.g. for dynamic pricing / path-based rules).
   */
  requirements:
    | s402PaymentRequirements
    | ((request: Request) => s402PaymentRequirements | Promise<s402PaymentRequirements>);

  /**
   * Optional custom 402 response builder. Defaults to JSON body with `payment-required`
   * header. Returning `undefined` falls back to the default.
   */
  on402?: (
    request: Request,
    requirements: s402PaymentRequirements,
  ) => Response | Promise<Response> | undefined;

  /**
   * Optional custom error response for payment processing failures (400/402/500 range).
   * Defaults to JSON `{ error, errorCode }` with status 402.
   */
  onError?: (
    request: Request,
    error: { message: string; code?: string },
  ) => Response | Promise<Response> | undefined;
}

/** Result of the low-level `.check()` escape hatch. */
export type S402CheckResult =
  | {
      accepted: false;
      /** The canned `Response` to send back (402 or error). */
      response: Response;
    }
  | {
      accepted: true;
      /** Decoded payload. Pass to `result.settle()` when ready. */
      payload: s402PaymentPayload;
      /** Resolved requirements (after dynamic evaluation). */
      requirements: s402PaymentRequirements;
      /** Completes verify+settle. Call exactly once. */
      settle: () => Promise<s402SettleResponse>;
    };

/** Returned by {@link s402Gate}. Either use as middleware or drop down to `.check()`. */
export interface S402Gate extends S402Middleware {
  /**
   * Low-level escape hatch. Runs the 402-vs-payment branch but does NOT settle
   * automatically. Call `result.settle()` once you're ready to consume the payment.
   */
  check: (request: Request) => Promise<S402CheckResult>;
}

const JSON_CT = 'application/json; charset=utf-8';

/**
 * Headers we tell browsers they're allowed to read from the response. Without
 * this, `fetch()` in a browser cannot see `payment-required` or
 * `x-payment-response` due to CORS policy — the s402 flow silently breaks on
 * cross-origin agent UIs.
 */
const CORS_EXPOSE = `${S402_HEADERS.PAYMENT_REQUIRED}, ${S402_HEADERS.PAYMENT_RESPONSE}`;

/**
 * Create an s402 payment gate.
 *
 * @example Hono
 * ```ts
 * import { s402Gate } from '@sweefi/server';
 * const gate = s402Gate({ server, requirements });
 *
 * app.get('/api/paid', (c) =>
 *   gate(async () => Response.json({ data: 'hello, paid world' }))(c.req.raw),
 * );
 * ```
 *
 * @example Next.js App Router
 * ```ts
 * export const GET = s402Gate({ server, requirements })(async () =>
 *   Response.json({ data: 'paid content' }),
 * );
 * ```
 *
 * @example Bun / Cloudflare Workers / Deno
 * ```ts
 * Bun.serve({
 *   fetch: s402Gate({ server, requirements })(async () => Response.json({ ok: true })),
 * });
 * ```
 */
export function s402Gate(options: S402GateOptions): S402Gate {
  const middleware: S402Middleware = (next) => {
    return async (request: Request): Promise<Response> => {
      const check = await runCheck(request, options);
      if (!check.accepted) return check.response;

      // Run the downstream handler. It produces the business response.
      const handlerResponse = await next(request);

      // Now settle. If settlement fails, we surface it instead of the success body.
      let settleResult: s402SettleResponse;
      try {
        settleResult = await check.settle();
      } catch (e) {
        return buildError(
          request,
          options,
          { message: e instanceof Error ? e.message : String(e), code: 'SETTLEMENT_FAILED' },
        );
      }

      if (!settleResult.success) {
        return buildError(request, options, {
          message: settleResult.error ?? 'Settlement failed',
          code: settleResult.errorCode,
        });
      }

      // Attach the settlement receipt header to the handler's response.
      // Also ensure browsers can read the s402 headers cross-origin.
      const headers = new Headers(handlerResponse.headers);
      headers.set(S402_HEADERS.PAYMENT_RESPONSE, encodeSettleResponse(settleResult));
      mergeExposeHeaders(headers);
      return new Response(handlerResponse.body, {
        status: handlerResponse.status,
        statusText: handlerResponse.statusText,
        headers,
      });
    };
  };

  const gate = middleware as S402Gate;
  gate.check = (request: Request) => runCheck(request, options);
  return gate;
}

async function runCheck(
  request: Request,
  options: S402GateOptions,
): Promise<S402CheckResult> {
  const requirements = await resolveRequirements(request, options);
  const paymentHeader = request.headers.get(S402_HEADERS.PAYMENT);

  if (!paymentHeader) {
    return {
      accepted: false,
      response: await build402(request, options, requirements),
    };
  }

  let payload: s402PaymentPayload;
  try {
    payload = decodePaymentPayload(paymentHeader);
  } catch (e) {
    return {
      accepted: false,
      response: await buildError(request, options, {
        message: `Invalid payment payload: ${e instanceof Error ? e.message : String(e)}`,
        code: 'INVALID_PAYLOAD',
      }),
    };
  }

  let settled = false;
  return {
    accepted: true,
    payload,
    requirements,
    settle: async () => {
      if (settled) {
        throw new Error('s402Gate: settle() called more than once on the same request');
      }
      settled = true;
      return options.server.process(payload, requirements);
    },
  };
}

async function resolveRequirements(
  request: Request,
  options: S402GateOptions,
): Promise<s402PaymentRequirements> {
  return typeof options.requirements === 'function'
    ? options.requirements(request)
    : options.requirements;
}

async function build402(
  request: Request,
  options: S402GateOptions,
  requirements: s402PaymentRequirements,
): Promise<Response> {
  const custom = await options.on402?.(request, requirements);
  if (custom) return withHygiene(custom);

  return new Response(
    JSON.stringify({
      error: 'Payment Required',
      s402Version: requirements.s402Version,
      accepts: requirements.accepts,
      network: requirements.network,
      amount: requirements.amount,
      asset: requirements.asset,
    }),
    {
      status: 402,
      headers: {
        'content-type': JSON_CT,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'access-control-expose-headers': CORS_EXPOSE,
        [S402_HEADERS.PAYMENT_REQUIRED]: encodePaymentRequired(requirements),
      },
    },
  );
}

async function buildError(
  request: Request,
  options: S402GateOptions,
  error: { message: string; code?: string },
): Promise<Response> {
  const custom = await options.onError?.(request, error);
  if (custom) return withHygiene(custom);

  return new Response(
    JSON.stringify({ error: error.message, errorCode: error.code ?? 'UNKNOWN' }),
    {
      status: 402,
      headers: {
        'content-type': JSON_CT,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'access-control-expose-headers': CORS_EXPOSE,
      },
    },
  );
}

/**
 * Wrap a user-supplied (on402 / onError) `Response` with s402 hygiene headers
 * without overwriting anything they set. Users keep full control of status +
 * body; we only add defaults for `cache-control` and `access-control-expose-
 * headers` when absent.
 */
function withHygiene(response: Response): Response {
  const needsCache = !response.headers.has('cache-control');
  const needsSniff = !response.headers.has('x-content-type-options');
  const needsExpose = !response.headers.has('access-control-expose-headers');
  if (!needsCache && !needsSniff && !needsExpose) return response;

  const headers = new Headers(response.headers);
  if (needsCache) headers.set('cache-control', 'no-store');
  if (needsSniff) headers.set('x-content-type-options', 'nosniff');
  if (needsExpose) mergeExposeHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Merge s402 header names into an existing `Access-Control-Expose-Headers`
 * value (if the downstream handler already set one), preserving whatever else
 * it already exposed.
 */
function mergeExposeHeaders(headers: Headers): void {
  const existing = headers.get('access-control-expose-headers');
  if (!existing) {
    headers.set('access-control-expose-headers', CORS_EXPOSE);
    return;
  }
  const tokens = new Set(existing.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
  const merged: string[] = existing.split(',').map((t) => t.trim()).filter(Boolean);
  for (const name of [S402_HEADERS.PAYMENT_REQUIRED, S402_HEADERS.PAYMENT_RESPONSE]) {
    if (!tokens.has(name.toLowerCase())) merged.push(name);
  }
  headers.set('access-control-expose-headers', merged.join(', '));
}
