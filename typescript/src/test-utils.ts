/**
 * s402 Test Utilities — mock scheme implementations for integration testing.
 *
 * Use these to test your s402 integration without a Sui connection or any
 * chain-specific dependencies. Each factory creates a scheme that operates
 * entirely in-memory.
 *
 * @example
 * ```ts
 * import { s402Client, s402Facilitator } from 's402';
 * import { mockExactClientScheme, mockExactFacilitatorScheme } from 's402/test-utils';
 *
 * const client = new s402Client();
 * client.register('sui:testnet', mockExactClientScheme());
 *
 * const facilitator = new s402Facilitator();
 * facilitator.register('sui:testnet', mockExactFacilitatorScheme());
 * ```
 *
 * @packageDocumentation
 */

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402ExactPayload,
  s402VerifyResponse,
  s402SettleResponse,
} from './types.js';
import { S402_VERSION } from './types.js';
import type {
  s402ClientScheme,
  s402ServerScheme,
  s402FacilitatorScheme,
  s402RouteConfig,
} from './scheme.js';

/**
 * Create a mock client scheme for the `exact` payment type.
 *
 * Produces payloads with deterministic transaction/signature strings
 * derived from the requirements (amount + payTo). Useful for testing
 * the client→server→facilitator flow without real keys.
 *
 * @example
 * ```ts
 * const client = new s402Client();
 * client.register('sui:testnet', mockExactClientScheme());
 *
 * const payload = await client.createPayment(requirements);
 * // payload.payload.transaction === 'mock-pay-1000000-to-0xabc...'
 * ```
 */
export function mockExactClientScheme(): s402ClientScheme {
  return {
    scheme: 'exact',
    async createPayment(
      requirements: s402PaymentRequirements,
    ): Promise<s402PaymentPayload> {
      return {
        s402Version: S402_VERSION,
        scheme: 'exact',
        payload: {
          transaction: `mock-pay-${requirements.amount}-to-${requirements.payTo}`,
          signature: 'mock-signature',
        },
      };
    },
  };
}

/**
 * Create a mock facilitator scheme for the `exact` payment type.
 *
 * Verifies that the payload's transaction string matches the expected
 * format from `mockExactClientScheme()`. Settle always succeeds with
 * a deterministic digest.
 *
 * Pair this with `mockExactClientScheme()` for end-to-end testing.
 *
 * @param options.txDigest - Custom transaction digest (default: 'mock-tx-digest')
 * @param options.finalityMs - Custom finality time (default: 400)
 * @param options.verifyFn - Override the verify function for custom behavior
 * @param options.settleFn - Override the settle function for custom behavior
 *
 * @example
 * ```ts
 * const facilitator = new s402Facilitator();
 * facilitator.register('sui:testnet', mockExactFacilitatorScheme());
 *
 * const result = await facilitator.process(payload, requirements);
 * // result.success === true
 * // result.txDigest === 'mock-tx-digest'
 * ```
 */
export function mockExactFacilitatorScheme(options?: {
  txDigest?: string;
  finalityMs?: number;
  verifyFn?: (payload: s402PaymentPayload, requirements: s402PaymentRequirements) => Promise<s402VerifyResponse>;
  settleFn?: (payload: s402PaymentPayload, requirements: s402PaymentRequirements) => Promise<s402SettleResponse>;
}): s402FacilitatorScheme {
  const txDigest = options?.txDigest ?? 'mock-tx-digest';
  const finalityMs = options?.finalityMs ?? 400;

  return {
    scheme: 'exact',
    async verify(payload, requirements) {
      if (options?.verifyFn) return options.verifyFn(payload, requirements);

      if (payload.scheme !== 'exact') {
        return { valid: false, invalidReason: `Expected exact scheme, got ${payload.scheme}` };
      }
      const exact = payload as s402ExactPayload;
      const expectedTx = `mock-pay-${requirements.amount}-to-${requirements.payTo}`;
      if (exact.payload.transaction !== expectedTx) {
        return { valid: false, invalidReason: 'Transaction does not match expected mock format' };
      }
      return { valid: true, payerAddress: '0xmock-payer' };
    },
    async settle(payload, requirements) {
      if (options?.settleFn) return options.settleFn(payload, requirements);

      return { success: true, txDigest, finalityMs };
    },
  };
}

/**
 * Create a mock server scheme for the `exact` payment type.
 *
 * Builds payment requirements from a route config. Useful for testing
 * server middleware without chain-specific adapters.
 *
 * @example
 * ```ts
 * const server = new s402ResourceServer();
 * server.register('sui:testnet', mockExactServerScheme());
 *
 * const requirements = server.buildRequirements({
 *   schemes: ['exact'],
 *   price: '1000000',
 *   network: 'sui:testnet',
 *   payTo: '0xabc...',
 *   asset: 'SUI',
 * });
 * ```
 */
export function mockExactServerScheme(): s402ServerScheme {
  return {
    scheme: 'exact',
    buildRequirements(config: s402RouteConfig): s402PaymentRequirements {
      return {
        s402Version: S402_VERSION,
        accepts: [...new Set([...config.schemes, 'exact' as const])],
        network: config.network,
        asset: config.asset,
        amount: config.price,
        payTo: config.payTo,
        facilitatorUrl: config.facilitatorUrl,
        protocolFeeBps: config.protocolFeeBps,
        receiptRequired: config.receiptRequired,
        settlementMode: config.settlementMode,
      };
    },
  };
}
