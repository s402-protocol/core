/**
 * MC/DC (Modified Condition/Decision Coverage) tests for validateRequirementsShape()
 *
 * DO-178B Level A methodology: For N boolean conditions in a decision,
 * N+1 tests minimum. Each condition independently proven to affect the outcome.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONDITION MAP — validateRequirementsShape() (http.ts)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The argument is the WIRE ENVELOPE — an x402 V2 `PaymentRequired`, not the
 * flat s402 v1 record (ADR-016). Every per-requirement condition below moved
 * one level down into `accepts[i]`, and every s402-only one moved down again
 * into `accepts[i].extra`; none of them was relaxed on the way.
 *
 * C1:  obj == null || typeof obj !== 'object'         → "not an object"
 * C2:  record.x402Version === undefined               → "Missing x402Version"
 *      …and record.s402Version present                → "s402 v1 flat requirements shape, retired"
 * C3:  record.x402Version !== 2                       → "Unsupported x402Version"
 * C4:  !Array.isArray(record.accepts)                 → missing "accepts (array of requirement objects)"
 * C5:  typeof entry.network !== 'string'              → missing "network (string)"
 * C6:  typeof entry.asset !== 'string'                → missing "asset (string)"
 * C7:  typeof entry.amount !== 'string'               → missing "amount (string)"
 * C8:  amount is string AND !isValidAmount()           → "invalid amount" (format-only, S7: no magnitude bounds)
 * C9:  typeof entry.payTo !== 'string'                → missing "payTo (string)"
 * C10: entry.payTo.length === 0                       → "payTo must be non-empty"
 * C11: /[\x00-\x1f\x7f]/.test(entry.network)         → "network contains control characters"
 * C12: /[\x00-\x1f\x7f]/.test(entry.asset)           → "asset contains control characters"
 * C13: /[\x00-\x1f\x7f]/.test(entry.payTo)           → "payTo contains control characters"
 * C14: accepts.length === 0                           → "at least one requirement"
 * C15: accepts entry is not an object                 → "accepts[i] is not an object"
 * C16: extra.protocolFeeBps present AND invalid       → rejects (6 sub-conditions)
 * C17: extra.expiresAt present AND invalid            → rejects (4 sub-conditions)
 * C18: extra.protocolFeeAddress present AND not non-empty string → rejects
 * C19: extra.protocolFeeAddress has control chars      → rejects
 * C20: extra.facilitatorUrl present AND not string     → rejects
 * C21: extra.facilitatorUrl has control chars          → rejects
 * C22: extra.facilitatorUrl not valid URL              → rejects
 * C23: extra.facilitatorUrl valid URL but not http/https → rejects
 * C24: extra.settlementMode present AND not 'facilitator'|'direct' → rejects
 * C25: extra.receiptRequired present AND not boolean   → rejects
 * C26-C32: sub-object validators — mandate (at extensions.s402.mandate),
 *          upto/settlementOverrides/prepaid/stream/escrow/unlock (inside extra)
 *
 * ── conditions the envelope added (wire v2) ──
 * C33: record.resource is not a plain object          → "missing resource (object with a url)"
 * C34: typeof record.resource.url !== 'string'        → "resource.url must be a string"
 * C35: entry.scheme not a non-empty string            → missing "scheme (non-empty string)"
 * C36: /[\x00-\x1f\x7f]/.test(entry.scheme)          → "scheme contains control characters"
 * C37: entry.maxTimeoutSeconds present AND invalid    → rejects
 * C38: entry.extra present AND not a plain object     → "extra must be a plain object"
 * C39: extensions / extensions.s402 not a plain object → rejects
 * C40: extensions.s402.version !== '2'                → "Unsupported s402 wire version"
 * ═══════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import {
  decodePaymentRequired,
  decodePaymentPayload,
  decodeSettleResponse,
  encodePaymentRequired,
  s402Error,
  S402_WIRE_VERSION,
  type s402PaymentRequired,
  type s402PaymentRequirements,
} from '../src/index.js';
import {
  validateRequirementsShape,
  validateMandateShape,
  validateStreamShape,
  validateEscrowShape,
  validateUnlockShape,
  validatePrepaidShape,
} from '../src/http.js';

// ══════════════════════════════════════════════════════════════
// Fixtures
// ══════════════════════════════════════════════════════════════

const VALID_PAY_TO = '0x' + 'a'.repeat(64);
const RESOURCE_URL = 'https://api.example.com/paid';

/**
 * Minimal valid requirements, written FLAT — all conditions TRUE (happy path).
 *
 * Flat is the memory shape, not the wire shape: `valid()` routes each key to
 * wherever wire v2 actually carries it, so a test that flips one field still
 * reads as one field.
 */
const VALID: Record<string, unknown> = {
  scheme: 'exact',
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000000',
  payTo: VALID_PAY_TO,
};

/** Full valid requirements — all optional fields present and valid. */
const VALID_FULL: Record<string, unknown> = {
  ...VALID,
  facilitatorUrl: 'https://facilitator.example.com',
  protocolFeeBps: 50,
  protocolFeeAddress: '0x' + 'b'.repeat(64),
  expiresAt: Date.now() + 60_000,
  receiptRequired: true,
  settlementMode: 'facilitator',
  extensions: { custom: 'data' },
};

/** The six keys x402 owns on one `accepts[]` entry. Everything else is s402's. */
const ENTRY_KEYS = new Set(['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds']);

/** Keys that belong to the envelope itself, above the `accepts[]` list. */
const ENVELOPE_KEYS = new Set(['x402Version', 'resource', 'accepts', 'extensions', 'error']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build the wire envelope a flat override describes.
 *
 * Routing, and it is the whole of wire v2 in six lines: the six x402 keys stay
 * on `accepts[0]`; `mandate` goes to `extensions.s402.mandate`; envelope keys
 * stay at envelope level; everything else is an s402 field and drops into
 * `accepts[0].extra`.
 */
function wireFrom(fields: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  const envelope: Record<string, unknown> = { x402Version: 2, resource: { url: RESOURCE_URL } };
  const s402Ext: Record<string, unknown> = { version: S402_WIRE_VERSION };

  for (const [key, value] of Object.entries(fields)) {
    if (ENTRY_KEYS.has(key)) entry[key] = value;
    else if (key === 'mandate') s402Ext.mandate = value;
    else if (ENVELOPE_KEYS.has(key)) envelope[key] = value;
    else extra[key] = value;
  }

  if (Object.keys(extra).length > 0) entry.extra = extra;
  if (!('accepts' in envelope)) envelope.accepts = [entry];
  if (envelope.extensions === undefined) envelope.extensions = { s402: s402Ext };
  else if (isPlainObject(envelope.extensions)) envelope.extensions = { ...envelope.extensions, s402: s402Ext };
  return envelope;
}

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return wireFrom({ ...VALID, ...overrides });
}

