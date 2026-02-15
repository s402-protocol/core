/**
 * End-to-end integration test: server → client → facilitator
 *
 * Wires up all three actors with mock scheme implementations to verify
 * the full payment flow works through the s402 protocol layer.
 */

import { describe, it, expect } from 'vitest';
import {
  s402Client,
  s402ResourceServer,
  s402Facilitator,
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodeSettleResponse,
  decodeSettleResponse,
  S402_VERSION,
  S402_HEADERS,
  type s402PaymentRequirements,
  type s402PaymentPayload,
  type s402SettleResponse,
} from '../src/index.js';
import type { s402ClientScheme, s402FacilitatorScheme } from '../src/scheme.js';

// ── Mock scheme implementations ──

function mockClientScheme(): s402ClientScheme {
  return {
    scheme: 'exact',
    async createPayment(requirements: s402PaymentRequirements): Promise<s402PaymentPayload> {
      return {
        s402Version: S402_VERSION,
        scheme: 'exact',
        payload: {
          transaction: `pay-${requirements.amount}-to-${requirements.payTo}`,
          signature: 'mock-client-sig',
        },
      };
    },
  };
}

function mockFacilitatorScheme(): s402FacilitatorScheme {
  return {
    scheme: 'exact',
    async verify(payload, requirements) {
      // Verify the transaction encodes the correct amount and recipient
      if (payload.scheme !== 'exact') {
        return { valid: false, invalidReason: 'wrong scheme' };
      }
      const exactPayload = payload as { scheme: 'exact'; payload: { transaction: string; signature: string } };
      const expectedTx = `pay-${requirements.amount}-to-${requirements.payTo}`;
      if (exactPayload.payload.transaction !== expectedTx) {
        return { valid: false, invalidReason: 'transaction mismatch' };
      }
      return { valid: true, payerAddress: '0xpayer' };
    },
    async settle(_payload, _requirements) {
      return {
        success: true,
        txDigest: 'integration-tx-ABC123',
        finalityMs: 380,
      };
    },
  };
}

