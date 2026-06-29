import { describe, it, expect } from 'vitest';
import {
  httpTransport,
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  encodeSettleResponse,
  S402_HEADERS,
} from '../src/index.js';
import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402SettleResponse,
} from '../src/index.js';

const requirements: s402PaymentRequirements = {
  s402Version: '1',
  accepts: ['exact'],
  network: 'sui:testnet',
  asset: '0x2::sui::SUI',
  amount: '1000000',
  payTo: '0xabc',
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
