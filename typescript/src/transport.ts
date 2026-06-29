/**
 * s402 Transport Abstraction (ADR-011)
 *
 * A `PaymentTransport` is a lossless mapping between the canonical s402 protocol
 * objects — `{ PaymentRequirements, PaymentPayload, SettleResponse }` — and a
 * specific *carrier's* out-of-band metadata slot:
 *
 *   - HTTP → headers              (`payment-required` / `x-payment` / `payment-response`)
 *   - MCP  → JSON-RPC `_meta`     (`s402/payment`, dual-read `x402/payment`)   [Chunk 1a-ii / 1b]
 *   - A2A  → task-state metadata  (`x402.payment.*` on the task lifecycle)     [Chunk 2]
 *
 * The s402 core (schemes, facilitator, S1–S16 invariants) is transport-agnostic;
 * it never knows which carrier it rides. Each carrier is a thin adapter over the
 * already-tested codec in `http.ts` (and, later, `mcp.ts` / `a2a.ts`). This is a
 * projection, not a reimplementation: if a carrier touches scheme or facilitator
 * logic, the seam is drawn in the wrong place.
 *
 * **Statefulness (ADR-011 blind-spot review).** The interface is designed for the
 * *most stateful* carrier (A2A), whose payment flow is a task lifecycle with a
 * correlation id and an explicit status progression — NOT a stateless
 * request/response. Every method therefore threads an optional
 * {@link PaymentCarrierContext}. Stateless carriers (HTTP) ignore the correlation
 * id (the wire has no slot for it) and only *derive* `status`; A2A populates both.
 * Designing for the harder carrier up front is what keeps A2A a thin adapter
 * instead of forcing an interface break when it lands.
 *
 * **S7 (chain-agnostic boundary).** This module contains zero chain-specific code:
 * no `@mysten/sui` / Solana / EVM imports, no address or u64 validation. Carrier
 * mapping only. Sui settlement lives in `@sweefi/*`.
 */

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
} from './types.js';
import { S402_HEADERS } from './types.js';
import {
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  validateRequirementsShape,
  validatePayloadShape,
  validateSettleShape,
  pickRequirementsFields,
  pickPayloadFields,
  pickSettleResponseFields,
} from './http.js';
import { s402Error } from './errors.js';

// ══════════════════════════════════════════════════════════════
// Carrier-agnostic context
// ══════════════════════════════════════════════════════════════

/**
 * Where a payment sits in its lifecycle. Stateful carriers (A2A) carry this
 * explicitly on the task; stateless carriers (HTTP) derive it from which message
 * is present in the frame.
 */
export type PaymentStatus = 'required' | 'submitted' | 'completed' | 'failed';

/**
 * Carrier-level correlation/state threaded across one payment exchange.
 *
 * - HTTP ignores `correlationId` (no wire slot) and reports only a derived `status`.
 * - A2A uses both: `correlationId` is the task id; `status` mirrors
 *   `x402.payment.status` on the task lifecycle.
 */
export interface PaymentCarrierContext {
  /** Opaque token tying the messages of one exchange together (A2A taskId). Undefined on stateless carriers. */
  correlationId?: string;
  /** Lifecycle position of the payment. */
  status?: PaymentStatus;
}

/** A decoded protocol object plus any carrier context recovered from the frame. */
export interface Decoded<T> {
  /** The canonical s402 protocol object. */
  value: T;
  /** Carrier context recovered from the frame (correlation id, derived/explicit status). */
  ctx: PaymentCarrierContext;
}

// ══════════════════════════════════════════════════════════════
// The transport interface
// ══════════════════════════════════════════════════════════════

/**
 * Binds the canonical s402 protocol objects to one carrier's metadata slot.
 *
 * `TFrame` is the carrier-native container the transport reads from / writes to:
 *   - HTTP: {@link Headers}
 *   - MCP:  the `_meta` record (`Record<string, unknown>`)   [future]
 *   - A2A:  task metadata (`Record<string, unknown>`)         [future]
 *
 * Encoders WRITE the relevant protocol object into a fresh frame; decoders READ
 * it back, returning `null` when the frame carries no such message (e.g. a
 * request that has no payment payload yet). All three encoders accept an optional
 * {@link PaymentCarrierContext} so stateful carriers can thread correlation/state;
 * stateless carriers may ignore it.
 */
export interface PaymentTransport<TFrame = unknown> {
  /** Carrier identifier. */
  readonly carrier: 'http' | 'mcp' | 'a2a';

