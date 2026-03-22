"""s402 ↔ x402 Compatibility Layer.

Enables bidirectional interop:
  - x402 clients can talk to s402 servers (via "exact" scheme)
  - s402 clients can talk to x402 servers (graceful degradation)
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from .errors import S402Error
from .http import S402_VERSION, is_valid_amount, validate_requirements_shape, pick_requirements_fields


def is_s402(obj: dict[str, Any]) -> bool:
    """Check if a decoded JSON object is s402 format."""
    return "s402Version" in obj


def is_x402(obj: dict[str, Any]) -> bool:
    """Check if a decoded JSON object is x402 format (not s402)."""
    return "x402Version" in obj and "s402Version" not in obj


def is_x402_envelope(obj: dict[str, Any]) -> bool:
    """Check if a decoded JSON object is an x402 V2 envelope."""
    return "x402Version" in obj and isinstance(obj.get("accepts"), list) and "s402Version" not in obj


def from_x402_requirements(x402: dict[str, Any]) -> dict[str, Any]:
    """Convert x402 requirements to s402 format."""
    amount = x402.get("amount") or x402.get("maxAmountRequired")
    if not amount:
        raise S402Error("INVALID_PAYLOAD", 'x402 requirements missing both "amount" (V2) and "maxAmountRequired" (V1)')
    if not isinstance(amount, str) or not is_valid_amount(amount):
        raise S402Error("INVALID_PAYLOAD", f'Invalid amount "{amount}": must be a non-negative integer string')

    facilitator_url = x402.get("facilitatorUrl")
    if facilitator_url is not None:
        try:
            parsed = urlparse(facilitator_url)
            if parsed.scheme not in ("https", "http"):
                raise S402Error("INVALID_PAYLOAD", f'facilitatorUrl must use https:// or http://, got "{parsed.scheme}:"')
            if parsed.username or parsed.password:
                raise S402Error("INVALID_PAYLOAD", "facilitatorUrl must not contain embedded credentials (user:password@)")
        except S402Error:
            raise
        except Exception:
            raise S402Error("INVALID_PAYLOAD", "facilitatorUrl is not a valid URL")

    result: dict[str, Any] = {
        "s402Version": S402_VERSION,
        "accepts": ["exact"],
        "network": x402["network"],
        "asset": x402["asset"],
        "amount": amount,
        "payTo": x402["payTo"],
    }
    if facilitator_url is not None:
        result["facilitatorUrl"] = facilitator_url
    extensions = x402.get("extensions")
    if extensions is not None:
        result["extensions"] = extensions
    return result


def _validate_x402_shape(obj: dict[str, Any]) -> None:
    """Validate x402 required fields."""
    missing: list[str] = []
    if not isinstance(obj.get("scheme"), str):
        missing.append("scheme (string)")
    if not isinstance(obj.get("network"), str):
        missing.append("network (string)")
    if not isinstance(obj.get("asset"), str):
        missing.append("asset (string)")
    if not isinstance(obj.get("payTo"), str):
        missing.append("payTo (string)")
    if not isinstance(obj.get("amount"), str) and not isinstance(obj.get("maxAmountRequired"), str):
        missing.append("amount or maxAmountRequired (string)")
    else:
        amt = obj.get("amount") if isinstance(obj.get("amount"), str) else obj.get("maxAmountRequired")
        if isinstance(amt, str) and not is_valid_amount(amt):
            raise S402Error("INVALID_PAYLOAD", f'Invalid amount "{amt}": must be a non-negative integer string')
    if missing:
        raise S402Error("INVALID_PAYLOAD", f"Malformed x402 requirements: missing or invalid fields: {', '.join(missing)}")


def from_x402_envelope(envelope: dict[str, Any]) -> dict[str, Any]:
    """Convert x402 V2 envelope to s402 format."""
    accepts = envelope.get("accepts")
    if not accepts or not isinstance(accepts, list) or len(accepts) == 0:
        raise S402Error("INVALID_PAYLOAD", "x402 V2 envelope has empty accepts array")
    req = {**accepts[0], "x402Version": envelope.get("x402Version")}
    _validate_x402_shape(req)
    return from_x402_requirements(req)


def normalize_requirements(obj: Any) -> dict[str, Any]:
    """Auto-detect and normalize: x402 or s402 → validated s402 requirements.

    Returns a clean object with only known s402 fields.
    """
    if obj is None or not isinstance(obj, dict):
        t = "null" if obj is None else ("array" if isinstance(obj, list) else type(obj).__name__)
        raise S402Error("INVALID_PAYLOAD", f"Payment requirements must be a plain object, got {t}")

    if is_s402(obj):
        validate_requirements_shape(obj)
        return pick_requirements_fields(obj)

    if is_x402_envelope(obj):
        result = from_x402_envelope(obj)
        validate_requirements_shape(result)
        return pick_requirements_fields(result)

    if is_x402(obj):
        _validate_x402_shape(obj)
        result = from_x402_requirements(obj)
        validate_requirements_shape(result)
        return pick_requirements_fields(result)

    raise S402Error("INVALID_PAYLOAD", "Unrecognized payment requirements format: missing s402Version or x402Version")
