import { describe, it, expect } from 'vitest';
import { mcpTransport, S402_MCP_META_KEY, S402_VERSION } from '../src/index.js';
import { fromX402PayloadMeta } from '../src/compat/x402.js';
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

describe('mcpTransport — payment in the MCP `_meta` slot (ADR-011 Chunk 1a-iii)', () => {
  it('reports its carrier', () => {
    expect(mcpTransport.carrier).toBe('mcp');
  });

  it('encodes the s402 object directly under `s402/payment` (structured JSON, not base64)', () => {
    const frame = mcpTransport.encodeRequirements(requirements);
    expect(frame[S402_MCP_META_KEY]).toEqual(requirements);
    // MCP idiom check: the value is the object itself, not a base64 string.
    expect(typeof frame[S402_MCP_META_KEY]).toBe('object');
  });

  it('round-trips requirements + derives status=required', () => {
    const decoded = mcpTransport.decodeRequirements(mcpTransport.encodeRequirements(requirements))!;
    expect(decoded.value).toEqual(requirements);
    expect(decoded.ctx.status).toBe('required');
    expect(decoded.ctx.correlationId).toBeUndefined();
  });

  it('round-trips payload + derives status=submitted', () => {
    const decoded = mcpTransport.decodePayload(mcpTransport.encodePayload(payload))!;
    expect(decoded.value).toEqual(payload);
    expect(decoded.ctx.status).toBe('submitted');
  });

  it('round-trips settlement + status reflects success/failure', () => {
    expect(mcpTransport.decodeSettlement(mcpTransport.encodeSettlement(settle))!.ctx.status).toBe('completed');
    const failed = mcpTransport.encodeSettlement({ success: false, error: 'boom', errorCode: 'SETTLEMENT_FAILED' });
    expect(mcpTransport.decodeSettlement(failed)!.ctx.status).toBe('failed');
  });

  it('returns null when the `_meta` carries no s402 payment', () => {
    expect(mcpTransport.decodeRequirements({})).toBeNull();
    expect(mcpTransport.decodePayload({})).toBeNull();
    expect(mcpTransport.decodeSettlement({})).toBeNull();
    expect(mcpTransport.decodeRequirements({ 'other/key': 1 })).toBeNull();
  });

  it('decoders cross the same trust boundary as HTTP — malformed object throws', () => {
    expect(() => mcpTransport.decodeRequirements({ [S402_MCP_META_KEY]: { nope: true } })).toThrow();
    expect(() => mcpTransport.decodePayload({ [S402_MCP_META_KEY]: { nope: true } })).toThrow();
    expect(() => mcpTransport.decodeSettlement({ [S402_MCP_META_KEY]: { nope: true } })).toThrow();
  });

  it('calling the wrong decoder for a frame throws (direction is the caller’s responsibility)', () => {
    const reqFrame = mcpTransport.encodeRequirements(requirements);
    expect(() => mcpTransport.decodePayload(reqFrame)).toThrow();
  });

  it('strips unknown keys via the canonical pick* (parity with HTTP decode)', () => {
    const frame = { [S402_MCP_META_KEY]: { ...requirements, bogusKey: 'evil' } };
    const decoded = mcpTransport.decodeRequirements(frame)!;
    expect('bogusKey' in (decoded.value as Record<string, unknown>)).toBe(false);
  });
});

describe('fromX402PayloadMeta — opt-in x402-over-MCP inbound bridge (compat)', () => {
  it('normalizes an x402 payload at the x402/payment _meta key to an s402 payload', () => {
    const meta = { 'x402/payment': { x402Version: 2, payload: { transaction: 'tx', signature: 'sig' } } };
    expect(fromX402PayloadMeta(meta)).toEqual({
      s402Version: S402_VERSION,
      scheme: 'exact',
      payload: { transaction: 'tx', signature: 'sig' },
    });
  });

  it('returns null when the x402 key is absent (caller falls back to native s402/payment)', () => {
    expect(fromX402PayloadMeta({})).toBeNull();
    expect(fromX402PayloadMeta({ 's402/payment': { anything: true } })).toBeNull();
  });

  it('throws when the x402 _meta value is present but not a valid payload object', () => {
    expect(() => fromX402PayloadMeta({ 'x402/payment': 'not-an-object' })).toThrow();
    expect(() => fromX402PayloadMeta({ 'x402/payment': { payload: {} } })).toThrow();
  });
});
