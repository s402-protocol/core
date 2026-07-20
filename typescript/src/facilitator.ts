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
import { canonicalizeToString } from './canonicalization.js';
import type { s402FacilitatorExtension, s402ExtensionErrorHandler } from './extensions.js';
import { s402ExtensionRegistry, runExtensionHooks } from './extensions.js';

/**
 * Options for `s402Facilitator.process()`.
 *
 * Callers can tune the verify→settle pipeline per-request.
 */
export interface s402ProcessOptions {
  /**
   * Skip the verify() dry-run and go straight to settle().
   *
   * On chains where failed transactions cost zero gas (e.g., Sui PTBs revert
   * atomically with no gas charge), the dry-run is pure latency overhead — it
   * adds a full RPC round-trip (~200-400ms) just to predict what settle() will
   * discover anyway. Setting `skipVerify: true` eliminates that round-trip.
   *
   * When `true`, process() still performs: expiration checks, scheme-mismatch
   * checks, deduplication, and settle timeout. Only the dry-run is skipped.
   *
   * **Use when:** your chain adapter knows failures are free (Sui, Aptos).
   * **Don't use when:** failed settlements cost gas (EVM L1s) — the dry-run
   * saves real money by catching bad txs before broadcast.
   *
   * @default false
   */
  skipVerify?: boolean;

  /**
   * Caller-supplied idempotency key (e.g., from an `Idempotency-Key` HTTP
   * header). When present, this string becomes the dedup cache key instead of
   * the auto-computed payload fingerprint.
   *
   * Semantics (Stripe-compatible):
   * - Same key + same payload → returns the cached original result (retry dedup)
   * - Same key while first call is in flight → awaits the in-flight promise (concurrent dedup)
   * - Key collisions across distinct payloads are the caller's responsibility
   *
   * Omit this field to fall back to payload-based dedup (JSON fingerprint).
   */
  idempotencyKey?: string;
}

/**
 * Constructor options for `s402Facilitator`.
 */
export interface s402FacilitatorOptions {
  /**
   * How long a completed result stays in the retry-dedup cache, in milliseconds.
   * A retry arriving within this window returns the cached original result
   * instead of re-executing. Tune based on your client's retry budget.
   *
   * @default 300_000 (5 minutes)
   */
  dedupTtlMs?: number;

  /**
   * Maximum entries retained in the retry-dedup cache. When the cache exceeds
   * this size, the oldest entry (by insertion order) is evicted. Bound memory
   * under high request volume; higher values retain more retry history.
   *
   * @default 10_000
   */
  dedupMaxEntries?: number;
}

type DedupCached = {
  result: s402SettleResponse;
  expiresAt: number;
};

export class s402Facilitator {
  private schemes = new Map<string, Map<s402Scheme, s402FacilitatorScheme>>();
  private inFlight = new Map<string, Promise<s402SettleResponse>>();
  private completed = new Map<string, DedupCached>();
  private dedupTtlMs: number;
  private dedupMaxEntries: number;
  private extensionRegistry = new s402ExtensionRegistry<s402FacilitatorExtension>();
  private extensionErrorHandler?: s402ExtensionErrorHandler;

  constructor(options: s402FacilitatorOptions = {}) {
    this.dedupTtlMs = options.dedupTtlMs ?? 300_000;
    this.dedupMaxEntries = options.dedupMaxEntries ?? 10_000;
  }

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
   * Register a facilitator extension. Extensions fire in dependency order
   * at four points in the process() pipeline: beforeVerify, afterVerify,
   * beforeSettle, afterSettle.
   *
   * @throws {s402Error} `EXTENSION_FAILED` on duplicate key or dependency cycle
   */
  registerExtension(ext: s402FacilitatorExtension): this {
    this.extensionRegistry.register(ext);
    return this;
  }

