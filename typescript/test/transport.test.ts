import { describe, it, expect } from 'vitest';
import {
  httpTransport,
  mcpTransport,
  a2aTransport,
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  encodeSettleResponse,
  S402_HEADERS,
} from '../src/index.js';
import type {
  s402PaymentRequired,
  s402PaymentPayload,
  s402SettleResponse,
} from '../src/index.js';

// The 402 document, not a bare requirement: wire v2 makes every 402 an x402 V2
// `PaymentRequired` envelope. `maxTimeoutSeconds` is named explicitly because
// the encoder supplies it when omitted — naming it keeps the round-trip exact.
const requirements: s402PaymentRequired = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/paid' },
  accepts: [{
    scheme: 'exact',
    network: 'sui:testnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xabc',
    maxTimeoutSeconds: 60,
  }],
};

const payload: s402PaymentPayload = {
  s402Version: '1',
  scheme: 'exact',
  payload: { transaction: 'deadbeef', signature: 'cafe' },
};

const settle: s402SettleResponse = { success: true, txDigest: 'abc123' };

describe('httpTransport — behavior-preserving over the http.ts codec (ADR-011 Chunk 1a-i)', () => {
  it('reports its carrier', () => {
    expect(httpTransport.carrier).toBe('http');
  });

  // ── Requirements ──────────────────────────────────────────────
  it('encodeRequirements writes the exact bytes the raw codec produces', () => {
    const frame = httpTransport.encodeRequirements(requirements);
    expect(frame.get(S402_HEADERS.PAYMENT_REQUIRED)).toBe(encodePaymentRequired(requirements));
  });

  it('decodeRequirements equals decodePaymentRequired and derives status=required', () => {
    const wire = encodePaymentRequired(requirements);
    const frame = new Headers({ [S402_HEADERS.PAYMENT_REQUIRED]: wire });
    const decoded = httpTransport.decodeRequirements(frame);
    expect(decoded).not.toBeNull();
    expect(decoded!.value).toEqual(decodePaymentRequired(wire));
    expect(decoded!.ctx.status).toBe('required');
    expect(decoded!.ctx.correlationId).toBeUndefined();
  });

  it('round-trips requirements identically', () => {
    const frame = httpTransport.encodeRequirements(requirements);
    expect(httpTransport.decodeRequirements(frame)!.value).toEqual(requirements);
  });

  // ── Payload ───────────────────────────────────────────────────
  it('encodePayload matches the raw codec; round-trips; derives status=submitted', () => {
    const frame = httpTransport.encodePayload(payload);
    expect(frame.get(S402_HEADERS.PAYMENT)).toBe(encodePaymentPayload(payload));
    const decoded = httpTransport.decodePayload(frame)!;
    expect(decoded.value).toEqual(payload);
    expect(decoded.ctx.status).toBe('submitted');
  });

  // ── Settlement ────────────────────────────────────────────────
  it('encodeSettlement matches the raw codec; round-trips; status reflects success', () => {
    const frame = httpTransport.encodeSettlement(settle);
    expect(frame.get(S402_HEADERS.PAYMENT_RESPONSE)).toBe(encodeSettleResponse(settle));
    const decoded = httpTransport.decodeSettlement(frame)!;
    expect(decoded.value).toEqual(settle);
    expect(decoded.ctx.status).toBe('completed');
  });

  it('failed settlement derives status=failed', () => {
    const frame = httpTransport.encodeSettlement({ success: false, error: 'boom', errorCode: 'SETTLEMENT_FAILED' });
    expect(httpTransport.decodeSettlement(frame)!.ctx.status).toBe('failed');
  });

  // ── Absence + case-insensitivity ──────────────────────────────
  it('decoders return null when the frame carries no such message', () => {
    const empty = new Headers();
    expect(httpTransport.decodeRequirements(empty)).toBeNull();
    expect(httpTransport.decodePayload(empty)).toBeNull();
    expect(httpTransport.decodeSettlement(empty)).toBeNull();
  });

  it('reads are case-insensitive (Headers normalization) — forward-compat with ALL-CAPS emit', () => {
    const frame = new Headers({ 'PAYMENT-REQUIRED': encodePaymentRequired(requirements) });
    expect(httpTransport.decodeRequirements(frame)).not.toBeNull();
  });

  // ── Trust boundary: malformed input still throws via the shared validator ──
  it('decodeRequirements propagates the codec validator on malformed input', () => {
    const frame = new Headers({ [S402_HEADERS.PAYMENT_REQUIRED]: 'not-base64-json!!!' });
    expect(() => httpTransport.decodeRequirements(frame)).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════
// N2 — every carrier emits a document its own decoder can read
// ══════════════════════════════════════════════════════════════

// The HTTP encoders check the emitted document against the schema the pinned
// `@x402/core` parses it with (ADR-016). MCP and A2A projected the same
// document and skipped the check, so "emit a 402 you cannot read back"
// survived off the HTTP path: a non-CAIP-2 network and an empty `resource.url`
// both encode, and both carriers' own decoders then refuse the result.
describe('N2 — MCP and A2A hold emission to the same schema as HTTP', () => {
  const nonCaip2: s402PaymentRequired = {
    x402Version: 2,
    resource: { url: '' },
    accepts: [{
      scheme: 'exact',
      network: 'base-sepolia',
      asset: '0x2::sui::SUI',
      amount: '1000000',
      payTo: '0xabc',
      maxTimeoutSeconds: 60,
    }],
  };

  it('the HTTP encoder refuses it — the baseline the other carriers must match', () => {
    expect(() => encodePaymentRequired(nonCaip2)).toThrow(/CAIP-2|resource\.url/);
  });

  it('mcpTransport.encodeRequirements refuses a document its own decoder rejects', () => {
    expect(() => mcpTransport.encodeRequirements(nonCaip2)).toThrow(/CAIP-2|resource\.url/);
  });

  it('a2aTransport.encodeRequirements refuses a document its own decoder rejects', () => {
    expect(() => a2aTransport.encodeRequirements(nonCaip2)).toThrow(/CAIP-2|resource\.url/);
  });

  it('a valid document still encodes and round-trips on both carriers', () => {
    const mcpFrame = mcpTransport.encodeRequirements(requirements);
    expect(mcpTransport.decodeRequirements(mcpFrame)?.value.accepts[0].network).toBe('sui:testnet');
    const a2aFrame = a2aTransport.encodeRequirements(requirements);
    expect(a2aTransport.decodeRequirements(a2aFrame)?.value.accepts[0].network).toBe('sui:testnet');
  });
});
