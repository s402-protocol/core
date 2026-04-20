/**
 * @sweefi/server — framework-agnostic s402 middleware.
 *
 * `s402Gate()` takes an s402ResourceServer + payment requirements and returns
 * a higher-order handler. The core signature is Web Fetch `(Request) => Response`,
 * which covers Hono, Next.js Route Handlers, Bun, Deno, Cloudflare Workers,
 * and anything else that speaks the platform `Request`/`Response` objects.
 *
 * For Node's `http.IncomingMessage` / `ServerResponse` (Express, raw Node), see
 * the `.check()` escape hatch and build the 402/200 responses yourself.
 *
 * @packageDocumentation
 */

export {
  s402Gate,
  type S402GateOptions,
  type S402GateHandler,
  type S402CheckResult,
  type S402Middleware,
} from './gate.js';
