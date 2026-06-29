import { describe, it, expect } from 'vitest';
import { a2aTransport, S402_A2A_KEYS, S402_VERSION } from '../src/index.js';
import { fromX402PayloadA2A } from '../src/compat/x402.js';
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

describe('a2aTransport — payment on the A2A task lifecycle (ADR-011 Chunk 2, the leapfrog)', () => {
  it('reports its carrier', () => {
    expect(a2aTransport.carrier).toBe('a2a');
  });

  it('encodes explicit lifecycle status + correlation into task metadata', () => {
    const frame = a2aTransport.encodeRequirements(requirements, { correlationId: 'task-1' });
    expect(frame[S402_A2A_KEYS.STATUS]).toBe('payment-required');
    expect(frame[S402_A2A_KEYS.REQUIRED]).toEqual(requirements);
    expect(frame[S402_A2A_KEYS.CORRELATION]).toBe('task-1');
  });

  it('round-trips requirements + recovers explicit status and correlation', () => {
    const frame = a2aTransport.encodeRequirements(requirements, { correlationId: 'task-1' });
    const decoded = a2aTransport.decodeRequirements(frame)!;
    expect(decoded.value).toEqual(requirements);
    expect(decoded.ctx.status).toBe('required');
    expect(decoded.ctx.correlationId).toBe('task-1');
  });

  it('round-trips payload with submitted status + correlation', () => {
    const frame = a2aTransport.encodePayload(payload, { correlationId: 'task-2' });
    expect(frame[S402_A2A_KEYS.STATUS]).toBe('payment-submitted');
    const decoded = a2aTransport.decodePayload(frame)!;
    expect(decoded.value).toEqual(payload);
    expect(decoded.ctx.status).toBe('submitted');
    expect(decoded.ctx.correlationId).toBe('task-2');
  });

  it('uses the plural receipts array; status reflects success/failure', () => {
    const ok = a2aTransport.encodeSettlement(settle, { correlationId: 't' });
    expect(ok[S402_A2A_KEYS.STATUS]).toBe('payment-completed');
    expect(ok[S402_A2A_KEYS.RECEIPTS]).toEqual([settle]);
    expect(a2aTransport.decodeSettlement(ok)!.value).toEqual(settle);
    expect(a2aTransport.decodeSettlement(ok)!.ctx.status).toBe('completed');

    const failed = a2aTransport.encodeSettlement({ success: false, error: 'boom', errorCode: 'SETTLEMENT_FAILED' });
    expect(failed[S402_A2A_KEYS.STATUS]).toBe('payment-failed');
    expect(a2aTransport.decodeSettlement(failed)!.ctx.status).toBe('failed');
  });

  // The defining A2A property: status is READ from metadata, not derived from which message is present.
  it('READS the explicit status from metadata rather than deriving it (statefulness)', () => {
    // A requirements payload, but the task metadata explicitly says submitted.
    const frame = {
      [S402_A2A_KEYS.STATUS]: 'payment-submitted',
      [S402_A2A_KEYS.REQUIRED]: requirements,
    };
    const decoded = a2aTransport.decodeRequirements(frame)!;
    expect(decoded.ctx.status).toBe('submitted'); // read, not the 'required' a derive would give
  });

  it('omits correlation when none is provided; decode reports undefined', () => {
    const frame = a2aTransport.encodeRequirements(requirements);
    expect(S402_A2A_KEYS.CORRELATION in frame).toBe(false);
    expect(a2aTransport.decodeRequirements(frame)!.ctx.correlationId).toBeUndefined();
  });

  it('returns null when the metadata carries no s402 payment for that direction', () => {
    expect(a2aTransport.decodeRequirements({})).toBeNull();
    expect(a2aTransport.decodePayload({})).toBeNull();
    expect(a2aTransport.decodeSettlement({})).toBeNull();
  });

  it('crosses the same trust boundary — malformed payment object throws', () => {
    expect(() => a2aTransport.decodeRequirements({ [S402_A2A_KEYS.REQUIRED]: { nope: true } })).toThrow();
    expect(() => a2aTransport.decodePayload({ [S402_A2A_KEYS.PAYLOAD]: { nope: true } })).toThrow();
  });

  it('rejects a receipts field that is not a non-empty array', () => {
    expect(() => a2aTransport.decodeSettlement({ [S402_A2A_KEYS.RECEIPTS]: [] })).toThrow();
    expect(() => a2aTransport.decodeSettlement({ [S402_A2A_KEYS.RECEIPTS]: { not: 'array' } })).toThrow();
  });
});

describe('fromX402PayloadA2A — opt-in x402-over-A2A inbound bridge (compat)', () => {
  it('normalizes an x402 payload at the x402.payment.payload metadata key', () => {
    const meta = { 'x402.payment.payload': { x402Version: 2, payload: { transaction: 'tx', signature: 'sig' } } };
    expect(fromX402PayloadA2A(meta)).toEqual({
      s402Version: S402_VERSION,
      scheme: 'exact',
      payload: { transaction: 'tx', signature: 'sig' },
    });
  });

  it('returns null when the x402 A2A key is absent', () => {
    expect(fromX402PayloadA2A({})).toBeNull();
    expect(fromX402PayloadA2A({ 's402.payment.payload': { anything: true } })).toBeNull();
  });

  it('throws when the x402 A2A value is present but not a valid payload object', () => {
    expect(() => fromX402PayloadA2A({ 'x402.payment.payload': 'nope' })).toThrow();
  });
});
