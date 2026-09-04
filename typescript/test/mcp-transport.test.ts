import { describe, it, expect } from 'vitest';
import { mcpTransport, S402_MCP_META_KEY, S402_VERSION } from '../src/index.js';
import { fromX402PayloadMeta } from '../src/compat/x402.js';
import type {
  s402PaymentRequired,
  s402PaymentPayload,
  s402SettleResponse,
} from '../src/index.js';

// The 402 document — wire v2 makes every 402 an x402 V2 `PaymentRequired`
// envelope. `maxTimeoutSeconds` is named because the encoder supplies it when
// omitted; naming it keeps the round-trip exact.
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

/** What the `_meta` slot actually carries: the WIRE envelope, not the in-memory doc. */
const requirementsWire = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/paid' },
  accepts: [{
    scheme: 'exact',
    network: 'sui:testnet',
    asset: '0x2::sui::SUI',
    amount: '1000000',
    payTo: '0xabc',
    maxTimeoutSeconds: 60,
    extra: {},
  }],
  extensions: { s402: { version: '2' } },
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
    // The frame carries the same x402 V2 envelope the HTTP header carries — one
    // projection, not three. s402's own per-requirement fields ride in `extra`,
    // and the wire version rides in `extensions.s402`.
    expect(frame[S402_MCP_META_KEY]).toEqual(requirementsWire);
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
    const frame = { [S402_MCP_META_KEY]: { ...requirementsWire, bogusKey: 'evil' } };
    const decoded = mcpTransport.decodeRequirements(frame)!;
    expect('bogusKey' in (decoded.value as Record<string, unknown>)).toBe(false);
    // …at the entry level too: `accepts[]` is x402's shape, not an open bag.
    const entryFrame = {
      [S402_MCP_META_KEY]: {
        ...requirementsWire,
        accepts: [{ ...requirementsWire.accepts[0], bogusEntryKey: 'evil' }],
      },
    };
    const entry = mcpTransport.decodeRequirements(entryFrame)!.value.accepts[0];
    expect('bogusEntryKey' in (entry as Record<string, unknown>)).toBe(false);
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
