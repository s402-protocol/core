/**
 * s402 Protocol Types — Chain-agnostic HTTP 402 wire format
 *
 * s402 (small s) is a chain-agnostic HTTP 402 protocol that is wire-compatible
 * with x402's JSON format. The reference implementation targets Sui, but the
 * protocol layer contains no chain-specific logic (see S7 invariant in AGENTS.md).
 *
 *   - Six payment schemes: exact, upto, prepaid, stream, escrow, unlock
 *   - AP2 mandate support for agent spending authorization
 *   - Direct settlement mode (no facilitator needed)
 *   - On-chain receipts as proofs
 *
 * Branding: protocol version field = s402Version (lowercase s).
 * TypeScript types use camelCase per TS convention.
 */

// ══════════════════════════════════════════════════════════════
// Protocol version
// ══════════════════════════════════════════════════════════════

import type { s402ErrorCodeType } from './errors.js';

/** Current protocol version. Always lowercase s. */
export const S402_VERSION = '1' as const;

// ══════════════════════════════════════════════════════════════
// Payment schemes
// ══════════════════════════════════════════════════════════════

/**
 * The six s402 payment schemes, ordered by complexity:
 *
 * TIER 1 — Single Payment:  exact (fixed amount), upto (variable amount)
 * TIER 2 — Persistent Balance: prepaid (multi-claim), stream (time-based)
 * TIER 3 — Conditional Release: escrow (arbiter), unlock (encryption)
 */
export type s402Scheme = 'exact' | 'upto' | 'prepaid' | 'stream' | 'escrow' | 'unlock';

/** Settlement mode: facilitator-mediated or direct on-chain */
export type s402SettlementMode = 'facilitator' | 'direct';

// ══════════════════════════════════════════════════════════════
// Payment requirements (server → client in 402 response)
// ══════════════════════════════════════════════════════════════

/**
 * Base payment requirements — included in every 402 response.
 * Wire-compatible with x402 PaymentRequirements where fields overlap.
 */
export interface s402PaymentRequirements {
  /** Protocol version (always "1") */
  s402Version: typeof S402_VERSION;
  /** Which payment schemes the server accepts. Always includes "exact" for x402 compat. */
  accepts: s402Scheme[];
  /** Network identifier (e.g., "sui:mainnet", "solana:mainnet-beta", "eip155:8453") */
  network: string;
  /** Asset/coin type identifier (chain-specific format, opaque to s402 core) */
  asset: string;
  /** Amount in base units as a non-negative integer string */
  amount: string;
  /** Recipient address */
  payTo: string;
  /**
   * Facilitator URL (optional for direct settlement).
   *
   * Validated at the wire layer for protocol (`https:` or `http:` only) and
   * embedded credentials (rejected). Consumers that fetch this URL MUST apply
   * their own hostname/IP restrictions to prevent SSRF (block RFC 1918 private
   * addresses, link-local 169.254.x.x, loopback, cloud metadata endpoints).
   * DNS-based SSRF cannot be caught at URL parse time.
   */
  facilitatorUrl?: string;

  // ── s402 extensions (not in x402) ──

  /** AP2 mandate requirements (if agent spending authorization is needed) */
  mandate?: s402MandateRequirements;
  /**
   * Protocol fee in basis points (0-10000). **Advisory only.**
   *
   * This field is a transparency hint for the client's UI — it lets the payer
   * see the total cost before committing. It is NOT the source of truth for
   * settlement math. The authoritative fee rate is owned by the Facilitator
   * (configured in its ProtocolState or equivalent on-chain object) and
   * enforced at the smart contract level.
   *
   * Resource Servers SHOULD omit this field and let the Facilitator provide
   * it via its `/.well-known/s402-facilitator` endpoint. If included, it MUST
   * match the Facilitator's configured rate — a mismatch is a warning sign.
   *
   * Trust model: Facilitator owns the fee. Resource Server cannot override it.
   */
  protocolFeeBps?: number;
  /**
   * Address that receives the protocol fee.
   * Advisory only — authoritative value is in Facilitator's on-chain config.
   * Defaults to the Facilitator's own address if omitted.
   */
  protocolFeeAddress?: string;
  /** Whether the server requires an on-chain receipt NFT */
  receiptRequired?: boolean;
  /** Settlement mode preference */
  settlementMode?: s402SettlementMode;
  /** When these requirements expire (Unix timestamp ms). Facilitator MUST reject after this. */
  expiresAt?: number;

  // ── Scheme-specific extensions (ordered by tier) ──

