"""s402 ↔ x402 Compatibility Layer.

Since wire v2 (ADR-016) s402's own 402 IS an x402 V2 ``PaymentRequired``
envelope, so the x402 direction of this module is the NATIVE decode path rather
than a translation layer. What is left to convert are the two retired flat
shapes:

  - **x402 V1** — ``{ x402Version: 1, scheme, network, maxAmountRequired, ... }``
  - **s402 v1** — ``{ s402Version: "1", accepts: ["exact"], network, ... }``

Reading our own past is an obligation (ADR-013); nothing here emits either shape.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlparse

from .errors import S402Error
from .http import (
    is_valid_amount,
    pick_requirements_fields,
    to_requirements_wire,
    validate_requirements_shape,
)


def is_s402(obj: dict[str, Any]) -> bool:
    """True for the retired s402 v1 flat shape.

    ``s402Version`` no longer appears on any 402 s402 emits. Its presence means
    the document was written by a pre-wire-v2 server.
    """
    return "s402Version" in obj


def is_x402(obj: dict[str, Any]) -> bool:
    """True for x402 format (V1 flat or V2 envelope)."""
    return "x402Version" in obj and "s402Version" not in obj


def is_x402_envelope(obj: dict[str, Any]) -> bool:
    """True for an x402 V2 envelope — which is also the shape s402 itself emits."""
    return "x402Version" in obj and isinstance(obj.get("accepts"), list) and "s402Version" not in obj


def x402_payment_flow_of(req: dict[str, Any]) -> str:
    """Read the payment flow an x402 requirement declares.

    Absent means ``authorization`` — the spec's own reading, not a convenience
    default. A value that is neither throws: defaulting an unrecognized flow
    would be a guess about resource-server ordering, and the guess a client wants
    least is the one that says "you have not been charged."
    """
    extra = req.get("extra")
    raw = extra.get("paymentFlow") if isinstance(extra, dict) else None
    if raw is None:
        return "authorization"
    if raw in ("authorization", "upfront"):
        return raw
    raise S402Error(
        "INVALID_PAYLOAD",
        f'x402 extra.paymentFlow "{raw}" is not a flow this build knows; '
        'expected "authorization" or "upfront"',
    )


def _validate_facilitator_url(value: str) -> None:
    """Reject SSRF-capable URL schemes and embedded credentials."""
    try:
        parsed = urlparse(value)
        if parsed.scheme not in ("https", "http"):
            raise S402Error("INVALID_PAYLOAD", f'facilitatorUrl must use https:// or http://, got "{parsed.scheme}:"')
        if parsed.username or parsed.password:
            raise S402Error("INVALID_PAYLOAD", "facilitatorUrl must not contain embedded credentials (user:password@)")
    except S402Error:
        raise
    except Exception:
        raise S402Error("INVALID_PAYLOAD", "facilitatorUrl is not a valid URL")


def from_x402_requirements(x402: dict[str, Any], now: int | None = None) -> dict[str, Any]:
    """Convert one inbound x402 requirement into one s402 ``accepts[]`` entry.

    Handles both V1 (``maxAmountRequired``) and V2 (``amount``). Accepts only
    ``exact`` — the sole x402 scheme with an s402 equivalent wired today. Any
    other scheme is rejected loudly rather than silently relabeled.

    ⚠️ **Wire v2 changed the return value.** This used to return a whole flat
    s402 402 document; it now returns a single requirement entry, because a 402
    is a list of them. Build the envelope with ``normalize_requirements()``.
    """
    if x402.get("scheme") != "exact":
        raise S402Error(
            "SCHEME_NOT_SUPPORTED",
            f'x402 scheme "{x402.get("scheme")}" has no s402 mapping; only "exact" is accepted inbound',
        )

    amount = x402.get("amount") or x402.get("maxAmountRequired")
    if not amount:
        raise S402Error("INVALID_PAYLOAD", 'x402 requirements missing both "amount" (V2) and "maxAmountRequired" (V1)')
    if not isinstance(amount, str) or not is_valid_amount(amount):
        raise S402Error("INVALID_PAYLOAD", f'Invalid amount "{amount}": must be a non-negative integer string')

    # Refuse a requirement whose resource-server ordering we cannot name.
    x402_payment_flow_of(x402)

    facilitator_url = x402.get("facilitatorUrl")
    if facilitator_url is not None:
        _validate_facilitator_url(facilitator_url)

    # Compute expiresAt from x402's maxTimeoutSeconds to preserve stale-payment
    # rejection. Without it, inbound x402 traffic bypasses every expiry guard,
    # because those guards skip an undefined expiresAt.
    max_timeout = x402.get("maxTimeoutSeconds")
    entry: dict[str, Any] = {
        "scheme": "exact",
        "network": x402.get("network"),
        "asset": x402.get("asset"),
        "amount": amount,
        "payTo": x402.get("payTo"),
    }
    if max_timeout is not None:
        entry["maxTimeoutSeconds"] = max_timeout
    if facilitator_url is not None:
        entry["facilitatorUrl"] = facilitator_url
    if isinstance(max_timeout, (int, float)) and not isinstance(max_timeout, bool) and max_timeout > 0:
        ref = now if now is not None else int(time.time() * 1000)
        entry["expiresAt"] = ref + int(max_timeout) * 1000
    if x402.get("extensions") is not None:
        entry["extensions"] = x402["extensions"]
    return entry


def _validate_x402_shape(obj: dict[str, Any]) -> None:
    """Validate that an x402 object has required fields (supports V1 and V2)."""
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
        amt = obj["amount"] if isinstance(obj.get("amount"), str) else obj.get("maxAmountRequired")
        if isinstance(amt, str) and not is_valid_amount(amt):
            raise S402Error("INVALID_PAYLOAD", f'Invalid amount "{amt}": must be a non-negative integer string')
    if missing:
        raise S402Error("INVALID_PAYLOAD", f"Malformed x402 requirements: missing or invalid fields: {', '.join(missing)}")


#: The v1 flat fields that describe the offer itself, and so ride on every
#: expanded entry.
_V1_SHARED_KEYS = [
    "network", "asset", "amount", "payTo",
    "facilitatorUrl", "protocolFeeBps", "protocolFeeAddress", "receiptRequired",
    "settlementMode", "expiresAt",
    "upto", "settlementOverrides", "prepaid", "stream", "escrow", "unlock",
    "extensions",
]


def from_s402_v1_requirements(
    v1: dict[str, Any],
    resource: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Decode the RETIRED s402 v1 flat requirements shape into a wire-v2 402.

    v1 was ``{ s402Version: "1", accepts: ["exact", "prepaid"], network, asset,
    amount, payTo, ... }`` — one price line plus a list of scheme NAMES. v2 is
    one ``accepts[]`` entry per scheme, so a v1 document expands: every entry
    carries the same network/asset/amount/payTo and the same per-requirement
    fields, and differs only in ``scheme``.

    **Nothing emits v1.** This exists because understanding what a peer said is
    an obligation and saying it yourself is not (ADR-013), and it is scoped to
    one major version. ``exact`` is hoisted to the front for the same reason the
    emitter does it: an x402 client pays the first entry it can handle.

    v1 had no ``resource``; x402's V2 envelope requires one. Pass the URL you
    fetched if you have it — an empty ``url`` is honest about not knowing.

    Raises:
        S402Error: ``INVALID_PAYLOAD`` if the document is not a well-formed v1 402.
    """
    if v1 is None or not isinstance(v1, dict):
        kind = "null" if v1 is None else ("array" if isinstance(v1, list) else type(v1).__name__)
        raise S402Error("INVALID_PAYLOAD", f"s402 v1 requirements must be a plain object, got {kind}")
    if v1.get("s402Version") != "1":
        raise S402Error(
            "INVALID_PAYLOAD",
            f'Unsupported s402Version {v1.get("s402Version")!r}: from_s402_v1_requirements reads the flat "1" shape only.',
        )
    if not isinstance(v1.get("accepts"), list) or len(v1["accepts"]) == 0:
        raise S402Error("INVALID_PAYLOAD", "s402 v1 requirements must carry a non-empty accepts array of scheme names")
    for scheme in v1["accepts"]:
        if not isinstance(scheme, str) or len(scheme) == 0:
            raise S402Error(
                "INVALID_PAYLOAD",
                f"Invalid entry in s402 v1 accepts array: expected a non-empty string, got {type(scheme).__name__}",
            )

    # Deduplicate, then hoist `exact` — v1 documents were not required to list it
    # first, and wire v2 is. `sorted` is stable, so everything else keeps order.
    schemes = sorted(dict.fromkeys(v1["accepts"]), key=lambda s: 0 if s == "exact" else 1)

    # Every v1 field except `accepts` describes the ONE offer the document made;
    # each expanded entry therefore carries all of them.
    shared = {key: v1[key] for key in _V1_SHARED_KEYS if v1.get(key) is not None}

    required: dict[str, Any] = {
        "x402Version": 2,
        "resource": resource if resource is not None else {"url": ""},
        "accepts": [{**shared, "scheme": scheme} for scheme in schemes],
    }
    if v1.get("mandate") is not None:
        required["mandate"] = v1["mandate"]

    # Validate through the canonical wire validator rather than a second copy of
    # it: project to the wire, check, and lift back. A v1 document with a bad
    # amount or a `file://` facilitatorUrl fails here exactly as it did before.
    wire = to_requirements_wire(required)
    validate_requirements_shape(wire, lifted_from_legacy=True)
    return pick_requirements_fields(wire)