  /** Server → client: encode payment requirements (the 402 challenge). */
  encodeRequirements(requirements: s402PaymentRequirements, ctx?: PaymentCarrierContext): TFrame;
  /** Client: decode an inbound requirements challenge, or `null` if the frame has none. */
  decodeRequirements(frame: TFrame): Decoded<s402PaymentRequirements> | null;

  /** Client → server: encode the signed payment payload. */
  encodePayload(payload: s402PaymentPayload, ctx?: PaymentCarrierContext): TFrame;
  /** Server: decode an inbound payment payload, or `null` if the frame has none. */
  decodePayload(frame: TFrame): Decoded<s402PaymentPayload> | null;

  /** Server → client: encode the settlement result. */
  encodeSettlement(response: s402SettleResponse, ctx?: PaymentCarrierContext): TFrame;
  /** Client: decode an inbound settlement result, or `null` if the frame has none. */
  decodeSettlement(frame: TFrame): Decoded<s402SettleResponse> | null;
}

// ══════════════════════════════════════════════════════════════
// HTTP transport — the reference carrier
//
// A thin, behavior-preserving adapter over the tested codec in `http.ts`. It
// introduces NO new wire behavior: header names and base64 encoding are exactly
// the existing `S402_HEADERS` + `encode*/decode*` functions. The header-casing
// tidy (ALL-CAPS emit, `PAYMENT-SIGNATURE` inbound) is deliberately deferred to
// Chunk 1a-ii so this step stays a pure refactor — the existing suite remains
// the regression proof.
// ══════════════════════════════════════════════════════════════

/** Build a single-header {@link Headers} frame. */
function headerFrame(name: string, value: string): Headers {
  const h = new Headers();
  h.set(name, value);
  return h;
}

/**
 * HTTP {@link PaymentTransport}. The frame is the web-standard {@link Headers}
 * (case-insensitive reads come for free, per RFC 9110). HTTP is stateless:
 * encoders ignore `ctx.correlationId` (the wire has no slot for it) and decoders
 * report only a *derived* `status` — `required` for a challenge, `submitted` for
 * a payload, and `completed`/`failed` for a settlement per `SettleResponse.success`.
 */
export const httpTransport: PaymentTransport<Headers> = {
  carrier: 'http',

  encodeRequirements(requirements) {
    return headerFrame(S402_HEADERS.PAYMENT_REQUIRED, encodePaymentRequired(requirements));
  },
  decodeRequirements(frame) {
    const header = frame.get(S402_HEADERS.PAYMENT_REQUIRED);
    if (header == null) return null;
    return { value: decodePaymentRequired(header), ctx: { status: 'required' } };
  },

  encodePayload(payload) {
    return headerFrame(S402_HEADERS.PAYMENT, encodePaymentPayload(payload));
  },
  decodePayload(frame) {
    const header = frame.get(S402_HEADERS.PAYMENT);
    if (header == null) return null;
    return { value: decodePaymentPayload(header), ctx: { status: 'submitted' } };
  },

  encodeSettlement(response) {
    return headerFrame(S402_HEADERS.PAYMENT_RESPONSE, encodeSettleResponse(response));
  },
  decodeSettlement(frame) {
    const header = frame.get(S402_HEADERS.PAYMENT_RESPONSE);
    if (header == null) return null;
    const value = decodeSettleResponse(header);
    return { value, ctx: { status: value.success ? 'completed' : 'failed' } };
  },
};

// ══════════════════════════════════════════════════════════════
// MCP transport — payment in the JSON-RPC `_meta` slot
//
// MCP (Model Context Protocol) is JSON-RPC: there are NO HTTP status codes, so
// there is no `402` to lean on. Payment state rides in the standard out-of-band
// slot — the message `_meta` record — exactly as it rides in an HTTP header.
// This codec is the bijection between the canonical s402 objects and a `_meta`
// fragment, with ZERO dependency on the MCP SDK. The actual SDK wiring (paid
// tool registration, attaching `_meta` to a result, raising the payment-required
// error) lives in the Sui-aware `@sweefi/mcp`, which consumes this codec.
//
// Native key: `s402/payment`. (x402's MCP uses `x402/payment`; that inbound
// dual-read + shape normalization is the opt-in `s402/compat/x402` layer's job —
// keeping this core codec x402-free, symmetric with the HTTP carrier.)
//
// Unlike HTTP, MCP carries structured JSON natively, so the `_meta` value is the
// s402 object DIRECTLY (not base64) — MCP's idiom. Decoders therefore run the
// canonical `validate*Shape` checks on the already-parsed object, so the trust
// boundary is identical across carriers.
// ══════════════════════════════════════════════════════════════

