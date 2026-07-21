/**
 * s402 Scheme Interfaces
 *
 * Each payment scheme (exact, upto, prepaid, stream, escrow, unlock) implements
 * these interfaces. The key insight: each scheme has its OWN verify logic.
 * Exact verify ≠ upto verify ≠ stream verify ≠ escrow verify.
 */

import type {
  s402PaymentRequirements,
  s402PaymentPayload,
  s402VerifyResponse,
  s402SettleResponse,
  s402Scheme,
  s402SettlementMode,
} from './types.js';

// ══════════════════════════════════════════════════════════════
// Client-side scheme (builds payment payloads)
// ══════════════════════════════════════════════════════════════

/**
 * Result of client-side settlement verification.
 *
 * See `s402ClientScheme.verifySettlement` — this is the outcome of the
 * client independently checking that the facilitator's returned digest
 * is causally bound to the signed payload the client actually sent.
 */
export interface s402SettlementVerification {
  /** True iff the facilitator's digest matches the one derived from the signed payload bytes. */
  verified: boolean;
  /** The digest the client computed locally from its own signed bytes. */
  expectedDigest: string;
  /** The digest the facilitator returned (copied from SettleResponse). */
  actualDigest: string | null;
  /**
   * Human-readable reason when `verified` is false. Present only on mismatch,
   * unknown-digest, or when the scheme cannot verify the settlement locally.
   */
  reason?: string;
}

/** Implemented by each scheme on the client side */
export interface s402ClientScheme {
  /** Which scheme this implements */
  readonly scheme: s402Scheme;

  /** Create a signed payment payload from server requirements */
  createPayment(
    requirements: s402PaymentRequirements,
  ): Promise<s402PaymentPayload>;

  /**
   * Verify that the facilitator's `SettleResponse` is causally bound to the
   * signed payload the client actually sent.
   *
   * For schemes where the client signs the full transaction before sending
   * (exact, stream, escrow, prepaid, unlock-TX1), this is a **local, offline
   * check**: derive the expected tx digest from the signed bytes and compare it
   * to the digest the facilitator returned. No RPC call required. This closes
   * the causal-binding hole identified in the April 2026 S8 review: a malicious
   * facilitator cannot substitute an unrelated-but-real tx digest, because that
   * other digest would correspond to different signed bytes the client never
   * produced.
   *
   * Every scheme MUST implement this method. Schemes that cannot verify locally
   * (e.g. unlock-TX2, which is facilitator-constructed) should return
   * `{ verified: false, reason: 'scheme does not support local verification' }`
   * and rely on other attestation mechanisms.
   *
   * @since 0.4.0 — required (was optional in 0.3.0)
   */
  verifySettlement(
    payload: s402PaymentPayload,
    settleResponse: s402SettleResponse,
  ): s402SettlementVerification;
}

// ══════════════════════════════════════════════════════════════
// Server-side scheme (builds requirements)
// ══════════════════════════════════════════════════════════════

/** Implemented by each scheme on the server side */
export interface s402ServerScheme {
  readonly scheme: s402Scheme;

  /** Build payment requirements from route config */
  buildRequirements(config: s402RouteConfig): s402PaymentRequirements;
}

// ══════════════════════════════════════════════════════════════
// Facilitator scheme (verify + settle)
// ══════════════════════════════════════════════════════════════

/**
 * Implemented by each scheme in the facilitator.
 *
 * Critical: each scheme has its OWN verify logic.
 * - Exact: signature recovery + dry-run simulation + balance check
 * - Upto: deposit PTB validation + maxAmount match + deadline check
 * - Prepaid: deposit PTB validation + rate/cap match
 * - Stream: stream creation PTB validation + deposit check
 * - Escrow: escrow creation PTB validation + arbiter/deadline check
 * - Unlock: escrow validation (key release is separate PTB)
 */
export interface s402FacilitatorScheme {
  readonly scheme: s402Scheme;

  /** Verify a payment payload without broadcasting */
  verify(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402VerifyResponse>;

  /** Verify and broadcast the transaction */
  settle(
    payload: s402PaymentPayload,
    requirements: s402PaymentRequirements,
  ): Promise<s402SettleResponse>;
}

// ══════════════════════════════════════════════════════════════
// Direct settlement (no facilitator)
// ══════════════════════════════════════════════════════════════

/**
 * For self-sovereign agents that hold their own keys.
 * Builds, signs, and broadcasts in one step — no facilitator needed.
 *
 * MUST call waitForTransaction() before returning success.
 * Without finality confirmation, server could grant access for a
 * transaction that gets reverted.
 */
export interface s402DirectScheme {
  readonly scheme: s402Scheme;

  /** Build, sign, broadcast, and wait for finality */
  settleDirectly(
    requirements: s402PaymentRequirements,
  ): Promise<s402SettleResponse>;
}

// ══════════════════════════════════════════════════════════════
// Route configuration
// ══════════════════════════════════════════════════════════════

/** Per-route payment configuration for the server middleware */
export interface s402RouteConfig {
  /** Which payment scheme(s) to accept. Always includes "exact" for x402 compat. */
  schemes: s402Scheme[];
  /** Amount in base units, same as wire format (e.g., "1000000") */
  price: string;
  /** Network identifier (e.g., "sui:mainnet", "solana:mainnet-beta") */
  network: string;
  /** Recipient address (chain-specific format, validated by chain adapter) */
  payTo: string;
  /** Asset/coin type identifier (chain-specific, e.g., Sui Move type or Solana mint address) */
  asset: string;
  /** Facilitator URL (optional for direct settlement) */
  facilitatorUrl?: string;
  /** Settlement mode preference */
  settlementMode?: s402SettlementMode;

  // ── Optional cross-cutting config ──

  /** AP2 mandate requirements */
  mandate?: {
    required: boolean;
    minPerTx?: string;
  };
  /** Protocol fee in basis points */
  protocolFeeBps?: number;
  /** Require on-chain receipt */
  receiptRequired?: boolean;

  // ── Scheme-specific config (ordered by tier) ──

  // Tier 1: Single Payment
  upto?: {
    maxAmount: string;
    settlementDeadlineMs: string;
    usageReportUrl?: string;
    estimatedAmount?: string;
  };

  // Tier 2: Persistent Balance
  prepaid?: {
    ratePerCall: string;
    maxCalls?: string;
    minDeposit: string;
    withdrawalDelayMs: string;
    /** Provider Ed25519 pubkey (hex). Enables v0.2 signed receipt mode. @since v0.2 */
    providerPubkey?: string;
    /** Dispute window in ms. Required when providerPubkey is set. @since v0.2 */
    disputeWindowMs?: string;
  };
  stream?: {
    ratePerSecond: string;
    budgetCap: string;
    minDeposit: string;
  };

  // Tier 3: Conditional Release
  escrow?: {
    seller: string;
    arbiter?: string;
    deadlineMs: string;
  };
  unlock?: {
    packageId: string;
    keyServers: { objectId: string; weight: number }[];
    threshold: number;
    contentDigest?: string;
  };
}
