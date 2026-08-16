/**
 * s402 ↔ MPP Compatibility Layer (bidirectional)
 *
 * Enables s402 servers and clients to interop with Stripe/Tempo's Machine
 * Payment Protocol (MPP). MPP uses `WWW-Authenticate: Payment` with auth-params
 * and a method/intent pair — not a flat scheme token like s402 or x402.
 *
 * Spec references (tempoxyz/mpp-specs). Cited per area rather than as one
 * repo-wide baseline: the previous header declared a single commit (e731a13,
 * 2026-05-12) for the whole module, which was wrong in both directions — the
 * file already implemented #285 (2026-06-19, newer than the baseline) while
 * lagging the method drafts by 22 commits. A global baseline asserts uniform
 * conformance that a partial implementation never has.
 *
 *   - Core:      specs/core/draft-httpauth-payment-00.md         @ e731a13
 *   - Charge:    specs/intents/draft-payment-intent-charge-00.md @ e731a13 (+ #285)
 *   - EVM:       specs/methods/evm/draft-evm-charge-00.md        @ e731a13
 *   - Solana:    specs/methods/solana/draft-solana-charge-00.md  @ f9506cd — network only
 *   - Lightning: specs/methods/lightning/draft-lightning-charge-00.md @ f9506cd — network only
 *   - Stellar:   specs/methods/stellar/draft-stellar-charge-00.md @ f9506cd — network only
 *   - Tempo:     specs/methods/tempo/draft-tempo-charge-00.md     @ f9506cd — chainId only
 *
 * Known NOT synced (DAN-848, criteria 3–4): `hedera`, `nearintents` and `usdc`
 * are specified blockchain charge methods that this module rejects. `usdc`
 * nests its chain id per chain family (`methodDetails.evm.chainId`) and
 * `nearintents` is cross-chain with a CAIP-2 `originNetwork`, so neither fits
 * the flat translation below without a design decision.
 *
 * Scope (v0.3 DAN-339, read-path):
 *   - Parse `WWW-Authenticate: Payment` challenges
 *   - Parse MPP-style `Accept-Payment` (method/intent pairs with wildcards)
 *   - Decode `Authorization: Payment` credentials
 *   - Translate the canonical `charge` intent into s402 exact requirements
 *
 * Scope (v0.4, write-path, 2026-05-12):
 *   - Build MppChargeRequest objects from direct input
 *   - Emit MppChallenge objects with JCS-canonicalized + base64url-encoded
 *     `request` parameter ready for `WWW-Authenticate: Payment` header
 *
 * Not in scope here:
 *   - Session intent (cumulative voucher model; needs Prepaid translation shim)
 *   - HMAC-SHA256 challenge binding computation (server-side, needs secret).
 *     Per mpp-specs §Challenge-Binding Secret Management (PR #233): callers
 *     that compute digests MUST keep the secret server-side only, MUST NOT
 *     log it, and SHOULD support graceful rotation. This module accepts a
 *     pre-computed `digest` as input and never sees the secret.
 *   - Method-specific credential dispatch (EVM permit2/authorization/transaction/hash,
 *     Tempo transaction/hash/proof — each method spec defines its own payload)
 *   - WWW-Authenticate / Authorization header string assembly (the
 *     MppChallenge / MppCredential objects produced here can be rendered to
 *     header strings by callers that need them).
 */

import type { s402PaymentRequirements } from '../types.js';
import { S402_VERSION } from '../types.js';
import { s402Error } from '../errors.js';
import { isValidAmount } from '../http.js';
import { canonicalizeToString } from '../canonicalization.js';

// ══════════════════════════════════════════════════════════════
// MPP wire types (read-side; fields we consume)
// ══════════════════════════════════════════════════════════════

/**
 * Parsed `WWW-Authenticate: Payment` challenge parameters.
 *
 * Required params per core spec §5.1.1: id, realm, method, intent, request.
 * Optional params per §5.1.2: digest, expires, description, opaque.
 * `request` is a base64url-nopad JCS-encoded JSON object — decoded separately
 * by intent-specific parsers (see {@link decodeMppChargeRequest}).
 */
export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
  digest?: string;
  expires?: string;
  description?: string;
  opaque?: string;
}

/**
 * Shared Charge-intent request fields per `draft-payment-intent-charge-00` §Request Schema.
 *
 * `amount` + `currency` are required across every method. `recipient` is
 * REQUIRED for blockchain methods and OPTIONAL for processor-based methods
 * (Stripe routes internally). `methodDetails` holds method-specific extension
 * data (chainId, permit2Address, invoice, networkId, paymentMethodTypes, ...).
 */
