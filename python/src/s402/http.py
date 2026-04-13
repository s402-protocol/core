"""s402 HTTP Helpers — encode/decode for HTTP headers and body transport.

Wire-compatible with x402: same header names, same base64 encoding.
Uses Unicode-safe base64 (UTF-8 → base64).
"""

from __future__ import annotations

import base64
import json
import math
import re
from typing import Any
from urllib.parse import urlparse

from .errors import S402Error

# ══════════════════════════════════════════════════════════════
# Constants
# ══════════════════════════════════════════════════════════════

S402_VERSION = "1"

S402_HEADERS = {
    "PAYMENT_REQUIRED": "payment-required",
    "PAYMENT": "x-payment",
    "PAYMENT_RESPONSE": "payment-response",
    "STREAM_ID": "x-stream-id",
}

S402_CONTENT_TYPE = "application/s402+json"

VALID_SCHEMES = frozenset({"exact", "upto", "stream", "escrow", "unlock", "prepaid"})

MAX_HEADER_BYTES = 64 * 1024

# ══════════════════════════════════════════════════════════════
# Amount validation
# ══════════════════════════════════════════════════════════════

_AMOUNT_RE = re.compile(r"^(0|[1-9][0-9]*)$")
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")


def is_valid_amount(s: str) -> bool:
    """Check that a string is a canonical non-negative integer. No magnitude bound."""
    return bool(_AMOUNT_RE.match(s))


# ══════════════════════════════════════════════════════════════
# Key allowlists (must match TS insertion order exactly)
# ══════════════════════════════════════════════════════════════

_REQUIREMENTS_KEYS = [
    "s402Version", "accepts", "network", "asset", "amount", "payTo",
    "facilitatorUrl", "mandate", "protocolFeeBps", "protocolFeeAddress",
    "receiptRequired", "settlementMode", "expiresAt",
    "upto", "settlementOverrides", "prepaid", "stream", "escrow", "unlock", "extensions",
]

_SUB_OBJECT_KEYS: dict[str, list[str]] = {
    "mandate": ["required", "minPerTx", "coinType"],
    "upto": ["maxAmount", "settlementDeadlineMs", "usageReportUrl", "estimatedAmount"],
    "settlementOverrides": ["actualAmount"],
    "stream": ["ratePerSecond", "budgetCap", "minDeposit", "streamSetupUrl"],
    "escrow": ["seller", "arbiter", "deadlineMs"],
    "unlock": ["encryptionId", "encryptedContentId", "encryptionServiceId"],
    "prepaid": ["ratePerCall", "maxCalls", "minDeposit", "withdrawalDelayMs", "providerPubkey", "disputeWindowMs"],
}

_PAYLOAD_TOP_KEYS = ["s402Version", "scheme", "payload"]

_PAYLOAD_INNER_KEYS: dict[str, list[str]] = {
    "exact": ["transaction", "signature"],
    "upto": ["transaction", "signature", "maxAmount", "settlementCeiling"],
    "stream": ["transaction", "signature"],
    "escrow": ["transaction", "signature"],
    "unlock": ["transaction", "signature", "encryptionId"],
    "prepaid": ["transaction", "signature", "ratePerCall", "maxCalls"],
}

_SETTLE_RESPONSE_KEYS = [
    "success", "txDigest", "receiptId", "finalityMs",
    "actualAmount", "depositId", "balanceId", "streamId", "escrowId",
    "error", "errorCode",
]

# ══════════════════════════════════════════════════════════════
# Base64 encode/decode (Unicode-safe)
# ══════════════════════════════════════════════════════════════


def _to_base64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def _from_base64(b64: str) -> str:
    return base64.b64decode(b64).decode("utf-8")


# ══════════════════════════════════════════════════════════════
# Key stripping (trust boundary)
# ══════════════════════════════════════════════════════════════