  /** Extra fields for upto scheme (usage-based, variable settlement) */
  upto?: s402UptoExtra;
  /** Extra fields for prepaid scheme */
  prepaid?: s402PrepaidExtra;
  /** Extra fields for stream scheme */
  stream?: s402StreamExtra;
  /** Extra fields for escrow scheme */
  escrow?: s402EscrowExtra;
  /** Extra fields for unlock scheme (pay-to-decrypt encrypted content) */
  unlock?: s402UnlockExtra;

  /** Settlement overrides (used by upto scheme — server provides actual amount at settle-time) */
  settlementOverrides?: s402SettlementOverrides;

  /**
   * Arbitrary extension data (forward-compatible extensibility).
   *
   * D-10 (Trust boundary): extensions is an opaque bag — the s402 library
   * passes it through without validation. Consumers MUST treat extension values
   * as untrusted input. Do not use extensions for security-critical fields
   * (use first-class typed fields instead). Scheme implementations should
   * validate any extension keys they consume.
   */
  extensions?: Record<string, unknown>;
}

// ── Tier 1: Single Payment ──────────────────────────────────

/**
 * Upto-specific requirements (usage-based, variable settlement).
 *
 * The client authorizes up to `maxAmount`; the facilitator settles the actual
 * amount (provided by the server via `settlementOverrides`) at settlement time.
 * Remainder is returned to the payer on-chain.
 *
 * TRUST MODEL: The client can bound its exposure via `settlementCeiling` in the
 * payment payload — an on-chain-enforced cap tighter than `maxAmount`. The server
 * advertises `estimatedAmount` so the client can set a tight ceiling (e.g., 1.2x
 * the estimate). Without `settlementCeiling`, the facilitator can settle up to
 * `maxAmount`. See ADR-003 §Decision 3 and §Decision 8.
 *
 * SEMANTIC CLARITY: `amount` on the parent `s402PaymentRequirements` is the
 * EXACT price for the `exact` scheme. For `upto`, `maxAmount` here is the
 * ceiling — the two are intentionally separate fields to avoid the semantic
 * overloading that x402 suffers from.
 */
export interface s402UptoExtra {
  /** Maximum authorized amount in base units. Client deposits this; actual may be less. */
  maxAmount: string;
  /**
   * Deadline for settlement in milliseconds since epoch.
   * After this time, the payer can reclaim the full deposit via `expire()`.
   * Must be in the future at verify-time. Facilitator MUST reject expired deposits.
   */
  settlementDeadlineMs: string;
  /** Optional URL where the client can query usage/metering data (informational) */
  usageReportUrl?: string;
  /**
   * Server's estimated cost in base units (advisory, optional).
   * Helps the client set a tight `settlementCeiling` in the payload.
   * Must be ≤ maxAmount when present. Not enforced on-chain — purely informational.
   */
  estimatedAmount?: string;
}

/**
 * Settlement overrides — server provides the actual amount to the facilitator.
 *
 * Used by the `upto` scheme: the resource server tells the facilitator how much
 * of the authorized maximum to actually charge, based on observed usage.
 * Threaded via `requirements.settlementOverrides` so the facilitator's `process()`
 * signature (payload, requirements) doesn't need to change.
 *
 * TRUST MODEL: The server is trusted to report honest usage. The facilitator
 * enforces `actualAmount <= maxAmount` but cannot verify usage independently.
 * On-chain events provide an audit trail for dispute resolution.
 */
export interface s402SettlementOverrides {
  /** Actual amount to settle in base units. Must be ≤ maxAmount from UptoExtra. */
  actualAmount: string;
}

// ── Tier 2: Persistent Balance ──────────────────────────────

/**
 * Prepaid-specific requirements.
 *
 * NOTE: Prepaid inverts the normal s402 flow — the PROVIDER signs claims,
 * not the CLIENT. The deposit phase uses the standard client→facilitator flow,
 * but claims are provider-initiated. Full HTTP flow integration is Phase 2+.
 *
 * TRUST MODEL: Trust-bounded, not trustless. The provider submits call_count —
 * Move cannot verify calls actually happened. Agent's protection: rate cap,
 * max_calls, deposit ceiling, small deposits + short refill cycles, reputation.
 * v0.2 adds signed usage receipts for cryptographic fraud proofs. See ADR-007.
 *
 * PAIRING INVARIANT: `providerPubkey` and `disputeWindowMs` are a pair.
 * Both must be present (v0.2 signed receipt mode) or both absent (v0.1 default).
 * Setting `providerPubkey` without `disputeWindowMs` (or vice versa) is invalid
 * and will be rejected by the on-chain contract at deposit time.
 */
