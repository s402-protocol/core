/**
 * s402 ↔ L402 Compatibility Layer — read path
 *
 * Enables s402 clients to consume L402 challenges from Lightning Labs' Aperture
 * (and aperture-derived servers). L402 is the oldest 402 dialect in production —
 * Lightning Labs shipped it in 2020 as LSAT (Lightning Service Auth Token),
 * renamed to L402 in 2022. This module accepts both names on the wire and
 * canonicalizes to `L402` in parsed output.
 *
 * Spec references:
 *   - L402 announcement: https://lightning.engineering/posts/2020-10-14-l402/
 *   - Aperture (reference impl): https://github.com/lightninglabs/aperture
 *   - BOLT-11 (payment encoding): https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
 *   - RFC 9110 auth-params: https://www.rfc-editor.org/rfc/rfc9110#section-11.2
 *
 * Scope (v0.7 DAN-344):
 *   - Parse `WWW-Authenticate: L402` / `WWW-Authenticate: LSAT` challenges
 *   - Decode the BOLT-11 human-readable part (HRP) for amount + network
 *   - Translate to `s402PaymentRequirements` with `scheme: "exact"` and
 *     `network: "lightning:{mainnet|testnet|regtest|signet}"`
 *
 * Not in scope here:
 *   - Macaroon caveat decoding or validation (opaque passthrough in v0.7)
 *   - Preimage verification (server-side, needs Lightning node access)
 *   - Full BOLT-11 tagged-field decoding (node pubkey, routing hints, etc.)
 *   - Write path (emitting L402 challenges from an s402 server)
 *   - BOLT-12 offers (spec still evolving)
 */

import type { s402PaymentRequirements } from '../types.js';
import { s402Error } from '../errors.js';

// ══════════════════════════════════════════════════════════════
// L402 wire types (read-side)
// ══════════════════════════════════════════════════════════════

/**
 * Parsed `WWW-Authenticate: L402` (or legacy `LSAT`) challenge.
 *
 * Per Lightning Labs' spec, an L402 challenge carries exactly two required
 * auth-params: the `macaroon` (opaque bearer token with caveats) and the
 * `invoice` (BOLT-11 payment request). The client pays the invoice via Lightning,
 * receives the preimage, and presents `Authorization: L402 <macaroon>:<preimage>`
 * on the retry.
 */
export interface L402Challenge {
  /** Canonicalized auth-scheme — always `"L402"`, even if the wire said `LSAT`. */
  scheme: 'L402';
  /** Base64-encoded macaroon. Treated as opaque by this module. */
  macaroon: string;
  /** BOLT-11 invoice (bech32 `ln...`). */
  invoice: string;
}

/**
 * Decoded BOLT-11 human-readable part (HRP). Only fields the translator needs.
 *
 * `amountMsat` is `null` for amountless invoices — BOLT-11 allows these, but
 * they are unusual in L402 contexts since Aperture embeds the price in the
 * invoice. Callers translating to s402 typically reject amountless invoices.
 */
export interface Bolt11Summary {
  network: 'lightning:mainnet' | 'lightning:testnet' | 'lightning:regtest' | 'lightning:signet';
  /** Amount in millisatoshi as a non-negative integer string, or `null` if the invoice specifies no amount. */
  amountMsat: string | null;
}

// ══════════════════════════════════════════════════════════════
// Parsing: WWW-Authenticate: L402 / LSAT
// ══════════════════════════════════════════════════════════════

const TOKEN_CHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const L402_SCHEME_PATTERN = /^\s*(L402|LSAT)(?:\s+(.*))?$/i;

/**
 * Parse a `WWW-Authenticate: L402 ...` header into an {@link L402Challenge}.
 *
 * Accepts both `L402` and legacy `LSAT` auth-schemes (case-insensitive) —
 * Aperture in the wild still emits `LSAT` on older deployments. The output
 * scheme is always canonicalized to `"L402"`.
 *
 * Returns `null` if the header is absent/empty or does not start with an L402
 * auth-scheme. Throws `INVALID_PAYLOAD` if the scheme is present but required
 * params (`macaroon`, `invoice`) are missing or malformed.
 *
 * @example
 * ```ts
 * const challenge = parseWwwAuthenticateL402(res.headers.get('WWW-Authenticate'));
 * if (challenge) {
 *   const requirements = fromL402Challenge(challenge);
 *   // requirements.scheme === 'exact', requirements.network === 'lightning:mainnet', ...
 * }
 * ```
 */