def _pick_sub_object(key: str, value: Any) -> Any:
    allowed = _SUB_OBJECT_KEYS.get(key)
    if allowed is None or value is None or not isinstance(value, dict):
        return value
    return {k: value[k] for k in allowed if k in value}


def pick_requirements_fields(obj: dict[str, Any]) -> dict[str, Any]:
    """Return a clean dict with only known s402 requirements keys, in allowlist order."""
    result: dict[str, Any] = {}
    for key in _REQUIREMENTS_KEYS:
        if key in obj:
            if key in _SUB_OBJECT_KEYS:
                result[key] = _pick_sub_object(key, obj[key])
            else:
                result[key] = obj[key]
    return result


def pick_payload_fields(obj: dict[str, Any]) -> dict[str, Any]:
    """Return a clean payload dict with only known keys, in allowlist order."""
    result: dict[str, Any] = {}
    for key in _PAYLOAD_TOP_KEYS:
        if key in obj:
            result[key] = obj[key]
    # Strip unknown inner payload fields
    if isinstance(result.get("payload"), dict) and isinstance(result.get("scheme"), str):
        allowed_inner = _PAYLOAD_INNER_KEYS.get(result["scheme"])
        if allowed_inner:
            inner = result["payload"]
            result["payload"] = {k: inner[k] for k in allowed_inner if k in inner}
    return result


def pick_settle_response_fields(obj: dict[str, Any]) -> dict[str, Any]:
    """Return a clean settle response with only known keys, in allowlist order."""
    return {k: obj[k] for k in _SETTLE_RESPONSE_KEYS if k in obj}


# ══════════════════════════════════════════════════════════════
# Sub-object validators
# ══════════════════════════════════════════════════════════════


def _assert_string(obj: dict, field: str, label: str) -> None:
    if not isinstance(obj.get(field), str):
        raise S402Error("INVALID_PAYLOAD", f"{label}.{field} must be a string, got {type(obj.get(field)).__name__}")


def _assert_optional_string(obj: dict, field: str, label: str) -> None:
    if field in obj and obj[field] is not None and not isinstance(obj[field], str):
        raise S402Error("INVALID_PAYLOAD", f"{label}.{field} must be a string if provided, got {type(obj[field]).__name__}")


def validate_mandate_shape(value: Any) -> None:
    if not isinstance(value, dict):
        raise S402Error("INVALID_PAYLOAD", f"mandate must be a plain object, got {type(value).__name__}")
    if not isinstance(value.get("required"), bool):
        raise S402Error("INVALID_PAYLOAD", f"mandate.required must be a boolean, got {type(value.get('required')).__name__}")
    _assert_optional_string(value, "minPerTx", "mandate")
    if isinstance(value.get("minPerTx"), str) and not is_valid_amount(value["minPerTx"]):
        raise S402Error("INVALID_PAYLOAD", f'mandate.minPerTx must be a non-negative integer string, got "{value["minPerTx"]}"')
    _assert_optional_string(value, "coinType", "mandate")


def validate_stream_shape(value: Any) -> None:
    if not isinstance(value, dict):
        raise S402Error("INVALID_PAYLOAD", f"stream must be a plain object, got {type(value).__name__}")
    _assert_string(value, "ratePerSecond", "stream")
    if isinstance(value.get("ratePerSecond"), str) and not is_valid_amount(value["ratePerSecond"]):
        raise S402Error("INVALID_PAYLOAD", f'stream.ratePerSecond must be a non-negative integer string, got "{value["ratePerSecond"]}"')
    _assert_string(value, "budgetCap", "stream")
    if isinstance(value.get("budgetCap"), str) and not is_valid_amount(value["budgetCap"]):
        raise S402Error("INVALID_PAYLOAD", f'stream.budgetCap must be a non-negative integer string, got "{value["budgetCap"]}"')
    _assert_string(value, "minDeposit", "stream")
    if isinstance(value.get("minDeposit"), str) and not is_valid_amount(value["minDeposit"]):
        raise S402Error("INVALID_PAYLOAD", f'stream.minDeposit must be a non-negative integer string, got "{value["minDeposit"]}"')
    _assert_optional_string(value, "streamSetupUrl", "stream")