function validFull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return wireFrom({ ...VALID_FULL, ...overrides });
}

/** The same fixture as an in-memory 402 document, for the encode → decode paths. */
function doc(overrides: Partial<s402PaymentRequirements> = {}, envelope: Partial<s402PaymentRequired> = {}): s402PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [{ ...(VALID as unknown as s402PaymentRequirements), ...overrides }],
    ...envelope,
  };
}

// ══════════════════════════════════════════════════════════════
// MC/DC: Happy Paths
// ══════════════════════════════════════════════════════════════

describe('mcdc: validateRequirementsShape — happy paths', () => {
  it('mcdc-hp: minimal valid requirements passes', () => {
    expect(() => validateRequirementsShape(valid())).not.toThrow();
  });

  it('mcdc-hp: full valid requirements with all optional fields passes', () => {
    expect(() => validateRequirementsShape(validFull())).not.toThrow();
  });

  it('mcdc-hp: one accepts[] entry per offered scheme passes', () => {
    // Wire v2: offering six schemes is six entries, not one entry listing six
    // names. `exact` first, because an x402 client pays the first entry it can.
    const schemes = ['exact', 'upto', 'prepaid', 'stream', 'escrow', 'unlock'];
    expect(() => validateRequirementsShape(valid({
      accepts: schemes.map((scheme) => ({ ...VALID, scheme })),
    }))).not.toThrow();
  });

  it('mcdc-hp: unknown scheme names pass (forward compat — a menu may list a dish we do not order)', () => {
    expect(() => validateRequirementsShape(valid({
      accepts: [{ ...VALID }, { ...VALID, scheme: 'futureScheme2030' }],
    }))).not.toThrow();
  });

  it('mcdc-hp: an entry carrying unknown `extra` keys passes (x402 owns that bag)', () => {
    expect(() => validateRequirementsShape(valid({
      accepts: [{ ...VALID, extra: { paymentFlow: 'authorize-capture', name: 'USDC' } }],
    }))).not.toThrow();
  });

  it('mcdc-hp: a plain x402 402 with no extensions.s402 passes', () => {
    // The s402 profile marker is optional on intake — a plain x402 V2 402 is
    // still a readable, payable 402.
    const plain = valid();
    delete (plain as Record<string, unknown>).extensions;
    expect(() => validateRequirementsShape(plain)).not.toThrow();
  });

  it('mcdc-hp: settlementMode "direct" passes', () => {
    expect(() => validateRequirementsShape(valid({ settlementMode: 'direct' }))).not.toThrow();
  });

  it('mcdc-hp: settlementMode "facilitator" passes', () => {
    expect(() => validateRequirementsShape(valid({ settlementMode: 'facilitator' }))).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: Isolation Tests — each flips exactly ONE condition
// ══════════════════════════════════════════════════════════════

describe('mcdc: validateRequirementsShape — isolation tests', () => {
  // C1: obj == null || typeof obj !== 'object'
  it('mcdc-mc1a: rejects null', () => {
    expect(() => validateRequirementsShape(null)).toThrow(s402Error);
    expect(() => validateRequirementsShape(null)).toThrow('not an object');
  });

  it('mcdc-mc1b: rejects undefined', () => {
    expect(() => validateRequirementsShape(undefined)).toThrow(s402Error);
    expect(() => validateRequirementsShape(undefined)).toThrow('not an object');
  });

  it('mcdc-mc1c: rejects string', () => {
    expect(() => validateRequirementsShape('hello')).toThrow('not an object');
  });

  it('mcdc-mc1d: rejects number', () => {
    expect(() => validateRequirementsShape(42)).toThrow('not an object');
  });

  it('mcdc-mc1e: rejects boolean', () => {
    expect(() => validateRequirementsShape(true)).toThrow('not an object');
  });

  // Note: Array IS an object in JS but passes typeof check. However, it won't
  // have x402Version, so it fails at C2. This is tested implicitly.

  // C2: x402Version === undefined
  it('mcdc-mc2: rejects missing x402Version', () => {
    const { x402Version: _, ...rest } = valid();
    expect(() => validateRequirementsShape(rest)).toThrow('Missing x402Version');
  });

  it('mcdc-mc2b: rejects the retired s402 v1 flat shape by name', () => {
    // The abolished shape, verbatim: a version field on the 402 itself and
    // `accepts` as a list of scheme-name strings. It must be REFUSED, with a
    // message that names where to read it instead — not half-parsed.
    const v1Flat = {
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000000000',
      payTo: VALID_PAY_TO,
    };
    expect(() => validateRequirementsShape(v1Flat)).toThrow('retired in wire v2');
    expect(() => validateRequirementsShape(v1Flat)).toThrow('fromS402V1Requirements');
  });

  // C3: x402Version !== 2
  it('mcdc-mc3a: rejects x402Version 1 (the x402 V1 flat shape)', () => {
    expect(() => validateRequirementsShape(valid({ x402Version: 1 }))).toThrow('Unsupported x402Version');
  });

  it('mcdc-mc3b: rejects x402Version 3', () => {
    expect(() => validateRequirementsShape(valid({ x402Version: 3 }))).toThrow('Unsupported x402Version');
  });

  it('mcdc-mc3c: rejects string x402Version "2" (must be the number 2)', () => {
    expect(() => validateRequirementsShape(valid({ x402Version: '2' }))).toThrow('Unsupported x402Version');
  });

  // C4: !Array.isArray(accepts)
  it('mcdc-mc4: rejects non-array accepts', () => {
    expect(() => validateRequirementsShape(valid({ accepts: 'exact' }))).toThrow('Malformed payment requirements');
    expect(() => validateRequirementsShape(valid({ accepts: 'exact' }))).toThrow('accepts');
  });

  // C5: typeof network !== 'string'
  it('mcdc-mc5: rejects non-string network', () => {
    expect(() => validateRequirementsShape(valid({ network: 42 }))).toThrow('network');
  });

  // C6: typeof asset !== 'string'
  it('mcdc-mc6: rejects non-string asset', () => {
    expect(() => validateRequirementsShape(valid({ asset: true }))).toThrow('asset');
  });

  // C7: typeof amount !== 'string'
  it('mcdc-mc7: rejects non-string amount', () => {
    expect(() => validateRequirementsShape(valid({ amount: 1000 }))).toThrow('amount');
  });

  // C8: amount is string AND !isValidAmount() — format-only check (S7: no chain-specific magnitude bounds)
  it('mcdc-mc8a: rejects non-numeric amount string', () => {
    expect(() => validateRequirementsShape(valid({ amount: 'abc' }))).toThrow('invalid amount');
  });

  it('mcdc-mc8b: rejects negative amount', () => {
    expect(() => validateRequirementsShape(valid({ amount: '-1' }))).toThrow('invalid amount');
  });

  it('mcdc-mc8c: rejects leading zeros', () => {
    expect(() => validateRequirementsShape(valid({ amount: '007' }))).toThrow('invalid amount');
  });

  it('mcdc-mc8d: rejects decimal amount', () => {
    expect(() => validateRequirementsShape(valid({ amount: '1.5' }))).toThrow('invalid amount');
  });

  it('mcdc-mc8e: accepts amount exceeding u64 max — S7: magnitude bounds belong in chain adapters', () => {
    // Wire format validates format only (non-negative integer string).
    // Chain-specific magnitude checks (u64 for Sui, u256 for EVM) belong in @sweefi/sui etc.
    expect(() => validateRequirementsShape(valid({ amount: '18446744073709551616' }))).not.toThrow();
  });

  // C9: typeof payTo !== 'string'
  it('mcdc-mc9: rejects non-string payTo', () => {
    expect(() => validateRequirementsShape(valid({ payTo: 123 }))).toThrow('payTo');
  });

  // C10: payTo.length === 0
  it('mcdc-mc10: rejects empty payTo', () => {
    expect(() => validateRequirementsShape(valid({ payTo: '' }))).toThrow('payTo must be a non-empty string');
  });

  // C11: network contains control characters
  it('mcdc-mc11a: rejects network with null byte', () => {
    expect(() => validateRequirementsShape(valid({ network: 'sui\x00:testnet' }))).toThrow('network contains control characters');
  });

  it('mcdc-mc11b: rejects network with newline', () => {
    expect(() => validateRequirementsShape(valid({ network: 'sui:testnet\n' }))).toThrow('network contains control characters');
  });

  it('mcdc-mc11c: rejects network with carriage return', () => {
    expect(() => validateRequirementsShape(valid({ network: 'sui:testnet\r' }))).toThrow('network contains control characters');
  });

  it('mcdc-mc11d: rejects network with tab', () => {
    expect(() => validateRequirementsShape(valid({ network: 'sui\t:testnet' }))).toThrow('network contains control characters');
  });

  it('mcdc-mc11e: rejects network with DEL (0x7f)', () => {
    expect(() => validateRequirementsShape(valid({ network: 'sui:testnet\x7f' }))).toThrow('network contains control characters');
  });

  // C12: asset contains control characters
  it('mcdc-mc12: rejects asset with control char', () => {
    expect(() => validateRequirementsShape(valid({ asset: '0x2::sui\x00::SUI' }))).toThrow('asset contains control characters');
  });

  // C13: payTo contains control characters
  it('mcdc-mc13: rejects payTo with control char', () => {
    expect(() => validateRequirementsShape(valid({ payTo: '0xabc\x00def' }))).toThrow('payTo contains control characters');
  });

  // C14: accepts.length === 0
  it('mcdc-mc14: rejects empty accepts array', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [] }))).toThrow('at least one requirement');
  });

  // C15: an accepts entry is not a requirement object.
  // Wire v2 inverted this condition: an entry used to have to BE a scheme-name
  // string, and now a bare string is exactly what is refused.
  it('mcdc-mc15a: rejects number in accepts', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [42] }))).toThrow('accepts[0] is not an object');
  });

  it('mcdc-mc15b: rejects null in accepts', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [null] }))).toThrow('accepts[0] is not an object');
  });

  it('mcdc-mc15c: rejects a bare scheme-name string in accepts (the retired v1 idiom)', () => {
    expect(() => validateRequirementsShape(valid({ accepts: ['exact'] }))).toThrow('accepts[0] is not an object');
  });

  it('mcdc-mc15d: rejects mixed valid/invalid in accepts, naming the bad index', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [{ ...VALID }, 42] }))).toThrow('accepts[1] is not an object');
  });

  it('mcdc-mc15e: rejects an accepts entry missing scheme', () => {
    const { scheme: _, ...noScheme } = VALID;
    expect(() => validateRequirementsShape(valid({ accepts: [noScheme] }))).toThrow('missing scheme (non-empty string)');
  });

  // C16: protocolFeeBps validation sub-conditions
  it('mcdc-mc16a: rejects protocolFeeBps as string', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: '50' }))).toThrow('protocolFeeBps');
  });

  it('mcdc-mc16b: rejects protocolFeeBps as NaN', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: NaN }))).toThrow('protocolFeeBps');
  });

  it('mcdc-mc16c: rejects protocolFeeBps as Infinity', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: Infinity }))).toThrow('protocolFeeBps');
  });

  it('mcdc-mc16d: rejects fractional protocolFeeBps', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: 1.5 }))).toThrow('protocolFeeBps');
  });

  it('mcdc-mc16e: rejects protocolFeeBps > 10000', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: 10001 }))).toThrow('protocolFeeBps');
  });

  it('mcdc-mc16f: rejects negative protocolFeeBps', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: -1 }))).toThrow('protocolFeeBps');
  });

  it('mcdc-mc16g: rejects protocolFeeBps as boolean', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: true }))).toThrow('protocolFeeBps');
  });

  // C17: expiresAt validation sub-conditions
  it('mcdc-mc17a: rejects expiresAt as string', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: 'never' }))).toThrow('expiresAt');
  });

  it('mcdc-mc17b: rejects expiresAt as NaN', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: NaN }))).toThrow('expiresAt');
  });

  it('mcdc-mc17c: rejects expiresAt as Infinity', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: Infinity }))).toThrow('expiresAt');
  });

  it('mcdc-mc17d: rejects expiresAt = 0', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: 0 }))).toThrow('expiresAt');
  });

  it('mcdc-mc17e: rejects expiresAt = -1', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: -1 }))).toThrow('expiresAt');
  });

  it('mcdc-mc17f: rejects expiresAt as -Infinity', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: -Infinity }))).toThrow('expiresAt');
  });

  // C18: protocolFeeAddress validation
  it('mcdc-mc18a: rejects protocolFeeAddress as number', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeAddress: 42 }))).toThrow('protocolFeeAddress');
  });

  it('mcdc-mc18b: rejects protocolFeeAddress as empty string', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeAddress: '' }))).toThrow('protocolFeeAddress');
  });

  it('mcdc-mc18c: rejects protocolFeeAddress as null', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeAddress: null }))).toThrow('protocolFeeAddress');
  });

  // C19: protocolFeeAddress control chars
  it('mcdc-mc19: rejects protocolFeeAddress with control chars', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeAddress: '0xabc\x00def' }))).toThrow('protocolFeeAddress contains control characters');
  });

  // C20: facilitatorUrl not string
  it('mcdc-mc20: rejects facilitatorUrl as number', () => {
    expect(() => validateRequirementsShape(valid({ facilitatorUrl: 42 }))).toThrow('facilitatorUrl must be a string');
  });

  // C21: facilitatorUrl control chars
  it('mcdc-mc21a: rejects facilitatorUrl with null byte', () => {
    expect(() => validateRequirementsShape(valid({ facilitatorUrl: 'https://evil.com\x00' }))).toThrow('control characters');
  });

  it('mcdc-mc21b: rejects facilitatorUrl with CRLF (header injection)', () => {
    expect(() => validateRequirementsShape(valid({ facilitatorUrl: 'https://evil.com\r\nX-Injected: true' }))).toThrow('control characters');
  });

  // C22: facilitatorUrl not a valid URL
  it('mcdc-mc22: rejects facilitatorUrl that is not a valid URL', () => {
    expect(() => validateRequirementsShape(valid({ facilitatorUrl: 'not a url' }))).toThrow('not a valid URL');
  });

  // C23: facilitatorUrl uses non-http(s) protocol (SSRF — M-1)
  it('mcdc-mc23a: rejects facilitatorUrl with file:// (SSRF)', () => {
    expect(() => validateRequirementsShape(valid({ facilitatorUrl: 'file:///etc/passwd' }))).toThrow('https:// or http://');
  });

  it('mcdc-mc23b: rejects facilitatorUrl with ftp://', () => {
    expect(() => validateRequirementsShape(valid({ facilitatorUrl: 'ftp://files.example.com/data' }))).toThrow('https:// or http://');
  });

  it('mcdc-mc23c: rejects facilitatorUrl with gopher://', () => {
    expect(() => validateRequirementsShape(valid({ facilitatorUrl: 'gopher://evil.com' }))).toThrow('https:// or http://');
  });

  it('mcdc-mc23d: rejects facilitatorUrl with javascript:', () => {
    expect(() => validateRequirementsShape(valid({ facilitatorUrl: 'javascript:alert(1)' }))).toThrow('https:// or http://');
  });

  // C24: settlementMode not 'facilitator' or 'direct'
  it('mcdc-mc24a: rejects settlementMode "instant"', () => {
    expect(() => validateRequirementsShape(valid({ settlementMode: 'instant' }))).toThrow('settlementMode');
  });

  it('mcdc-mc24b: rejects settlementMode as number', () => {
    expect(() => validateRequirementsShape(valid({ settlementMode: 1 }))).toThrow('settlementMode');
  });

  it('mcdc-mc24c: rejects settlementMode as boolean', () => {
    expect(() => validateRequirementsShape(valid({ settlementMode: true }))).toThrow('settlementMode');
  });

  // C25: receiptRequired not boolean
  it('mcdc-mc25a: rejects receiptRequired as string', () => {
    expect(() => validateRequirementsShape(valid({ receiptRequired: 'true' }))).toThrow('receiptRequired must be a boolean');
  });

  it('mcdc-mc25b: rejects receiptRequired as number', () => {
    expect(() => validateRequirementsShape(valid({ receiptRequired: 1 }))).toThrow('receiptRequired must be a boolean');
  });

  // ── conditions the envelope added (wire v2) ──

  // C33: resource is not a plain object
  it('mcdc-mc33a: rejects missing resource', () => {
    const { resource: _, ...rest } = valid();
    expect(() => validateRequirementsShape(rest)).toThrow('missing resource (object with a url)');
  });

  it('mcdc-mc33b: rejects array resource', () => {
    expect(() => validateRequirementsShape(valid({ resource: [] }))).toThrow('missing resource (object with a url)');
  });

  // C34: resource.url is not a string
  it('mcdc-mc34a: rejects missing resource.url', () => {
    expect(() => validateRequirementsShape(valid({ resource: {} }))).toThrow('resource.url must be a string');
  });

  it('mcdc-mc34b: rejects non-string resource.url', () => {
    expect(() => validateRequirementsShape(valid({ resource: { url: 42 } }))).toThrow('resource.url must be a string');
  });

  // C35: scheme is not a non-empty string
  it('mcdc-mc35a: rejects non-string scheme', () => {
    expect(() => validateRequirementsShape(valid({ scheme: 42 }))).toThrow('missing scheme (non-empty string)');
  });

  it('mcdc-mc35b: rejects empty scheme', () => {
    expect(() => validateRequirementsShape(valid({ scheme: '' }))).toThrow('missing scheme (non-empty string)');
  });

  // C36: scheme contains control characters
  it('mcdc-mc36: rejects scheme with control char', () => {
    expect(() => validateRequirementsShape(valid({ scheme: 'exa\x00ct' }))).toThrow('scheme contains control characters');
  });

  // C37: maxTimeoutSeconds present AND invalid
  it('mcdc-mc37a: rejects non-numeric maxTimeoutSeconds', () => {
    expect(() => validateRequirementsShape(valid({ maxTimeoutSeconds: '60' }))).toThrow('maxTimeoutSeconds must be a non-negative finite number');
  });

  it('mcdc-mc37b: rejects negative maxTimeoutSeconds', () => {
    expect(() => validateRequirementsShape(valid({ maxTimeoutSeconds: -1 }))).toThrow('maxTimeoutSeconds must be a non-negative finite number');
  });

  it('mcdc-mc37c: rejects Infinity maxTimeoutSeconds', () => {
    expect(() => validateRequirementsShape(valid({ maxTimeoutSeconds: Infinity }))).toThrow('maxTimeoutSeconds must be a non-negative finite number');
  });

  it('mcdc-mc37d: accepts maxTimeoutSeconds = 0 (lower bound)', () => {
    expect(() => validateRequirementsShape(valid({ maxTimeoutSeconds: 0 }))).not.toThrow();
  });

  // C38: entry.extra present AND not a plain object
  it('mcdc-mc38a: rejects string extra', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [{ ...VALID, extra: 'nope' }] }))).toThrow('extra must be a plain object');
  });

  it('mcdc-mc38b: rejects array extra', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [{ ...VALID, extra: [] }] }))).toThrow('extra must be a plain object');
  });

  // C39: extensions / extensions.s402 must be plain objects
  it('mcdc-mc39a: rejects non-object envelope extensions', () => {
    expect(() => validateRequirementsShape({ ...valid(), extensions: 'nope' })).toThrow('extensions must be a plain object');
  });

  it('mcdc-mc39b: rejects non-object extensions.s402', () => {
    expect(() => validateRequirementsShape({ ...valid(), extensions: { s402: 'nope' } })).toThrow('extensions.s402 must be a plain object');
  });

  // C40: extensions.s402.version is a version this build does not implement
  it('mcdc-mc40a: rejects s402 wire version "1"', () => {
    expect(() => validateRequirementsShape({ ...valid(), extensions: { s402: { version: '1' } } })).toThrow('Unsupported s402 wire version');
  });

  it('mcdc-mc40b: rejects s402 wire version "3"', () => {
    expect(() => validateRequirementsShape({ ...valid(), extensions: { s402: { version: '3' } } })).toThrow('Unsupported s402 wire version');
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: Sub-Object Validators
// ══════════════════════════════════════════════════════════════

describe('mcdc: validateMandateShape — isolation tests', () => {
  it('mcdc-hp: valid mandate passes', () => {
    expect(() => validateMandateShape({ required: true })).not.toThrow();
  });

  it('mcdc-hp: valid mandate with optional fields passes', () => {
    expect(() => validateMandateShape({ required: false, minPerTx: '500', coinType: '0x2::sui::SUI' })).not.toThrow();
  });

  it('mcdc-mc1: rejects null mandate', () => {
    expect(() => validateMandateShape(null)).toThrow('must be a plain object');
  });

  it('mcdc-mc2: rejects array mandate', () => {
    expect(() => validateMandateShape([true])).toThrow('must be a plain object');
  });

  it('mcdc-mc3: rejects non-boolean required', () => {
    expect(() => validateMandateShape({ required: 'yes' })).toThrow('required must be a boolean');
  });

  it('mcdc-mc4: rejects non-string minPerTx', () => {
    expect(() => validateMandateShape({ required: true, minPerTx: 500 })).toThrow('minPerTx must be a string');
  });

  it('mcdc-mc5: rejects non-string coinType', () => {
    expect(() => validateMandateShape({ required: true, coinType: 42 })).toThrow('coinType must be a string');
  });
});

describe('mcdc: validateStreamShape — isolation tests', () => {
  const VALID_STREAM = { ratePerSecond: '100', budgetCap: '10000', minDeposit: '1000' };

  it('mcdc-hp: valid stream passes', () => {
    expect(() => validateStreamShape(VALID_STREAM)).not.toThrow();
  });

  it('mcdc-hp: valid stream with optional streamSetupUrl passes', () => {
    expect(() => validateStreamShape({ ...VALID_STREAM, streamSetupUrl: 'https://setup.example.com' })).not.toThrow();
  });

  it('mcdc-mc1: rejects null stream', () => {
    expect(() => validateStreamShape(null)).toThrow('must be a plain object');
  });

  it('mcdc-mc2: rejects non-string ratePerSecond', () => {
    expect(() => validateStreamShape({ ...VALID_STREAM, ratePerSecond: 100 })).toThrow('ratePerSecond must be a string');
  });

  it('mcdc-mc3: rejects invalid ratePerSecond format', () => {
    expect(() => validateStreamShape({ ...VALID_STREAM, ratePerSecond: 'abc' })).toThrow('ratePerSecond must be a non-negative integer');
  });

  it('mcdc-mc4: rejects non-string budgetCap', () => {
    expect(() => validateStreamShape({ ...VALID_STREAM, budgetCap: 10000 })).toThrow('budgetCap must be a string');
  });

  it('mcdc-mc5: rejects invalid budgetCap format', () => {
    expect(() => validateStreamShape({ ...VALID_STREAM, budgetCap: '-1' })).toThrow('budgetCap must be a non-negative integer');
  });

  it('mcdc-mc6: rejects non-string minDeposit', () => {
    expect(() => validateStreamShape({ ...VALID_STREAM, minDeposit: true })).toThrow('minDeposit must be a string');
  });

  it('mcdc-mc7: rejects invalid minDeposit format', () => {
    expect(() => validateStreamShape({ ...VALID_STREAM, minDeposit: '007' })).toThrow('minDeposit must be a non-negative integer');
  });

  it('mcdc-mc8: rejects non-string streamSetupUrl', () => {
    expect(() => validateStreamShape({ ...VALID_STREAM, streamSetupUrl: 42 })).toThrow('streamSetupUrl must be a string');
  });
});

describe('mcdc: validateEscrowShape — isolation tests', () => {
  const VALID_ESCROW = { seller: '0xseller', deadlineMs: '1700000000000' };

  it('mcdc-hp: valid escrow passes', () => {
    expect(() => validateEscrowShape(VALID_ESCROW)).not.toThrow();
  });

  it('mcdc-hp: valid escrow with arbiter passes', () => {
    expect(() => validateEscrowShape({ ...VALID_ESCROW, arbiter: '0xarbiter' })).not.toThrow();
  });

  it('mcdc-mc1: rejects null escrow', () => {
    expect(() => validateEscrowShape(null)).toThrow('must be a plain object');
  });

  it('mcdc-mc2: rejects non-string seller', () => {
    expect(() => validateEscrowShape({ ...VALID_ESCROW, seller: 42 })).toThrow('seller must be a string');
  });

  it('mcdc-mc3: rejects non-string deadlineMs', () => {
    expect(() => validateEscrowShape({ ...VALID_ESCROW, deadlineMs: 1700000000000 })).toThrow('deadlineMs must be a string');
  });

  it('mcdc-mc4: rejects invalid deadlineMs format', () => {
    expect(() => validateEscrowShape({ ...VALID_ESCROW, deadlineMs: '-1' })).toThrow('deadlineMs must be a non-negative integer');
  });

  it('mcdc-mc5: rejects non-string arbiter', () => {
    expect(() => validateEscrowShape({ ...VALID_ESCROW, arbiter: true })).toThrow('arbiter must be a string');
  });
});

describe('mcdc: validateUnlockShape — isolation tests', () => {
  const VALID_UNLOCK = {
    packageId: '0xpkg',
    keyServers: [{ objectId: '0xks1', weight: 1 }],
    threshold: 1,
  };

  it('mcdc-hp: valid unlock passes', () => {
    expect(() => validateUnlockShape(VALID_UNLOCK)).not.toThrow();
  });

  it('mcdc-hp: valid unlock with optional contentDigest passes', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, contentDigest: 'sha256-abc' })).not.toThrow();
  });

  it('mcdc-mc1: rejects null unlock', () => {
    expect(() => validateUnlockShape(null)).toThrow('must be a plain object');
  });

  it('mcdc-mc2: rejects non-string packageId', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, packageId: 42 })).toThrow('packageId must be a string');
  });

  it('mcdc-mc3: rejects non-integer threshold', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, threshold: 0 })).toThrow('threshold must be a positive integer');
  });

  it('mcdc-mc4: rejects empty keyServers', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, keyServers: [] })).toThrow('keyServers must be a non-empty array');
  });

  it('mcdc-mc4b: rejects keyServer without string objectId', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, keyServers: [{ objectId: 1, weight: 1 }] })).toThrow('objectId must be a string');
  });

  it('mcdc-mc4c: rejects keyServer with non-numeric weight', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, keyServers: [{ objectId: '0xks1', weight: 'x' }] })).toThrow('weight must be a number');
  });

  it('mcdc-mc4d: rejects non-string contentDigest', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, contentDigest: 5 })).toThrow('contentDigest must be a string');
  });
});

