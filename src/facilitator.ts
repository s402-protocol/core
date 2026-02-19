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
  private inFlight = new Set<string>();

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
   * Includes expiration guard and scheme-mismatch check.
   */
  async verify(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402VerifyResponse> {
    // Reject non-number expiresAt (defense-in-depth: matches process() guard)
    if (requirements.expiresAt != null) {
      if (typeof requirements.expiresAt !== 'number' || !Number.isFinite(requirements.expiresAt)) {
        return {
          valid: false,
          invalidReason: `Invalid expiresAt value: expected finite number, got ${typeof requirements.expiresAt}`,
        };
      }
      if (Date.now() > requirements.expiresAt) {
        return {
          valid: false,
          invalidReason: `Payment requirements expired at ${new Date(requirements.expiresAt).toISOString()}`,
        };
      }
    }

    // Cross-check: payload scheme must be in requirements.accepts
    if (requirements.accepts && requirements.accepts.length > 0) {
      if (!requirements.accepts.includes(payload.scheme)) {
        return {
          valid: false,
          invalidReason: `Scheme "${payload.scheme}" is not accepted by these requirements. Accepted: [${requirements.accepts.join(', ')}]`,
        };
      }
    }

    // H-1: Wrap in try/catch — resolveScheme throws s402Error on unknown network/scheme
    try {
      const scheme = this.resolveScheme(payload.scheme, requirements.network);
      return scheme.verify(payload, requirements);
    } catch (e) {
      if (e instanceof s402Error) {
        return { valid: false, invalidReason: e.message };
      }
      return { valid: false, invalidReason: 'Unexpected error resolving scheme' };
    }
  }

  /**
   * Settle a payment by dispatching to the correct scheme.
   * Includes expiration guard and scheme-mismatch check.
   */
  async settle(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402SettleResponse> {
    // Reject non-number expiresAt (defense-in-depth: matches process() guard)
    if (requirements.expiresAt != null) {
      if (typeof requirements.expiresAt !== 'number' || !Number.isFinite(requirements.expiresAt)) {
        return {
          success: false,
          error: `Invalid expiresAt value: expected finite number, got ${typeof requirements.expiresAt}`,
          errorCode: 'INVALID_PAYLOAD',
        };
      }
      if (Date.now() > requirements.expiresAt) {
        return {
          success: false,
          error: `Payment requirements expired at ${new Date(requirements.expiresAt).toISOString()}`,
          errorCode: 'REQUIREMENTS_EXPIRED',
        };
      }
    }

    // Cross-check: payload scheme must be in requirements.accepts
    if (requirements.accepts && requirements.accepts.length > 0) {
      if (!requirements.accepts.includes(payload.scheme)) {
        return {
          success: false,
          error: `Scheme "${payload.scheme}" is not accepted by these requirements. Accepted: [${requirements.accepts.join(', ')}]`,
          errorCode: 'SCHEME_NOT_SUPPORTED',
        };
      }
    }

    // H-1: Wrap in try/catch — resolveScheme throws s402Error on unknown network/scheme
    try {
      const scheme = this.resolveScheme(payload.scheme, requirements.network);
      return scheme.settle(payload, requirements);
    } catch (e) {
      if (e instanceof s402Error) {
        return { success: false, error: e.message, errorCode: e.code };
      }
      return { success: false, error: 'Unexpected error resolving scheme', errorCode: 'SCHEME_NOT_SUPPORTED' };
    }
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
    // Reject expired requirements before doing any work.
    // Type check defends against string/NaN expiresAt from untrusted JSON
    // (Date.now() > "never" is false in JS, silently bypassing the check).
    if (requirements.expiresAt != null) {
      if (typeof requirements.expiresAt !== 'number' || !Number.isFinite(requirements.expiresAt)) {
        return {
          success: false,
          error: `Invalid expiresAt value: expected finite number, got ${typeof requirements.expiresAt}`,
          errorCode: 'INVALID_PAYLOAD',
        };
      }
      if (Date.now() > requirements.expiresAt) {
        return {
          success: false,
          error: `Payment requirements expired at ${new Date(requirements.expiresAt).toISOString()}`,
          errorCode: 'REQUIREMENTS_EXPIRED',
        };
      }
    }

    // Cross-check: payload scheme must be in requirements.accepts
    if (requirements.accepts && requirements.accepts.length > 0) {
      if (!requirements.accepts.includes(payload.scheme)) {
        return {
          success: false,
          error: `Scheme "${payload.scheme}" is not accepted by these requirements. Accepted: [${requirements.accepts.join(', ')}]`,
          errorCode: 'SCHEME_NOT_SUPPORTED',
        };
      }
    }

    // H-1: Wrap resolveScheme in try/catch — throws s402Error on unknown network/scheme
    let scheme: s402FacilitatorScheme;
    try {
      scheme = this.resolveScheme(payload.scheme, requirements.network);
    } catch (e) {
      if (e instanceof s402Error) {
        return { success: false, error: e.message, errorCode: e.code };
      }
      return { success: false, error: 'Failed to resolve payment scheme', errorCode: 'SCHEME_NOT_SUPPORTED' };
    }

    // H-2: Deduplicate concurrent identical payloads — prevents free resource access
    // if two identical requests arrive before either reaches scheme.settle()
    const dedupeKey = JSON.stringify(payload);
    if (this.inFlight.has(dedupeKey)) {
      return { success: false, error: 'Duplicate payment request already in flight', errorCode: 'INVALID_PAYLOAD' };
    }
    this.inFlight.add(dedupeKey);

    try {
      // H-1 + H-3: Verify with timeout to prevent hanging RPC calls from exhausting the event loop
      let verifyResult: s402VerifyResponse;
      try {
        verifyResult = await Promise.race([
          scheme.verify(payload, requirements),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Verification timed out after 5s')), 5_000)
          ),
        ]);
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : 'Verification threw an unexpected error',
          errorCode: 'VERIFICATION_FAILED',
        };
      }

      if (!verifyResult.valid) {
        return {
          success: false,
          error: verifyResult.invalidReason ?? 'Payment verification failed',
          errorCode: 'VERIFICATION_FAILED',
        };
      }

      // Latency guard: if the dry-run took a long time, don't waste gas on stale requirements.
      // Note: this is NOT a TOCTOU fix — Sui PTBs are atomic. This just avoids broadcasting
      // a transaction for requirements the server has already expired.
      // Type already validated above, so only check expiration here.
      if (typeof requirements.expiresAt === 'number' && Date.now() > requirements.expiresAt) {
        return {
          success: false,
          error: `Payment requirements expired during verification at ${new Date(requirements.expiresAt).toISOString()}`,
          errorCode: 'REQUIREMENTS_EXPIRED',
        };
      }

      // H-1 + H-3 + M-5: Settle with timeout; SETTLEMENT_FAILED is retryable (transient RPC errors)
      try {
        return await Promise.race([
          scheme.settle(payload, requirements),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Settlement timed out after 15s')), 15_000)
          ),
        ]);
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : 'Settlement failed with an unexpected error',
          errorCode: 'SETTLEMENT_FAILED',
        };
      }
    } finally {
      this.inFlight.delete(dedupeKey);
    }
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