export interface MppChargeRequest {
  amount: string;
  currency: string;
  recipient?: string;
  description?: string;
  externalId?: string;
  methodDetails?: Record<string, unknown>;
}

/**
 * Decoded `Authorization: Payment <base64url>` credential per core spec §5.2.
 *
 * `challenge` echoes the original challenge params (verified server-side).
 * `payload` is method-specific (Permit2 signature, Lightning preimage, Stripe
 * confirmation id, ...). `source` is RECOMMENDED DID format for payer identity.
 */
export interface MppCredential {
  challenge: {
    id: string;
    realm: string;
    method: string;
    intent: string;
    request: string;
    digest?: string;
    expires?: string;
    description?: string;
    opaque?: string;
  };
  source?: string;
  payload: Record<string, unknown>;
}

/**
 * Entry in an MPP `Accept-Payment` header.
 *
 * MPP preference uses method/intent pairs with wildcards on either side
 * (`tempo/x`, `x/session`, `x/x` where `x` is the literal `*`) and q-values
 * per RFC 9110. This differs from s402's flat scheme tokens (`s402/exact`,
 * `s402/prepaid`) which `parseAcceptPayment` treats as opaque strings.
 */
export interface MppPaymentRange {
  /** Lowercase method id or "*" wildcard. */
  method: string;
  /** Intent token or "*" wildcard. */
  intent: string;
  /** Quality factor in [0,1]; 0 means "do not use". */
  q: number;
}

// ══════════════════════════════════════════════════════════════
// Parsing: WWW-Authenticate: Payment
// ══════════════════════════════════════════════════════════════

const TOKEN_CHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const AUTH_SCHEME_PATTERN = /^\s*Payment(?:\s+(.*))?$/i;

/**
 * Parse a `WWW-Authenticate: Payment ...` header into an {@link MppChallenge}.
 *
 * Returns null if the header is absent, empty, or doesn't start with `Payment`.
 * Throws `INVALID_PAYLOAD` if the Payment scheme is present but required params
 * are missing. Accepts a single Payment challenge per header line — per core
 * spec §7.1 (Intent Negotiation), servers emitting multiple challenges send
 * one header per challenge.
 *
 * @example
 * ```ts
 * const header = res.headers.get('WWW-Authenticate');
 * const challenge = parseWwwAuthenticatePayment(header);
 * if (challenge?.intent === 'charge') {
 *   const req = decodeMppChargeRequest(challenge);
 *   // ...
 * }
 * ```
 */
export function parseWwwAuthenticatePayment(
  header: string | null | undefined,
): MppChallenge | null {
  if (!header) return null;
  const match = AUTH_SCHEME_PATTERN.exec(header);
  if (!match) return null;
  const paramString = (match[1] ?? '').trim();
  if (paramString.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'Payment challenge missing auth-params');
  }

  const params = parseAuthParams(paramString);
  const required = ['id', 'realm', 'method', 'intent', 'request'] as const;
  // A required auth-param that parsed to an empty string is effectively missing.
  // MPP hardened `id` to MUST-be-non-empty (mpp-specs PR #285): an empty challenge
  // id is replay-ambiguous (nothing to bind the challenge to). Apply to all required.
  const missing = required.filter((k) => typeof params[k] !== 'string' || params[k] === '');
  if (missing.length > 0) {
    throw new s402Error('INVALID_PAYLOAD',
      `Payment challenge missing required auth-params: ${missing.join(', ')}`);
  }

  return {
    id: params.id!,
    realm: params.realm!,
    method: params.method!.toLowerCase(),
    intent: params.intent!,
    request: params.request!,
    digest: params.digest,
    expires: params.expires,
    description: params.description,
    opaque: params.opaque,
  };
}

/**
 * Parse an `auth-params` string per RFC 9110 §11.2: `token "=" ( token / quoted-string )`
 * list separated by `OWS "," OWS`. Unknown parameters are preserved in the
 * returned map so callers can ignore them per core spec §5.1.2.
 */