describe('mcdc: validatePrepaidShape — isolation tests', () => {
  const VALID_PREPAID = { ratePerCall: '100', minDeposit: '1000', withdrawalDelayMs: '300000' };

  it('mcdc-hp: valid prepaid (v0.1 — no providerPubkey/disputeWindowMs) passes', () => {
    expect(() => validatePrepaidShape(VALID_PREPAID)).not.toThrow();
  });

  it('mcdc-hp: valid prepaid (v0.2 — both providerPubkey and disputeWindowMs) passes', () => {
    expect(() => validatePrepaidShape({
      ...VALID_PREPAID,
      providerPubkey: '0xpub',
      disputeWindowMs: '86400000',
    })).not.toThrow();
  });

  it('mcdc-mc1: rejects null prepaid', () => {
    expect(() => validatePrepaidShape(null)).toThrow('must be a plain object');
  });

  it('mcdc-mc2: rejects non-string ratePerCall', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, ratePerCall: 100 })).toThrow('ratePerCall must be a string');
  });

  it('mcdc-mc3: rejects invalid ratePerCall format', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, ratePerCall: '-5' })).toThrow('ratePerCall must be a non-negative integer');
  });

  it('mcdc-mc4: rejects non-string minDeposit', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, minDeposit: true })).toThrow('minDeposit must be a string');
  });

  it('mcdc-mc5: rejects invalid minDeposit format', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, minDeposit: '007' })).toThrow('minDeposit must be a non-negative integer');
  });

  it('mcdc-mc6: rejects non-string withdrawalDelayMs', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, withdrawalDelayMs: 300000 })).toThrow('withdrawalDelayMs must be a string');
  });

  it('mcdc-mc7: rejects invalid withdrawalDelayMs format', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, withdrawalDelayMs: 'abc' })).toThrow('withdrawalDelayMs must be a non-negative integer');
  });

  it('mcdc-mc8: rejects non-string maxCalls', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, maxCalls: 42 })).toThrow('maxCalls must be a string');
  });

  it('mcdc-mc9: rejects providerPubkey without disputeWindowMs (pairing invariant)', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, providerPubkey: '0xpub' })).toThrow('both be present');
  });

  it('mcdc-mc10: rejects disputeWindowMs without providerPubkey (pairing invariant)', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, disputeWindowMs: '86400000' })).toThrow('both be present');
  });

  // BVA for withdrawalDelayMs bounds: 60,000ms (1 min) to 604,800,000ms (7 days)
  it('mcdc-bva1: withdrawalDelayMs at exact lower bound (60000) passes', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, withdrawalDelayMs: '60000' })).not.toThrow();
  });

  it('mcdc-bva2: withdrawalDelayMs below lower bound (59999) rejects', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, withdrawalDelayMs: '59999' })).toThrow('between 60000');
  });

  it('mcdc-bva3: withdrawalDelayMs at exact upper bound (604800000) passes', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, withdrawalDelayMs: '604800000' })).not.toThrow();
  });

  it('mcdc-bva4: withdrawalDelayMs above upper bound (604800001) rejects', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, withdrawalDelayMs: '604800001' })).toThrow('between 60000');
  });

  it('mcdc-bva5: withdrawalDelayMs = "0" (below range) rejects', () => {
    expect(() => validatePrepaidShape({ ...VALID_PREPAID, withdrawalDelayMs: '0' })).toThrow('between 60000');
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: Sub-objects integrated with validateRequirementsShape
// ══════════════════════════════════════════════════════════════

describe('mcdc: validateRequirementsShape — sub-object integration', () => {
  it('mcdc-mc26: rejects invalid mandate sub-object', () => {
    expect(() => validateRequirementsShape(valid({ mandate: { required: 'yes' } }))).toThrow('required must be a boolean');
  });

  it('mcdc-mc27: rejects invalid stream sub-object', () => {
    expect(() => validateRequirementsShape(valid({ stream: { ratePerSecond: 100 } }))).toThrow('ratePerSecond must be a string');
  });

  it('mcdc-mc28: rejects invalid escrow sub-object', () => {
    expect(() => validateRequirementsShape(valid({ escrow: 'not an object' }))).toThrow('must be a plain object');
  });

  it('mcdc-mc29: rejects invalid unlock sub-object', () => {
    expect(() => validateRequirementsShape(valid({ unlock: { packageId: 42 } }))).toThrow('packageId must be a string');
  });

  it('mcdc-mc30: rejects invalid prepaid sub-object', () => {
    expect(() => validateRequirementsShape(valid({ prepaid: null }))).toThrow('must be a plain object');
  });

  it('mcdc-mc31: accepts valid mandate sub-object within requirements', () => {
    expect(() => validateRequirementsShape(valid({ mandate: { required: true, minPerTx: '500' } }))).not.toThrow();
  });

  it('mcdc-mc32: accepts valid stream sub-object within requirements', () => {
    expect(() => validateRequirementsShape(valid({
      stream: { ratePerSecond: '100', budgetCap: '10000', minDeposit: '1000' },
    }))).not.toThrow();
  });

  it('mcdc-mc33: accepts valid escrow sub-object within requirements', () => {
    expect(() => validateRequirementsShape(valid({
      escrow: { seller: '0xseller', deadlineMs: '1700000000000' },
    }))).not.toThrow();
  });

  it('mcdc-mc34: accepts valid unlock sub-object within requirements', () => {
    expect(() => validateRequirementsShape(valid({
      unlock: { packageId: '0xpkg', keyServers: [{ objectId: '0xks1', weight: 1 }], threshold: 1 },
    }))).not.toThrow();
  });

  it('mcdc-mc35: accepts valid prepaid sub-object within requirements', () => {
    expect(() => validateRequirementsShape(valid({
      prepaid: { ratePerCall: '100', minDeposit: '1000', withdrawalDelayMs: '300000' },
    }))).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════
// BVA: Boundary Value Analysis for numeric fields
// ══════════════════════════════════════════════════════════════

describe('mcdc-bva: validateRequirementsShape — boundary values', () => {
  // protocolFeeBps: valid range [0, 10000]
  it('bva: protocolFeeBps = 0 (lower bound) passes', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: 0 }))).not.toThrow();
  });

  it('bva: protocolFeeBps = 10000 (upper bound, 100%) passes', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: 10000 }))).not.toThrow();
  });

  it('bva: protocolFeeBps = 10001 (upper bound + 1) rejects', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: 10001 }))).toThrow('protocolFeeBps');
  });

  it('bva: protocolFeeBps = -1 (lower bound - 1) rejects', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: -1 }))).toThrow('protocolFeeBps');
  });

  it('bva: protocolFeeBps = 5000 (midpoint) passes', () => {
    expect(() => validateRequirementsShape(valid({ protocolFeeBps: 5000 }))).not.toThrow();
  });

  // amount: valid range [0, u64 max]
  it('bva: amount = "0" (lower bound) passes', () => {
    expect(() => validateRequirementsShape(valid({ amount: '0' }))).not.toThrow();
  });

  it('bva: amount = "18446744073709551615" (u64 max) passes', () => {
    expect(() => validateRequirementsShape(valid({ amount: '18446744073709551615' }))).not.toThrow();
  });

  it('bva: amount = "18446744073709551616" (u64 max + 1) passes — S7: wire format is chain-agnostic', () => {
    // u64 bounds checking belongs in chain adapters (@sweefi/sui), not in the protocol wire validator.
    expect(() => validateRequirementsShape(valid({ amount: '18446744073709551616' }))).not.toThrow();
  });

  it('bva: amount = "1" (just above lower bound) passes', () => {
    expect(() => validateRequirementsShape(valid({ amount: '1' }))).not.toThrow();
  });

  it('bva: amount = "18446744073709551614" (u64 max - 1) passes', () => {
    expect(() => validateRequirementsShape(valid({ amount: '18446744073709551614' }))).not.toThrow();
  });

  // expiresAt: must be positive finite number
  it('bva: expiresAt = 1 (smallest positive) passes', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: 1 }))).not.toThrow();
  });

  it('bva: expiresAt = 0 (boundary) rejects', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: 0 }))).toThrow('expiresAt');
  });

  it('bva: expiresAt = Number.MAX_SAFE_INTEGER passes', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: Number.MAX_SAFE_INTEGER }))).not.toThrow();
  });

  it('bva: expiresAt = Number.MIN_VALUE (smallest positive float) passes', () => {
    expect(() => validateRequirementsShape(valid({ expiresAt: Number.MIN_VALUE }))).not.toThrow();
  });

  // Header size boundary (tested via decode)
  it('bva: header at exactly 64KB passes decode (if valid content)', () => {
    // Create a 402 with extensions that pad to near 64KB
    const encoded = encodePaymentRequired(doc({ extensions: { padding: 'x'.repeat(40_000) } }));
    // This should be under 64KB after base64 encoding
    if (encoded.length <= 64 * 1024) {
      expect(() => decodePaymentRequired(encoded)).not.toThrow();
    }
  });

  it('bva: header at 64KB + 1 rejects decode', () => {
    const huge = 'A'.repeat(64 * 1024 + 1);
    expect(() => decodePaymentRequired(huge)).toThrow('exceeds maximum size');
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: validatePayloadShape (via decodePaymentPayload)
// ══════════════════════════════════════════════════════════════

describe('mcdc: validatePayloadShape — isolation tests', () => {
  function encodePayload(obj: Record<string, unknown>): string {
    return btoa(JSON.stringify(obj));
  }

  const VALID_PAYLOAD = { scheme: 'exact', payload: { transaction: 'tx', signature: 'sig' } };

  it('mcdc-hp: valid exact payload passes', () => {
    expect(() => decodePaymentRequired(encodePaymentRequired(doc()))).not.toThrow();
  });

  // C1: array is typeof 'object' but has no x402Version — hits version gate
  it('mcdc-mc1: rejects array (passes typeof but fails x402Version)', () => {
    expect(() => decodePaymentRequired(btoa(JSON.stringify([])))).toThrow('Missing x402Version');
  });

  // Payload version gate
  it('mcdc-mc2: rejects payload with s402Version "99"', () => {
    const encoded = encodePayload({ ...VALID_PAYLOAD, s402Version: '99' });
    expect(() => decodePaymentPayload(encoded)).toThrow('Unsupported s402 version');
  });

  // Missing scheme
  it('mcdc-mc3: rejects payload missing scheme', () => {
    expect(() => decodePaymentPayload(encodePayload({ payload: { transaction: 'tx', signature: 'sig' } }))).toThrow('missing scheme');
  });

  // Invalid scheme
  it('mcdc-mc4: rejects payload with unknown scheme', () => {
    expect(() => decodePaymentPayload(encodePayload({ scheme: 'bitcoin', payload: { transaction: 'tx', signature: 'sig' } }))).toThrow('Unknown payment scheme');
  });

  // Missing inner payload
  it('mcdc-mc5: rejects payload missing inner payload', () => {
    expect(() => decodePaymentPayload(encodePayload({ scheme: 'exact' }))).toThrow('missing payload');
  });

  // Inner transaction not string
  it('mcdc-mc6: rejects non-string inner transaction', () => {
    expect(() => decodePaymentPayload(encodePayload({ scheme: 'exact', payload: { transaction: 42, signature: 'sig' } }))).toThrow('transaction must be a string');
  });

  // Inner signature not string
  it('mcdc-mc7: rejects non-string inner signature', () => {
    expect(() => decodePaymentPayload(encodePayload({ scheme: 'exact', payload: { transaction: 'tx', signature: null } }))).toThrow('signature must be a string');
  });

  // Scheme-specific: unlock carries only transaction + signature (single-tx pay_and_mint)
  it('mcdc-mc8: accepts unlock payload with only transaction + signature', () => {
    expect(() => decodePaymentPayload(encodePayload({ scheme: 'unlock', payload: { transaction: 'tx', signature: 'sig' } }))).not.toThrow();
  });

  // Scheme-specific: prepaid requires ratePerCall
  it('mcdc-mc9: rejects prepaid payload without ratePerCall', () => {
    expect(() => decodePaymentPayload(encodePayload({ scheme: 'prepaid', payload: { transaction: 'tx', signature: 'sig' } }))).toThrow('ratePerCall');
  });

  // Scheme-specific: prepaid maxCalls must be string if present
  it('mcdc-mc10: rejects prepaid payload with non-string maxCalls', () => {
    expect(() => decodePaymentPayload(encodePayload({
      scheme: 'prepaid',
      payload: { transaction: 'tx', signature: 'sig', ratePerCall: '100', maxCalls: 42 },
    }))).toThrow('maxCalls must be a string');
  });
});

// ══════════════════════════════════════════════════════════════
// MC/DC: validateSettleShape (via decodeSettleResponse)
// ══════════════════════════════════════════════════════════════

describe('mcdc: validateSettleShape — isolation tests', () => {
  function encodeSettle(obj: Record<string, unknown>): string {
    return btoa(JSON.stringify(obj));
  }

  it('mcdc-hp: minimal valid settle passes', () => {
    expect(() => decodeSettleResponse(encodeSettle({ success: true }))).not.toThrow();
  });

  it('mcdc-hp: full valid settle passes', () => {
    expect(() => decodeSettleResponse(encodeSettle({
      success: true, txDigest: 'ABC', receiptId: '0xr', finalityMs: 450,
      streamId: '0xs', escrowId: '0xe', balanceId: '0xb',
    }))).not.toThrow();
  });

  it('mcdc-hp: error settle passes', () => {
    expect(() => decodeSettleResponse(encodeSettle({
      success: false, error: 'fail', errorCode: 'INSUFFICIENT_BALANCE',
    }))).not.toThrow();
  });

  it('mcdc-mc1: rejects non-object', () => {
    expect(() => decodeSettleResponse(encodeSettle('string' as any))).toThrow('not an object');
  });

  it('mcdc-mc2: rejects missing success', () => {
    expect(() => decodeSettleResponse(encodeSettle({ txDigest: 'ABC' }))).toThrow('success');
  });

  it('mcdc-mc3: rejects non-boolean success', () => {
    expect(() => decodeSettleResponse(encodeSettle({ success: 'yes' }))).toThrow('success');
  });
});

// ══════════════════════════════════════════════════════════════
// Error Type Consistency — all rejections are s402Error
// ══════════════════════════════════════════════════════════════

describe('mcdc: all rejections throw s402Error with INVALID_PAYLOAD code', () => {
  const INVALID_INPUTS = [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['missing x402Version', { resource: { url: RESOURCE_URL }, accepts: [{ ...VALID }] }],
    ['retired s402 v1 flat shape', { s402Version: '1', accepts: ['exact'], network: 'n', asset: 'a', amount: '0', payTo: 'p' }],
    ['wrong x402Version', valid({ x402Version: 99 })],
    ['missing resource', { x402Version: 2, accepts: [{ ...VALID }] }],
    ['non-string resource.url', valid({ resource: { url: 42 } })],
    ['non-array accepts', valid({ accepts: 'exact' })],
    ['empty accepts', valid({ accepts: [] })],
    ['bare string accepts entry', valid({ accepts: ['exact'] })],
    ['non-string network', valid({ network: 42 })],
    ['non-string amount', valid({ amount: 42 })],
    ['invalid amount', valid({ amount: 'hello' })],
    ['empty payTo', valid({ payTo: '' })],
    ['control char in network', valid({ network: 'sui\x00' })],
    ['non-object entry extra', valid({ accepts: [{ ...VALID, extra: 'nope' }] })],
    ['invalid facilitatorUrl', valid({ facilitatorUrl: 'not-a-url' })],
    ['SSRF facilitatorUrl', valid({ facilitatorUrl: 'file:///etc/passwd' })],
    ['bad settlementMode', valid({ settlementMode: 'fast' })],
    ['bad receiptRequired', valid({ receiptRequired: 'yes' })],
    ['bad protocolFeeBps', valid({ protocolFeeBps: 50001 })],
    ['bad expiresAt', valid({ expiresAt: 'never' })],
    ['unsupported s402 wire version', { ...valid(), extensions: { s402: { version: '3' } } }],
  ] as const;

  for (const [label, input] of INVALID_INPUTS) {
    it(`throws s402Error with code INVALID_PAYLOAD for: ${label}`, () => {
      try {
        validateRequirementsShape(input);
        expect.unreachable(`should have thrown for: ${label}`);
      } catch (e) {
        expect(e).toBeInstanceOf(s402Error);
        expect((e as InstanceType<typeof s402Error>).code).toBe('INVALID_PAYLOAD');
      }
    });
  }
});
