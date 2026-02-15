/**
 * s402 Resource Server — 402 response generation + payment processing
 *
 * The server builds payment requirements for routes and processes
 * incoming payment payloads through the facilitator.
 */

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402VerifyResponse,
  s402SettleResponse,
  s402Scheme,
} from './types.js';
import { S402_VERSION } from './types.js';
import type { s402ServerScheme, s402RouteConfig } from './scheme.js';
import type { s402Facilitator } from './facilitator.js';
import { s402Error } from './errors.js';
import { isValidAmount } from './http.js';

export class s402ResourceServer {
  private schemes = new Map<string, Map<s402Scheme, s402ServerScheme>>();
  private facilitator: s402Facilitator | null = null;

  /**
   * Register a server-side scheme for building requirements.
   */
  register(network: string, scheme: s402ServerScheme): this {
    if (!this.schemes.has(network)) {
      this.schemes.set(network, new Map());
    }
    this.schemes.get(network)!.set(scheme.scheme, scheme);
    return this;
  }

  /**
   * Set the facilitator for verify + settle.
   */
  setFacilitator(facilitator: s402Facilitator): this {
    this.facilitator = facilitator;
    return this;
  }

  /**
   * Build payment requirements for a route.
   * Uses the first scheme in the config's schemes array.
   * Always includes "exact" in accepts for x402 compat.
   */
  buildRequirements(config: s402RouteConfig): s402PaymentRequirements {
    // Validate price early — catch bad config before it reaches the wire
    if (!isValidAmount(config.price)) {
      throw new s402Error('INVALID_PAYLOAD',
        `Invalid price "${config.price}": must be a non-negative integer string`);
    }

    const networkSchemes = this.schemes.get(config.network);
    const primaryScheme = config.schemes[0] ?? 'exact';

    // Try scheme-specific builder if available
    const schemeImpl = networkSchemes?.get(primaryScheme);
    if (schemeImpl) {
      const requirements = schemeImpl.buildRequirements(config);
      // Enforce protocol invariant: always include 'exact' for x402 compat
      if (!requirements.accepts.includes('exact')) {
        requirements.accepts = [...requirements.accepts, 'exact'];
      }
      return requirements;
    }

    // Fallback: build generic requirements
    const accepts: s402Scheme[] = [...new Set([...config.schemes, 'exact' as const])];

    return {
      s402Version: S402_VERSION,
      accepts,
      network: config.network,
      asset: config.asset ?? '0x2::sui::SUI',
      amount: config.price,
      payTo: config.payTo,
      facilitatorUrl: config.facilitatorUrl,
      mandate: config.mandate ? { required: config.mandate.required, minPerTx: config.mandate.minPerTx } : undefined,
      protocolFeeBps: config.protocolFeeBps,
      receiptRequired: config.receiptRequired,
      settlementMode: config.settlementMode,
      stream: config.stream,
      escrow: config.escrow,
      unlock: config.unlock,
      prepaid: config.prepaid,
    };
  }

  /**
   * Verify a payment payload.
   */
  async verify(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402VerifyResponse> {
    if (!this.facilitator) {
      throw new s402Error('FACILITATOR_UNAVAILABLE', 'No facilitator configured on this server');
    }
    return this.facilitator.verify(payload, requirements);
  }

  /**
   * Settle a pre-verified payment payload (no verify, no expiration check).
   * Prefer `process()` for the full guarded path.
   */
  async settle(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402SettleResponse> {
    if (!this.facilitator) {
      throw new s402Error('FACILITATOR_UNAVAILABLE', 'No facilitator configured on this server');
    }
    return this.facilitator.settle(payload, requirements);
  }

  /**
   * Expiration-guarded verify + settle. This is the recommended path.
   * Rejects expired requirements, verifies the payload, then settles.
   * True atomicity comes from Sui PTBs in the scheme implementation.
   */
  async process(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402SettleResponse> {
    if (!this.facilitator) {
      throw new s402Error('FACILITATOR_UNAVAILABLE', 'No facilitator configured on this server');
    }
    return this.facilitator.process(payload, requirements);
  }
}