function parseAuthParams(input: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  let i = 0;
  const n = input.length;

  while (i < n) {
    while (i < n && (input[i] === ' ' || input[i] === '\t' || input[i] === ',')) i++;
    if (i >= n) break;

    const keyStart = i;
    while (i < n && input[i] !== '=' && input[i] !== ' ' && input[i] !== '\t') i++;
    const key = input.slice(keyStart, i).toLowerCase();
    if (key.length === 0 || !TOKEN_CHARS.test(key)) {
      throw new s402Error('INVALID_PAYLOAD', `Malformed auth-param name at position ${keyStart}`);
    }

    while (i < n && (input[i] === ' ' || input[i] === '\t')) i++;
    if (input[i] !== '=') {
      throw new s402Error('INVALID_PAYLOAD', `Missing "=" after auth-param "${key}"`);
    }
    i++;
    while (i < n && (input[i] === ' ' || input[i] === '\t')) i++;

    let value: string;
    if (input[i] === '"') {
      i++;
      const valueStart = i;
      let raw = '';
      while (i < n && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < n) {
          raw += input[i + 1];
          i += 2;
        } else {
          raw += input[i];
          i++;
        }
      }
      if (input[i] !== '"') {
        throw new s402Error('INVALID_PAYLOAD', `Unterminated quoted-string starting at position ${valueStart}`);
      }
      i++;
      value = raw;
    } else {
      const valueStart = i;
      while (i < n && input[i] !== ',' && input[i] !== ' ' && input[i] !== '\t') i++;
      value = input.slice(valueStart, i);
      if (value.length === 0 || !TOKEN_CHARS.test(value)) {
        throw new s402Error('INVALID_PAYLOAD', `Malformed auth-param value for "${key}"`);
      }
    }

    out[key] = value;
  }

  return out;
}

// ══════════════════════════════════════════════════════════════
// Parsing: Accept-Payment (method/intent pairs)
// ══════════════════════════════════════════════════════════════

const METHOD_ID_PATTERN = /^[a-z]+$|^\*$/;
const INTENT_PATTERN = /^[a-zA-Z0-9\-_]+$|^\*$/;
const Q_VALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * MPP charge method-id grammar — `payment-method-id = 1*LOWERALPHA`
 * (mpp-specs §Method Identifier Format). Stricter than {@link METHOD_ID_PATTERN}:
 * no `*` wildcard, because a concrete *emitted* method is never a range.
 */
const CHARGE_METHOD_ID = /^[a-z]+$/;

/**
 * Validate + normalize an MPP charge method id: lowercase, then enforce the
 * lowercase-ASCII-letter grammar so the write-path can never emit a method the
 * read-path ({@link parseMppAcceptPayment}) would reject. Non-string input
 * becomes a typed {@link s402Error}, never a raw `TypeError`.
 */
function normalizeChargeMethod(method: unknown): string {
  if (typeof method !== 'string' || method.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'MPP Charge "method" is required and must be a non-empty string');
  }
  const normalized = method.toLowerCase();
  if (!CHARGE_METHOD_ID.test(normalized)) {
    throw new s402Error('INVALID_PAYLOAD',
      `MPP method "${method}" must be lowercase ASCII letters per mpp-specs §Method Identifier Format (1*LOWERALPHA)`);
  }
  return normalized;
}

/**
 * Parse an MPP `Accept-Payment` header per core spec §6.1.
 *
 * Grammar: `Accept-Payment = #(method-or-* "/" intent-or-* [weight])`.
 * Drops malformed entries silently — spec §6.1: "If Accept-Payment is
 * malformed, servers MAY ignore it." Stable sort: descending q, original
 * order on ties (preserves client preference per §6.1).
 *
 * @example
 * ```ts
 * const ranges = parseMppAcceptPayment('tempo/charge, tempo/session;q=0, stripe/*;q=0.5');
 * // [{ method: 'tempo', intent: 'charge', q: 1 },
 * //  { method: 'stripe', intent: '*', q: 0.5 },
 * //  { method: 'tempo', intent: 'session', q: 0 }]
 * ```
 */
export function parseMppAcceptPayment(
  header: string | null | undefined,
): MppPaymentRange[] {
  if (!header) return [];
  const entries: Array<{ range: MppPaymentRange; order: number }> = [];

  const parts = header.split(',');
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i].trim();
    if (segment.length === 0) continue;

    const [tokenRaw, ...paramParts] = segment.split(';');
    const token = tokenRaw.trim().toLowerCase();
    const slash = token.indexOf('/');
    if (slash <= 0 || slash === token.length - 1) continue;

    const method = token.slice(0, slash);
    const intent = token.slice(slash + 1);
    if (!METHOD_ID_PATTERN.test(method) || !INTENT_PATTERN.test(intent)) continue;

    let q = 1;
    let qSeen = false;
    let valid = true;
    for (const p of paramParts) {
      const [nameRaw, valRaw] = p.split('=');
      if (!nameRaw || valRaw === undefined) continue;
      if (nameRaw.trim().toLowerCase() !== 'q') continue;
      if (qSeen) { valid = false; break; }
      qSeen = true;
      const val = valRaw.trim();
      if (!Q_VALUE_PATTERN.test(val)) { valid = false; break; }
      const parsed = Number.parseFloat(val);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) { valid = false; break; }
      q = parsed;
    }
    if (!valid) continue;

    entries.push({ range: { method, intent, q }, order: i });
  }

  entries.sort((a, b) => (b.range.q - a.range.q) || (a.order - b.order));
  return entries.map((e) => e.range);
}

