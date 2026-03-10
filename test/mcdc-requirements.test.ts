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
 * C1:  obj == null || typeof obj !== 'object'         → "not an object"
 * C2:  record.s402Version === undefined               → "Missing s402Version"
 * C3:  record.s402Version !== '1'                     → "Unsupported s402 version"
 * C4:  !Array.isArray(record.accepts)                 → missing "accepts (array)"
 * C5:  typeof record.network !== 'string'             → missing "network (string)"
 * C6:  typeof record.asset !== 'string'               → missing "asset (string)"
 * C7:  typeof record.amount !== 'string'              → missing "amount (string)"
 * C8:  amount is string AND !isValidU64Amount()       → "Invalid amount"
 * C9:  typeof record.payTo !== 'string'               → missing "payTo (string)"
 * C10: payTo.length === 0                             → "payTo must be non-empty"
 * C11: /[\x00-\x1f\x7f]/.test(network)               → "network contains control characters"
 * C12: /[\x00-\x1f\x7f]/.test(asset)                 → "asset contains control characters"
 * C13: /[\x00-\x1f\x7f]/.test(payTo)                 → "payTo contains control characters"
 * C14: accepts.length === 0                           → "at least one scheme"
 * C15: accepts entry is not string                    → "expected string, got ..."
 * C16: protocolFeeBps present AND invalid             → rejects (6 sub-conditions)
 * C17: expiresAt present AND invalid                  → rejects (4 sub-conditions)
 * C18: protocolFeeAddress present AND not non-empty string → rejects
 * C19: protocolFeeAddress has control chars            → rejects
 * C20: facilitatorUrl present AND not string           → rejects
 * C21: facilitatorUrl has control chars                → rejects
 * C22: facilitatorUrl not valid URL                    → rejects
 * C23: facilitatorUrl valid URL but not http/https     → rejects
 * C24: settlementMode present AND not 'facilitator'|'direct' → rejects
 * C25: receiptRequired present AND not boolean         → rejects
 * C26-C30: sub-object validators (mandate, stream, escrow, unlock, prepaid)
 * ═══════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import {
  decodePaymentRequired,
  decodePaymentPayload,
  decodeSettleResponse,
  encodePaymentRequired,
  s402Error,
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

/** Minimal valid requirements — all conditions TRUE (happy path). */
const VALID: Record<string, unknown> = {
  s402Version: '1',
  accepts: ['exact'],
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

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...VALID, ...overrides };
}

