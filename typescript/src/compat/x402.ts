/**
 * s402 ↔ x402 Compatibility Layer
 *
 * Enables bidirectional interop:
 *   - x402 clients can talk to s402 servers (via "exact" scheme)
 *   - s402 clients can talk to x402 servers (graceful degradation)
 *
 * Roundtrip: fromX402(toX402(s402)) preserves all x402 fields.
 * s402-only fields (mandate, stream, escrow, unlock extensions) are stripped.
 */

import type {
  s402PaymentRequired,
  s402PaymentRequirements,
  s402ResourceInfo,
  s402Scheme,
  s402ExactPayload,
  s402PaymentPayload,
  s402SettleResponse,
} from '../types.js';
import { S402_VERSION, S402_DEFAULT_MAX_TIMEOUT_SECONDS } from '../types.js';
import { s402Error } from '../errors.js';
import {
  isValidAmount,
  validateRequirementsShape,
  pickRequirementsFields,
  toRequirementsWire,
} from '../http.js';

// ══════════════════════════════════════════════════════════════
// Upstream pin — the x402 HEAD this layer was last audited against
// ══════════════════════════════════════════════════════════════

/**
 * The exact upstream x402 commit this compat layer was audited and tested
 * against. "Compatible with x402" means nothing without a date on it; this is
 * the date. Bump it only after re-running `bin/check-x402-mpp-drift.sh` and
 * the interop tests (`test/interop-x402-client.test.ts`) against the new HEAD.
 *
 * x402 development lives in the `x402-foundation/x402` repo (Linux Foundation)
 * since 2026-04; `coinbase/x402` is frozen at `dd927a26` and must not be used
 * as the reference.
 */
export const X402_UPSTREAM_PIN = {
  repo: 'x402-foundation/x402',
  sha: '2cc7e9a6880c08433b692666032862bcbea51187',
  date: '2026-09-04',
  /** Version of `@x402/core` / `@x402/fetch` published from that HEAD; the interop tests run against it. */
  npmVersion: '2.25.0',
} as const;

// ══════════════════════════════════════════════════════════════
// x402 types (minimal — just what we need for conversion)
// ══════════════════════════════════════════════════════════════

/**
 * x402 PaymentRequirements shape — supports both V1 and V2 wire formats.
 *
 * V1 wire format uses `maxAmountRequired`; V2 uses `amount`.
 * Both versions require `maxTimeoutSeconds`.
 * V1 includes resource metadata (`resource`, `description`, `mimeType`) inline;
 * V2 hoists these to the `PaymentRequired` envelope.
 */
export interface x402PaymentRequirements {
  x402Version: number;
  scheme: string;
  network: string;
  asset: string;
  /** V2 amount field (base units). */
  amount?: string;
  /** V1 amount field (renamed to `amount` in V2). */
  maxAmountRequired?: string;
  payTo: string;
  /** Required in x402. Seconds the facilitator will wait before rejecting. */
  maxTimeoutSeconds?: number;
  /** V1-only: resource URL. V2 moves this to the PaymentRequired envelope. */
  resource?: string;
  /** V1-only: human-readable description. */
  description?: string;
  facilitatorUrl?: string;
  extensions?: Record<string, unknown>;
  /**
   * V2 scheme-specific metadata. Present on every upstream V2 requirement
   * (upstream types it as REQUIRED), absent in V1.
   *
   * This field was missing from s402's intake type entirely until 2026-08-31,
   * which mattered the moment `exact` grew a second payment flow: `paymentFlow`
   * lives here, so its absence from the type made the flow unreadable rather
   * than merely unread. See {@link x402PaymentFlowOf}.
   */
  extra?: Record<string, unknown>;
}

/**
 * The resource-server orderings `exact` may run under (x402 #3240, #3267,
 * 2026-08-25/26, `specs/schemes/exact/scheme_exact.md`).
 *
 *   authorization — verify → resource → settle. The default, and what an
 *                   absent `extra.paymentFlow` means.
 *   upfront       — settle → resource → respond, for resources needing on-chain
 *                   finality before execution. `/verify` is not invoked;
 *                   `/settle` both validates and commits.
 *
 * Payload creation and settlement mechanics are identical between them, so the
 * payload s402 builds is byte-identical either way. What differs is what a
 * CLIENT may conclude from a retry: under `upfront` the charge may already have
 * happened, so "402 again" does not mean "not yet charged."
 */
export type x402PaymentFlow = 'authorization' | 'upfront';

/**
 * Read the payment flow an x402 requirement declares.
 *
 * Absent means `authorization` — that is the spec's own reading ("When the
 * resolved flow is not `authorization`, `accepts[].extra.paymentFlow` MUST be
 * `upfront`"), not a convenience default here.
 *
 * A value that is neither throws. Defaulting an unrecognized flow to
 * `authorization` would be a guess about resource-server ordering, and the
 * guess a client wants least is the one that says "you have not been charged."
 *
 * @throws {s402Error} `INVALID_PAYLOAD` on an unrecognized `paymentFlow`.
 */
export function x402PaymentFlowOf(
  req: Pick<x402PaymentRequirements, 'extra'>,
): x402PaymentFlow {
  const raw = req.extra?.paymentFlow;
  if (raw === undefined || raw === null) return 'authorization';
  if (raw === 'authorization' || raw === 'upfront') return raw;
  throw new s402Error('INVALID_PAYLOAD',
    `x402 extra.paymentFlow "${String(raw)}" is not a flow this build knows; ` +
    `expected "authorization" or "upfront"`);
}

/**
 * x402 V2 PaymentRequired envelope — wraps an array of requirements.
 * In V2, `x402Version` lives on this envelope, not on individual requirements.
 * Resource metadata and extensions are also at the envelope level.
 */
export interface x402PaymentRequiredEnvelope {
  x402Version: number;
  accepts: x402PaymentRequirements[];
  resource?: { url?: string; mimeType?: string; description?: string };
  extensions?: Record<string, unknown>;
  error?: string;
}

