/**
 * s402 canonicalization — RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * JCS produces a deterministic byte sequence from a JSON value. Two parsers
 * that honor JCS produce identical bytes for semantically equal JSON, enabling
 * content-hashing and cross-language interop.
 *
 * Full spec: see `spec/canonicalization.md` (project-local, normative).
 * Summary applied here:
 *   - Object keys sorted by UTF-16 code unit order (RFC 8785 §3.2.3)
 *   - Numbers rendered per ECMA-404 shortest-roundtrip (RFC 8785 §3.2.2)
 *   - Strings escape only the minimum required (RFC 8785 §3.2.1)
 *   - Arrays preserve order
 *   - No whitespace
 *   - Reject non-finite numbers, BigInt, undefined, functions, symbols
 *
 * This module implements JCS *serialization* only. Strict parsing with
 * duplicate-key rejection is deferred to a later PR — envelope txBinding
 * verification never parses untrusted canonical JSON, so dup-key handling is
 * not on this critical path. (Client recomputes from its own objects.)
 */

import { s402Error } from './errors.js';

/**
 * JCS value type — mirrors JSON's data model.
 * `unknown` arrays/objects are fine; we'll type-check at serialize time.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Serialize a JSON value to RFC 8785 canonical form.
 *
 * Returns a UTF-8 byte string (represented as `Uint8Array`). Callers hash the
 * bytes directly; do NOT re-encode via `TextEncoder` (double-encoding risk).
 *
 * @throws {s402Error} INVALID_PAYLOAD on non-JSON-safe values (NaN, Infinity,
 *                    bigint, undefined, functions, symbols, circular refs).
 */
export function canonicalize(value: unknown): Uint8Array {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  writeValue(value, out, seen);
  return new TextEncoder().encode(out.join(''));
}

/**
 * Convenience: canonicalize to a UTF-8 string.
 *
 * Use only when a downstream API demands a string; prefer the Uint8Array form
 * for digest inputs to avoid an extra encode/decode round-trip.
 */
export function canonicalizeToString(value: unknown): string {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  writeValue(value, out, seen);
  return out.join('');
}

function writeValue(v: unknown, out: string[], seen: WeakSet<object>): void {
  if (v === null) {
    out.push('null');
    return;
  }
  const t = typeof v;
  if (t === 'boolean') {
    out.push(v ? 'true' : 'false');
    return;
  }
  if (t === 'number') {
    writeNumber(v as number, out);
    return;
  }
  if (t === 'string') {
    writeString(v as string, out);
    return;
  }
  if (t === 'bigint') {
    throw new s402Error('INVALID_PAYLOAD',
      'Canonicalization does not accept bigint — encode monetary amounts as decimal strings');
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol') {
    throw new s402Error('INVALID_PAYLOAD',
      `Canonicalization does not accept ${t}`);
  }
  if (Array.isArray(v)) {
    if (seen.has(v)) {
      throw new s402Error('INVALID_PAYLOAD', 'Canonicalization does not accept cyclic values');
    }
    seen.add(v);
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      writeValue(v[i], out, seen);
    }
    out.push(']');
    seen.delete(v);
    return;
  }
  if (t === 'object') {
    if (seen.has(v as object)) {
      throw new s402Error('INVALID_PAYLOAD', 'Canonicalization does not accept cyclic values');
    }
    seen.add(v as object);
    const obj = v as Record<string, unknown>;
    // RFC 8785 §3.2.3: sort keys by UTF-16 code unit order.
    // JS Array.prototype.sort with no comparator uses lexicographic UTF-16 already.
    const keys = Object.keys(obj).sort();
    out.push('{');
    let first = true;
    for (const k of keys) {
      const val = obj[k];
      // Skip undefined members (RFC 8785 references ECMA-262; undefined is not JSON).
      if (val === undefined) continue;
      if (!first) out.push(',');
      first = false;
      writeString(k, out);
      out.push(':');
      writeValue(val, out, seen);
    }
    out.push('}');
    seen.delete(v as object);
    return;
  }
  throw new s402Error('INVALID_PAYLOAD', `Canonicalization does not accept type ${t}`);
}

function writeNumber(n: number, out: string[]): void {
  if (!Number.isFinite(n)) {
    throw new s402Error('INVALID_PAYLOAD',
      `Canonicalization does not accept non-finite numbers (got ${n})`);
  }
  // RFC 8785 §3.2.2: "0" is the only representation of signed zero.
  if (n === 0) {
    out.push('0');
    return;
  }
  // ECMAScript Number.prototype.toString produces the shortest round-trippable
  // decimal representation, which matches RFC 8785 §3.2.2's "ECMA-404 shortest".
  // Exponents use lowercase 'e' and no '+' — RFC 8785 agrees.
  out.push(n.toString());
}

function writeString(s: string, out: string[]): void {
  out.push('"');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // RFC 8785 §3.2.1 / RFC 8259: escape only control chars, \, and ".
    switch (c) {
      case 0x08: out.push('\\b'); continue;
      case 0x09: out.push('\\t'); continue;
      case 0x0a: out.push('\\n'); continue;
      case 0x0c: out.push('\\f'); continue;
      case 0x0d: out.push('\\r'); continue;
      case 0x22: out.push('\\"'); continue;
      case 0x5c: out.push('\\\\'); continue;
    }
    if (c < 0x20) {
      out.push('\\u', c.toString(16).padStart(4, '0'));
      continue;
    }
    out.push(s[i]);
  }
  out.push('"');
}