def validate_escrow_shape(value: Any) -> None:
    if not isinstance(value, dict):
        raise S402Error("INVALID_PAYLOAD", f"escrow must be a plain object, got {type(value).__name__}")
    _assert_string(value, "seller", "escrow")
    _assert_string(value, "deadlineMs", "escrow")
    if isinstance(value.get("deadlineMs"), str) and not is_valid_amount(value["deadlineMs"]):
        raise S402Error("INVALID_PAYLOAD", f'escrow.deadlineMs must be a non-negative integer string (Unix timestamp ms), got "{value["deadlineMs"]}"')
    _assert_optional_string(value, "arbiter", "escrow")


def validate_unlock_shape(value: Any) -> None:
    if not isinstance(value, dict):
        raise S402Error("INVALID_PAYLOAD", f"unlock must be a plain object, got {type(value).__name__}")
    _assert_string(value, "encryptionId", "unlock")
    _assert_string(value, "encryptedContentId", "unlock")
    _assert_string(value, "encryptionServiceId", "unlock")


def validate_upto_shape(value: Any) -> None:
    if not isinstance(value, dict):
        raise S402Error("INVALID_PAYLOAD", f"upto must be a plain object, got {type(value).__name__}")
    _assert_string(value, "maxAmount", "upto")
    if isinstance(value.get("maxAmount"), str) and not is_valid_amount(value["maxAmount"]):
        raise S402Error("INVALID_PAYLOAD", f'upto.maxAmount must be a non-negative integer string, got "{value["maxAmount"]}"')
    _assert_string(value, "settlementDeadlineMs", "upto")
    if isinstance(value.get("settlementDeadlineMs"), str) and not is_valid_amount(value["settlementDeadlineMs"]):
        raise S402Error("INVALID_PAYLOAD", f'upto.settlementDeadlineMs must be a non-negative integer string (Unix timestamp ms), got "{value["settlementDeadlineMs"]}"')
    _assert_optional_string(value, "usageReportUrl", "upto")
    _assert_optional_string(value, "estimatedAmount", "upto")
    if isinstance(value.get("estimatedAmount"), str):
        if not is_valid_amount(value["estimatedAmount"]):
            raise S402Error("INVALID_PAYLOAD", f'upto.estimatedAmount must be a non-negative integer string, got "{value["estimatedAmount"]}"')
        if isinstance(value.get("maxAmount"), str) and is_valid_amount(value["maxAmount"]):
            est = int(value["estimatedAmount"])
            max_amt = int(value["maxAmount"])
            if est > max_amt:
                raise S402Error("INVALID_PAYLOAD", f"upto.estimatedAmount ({value['estimatedAmount']}) must be <= maxAmount ({value['maxAmount']})")


def validate_settlement_overrides_shape(value: Any) -> None:
    if not isinstance(value, dict):
        raise S402Error("INVALID_PAYLOAD", f"settlementOverrides must be a plain object, got {type(value).__name__}")
    _assert_optional_string(value, "actualAmount", "settlementOverrides")