/** Minimal x402 PaymentPayload shape */
export interface x402PaymentPayload {
  x402Version: number;
  /** V1 carries the scheme at top level; V2 nests it under `accepted` or omits it. */
  scheme?: string;
  accepted?: { scheme?: string; network?: string };
  payload: {
    transaction: string;
    signature: string;
  };
}

// ══════════════════════════════════════════════════════════════
// Convert x402 → s402
// ══════════════════════════════════════════════════════════════

/**
 * Convert inbound x402 requirements to s402 format.
 * Handles both V1 (`maxAmountRequired`) and V2 (`amount`) wire formats.
 * Accepts only `exact` — the sole x402 scheme with an s402 equivalent wired
 * today. Any other scheme (upstream now ships upto, auth-capture,
 * batch-settlement) is rejected loudly rather than silently relabeled;
 * explicit mappings are 0.9.0 scope.
 */
export function fromX402Requirements(x402: x402PaymentRequirements, now?: number): s402PaymentRequirements {
  if (x402.scheme !== 'exact') {
    throw new s402Error('SCHEME_NOT_SUPPORTED',
      `x402 scheme "${x402.scheme}" has no s402 mapping; only "exact" is accepted inbound`);
  }
  // V1 uses maxAmountRequired, V2 uses amount
  const amount = x402.amount ?? x402.maxAmountRequired;
  if (!amount) {
    throw new s402Error('INVALID_PAYLOAD',
      'x402 requirements missing both "amount" (V2) and "maxAmountRequired" (V1)');
  }
  if (!isValidAmount(amount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Invalid amount "${amount}": must be a non-negative integer string`);
  }
  // Reject an unrecognized payment flow at the trust boundary. The flow itself
  // does not change the payload s402 builds, so this is not a translation
  // step — it is a refusal to accept a requirement whose resource-server
  // ordering we cannot name. Same posture as the scheme check above: rejected
  // loudly rather than silently relabeled.
  x402PaymentFlowOf(x402);
  // M-1: Validate facilitatorUrl to prevent SSRF via dangerous URL schemes (file://, etc.)
  if (x402.facilitatorUrl !== undefined) {
    try {
      const url = new URL(x402.facilitatorUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new s402Error('INVALID_PAYLOAD',
          `facilitatorUrl must use https:// or http://, got "${url.protocol}"`);
      }
      if (url.username || url.password) {
        throw new s402Error('INVALID_PAYLOAD',
          'facilitatorUrl must not contain embedded credentials (user:password@)');
      }
    } catch (e) {
      if (e instanceof s402Error) throw e;
      throw new s402Error('INVALID_PAYLOAD', 'facilitatorUrl is not a valid URL');
    }
  }
  // Compute expiresAt from x402's maxTimeoutSeconds to preserve S1 (Stale Payment Rejection).
  // Without this, inbound x402 traffic would bypass all three S1 expiration layers because
  // expiresAt would be undefined (the null-check guards in facilitator.process() would skip).
  const expiresAt = x402.maxTimeoutSeconds != null && x402.maxTimeoutSeconds > 0
    ? (now ?? Date.now()) + x402.maxTimeoutSeconds * 1000
    : undefined;

  return {
    scheme: 'exact',
    network: x402.network,
    asset: x402.asset,
    amount,
    payTo: x402.payTo,
    maxTimeoutSeconds: x402.maxTimeoutSeconds,
    facilitatorUrl: x402.facilitatorUrl,
    expiresAt,
    extensions: x402.extensions,
  };
}

/**
 * Convert inbound x402 payment payload to s402 format.
 * Validates that required fields are present and correctly typed.
 */
export function fromX402Payload(x402: x402PaymentPayload): s402ExactPayload {
  // V1 puts scheme at top level, V2 under `accepted`; V2 payloads may omit it
  // entirely (the negotiated requirements carry it), which implies exact. A
  // scheme that is PRESENT and non-exact is rejected loudly — never relabeled.
  const scheme = x402.scheme ?? x402.accepted?.scheme;
  if (scheme !== undefined && scheme !== 'exact') {
    throw new s402Error('SCHEME_NOT_SUPPORTED',
      `x402 scheme "${scheme}" has no s402 mapping; only "exact" is accepted inbound`);
  }
  if (x402.payload == null || typeof x402.payload !== 'object') {
    throw new s402Error('INVALID_PAYLOAD', 'x402 payload missing or not an object');
  }
  if (typeof x402.payload.transaction !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `x402 payload.transaction must be a string, got ${typeof x402.payload.transaction}`);
  }
  if (typeof x402.payload.signature !== 'string') {
    throw new s402Error('INVALID_PAYLOAD',
      `x402 payload.signature must be a string, got ${typeof x402.payload.signature}`);
  }
  return {
    s402Version: S402_VERSION,
    scheme: 'exact',
    payload: {
      transaction: x402.payload.transaction,
      signature: x402.payload.signature,
    },
  };
}

// ══════════════════════════════════════════════════════════════
// Inbound from HTTP headers (server intake — opt-in x402 acceptance)
// ══════════════════════════════════════════════════════════════

/**
 * x402 inbound payload header names, in preference order. x402 V2 uses
 * `PAYMENT-SIGNATURE`; x402 V1 used `X-PAYMENT`. Read case-insensitively — HTTP
 * field names are case-insensitive (RFC 9110 §5.1), and HTTP/2 mandates lowercase
 * on the wire (RFC 9113 §8.2.1), so a `Headers` lookup matches any client casing.
 */
const X402_PAYLOAD_HEADERS = ['payment-signature', 'x-payment'] as const;

/** Defense-in-depth header size cap, mirroring `http.ts` MAX_HEADER_BYTES (64KB). */
const MAX_X402_HEADER_BYTES = 64 * 1024;

/** Unicode-safe standard-base64 → parsed JSON (x402 encodes header JSON as standard base64). */
function decodeBase64Json(b64: string): unknown {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Unicode-safe JSON → standard base64, the encoding x402's header decoders accept. */
function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
}