/**
 * Match an MPP payment range against a concrete `method/intent` pair.
 *
 * Returns a specificity score: 2 (exact match on both), 1 (one wildcard),
 * 0 (both wildcards), -1 (no match). Higher specificity wins per spec §6.1:
 * "Prefer the most specific matching range when multiple ranges match."
 */
export function matchMppRange(
  range: MppPaymentRange,
  method: string,
  intent: string,
): number {
  const methodMatch = range.method === '*' || range.method === method.toLowerCase();
  const intentMatch = range.intent === '*' || range.intent === intent;
  if (!methodMatch || !intentMatch) return -1;
  const methodSpecific = range.method !== '*' ? 1 : 0;
  const intentSpecific = range.intent !== '*' ? 1 : 0;
  return methodSpecific + intentSpecific;
}

// ══════════════════════════════════════════════════════════════
// Base64url + JSON decoding
// ══════════════════════════════════════════════════════════════

function base64urlDecodeToString(input: string): string {
  // Defense-in-depth size cap (mirrors http.ts MAX_HEADER_BYTES). MPP header
  // params are bounded by the HTTP server upstream, but this trust-boundary
  // decoder shouldn't rely on that.
  if (input.length > 64 * 1024) {
    throw new s402Error('INVALID_PAYLOAD', 'base64url value exceeds maximum size (65536)');
  }
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new s402Error('INVALID_PAYLOAD', 'Value is not valid base64url (no-padding)');
  }
  const pad = input.length % 4;
  const padded = pad === 0 ? input : input + '='.repeat(4 - pad);
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  try {
    if (typeof globalThis.atob === 'function') {
      const bin = globalThis.atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    const BufferCtor = (globalThis as { Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string } } }).Buffer;
    if (BufferCtor) {
      return BufferCtor.from(b64, 'base64').toString('utf-8');
    }
    throw new s402Error('INVALID_PAYLOAD', 'No base64 decoder available in this runtime');
  } catch (e) {
    if (e instanceof s402Error) throw e;
    throw new s402Error('INVALID_PAYLOAD', 'Failed to decode base64url value');
  }
}

/**
 * Encode a UTF-8 string as base64url (RFC 4648 §5) with no padding. Symmetric
 * counterpart to {@link base64urlDecodeToString}: roundtrip-stable for any
 * valid UTF-8 input.
 */
