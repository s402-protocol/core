/**
 * s402 Client — scheme registry + payment creation
 *
 * The client holds registered payment schemes and creates payment payloads
 * based on server requirements. It auto-selects the best scheme from the
 * server's `accepts` array.
 */

import type {
  s402PaymentRequired,
  s402PaymentRequirements,
  s402PaymentPayload,
  s402Scheme,
} from './types.js';
import type { s402ClientScheme } from './scheme.js';
import { s402Error } from './errors.js';

export class s402Client {
  private schemes = new Map<string, Map<s402Scheme, s402ClientScheme>>();

  /**
   * Register a scheme implementation for a network.
   *
   * @param network - Network identifier (e.g., "sui:testnet", "sui:mainnet")
   * @param scheme - Scheme implementation (from @sweefi/sui or your own)
   * @returns `this` for chaining
   *
   * @example
   * ```ts
   * import { s402Client } from 's402';
   *
   * const client = new s402Client();
   * client
   *   .register('sui:mainnet', exactScheme)
   *   .register('sui:mainnet', prepaidScheme);
   * ```
   */
  register(network: string, scheme: s402ClientScheme): this {
    if (!this.schemes.has(network)) {
      this.schemes.set(network, new Map());
    }
    this.schemes.get(network)!.set(scheme.scheme, scheme);
    return this;
  }

  /**
   * Create a payment payload for a 402.
   *
   * Pass the whole 402 document and the client picks: the FIRST `accepts[]`
   * entry it has a registered scheme for on that entry's own network. Entries
   * naming a scheme (or a network) this client cannot pay are skipped, not
   * refused — one 402 may legitimately offer `exact` on Sui and something else
   * somewhere else. Pass a single requirement instead to pay exactly that one.
   *
   * A plain x402 V2 402 decodes into the same document, so it works here too.
   *
   * @param input - The decoded 402 document, or one `accepts[]` entry from it
   * @returns Payment payload ready to send in the `x-payment` header
   * @throws {s402Error} `NETWORK_MISMATCH` if no schemes are registered for the network
   * @throws {s402Error} `SCHEME_NOT_SUPPORTED` if no registered scheme matches any offer
   *
   * @example
   * ```ts
   * import { s402Client, decodePaymentRequired, encodePaymentPayload, S402_HEADERS } from 's402';
   *
   * const client = new s402Client();
   * client.register('sui:mainnet', exactScheme);
   *
   * const required = decodePaymentRequired(res.headers.get('payment-required')!);
   * const payload = await client.createPayment(required);
   * fetch(url, { headers: { [S402_HEADERS.PAYMENT]: encodePaymentPayload(payload) } });
   * ```
   */
  async createPayment(
    input: s402PaymentRequired | s402PaymentRequirements,
  ): Promise<s402PaymentPayload> {
    const offers: s402PaymentRequirements[] = 'accepts' in input ? input.accepts : [input];

    // Report the more specific failure when it is the only one available: a
    // caller with nothing registered for the network needs a different message
    // from one whose networks match but whose schemes do not.
    const networksMatched = offers.some((o) => this.schemes.has(o.network));
    if (!networksMatched) {
      throw new s402Error(
        'NETWORK_MISMATCH',
        `No schemes registered for network${offers.length > 1 ? 's' : ''} "${[...new Set(offers.map((o) => o.network))].join('", "')}"`,
      );
    }

    for (const offer of offers) {
      const scheme = this.schemes.get(offer.network)?.get(offer.scheme as s402Scheme);
      if (scheme) return scheme.createPayment(offer);
    }

    throw new s402Error(
      'SCHEME_NOT_SUPPORTED',
      `No registered scheme matches server's accepts: [${offers.map((o) => o.scheme).join(', ')}]`,
    );
  }

  /**
   * Check if we can handle requirements for a given network.
   */
  supports(network: string, scheme: s402Scheme): boolean {
    return this.schemes.get(network)?.has(scheme) ?? false;
  }
}
