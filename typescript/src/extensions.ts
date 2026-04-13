/**
 * s402 Extension System — Typed, Lifecycle-Aware Plugin Architecture
 *
 * Three actor-specific interfaces (client, server, facilitator), each with
 * lifecycle hooks that fire at specific points in the payment flow.
 *
 * Fixes x402's 7 extension flaws:
 *   F1: Typed interfaces (not `unknown` everywhere)
 *   F2: Dependency ordering via topological sort
 *   F3: Facilitator gets 4 hooks (not a passive data bag)
 *   F4: Client `supported` field enables negotiation
 *   F5: No round-trip waste (client sends keys, not schemas)
 *   F6: Transport-agnostic (no `transportContext` parameter)
 *   F7: critical vs advisory error handling
 *
 * See ADR-004 for full design rationale.
 */

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402VerifyResponse,
  s402SettleResponse,
} from './types.js';
import type { s402RouteConfig } from './scheme.js';
import { s402Error } from './errors.js';

// ══════════════════════════════════════════════════════════════
// Extension interfaces
// ══════════════════════════════════════════════════════════════

/**
 * Base extension interface. All three actor-specific interfaces extend this.
 *
 * Extensions use reverse-domain keys (per ADR-001 §4a) to avoid conflicts:
 * e.g., "org.s402.discovery", "com.mycompany.ratelimit".
 */
export interface s402Extension {
  /** Reverse-domain key: e.g., "org.s402.discovery" */
  readonly key: string;
  /** Semver version (per ADR-001 §4b) */
  readonly version: string;
  /**
   * If true, failure in this extension blocks the payment flow.
   * If false, failure is logged but doesn't block (advisory).
   */
  readonly critical: boolean;
  /** Keys of extensions that must run before this one. */
  readonly dependsOn?: string[];
}

/**
 * Client-side extension.
 * Hooks fire during payment creation and settlement verification.
 */
export interface s402ClientExtension extends s402Extension {
  /** Enrich the payment payload before sending. */
  enrichPayload?(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402PaymentPayload>;

  /** Process extension data from the settle response. */
  onSettlement?(
    response: s402SettleResponse,
    payload: s402PaymentPayload,
  ): Promise<void>;
}

/**
 * Server-side extension (resource server).
 * Hooks fire during requirements building and settlement response.
 */
export interface s402ServerExtension extends s402Extension {
  /** Enrich payment requirements before sending the 402 response. */
  enrichRequirements?(
    requirements: s402PaymentRequirements,
    config: s402RouteConfig,
  ): s402PaymentRequirements;