def from_x402_envelope(envelope: dict[str, Any], now: int | None = None) -> dict[str, Any]:
    """Decode an x402 V2 ``PaymentRequired`` envelope.

    Since wire v2 this is the NATIVE shape, so the conversion is identity plus
    the ``extra`` projection.
    """
    return normalize_requirements(envelope, now)


def normalize_requirements(obj: Any, now: int | None = None) -> dict[str, Any]:
    """Auto-detect and normalize any 402 document into s402's wire-v2 shape.

    ⚠️ One thing is added rather than copied. When a document carries no
    ``extensions.s402`` — a plain x402 402, from a server that has never heard of
    s402 — an entry with no ``expiresAt`` gets one derived from its
    ``maxTimeoutSeconds``. s402's own documents are never touched: they say what
    they mean about expiry, including by saying nothing.

    Args:
        obj: Raw decoded JSON (s402 wire v2 / x402 V2, x402 V1, or s402 v1).
        now: Clock (epoch ms) for that derivation. Defaults to the system clock.

    Raises:
        S402Error: ``INVALID_PAYLOAD`` if the format is unrecognized or malformed.
    """
    if obj is None or not isinstance(obj, dict):
        kind = "null" if obj is None else ("array" if isinstance(obj, list) else type(obj).__name__)
        raise S402Error("INVALID_PAYLOAD", f"Payment requirements must be a plain object, got {kind}")

    # s402 v1 flat — the retired shape. ADR-013: we read it, we never write it.
    if is_s402(obj):
        return from_s402_v1_requirements(obj)

    # x402 V2 envelope — and s402's own wire v2, which is the same document.
    # `pick_requirements_fields` is the whole decode, foreign-expiry derivation
    # included; there is one copy of that rule and it is on the decode path.
    if is_x402_envelope(obj):
        validate_requirements_shape(obj)
        return pick_requirements_fields(obj, now)

    # x402 V1 flat.
    if is_x402(obj):
        _validate_x402_shape(obj)
        entry = from_x402_requirements(obj, now)
        # V1 carried resource metadata on the requirement itself; V2 hoists it.
        resource: dict[str, Any] = {"url": obj.get("resource") or ""}
        if obj.get("description"):
            resource["description"] = obj["description"]
        required = {"x402Version": 2, "resource": resource, "accepts": [entry]}
        wire = to_requirements_wire(required)
        validate_requirements_shape(wire, lifted_from_legacy=True)
        return pick_requirements_fields(wire)

    raise S402Error("INVALID_PAYLOAD", "Unrecognized payment requirements format: missing s402Version or x402Version")


__all__ = [
    "is_s402",
    "is_x402",
    "is_x402_envelope",
    "x402_payment_flow_of",
    "from_x402_requirements",
    "from_x402_envelope",
    "from_s402_v1_requirements",
    "normalize_requirements",
]
