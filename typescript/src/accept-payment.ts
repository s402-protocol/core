/**
 * `Accept-Payment` header — content negotiation for HTTP 402 protocols.
 *
 * Modeled on RFC 7231 `Accept` / `Accept-Language` with q-value preference.
 * A client advertises which payment schemes it can produce; the server picks
 * the best scheme both sides support. This lets s402, x402, and MPP
 * ({@link https://machinepayments.org}) coexist on the same endpoint.
 *
 * Grammar (informal):
 * ```
 *   Accept-Payment = 1#( scheme [ OWS ";" OWS "q=" qvalue ] )
 *   scheme         = token         e.g. "s402/prepaid", "tempo/charge"
 *   qvalue         = 0.0 - 1.0     default 1.0, 3-decimal precision
 * ```
 *
 * Entries with `q=0` are explicit rejections — they are retained in parsed
 * output (callers may need to know the client named them) but {@link selectBestScheme}
 * will never pick them.
 *
 * @packageDocumentation
 */

export interface AcceptPaymentEntry {
  /** Scheme token, normalized to lowercase (e.g. "s402/prepaid"). */
  readonly scheme: string;
  /** Quality value 0.0–1.0. Default 1.0 when omitted. */
  readonly q: number;
}

const Q_VALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Parse an `Accept-Payment` header into sorted preference entries.
 *
 * - Entries are returned in descending q-value order; ties preserve input order
 *   (stable sort).
 * - Malformed entries are dropped silently (robustness principle).
 * - Scheme tokens are lowercased. Whitespace around `;` and `,` is tolerated.
 * - Duplicate schemes: the highest-q occurrence wins.
 *
 * @example
 * parseAcceptPayment('s402/prepaid, s402/exact;q=0.8, tempo/charge;q=0.5');
 * // [
 * //   { scheme: 's402/prepaid', q: 1 },
 * //   { scheme: 's402/exact',   q: 0.8 },
 * //   { scheme: 'tempo/charge', q: 0.5 },
 * // ]
 */
export function parseAcceptPayment(header: string | null | undefined): AcceptPaymentEntry[] {
  if (!header) return [];

  const entries: { scheme: string; q: number; order: number }[] = [];
  const seen = new Map<string, number>();

  const segments = header.split(',');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i].trim();
    if (!segment) continue;

    const parts = segment.split(';');
    const scheme = parts[0].trim().toLowerCase();
    if (!isValidSchemeToken(scheme)) continue;

    let q = 1;
    let valid = true;
    for (let j = 1; j < parts.length; j++) {
      const param = parts[j].trim();
      if (!param) continue;
      const eq = param.indexOf('=');
      if (eq === -1) {
        valid = false;
        break;
      }
      const key = param.slice(0, eq).trim().toLowerCase();
      const value = param.slice(eq + 1).trim();
      if (key === 'q') {
        if (!Q_VALUE_PATTERN.test(value)) {
          valid = false;
          break;
        }
        q = Number.parseFloat(value);
      }
    }
    if (!valid) continue;

    const existing = seen.get(scheme);
    if (existing !== undefined) {
      if (entries[existing].q < q) entries[existing] = { scheme, q, order: i };
      continue;
    }
    seen.set(scheme, entries.length);
    entries.push({ scheme, q, order: i });
  }

  entries.sort((a, b) => (b.q - a.q) || (a.order - b.order));
  return entries.map(({ scheme, q }) => ({ scheme, q }));
}

/**
 * Format a list of entries back into an `Accept-Payment` header string.
 *
 * Entries with `q=1` omit the parameter (it's the default). Other q-values
 * are emitted with up to 3 decimals, trailing zeros trimmed.
 *
 * @example
 * formatAcceptPayment([
 *   { scheme: 's402/prepaid', q: 1 },
 *   { scheme: 'tempo/charge', q: 0.5 },
 * ]);
 * // "s402/prepaid, tempo/charge;q=0.5"
 */
export function formatAcceptPayment(entries: readonly AcceptPaymentEntry[]): string {
  return entries
    .filter((e) => isValidSchemeToken(e.scheme) && e.q >= 0 && e.q <= 1)
    .map((e) => (e.q === 1 ? e.scheme : `${e.scheme};q=${formatQ(e.q)}`))
    .join(', ');
}

/**
 * Select the best scheme both sides agree on.
 *
 * - Walks `preferred` in order (parseAcceptPayment returns them sorted by q).
 * - Returns the first scheme that appears in `supported`.
 * - Entries with `q=0` are explicit rejections and are skipped.
 * - Scheme comparison is case-insensitive; the returned string matches the
 *   casing from `supported`.
 * - If `preferred` is empty (no header), falls back to the first entry in
 *   `supported` (server's default).
 * - Returns `null` if no overlap exists.
 */
export function selectBestScheme(
  preferred: readonly AcceptPaymentEntry[],
  supported: readonly string[],
): string | null {
  if (supported.length === 0) return null;

  const supportedLower = new Map<string, string>();
  for (const s of supported) supportedLower.set(s.toLowerCase(), s);

  if (preferred.length === 0) return supported[0];

  for (const entry of preferred) {
    if (entry.q === 0) continue;
    const match = supportedLower.get(entry.scheme);
    if (match) return match;
  }
  return null;
}

function isValidSchemeToken(token: string): boolean {
  if (token.length === 0) return false;
  // RFC 7230 tchar set minus characters that have special meaning in our use:
  // we allow alphanumerics, `/`, `-`, `_`, `.`, `+`. Reject anything with
  // whitespace, `;`, `,`, `=`, `"` which would break the header grammar.
  return /^[A-Za-z0-9][A-Za-z0-9/\-_.+]*$/.test(token);
}

function formatQ(q: number): string {
  const fixed = q.toFixed(3);
  return fixed.replace(/\.?0+$/, '') || '0';
}