export function parseWwwAuthenticateL402(
  header: string | null | undefined,
): L402Challenge | null {
  if (!header) return null;
  const match = L402_SCHEME_PATTERN.exec(header);
  if (!match) return null;
  const paramString = (match[2] ?? '').trim();
  if (paramString.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'L402 challenge missing auth-params');
  }

  const params = parseAuthParams(paramString);
  const macaroon = params.macaroon;
  const invoice = params.invoice;
  if (typeof macaroon !== 'string' || macaroon.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'L402 challenge missing "macaroon" auth-param');
  }
  if (typeof invoice !== 'string' || invoice.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'L402 challenge missing "invoice" auth-param');
  }

  return { scheme: 'L402', macaroon, invoice };
}

/**
 * Parse RFC 9110 §11.2 `auth-params` (`token "=" ( token / quoted-string )`
 * comma-separated). L402 uses the same grammar as MPP; this function mirrors
 * the MPP parser in `compat-mpp` rather than sharing a helper because the two
 * dialects may diverge on edge cases (e.g., L402 invoices have not historically
 * been quoted in Aperture output, whereas MPP params are consistently quoted).
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
      if (value.length === 0) {
        throw new s402Error('INVALID_PAYLOAD', `Empty auth-param value for "${key}" at position ${valueStart}`);
      }
    }

    out[key] = value;
  }

  return out;
}

// ══════════════════════════════════════════════════════════════
// BOLT-11 HRP decoding
// ══════════════════════════════════════════════════════════════

// HRP-only sanity check — does NOT validate the bech32 body (checksum, data
// payload). Real BOLT-11 invoices have a 520-bit signature and tagged fields
// past the `1` separator; Lightning wallets validate those. Ordering in the
// alternation matters: `bcrt` before `bc`, `tbs` before `tb` — the regex picks
// the FIRST match, so longer prefixes must come first to avoid being shadowed.
const HRP_PATTERN = /^ln(bcrt|tbs|bc|tb|sb)(\d+)?([munp])?1[a-z0-9]+$/;

// BOLT-11 network prefixes. Two signet prefixes are recognized:
//   - `tbs` — canonical per current BOLT-11 spec (core-lightning, recent LND)
//   - `sb`  — legacy LND emissions still in the wild
// Both canonicalize to `lightning:signet` in the output.
const NETWORK_BY_PREFIX: Record<string, Bolt11Summary['network']> = {
  bc: 'lightning:mainnet',
  tb: 'lightning:testnet',
  bcrt: 'lightning:regtest',
  tbs: 'lightning:signet',
  sb: 'lightning:signet',
};

/**
 * Decode the BOLT-11 human-readable part of a Lightning invoice into its
 * network and amount components. This is a **partial** decoder — it reads only
 * the HRP (up to the bech32 `1` separator) because full BOLT-11 decoding
 * requires bech32 + tagged-field parsing (~500 LOC) and the translator only
 * needs network + amount.
 *
 * BOLT-11 HRP grammar: `ln{prefix}{amount?}{multiplier?}` where
 *   - prefix ∈ {`bc`, `tb`, `bcrt`, `sb`}  (mainnet/testnet/regtest/signet)
 *   - amount is a decimal integer (BTC units before multiplier)
 *   - multiplier ∈ {`m`, `u`, `n`, `p`}  (milli/micro/nano/pico-BTC)
 *
 * Conversion to millisatoshi (msat = 10^-11 BTC):
 *   - no multiplier: `amount * 10^11` msat
 *   - `m`: `amount * 10^8` msat
 *   - `u`: `amount * 10^5` msat
 *   - `n`: `amount * 10^2` msat
 *   - `p`: `amount / 10` msat  (amount must be multiple of 10)
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the HRP is malformed, the prefix is
 *   unknown, or a pico-BTC amount is not a multiple of 10.
 */
