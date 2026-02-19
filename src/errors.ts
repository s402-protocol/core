/**
 * s402 Error Types — typed error codes with recovery hints
 *
 * Every s402 error tells the client:
 *   1. What went wrong (code)
 *   2. Whether it can retry (retryable)
 *   3. What to do about it (suggestedAction)
 */

export const s402ErrorCode = {
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MANDATE_EXPIRED: 'MANDATE_EXPIRED',
  MANDATE_LIMIT_EXCEEDED: 'MANDATE_LIMIT_EXCEEDED',
  STREAM_DEPLETED: 'STREAM_DEPLETED',
  ESCROW_DEADLINE_PASSED: 'ESCROW_DEADLINE_PASSED',
  UNLOCK_DECRYPTION_FAILED: 'UNLOCK_DECRYPTION_FAILED',
  FINALITY_TIMEOUT: 'FINALITY_TIMEOUT',
  FACILITATOR_UNAVAILABLE: 'FACILITATOR_UNAVAILABLE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  SCHEME_NOT_SUPPORTED: 'SCHEME_NOT_SUPPORTED',
  NETWORK_MISMATCH: 'NETWORK_MISMATCH',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  REQUIREMENTS_EXPIRED: 'REQUIREMENTS_EXPIRED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  SETTLEMENT_FAILED: 'SETTLEMENT_FAILED',
} as const;

export type s402ErrorCodeType = (typeof s402ErrorCode)[keyof typeof s402ErrorCode];

export interface s402ErrorInfo {
  code: s402ErrorCodeType;
  message: string;
  retryable: boolean;
  suggestedAction: string;
}

/** Error recovery hints for each error code */
const ERROR_HINTS: Record<s402ErrorCodeType, { retryable: boolean; suggestedAction: string }> = {
  INSUFFICIENT_BALANCE: {
    retryable: false,
    suggestedAction: 'Top up wallet balance or try with a smaller amount',
  },
  MANDATE_EXPIRED: {
    retryable: false,
    suggestedAction: 'Request a new mandate from the delegator',
  },
  MANDATE_LIMIT_EXCEEDED: {
    retryable: false,
    suggestedAction: 'Request mandate increase or split across transactions',
  },
  STREAM_DEPLETED: {
    retryable: true,
    suggestedAction: 'Top up the stream deposit',
  },
  ESCROW_DEADLINE_PASSED: {
    retryable: false,
    suggestedAction: 'Create a new escrow with a later deadline',
  },
  UNLOCK_DECRYPTION_FAILED: {
    retryable: true,
    suggestedAction: 'Re-request decryption key with a fresh session key',
  },
  FINALITY_TIMEOUT: {
    retryable: true,
    suggestedAction: 'Transaction submitted but not confirmed — retry finality check',
  },
  FACILITATOR_UNAVAILABLE: {
    retryable: true,
    suggestedAction: 'Fall back to direct settlement if signer is available',
  },
  INVALID_PAYLOAD: {
    retryable: false,
    suggestedAction: 'Check payload format and re-sign the transaction',
  },
  SCHEME_NOT_SUPPORTED: {
    retryable: false,
    suggestedAction: 'Use the "exact" scheme (always supported for x402 compat)',
  },
  NETWORK_MISMATCH: {
    retryable: false,
    suggestedAction: 'Ensure client and server are on the same Sui network',
  },
  SIGNATURE_INVALID: {
    retryable: false,
    suggestedAction: 'Re-sign the transaction with the correct keypair',
  },
  REQUIREMENTS_EXPIRED: {
    retryable: true,
    suggestedAction: 'Re-fetch payment requirements from the server',
  },
  VERIFICATION_FAILED: {
    retryable: false,
    suggestedAction: 'Check payment amount and transaction structure',
  },
  SETTLEMENT_FAILED: {
    retryable: true,
    suggestedAction: 'Transient RPC failure during settlement — retry in a few seconds',
  },
};

/**
 * Create a typed s402 error with recovery hints.
 */
export function createS402Error(code: s402ErrorCodeType, message?: string): s402ErrorInfo {
  const hints = ERROR_HINTS[code];
  return {
    code,
    message: message ?? code,
    retryable: hints.retryable,
    suggestedAction: hints.suggestedAction,
  };
}

/**
 * s402 error class for throwing in code.
 */
export class s402Error extends Error {
  readonly code: s402ErrorCodeType;
  readonly retryable: boolean;
  readonly suggestedAction: string;

  constructor(code: s402ErrorCodeType, message?: string) {
    const info = createS402Error(code, message);
    super(info.message);
    this.name = 's402Error';
    this.code = info.code;
    this.retryable = info.retryable;
    this.suggestedAction = info.suggestedAction;
  }

  toJSON(): s402ErrorInfo {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      suggestedAction: this.suggestedAction,
    };
  }
}