def validate_prepaid_shape(value: Any) -> None:
    if not isinstance(value, dict):
        raise S402Error("INVALID_PAYLOAD", f"prepaid must be a plain object, got {type(value).__name__}")
    _assert_string(value, "ratePerCall", "prepaid")
    if isinstance(value.get("ratePerCall"), str) and not is_valid_amount(value["ratePerCall"]):
        raise S402Error("INVALID_PAYLOAD", f'prepaid.ratePerCall must be a non-negative integer string, got "{value["ratePerCall"]}"')
    _assert_string(value, "minDeposit", "prepaid")
    if isinstance(value.get("minDeposit"), str) and not is_valid_amount(value["minDeposit"]):
        raise S402Error("INVALID_PAYLOAD", f'prepaid.minDeposit must be a non-negative integer string, got "{value["minDeposit"]}"')
    _assert_string(value, "withdrawalDelayMs", "prepaid")
    if isinstance(value.get("withdrawalDelayMs"), str):
        if not is_valid_amount(value["withdrawalDelayMs"]):
            raise S402Error("INVALID_PAYLOAD", f'prepaid.withdrawalDelayMs must be a non-negative integer string (milliseconds), got "{value["withdrawalDelayMs"]}"')
        delay_ms = int(value["withdrawalDelayMs"])
        if delay_ms < 60_000 or delay_ms > 604_800_000:
            raise S402Error("INVALID_PAYLOAD", f'prepaid.withdrawalDelayMs must be between 60000 (1 min) and 604800000 (7 days), got "{value["withdrawalDelayMs"]}"')
    _assert_optional_string(value, "maxCalls", "prepaid")
    _assert_optional_string(value, "providerPubkey", "prepaid")
    _assert_optional_string(value, "disputeWindowMs", "prepaid")
    has_pubkey = isinstance(value.get("providerPubkey"), str)
    has_window = isinstance(value.get("disputeWindowMs"), str)
    if has_pubkey != has_window:
        side = "providerPubkey only" if has_pubkey else "disputeWindowMs only"
        raise S402Error("INVALID_PAYLOAD", f"prepaid: providerPubkey and disputeWindowMs must both be present (v0.2) or both absent (v0.1), got {side}")


def _validate_sub_objects(record: dict[str, Any]) -> None:
    if "mandate" in record and record["mandate"] is not None:
        validate_mandate_shape(record["mandate"])
    if "upto" in record and record["upto"] is not None:
        validate_upto_shape(record["upto"])
    if "settlementOverrides" in record and record["settlementOverrides"] is not None:
        validate_settlement_overrides_shape(record["settlementOverrides"])
    if "stream" in record and record["stream"] is not None:
        validate_stream_shape(record["stream"])
    if "escrow" in record and record["escrow"] is not None:
        validate_escrow_shape(record["escrow"])
    if "unlock" in record and record["unlock"] is not None:
        validate_unlock_shape(record["unlock"])
    if "prepaid" in record and record["prepaid"] is not None:
        validate_prepaid_shape(record["prepaid"])


# ══════════════════════════════════════════════════════════════
# Shape validators (trust boundary)
# ══════════════════════════════════════════════════════════════