  /** Enrich the settlement response before returning to client. */
  enrichSettleResponse?(
    response: s402SettleResponse,
    payload: s402PaymentPayload,
  ): Promise<s402SettleResponse>;
}

/**
 * Facilitator-side extension.
 * Hooks fire during the verify→settle pipeline.
 *
 * Four hooks covering every phase:
 *   beforeVerify → verify() → afterVerify → beforeSettle → settle() → afterSettle
 */
export interface s402FacilitatorExtension extends s402Extension {
  /** Called before verify(). Can reject by throwing. */
  beforeVerify?(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<void>;

  /** Called after successful verify(), before settle(). */
  afterVerify?(
    payload: s402PaymentPayload,
    verifyResult: s402VerifyResponse,
  ): Promise<void>;

  /** Called before settle(). Last chance to abort. */
  beforeSettle?(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<void>;

  /** Called after successful settle() only (not on settlement failure).
   *  Failures here never change the settle result — the tx is already on-chain. */
  afterSettle?(
    payload: s402PaymentPayload,
    settleResult: s402SettleResponse,
  ): Promise<void>;
}

// ══════════════════════════════════════════════════════════════
// Extension data helpers
// ══════════════════════════════════════════════════════════════

/**
 * Type-safe extension data retrieval.
 *
 * The wire format is `Record<string, unknown>` for interop, but this helper
 * provides typed access for TypeScript consumers.
 *
 * @example
 * ```ts
 * interface DiscoveryData { services: string[] }
 * const data = getExtensionData<DiscoveryData>(requirements.extensions, 'org.s402.discovery');
 * if (data) console.log(data.services);
 * ```
 */
export function getExtensionData<T>(
  extensions: Record<string, unknown> | undefined,
  key: string,
): T | undefined {
  return extensions?.[key] as T | undefined;
}

/**
 * Set extension data on an extensions record (creates if needed).
 * Returns a new extensions object (does not mutate the input).
 */
export function setExtensionData(
  extensions: Record<string, unknown> | undefined,
  key: string,
  data: unknown,
): Record<string, unknown> {
  return { ...extensions, [key]: data };
}

// ══════════════════════════════════════════════════════════════
// Extension registry with topological sort
// ══════════════════════════════════════════════════════════════

/**
 * Registry for extensions with dependency-ordered execution.
 *
 * Extensions are stored by key and sorted topologically based on `dependsOn`.
 * Within the same dependency level, registration order is preserved.
 *
 * @example
 * ```ts
 * const registry = new s402ExtensionRegistry<s402FacilitatorExtension>();
 * registry.register(rateLimitExtension);
 * registry.register(analyticsExtension);
 * const sorted = registry.sorted(); // dependency-ordered list
 * ```
 */
export class s402ExtensionRegistry<T extends s402Extension> {
  private extensions = new Map<string, T>();
  private sortedCache: T[] | null = null;

  /**
   * Register an extension. Throws on duplicate key or dependency cycle.
   */
  register(ext: T): void {
    if (this.extensions.has(ext.key)) {
      throw new s402Error('EXTENSION_FAILED',
        `Extension "${ext.key}" is already registered`);
    }
    this.extensions.set(ext.key, ext);
    this.sortedCache = null; // invalidate — next sorted() call rebuilds
  }

  /** Get a registered extension by key. */
  get(key: string): T | undefined {
    return this.extensions.get(key);
  }

  /** Number of registered extensions. */
  get size(): number {
    return this.extensions.size;
  }

  /**
   * Return extensions in topological (dependency) order.
   * Cached until a new extension is registered.
   */
  sorted(): T[] {
    if (this.sortedCache) return this.sortedCache;
    this.sortedCache = topologicalSort(this.extensions);
    return this.sortedCache;
  }
}

/**
 * Topological sort of extensions based on `dependsOn` declarations.
 * Uses Kahn's algorithm. Throws on cycles.
 */
function topologicalSort<T extends s402Extension>(extensions: Map<string, T>): T[] {
  if (extensions.size === 0) return [];

  // Build adjacency list and in-degree map
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // key → keys that depend on it

  for (const [key] of extensions) {
    inDegree.set(key, 0);
    dependents.set(key, []);
  }

  for (const [key, ext] of extensions) {
    if (ext.dependsOn) {
      for (const dep of ext.dependsOn) {
        if (!extensions.has(dep)) {
          throw new s402Error('EXTENSION_FAILED',
            `Extension "${key}" depends on "${dep}" which is not registered`);
        }
        dependents.get(dep)!.push(key);
        inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm: start with nodes that have no dependencies
  const queue: string[] = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key);
  }

  const sorted: T[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    sorted.push(extensions.get(key)!);
    for (const dependent of dependents.get(key)!) {
      const newDegree = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== extensions.size) {
    // Some nodes weren't reachable → cycle exists
    const inCycle = [...extensions.keys()].filter(k => !sorted.some(e => e.key === k));
    throw new s402Error('EXTENSION_FAILED',
      `Extension dependency cycle detected involving: ${inCycle.join(', ')}`);
  }

  return sorted;
}

// ══════════════════════════════════════════════════════════════
// Extension runner (handles critical vs advisory)
// ══════════════════════════════════════════════════════════════

/** Callback for advisory extension failures. */
export type s402ExtensionErrorHandler = (ext: s402Extension, error: unknown) => void;

/**
 * Run an async hook on all extensions in order.
 * Critical extensions throw on failure; advisory extensions call the error handler.
 */
export async function runExtensionHooks<T extends s402Extension>(
  extensions: T[],
  hookName: string,
  runner: (ext: T) => Promise<void>,
  onError?: s402ExtensionErrorHandler,
): Promise<void> {
  for (const ext of extensions) {
    try {
      await runner(ext);
    } catch (e) {
      if (ext.critical) {
        throw new s402Error('EXTENSION_FAILED',
          `Critical extension "${ext.key}" failed in ${hookName}: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Advisory: log and continue
      onError?.(ext, e);
    }
  }
}