/**
 * Which dialect did the client address us in?
 *
 * `'x402'` when the payment arrived under x402 V2's `PAYMENT-SIGNATURE`, or under
 * `X-PAYMENT` carrying an `x402Version` (x402 V1 — s402 shares that header name
 * and its own payloads never carry `x402Version`). `null` when no payment header
 * is present or the payload is s402-native.
 *
 * A server that knows the dialect it was addressed in can answer in it — the
 * `PAYMENT-RESPONSE` an x402 client decodes wants `transaction` and `network`,
 * where s402's own carries `txDigest`. Answering in the caller's dialect is not
 * a wire change for s402 clients, who never send these markers.
 */
export function x402PayloadDialect(headers: Headers): 'x402' | null {
  // Truthiness, not presence: an empty `PAYMENT-SIGNATURE` is not a payment.
  // x402's own resource server reads `getHeader('payment-signature') || ...`,
  // so a stray empty header falls through to the next candidate there too.
  // Presence alone would let `payment-signature: ""` shadow a real `X-PAYMENT`.
  if (headers.get('payment-signature')) return 'x402';
  const legacy = headers.get('x-payment');
  if (!legacy || legacy.length > MAX_X402_HEADER_BYTES) return null;
  try {
    const decoded = decodeBase64Json(legacy);
    if (decoded == null || typeof decoded !== 'object') return null;
    // Both markers → s402, because s402 is the superset. Same rule as `isX402()`
    // below and the note at the top of `http.ts`; classifying on `x402Version`
    // alone would have this function disagree with every other detector here.
    return 'x402Version' in (decoded as object) && !('s402Version' in (decoded as object)) ? 'x402' : null;
  } catch {
    return null; // malformed → let the native decoder produce the error
  }
}

/**
 * Translate an s402 settlement result into the x402 `SettleResponse` shape an
 * x402 client's `PAYMENT-RESPONSE` decoder reads.
 *
 * Field map: `txDigest` → `transaction` (x402 requires the field; empty string
 * when nothing was broadcast) · `errorCode` → `errorReason` · `error` →
 * `errorMessage` · `actualAmount` → `amount`. `network` is required by x402
 * and s402's settle response does not carry it, so the caller supplies it from
 * the requirements the payment was verified against.
 *
 * s402-specific fields (`receiptId`, `finalityMs`, scheme object ids) are kept
 * alongside: x402 decoders ignore unknown keys, and losing them would make an
 * x402-dialect receipt strictly poorer than a native one for no reason.
 *
 * Direction note: this is s402 → x402 (emission in the caller's dialect). The
 * reverse, `toS402SettleResponse`, deliberately does not exist — see ADR-013.
 */
export function toX402SettleResponse(s402: s402SettleResponse, network: string): x402SettleResponse {
  const { success, txDigest, errorCode, error, actualAmount, ...rest } = s402;
  const out: x402SettleResponse = {
    ...rest,
    success,
    transaction: txDigest ?? '',
    network,
  };
  if (txDigest !== undefined) out.txDigest = txDigest;
  if (errorCode !== undefined) out.errorReason = errorCode;
  if (error !== undefined) out.errorMessage = error;
  if (actualAmount !== undefined) { out.amount = actualAmount; out.actualAmount = actualAmount; }
  return out;
}

/** Encode an x402 `SettleResponse` for the `PAYMENT-RESPONSE` header. */
export function encodeX402SettleResponse(response: x402SettleResponse): string {
  return encodeBase64Json(response);
}

/** Encode an x402 V2 `PaymentRequired` envelope for the `PAYMENT-REQUIRED` header. */
export function encodeX402V2Envelope(envelope: x402V2PaymentRequired): string {
  return encodeBase64Json(envelope);
}

/**
 * Server-intake bridge: extract an **x402** payment payload from a request's
 * headers and normalize it to an **s402** payload.
 *
 * This is the inbound half of "s402 servers transparently accept x402 clients"
 * (ADR-005). It lives in the OPT-IN `s402/compat/x402` layer — NOT the core —
 * so the s402 protocol core stays x402-free (AGENTS.md: "x402 compat is opt-in;
 * core has no x402 dependency").
 *
 * ⚠️ CORRECTED 2026-08-31. This comment used to end with a companion claim:
 * that s402's outbound `payment-response` matches x402 V2's `PAYMENT-RESPONSE`
 * case-insensitively, "so no emit change is needed to be read by x402 clients."
 * The header NAME still matches. The claim was about the whole response and it
 * outlived its target: x402 V2 added `settlement_pending` (#3083) and now ships
 * it in the reference resource server, so the response x402 clients read has a
 * third state — settled, failed, and broadcast-but-unconfirmed — while s402's
 * `payment-response` body carries a boolean. Matching the header name says
 * nothing about matching the states inside it.
 *
 * What s402 does about that today is INTAKE only — see
 * {@link fromX402SettleResponse}. Whether s402's own settle envelope should
 * emit a non-terminal state is an ADR-007 question and is deliberately open.
 *
 * Reads the x402 payload header — `PAYMENT-SIGNATURE` (x402 V2) or `X-PAYMENT`
 * (x402 V1) — base64-decodes the JSON, and runs {@link fromX402Payload}. The
 * realistic interop path is an x402 **Sui** client whose `payload` carries
 * `{ transaction, signature }`; EVM-shaped authorization payloads have no s402
 * equivalent and are rejected by `fromX402Payload`.
 *
 * @param headers - The inbound request headers.
 * @returns The normalized s402 payload, or `null` if no x402 payload header is
 *   present (so callers can fall back to the native s402 `x-payment` path).
 * @throws {s402Error} `INVALID_PAYLOAD` if a header IS present but oversized,
 *   not base64-JSON, or not a valid x402 payload object.
 *
 * @example Server intake — prefer native s402, fall back to x402
 * ```ts
 * import { decodePaymentPayload } from 's402/http';
 * import { fromX402PayloadHeaders } from 's402/compat/x402';
 *
 * const native = request.headers.get('x-payment');
 * const payload = native
 *   ? decodePaymentPayload(native)                  // s402-native client
 *   : fromX402PayloadHeaders(request.headers);      // x402 client (or null)
 * ```
 */
