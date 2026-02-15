/**
 * s402 Client — scheme registry + payment creation
 *
 * The client holds registered payment schemes and creates payment payloads
 * based on server requirements. It auto-selects the best scheme from the
 * server's `accepts` array.
 */

import type { s402PaymentRequirements, s402PaymentPayload, s402Scheme } from './types.js';
import type { s402ClientScheme } from './scheme.js';
import { s402Error } from './errors.js';
import { normalizeRequirements } from './compat.js';

export class s402Client {
  private schemes = new Map<string, Map<s402Scheme, s402ClientScheme>>();

  /**
   * Register a scheme implementation for a network.
   *
   * @param network - Sui network (e.g., "sui:testnet")
   * @param scheme - Scheme implementation
   */
  register(network: string, scheme: s402ClientScheme): this {
    if (!this.schemes.has(network)) {
      this.schemes.set(network, new Map());
    }
    this.schemes.get(network)!.set(scheme.scheme, scheme);
    return this;
  }

  /**
   * Create a payment payload for the given requirements.
   *
   * Auto-selects the best scheme: prefers the first scheme in the server's
   * `accepts` array that we have a registered implementation for.
   */
  async createPayment(
    requirementsOrRaw: s402PaymentRequirements | Record<string, unknown>,
  ): Promise<s402PaymentPayload> {
    // Always validate through normalizeRequirements — even typed s402 input
    // could be from JSON.parse of untrusted network data at runtime.
    const requirements = normalizeRequirements(
      requirementsOrRaw as Record<string, unknown>,
    );

    const networkSchemes = this.schemes.get(requirements.network);
    if (!networkSchemes) {
      throw new s402Error(
        'NETWORK_MISMATCH',
        `No schemes registered for network "${requirements.network}"`,
      );
    }

    // Find the first accepted scheme we support
    for (const accepted of requirements.accepts) {
      const scheme = networkSchemes.get(accepted);
      if (scheme) {
        return scheme.createPayment(requirements);
      }
    }

    throw new s402Error(
      'SCHEME_NOT_SUPPORTED',
      `No registered scheme matches server's accepts: [${requirements.accepts.join(', ')}]`,
    );
  }

  /**
   * Check if we can handle requirements for a given network.
   */
  supports(network: string, scheme: s402Scheme): boolean {
    return this.schemes.get(network)?.has(scheme) ?? false;
  }
}