def validate_requirements_shape(obj: Any) -> None:
    """Validate decoded payment requirements. Raises S402Error on invalid shape."""
    if obj is None or not isinstance(obj, dict):
        raise S402Error("INVALID_PAYLOAD", "Payment requirements is not an object")

    if "s402Version" not in obj:
        raise S402Error("INVALID_PAYLOAD", 'Missing s402Version. For x402 format, use normalize_requirements() from s402.compat.')
    if obj["s402Version"] != "1":
        raise S402Error("INVALID_PAYLOAD", f'Unsupported s402 version "{obj["s402Version"]}". This library supports version "1".')

    missing: list[str] = []
    if not isinstance(obj.get("accepts"), list):
        missing.append("accepts (array)")
    if not isinstance(obj.get("network"), str):
        missing.append("network (string)")
    if not isinstance(obj.get("asset"), str):
        missing.append("asset (string)")
    if not isinstance(obj.get("amount"), str):
        missing.append("amount (string)")
    else:
        if not is_valid_amount(obj["amount"]):
            raise S402Error("INVALID_PAYLOAD", f'Invalid amount "{obj["amount"]}": must be a non-negative integer string')
    if not isinstance(obj.get("payTo"), str):
        missing.append("payTo (string)")
    elif len(obj["payTo"]) == 0:
        raise S402Error("INVALID_PAYLOAD", "payTo must be a non-empty string")

    if missing:
        raise S402Error("INVALID_PAYLOAD", f"Malformed payment requirements: missing {', '.join(missing)}")

    # Control character rejection
    if _CONTROL_CHAR_RE.search(obj["network"]):
        raise S402Error("INVALID_PAYLOAD", "network contains control characters")
    if _CONTROL_CHAR_RE.search(obj["asset"]):
        raise S402Error("INVALID_PAYLOAD", "asset contains control characters")
    if _CONTROL_CHAR_RE.search(obj["payTo"]):
        raise S402Error("INVALID_PAYLOAD", "payTo contains control characters")

    # Empty accepts
    if isinstance(obj.get("accepts"), list) and len(obj["accepts"]) == 0:
        raise S402Error("INVALID_PAYLOAD", "accepts array must contain at least one scheme")

    # accepts entries must be strings
    if isinstance(obj.get("accepts"), list):
        for scheme in obj["accepts"]:
            if not isinstance(scheme, str):
                raise S402Error("INVALID_PAYLOAD", f"Invalid entry in accepts array: expected string, got {type(scheme).__name__}")

    # Optional field validation
    if "protocolFeeBps" in obj and obj["protocolFeeBps"] is not None:
        v = obj["protocolFeeBps"]
        # isinstance(True, int) is True in Python — reject bools explicitly (JS typeof true !== 'number')
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and (not math.isfinite(v) or v != int(v))) or v < 0 or v > 10000:
            raise S402Error("INVALID_PAYLOAD", f"protocolFeeBps must be an integer between 0 and 10000, got {v}")

    if "expiresAt" in obj and obj["expiresAt"] is not None:
        v = obj["expiresAt"]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)) or v <= 0:
            raise S402Error("INVALID_PAYLOAD", f"expiresAt must be a positive finite number (Unix timestamp ms), got {v}")

    if "protocolFeeAddress" in obj and obj["protocolFeeAddress"] is not None:
        v = obj["protocolFeeAddress"]
        if not isinstance(v, str) or len(v) == 0:
            raise S402Error("INVALID_PAYLOAD", f"protocolFeeAddress must be a non-empty string, got {json.dumps(v)}")
        if _CONTROL_CHAR_RE.search(v):
            raise S402Error("INVALID_PAYLOAD", "protocolFeeAddress contains control characters")

    if "facilitatorUrl" in obj and obj["facilitatorUrl"] is not None:
        v = obj["facilitatorUrl"]
        if not isinstance(v, str):
            raise S402Error("INVALID_PAYLOAD", f"facilitatorUrl must be a string, got {type(v).__name__}")
        if _CONTROL_CHAR_RE.search(v):
            raise S402Error("INVALID_PAYLOAD", "facilitatorUrl contains control characters (potential header injection)")
        try:
            parsed = urlparse(v)
            if parsed.scheme not in ("https", "http"):
                raise S402Error("INVALID_PAYLOAD", f'facilitatorUrl must use https:// or http://, got "{parsed.scheme}:"')
            if parsed.username or parsed.password:
                raise S402Error("INVALID_PAYLOAD", "facilitatorUrl must not contain embedded credentials (user:password@)")
        except S402Error:
            raise
        except Exception:
            raise S402Error("INVALID_PAYLOAD", "facilitatorUrl is not a valid URL")

    if "settlementMode" in obj and obj["settlementMode"] is not None:
        if obj["settlementMode"] not in ("facilitator", "direct"):
            raise S402Error("INVALID_PAYLOAD", f'settlementMode must be "facilitator" or "direct", got {json.dumps(obj["settlementMode"])}')

    if "receiptRequired" in obj and obj["receiptRequired"] is not None:
        if not isinstance(obj["receiptRequired"], bool):
            raise S402Error("INVALID_PAYLOAD", f"receiptRequired must be a boolean, got {type(obj['receiptRequired']).__name__}")

    _validate_sub_objects(obj)


