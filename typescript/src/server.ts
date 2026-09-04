/**
 * s402 Resource Server — 402 response generation + payment processing
 *
 * The server builds payment requirements for routes and processes
 * incoming payment payloads through the facilitator.
 */

import type {
  s402PaymentRequired,
  s402PaymentRequirements,
  s402ResourceInfo,
  s402PaymentPayload,
  s402VerifyResponse,
  s402SettleResponse,
  s402Scheme,
} from './types.js';

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
   * Build ONE payment requirement — a single `accepts[]` entry — for a route.
   *
   * Uses the first scheme in the config's `schemes` array. To emit a 402 you
   * want {@link buildPaymentRequired}, which wraps one or more of these in the
   * x402 V2 envelope the wire actually carries.
   *
   * @param config - Per-route payment configuration (schemes, price, network, payTo, asset)
   * @param scheme - Override the scheme to build for (defaults to `config.schemes[0]`)
   * @throws {s402Error} `INVALID_PAYLOAD` if price is not a valid non-negative integer string
   *
   * @example
   * ```ts
   * const requirement = server.buildRequirements({
   *   schemes: ['exact'],
   *   price: '1000000',
   *   network: 'your-chain:mainnet',
   *   payTo: 'YOUR_ADDRESS',
   *   asset: 'NATIVE_TOKEN',
   * });
   * ```
   */
  buildRequirements(config: s402RouteConfig, scheme?: s402Scheme): s402PaymentRequirements {
    // Validate price early — catch bad config before it reaches the wire
    if (!isValidAmount(config.price)) {
      throw new s402Error('INVALID_PAYLOAD',
        `Invalid price "${config.price}": must be a non-negative integer string`);
    }

    const target = scheme ?? config.schemes[0] ?? 'exact';
    const schemeImpl = this.schemes.get(config.network)?.get(target);
    if (schemeImpl) {
      // A scheme implementation owns its own extras; it does not get to change
      // which scheme the entry is for.
      return { ...schemeImpl.buildRequirements(config), scheme: target };
    }

    // Fallback: build generic requirements
    return {
      scheme: target,
      network: config.network,
      asset: config.asset,
      amount: config.price,
      payTo: config.payTo,
      facilitatorUrl: config.facilitatorUrl,
      protocolFeeBps: config.protocolFeeBps,
      receiptRequired: config.receiptRequired,
      settlementMode: config.settlementMode,
      upto: config.upto,
      prepaid: config.prepaid,
      stream: config.stream,
      escrow: config.escrow,
      unlock: config.unlock,
    };
  }

  /**
   * Build the 402 document for a route: an x402 V2 `PaymentRequired` envelope
   * with one `accepts[]` entry per offered scheme.
   *
   * **`exact` is always offered and always first.** x402's client pays the
   * first entry it has a handler for, so an `exact` entry anywhere else is an
   * entry an x402 client walks past. The old flat shape enforced the same
   * invariant by forcing `'exact'` into `accepts`; this is where it lives now.
   *
   * @param config - Per-route payment configuration
   * @param resource - What is being paid for. Required by x402's V2 envelope.
   *
   * @example
   * ```ts
   * const required = server.buildPaymentRequired(
   *   { schemes: ['prepaid'], price: '1000000', network: 'sui:mainnet', payTo: '0x…', asset: '0x2::sui::SUI' },
   *   { url: 'https://api.example.com/paid' },
   * );
   * // required.accepts.map(a => a.scheme) === ['exact', 'prepaid']
   * ```
   */
  buildPaymentRequired(config: s402RouteConfig, resource: s402ResourceInfo): s402PaymentRequired {
    const schemes: s402Scheme[] = [...new Set<s402Scheme>(['exact', ...config.schemes])];
    const required: s402PaymentRequired = {
      x402Version: 2,
      resource,
      accepts: schemes.map((scheme) => this.buildRequirements(config, scheme)),
    };
    if (config.mandate) {
      required.mandate = { required: config.mandate.required, minPerTx: config.mandate.minPerTx };
    }
    return required;
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
   *
   * @param payload - Client's payment payload (from the `x-payment` header)
   * @param requirements - The requirements this server originally sent
   * @returns Settlement result with txDigest on success
   * @throws {s402Error} `FACILITATOR_UNAVAILABLE` if no facilitator is configured
   *
   * @example
   * ```ts
   * const result = await server.process(payload, requirements);
   * if (result.success) {
   *   // Serve the protected resource
   *   res.status(200).json({ data: 'paid content' });
   * }
   * ```
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
