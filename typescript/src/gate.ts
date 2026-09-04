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
  resolveMandate,
} from './http.js';
import {
  fromX402PayloadHeaders,
  x402AcceptedFromHeaders,
  x402PayloadDialect,
  toX402SettleResponse,
  encodeX402SettleResponse,
} from './compat/x402.js';
import { s402Error } from './errors.js';
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

/**
 * A 402 must offer something. Checked at construction for a static list, and at
 * resolve time for a `requirements` function — which can only be caught when it
 * runs, so it throws there rather than returning an unpayable 402.
 */
function assertOffered(accepts: readonly s402PaymentRequirements[]): void {
  if (accepts.length === 0) {
    throw new s402Error('INVALID_PAYLOAD',
      's402Gate requires at least one payment requirement; an empty `accepts` is a 402 no client can pay.');
  }
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
  // A gate with nothing to sell emits a 402 whose `accepts` is empty — a
  // document no decoder accepts, ours included — and then hands `undefined` to
  // verify. Refuse at construction, where the misconfiguration actually is.
  //
  // Same for a mandate two offers disagree about. The encoder catches that too,
  // but the encoder runs on every 402: an operator who got it wrong would learn
  // once per request, forever, instead of once, at boot. The encode-time check
  // stays as the backstop for a `requirements` FUNCTION, which cannot be
  // inspected until it runs.
  if (Array.isArray(options.requirements)) {
    assertOffered(options.requirements);
    resolveMandate(options.requirements, options.mandate);
  }

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

  // A 402 may offer several entries, and they differ in PRICE. Which one the
  // payment is for is a question that must be answered exactly or not at all.
  let requirements: s402PaymentRequirements;
  try {
    requirements = selectOffer(required, payload, dialect === 'x402' ? x402AcceptedFromHeaders(request.headers) : null);
  } catch (e) {
    return {
      accepted: false,
      response: await buildError(request, options, {
        message: e instanceof Error ? e.message : String(e),
        code: e instanceof s402Error ? e.code : 'INVALID_PAYLOAD',
      }),
    };
  }

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

/**
 * Decide which offer a payment is settling against.
 *
 * **Fails closed.** There is no "pick the first one" branch: an entry that was
 * never offered at the price the payer signed for is not a near miss, it is a
 * different contract, and charging it is worse than refusing the request.
 *
 * An x402 V2 payment carries `accepted` — the whole requirement the client
 * chose — so it is matched on all five economic fields. Anything less (matching
 * the scheme name and taking the first hit) settles a payment for a $5 offer
 * against a $1 one whenever both are on the menu.
 *
 * A native s402 payment names only its scheme. That identifies an offer when
 * exactly one entry uses that scheme, and does not when two do — so two do is
 * refused as ambiguous rather than guessed.
 *
 * @throws {s402Error} `SCHEME_NOT_SUPPORTED` when nothing matches,
 *   `INVALID_PAYLOAD` when the payload cannot tell two offers apart.
 */
function selectOffer(
  required: s402PaymentRequired,
  payload: s402PaymentPayload,
  accepted: Record<string, unknown> | null,
): s402PaymentRequirements {
  if (accepted) {
    // Full economic match first, compared the way peers actually serialize
    // these: an EVM client re-checksums `payTo`, a proxy re-serializes
    // `amount` as a number or with a leading zero. None of that is a different
    // contract, and refusing it sent a payment that main settled to
    // SCHEME_NOT_SUPPORTED.
    const exactMatch = required.accepts.find((offer) =>
      sameIdentifier(offer.scheme, accepted.scheme) &&
      sameIdentifier(offer.network, accepted.network) &&
      sameIdentifier(offer.asset, accepted.asset) &&
      sameIdentifier(offer.payTo, accepted.payTo) &&
      sameAmount(offer.amount, accepted.amount));
    if (exactMatch) return exactMatch;

    // `x402PaymentPayload.accepted` is typed `{ scheme?, network? }`, so a
    // conforming client may send exactly that. Fall back to the route match —
    // but ONLY when the payload named no economic fields at all. A stated
    // price that matches nothing is a different contract, not a truncation,
    // and must keep failing.
    const statedEconomics = ['asset', 'amount', 'payTo'].some((key) => accepted[key] !== undefined);
    if (!statedEconomics) {
      const onRoute = required.accepts.filter((offer) =>
        sameIdentifier(offer.scheme, accepted.scheme) &&
        sameIdentifier(offer.network, accepted.network));
      if (onRoute.length === 1) return onRoute[0];
      if (onRoute.length > 1) throw ambiguous(onRoute.length, String(accepted.scheme), String(accepted.network));
    }

    throw new s402Error('SCHEME_NOT_SUPPORTED',
      `The payment names a requirement this route did not offer ` +
      `(scheme "${String(accepted.scheme)}", network "${String(accepted.network)}", ` +
      `asset "${String(accepted.asset)}", amount "${String(accepted.amount)}", ` +
      `payTo "${String(accepted.payTo)}").`);
  }

  let candidates = required.accepts.filter((offer) => offer.scheme === payload.scheme);
  if (candidates.length === 0) {
    throw new s402Error('SCHEME_NOT_SUPPORTED',
      `Scheme "${payload.scheme}" is not offered by this route. ` +
      `Offered: [${required.accepts.map((o) => o.scheme).join(', ')}].`);
  }

  // A native payload may name the network it was signed for. That is what
  // separates `exact` on Sui from `exact` on Base — the configuration the
  // upgrade guide recommends, which the gate used to refuse outright.
  if (payload.network !== undefined) {
    const onNetwork = candidates.filter((offer) => sameIdentifier(offer.network, payload.network));
    if (onNetwork.length === 0) {
      throw new s402Error('SCHEME_NOT_SUPPORTED',
        `Scheme "${payload.scheme}" is not offered on network "${payload.network}" by this route. ` +
        `Offered: [${required.accepts.map((o) => `${o.scheme}@${o.network}`).join(', ')}].`);
    }
    candidates = onNetwork;
  }

  if (candidates.length === 1) return candidates[0];
  // Several left, and if they are the same contract it does not matter which
  // one settles. Refusing there was pedantry: a route may list one dish twice.
  if (candidates.every((offer) => sameContract(offer, candidates[0]))) return candidates[0];
  throw ambiguous(candidates.length, String(payload.scheme), payload.network);
}

/** The refusal for "several offers, and they are not the same contract". */
function ambiguous(count: number, scheme: string, network?: string): s402Error {
  return new s402Error('INVALID_PAYLOAD',
    `Ambiguous payment: ${count} offers on this route use scheme "${scheme}"` +
    (network ? ` on network "${network}"` : '') +
    ' at different prices, and the payment does not say which one it paid. ' +
    'Set `network` on the payment payload, or offer that scheme once per network.');
}

/**
 * Compare two wire identifiers the way peers actually serialize them.
 *
 * `scheme`, `network`, `asset` and `payTo` are case-insensitive in practice —
 * EVM addresses arrive EIP-55-checksummed or not depending on who touched them
 * last, and neither spelling means a different recipient.
 */
function sameIdentifier(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Compare two base-unit amounts numerically: `"01000"`, `"1000"` and `1000` are one price. */
function sameAmount(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string | null => {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
    if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
    return v.replace(/^0+(?=\d)/, '');
  };
  const na = norm(a);
  return na !== null && na === norm(b);
}

/** Two offers are the same contract when every economic field agrees. */
function sameContract(a: s402PaymentRequirements, b: s402PaymentRequirements): boolean {
  return sameIdentifier(a.network, b.network)
    && sameIdentifier(a.asset, b.asset)
    && sameIdentifier(a.payTo, b.payTo)
    && sameAmount(a.amount, b.amount);
}

async function resolveRequired(
  request: Request,
  options: S402GateOptions,
): Promise<s402PaymentRequired> {
  const resolved = typeof options.requirements === 'function'
    ? await options.requirements(request)
    : options.requirements;
  const accepts = Array.isArray(resolved) ? resolved : [resolved];
  assertOffered(accepts);
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
