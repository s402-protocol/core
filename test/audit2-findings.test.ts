/**
 * Security Audit Pass 2 — Finding Verification Tests
 *
 * These tests verify issues found during the second hardening pass
 * of the compat/trust-boundary layer.
 */
import { describe, it, expect } from 'vitest';
import {
  fromX402Requirements,
  fromX402Payload,
  fromX402Envelope,
  toX402Requirements,
  isS402,
  isX402,
  isX402Envelope,
  normalizeRequirements,
  decodePaymentRequired,
  detectProtocol,
  s402Error,
  type x402PaymentRequiredEnvelope,
} from '../src/index.js';

// ════════════════════════════════════════════════════════════════
// FINDING 1: fromX402Payload has zero input validation
// ════════════════════════════════════════════════════════════════
describe('FINDING 1: fromX402Payload validation (FIXED)', () => {
  it('rejects non-string transaction with s402Error', () => {
    expect(() => fromX402Payload({
      x402Version: 1,
      scheme: 'exact',
      payload: { transaction: 42 as any, signature: 'sig' },
    })).toThrow(s402Error);
  });

  it('rejects null signature with s402Error', () => {
    expect(() => fromX402Payload({
      x402Version: 1,
      scheme: 'exact',
      payload: { transaction: 'tx', signature: null as any },
    })).toThrow(s402Error);
  });

  it('throws s402Error (not TypeError) when payload is missing', () => {
    expect(() => fromX402Payload({
      x402Version: 1,
      scheme: 'exact',
    } as any)).toThrow(s402Error);
  });

  it('normalizes non-exact scheme to exact (x402 only supports exact)', () => {
    const result = fromX402Payload({
      x402Version: 1,
      scheme: 'stream',
      payload: { transaction: 'tx', signature: 'sig' },
    });
    expect(result.scheme).toBe('exact');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 2: detectProtocol uses truthiness, not 'in' operator
// ════════════════════════════════════════════════════════════════
describe('FINDING 2: detectProtocol now uses in-check (FIXED)', () => {
  it('detectProtocol and isS402 agree on s402Version=0', () => {
    const obj = { s402Version: 0 };
    expect(isS402(obj as any)).toBe(true);
    // Now consistent: detectProtocol also uses 'in' operator
    const headers = new Headers();
    headers.set('payment-required', btoa(JSON.stringify(obj)));
    expect(detectProtocol(headers)).toBe('s402');
  });

  it('detectProtocol and isX402 agree on x402Version=0', () => {
    const obj = { x402Version: 0 };
    expect(isX402(obj as any)).toBe(true);
    const headers = new Headers();
    headers.set('payment-required', btoa(JSON.stringify(obj)));
    expect(detectProtocol(headers)).toBe('x402');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 3: x402 V2 envelope inner requirement field injection
// ════════════════════════════════════════════════════════════════
describe('FINDING 3: V2 envelope inner requirement field injection → fromX402Requirements', () => {
  it('extensions field in V2 inner requirement propagates to s402 output via extensions', () => {
    // fromX402Requirements copies x402.extensions to the output
    // An attacker can inject arbitrary data via the extensions field in V2 inner reqs
    const envelope: x402PaymentRequiredEnvelope = {
      x402Version: 2,
      accepts: [{
        x402Version: 2,
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '1000',
        payTo: '0xabc',
        extensions: { __proto__: { polluted: true }, toString: 'gotcha' },
      }],
    };
    const result = fromX402Envelope(envelope);
    // extensions IS a known s402 field, so it survives.
    // But the CONTENTS of extensions are attacker-controlled and unvalidated.
    expect(result.extensions).toBeDefined();
    expect((result.extensions as any).__proto__).toBeDefined();
  });

  it('V2 inner requirement with injected facilitatorUrl overrides envelope-level intent', () => {
    const envelope: x402PaymentRequiredEnvelope = {
      x402Version: 2,
      accepts: [{
        x402Version: 2,
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '1000',
        payTo: '0xabc',
        facilitatorUrl: 'https://evil-facilitator.com',
      }],
    };
    const result = normalizeRequirements(envelope as any);
    // Attacker's facilitatorUrl survives because fromX402Requirements copies it
    expect(result.facilitatorUrl).toBe('https://evil-facilitator.com');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 4: x402 path does NOT apply pickS402Fields
// ════════════════════════════════════════════════════════════════
describe('FINDING 4: x402 conversion path bypasses pickS402Fields allowlist', () => {
  it('fromX402Requirements copies x402.extensions without content validation', () => {
    const result = fromX402Requirements({
      x402Version: 1,
      scheme: 'exact',
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0xabc',
      extensions: { deeply: { nested: { attack: true } } },
    });
    // The extensions field is blindly copied
    expect((result.extensions as any).deeply.nested.attack).toBe(true);
  });

  it('fromX402Requirements preserves facilitatorUrl without URL validation', () => {
    const result = fromX402Requirements({
      x402Version: 1,
      scheme: 'exact',
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0xabc',
      facilitatorUrl: 'javascript:alert(1)',
    });
    // No URL validation — potentially dangerous in web contexts
    expect(result.facilitatorUrl).toBe('javascript:alert(1)');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 5: accepts array entries not validated in s402 path
// ════════════════════════════════════════════════════════════════
describe('FINDING 5: accepts array content validation gaps', () => {
  it('validateRequirementsShape accepts empty strings in accepts array', () => {
    // Empty string passes typeof === 'string' check
    const result = normalizeRequirements({
      s402Version: '1',
      accepts: [''],  // empty string is a string
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0x1',
    });
    expect(result.accepts).toContain('');
  });

  it('validateRequirementsShape accepts extremely long strings in accepts array', () => {
    const longScheme = 'a'.repeat(10000);
    const result = normalizeRequirements({
      s402Version: '1',
      accepts: [longScheme],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0x1',
    });
    expect(result.accepts[0].length).toBe(10000);
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 6: No validation of string field content/length
// ════════════════════════════════════════════════════════════════
describe('FINDING 6: String field length/content not bounded', () => {
  it('accepts extremely long network string', () => {
    const result = normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'x'.repeat(100000),
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0x1',
    });
    expect(result.network.length).toBe(100000);
  });

  it('accepts null bytes in string fields', () => {
    const result = normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet\x00evil',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0x1',
    });
    expect(result.network).toContain('\x00');
  });

  it('accepts newlines/CRLF in string fields (header injection potential)', () => {
    const result = normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0x1',
      facilitatorUrl: 'https://example.com\r\nX-Injected: true',
    });
    expect(result.facilitatorUrl).toContain('\r\n');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 7: Scheme-specific sub-objects not validated at trust boundary
// ════════════════════════════════════════════════════════════════
describe('FINDING 7: Scheme-specific sub-objects now validated (FIXED)', () => {
  it('rejects stream with non-string ratePerSecond', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['stream'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: '0x1',
      stream: { ratePerSecond: -999, budgetCap: '1000', minDeposit: '100' },
    } as any)).toThrow('stream.ratePerSecond must be a string');
  });

  it('rejects escrow with non-string seller', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['escrow'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: '0x1',
      escrow: { seller: 42, deadlineMs: '1000' },
    } as any)).toThrow('escrow.seller must be a string');
  });

  it('rejects unlock as non-object', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['unlock'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: '0x1',
      unlock: 'not-even-an-object',
    } as any)).toThrow('unlock must be a plain object');
  });

  it('rejects mandate with non-boolean required', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: '0x1',
      mandate: { required: 'yes-please', minPerTx: '500' },
    } as any)).toThrow('mandate.required must be a boolean');
  });

  it('rejects prepaid with non-string ratePerCall', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['prepaid'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: '0x1',
      prepaid: { ratePerCall: [1, 2, 3], minDeposit: '100', withdrawalDelayMs: '60000' },
    } as any)).toThrow('prepaid.ratePerCall must be a string');
  });

  it('accepts valid sub-objects', () => {
    const result = normalizeRequirements({
      s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: '0x1',
      mandate: { required: true, minPerTx: '500' },
    });
    expect(result.mandate?.required).toBe(true);
    expect(result.mandate?.minPerTx).toBe('500');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 8: protocolFeeBps NaN and Infinity edge cases
// ════════════════════════════════════════════════════════════════
describe('FINDING 8: protocolFeeBps NaN handling (FIXED)', () => {
  it('rejects NaN protocolFeeBps', () => {
    expect(() => normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0x1',
      protocolFeeBps: NaN,
    })).toThrow('protocolFeeBps');
  });

  it('rejects Infinity protocolFeeBps', () => {
    expect(() => normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0x1',
      protocolFeeBps: Infinity,
    })).toThrow('protocolFeeBps');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 9: amount field BigInt overflow (extremely large numbers)
// ════════════════════════════════════════════════════════════════
describe('FINDING 9: amount field — extremely large values', () => {
  it('accepts amounts far exceeding u64 max without rejection', () => {
    // u64 max = 18446744073709551615 (20 digits)
    // This is 100 digits — no u64 or u128 can hold this
    const hugeAmount = '9'.repeat(100);
    const result = normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: hugeAmount,
      payTo: '0x1',
    });
    // isValidAmount only checks regex, not magnitude
    expect(result.amount).toBe(hugeAmount);
    expect(result.amount.length).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 10: x402 → s402 amount selection when both present with different validity
// ════════════════════════════════════════════════════════════════
describe('FINDING 10: x402 dual amount fields — validation gap', () => {
  it('amount is preferred but maxAmountRequired is unchecked when amount is valid', () => {
    // When both are present, `amount ?? maxAmountRequired` picks amount.
    // maxAmountRequired could be malicious — and the x402 V1 client might use
    // maxAmountRequired while we used amount. But this is by design (V2 over V1).
    // However, validateX402Shape only validates the FIRST one found:
    const result = normalizeRequirements({
      x402Version: 2,
      scheme: 'exact',
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      maxAmountRequired: 'ATTACK',  // Invalid but unchecked
      payTo: '0xabc',
    });
    expect(result.amount).toBe('1000');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 11: decodePaymentRequired does not strip unknown keys
// ════════════════════════════════════════════════════════════════
describe('FINDING 11: decodePaymentRequired now strips unknown keys (FIXED)', () => {
  it('unknown keys are stripped by decodePaymentRequired', () => {
    const malicious = {
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0x1',
      __injected: 'malicious_value',
      admin: true,
    };
    const encoded = btoa(JSON.stringify(malicious));
    const decoded = decodePaymentRequired(encoded) as any;
    // Now stripped by pickRequirementsFields
    expect(decoded.__injected).toBeUndefined();
    expect(decoded.admin).toBeUndefined();
    // But known fields survive
    expect(decoded.s402Version).toBe('1');
    expect(decoded.amount).toBe('1000');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 12: toX402Requirements passes through s402.extensions unvalidated
// ════════════════════════════════════════════════════════════════
describe('FINDING 12: toX402Requirements passes s402.extensions to x402 output', () => {
  it('s402-specific data leaks into x402 output via extensions field', () => {
    const s402Req = {
      s402Version: '1' as const,
      accepts: ['exact' as const],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0xabc',
      extensions: {
        mandateId: 'secret-mandate-123',
        internalNotes: 'customer is VIP',
      },
    };
    const x402 = toX402Requirements(s402Req);
    // s402 internal data leaks to x402 clients via extensions
    expect(x402.extensions).toBeDefined();
    expect((x402.extensions as any).mandateId).toBe('secret-mandate-123');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 13: isX402Envelope can match s402 objects with accepts array
// ════════════════════════════════════════════════════════════════
describe('FINDING 13: Detection edge cases', () => {
  it('object with both s402Version AND x402Version is detected as s402 not x402', () => {
    const both = { s402Version: '1', x402Version: 2, accepts: ['exact'] };
    expect(isS402(both as any)).toBe(true);
    expect(isX402(both as any)).toBe(false);
    expect(isX402Envelope(both as any)).toBe(false);
    // Good: the !('s402Version' in obj) guard works
  });

  it('array input to isS402 returns false (not a crash)', () => {
    // Edge case: arrays have 'length' in them, etc.
    expect(isS402([] as any)).toBe(false);
  });
});
