/**
 * s402Gate — framework-agnostic payment gate for s402-protected routes.
 *
 * Returns a middleware that:
 *   1. Reads the payment header from the incoming `Request` — s402's `x-payment`,
 *      or x402's `PAYMENT-SIGNATURE` (V2) / `X-PAYMENT` (V1). x402 intake is
 *      always on: compatibility obliges s402 to understand x402 (ADR-013).
 *   2. If absent → responds `402 Payment Required` with an x402 V2
 *      `PaymentRequired` envelope in the header and the body. Always, on every
 *      route, with no option to select another grammar (ADR-016) — which is why
 *      an unmodified x402 client can pay this gate with no server flag.
 *   3. If present → decodes, runs server.process() (verify + settle), then
 *      invokes the downstream handler and attaches the `payment-response`
 *      header to its `Response` so the client sees the settlement receipt —
 *      in the dialect the client addressed us in.
 *
 * Signature is pure Web Fetch: `(Request) => Promise<Response>`. This works
 * natively in Hono (via `c.req.raw`), Next.js Route Handlers, Bun, Deno, and
 * Cloudflare Workers. For callers that need the raw gate result — e.g. to
 * thread settlement through a non-Fetch framework — use `.check()`.
 */

import {
  S402_HEADERS,
  type s402PaymentRequired,
  type s402PaymentRequirements,
  type s402PaymentPayload,
  type s402SettleResponse,
  type s402ResourceInfo,
  type s402MandateRequirements,
} from './types.js';
import {
  encodePaymentRequired,
  encodeRequirementsBody,
  decodePaymentPayload,
  encodeSettleResponse,
} from './http.js';
import {
  fromX402PayloadHeaders,
  x402PayloadDialect,
  toX402SettleResponse,
  encodeX402SettleResponse,
} from './compat/x402.js';
import type { s402ResourceServer } from './server.js';

/** A Web Fetch-style handler. */
export type S402GateHandler = (request: Request) => Response | Promise<Response>;

/** Middleware shape: takes a downstream handler, returns a wrapped handler. */
export type S402Middleware = (next: S402GateHandler) => S402GateHandler;

/** Options for {@link s402Gate}. */
export interface S402GateOptions {
  /** Configured s402 resource server (with facilitator + schemes registered). */
  server: s402ResourceServer;

  /**
   * What the route costs: one offer, or several — one per scheme the route
   * accepts. May be a static value or a function called per-request (e.g. for
   * dynamic pricing / path-based rules).
   *
   * Order matters. An x402 client pays the FIRST entry it has a handler for, so
   * put `exact` first whenever it is offered (`buildPaymentRequired` does this
   * for you).
   */
  requirements:
    | s402PaymentRequirements
    | s402PaymentRequirements[]
    | ((request: Request) =>
        | s402PaymentRequirements
        | s402PaymentRequirements[]
        | Promise<s402PaymentRequirements | s402PaymentRequirements[]>);

  /**
   * What is being paid for. **Required**, because x402's V2 envelope requires
   * it and s402's 402 is that envelope on every route (ADR-016).
   */
  resource: s402ResourceInfo;

  /** AP2 mandate requirements for this route. Rides in `extensions.s402.mandate`. */
  mandate?: s402MandateRequirements;

  /** Envelope-level extensions to publish alongside s402's own. */
  extensions?: Record<string, unknown>;

  /**
   * Optional custom 402 response builder. Defaults to JSON body with `payment-required`
   * header. Returning `undefined` falls back to the default.
   */
  on402?: (
    request: Request,
    required: s402PaymentRequired,
  ) => Response | Promise<Response> | undefined;

  /**
   * Optional custom error response for payment processing failures (400/402/500 range).
   * Defaults to JSON `{ error, errorCode }` with status 402.
   */
  onError?: (
    request: Request,
    error: { message: string; code?: string },
  ) => Response | Promise<Response> | undefined;

  /**
   * Cryptographically verify the payment BEFORE running the protected handler
   * (security-first — the default). When true, an invalid payment is rejected
   * with a 402 and the handler never executes (no compute, no side effects).
   *
   * Set `false` for optimistic serve-then-settle: the handler runs first and
   * verification happens at settle time — lower latency, but the handler
   * executes before the payment is confirmed valid, so this is ONLY safe for
   * idempotent / side-effect-free handlers. The response body is withheld on
   * settlement failure either way.
   *
   * @default true
   */
  verifyBeforeServe?: boolean;
}