export function decodeBolt11Summary(invoice: string): Bolt11Summary {
  if (typeof invoice !== 'string' || invoice.length === 0) {
    throw new s402Error('INVALID_PAYLOAD', 'BOLT-11 invoice must be a non-empty string');
  }
  const lower = invoice.toLowerCase();
  const match = HRP_PATTERN.exec(lower);
  if (!match) {
    throw new s402Error('INVALID_PAYLOAD',
      `Invoice does not match BOLT-11 HRP grammar (expected "ln(bc|tb|bcrt|sb){amount}{m|u|n|p}1..."): "${invoice}"`);
  }
  const prefix = match[1];
  const amountPart = match[2];
  const multiplier = match[3];

  const network = NETWORK_BY_PREFIX[prefix];
  if (!network) {
    throw new s402Error('INVALID_PAYLOAD', `Unknown BOLT-11 network prefix: "${prefix}"`);
  }

  if (amountPart === undefined) {
    if (multiplier !== undefined) {
      throw new s402Error('INVALID_PAYLOAD', 'BOLT-11 multiplier without amount');
    }
    return { network, amountMsat: null };
  }

  const amount = BigInt(amountPart);
  let amountMsat: bigint;
  switch (multiplier) {
    case undefined:
      amountMsat = amount * 100_000_000_000n;
      break;
    case 'm':
      amountMsat = amount * 100_000_000n;
      break;
    case 'u':
      amountMsat = amount * 100_000n;
      break;
    case 'n':
      amountMsat = amount * 100n;
      break;
    case 'p':
      if (amount % 10n !== 0n) {
        throw new s402Error('INVALID_PAYLOAD',
          `BOLT-11 pico-BTC amount must be a multiple of 10 (got ${amount}) — ` +
          `1 msat is the minimum divisible unit`);
      }
      amountMsat = amount / 10n;
      break;
    default:
      throw new s402Error('INVALID_PAYLOAD', `Unknown BOLT-11 multiplier: "${multiplier}"`);
  }

  return { network, amountMsat: amountMsat.toString() };
}

// ══════════════════════════════════════════════════════════════
// Translation: L402 → s402 requirements
// ══════════════════════════════════════════════════════════════

/**
 * Sentinel payTo for Lightning — the actual payment destination is encoded in
 * the invoice itself (BOLT-11 tagged fields carry node pubkey + payment hash).
 * An s402 client paying an L402 challenge routes through a Lightning wallet
 * that knows how to pay an invoice; the `payTo` field exists only to satisfy
 * the s402 schema.
 */
const LIGHTNING_INVOICE_SENTINEL = 'lightning:invoice';

/**
 * Conservative default expiry window applied to L402-derived requirements.
 *
 * BOLT-11 invoices carry their own expiry as a tagged field (type `x`) past
 * the `1` separator, defaulting to 3600 seconds per spec. This partial decoder
 * reads only the HRP, so the real invoice expiry is not surfaced. To keep
 * S1 (stale payment rejection) load-bearing for L402-derived requirements,
 * we stamp a conservative 60s window: an s402 client that caches requirements
 * longer than 60s must re-fetch the 402 response rather than reusing stale
 * ones against a possibly-expired invoice.
 *
 * Tradeoff: a long-lived invoice (e.g., Aperture's default 1-hour expiry) is
 * rejected by s402 after 60s even though the invoice is still payable. The
 * re-fetch cost is one extra round-trip, not a payment failure.
 *
 * A future v0.8 full BOLT-11 decoder can read the `x` tag and use the real
 * expiry. Until then, 60s is the safe floor.
 */
const L402_DEFAULT_EXPIRY_WINDOW_MS = 60_000;

/**
 * Translate an L402 challenge into s402 payment requirements using the `exact`
 * scheme.
 *
 * The resulting requirements are consumable by a Lightning-aware s402 client.
 * The `payTo` field is a sentinel (`"lightning:invoice"`) rather than a node
 * pubkey because the true destination is inside the BOLT-11 invoice — which
 * Lightning wallets decode themselves. The invoice and macaroon are surfaced
 * under `extensions.l402` so the client can present them back on the retry
 * (`Authorization: L402 <macaroon>:<preimage>`).
 *
 * @throws {s402Error} `INVALID_PAYLOAD` if the invoice HRP is malformed or the
 *   invoice is amountless (L402 challenges always specify a price in the
 *   invoice; an amountless invoice is a spec violation).
 */
export function fromL402Challenge(challenge: L402Challenge): s402PaymentRequirements {
  const summary = decodeBolt11Summary(challenge.invoice);
  if (summary.amountMsat === null) {
    throw new s402Error('INVALID_PAYLOAD',
      'L402 invoice is amountless — L402 challenges must specify an exact price via the BOLT-11 amount');
  }

  return {
    scheme: 'exact',
    network: summary.network,
    asset: 'lightning:msat',
    amount: summary.amountMsat,
    payTo: LIGHTNING_INVOICE_SENTINEL,
    // Conservative expiry keeps S1 (stale payment rejection) honest for
    // L402-derived requirements — see L402_DEFAULT_EXPIRY_WINDOW_MS doc.
    expiresAt: Date.now() + L402_DEFAULT_EXPIRY_WINDOW_MS,
    extensions: {
      l402: {
        macaroon: challenge.macaroon,
        invoice: challenge.invoice,
      },
    },
  };
}