  /**
   * Set the handler for advisory (non-critical) extension failures.
   * Critical extensions always throw; advisory extensions call this handler.
   */
  onExtensionError(handler: s402ExtensionErrorHandler): this {
    this.extensionErrorHandler = handler;
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
   * Expiration-guarded verify + settle in one call. **This is the recommended path.**
   * Rejects expired requirements, verifies the payload, then settles.
   * Includes deduplication (prevents concurrent identical requests) and timeouts
   * (5s verify, 15s settle).
   *
   * Note: True atomicity comes from Sui's PTBs in the scheme implementation,
   * not from this method. This method provides the expiration guard and
   * sequential verify-then-settle orchestration.
   *
   * @param payload - Client's payment payload
   * @param requirements - Server's payment requirements
   * @param options - Optional process configuration (e.g., `{ skipVerify: true }` for zero-cost-failure chains)
   * @returns Settlement result (check `result.success` and `result.errorCode`)
   *
   * @example
   * ```ts
   * import { s402Facilitator } from 's402';
   *
   * const facilitator = new s402Facilitator();
   * facilitator.register('sui:mainnet', exactFacilitatorScheme);
   *
   * const result = await facilitator.process(payload, requirements);
   * if (result.success) {
   *   console.log(result.txDigest); // Sui transaction digest
   * } else {
   *   console.log(result.errorCode); // e.g. 'VERIFICATION_FAILED'
   * }
   * ```
   */
  async process(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
    options?: s402ProcessOptions,
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

    // Dedup key: caller-supplied Idempotency-Key wins, else payload fingerprint.
    // Fingerprint uses canonical form (ADR-007 §idempotency) so the key is
    // order-independent even for direct process() callers that hand-build the
    // payload — the decodePaymentPayload() path already had stable key order,
    // but nothing forces callers through that path.
    const dedupeKey = options?.idempotencyKey ?? canonicalizeToString(payload);

    // Retry dedup: returning a cached result for a previously-completed request
    // is Stripe-standard idempotency. Without this, a retry after a successful
    // settle() would pay twice.
    const cached = this.getCached(dedupeKey);
    if (cached) {
      return cached;
    }

    // Concurrent dedup: a second call arriving while the first is in flight
    // awaits the same promise. Both callers see the same result — no double-spend,
    // no bogus error. This replaces the previous "return error for duplicate"
    // behavior, which surprised retrying clients.
    const inFlight = this.inFlight.get(dedupeKey);
    if (inFlight) {
      return inFlight;
    }

    const resultPromise = this.executeProcess(payload, requirements, scheme, options).then(
      (result) => {
        this.cacheResult(dedupeKey, result);
        return result;
      },
    );
    this.inFlight.set(dedupeKey, resultPromise);

    try {
      return await resultPromise;
    } finally {
      this.inFlight.delete(dedupeKey);
    }
  }

  private async executeProcess(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
    scheme: s402FacilitatorScheme,
    options?: s402ProcessOptions,
  ): Promise<s402SettleResponse> {
    // Get sorted extensions once (cached after first call, zero-cost when empty)
    const extensions = this.extensionRegistry.size > 0
      ? this.extensionRegistry.sorted()
      : null;

    // V6 optimization: skip verify dry-run when caller knows failures are free.
    // All pre-flight checks (expiration, scheme-mismatch, dedup) still run above.
    if (!options?.skipVerify) {
      // Extension hook: beforeVerify (rate limiting, allowlisting, pre-checks)
      if (extensions) {
        try {
          await runExtensionHooks(extensions, 'beforeVerify',
            (ext) => ext.beforeVerify ? ext.beforeVerify(payload, requirements) : Promise.resolve(),
            this.extensionErrorHandler);
        } catch (e) {
          if (e instanceof s402Error) return { success: false, error: e.message, errorCode: e.code };
          return { success: false, error: 'Extension beforeVerify failed', errorCode: 'EXTENSION_FAILED' };
        }
      }

      // H-1 + H-3: Verify with timeout to prevent hanging RPC calls from exhausting the event loop
      let verifyResult: s402VerifyResponse;
      try {
        let verifyTimer: ReturnType<typeof setTimeout>;
        verifyResult = await Promise.race([
          scheme.verify(payload, requirements),
          new Promise<never>((_, reject) => {
            verifyTimer = setTimeout(() => reject(new Error('Verification timed out after 5s')), 5_000);
          }),
        ]).finally(() => clearTimeout(verifyTimer));
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

      // Extension hook: afterVerify (logging, metrics, post-verification checks)
      if (extensions) {
        try {
          await runExtensionHooks(extensions, 'afterVerify',
            (ext) => ext.afterVerify ? ext.afterVerify(payload, verifyResult) : Promise.resolve(),
            this.extensionErrorHandler);
        } catch (e) {
          if (e instanceof s402Error) return { success: false, error: e.message, errorCode: e.code };
          return { success: false, error: 'Extension afterVerify failed', errorCode: 'EXTENSION_FAILED' };
        }
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
    }

    // Extension hook: beforeSettle (final fraud checks, balance confirmation)
    if (extensions) {
      try {
        await runExtensionHooks(extensions, 'beforeSettle',
          (ext) => ext.beforeSettle ? ext.beforeSettle(payload, requirements) : Promise.resolve(),
          this.extensionErrorHandler);
      } catch (e) {
        if (e instanceof s402Error) return { success: false, error: e.message, errorCode: e.code };
        return { success: false, error: 'Extension beforeSettle failed', errorCode: 'EXTENSION_FAILED' };
      }
    }

    // H-1 + H-3 + M-5: Settle with timeout; SETTLEMENT_FAILED is retryable (transient RPC errors)
    let settleResult: s402SettleResponse;
    try {
      let settleTimer: ReturnType<typeof setTimeout>;
      settleResult = await Promise.race([
        scheme.settle(payload, requirements),
        new Promise<never>((_, reject) => {
          settleTimer = setTimeout(() => reject(new Error('Settlement timed out after 15s')), 15_000);
        }),
      ]).finally(() => clearTimeout(settleTimer));
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : 'Settlement failed with an unexpected error',
        errorCode: 'SETTLEMENT_FAILED',
      };
    }

    // Extension hook: afterSettle (indexing, receipts, analytics)
    // Only fires on successful settlement — extensions observing failures should
    // use beforeSettle or external monitoring. Post-settle hooks never change the result.
    if (extensions && settleResult.success) {
      try {
        await runExtensionHooks(extensions, 'afterSettle',
          (ext) => ext.afterSettle ? ext.afterSettle(payload, settleResult) : Promise.resolve(),
          this.extensionErrorHandler);
      } catch (e) {
        // Even critical extension failure after settle doesn't change the result —
        // the transaction is already on-chain. Forward to error handler for observability
        // but always return the true settle result.
        this.extensionErrorHandler?.({ key: 'afterSettle', version: '0', critical: true }, e);
      }
    }

    return settleResult;
  }

  private getCached(key: string): s402SettleResponse | null {
    const entry = this.completed.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.completed.delete(key);
      return null;
    }
    return entry.result;
  }

  private cacheResult(key: string, result: s402SettleResponse): void {
    this.completed.set(key, {
      result,
      expiresAt: Date.now() + this.dedupTtlMs,
    });
    // LRU eviction: Map iteration is insertion-ordered, so the first key is the
    // oldest. Evict one per insertion to keep size bounded without periodic sweeps.
    if (this.completed.size > this.dedupMaxEntries) {
      const oldestKey = this.completed.keys().next().value;
      if (oldestKey !== undefined) {
        this.completed.delete(oldestKey);
      }
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