/** The native s402 key within an MCP message's `_meta` record. */
export const S402_MCP_META_KEY = 's402/payment' as const;

/** An MCP message `_meta` record — the carrier frame for the MCP transport. */
export type McpMetaFrame = Record<string, unknown>;

/** Build a `_meta` fragment carrying an s402 object under the native key. */
function metaFrame(value: unknown): McpMetaFrame {
  return { [S402_MCP_META_KEY]: value };
}

/**
 * MCP {@link PaymentTransport}. The frame is the message `_meta` record; the
 * s402 object lives at `_meta['s402/payment']` as structured JSON. Like HTTP,
 * MCP is stateless per call here: encoders ignore `ctx.correlationId` (the SDK's
 * JSON-RPC `id` already correlates request/response) and decoders derive `status`.
 *
 * Decoders validate the already-parsed `_meta` object through the SAME canonical
 * validators the HTTP path uses (`validate*Shape` + `pick*Fields` from `http.ts`),
 * so untrusted MCP input crosses the identical trust boundary as untrusted HTTP
 * input. Calling the wrong decoder for a frame (e.g. `decodePayload` on a
 * requirements `_meta`) throws via shape validation — the caller knows direction.
 */
export const mcpTransport: PaymentTransport<McpMetaFrame> = {
  carrier: 'mcp',

  encodeRequirements(requirements) {
    return metaFrame(requirements);
  },
  decodeRequirements(frame) {
    const raw = frame[S402_MCP_META_KEY];
    if (raw == null) return null;
    validateRequirementsShape(raw);
    return { value: pickRequirementsFields(raw as Record<string, unknown>), ctx: { status: 'required' } };
  },

  encodePayload(payload) {
    return metaFrame(payload);
  },
  decodePayload(frame) {
    const raw = frame[S402_MCP_META_KEY];
    if (raw == null) return null;
    validatePayloadShape(raw);
    return { value: pickPayloadFields(raw as Record<string, unknown>), ctx: { status: 'submitted' } };
  },

  encodeSettlement(response) {
    return metaFrame(response);
  },
  decodeSettlement(frame) {
    const raw = frame[S402_MCP_META_KEY];
    if (raw == null) return null;
    validateSettleShape(raw);
    const value = pickSettleResponseFields(raw as Record<string, unknown>);
    return { value, ctx: { status: value.success ? 'completed' : 'failed' } };
  },
};

// ══════════════════════════════════════════════════════════════
// A2A transport — payment on the Agent-to-Agent task lifecycle
//
// A2A (Google's Agent-to-Agent protocol) is STATEFUL: payment rides a task
// through an explicit lifecycle (`input-required → completed`/`failed`), the
// messages are tied together by a `taskId`, and the payment status is carried
// EXPLICITLY in task/message `metadata` — NOT derived from which message is
// present (as HTTP/MCP must). This is exactly the carrier the `PaymentTransport`
// interface was shaped for: the reason `ctx` carries `status` + `correlationId`.
//
// x402 has only an A2A *spec* (no implementation in any language); this is the
// shipped s402 implementation — the leapfrog. Native keys mirror x402's
// `x402.payment.*` metadata convention under the `s402.payment.*` namespace; the
// x402 inbound bridge (`fromX402PayloadA2A`) lives in the opt-in compat layer,
// symmetric with the HTTP and MCP carriers — core stays x402-free.
//
// Frame = the A2A task/message `metadata` record. The canonical `taskId` lives
// on the message envelope (the A2A SDK's concern); the transport additionally
// stamps the correlation under `s402.payment.correlationId` when provided, so a
// payment exchange is self-correlating at the metadata layer and round-trips.
// ══════════════════════════════════════════════════════════════

/** s402 metadata keys on the A2A task/message `metadata` record. */
export const S402_A2A_KEYS = {
  /** Explicit payment lifecycle status (A2A carries this; HTTP/MCP derive it). */
  STATUS: 's402.payment.status',
  /** PaymentRequirements (server → client; task state `input-required`). */
  REQUIRED: 's402.payment.required',
  /** PaymentPayload (client → server; correlated by the envelope taskId). */
  PAYLOAD: 's402.payment.payload',
  /** SettleResponse[] (server → client; task state `completed`/`failed`). */
  RECEIPTS: 's402.payment.receipts',
  /** Optional s402-namespaced copy of the correlation/task id. */
  CORRELATION: 's402.payment.correlationId',
} as const;