export function fromX402PayloadHeaders(headers: Headers): s402PaymentPayload | null {
  const decoded = readX402PayloadHeader(headers);
  if (decoded == null) return null;
  return fromX402Payload(decoded as unknown as x402PaymentPayload);
}

/** Read, size-check and parse the x402 payload header. `null` when absent. */
function readX402PayloadHeader(headers: Headers): Record<string, unknown> | null {
  let raw: string | null = null;
  for (const name of X402_PAYLOAD_HEADERS) {
    // Truthiness, not presence — matching x402's own server, which reads
    // `getHeader('payment-signature') || getHeader('x-payment')`. An empty
    // header is not a payment: taking it would both throw on `JSON.parse('')`
    // and stop us from reading the real payload in the next header.
    const value = headers.get(name);
    if (value) { raw = value; break; }
  }
  if (raw == null) return null;
  if (raw.length > MAX_X402_HEADER_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `x402 payment header exceeds maximum size (${raw.length} > ${MAX_X402_HEADER_BYTES})`);
  }
  let decoded: unknown;
  try {
    decoded = decodeBase64Json(raw);
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to decode x402 payment header: ${e instanceof Error ? e.message : 'invalid base64 or JSON'}`);
  }
  if (decoded == null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 payment payload must be a JSON object');
  }
  return decoded as Record<string, unknown>;
}

/**
 * The requirement an x402 V2 payment says it is paying.
 *
 * x402 V2's `PaymentPayload` carries `accepted` — the FULL `PaymentRequirements`
 * the client chose, not just its scheme name. On a 402 that offered several
 * entries, that object is the only thing that says which one the money is for,
 * and the entries differ in price. Reading the scheme alone and taking the
 * first match settles the payment against the wrong amount.
 *
 * Returns `null` for an x402 V1 payload (no `accepted`) or no payment header.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the header is present but unreadable.
 */
export function x402AcceptedFromHeaders(headers: Headers): Record<string, unknown> | null {
  const decoded = readX402PayloadHeader(headers);
  const accepted = decoded?.accepted;
  return accepted != null && typeof accepted === 'object' && !Array.isArray(accepted)
    ? accepted as Record<string, unknown>
    : null;
}

/**
 * x402's MCP `_meta` key. x402's MCP transport places the payment object at
 * `_meta['x402/payment']` (its `MCP_PAYMENT_META_KEY`). s402's native key is
 * `s402/payment` (see `S402_MCP_META_KEY` in `transport.ts`).
 */
const X402_MCP_META_KEY = 'x402/payment' as const;

/**
 * Server-intake bridge (MCP): extract an **x402** payment payload from a
 * JSON-RPC message `_meta` record and normalize it to an **s402** payload. The
 * MCP analogue of {@link fromX402PayloadHeaders}, and the opt-in inbound half of
 * x402-over-MCP interop — kept in compat so the core `mcpTransport` stays
 * x402-free (AGENTS.md), symmetric with how the HTTP x402 inbound is handled.
 *
 * Reads `_meta['x402/payment']` (x402's MCP key), which carries the payment
 * object as structured JSON — not base64 — per MCP's idiom, and runs
 * {@link fromX402Payload}. Returns `null` when the key is absent so callers can
 * fall back to the native `_meta['s402/payment']` path.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the key is present but not a valid
 *   x402 payload object (e.g. missing `payload.transaction`/`signature`).
 */
export function fromX402PayloadMeta(meta: Record<string, unknown>): s402PaymentPayload | null {
  const raw = meta[X402_MCP_META_KEY];
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 _meta payment payload must be a JSON object');
  }
  return fromX402Payload(raw as x402PaymentPayload);
}

// ══════════════════════════════════════════════════════════════
// Inbound settlement result (client intake — reading an x402 server's answer)
// ══════════════════════════════════════════════════════════════

/**
 * x402's non-terminal settle outcome (x402 #3083, `6dba93ed`; reference
 * implementation `230e6a9a..94f9951a` in `x402ResourceServer.ts` as
 * `SETTLEMENT_PENDING_REASON`, mirrored by Go's `x402.ErrSettlementPending`).
 *
 * It means: the transaction was broadcast, and the wait for its confirmation
 * failed. Not that the payment failed.
 */
export const X402_SETTLEMENT_PENDING = 'settlement_pending' as const;

/**
 * x402 V2 `SettleResponse` as carried in `PAYMENT-RESPONSE` (base64 JSON).
 * Only the fields s402 reads are typed; upstream also carries `extensions`,
 * `extensionResponses` and `extra`, which pass through untouched.
 */
export interface x402SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  /** Broadcast transaction hash. Empty string when nothing was broadcast. */
  transaction?: string;
  network?: string;
  /** Actual amount settled, for schemes where it can differ from the maximum. */
  amount?: string;
  [key: string]: unknown;
}

/** Common fields on every classified outcome. */
interface x402SettlementBase {
  transaction: string;
  network?: string;
  payer?: string;
  /**
   * Whether re-submitting a NEW payment is safe. `false` for `settled`,
   * `pending`, and any `failed` that still carries a `transaction` hash — three
   * different reasons for one answer: it has been paid, it may have been, or
   * something was broadcast that nobody has reconciled yet.
   */
  retryable: boolean;
  /** The response as received, so callers lose nothing this type does not name. */
  raw: x402SettleResponse;
}

export interface x402SettlementSettled extends x402SettlementBase {
  state: 'settled';
  retryable: false;
  amount?: string;
}

export interface x402SettlementPending extends x402SettlementBase {
  state: 'pending';
  retryable: false;
  reason: typeof X402_SETTLEMENT_PENDING;
  message?: string;
}

export interface x402SettlementFailed extends x402SettlementBase {
  state: 'failed';
  /**
   * `true` only when nothing was broadcast (`transaction` is empty).
   *
   * Upstream `@x402/core` forwards `transaction` on any `errorReason`, so a
   * failure can arrive holding a real broadcast hash. Building a fresh payload
   * on that is the double-pay this module exists to prevent: reconcile the hash
   * on chain first. Not a literal `true` for exactly this reason.
   */
  retryable: boolean;
  reason?: string;
  message?: string;
}

/**
 * A settle outcome with the pending case pulled out of the boolean.
 *
 * 🛑 THERE IS DELIBERATELY NO `toS402SettleResponse` COUNTERPART. Mapping this
 * back into `s402SettleResponse` would have to collapse `pending` onto
 * `success: false`, which is exactly the double-pay this type exists to
 * prevent. s402's own settle envelope stays as it is; see
 * docs/adr/013-x402-intake-compatibility.md for why that boundary is where it
 * is and what would move it.
 */
export type x402SettlementOutcome =
  | x402SettlementSettled
  | x402SettlementPending
  | x402SettlementFailed;

/**
 * Classify an x402 settle response into settled / pending / failed.
 *
 * The one thing this function exists to prevent: reading
 * `errorReason: "settlement_pending"` as a failure. Upstream's own resource
 * server does a single automatic re-settle on it (`settleWithPendingRetry`) —
 * a re-settle of the SAME broadcast, never a fresh payment — precisely because
 * the money may already have moved. A caller that sees `success: false` and
 * builds a new payload pays twice.
 *
 * ⚠️ `pending` is returned even when `transaction` is empty, which x402 V2
 * forbids ("MUST be non-empty when errorReason is settlement_pending"). A
 * server violating that leaves us unable to name the transaction; it does not
 * make the transaction not exist. Downgrading a malformed pending to `failed`
 * would trade a spec violation for a double charge.
 *
 * The same reasoning governs `failed`: upstream forwards `transaction` on any
 * `errorReason`, so `retryable` is `true` only when that hash is empty. A
 * failure holding a broadcast hash is a reconciliation, not a retry.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the response is not an object with a
 *   boolean `success`.
 */
export function fromX402SettleResponse(response: x402SettleResponse): x402SettlementOutcome {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 settle response must be a JSON object');
  }
  if (typeof response.success !== 'boolean') {
    throw new s402Error('INVALID_PAYLOAD',
      `x402 settle response "success" must be a boolean, got ${typeof response.success}`);
  }
  const transaction = typeof response.transaction === 'string' ? response.transaction : '';
  const network = typeof response.network === 'string' ? response.network : undefined;
  const payer = typeof response.payer === 'string' ? response.payer : undefined;
  const message = typeof response.errorMessage === 'string' ? response.errorMessage : undefined;

  if (response.success) {
    return {
      state: 'settled', retryable: false, transaction, network, payer,
      amount: typeof response.amount === 'string' ? response.amount : undefined,
      raw: response,
    };
  }
  if (response.errorReason === X402_SETTLEMENT_PENDING) {
    return {
      state: 'pending', retryable: false, transaction, network, payer,
      reason: X402_SETTLEMENT_PENDING, message, raw: response,
    };
  }
  return {
    // A hash in hand means something was broadcast. Retrying builds a SECOND
    // payment for a transaction that may already have landed — the same trap as
    // `settlement_pending`, arriving under an ordinary errorReason.
    state: 'failed', retryable: transaction === '', transaction, network, payer,
    reason: typeof response.errorReason === 'string' ? response.errorReason : undefined,
    message, raw: response,
  };
}

/**
 * x402 settle-response header names, in preference order. V2 uses
 * `PAYMENT-RESPONSE`; V1 used `X-PAYMENT-RESPONSE` (deprecated upstream but
 * still emitted by older servers). Read case-insensitively, same as the
 * payload headers above.
 */
const X402_SETTLE_HEADERS = ['payment-response', 'x-payment-response'] as const;

/**
 * The one settle header whose name s402 also uses natively
 * (`S402_HEADERS.PAYMENT_RESPONSE` in `types.ts` is byte-identical). Reading it
 * is therefore a dialect question, not a lookup.
 */
const AMBIGUOUS_SETTLE_HEADER = 'payment-response';

/**
 * Fields only a NATIVE s402 settle response carries. `txDigest` is the one that
 * matters — s402 names the hash `txDigest` where x402 names it `transaction` —
 * and the rest are s402's scheme-specific receipt fields.
 */
const S402_SETTLE_MARKERS = [
  'txDigest', 'receiptId', 'finalityMs', 'actualAmount',
  'depositId', 'balanceId', 'streamId', 'escrowId', 'errorCode', 'error',
] as const;

/** Fields only an x402 settle response carries. */
const X402_SETTLE_MARKERS = ['transaction', 'network', 'errorReason', 'errorMessage', 'payer'] as const;

/**
 * Is this settle body written in x402's dialect? The body-side twin of
 * {@link x402PayloadDialect}, and it follows the same rule: a native marker
 * wins over an x402 one, because s402 is the superset. `false` covers both the
 * native case and a body too bare to tell — on s402's own header name, the
 * native decoder is the safe default for both.
 */
function settleBodyIsX402(body: object): boolean {
  if (S402_SETTLE_MARKERS.some((k) => k in body)) return false;
  return X402_SETTLE_MARKERS.some((k) => k in body);
}

/**
 * Client-intake bridge: read an x402 server's settle result off the response
 * headers and classify it.
 *
 * Returns `null` when no x402 settle result is there — no header at all, or a
 * `PAYMENT-RESPONSE` that turns out to be a native s402 receipt — so a caller
 * can fall back to the native `payment-response` decode path.
 *
 * ⚠️ `PAYMENT-RESPONSE` is s402's own settle header name as well as x402 V2's,
 * so the name cannot answer the question and the body has to. A native receipt
 * `{ success, txDigest, receiptId }` read as x402 would come back as
 * `state: 'settled', transaction: ''` — the digest and the receipt id silently
 * dropped, and the caller told a hash does not exist when it does.
 * `X-PAYMENT-RESPONSE` is x402-only and needs no such check.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if an x402 header IS present but
 *   oversized, not base64-JSON, or not a valid settle response.
 */
export function fromX402SettleResponseHeaders(headers: Headers): x402SettlementOutcome | null {
  let raw: string | null = null;
  let ambiguous = false;
  for (const name of X402_SETTLE_HEADERS) {
    const value = headers.get(name);
    if (value) { raw = value; ambiguous = name === AMBIGUOUS_SETTLE_HEADER; break; }
  }
  if (raw == null) return null;
  if (raw.length > MAX_X402_HEADER_BYTES) {
    throw new s402Error('INVALID_PAYLOAD',
      `x402 settle response header exceeds maximum size (${raw.length} > ${MAX_X402_HEADER_BYTES})`);
  }
  let decoded: unknown;
  try {
    decoded = decodeBase64Json(raw);
  } catch (e) {
    throw new s402Error('INVALID_PAYLOAD',
      `Failed to decode x402 settle response header: ${e instanceof Error ? e.message : 'invalid base64 or JSON'}`);
  }
  if (decoded == null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 settle response must be a JSON object');
  }
  if (ambiguous && !settleBodyIsX402(decoded)) return null;
  return fromX402SettleResponse(decoded as x402SettleResponse);
}

/** x402's A2A payload metadata key (`x402.payment.payload` on the task/message metadata). */
const X402_A2A_PAYLOAD_KEY = 'x402.payment.payload' as const;

/**
 * Server-intake bridge (A2A): extract an **x402** payment payload from an A2A
 * task/message `metadata` record and normalize it to an **s402** payload. The
 * A2A analogue of {@link fromX402PayloadHeaders} / {@link fromX402PayloadMeta},
 * completing the opt-in x402-inbound trio (HTTP · MCP · A2A) — kept in compat so
 * the core `a2aTransport` stays x402-free (AGENTS.md).
 *
 * Reads `metadata['x402.payment.payload']` (x402's A2A key), which carries the
 * payment object as structured JSON, and runs {@link fromX402Payload}. Returns
 * `null` when absent so callers can fall back to the native `s402.payment.payload`
 * path.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the key is present but not a valid
 *   x402 payload object.
 */
export function fromX402PayloadA2A(metadata: Record<string, unknown>): s402PaymentPayload | null {
  const raw = metadata[X402_A2A_PAYLOAD_KEY];
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new s402Error('INVALID_PAYLOAD', 'x402 A2A payment payload must be a JSON object');
  }
  return fromX402Payload(raw as x402PaymentPayload);
}

// ══════════════════════════════════════════════════════════════
// Convert s402 → x402
// ══════════════════════════════════════════════════════════════

/**
 * Convert outbound s402 requirements to x402 V1 wire format.
 * Strips s402-only fields (mandate, upto, prepaid, stream, escrow, unlock extensions).
 * Only works for "exact" scheme — other schemes have no x402 equivalent.
 *
 * Includes both `maxAmountRequired` (V1) and `amount` (V2) for maximum interop.
 * Includes `maxTimeoutSeconds` (required in x402, defaults to 60s).
 * V1 metadata fields (`resource`, `description`) default to empty strings.
 */
export function toX402Requirements(
  s402: s402PaymentRequirements,
  overrides?: { maxTimeoutSeconds?: number; resource?: string; description?: string },
): x402PaymentRequirements {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: s402.network,
    asset: s402.asset,
    amount: s402.amount,
    maxAmountRequired: s402.amount,
    payTo: s402.payTo,
    facilitatorUrl: s402.facilitatorUrl,
    maxTimeoutSeconds: overrides?.maxTimeoutSeconds ?? 60,
    resource: overrides?.resource ?? '',
    description: overrides?.description ?? '',
    extensions: s402.extensions,
  };
}

/**
 * Convert outbound s402 payload to x402 format.
 * Only works for exact scheme payloads.
 */
export function toX402Payload(s402: s402PaymentPayload): x402PaymentPayload | null {
  if (s402.scheme !== 'exact') return null;

  const exact = s402 as s402ExactPayload;
  return {
    x402Version: 1,
    scheme: 'exact',
    payload: {
      transaction: exact.payload.transaction,
      signature: exact.payload.signature,
    },
  };
}

// ══════════════════════════════════════════════════════════════
// V2 wire types and write path
// ══════════════════════════════════════════════════════════════

/**
 * x402 V2 ResourceInfo per upstream `@x402/core/types/payments.ts`.
 *
 * Replaces V1's inline `resource: string` + `description: string` on each
 * requirement. V2 hoists resource metadata to the `PaymentRequired` envelope
 * level (one ResourceInfo per envelope, not per requirement).
 */
export interface x402V2ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/**
 * x402 V2 PaymentRequirements per upstream `@x402/core/types/payments.ts` HEAD
 * as of 2026-05-12. Compared to our V1-superset {@link x402PaymentRequirements}:
 *
 *   - `x402Version` is REMOVED (moved to envelope level)
 *   - `maxAmountRequired` is REMOVED (alias dropped; only `amount`)
 *   - `resource` / `description` REMOVED (moved to envelope's ResourceInfo)
 *   - `extra: Record<string, unknown>` is REQUIRED (was optional/absent in V1)
 *   - `facilitatorUrl` not in upstream V2 — kept as our extension in V1
 *   - `maxTimeoutSeconds` is REQUIRED in V2 (was optional in V1)
 */
export interface x402V2PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/**
 * x402 V2 PaymentRequired envelope per upstream. Wraps an `accepts` array of
 * {@link x402V2PaymentRequirements}. `resource` is REQUIRED on the V2 envelope.
 */
export interface x402V2PaymentRequired {
  x402Version: number;
  resource: x402V2ResourceInfo;
  accepts: x402V2PaymentRequirements[];
  error?: string;
  extensions?: Record<string, unknown>;
}

/**
 * Convert one s402 requirement to the x402 V2 `PaymentRequirements` it is.
 *
 * Since wire v2 this is a **projection, not a translation** — the s402
 * requirement already IS an x402 V2 requirement, with s402's own fields living
 * in `extra`. `encodePaymentRequired` does exactly this on the way to the
 * header; this function is here for callers assembling an x402 document by
 * hand.
 *
 * Every s402 scheme is expressible. The old exact-only constraint is gone: a
 * requirement naming `prepaid` is a well-formed x402 requirement that an x402
 * client without a `prepaid` handler skips, which is what `accepts[]` is for.
 *
 * **EVM EIP-3009 callers:** the default `extra` is wire-shape-correct but not
 * signing-correct for real EVM tokens. To sign a real Permit2 authorization,
 * `extra` must include `name` (token name) and `version` (token version) for
 * the EIP-712 domain. Pass these via `options.extra`.
 */
export function toX402V2Requirements(
  s402: s402PaymentRequirements,
  options?: { maxTimeoutSeconds?: number; extra?: Record<string, unknown> },
): x402V2PaymentRequirements {
  const wire = toRequirementsWire({
    x402Version: 2,
    resource: { url: '' },
    accepts: [{ ...s402, extra: { ...(s402.extra ?? {}), ...(options?.extra ?? {}) } }],
  }) as { accepts: x402V2PaymentRequirements[] };
  const req = wire.accepts[0];
  if (options?.maxTimeoutSeconds !== undefined) req.maxTimeoutSeconds = options.maxTimeoutSeconds;
  return req;
}

/**
 * Wrap s402 requirements in an x402 V2 `PaymentRequired` envelope.
 *
 * @param s402 - One requirement, or the list of offers. `exact` is NOT reordered
 *   here: the caller owns the order, and `s402ResourceServer.buildPaymentRequired`
 *   is what puts `exact` first.
 * @param resource - ResourceInfo describing the resource being paid for.
 *   REQUIRED in V2 envelopes per the upstream spec; a non-empty `url` is
 *   enforced on emission.
 */
export function toX402V2Envelope(
  s402: s402PaymentRequirements | s402PaymentRequirements[],
  resource: x402V2ResourceInfo,
  options?: {
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
    error?: string;
  },
): x402V2PaymentRequired {
  if (!resource || typeof resource.url !== 'string' || resource.url.length === 0) {
    throw new s402Error('INVALID_PAYLOAD',
      'x402 V2 envelope requires a non-empty resource.url (ResourceInfo.url is mandatory per the x402 V2 spec)');
  }
  const offers = Array.isArray(s402) ? s402 : [s402];
  const envelope: x402V2PaymentRequired = {
    x402Version: 2,
    resource,
    accepts: offers.map((offer) => toX402V2Requirements(offer, options)),
  };
  if (options?.extensions) envelope.extensions = options.extensions;
  if (options?.error) envelope.error = options.error;
  return envelope;
}

// ══════════════════════════════════════════════════════════════
// Detection helpers
// ══════════════════════════════════════════════════════════════

/**
 * Check if a decoded JSON object is the retired s402 v1 flat shape.
 *
 * `s402Version` no longer appears on any 402 s402 emits. Its presence means the
 * document was written by a pre-wire-v2 server — see {@link fromS402V1Requirements}.
 */
export function isS402(obj: Record<string, unknown>): boolean {
  return 's402Version' in obj;
}

/**
 * Check if a decoded JSON object is x402 format (V1 flat or V2 envelope).
 */
export function isX402(obj: Record<string, unknown>): boolean {
  return 'x402Version' in obj && !('s402Version' in obj);
}

/**
 * Check if a decoded JSON object is an x402 V2 envelope (has `accepts` array).
 * This is also the shape s402 itself emits since wire v2.
 */
export function isX402Envelope(obj: Record<string, unknown>): boolean {
  return 'x402Version' in obj && Array.isArray(obj.accepts) && !('s402Version' in obj);
}

/**
 * Decode an x402 V2 `PaymentRequired` envelope.
 *
 * Since wire v2 this is the NATIVE shape, so the conversion is identity plus
 * the `extra` projection — see {@link normalizeRequirements}, which this
 * delegates to for everything except the V1-flat case.
 */
export function fromX402Envelope(envelope: x402PaymentRequiredEnvelope, now?: number): s402PaymentRequired {
  return normalizeRequirements(envelope as unknown as Record<string, unknown>, now);
}

/**
 * Decode the RETIRED s402 v1 flat requirements shape into a wire-v2 402.
 *
 * v1 was `{ s402Version: '1', accepts: ['exact', 'prepaid'], network, asset,
 * amount, payTo, … }` — one price line plus a list of scheme NAMES. v2 is one
 * `accepts[]` entry per scheme, so a v1 document expands: every entry carries
 * the same network/asset/amount/payTo and the same per-requirement fields, and
 * differs only in `scheme`.
 *
 * **Nothing emits v1.** This exists because understanding what a peer said is an
 * obligation and saying it yourself is not (ADR-013), and it is scoped to one
 * major version. `exact` is hoisted to the front for the same reason the
 * emitter does it: an x402 client pays the first entry it can handle.
 *
 * v1 had no `resource`; x402's V2 envelope requires one. Pass the URL you
 * fetched if you have it — an empty `url` is honest about not knowing, and is
 * what a re-emitted envelope would otherwise claim to know.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the document is not a well-formed v1 402.
 */
export function fromS402V1Requirements(
  v1: Record<string, unknown>,
  options?: { resource?: s402ResourceInfo },
): s402PaymentRequired {
  if (v1 == null || typeof v1 !== 'object' || Array.isArray(v1)) {
    throw new s402Error('INVALID_PAYLOAD',
      `s402 v1 requirements must be a plain object, got ${v1 === null ? 'null' : Array.isArray(v1) ? 'array' : typeof v1}`);
  }
  if (v1.s402Version !== '1') {
    throw new s402Error('INVALID_PAYLOAD',
      `Unsupported s402Version ${JSON.stringify(v1.s402Version)}: fromS402V1Requirements reads the flat "1" shape only.`);
  }
  if (!Array.isArray(v1.accepts) || v1.accepts.length === 0) {
    throw new s402Error('INVALID_PAYLOAD',
      's402 v1 requirements must carry a non-empty accepts array of scheme names');
  }
  for (const scheme of v1.accepts) {
    if (typeof scheme !== 'string' || scheme.length === 0) {
      throw new s402Error('INVALID_PAYLOAD',
        `Invalid entry in s402 v1 accepts array: expected a non-empty string, got ${typeof scheme}`);
    }
  }

  // Deduplicate, then hoist `exact` — v1 documents were not required to list it
  // first, and wire v2 is.
  const schemes = [...new Set(v1.accepts as string[])]
    .sort((a, b) => (a === 'exact' ? -1 : b === 'exact' ? 1 : 0));

  // Every v1 field except `accepts` describes the ONE offer the document made;
  // each expanded entry therefore carries all of them.
  const shared: Record<string, unknown> = {};
  for (const key of V1_SHARED_KEYS) {
    if (v1[key] !== undefined) shared[key] = v1[key];
  }

  const required: s402PaymentRequired = {
    x402Version: 2,
    resource: options?.resource ?? { url: '' },
    accepts: schemes.map((scheme) => ({ ...shared, scheme } as unknown as s402PaymentRequirements)),
  };
  if (v1.mandate !== undefined) {
    required.mandate = v1.mandate as s402PaymentRequired['mandate'];
  }

  // Validate through the canonical wire validator rather than a second copy of
  // it: project to the wire, check, and lift back. A v1 document with a bad
  // amount or a `file://` facilitatorUrl fails here exactly as it did before.
  const wire = toRequirementsWire(required) as Record<string, unknown>;
  validateRequirementsShape(wire);
  return pickRequirementsFields(wire);
}