function base64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let b64: string;
  if (typeof globalThis.btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    b64 = globalThis.btoa(bin);
  } else {
    const BufferCtor = (globalThis as { Buffer?: { from: (b: Uint8Array) => { toString: (enc: string) => string } } }).Buffer;
    if (!BufferCtor) {
      throw new s402Error('INVALID_PAYLOAD', 'No base64 encoder available in this runtime');
    }
    b64 = BufferCtor.from(bytes).toString('base64');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode the `request` parameter of an MPP Charge challenge into its shared
 * fields. Per `draft-payment-intent-charge-00` §Request Schema, every Charge
 * method emits `amount` + `currency` as REQUIRED shared fields; blockchain
 * methods additionally require `recipient`.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the request blob is not
 *   base64url-JSON, or is missing `amount` / `currency`, or if `amount` is
 *   not a non-negative integer string.
 */
export function decodeMppChargeRequest(challenge: MppChallenge): MppChargeRequest {
  if (challenge.intent !== 'charge') {
    throw new s402Error('INVALID_PAYLOAD',
      `Expected intent="charge", got "${challenge.intent}"`);
  }
  const json = base64urlDecodeToString(challenge.request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new s402Error('INVALID_PAYLOAD', 'Charge request is not valid JSON');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new s402Error('INVALID_PAYLOAD', 'Charge request must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.amount !== 'string') {
    throw new s402Error('INVALID_PAYLOAD', 'Charge request missing "amount" (string)');
  }
  if (typeof obj.currency !== 'string') {
    throw new s402Error('INVALID_PAYLOAD', 'Charge request missing "currency" (string)');
  }
  if (!isValidAmount(obj.amount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Charge "amount" must be a non-negative integer string, got "${obj.amount}"`);
  }

  const out: MppChargeRequest = {
    amount: obj.amount,
    currency: obj.currency,
  };
  if (typeof obj.recipient === 'string') out.recipient = obj.recipient;
  if (typeof obj.description === 'string') out.description = obj.description;
  if (typeof obj.externalId === 'string') out.externalId = obj.externalId;
  if (obj.methodDetails != null && typeof obj.methodDetails === 'object' && !Array.isArray(obj.methodDetails)) {
    out.methodDetails = obj.methodDetails as Record<string, unknown>;
  }
  return out;
}

/**
 * Decode an `Authorization: Payment <base64url>` credential into its JSON form.
 * Does not verify HMAC challenge-binding — that requires the server's secret
 * and is intentionally out of scope for this client-facing helper.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the header is missing/malformed,
 *   the blob is not base64url-JSON, or required fields (`challenge`, `payload`)
 *   are missing.
 */
export function decodeMppCredential(
  authorizationHeader: string | null | undefined,
): MppCredential {
  if (!authorizationHeader) {
    throw new s402Error('INVALID_PAYLOAD', 'Authorization header missing');
  }
  const match = /^\s*Payment\s+([A-Za-z0-9_-]+)\s*$/i.exec(authorizationHeader);
  if (!match) {
    throw new s402Error('INVALID_PAYLOAD',
      'Authorization header must be "Payment <base64url>" (RFC 4648 §5 no-padding)');
  }
  const json = base64urlDecodeToString(match[1]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new s402Error('INVALID_PAYLOAD', 'Credential blob is not valid JSON');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new s402Error('INVALID_PAYLOAD', 'Credential must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.challenge == null || typeof obj.challenge !== 'object' || Array.isArray(obj.challenge)) {
    throw new s402Error('INVALID_PAYLOAD', 'Credential missing "challenge" object');
  }
  if (obj.payload == null || typeof obj.payload !== 'object' || Array.isArray(obj.payload)) {
    throw new s402Error('INVALID_PAYLOAD', 'Credential missing "payload" object');
  }
  const ch = obj.challenge as Record<string, unknown>;
  for (const k of ['id', 'realm', 'method', 'intent', 'request'] as const) {
    if (typeof ch[k] !== 'string' || ch[k] === '') {
      throw new s402Error('INVALID_PAYLOAD', `Credential challenge missing "${k}" (string)`);
    }
  }
  const credential: MppCredential = {
    challenge: {
      id: ch.id as string,
      realm: ch.realm as string,
      method: (ch.method as string).toLowerCase(),
      intent: ch.intent as string,
      request: ch.request as string,
    },
    payload: obj.payload as Record<string, unknown>,
  };
  if (typeof ch.digest === 'string') credential.challenge.digest = ch.digest;
  if (typeof ch.expires === 'string') credential.challenge.expires = ch.expires;
  if (typeof ch.description === 'string') credential.challenge.description = ch.description;
  if (typeof ch.opaque === 'string') credential.challenge.opaque = ch.opaque;
  if (typeof obj.source === 'string') credential.source = obj.source;
  return credential;
}

// ══════════════════════════════════════════════════════════════
// Translation: MPP Charge → s402 requirements
// ══════════════════════════════════════════════════════════════

/** Options for {@link fromMppChargeChallenge}. */
export interface FromMppChargeOptions {
  /** Injected clock for the expiry check. Defaults to `Date.now()`. */
  now?: number;
  /**
   * The network this client is configured to pay on. When supplied, a challenge
   * resolving to any other network is rejected.
   *
   * Method specs put the obligation on the client, not the server: Solana's
   * charge draft says clients MUST reject challenges whose network does not
   * match their configured cluster, and Lightning's says SHOULD. Supply this
   * wherever the configured network is known — the check is opt-in only because
   * the translator cannot discover it.
   */
  expectedNetwork?: string;
}

/**
 * Known-mappable MPP methods. The set is deliberately conservative:
 * a method is only listed here if its Charge request shape reliably carries
 * the fields s402 needs (`recipient` as payTo, `currency` as asset). Processor
 * methods (`stripe`, `card`) route internally — their Charge requests do not
 * expose a payTo, so they need the write-path emitter, not this translator.
 */
const BLOCKCHAIN_CHARGE_METHODS = new Set(['tempo', 'evm', 'solana', 'lightning', 'stellar']);

/**
 * Specified blockchain Charge methods this translator does not map. They are
 * named so the rejection can say why: each has a published method draft and a
 * real payTo, so calling them "processor-based" — as the single catch-all
 * message used to — sends the reader looking for a problem that is not there.
 *
 *   - hedera:      EIP-155 chainId (295 mainnet / 296 testnet); would fit, unbuilt.
 *   - usdc:        nests chain id per family (`methodDetails.evm.chainId`).
 *   - nearintents: cross-chain — a CAIP-2 `originNetwork` plus a distinct
 *                  destination asset, so a single `network` field is ambiguous.
 */
const UNMAPPED_BLOCKCHAIN_CHARGE_METHODS = new Set(['hedera', 'usdc', 'nearintents']);

/**
 * Methods that name their network with an enumerated string under
 * `methodDetails.network`, rather than a numeric chain id.
 *
 * Solana and Lightning are the same shape: an OPTIONAL `network` field, a
 * closed enumeration, a spec'd default of `"mainnet"`, and a clause obliging
 * clients to reject a challenge whose network differs from the one they are
 * configured for (MUST for Solana, SHOULD for Lightning).
 *
 *   - solana:    draft-solana-charge-00 §Method Details
 *   - lightning: draft-lightning-charge-00 §Method Details
 *
 * **Architecture Invariant:** every member of {@link BLOCKCHAIN_CHARGE_METHODS}
 * must have a resolution arm in {@link resolveNetwork}. The resolver has no
 * fallback — a method added to the mappable set without one throws on every
 * challenge. This is deliberate: the previous fallback returned
 * `` `${method}:unknown` ``, which made two different networks compare equal
 * and silently disarmed the reject-on-mismatch clause above.
 */
const ENUMERATED_NETWORK_METHODS: Record<string, ReadonlySet<string>> = {
  solana: new Set(['mainnet', 'devnet', 'localnet']),
  lightning: new Set(['mainnet', 'regtest', 'signet']),
};

/** Spec'd default when a Tempo Charge omits `chainId` (draft-tempo-charge-00 §Request Schema). */
const TEMPO_DEFAULT_CHAIN_ID = 42431;

/** Both spec'd network enumerations default to this when the field is absent. */
const DEFAULT_ENUMERATED_NETWORK = 'mainnet';

/** Normalize a numeric-or-decimal-string chain id, or `undefined` if malformed. */
function parseChainId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  return undefined;
}

/**
 * Network identifier resolution for MPP Charge requests per method.
 *
 * The core spec leaves network naming to individual method specs, and they do
 * not agree on a field: EVM and Tempo carry a numeric `chainId`, Solana and
 * Lightning an enumerated `network` string, Stellar a CAIP-2 identifier already
 * in its final form. This resolver reads whichever field the owning method spec
 * names, and throws when it cannot — it never invents a placeholder.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` when the method's network field is
 *   absent where REQUIRED, or present but outside the spec's enumeration.
 */
function resolveNetwork(method: string, methodDetails: Record<string, unknown> | undefined): string {
  const enumerated = ENUMERATED_NETWORK_METHODS[method];
  if (enumerated) {
    const network = methodDetails?.network ?? DEFAULT_ENUMERATED_NETWORK;
    if (typeof network === 'string' && enumerated.has(network)) return `${method}:${network}`;
    throw new s402Error('INVALID_PAYLOAD',
      `MPP ${method} Charge "methodDetails.network" must be one of ` +
      `${[...enumerated].map((n) => `"${n}"`).join(', ')} — got ${JSON.stringify(network)}`);
  }

  if (method === 'stellar') {
    // REQUIRED for stellar, and already a CAIP-2 identifier (`stellar:pubnet`,
    // `stellar:testnet`) — the resolver's job is to validate and pass through,
    // not to re-derive. The reference is left open rather than enumerated: the
    // CAIP-2 Stellar namespace, not this module, decides what is valid.
    const network = methodDetails?.network;
    if (typeof network === 'string' && /^stellar:[-a-zA-Z0-9]{1,32}$/.test(network)) return network;
    throw new s402Error('INVALID_PAYLOAD',
      `MPP stellar Charge requires a CAIP-2 "methodDetails.network" ` +
      `(e.g. "stellar:pubnet") — got ${JSON.stringify(network)}`);
  }

  if (method === 'evm' || method === 'tempo') {
    const raw = method === 'tempo'
      ? methodDetails?.chainId ?? TEMPO_DEFAULT_CHAIN_ID  // OPTIONAL, spec'd default
      : methodDetails?.chainId;                            // REQUIRED for evm
    const chainId = parseChainId(raw);
    if (chainId === undefined) {
      throw new s402Error('INVALID_PAYLOAD',
        `MPP ${method} Charge "methodDetails.chainId" must be a non-negative integer ` +
        `— got ${JSON.stringify(raw)}`);
    }
    return method === 'evm' ? `eip155:${chainId}` : `tempo:${chainId}`;
  }

  // Unreachable for members of BLOCKCHAIN_CHARGE_METHODS — see the invariant above.
  throw new s402Error('INVALID_PAYLOAD',
    `MPP method "${method}" has no network resolution rule`);
}

/**
 * Translate an MPP Charge challenge into s402 requirements using the `exact`
 * scheme. This is the inbound half of the coexistence pattern documented in
 * `guide/upgrade-mpp.md`: an s402 client receives an MPP 402, lifts it into
 * s402 types, then reuses its existing payment machinery.
 *
 * Only blockchain-like methods are translated here. Processor methods (Stripe
 * card, etc.) route internally and do not expose the payTo/asset fields s402
 * requires — keep those on the MPP path.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the method is not a known
 *   blockchain-style Charge method, if the request is missing a recipient
 *   (REQUIRED for blockchain methods per charge spec), if the challenge
 *   has expired at `now`, if its network cannot be resolved, or if that
 *   network differs from `options.expectedNetwork`.
 */
export function fromMppChargeChallenge(
  challenge: MppChallenge,
  optionsOrNow?: number | FromMppChargeOptions,
): s402PaymentRequirements {
  const options: FromMppChargeOptions =
    typeof optionsOrNow === 'number' ? { now: optionsOrNow } : optionsOrNow ?? {};
  const now = options.now;
  if (challenge.intent !== 'charge') {
    throw new s402Error('INVALID_PAYLOAD',
      `fromMppChargeChallenge requires intent="charge", got "${challenge.intent}"`);
  }
  if (!BLOCKCHAIN_CHARGE_METHODS.has(challenge.method)) {
    throw new s402Error('INVALID_PAYLOAD',
      UNMAPPED_BLOCKCHAIN_CHARGE_METHODS.has(challenge.method)
        ? `MPP method "${challenge.method}" is a blockchain Charge method that this ` +
          `translator does not yet map — its Charge request does not fit the flat ` +
          `network/asset/payTo shape (see DAN-848)`
        : `MPP method "${challenge.method}" is not mappable to s402 requirements — ` +
          `processor-based methods (stripe, card) have no payTo/asset exposed in the Charge request`);
  }

  const request = decodeMppChargeRequest(challenge);
  if (typeof request.recipient !== 'string' || request.recipient.length === 0) {
    throw new s402Error('INVALID_PAYLOAD',
      'Blockchain Charge request missing "recipient" — required by charge-intent spec for blockchain methods');
  }

  let expiresAt: number | undefined;
  if (challenge.expires) {
    const ts = Date.parse(challenge.expires);
    if (Number.isNaN(ts)) {
      throw new s402Error('INVALID_PAYLOAD',
        `Challenge "expires" is not a valid RFC 3339 date-time: "${challenge.expires}"`);
    }
    expiresAt = ts;
    const currentTime = now ?? Date.now();
    if (ts <= currentTime) {
      throw new s402Error('INVALID_PAYLOAD', 'MPP challenge has already expired');
    }
  }

  const network = resolveNetwork(challenge.method, request.methodDetails);
  if (options.expectedNetwork !== undefined && network !== options.expectedNetwork) {
    // Solana's spec makes this a MUST and Lightning's a SHOULD. Enforcing it at
    // the lift means a caller that supplies its configured network cannot
    // forget the comparison downstream.
    throw new s402Error('INVALID_PAYLOAD',
      `MPP challenge is for network "${network}" but this client is configured ` +
      `for "${options.expectedNetwork}"`);
  }

  return {
    s402Version: S402_VERSION,
    accepts: ['exact'],
    network,
    asset: request.currency,
    amount: request.amount,
    payTo: request.recipient,
    expiresAt,
    extensions: {
      mpp: {
        challengeId: challenge.id,
        method: challenge.method,
        intent: challenge.intent,
        realm: challenge.realm,
      },
    },
  };
}

// ══════════════════════════════════════════════════════════════
// Translation: s402 → MPP Charge (write path)
// ══════════════════════════════════════════════════════════════

/**
 * Direct-input shape for {@link toMppChargeChallenge}. Mirrors the MPP Charge
 * request structure rather than the s402 wire format — this is deliberate:
 * the write-path's primary use case is fresh emission for processor methods
 * (stripe, card) which don't have a clean s402 expression (no payTo, no asset
 * — Stripe routes internally). Callers with an s402PaymentRequirements in
 * hand can derive these fields trivially.
 */
export interface ToMppChargeInput {
  /** Payment method identifier per the MPP method registry (tempo, evm, solana, stripe, card, lightning, stellar, ...). Lowercased on emission. */
  method: string;
  /** Charge amount in smallest unit, as a canonical non-negative integer string. */
  amount: string;
  /** Currency or asset identifier (e.g., 'USD', '0x...USDC contract', or a chain-native coin type tag). */
  currency: string;
  /** REQUIRED for blockchain methods (tempo, evm, solana, lightning, stellar). OPTIONAL for processor methods (stripe, card) which route internally. */
  recipient?: string;
  /** Method-specific data (chainId, permit2Address, intentId, paymentMethodTypes, networkId, ...). */
  methodDetails?: Record<string, unknown>;
  /** Human-readable description of the payment. */
  description?: string;
  /** Client-supplied idempotency / correlation identifier. */
  externalId?: string;
  /** Challenge ID. Auto-generated via crypto.randomUUID() if not provided. */
  id?: string;
  /** Protection realm. Defaults to `'s402'`. */
  realm?: string;
  /** RFC 3339 expiration timestamp. Optional. */
  expires?: string;
  /** Opaque server-data for replay binding. Optional. */
  opaque?: string;
  /** HMAC digest of challenge fields for stateless challenge-binding. Optional. Per mpp-specs §Challenge-Binding Secret Management (PR #233), callers that compute digests MUST keep the secret server-side only. */
  digest?: string;
}

/**
 * Build an {@link MppChargeRequest} from direct input. The shape follows
 * `draft-payment-intent-charge-00` §Request Schema: `amount` + `currency` are
 * REQUIRED across every method; `recipient` is REQUIRED for blockchain
 * methods and OPTIONAL for processor methods; `methodDetails` carries
 * method-specific extension data.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` for malformed amount or for missing
 *   recipient on a known blockchain method.
 */
export function toMppChargeRequest(input: ToMppChargeInput): MppChargeRequest {
  if (!isValidAmount(input.amount)) {
    throw new s402Error('INVALID_PAYLOAD',
      `MPP Charge "amount" must be a canonical non-negative integer string, got "${input.amount}"`);
  }
  if (!input.currency || typeof input.currency !== 'string') {
    throw new s402Error('INVALID_PAYLOAD', 'MPP Charge "currency" is required and must be a string');
  }
  const method = normalizeChargeMethod(input.method);
  if (BLOCKCHAIN_CHARGE_METHODS.has(method) && (!input.recipient || typeof input.recipient !== 'string')) {
    throw new s402Error('INVALID_PAYLOAD',
      `MPP method "${method}" is a blockchain method and requires "recipient" — processor methods (stripe, card) route internally and may omit it`);
  }

  const request: MppChargeRequest = {
    amount: input.amount,
    currency: input.currency,
  };
  if (input.recipient) request.recipient = input.recipient;
  if (input.description) request.description = input.description;
  if (input.externalId) request.externalId = input.externalId;
  if (input.methodDetails) request.methodDetails = input.methodDetails;
  return request;
}

/**
 * Build an {@link MppChallenge} ready for `WWW-Authenticate: Payment` emission.
 * The `request` field is JCS-canonicalized (RFC 8785) then base64url-encoded
 * with no padding, matching the read-path's decoding expectation (see
 * {@link decodeMppChargeRequest}).
 *
 * Symmetric to {@link fromMppChargeChallenge} on the read-path:
 *   fromMppChargeChallenge(toMppChargeChallenge(s402)) ≈ s402
 * (for blockchain methods only; processor methods don't roundtrip through s402).
 *
 * The function never computes HMAC digests itself — those require the server's
 * challenge-binding secret, which is intentionally kept outside this library
 * per mpp-specs §Challenge-Binding Secret Management (PR #233). Callers that
 * need challenge-binding MUST compute the digest server-side and pass it via
 * `input.digest`.
 *
 * @throws {s402Error} `INVALID_PAYLOAD` for malformed amount, missing
 *   currency, or missing recipient on a known blockchain method.
 *
 * @example
 * ```ts
 * const challenge = toMppChargeChallenge({
 *   method: 'stripe',
 *   amount: '1000',
 *   currency: 'USD',
 *   methodDetails: { intentId: 'pi_demo_0000000000000000000' },
 *   description: 'Demo payment-gated tool',
 * });
 * // challenge.request is base64url(JCS({amount,currency,...,methodDetails}))
 * ```
 */
export function toMppChargeChallenge(input: ToMppChargeInput): MppChallenge {
  const method = normalizeChargeMethod(input.method);

  const request = toMppChargeRequest(input);
  const requestEncoded = base64urlEncode(canonicalizeToString(request));

  const challenge: MppChallenge = {
    id: input.id ?? mintChallengeId(),
    realm: input.realm ?? 's402',
    method,
    intent: 'charge',
    request: requestEncoded,
  };
  if (input.digest) challenge.digest = input.digest;
  if (input.expires) challenge.expires = input.expires;
  if (input.description) challenge.description = input.description;
  if (input.opaque) challenge.opaque = input.opaque;
  return challenge;
}

/**
 * Generate a unique challenge ID. Prefers `crypto.randomUUID()` (Node 20+,
 * modern browsers) and falls back to a hex string from `crypto.getRandomValues`.
 */
function mintChallengeId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return `s402-${c.randomUUID()}`;
  }
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return `s402-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new s402Error('INVALID_PAYLOAD',
    'No crypto.randomUUID or getRandomValues available; supply input.id explicitly');
}