/** The wire dialect a payment arrived in; the receipt is answered in the same one. */
export type S402PaymentDialect = 's402' | 'x402';

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
      /**
       * The single offer this payment is being settled against — the entry from
       * `accepts[]` whose scheme the payload named, or the first one when it
       * named none.
       */
      requirements: s402PaymentRequirements;
      /** The whole 402 document that was on offer, after dynamic evaluation. */
      required: s402PaymentRequired;
      /**
       * Which dialect the client paid in. Callers threading settlement through
       * their own framework should encode the receipt for this dialect
       * (`encodeSettleResponse` for s402, `toX402SettleResponse` +
       * `encodeX402SettleResponse` for x402).
       */
      dialect: S402PaymentDialect;
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
 * **Settlement model — verify-before-serve (default, security-first).** The
 * payment is cryptographically verified BEFORE the protected handler runs; an
 * invalid payment is rejected with a 402 and the handler never executes. After
 * the handler returns, `server.process()` re-checks expiration and settles
 * on-chain (the response body is withheld if settlement fails). Set
 * `verifyBeforeServe: false` for optimistic serve-then-settle — lower latency,
 * but the handler runs before verification, so only for idempotent /
 * side-effect-free handlers.
 *
 * @example Hono
 * ```ts
 * import { s402Gate } from '@sweefi/server';
 * const gate = s402Gate({ server, requirements, resource: { url: 'https://api.example.com/paid' } });
 *
 * app.get('/api/paid', (c) =>
 *   gate(async () => Response.json({ data: 'hello, paid world' }))(c.req.raw),
 * );
 * ```
 *
 * @example Next.js App Router
 * ```ts
 * export const GET = s402Gate({ server, requirements, resource })(async () =>
 *   Response.json({ data: 'paid content' }),
 * );
 * ```
 *
 * @example Bun / Cloudflare Workers / Deno
 * ```ts
 * Bun.serve({
 *   fetch: s402Gate({ server, requirements, resource })(async () => Response.json({ ok: true })),
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

      // Attach the settlement receipt header to the handler's response, in the
      // dialect the client paid in: an x402 client's decoder wants
      // `transaction` + `network`, s402's wants `txDigest`. Same header name
      // either way — x402 V2 reads `PAYMENT-RESPONSE`, V1 falls back to it.
      // Also ensure browsers can read the s402 headers cross-origin.
      const headers = new Headers(handlerResponse.headers);
      headers.set(
        S402_HEADERS.PAYMENT_RESPONSE,
        check.dialect === 'x402'
          ? encodeX402SettleResponse(toX402SettleResponse(settleResult, check.requirements.network))
          : encodeSettleResponse(settleResult),
      );
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
  const required = await resolveRequired(request, options);
  const paymentHeader = request.headers.get(S402_HEADERS.PAYMENT);
  const dialect: S402PaymentDialect = x402PayloadDialect(request.headers) ?? 's402';

  if (!paymentHeader && dialect === 's402') {
    return {
      accepted: false,
      response: await build402(request, options, required),
    };
  }

  let payload: s402PaymentPayload;
  try {
    // Two dialects, one gate. x402 V1 shares s402's `x-payment` header and a
    // top-level `scheme`, so the native decoder reads it; x402 V2 moved the
    // scheme under `accepted` and the header to `PAYMENT-SIGNATURE`, which
    // the native decoder cannot see. `fromX402PayloadHeaders` normalizes both
    // x402 versions; the dialect is remembered so the receipt answers in kind.
    payload = dialect === 'x402'
      ? fromX402PayloadHeaders(request.headers)!
      : decodePaymentPayload(paymentHeader!);
  } catch (e) {
    return {
      accepted: false,
      response: await buildError(request, options, {
        message: `Invalid payment payload: ${e instanceof Error ? e.message : String(e)}`,
        code: 'INVALID_PAYLOAD',
      }),
    };
  }

  // A 402 may offer several schemes; the payment picked one. Settle against
  // THAT offer — its own price, network and expiry — not against whichever
  // entry happened to be listed first. An offer the payload does not match
  // falls through to `accepts[0]`, where the facilitator's own scheme
  // cross-check rejects it with a reason.
  const requirements = required.accepts.find((offer) => offer.scheme === payload.scheme)
    ?? required.accepts[0];

  // Security-first (default): verify the payment cryptographically BEFORE the
  // protected handler runs, so an invalid payment never triggers handler compute
  // or side effects. Opt out via `verifyBeforeServe: false` for optimistic flows.
  if (options.verifyBeforeServe !== false) {
    try {
      const verification = await options.server.verify(payload, requirements);
      if (!verification.valid) {
        return {
          accepted: false,
          response: await buildError(request, options, {
            message: verification.invalidReason ?? 'Payment verification failed',
            code: 'VERIFICATION_FAILED',
          }),
        };
      }
    } catch (e) {
      return {
        accepted: false,
        response: await buildError(request, options, {
          message: `Payment verification error: ${e instanceof Error ? e.message : String(e)}`,
          code: 'VERIFICATION_FAILED',
        }),
      };
    }
  }

  let settled = false;
  return {
    accepted: true,
    payload,
    requirements,
    required,
    dialect,
    settle: async () => {
      if (settled) {
        throw new Error('s402Gate: settle() called more than once on the same request');
      }
      settled = true;
      return options.server.process(payload, requirements);
    },
  };
}

async function resolveRequired(
  request: Request,
  options: S402GateOptions,
): Promise<s402PaymentRequired> {
  const resolved = typeof options.requirements === 'function'
    ? await options.requirements(request)
    : options.requirements;
  const accepts = Array.isArray(resolved) ? resolved : [resolved];
  const required: s402PaymentRequired = {
    x402Version: 2,
    resource: options.resource,
    error: 'Payment Required',
    accepts,
  };
  if (options.mandate !== undefined) required.mandate = options.mandate;
  if (options.extensions !== undefined) required.extensions = options.extensions;
  return required;
}

async function build402(
  request: Request,
  options: S402GateOptions,
  required: s402PaymentRequired,
): Promise<Response> {
  const custom = await options.on402?.(request, required);
  if (custom) return withHygiene(custom);

  // The envelope goes in the header AND the body: upstream's own resource
  // server does the same, and an x402 V1 client reads only the body. One
  // document, one grammar — there is no s402-native alternative to select.
  return new Response(encodeRequirementsBody(required), {
    status: 402,
    headers: {
      'content-type': JSON_CT,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'access-control-expose-headers': CORS_EXPOSE,
      [S402_HEADERS.PAYMENT_REQUIRED]: encodePaymentRequired(required),
    },
  });
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