export interface s402PrepaidExtra {
  /** Maximum base units per API call (rate cap) */
  ratePerCall: string;
  /** Max calls cap. Omit for unlimited (u64::MAX on-chain). */
  maxCalls?: string;
  /** Minimum deposit amount in base units */
  minDeposit: string;
  /** Withdrawal delay in ms. Agent must wait this long after last claim. Min 60s, max 7d. */
  withdrawalDelayMs: string;
  /**
   * Provider's Ed25519 public key (hex string, 32 bytes).
   * When present, enables v0.2 signed receipt mode — claims enter a pending
   * state and can be disputed with cryptographic fraud proofs.
   * @since v0.2
   */
  providerPubkey?: string;
  /**
   * Dispute window in milliseconds. Min 60s (60000), max 24h (86400000).
   * Only relevant when providerPubkey is set.
   * @since v0.2
   */
  disputeWindowMs?: string;
}

/** Stream-specific requirements */
export interface s402StreamExtra {
  /** Rate in base units per second */
  ratePerSecond: string;
  /** Maximum budget cap in base units */
  budgetCap: string;
  /** Minimum initial deposit in base units */
  minDeposit: string;
  /** URL for stream status checks (phase 2) */
  streamSetupUrl?: string;
}

// ── Tier 3: Conditional Release ─────────────────────────────

/** Escrow-specific requirements */
export interface s402EscrowExtra {
  /** Seller/payee address */
  seller: string;
  /** Arbiter address for dispute resolution */
  arbiter?: string;
  /** Escrow deadline in milliseconds since epoch */
  deadlineMs: string;
}

/** Reference to an on-chain registered threshold key server (Seal). */
export interface s402KeyServerRef {
  /** Object ID of the on-chain registered key server; the client resolves its URL from it. */
  objectId: string;
  /** Weight this server contributes toward the decryption threshold. */
  weight: number;
}

/**
 * Unlock-specific requirements (pay-to-decrypt, single-transaction).
 *
 * The deliverable is encrypted under a Seal identity anchored to the mint-time
 * `UnlockReceipt` object ID; a single `pay_and_mint` transaction pays the seller and
 * mints that receipt atomically. No escrow, arbiter, or deadline — see the `unlock` on
 * Sui scheme spec.
 */
export interface s402UnlockExtra {
  /** Move package implementing `pay_and_mint` + the `seal_approve` policy; also the Seal identity namespace. */
  packageId: string;
  /** Key-server set the seller encrypts to (t-of-n threshold encryption). */
  keyServers: s402KeyServerRef[];
  /** Threshold `t` in the t-of-n encryption. */
  threshold: number;
  /** Optional `sha256-<base64url>` commitment to the plaintext (off-chain/reputational evidence). */
  contentDigest?: string;
}

// ══════════════════════════════════════════════════════════════
// AP2 Mandate (agent spending authorization)
// ══════════════════════════════════════════════════════════════

/** Mandate requirements in a 402 response — tells client what mandate is needed */
export interface s402MandateRequirements {
  /** Whether a mandate is required (true) or optional (false = speeds up if present) */
  required: boolean;
  /** Minimum per-transaction limit needed */
  minPerTx?: string;
  /** Mandate coin type (must match payment asset) */
  coinType?: string;
}

/** On-chain mandate reference — included in payment payload when agent has authorization */
export interface s402Mandate {
  /** Mandate object ID on Sui */
  mandateId: string;
  /** Delegator (human) address */
  delegator: string;
  /** Delegate (agent) address */
  delegate: string;
  /** Per-transaction spending limit */
  maxPerTx: string;
  /** Lifetime spending cap */
  maxTotal: string;
  /** Amount already spent */
  totalSpent: string;
  /** Expiry timestamp (ms since epoch) */
  expiresAtMs: string;
}

// ══════════════════════════════════════════════════════════════
// Payment payload (client → server/facilitator)
// ══════════════════════════════════════════════════════════════

/** Base payload — all schemes include these fields */
export interface s402PaymentPayloadBase {
  /** Protocol version */
  s402Version: typeof S402_VERSION;
  /** Which scheme is being used */
  scheme: s402Scheme;
}

// ── Tier 1: Single Payment ──────────────────────────────────

/** Exact payment: signed transaction bytes */
export interface s402ExactPayload extends s402PaymentPayloadBase {
  scheme: 'exact';
  payload: {
    /** Base64-encoded signed transaction bytes */
    transaction: string;
    /** Base64-encoded signature */
    signature: string;
  };
}