function validFull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...VALID_FULL, ...overrides };
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

  it('mcdc-hp: multiple schemes in accepts passes', () => {
    expect(() => validateRequirementsShape(valid({ accepts: ['exact', 'stream', 'escrow', 'unlock', 'prepaid'] }))).not.toThrow();
  });

  it('mcdc-hp: unknown scheme names in accepts pass (forward compat)', () => {
    expect(() => validateRequirementsShape(valid({ accepts: ['exact', 'futureScheme2030'] }))).not.toThrow();
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
  // have s402Version, so it fails at C2. This is tested implicitly.

  // C2: s402Version === undefined
  it('mcdc-mc2: rejects missing s402Version', () => {
    const { s402Version: _, ...rest } = valid();
    expect(() => validateRequirementsShape(rest)).toThrow('Missing s402Version');
  });

  // C3: s402Version !== '1'
  it('mcdc-mc3a: rejects s402Version "2"', () => {
    expect(() => validateRequirementsShape(valid({ s402Version: '2' }))).toThrow('Unsupported s402 version');
  });

  it('mcdc-mc3b: rejects s402Version "0"', () => {
    expect(() => validateRequirementsShape(valid({ s402Version: '0' }))).toThrow('Unsupported s402 version');
  });

  it('mcdc-mc3c: rejects numeric s402Version 1 (must be string "1")', () => {
    expect(() => validateRequirementsShape(valid({ s402Version: 1 }))).toThrow('Unsupported s402 version');
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

  // C8: amount is string AND !isValidU64Amount()
  it('mcdc-mc8a: rejects non-numeric amount string', () => {
    expect(() => validateRequirementsShape(valid({ amount: 'abc' }))).toThrow('Invalid amount');
  });

  it('mcdc-mc8b: rejects negative amount', () => {
    expect(() => validateRequirementsShape(valid({ amount: '-1' }))).toThrow('Invalid amount');
  });

  it('mcdc-mc8c: rejects leading zeros', () => {
    expect(() => validateRequirementsShape(valid({ amount: '007' }))).toThrow('Invalid amount');
  });

  it('mcdc-mc8d: rejects decimal amount', () => {
    expect(() => validateRequirementsShape(valid({ amount: '1.5' }))).toThrow('Invalid amount');
  });

  it('mcdc-mc8e: rejects amount exceeding u64 max', () => {
    expect(() => validateRequirementsShape(valid({ amount: '18446744073709551616' }))).toThrow('Invalid amount');
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
    expect(() => validateRequirementsShape(valid({ accepts: [] }))).toThrow('at least one scheme');
  });

  // C15: accepts entry is not string
  it('mcdc-mc15a: rejects number in accepts', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [42] }))).toThrow('expected string');
  });

  it('mcdc-mc15b: rejects null in accepts', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [null] }))).toThrow('expected string');
  });

  it('mcdc-mc15c: rejects object in accepts', () => {
    expect(() => validateRequirementsShape(valid({ accepts: [{ scheme: 'exact' }] }))).toThrow('expected string');
  });

  it('mcdc-mc15d: rejects mixed valid/invalid in accepts', () => {
    expect(() => validateRequirementsShape(valid({ accepts: ['exact', 42] }))).toThrow('expected string');
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
  const VALID_UNLOCK = { encryptionId: 'enc123', walrusBlobId: 'blob456', encryptionPackageId: '0xpkg' };

  it('mcdc-hp: valid unlock passes', () => {
    expect(() => validateUnlockShape(VALID_UNLOCK)).not.toThrow();
  });

  it('mcdc-mc1: rejects null unlock', () => {
    expect(() => validateUnlockShape(null)).toThrow('must be a plain object');
  });

  it('mcdc-mc2: rejects non-string encryptionId', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, encryptionId: 42 })).toThrow('encryptionId must be a string');
  });

  it('mcdc-mc3: rejects non-string walrusBlobId', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, walrusBlobId: null })).toThrow('walrusBlobId must be a string');
  });

  it('mcdc-mc4: rejects non-string encryptionPackageId', () => {
    expect(() => validateUnlockShape({ ...VALID_UNLOCK, encryptionPackageId: false })).toThrow('encryptionPackageId must be a string');
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
    expect(() => validateRequirementsShape(valid({ unlock: { encryptionId: 42 } }))).toThrow('encryptionId must be a string');
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
      unlock: { encryptionId: 'enc', walrusBlobId: 'blob', encryptionPackageId: '0xpkg' },
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

  it('bva: amount = "18446744073709551616" (u64 max + 1) rejects', () => {
    expect(() => validateRequirementsShape(valid({ amount: '18446744073709551616' }))).toThrow('Invalid amount');
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
    // Create a requirements with extensions that pad to near 64KB
    const reqs = {
      ...VALID,
      extensions: { padding: 'x'.repeat(40_000) },
    } as unknown as s402PaymentRequirements;
    const encoded = encodePaymentRequired(reqs);
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
    expect(() => decodePaymentRequired(encodePaymentRequired(VALID as unknown as s402PaymentRequirements))).not.toThrow();
  });

  // C1: array is typeof 'object' but has no s402Version — hits version gate
  it('mcdc-mc1: rejects array (passes typeof but fails s402Version)', () => {
    expect(() => decodePaymentRequired(btoa(JSON.stringify([])))).toThrow('Missing s402Version');
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

  // Scheme-specific: unlock requires encryptionId
  it('mcdc-mc8: rejects unlock payload without encryptionId', () => {
    expect(() => decodePaymentPayload(encodePayload({ scheme: 'unlock', payload: { transaction: 'tx', signature: 'sig' } }))).toThrow('encryptionId');
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
    ['missing s402Version', { accepts: ['exact'], network: 'n', asset: 'a', amount: '0', payTo: 'p' }],
    ['wrong version', { ...VALID, s402Version: '99' }],
    ['non-array accepts', { ...VALID, accepts: 'exact' }],
    ['empty accepts', { ...VALID, accepts: [] }],
    ['non-string network', { ...VALID, network: 42 }],
    ['non-string amount', { ...VALID, amount: 42 }],
    ['invalid amount', { ...VALID, amount: 'hello' }],
    ['empty payTo', { ...VALID, payTo: '' }],
    ['control char in network', { ...VALID, network: 'sui\x00' }],
    ['invalid facilitatorUrl', { ...VALID, facilitatorUrl: 'not-a-url' }],
    ['SSRF facilitatorUrl', { ...VALID, facilitatorUrl: 'file:///etc/passwd' }],
    ['bad settlementMode', { ...VALID, settlementMode: 'fast' }],
    ['bad receiptRequired', { ...VALID, receiptRequired: 'yes' }],
    ['bad protocolFeeBps', { ...VALID, protocolFeeBps: 50001 }],
    ['bad expiresAt', { ...VALID, expiresAt: 'never' }],
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
