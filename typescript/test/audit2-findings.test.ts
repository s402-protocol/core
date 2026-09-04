/**
 * Security Audit Pass 2 — Finding Verification Tests
 *
 * These tests verify issues found during the second hardening pass
 * of the compat/trust-boundary layer.
 */
import { describe, it, expect } from 'vitest';
import {
  decodePaymentRequired,
  detectProtocol,
  s402Error,
} from '../src/index.js';
import {
  fromX402Requirements,
  fromX402Payload,
  fromX402Envelope,
  toX402Requirements,
  isS402,
  isX402,
  isX402Envelope,
  normalizeRequirements,
  type x402PaymentRequiredEnvelope,
} from '../src/compat/x402.js';

const VALID_PAY_TO = '0x' + 'a'.repeat(64);

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

  it('rejects non-exact scheme loudly (x402 ships auth-capture/batch-settlement now; no silent relabel)', () => {
    expect(() => fromX402Payload({
      x402Version: 1,
      scheme: 'auth-capture',
      payload: { transaction: 'tx', signature: 'sig' },
    })).toThrow(s402Error);
    expect(() => fromX402Payload({
      x402Version: 1,
      scheme: 'batch-settlement',
      payload: { transaction: 'tx', signature: 'sig' },
    })).toThrow(/no s402 mapping/);
    // V2 nests the scheme under `accepted` — same rejection applies there
    expect(() => fromX402Payload({
      x402Version: 2,
      accepted: { scheme: 'auth-capture', network: 'base' },
      payload: { transaction: 'tx', signature: 'sig' },
    })).toThrow(/no s402 mapping/);
    // V2 with NO scheme anywhere = exact-by-context (real Sui-shaped traffic)
    expect(fromX402Payload({
      x402Version: 2,
      payload: { transaction: 'tx', signature: 'sig' },
    }).scheme).toBe('exact');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 2: detectProtocol uses truthiness, not 'in' operator
// ════════════════════════════════════════════════════════════════
describe('FINDING 2: detectProtocol now uses in-check (FIXED)', () => {
  it('detectProtocol and isX402 agree on x402Version=0', () => {
    const obj = { x402Version: 0 };
    expect(isX402(obj as any)).toBe(true);
    const headers = new Headers();
    headers.set('payment-required', btoa(JSON.stringify(obj)));
    expect(detectProtocol(headers)).toBe('x402');
  });

  it('the s402 marker is the PRESENCE of extensions.s402, even when it is empty', () => {
    // Wire v2 moved the marker: `s402Version` is gone from the 402, and what
    // says "s402 profile" is the extensions.s402 KEY. An empty object there is
    // still the marker — a truthiness check on its contents would miss it.
    const headers = new Headers();
    headers.set('payment-required', btoa(JSON.stringify({ x402Version: 2, extensions: { s402: {} } })));
    expect(detectProtocol(headers)).toBe('s402');
  });

  it('a retired s402 v1 flat document is reported as s402 — a different ERA, not a different protocol', () => {
    // REVISED with ADR-016's rework (item 8). This used to expect 'unknown',
    // which is also what a response with NO payment-required header returns —
    // so during a rolling upgrade a client could not tell "the server wants
    // money in a shape I used to speak" from "no payment required", and it
    // neither paid nor errored. `detectProtocol` answers whose document this
    // is; which era wrote it is `isS402`'s question, and it still answers.
    const obj = { s402Version: 0 };
    expect(isS402(obj as any)).toBe(true);
    const headers = new Headers();
    headers.set('payment-required', btoa(JSON.stringify(obj)));
    expect(detectProtocol(headers)).toBe('s402');

    // And the eras stay distinguishable where it matters: the wire-v2 decoder
    // still refuses the flat shape and says which reader to use instead.
    expect(() => decodePaymentRequired(btoa(JSON.stringify(obj))))
      .toThrow(/flat requirements shape|s402Version/);
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 3: x402 V2 envelope inner requirement field injection
// ════════════════════════════════════════════════════════════════
describe('FINDING 3: V2 envelope inner requirement field injection → fromX402Requirements', () => {
  it('a literal "__proto__" key in the wire bytes is carried as DATA, never as a prototype', () => {
    // ⚠️ This test used to build the payload as a TypeScript object literal with
    // `__proto__:` in it, which SETS THE PROTOTYPE rather than creating a key —
    // so it asserted `{}.__proto__ !== undefined`, which is true of every object
    // in JavaScript. It passed on an empty object and proved nothing. The attack
    // only exists in the BYTES, so the bytes are what this drives now.
    // `__proto__:` in an object literal is the prototype setter even when the
    // key is quoted, so the payload is assembled with a placeholder and the
    // real key is spliced into the JSON TEXT.
    const wire = JSON.stringify({
      x402Version: 2,
      resource: { url: 'https://api.example.com/paid' },
      accepts: [{
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '1000',
        payTo: '0xabc',
        maxTimeoutSeconds: 60,
        extra: { extensions: { PROTO_KEY_PLACEHOLDER: { polluted: true }, toString: 'gotcha' } },
      }],
    }).replace('PROTO_KEY_PLACEHOLDER', '__proto__');
    expect(wire).toContain('"__proto__"');

    const entry = decodePaymentRequired(btoa(wire)).accepts[0];
    const extensions = entry.extensions as Record<string, unknown>;

    // The key survives as an OWN property — `extensions` is a passthrough bag
    // and dropping it would be a different bug.
    expect(Object.prototype.hasOwnProperty.call(extensions, '__proto__')).toBe(true);
    expect((extensions as Record<string, unknown>)['__proto__']).toEqual({ polluted: true });

    // …and it was not honored as a prototype: nothing was polluted, here or
    // globally, and the decoded objects still have the ordinary Object prototype.
    expect((extensions as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(extensions)).toBe(Object.prototype);
  });

  it('an accepts[] entry with an injected facilitatorUrl still carries it after decode', () => {
    const envelope: x402PaymentRequiredEnvelope = {
      x402Version: 2,
      resource: { url: 'https://api.example.com/paid' },
      accepts: [{
        x402Version: 2,
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '1000',
        payTo: '0xabc',
        extra: { facilitatorUrl: 'https://evil-facilitator.com' },
      }],
    };
    const result = normalizeRequirements(envelope as any);
    // Attacker's facilitatorUrl survives — the decoder validates its SHAPE
    // (scheme, no credentials), never its trustworthiness.
    expect(result.accepts[0].facilitatorUrl).toBe('https://evil-facilitator.com');
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

  it('fromX402Requirements now rejects dangerous facilitatorUrl schemes (M-1 fix)', () => {
    // M-1 fix: facilitatorUrl must use https:// or http://
    expect(() => fromX402Requirements({
      x402Version: 1,
      scheme: 'exact',
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0xabc',
      facilitatorUrl: 'javascript:alert(1)',
    })).toThrow('facilitatorUrl must use https');

    // Valid https: passes through
    const result = fromX402Requirements({
      x402Version: 1,
      scheme: 'exact',
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: '0xabc',
      facilitatorUrl: 'https://facilitator.example.com',
    });
    expect(result.facilitatorUrl).toBe('https://facilitator.example.com');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 5: accepts array entries not validated in s402 path
// ════════════════════════════════════════════════════════════════
describe('FINDING 5: accepts array content validation gaps', () => {
  it('an empty scheme name is now REJECTED (wire v2 closed the gap)', () => {
    // v1 let '' through because it passed typeof === 'string'. A scheme name is
    // one accepts[] entry's identity in wire v2, and the entry validator
    // requires it to be non-empty — on the v1 reader's path too.
    expect(() => normalizeRequirements({
      s402Version: '1',
      accepts: [''],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: VALID_PAY_TO,
    })).toThrow('expected a non-empty string');
  });

  it('an extremely long scheme name is still accepted (Postel: a scheme we cannot pay is one we SKIP)', () => {
    const longScheme = 'a'.repeat(10000);
    const result = normalizeRequirements({
      s402Version: '1',
      accepts: [longScheme],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: VALID_PAY_TO,
    });
    expect(result.accepts[0].scheme.length).toBe(10000);
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
      payTo: VALID_PAY_TO,
    });
    expect(result.accepts[0].network.length).toBe(100000);
  });

  it('rejects null bytes in network field (FIXED)', () => {
    expect(() => normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet\x00evil',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: VALID_PAY_TO,
    })).toThrow('control characters');
  });

  it('rejects null bytes in asset field (FIXED)', () => {
    expect(() => normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI\x00evil',
      amount: '1000',
      payTo: VALID_PAY_TO,
    })).toThrow('control characters');
  });

  it('rejects CRLF in facilitatorUrl (header injection — FIXED)', () => {
    expect(() => normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000',
      payTo: VALID_PAY_TO,
      facilitatorUrl: 'https://example.com\r\nX-Injected: true',
    })).toThrow('control characters');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 7: Scheme-specific sub-objects not validated at trust boundary
// ════════════════════════════════════════════════════════════════
describe('FINDING 7: Scheme-specific sub-objects now validated (FIXED)', () => {
  it('rejects stream with non-string ratePerSecond', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['stream'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
      stream: { ratePerSecond: -999, budgetCap: '1000', minDeposit: '100' },
    } as any)).toThrow('stream.ratePerSecond must be a string');
  });

  it('rejects escrow with non-string seller', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['escrow'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
      escrow: { seller: 42, deadlineMs: '1000' },
    } as any)).toThrow('escrow.seller must be a string');
  });

  it('rejects unlock as non-object', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['unlock'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
      unlock: 'not-even-an-object',
    } as any)).toThrow('unlock must be a plain object');
  });

  it('rejects mandate with non-boolean required', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
      mandate: { required: 'yes-please', minPerTx: '500' },
    } as any)).toThrow('mandate.required must be a boolean');
  });

  it('rejects prepaid with non-string ratePerCall', () => {
    expect(() => normalizeRequirements({
      s402Version: '1', accepts: ['prepaid'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
      prepaid: { ratePerCall: [1, 2, 3], minDeposit: '100', withdrawalDelayMs: '60000' },
    } as any)).toThrow('prepaid.ratePerCall must be a string');
  });

  it('accepts valid sub-objects', () => {
    const result = normalizeRequirements({
      s402Version: '1', accepts: ['exact'], network: 'sui:testnet',
      asset: '0x2::sui::SUI', amount: '1000', payTo: VALID_PAY_TO,
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
      payTo: VALID_PAY_TO,
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
      payTo: VALID_PAY_TO,
      protocolFeeBps: Infinity,
    })).toThrow('protocolFeeBps');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 9: amount field BigInt overflow (extremely large numbers)
// ════════════════════════════════════════════════════════════════
describe('FINDING 9: amount field — extremely large values', () => {
  it('accepts amounts exceeding u64 max (S7: wire format is chain-agnostic, u64 bounds belong in chain adapters)', () => {
    // u64 max = 18446744073709551615 (20 digits)
    // This is 100 digits — valid as a non-negative integer string.
    // Chain-specific magnitude checks (u64, u256) belong in @sweefi/sui, @sweefi/evm, etc.
    const hugeAmount = '9'.repeat(100);
    expect(() => normalizeRequirements({
      s402Version: '1',
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: hugeAmount,
      payTo: VALID_PAY_TO,
    })).not.toThrow();
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
    expect(result.accepts[0].amount).toBe('1000');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 11: decodePaymentRequired does not strip unknown keys
// ════════════════════════════════════════════════════════════════
describe('FINDING 11: decodePaymentRequired now strips unknown keys (FIXED)', () => {
  it('unknown keys are stripped by decodePaymentRequired — at every level of the envelope', () => {
    const malicious = {
      x402Version: 2,
      resource: { url: 'https://api.example.com/paid', __injected: 'malicious_value' },
      accepts: [{
        scheme: 'exact',
        network: 'sui:testnet',
        asset: '0x2::sui::SUI',
        amount: '1000',
        payTo: VALID_PAY_TO,
        __injected: 'malicious_value',
        admin: true,
      }],
      extensions: { s402: { version: '2' } },
      __injected: 'malicious_value',
      admin: true,
    };
    const encoded = btoa(JSON.stringify(malicious));
    const decoded = decodePaymentRequired(encoded) as any;
    // Now stripped by pickRequirementsFields — envelope, entry and resource alike
    expect(decoded.__injected).toBeUndefined();
    expect(decoded.admin).toBeUndefined();
    expect(decoded.accepts[0].__injected).toBeUndefined();
    expect(decoded.accepts[0].admin).toBeUndefined();
    expect(decoded.resource.__injected).toBeUndefined();
    // But known fields survive
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe('https://api.example.com/paid');
    expect(decoded.accepts[0].amount).toBe('1000');
  });
});

// ════════════════════════════════════════════════════════════════
// FINDING 12: toX402Requirements passes through s402.extensions unvalidated
// ════════════════════════════════════════════════════════════════
describe('FINDING 12: toX402Requirements passes s402.extensions to x402 output', () => {
  it('s402-specific data leaks into x402 output via extensions field', () => {
    const s402Req = {
      s402Version: '1' as const,
      scheme: 'exact' as const,
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