def _validate_payload_shape(obj: Any) -> None:
    """Validate decoded payment payload."""
    if obj is None or not isinstance(obj, dict):
        raise S402Error("INVALID_PAYLOAD", "Payment payload is not an object")

    if "s402Version" in obj and obj["s402Version"] is not None and obj["s402Version"] != "1":
        raise S402Error("INVALID_PAYLOAD", f'Unsupported s402 version "{obj["s402Version"]}" in payment payload. This library supports version "1".')

    missing: list[str] = []
    if not isinstance(obj.get("scheme"), str):
        missing.append("scheme")
    elif obj["scheme"] not in VALID_SCHEMES:
        raise S402Error("INVALID_PAYLOAD", f'Unknown payment scheme "{obj["scheme"]}". Valid: {", ".join(sorted(VALID_SCHEMES))}')
    if obj.get("payload") is None or not isinstance(obj.get("payload"), dict):
        missing.append("payload")
    if missing:
        raise S402Error("INVALID_PAYLOAD", f"Malformed payment payload: missing {', '.join(missing)}")

    inner = obj["payload"]
    if not isinstance(inner.get("transaction"), str):
        raise S402Error("INVALID_PAYLOAD", f"payload.transaction must be a string, got {type(inner.get('transaction')).__name__}")
    if not isinstance(inner.get("signature"), str):
        raise S402Error("INVALID_PAYLOAD", f"payload.signature must be a string, got {type(inner.get('signature')).__name__}")

    if obj["scheme"] == "upto":
        if not isinstance(inner.get("maxAmount"), str):
            raise S402Error("INVALID_PAYLOAD", f"upto payload requires maxAmount (string), got {type(inner.get('maxAmount')).__name__}")
        if isinstance(inner.get("maxAmount"), str) and not is_valid_amount(inner["maxAmount"]):
            raise S402Error("INVALID_PAYLOAD", f'upto payload maxAmount must be a non-negative integer string, got "{inner["maxAmount"]}"')
        if "settlementCeiling" in inner and inner["settlementCeiling"] is not None:
            if not isinstance(inner["settlementCeiling"], str):
                raise S402Error("INVALID_PAYLOAD", f"upto payload settlementCeiling must be a string if provided, got {type(inner['settlementCeiling']).__name__}")
            if not is_valid_amount(inner["settlementCeiling"]):
                raise S402Error("INVALID_PAYLOAD", f'upto payload settlementCeiling must be a non-negative integer string, got "{inner["settlementCeiling"]}"')
            ceiling = int(inner["settlementCeiling"])
            if ceiling < 1:
                raise S402Error("INVALID_PAYLOAD", f'upto payload settlementCeiling must be >= 1, got "{inner["settlementCeiling"]}"')
            max_amt = int(inner["maxAmount"])
            if ceiling > max_amt:
                raise S402Error("INVALID_PAYLOAD", f"upto payload settlementCeiling ({inner['settlementCeiling']}) must be <= maxAmount ({inner['maxAmount']})")
    if obj["scheme"] == "unlock" and not isinstance(inner.get("encryptionId"), str):
        raise S402Error("INVALID_PAYLOAD", f"unlock payload requires encryptionId (string), got {type(inner.get('encryptionId')).__name__}")
    if obj["scheme"] == "prepaid":
        if not isinstance(inner.get("ratePerCall"), str):
            raise S402Error("INVALID_PAYLOAD", f"prepaid payload requires ratePerCall (string), got {type(inner.get('ratePerCall')).__name__}")
        if isinstance(inner.get("ratePerCall"), str) and not is_valid_amount(inner["ratePerCall"]):
            raise S402Error("INVALID_PAYLOAD", f'prepaid payload ratePerCall must be a non-negative integer string, got "{inner["ratePerCall"]}"')
        if "maxCalls" in inner and inner["maxCalls"] is not None:
            if not isinstance(inner["maxCalls"], str):
                raise S402Error("INVALID_PAYLOAD", f"prepaid payload maxCalls must be a string if provided, got {type(inner['maxCalls']).__name__}")
            if not is_valid_amount(inner["maxCalls"]):
                raise S402Error("INVALID_PAYLOAD", f'prepaid payload maxCalls must be a non-negative integer string, got "{inner["maxCalls"]}"')


