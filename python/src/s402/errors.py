"""s402 Error Types — typed error codes with recovery hints.

Every s402 error tells the client:
  1. What went wrong (code)
  2. Whether it can retry (retryable)
  3. What to do about it (suggested_action)
"""

from __future__ import annotations

from typing import Literal

S402ErrorCode = Literal[
    "INSUFFICIENT_BALANCE",
    "MANDATE_EXPIRED",
    "MANDATE_LIMIT_EXCEEDED",
    "STREAM_DEPLETED",
    "ESCROW_DEADLINE_PASSED",
    "UNLOCK_DECRYPTION_FAILED",
    "FINALITY_TIMEOUT",
    "FACILITATOR_UNAVAILABLE",
    "INVALID_PAYLOAD",
    "SCHEME_NOT_SUPPORTED",
    "NETWORK_MISMATCH",
    "SIGNATURE_INVALID",
    "REQUIREMENTS_EXPIRED",
    "VERIFICATION_FAILED",
    "SETTLEMENT_FAILED",
]

_ERROR_HINTS: dict[str, tuple[bool, str]] = {
    "INSUFFICIENT_BALANCE": (False, "Top up wallet balance or try with a smaller amount"),
    "MANDATE_EXPIRED": (False, "Request a new mandate from the delegator"),
    "MANDATE_LIMIT_EXCEEDED": (False, "Request mandate increase or split across transactions"),
    "STREAM_DEPLETED": (True, "Top up the stream deposit"),
    "ESCROW_DEADLINE_PASSED": (False, "Create a new escrow with a later deadline"),
    "UNLOCK_DECRYPTION_FAILED": (True, "Re-request decryption key with a fresh session key"),
    "FINALITY_TIMEOUT": (True, "Transaction submitted but not confirmed — retry finality check"),
    "FACILITATOR_UNAVAILABLE": (True, "Fall back to direct settlement if signer is available"),
    "INVALID_PAYLOAD": (False, "Check payload format and re-sign the transaction"),
    "SCHEME_NOT_SUPPORTED": (False, 'Use the "exact" scheme (always supported for x402 compat)'),
    "NETWORK_MISMATCH": (False, "Ensure client and server are on the same network"),
    "SIGNATURE_INVALID": (False, "Re-sign the transaction with the correct keypair"),
    "REQUIREMENTS_EXPIRED": (True, "Re-fetch payment requirements from the server"),
    "VERIFICATION_FAILED": (False, "Check payment amount and transaction structure"),
    "SETTLEMENT_FAILED": (True, "Transient RPC failure during settlement — retry in a few seconds"),
}


class S402Error(Exception):
    """s402 error with machine-readable code, retryable flag, and recovery hint."""

    code: str
    retryable: bool
    suggested_action: str

    def __init__(self, code: str, message: str | None = None) -> None:
        hints = _ERROR_HINTS.get(code, (False, "Unknown error"))
        super().__init__(message or code)
        self.code = code
        self.retryable = hints[0]
        self.suggested_action = hints[1]