/** The v1 flat fields that describe the offer itself, and so ride on every expanded entry. */
const V1_SHARED_KEYS = [
  'network', 'asset', 'amount', 'payTo',
  'facilitatorUrl', 'protocolFeeBps', 'protocolFeeAddress', 'receiptRequired',
  'settlementMode', 'expiresAt',
  'upto', 'settlementOverrides', 'prepaid', 'stream', 'escrow', 'unlock',
  'extensions',
] as const;

/**
 * Auto-detect and normalize any 402 document into s402's wire-v2 shape.
 *
 * This is the NATIVE decode path, not a translation layer: an x402 V2 envelope
 * is what s402 emits, so that case is identity plus the `extra` projection. The
 * conversions left are the two retired flat shapes — x402 V1 and s402 v1.
 *
 * ⚠️ One thing is added rather than copied. When a document carries no
 * `extensions.s402` — a plain x402 402, from a server that has never heard of
 * s402 — an entry with no `expiresAt` gets one derived from its
 * `maxTimeoutSeconds`. Without it, inbound x402 traffic would bypass all three
 * S1 (stale payment rejection) layers, because the facilitator's expiry guards
 * skip an undefined `expiresAt`. s402's own documents are never touched: they
 * say what they mean about expiry, including by saying nothing.
 *
 * @param obj - Raw decoded JSON (s402 wire v2 / x402 V2, x402 V1, or s402 v1)
 * @param now - Clock for the derivation above. Defaults to `Date.now()`.
 * @returns A validated 402 document
 * @throws {s402Error} `INVALID_PAYLOAD` if the format is unrecognized or malformed
 *
 * @example
 * ```ts
 * import { normalizeRequirements } from 's402/compat/x402';
 *
 * const raw = JSON.parse(atob(header));
 * const required = normalizeRequirements(raw);   // any era, one shape out
 * ```
 */