/**
 * Upto payment: signed deposit transaction for variable-amount settlement.
 *
 * The client deposits `maxAmount` into an on-chain UptoDeposit proxy.
 * The facilitator later calls `settle(actual_amount)` where
 * `actual ≤ min(maxAmount, settlementCeiling)`, returning the remainder
 * to the payer. If settlement doesn't happen before the deadline, the
 * payer can reclaim via `expire()`.
 */
export interface s402UptoPayload extends s402PaymentPayloadBase {
  scheme: 'upto';
  payload: {
    /** Base64-encoded signed deposit transaction (creates UptoDeposit on-chain) */
    transaction: string;
    /** Base64-encoded signature */
    signature: string;
    /** Maximum authorized amount (must match requirements.upto.maxAmount) */
    maxAmount: string;
    /**
     * Client-chosen settlement ceiling (optional, on-chain enforced).
     * The Move contract rejects settlements where `actualAmount > settlementCeiling`.
     * Must satisfy: `1 <= settlementCeiling <= maxAmount`.
     * Omit to allow settlement up to `maxAmount` (backwards compatible).
     *
     * Servers SHOULD check this before serving expensive resources — if
     * `settlementCeiling < estimatedCost`, respond with an updated 402.
     */
    settlementCeiling?: string;
  };
}

// ── Tier 2: Persistent Balance ──────────────────────────────

/**
 * Prepaid payment: agent deposits into a PrepaidBalance shared object.
 * This is the deposit phase only — claims are provider-initiated (not via HTTP 402).
 */
export interface s402PrepaidPayload extends s402PaymentPayloadBase {
  scheme: 'prepaid';
  payload: {
    /** Base64-encoded deposit PTB */
    transaction: string;
    /** Agent's signature */
    signature: string;
    /** Committed rate per call (must match requirements) */
    ratePerCall: string;
    /** Committed max calls cap (must match requirements) */
    maxCalls?: string;
  };
}

/** Stream payment: signed stream creation transaction */
export interface s402StreamPayload extends s402PaymentPayloadBase {
  scheme: 'stream';
  payload: {
    transaction: string;
    signature: string;
  };
}

// ── Tier 3: Conditional Release ─────────────────────────────

/** Escrow payment: signed escrow creation transaction */
export interface s402EscrowPayload extends s402PaymentPayloadBase {
  scheme: 'escrow';
  payload: {
    transaction: string;
    signature: string;
  };
}

/**
 * Unlock payment: a single signed `pay_and_mint` transaction that pays the seller and
 * mints the decryption entitlement (`UnlockReceipt`) atomically. The payload carries only
 * the signed transaction — as in `exact` — because the encryption identity is anchored to
 * the mint-time receipt object ID and travels in the fulfillment, not the payment.
 */
export interface s402UnlockPayload extends s402PaymentPayloadBase {
  scheme: 'unlock';
  payload: {
    /** Signed `pay_and_mint` transaction. */
    transaction: string;
    signature: string;
  };
}

/**
 * Unlock fulfillment — returned by the resource server (pre-settlement, in
 * `PAYMENT-RESPONSE`). Tells the buyer what to inspect before broadcasting.
 */
export interface s402UnlockFulfillment {
  /** Object ID the `UnlockReceipt` will have once broadcast — the Seal anchor. */
  receiptId: string;
  /** Hex Seal inner identity (`receiptId ‖ nonce`). Advisory — verify against the ciphertext's embedded id. */
  encryptionId: string;
  /** Reference to the encrypted deliverable. */
  ciphertext: {
    /** `walrus:<blobId>` or an https URL for the encrypted content. */
    contentRef?: string;
    /** Base64 inline encrypted content (mutually exclusive with `contentRef`). */
    inline?: string;
    /** Base64 Seal `EncryptedObject` wrapping the content key (envelope mode). */
    encryptedKey?: string;
  };
}

/** Discriminated union of all payment payloads */
export type s402PaymentPayload =
  | s402ExactPayload
  | s402UptoPayload
  | s402PrepaidPayload
  | s402StreamPayload
  | s402EscrowPayload
  | s402UnlockPayload;

// ══════════════════════════════════════════════════════════════
// Settlement response (facilitator/server → client)
// ══════════════════════════════════════════════════════════════

export interface s402SettleResponse {
  /** Whether settlement was successful */
  success: boolean;
  /** Transaction digest on Sui */
  txDigest?: string;
  /** On-chain receipt object ID (if receipt was minted) */
  receiptId?: string;
  /** Time to finality in milliseconds */
  finalityMs?: number;

  // ── Scheme-specific response fields (ordered by tier) ──

