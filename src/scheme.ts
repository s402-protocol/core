/**
 * s402 Scheme Interfaces
 *
 * Each payment scheme (exact, stream, escrow, seal) implements these
 * interfaces. The key insight: each scheme has its OWN verify logic.
 * Exact verify ≠ stream verify ≠ escrow verify.
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

/** Implemented by each scheme on the client side */
export interface s402ClientScheme {
  /** Which scheme this implements */
  readonly scheme: s402Scheme;

  /** Create a signed payment payload from server requirements */
  createPayment(
    requirements: s402PaymentRequirements,
  ): Promise<s402PaymentPayload>;
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
 * - Stream: stream creation PTB validation + deposit check
 * - Escrow: escrow creation PTB validation + arbiter/deadline check
 * - Seal: escrow validation (seal_approve is separate PTB)
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
  /** Amount in base units, same as wire format (e.g., "1000000" for 0.001 SUI in MIST) */
  price: string;
  /** Sui network */
  network: string;
  /** Recipient address */
  payTo: string;
  /** Move coin type */
  asset?: string;
  /** Facilitator URL (optional for direct settlement) */
  facilitatorUrl?: string;
  /** Settlement mode preference */
  settlementMode?: s402SettlementMode;

  // ── Optional scheme-specific config ──

  /** AP2 mandate requirements */
  mandate?: {
    required: boolean;
    minPerTx?: string;
  };
  /** Protocol fee in basis points */
  protocolFeeBps?: number;
  /** Require on-chain receipt */
  receiptRequired?: boolean;

  // ── Stream config ──
  stream?: {
    ratePerSecond: string;
    budgetCap: string;
    minDeposit: string;
  };

  // ── Escrow config ──
  escrow?: {
    seller: string;
    arbiter?: string;
    deadlineMs: string;
  };

  // ── Seal config ──
  seal?: {
    encryptionId: string;
    walrusBlobId: string;
    sealPackageId: string;
  };

  // ── Prepaid config ──
  prepaid?: {
    ratePerCall: string;
    maxCalls?: string;
    minDeposit: string;
    withdrawalDelayMs: string;
  };
}
