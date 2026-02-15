/**
 * s402 Facilitator — dispatches to scheme-specific verify + settle
 *
 * Each scheme has its own verify logic. The facilitator acts as a dispatcher,
 * routing to the correct scheme implementation based on the payload's scheme field.
 *
 * Critical design decision: exact verify ≠ stream verify ≠ escrow verify.
 * The facilitator does NOT share verification logic across schemes.
 */

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402VerifyResponse,
  s402SettleResponse,
  s402Scheme,
} from './types.js';
import type { s402FacilitatorScheme } from './scheme.js';
import { s402Error } from './errors.js';

export class s402Facilitator {
  private schemes = new Map<string, Map<s402Scheme, s402FacilitatorScheme>>();

  /**
   * Register a scheme-specific facilitator for a network.
   */
  register(network: string, scheme: s402FacilitatorScheme): this {
    if (!this.schemes.has(network)) {
      this.schemes.set(network, new Map());
    }
    this.schemes.get(network)!.set(scheme.scheme, scheme);
    return this;
  }

  /**
   * Verify a payment payload by dispatching to the correct scheme.
   */
  async verify(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402VerifyResponse> {
    const scheme = this.resolveScheme(payload.scheme, requirements.network);
    return scheme.verify(payload, requirements);
  }

  /**
   * Settle a payment by dispatching to the correct scheme.
   */
  async settle(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402SettleResponse> {
    const scheme = this.resolveScheme(payload.scheme, requirements.network);
    return scheme.settle(payload, requirements);
  }

  /**
   * Expiration-guarded verify + settle in one call.
   * Rejects expired requirements, verifies the payload, then settles.
   *
   * Note: True atomicity comes from Sui's PTBs in the scheme implementation,
   * not from this method. This method provides the expiration guard and
   * sequential verify→settle orchestration.
   */
  async process(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402SettleResponse> {
    // Reject expired requirements before doing any work
    if (requirements.expiresAt != null && Date.now() > requirements.expiresAt) {
      return {
        success: false,
        error: `Payment requirements expired at ${new Date(requirements.expiresAt).toISOString()}`,
        errorCode: 'REQUIREMENTS_EXPIRED',
      };
    }

    const scheme = this.resolveScheme(payload.scheme, requirements.network);

    // Verify first
    const verifyResult = await scheme.verify(payload, requirements);
    if (!verifyResult.valid) {
      return {
        success: false,
        error: verifyResult.invalidReason ?? 'Payment verification failed',
        errorCode: 'VERIFICATION_FAILED',
      };
    }

    // Then settle
    return scheme.settle(payload, requirements);
  }

  /**
   * Check if a scheme is supported for a network.
   */
  supports(network: string, scheme: s402Scheme): boolean {
    return this.schemes.get(network)?.has(scheme) ?? false;
  }

  /**
   * List supported schemes for a network.
   */
  supportedSchemes(network: string): s402Scheme[] {
    const networkSchemes = this.schemes.get(network);
    return networkSchemes ? [...networkSchemes.keys()] : [];
  }

  private resolveScheme(scheme: s402Scheme, network: string): s402FacilitatorScheme {
    const networkSchemes = this.schemes.get(network);
    if (!networkSchemes) {
      throw new s402Error(
        'NETWORK_MISMATCH',
        `No facilitator schemes registered for network "${network}"`,
      );
    }

    const impl = networkSchemes.get(scheme);
    if (!impl) {
      throw new s402Error(
        'SCHEME_NOT_SUPPORTED',
        `Scheme "${scheme}" is not supported on network "${network}". ` +
        `Supported: [${[...networkSchemes.keys()].join(', ')}]`,
      );
    }

    return impl;
  }
}