  /** Actual amount settled in base units (for upto scheme — fixes x402's opacity) */
  actualAmount?: string;
  /** UptoDeposit object ID (for upto scheme) */
  depositId?: string;
  /** PrepaidBalance object ID (for prepaid scheme) */
  balanceId?: string;
  /** Stream object ID (for stream scheme) */
  streamId?: string;
  /** Escrow object ID (for escrow scheme) */
  escrowId?: string;

  /** Error message if settlement failed */
  error?: string;
  /** Typed error code for programmatic failure handling */
  errorCode?: s402ErrorCodeType;
}

export interface s402VerifyResponse {
  /** Whether the payment payload is valid */
  valid: boolean;
  /** Reason for rejection */
  invalidReason?: string;
  /** Payer address (recovered from signature) */
  payerAddress?: string;
}

// ══════════════════════════════════════════════════════════════
// Discovery (.well-known/s402.json)
// ══════════════════════════════════════════════════════════════

export interface s402Discovery {
  /** Protocol version */
  s402Version: typeof S402_VERSION;
  /** Supported schemes */
  schemes: s402Scheme[];
  /** Supported Sui networks */
  networks: string[];
  /** Supported coin types */
  assets: string[];
  /** Facilitator URL */
  facilitatorUrl?: string;
  /** Whether direct settlement is supported */
  directSettlement: boolean;
  /** Whether mandates are supported */
  mandateSupport: boolean;
  /** Protocol fee in basis points */
  protocolFeeBps: number;
  /** Address that receives the protocol fee */
  protocolFeeAddress?: string;
}

// ══════════════════════════════════════════════════════════════
// Payment session (client-side state tracking)
// ══════════════════════════════════════════════════════════════

/**
 * Tracks the lifecycle of a single payment exchange.
 * Used by s402 clients (SDK fetch wrapper, MCP tools) to correlate
 * the 402 response → payment creation → settlement result.
 */
export interface s402PaymentSession {
  /** Unique session ID (client-generated, e.g., crypto.randomUUID()) */
  id: string;
  /** When the session started (Date.now()) */
  startedAt: number;
  /** The payment requirements from the 402 response */
  requirements: s402PaymentRequirements;
  /** The payment payload sent to the facilitator/server (null until created) */
  payload: s402PaymentPayload | null;
  /** Settlement result (null until settled) */
  result: s402SettleResponse | null;
  /** Current session state */
  state: 'pending' | 'paying' | 'settled' | 'failed';
  /** Number of retry attempts */
  retries: number;
  /** Error message if state is 'failed' */
  error?: string;
}

// ══════════════════════════════════════════════════════════════
// Service registry (multi-service discovery)
// ══════════════════════════════════════════════════════════════

/**
 * A single s402-enabled service endpoint in a registry.
 * Supports multi-service discovery (e.g., an API gateway advertising
 * multiple endpoints with different payment requirements).
 */
export interface s402ServiceEntry {
  /** Service name (human-readable) */
  name: string;
  /** Service endpoint URL */
  url: string;
  /** Payment schemes this service accepts */
  accepts: s402Scheme[];
  /** Supported coin types */
  assets: string[];
  /** Base price in smallest unit (MIST for SUI, micro for USDC) */
  baseAmount: string;
  /** Facilitator URL (if not direct settlement) */
  facilitatorUrl?: string;
}

/**
 * Query parameters for service registry lookups.
 */
export interface s402RegistryQuery {
  /** Filter by supported scheme */
  scheme?: s402Scheme;
  /** Filter by coin type */
  asset?: string;
  /** Filter by network */
  network?: string;
  /** Maximum number of results */
  limit?: number;
}

// ══════════════════════════════════════════════════════════════
// Wire format helpers
// ══════════════════════════════════════════════════════════════

/**
 * HTTP headers used by s402 (same names as x402 for compatibility).
 * All lowercase per HTTP/2 spec (RFC 9113 §8.2.1). The Headers API
 * normalizes casing for HTTP/1.1, so lowercase works everywhere.
 */
export const S402_HEADERS = {
  /** Server → client: payment requirements (base64 JSON in 402 response) */
  PAYMENT_REQUIRED: 'payment-required',
  /** Client → server: payment payload (base64 JSON) */
  PAYMENT: 'x-payment',
  /** Server → client: settlement result (base64 JSON) */
  PAYMENT_RESPONSE: 'payment-response',
  /** Client → server: active stream ID (phase 2 of stream protocol) */
  STREAM_ID: 'x-stream-id',
  /** Client → server: scheme preference negotiation (RFC 7231-style q-values) */
  ACCEPT_PAYMENT: 'accept-payment',
} as const;