def _validate_settle_shape(obj: Any) -> None:
    """Validate decoded settle response."""
    if obj is None or not isinstance(obj, dict):
        raise S402Error("INVALID_PAYLOAD", "Settle response is not an object")
    if not isinstance(obj.get("success"), bool):
        raise S402Error("INVALID_PAYLOAD", 'Malformed settle response: missing or invalid "success" (boolean)')

    if "txDigest" in obj and obj["txDigest"] is not None and not isinstance(obj["txDigest"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: txDigest must be a string, got {type(obj['txDigest']).__name__}")
    if "receiptId" in obj and obj["receiptId"] is not None and not isinstance(obj["receiptId"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: receiptId must be a string, got {type(obj['receiptId']).__name__}")
    if "finalityMs" in obj and obj["finalityMs"] is not None:
        v = obj["finalityMs"]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)):
            raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: finalityMs must be a finite number, got {type(v).__name__}")
    if "actualAmount" in obj and obj["actualAmount"] is not None and not isinstance(obj["actualAmount"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: actualAmount must be a string, got {type(obj['actualAmount']).__name__}")
    if "depositId" in obj and obj["depositId"] is not None and not isinstance(obj["depositId"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: depositId must be a string, got {type(obj['depositId']).__name__}")
    if "streamId" in obj and obj["streamId"] is not None and not isinstance(obj["streamId"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: streamId must be a string, got {type(obj['streamId']).__name__}")
    if "escrowId" in obj and obj["escrowId"] is not None and not isinstance(obj["escrowId"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: escrowId must be a string, got {type(obj['escrowId']).__name__}")
    if "balanceId" in obj and obj["balanceId"] is not None and not isinstance(obj["balanceId"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: balanceId must be a string, got {type(obj['balanceId']).__name__}")
    if "error" in obj and obj["error"] is not None and not isinstance(obj["error"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: error must be a string, got {type(obj['error']).__name__}")
    if "errorCode" in obj and obj["errorCode"] is not None and not isinstance(obj["errorCode"], str):
        raise S402Error("INVALID_PAYLOAD", f"Malformed settle response: errorCode must be a string, got {type(obj['errorCode']).__name__}")


# ══════════════════════════════════════════════════════════════
# Encode (object → base64 string for HTTP header)
# ══════════════════════════════════════════════════════════════


def encode_payment_required(requirements: dict[str, Any]) -> str:
    """Encode payment requirements for the payment-required header."""
    return _to_base64(json.dumps(requirements, separators=(",", ":")))


def encode_payment_payload(payload: dict[str, Any]) -> str:
    """Encode payment payload for the x-payment header."""
    return _to_base64(json.dumps(payload, separators=(",", ":")))


def encode_settle_response(response: dict[str, Any]) -> str:
    """Encode settlement response for the payment-response header."""
    return _to_base64(json.dumps(response, separators=(",", ":")))


# ══════════════════════════════════════════════════════════════
# Decode (base64 string from HTTP header → object)
# ══════════════════════════════════════════════════════════════


def decode_payment_required(header: str) -> dict[str, Any]:
    """Decode and validate payment requirements from the payment-required header."""
    if not isinstance(header, str):
        raise S402Error("INVALID_PAYLOAD", f"payment-required header must be a string, got {type(header).__name__}")
    if len(header) > MAX_HEADER_BYTES:
        raise S402Error("INVALID_PAYLOAD", f"payment-required header exceeds maximum size ({len(header)} > {MAX_HEADER_BYTES})")
    try:
        parsed = json.loads(_from_base64(header))
    except Exception as e:
        raise S402Error("INVALID_PAYLOAD", f"Failed to decode payment-required header: {e}")
    validate_requirements_shape(parsed)
    return pick_requirements_fields(parsed)


def decode_payment_payload(header: str) -> dict[str, Any]:
    """Decode and validate payment payload from the x-payment header."""
    if not isinstance(header, str):
        raise S402Error("INVALID_PAYLOAD", f"x-payment header must be a string, got {type(header).__name__}")
    if len(header) > MAX_HEADER_BYTES:
        raise S402Error("INVALID_PAYLOAD", f"x-payment header exceeds maximum size ({len(header)} > {MAX_HEADER_BYTES})")
    try:
        parsed = json.loads(_from_base64(header))
    except Exception as e:
        raise S402Error("INVALID_PAYLOAD", f"Failed to decode x-payment header: {e}")
    _validate_payload_shape(parsed)
    return pick_payload_fields(parsed)


def decode_settle_response(header: str) -> dict[str, Any]:
    """Decode and validate settlement response from the payment-response header."""
    if not isinstance(header, str):
        raise S402Error("INVALID_PAYLOAD", f"payment-response header must be a string, got {type(header).__name__}")
    if len(header) > MAX_HEADER_BYTES:
        raise S402Error("INVALID_PAYLOAD", f"payment-response header exceeds maximum size ({len(header)} > {MAX_HEADER_BYTES})")
    try:
        parsed = json.loads(_from_base64(header))
    except Exception as e:
        raise S402Error("INVALID_PAYLOAD", f"Failed to decode payment-response header: {e}")
    _validate_settle_shape(parsed)
    return pick_settle_response_fields(parsed)


# ══════════════════════════════════════════════════════════════
# Body transport (raw JSON, no base64)
# ══════════════════════════════════════════════════════════════


def encode_requirements_body(requirements: dict[str, Any]) -> str:
    return json.dumps(requirements, separators=(",", ":"))


def decode_requirements_body(body: str) -> dict[str, Any]:
    if not isinstance(body, str):
        raise S402Error("INVALID_PAYLOAD", f"s402 requirements body must be a string, got {type(body).__name__}")
    try:
        parsed = json.loads(body)
    except Exception as e:
        raise S402Error("INVALID_PAYLOAD", f"Failed to parse s402 requirements body: {e}")
    validate_requirements_shape(parsed)
    return pick_requirements_fields(parsed)


def encode_payload_body(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"))


def decode_payload_body(body: str) -> dict[str, Any]:
    if not isinstance(body, str):
        raise S402Error("INVALID_PAYLOAD", f"s402 payload body must be a string, got {type(body).__name__}")
    try:
        parsed = json.loads(body)
    except Exception as e:
        raise S402Error("INVALID_PAYLOAD", f"Failed to parse s402 payload body: {e}")
    _validate_payload_shape(parsed)
    return pick_payload_fields(parsed)


def encode_settle_body(response: dict[str, Any]) -> str:
    return json.dumps(response, separators=(",", ":"))


def decode_settle_body(body: str) -> dict[str, Any]:
    if not isinstance(body, str):
        raise S402Error("INVALID_PAYLOAD", f"s402 settle body must be a string, got {type(body).__name__}")
    try:
        parsed = json.loads(body)
    except Exception as e:
        raise S402Error("INVALID_PAYLOAD", f"Failed to parse s402 settle body: {e}")
    _validate_settle_shape(parsed)
    return pick_settle_response_fields(parsed)


# ══════════════════════════════════════════════════════════════
# Protocol detection
# ══════════════════════════════════════════════════════════════


def detect_protocol(headers: dict[str, str]) -> str:
    """Detect 's402', 'x402', or 'unknown' from response headers."""
    payment_required = headers.get(S402_HEADERS["PAYMENT_REQUIRED"])
    if not payment_required:
        return "unknown"
    if len(payment_required) > MAX_HEADER_BYTES:
        return "unknown"
    try:
        decoded = json.loads(_from_base64(payment_required))
        if isinstance(decoded, dict):
            if "s402Version" in decoded:
                return "s402"
            if "x402Version" in decoded:
                return "x402"
    except Exception:
        pass
    return "unknown"
