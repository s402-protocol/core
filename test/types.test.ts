import { describe, it, expect } from 'vitest';
import {
  S402_VERSION,
  S402_HEADERS,
  type s402PaymentRequirements,
  type s402ExactPayload,
  type s402StreamPayload,
  type s402Discovery,
} from '../src/index.js';

describe('s402 types', () => {
  it('S402_VERSION is "1"', () => {
    expect(S402_VERSION).toBe('1');
  });

  it('S402_HEADERS uses lowercase header names (HTTP/2 compliant)', () => {
    expect(S402_HEADERS.PAYMENT_REQUIRED).toBe('payment-required');
    expect(S402_HEADERS.PAYMENT).toBe('x-payment');
    expect(S402_HEADERS.PAYMENT_RESPONSE).toBe('payment-response');
    expect(S402_HEADERS.STREAM_ID).toBe('x-stream-id');
  });

  it('payment requirements type satisfies shape', () => {
    const req: s402PaymentRequirements = {
      s402Version: S402_VERSION,
      accepts: ['exact', 'stream'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000000000',
      payTo: '0xabc',
      protocolFeeBps: 50,
      mandate: { required: true, minPerTx: '100000' },
    };

    expect(req.s402Version).toBe('1');
    expect(req.accepts).toContain('exact');
    expect(req.mandate?.required).toBe(true);
  });

  it('payment requirements supports optional expiresAt', () => {
    const future = Date.now() + 5 * 60 * 1000;
    const req: s402PaymentRequirements = {
      s402Version: S402_VERSION,
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000000000',
      payTo: '0xabc',
      expiresAt: future,
    };

    expect(req.expiresAt).toBe(future);
  });

  it('payment requirements without expiresAt is valid', () => {
    const req: s402PaymentRequirements = {
      s402Version: S402_VERSION,
      accepts: ['exact'],
      network: 'sui:testnet',
      asset: '0x2::sui::SUI',
      amount: '1000000000',
      payTo: '0xabc',
    };

    expect(req.expiresAt).toBeUndefined();
  });

  it('exact payload satisfies discriminated union', () => {
    const payload: s402ExactPayload = {
      s402Version: S402_VERSION,
      scheme: 'exact',
      payload: {
        transaction: 'base64tx',
        signature: 'base64sig',
      },
    };

    expect(payload.scheme).toBe('exact');
    expect(payload.payload.transaction).toBe('base64tx');
  });

  it('stream payload satisfies discriminated union', () => {
    const payload: s402StreamPayload = {
      s402Version: S402_VERSION,
      scheme: 'stream',
      payload: {
        transaction: 'base64tx',
        signature: 'base64sig',
      },
    };

    expect(payload.scheme).toBe('stream');
  });

  it('discovery type satisfies shape', () => {
    const discovery: s402Discovery = {
      s402Version: S402_VERSION,
      schemes: ['exact', 'stream', 'escrow', 'unlock'],
      networks: ['sui:testnet', 'sui:mainnet'],
      assets: ['0x2::sui::SUI'],
      directSettlement: true,
      mandateSupport: true,
      protocolFeeBps: 50,
    };

    expect(discovery.schemes).toHaveLength(4);
    expect(discovery.directSettlement).toBe(true);
  });
});