/** An A2A task/message `metadata` record — the carrier frame for the A2A transport. */
export type A2aMetadataFrame = Record<string, unknown>;

/** Our {@link PaymentStatus} enum → A2A's verbose `payment.status` wire form. */
const A2A_STATUS_VERBOSE: Record<PaymentStatus, string> = {
  required: 'payment-required',
  submitted: 'payment-submitted',
  completed: 'payment-completed',
  failed: 'payment-failed',
};
/** A2A's verbose `payment.status` wire form → our {@link PaymentStatus} enum. */
const A2A_STATUS_ENUM: Record<string, PaymentStatus> = {
  'payment-required': 'required',
  'payment-submitted': 'submitted',
  'payment-completed': 'completed',
  'payment-failed': 'failed',
};

/** Read the EXPLICIT A2A status from metadata, mapped to our enum; `fallback` if absent/unknown. */
function a2aStatus(frame: A2aMetadataFrame, fallback: PaymentStatus): PaymentStatus {
  const raw = frame[S402_A2A_KEYS.STATUS];
  if (typeof raw !== 'string') return fallback;
  return A2A_STATUS_ENUM[raw] ?? fallback;
}

/** Recover the optional s402-namespaced correlation id from metadata. */
function a2aCorrelation(frame: A2aMetadataFrame): string | undefined {
  const raw = frame[S402_A2A_KEYS.CORRELATION];
  return typeof raw === 'string' ? raw : undefined;
}

/** Build the status (+ optional correlation) preamble shared by every A2A encode. */
function a2aPreamble(status: PaymentStatus, ctx?: PaymentCarrierContext): A2aMetadataFrame {
  const frame: A2aMetadataFrame = { [S402_A2A_KEYS.STATUS]: A2A_STATUS_VERBOSE[status] };
  if (ctx?.correlationId != null) frame[S402_A2A_KEYS.CORRELATION] = ctx.correlationId;
  return frame;
}

/**
 * A2A {@link PaymentTransport}. The frame is the task/message `metadata` record.
 * Unlike HTTP/MCP, A2A is fully stateful: encoders WRITE an explicit
 * `s402.payment.status` and thread `ctx.correlationId`; decoders READ the status
 * back (rather than derive it) and recover the correlation. Payment objects are
 * structured JSON under direction-specific keys, validated through the same
 * canonical `validate*Shape`/`pick*Fields` as every other carrier — identical
 * trust boundary. Settlement uses A2A's plural `receipts` array convention
 * (s402 settles once, so the array holds a single response).
 */
export const a2aTransport: PaymentTransport<A2aMetadataFrame> = {
  carrier: 'a2a',

  encodeRequirements(requirements, ctx) {
    return { ...a2aPreamble('required', ctx), [S402_A2A_KEYS.REQUIRED]: requirements };
  },
  decodeRequirements(frame) {
    const raw = frame[S402_A2A_KEYS.REQUIRED];
    if (raw == null) return null;
    validateRequirementsShape(raw);
    return {
      value: pickRequirementsFields(raw as Record<string, unknown>),
      ctx: { status: a2aStatus(frame, 'required'), correlationId: a2aCorrelation(frame) },
    };
  },

  encodePayload(payload, ctx) {
    return { ...a2aPreamble('submitted', ctx), [S402_A2A_KEYS.PAYLOAD]: payload };
  },
  decodePayload(frame) {
    const raw = frame[S402_A2A_KEYS.PAYLOAD];
    if (raw == null) return null;
    validatePayloadShape(raw);
    return {
      value: pickPayloadFields(raw as Record<string, unknown>),
      ctx: { status: a2aStatus(frame, 'submitted'), correlationId: a2aCorrelation(frame) },
    };
  },

  encodeSettlement(response, ctx) {
    const status: PaymentStatus = response.success ? 'completed' : 'failed';
    return { ...a2aPreamble(status, ctx), [S402_A2A_KEYS.RECEIPTS]: [response] };
  },
  decodeSettlement(frame) {
    const raw = frame[S402_A2A_KEYS.RECEIPTS];
    if (raw == null) return null;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new s402Error('INVALID_PAYLOAD', 'A2A s402.payment.receipts must be a non-empty array');
    }
    validateSettleShape(raw[0]);
    const value = pickSettleResponseFields(raw[0] as Record<string, unknown>);
    return {
      value,
      ctx: { status: a2aStatus(frame, value.success ? 'completed' : 'failed'), correlationId: a2aCorrelation(frame) },
    };
  },
};