export function normalizeRequirements(
  obj: Record<string, unknown>,
  now?: number,
): s402PaymentRequired {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Payment requirements must be a plain object, got ${obj === null ? 'null' : Array.isArray(obj) ? 'array' : typeof obj}`);
  }

  // s402 v1 flat — the retired shape. ADR-013: we read it, we never write it.
  if (isS402(obj)) {
    return fromS402V1Requirements(obj);
  }

  // x402 V2 envelope — and s402's own wire v2, which is the same document.
  // `pickRequirementsFields` is the whole decode, foreign-expiry derivation
  // included; there is one copy of that rule and it is on the decode path, so
  // every entry point gets it (http.ts `applyForeignExpiry`).
  if (isX402Envelope(obj)) {
    validateRequirementsShape(obj);
    return pickRequirementsFields(obj, now);
  }

  // x402 V1 flat: { x402Version, scheme, network, amount/maxAmountRequired, ... }
  if (isX402(obj)) {
    validateX402Shape(obj);
    const entry = fromX402Requirements(obj as unknown as x402PaymentRequirements, now);
    const v1 = obj as unknown as x402PaymentRequirements;
    const required: s402PaymentRequired = {
      x402Version: 2,
      // V1 carried resource metadata on the requirement itself; V2 hoists it.
      resource: { url: v1.resource ?? '', ...(v1.description ? { description: v1.description } : {}) },
      accepts: [entry],
    };
    const wire = toRequirementsWire(required) as Record<string, unknown>;
    validateRequirementsShape(wire);
    return pickRequirementsFields(wire);
  }

  throw new s402Error('INVALID_PAYLOAD', 'Unrecognized payment requirements format: missing s402Version or x402Version');
}

/** Validate that an x402 object has required fields (supports V1 and V2). */
function validateX402Shape(obj: Record<string, unknown>): void {
  const missing: string[] = [];
  if (typeof obj.scheme !== 'string') missing.push('scheme (string)');
  if (typeof obj.network !== 'string') missing.push('network (string)');
  if (typeof obj.asset !== 'string') missing.push('asset (string)');
  if (typeof obj.payTo !== 'string') missing.push('payTo (string)');
  // V1 uses maxAmountRequired, V2 uses amount — one must be present
  if (typeof obj.amount !== 'string' && typeof obj.maxAmountRequired !== 'string') {
    missing.push('amount or maxAmountRequired (string)');
  } else {
    // Validate numeric format of whichever amount field is present
    const amt = (typeof obj.amount === 'string' ? obj.amount : obj.maxAmountRequired) as string;
    if (!isValidAmount(amt)) {
      throw new s402Error('INVALID_PAYLOAD',
        `Invalid amount "${amt}": must be a non-negative integer string`);
    }
  }
  if (missing.length > 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `Malformed x402 requirements: missing or invalid fields: ${missing.join(', ')}`);
  }
}