describe('integration: full payment flow', () => {
  const NETWORK = 'sui:testnet';

  it('server → client → facilitator: exact payment succeeds', async () => {
    // ── 1. Server builds requirements ──
    const server = new s402ResourceServer();
    const facilitator = new s402Facilitator();
    facilitator.register(NETWORK, mockFacilitatorScheme());
    server.setFacilitator(facilitator);

    const requirements = server.buildRequirements({
      schemes: ['exact'],
      price: '5000000',
      network: NETWORK,
      payTo: '0xmerchant',
    });

    expect(requirements.s402Version).toBe(S402_VERSION);
    expect(requirements.accepts).toContain('exact');
    expect(requirements.amount).toBe('5000000');

    // ── 2. Server encodes 402 response ──
    const encoded402 = encodePaymentRequired(requirements);
    expect(typeof encoded402).toBe('string');

    // ── 3. Client decodes requirements ──
    const decodedReqs = decodePaymentRequired(encoded402);
    expect(decodedReqs.amount).toBe('5000000');
    expect(decodedReqs.payTo).toBe('0xmerchant');

    // ── 4. Client creates payment ──
    const client = new s402Client();
    client.register(NETWORK, mockClientScheme());

    const paymentPayload = await client.createPayment(decodedReqs);
    expect(paymentPayload.scheme).toBe('exact');

    // ── 5. Client encodes payment header ──
    const encodedPayment = encodePaymentPayload(paymentPayload);
    expect(typeof encodedPayment).toBe('string');

    // ── 6. Server decodes payment ──
    const decodedPayload = decodePaymentPayload(encodedPayment);
    expect(decodedPayload.scheme).toBe('exact');

    // ── 7. Facilitator processes (verify + settle) ──
    const result = await server.process(decodedPayload, decodedReqs);
    expect(result.success).toBe(true);
    expect(result.txDigest).toBe('integration-tx-ABC123');
    expect(result.finalityMs).toBe(380);

    // ── 8. Server encodes settlement response ──
    const encodedSettle = encodeSettleResponse(result);
    const decodedSettle = decodeSettleResponse(encodedSettle);
    expect(decodedSettle.success).toBe(true);
    expect(decodedSettle.txDigest).toBe('integration-tx-ABC123');
  });

  it('server → client → facilitator: expired requirements rejected', async () => {
    const server = new s402ResourceServer();
    const facilitator = new s402Facilitator();
    facilitator.register(NETWORK, mockFacilitatorScheme());
    server.setFacilitator(facilitator);

    const requirements = server.buildRequirements({
      schemes: ['exact'],
      price: '1000',
      network: NETWORK,
      payTo: '0xmerchant',
    });

    // Add expiration in the past
    const expiredReqs: s402PaymentRequirements = {
      ...requirements,
      expiresAt: Date.now() - 5000,
    };

    const client = new s402Client();
    client.register(NETWORK, mockClientScheme());

    const payload = await client.createPayment(expiredReqs);
    const result = await server.process(payload, expiredReqs);

    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
    expect(result.errorCode).toBe('REQUIREMENTS_EXPIRED');
  });

  it('server → client → facilitator: verify failure returns errorCode', async () => {
    const server = new s402ResourceServer();
    const badFacilitatorScheme = mockFacilitatorScheme();
    // Override verify to always fail
    badFacilitatorScheme.verify = async () => ({
      valid: false,
      invalidReason: 'Insufficient balance',
    });

    const facilitator = new s402Facilitator();
    facilitator.register(NETWORK, badFacilitatorScheme);
    server.setFacilitator(facilitator);

    const requirements = server.buildRequirements({
      schemes: ['exact'],
      price: '1000',
      network: NETWORK,
      payTo: '0xmerchant',
    });

    const client = new s402Client();
    client.register(NETWORK, mockClientScheme());

    const payload = await client.createPayment(requirements);
    const result = await server.process(payload, requirements);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Insufficient balance');
    expect(result.errorCode).toBe('VERIFICATION_FAILED');
  });

  it('HTTP header roundtrip preserves all data through the full wire format', () => {
    // Simulate the full HTTP exchange using headers
    const requirements: s402PaymentRequirements = {
      s402Version: S402_VERSION,
      accepts: ['exact', 'stream'],
      network: 'sui:mainnet',
      asset: '0x2::sui::SUI',
      amount: '999999',
      payTo: '0xvendor',
      facilitatorUrl: 'https://facilitator.example.com',
      protocolFeeBps: 25,
      expiresAt: Date.now() + 300_000,
    };

    // Server → Client (402 response)
    const responseHeaders = new Headers();
    responseHeaders.set(S402_HEADERS.PAYMENT_REQUIRED, encodePaymentRequired(requirements));

    // Client reads
    const clientReqs = decodePaymentRequired(
      responseHeaders.get(S402_HEADERS.PAYMENT_REQUIRED)!,
    );
    expect(clientReqs.amount).toBe('999999');
    expect(clientReqs.protocolFeeBps).toBe(25);
    expect(clientReqs.expiresAt).toBe(requirements.expiresAt);
    expect(clientReqs.accepts).toEqual(['exact', 'stream']);

    // Client → Server (payment)
    const payload: s402PaymentPayload = {
      s402Version: S402_VERSION,
      scheme: 'exact',
      payload: { transaction: 'real-tx-bytes', signature: 'real-sig' },
    };
    const requestHeaders = new Headers();
    requestHeaders.set(S402_HEADERS.PAYMENT, encodePaymentPayload(payload));

    // Server reads
    const serverPayload = decodePaymentPayload(
      requestHeaders.get(S402_HEADERS.PAYMENT)!,
    );
    expect(serverPayload.scheme).toBe('exact');
    if (serverPayload.scheme === 'exact') {
      expect(serverPayload.payload.transaction).toBe('real-tx-bytes');
    }

    // Server → Client (settlement response)
    const settle: s402SettleResponse = {
      success: true,
      txDigest: 'DigestXYZ',
      finalityMs: 420,
    };
    const settleHeaders = new Headers();
    settleHeaders.set(S402_HEADERS.PAYMENT_RESPONSE, encodeSettleResponse(settle));

    const clientSettle = decodeSettleResponse(
      settleHeaders.get(S402_HEADERS.PAYMENT_RESPONSE)!,
    );
    expect(clientSettle.success).toBe(true);
    expect(clientSettle.txDigest).toBe('DigestXYZ');
  });
});
