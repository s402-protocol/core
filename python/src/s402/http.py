"""s402 HTTP Helpers — encode/decode for HTTP headers and body transport.

The `payment-required` document IS an x402 V2 `PaymentRequired` envelope
(ADR-016): ``{ x402Version: 2, resource, accepts: [...], extensions }``. s402's
per-requirement fields ride in each ``accepts[]`` entry's ``extra``; its
envelope-level fields ride in ``extensions.s402``. Nothing here emits the
retired v1 flat shape — reading it is an intake obligation discharged in
``s402.compat``.

Wire-compatible with x402: same header names, same base64 encoding.
Uses Unicode-safe base64 (UTF-8 → base64).
"""

from __future__ import annotations

import base64
import json
import math
import re
import time
from typing import Any
from urllib.parse import urlparse

from .errors import S402Error

# ══════════════════════════════════════════════════════════════
# Constants
# ══════════════════════════════════════════════════════════════

#: Version carried on a payment PAYLOAD (`x-payment`). Unchanged by wire v2.
S402_VERSION = "1"

#: Version of the 402 envelope, carried at ``extensions.s402.version``.
S402_WIRE_VERSION = "2"

#: x402's default when an ``accepts[]`` entry states no ``maxTimeoutSeconds``.
S402_DEFAULT_MAX_TIMEOUT_SECONDS = 60

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

#: x402 V2 ``ResourceInfo`` keys, per upstream ``types/payments.ts`` at the pin.
_RESOURCE_KEYS = ["url", "description", "mimeType", "serviceName", "tags", "iconUrl"]

#: x402 V2 ``PaymentRequirements`` keys — the shape of one ``accepts[]`` entry.
_X402_REQUIREMENT_KEYS = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"]

#: s402's per-requirement fields, in the order the encoder writes them into an
#: entry's ``extra``. x402 owns the six keys above; everything s402 adds to a
#: single offer lives here, because the top level is x402's.
#:
#: ⚠️ Order is load-bearing: the encoder writes passthrough keys first and then
#: these, so decode → re-encode is byte-identical.
_S402_EXTRA_KEYS = [
    "facilitatorUrl", "protocolFeeBps", "protocolFeeAddress", "receiptRequired",
    "settlementMode", "expiresAt",
    "upto", "settlementOverrides", "prepaid", "stream", "escrow", "unlock",
    "extensions",
]

#: The ``extensions`` key s402's envelope-level fields live under.
S402_EXTENSION_KEY = "s402"

_SUB_OBJECT_KEYS: dict[str, list[str]] = {
    "mandate": ["required", "minPerTx", "coinType"],
    "upto": ["maxAmount", "settlementDeadlineMs", "usageReportUrl", "estimatedAmount"],
    "settlementOverrides": ["actualAmount"],
    "stream": ["ratePerSecond", "budgetCap", "minDeposit", "streamSetupUrl"],
    "escrow": ["seller", "arbiter", "deadlineMs"],
    "unlock": ["packageId", "keyServers", "threshold", "contentDigest"],
    "prepaid": ["ratePerCall", "maxCalls", "minDeposit", "withdrawalDelayMs", "providerPubkey", "disputeWindowMs"],
}

_PAYLOAD_TOP_KEYS = ["s402Version", "scheme", "payload"]

_PAYLOAD_INNER_KEYS: dict[str, list[str]] = {
    "exact": ["transaction", "signature"],
    "upto": ["transaction", "signature", "maxAmount", "settlementCeiling"],
    "stream": ["transaction", "signature"],
    "escrow": ["transaction", "signature"],
    "unlock": ["transaction", "signature"],
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


def _is_plain_object(value: Any) -> bool:
    """True for a plain (non-list) dict — the Python reading of JS ``isPlainObject``."""
    return isinstance(value, dict)


# ══════════════════════════════════════════════════════════════
# Wire projection — s402 fields ↔ x402's `extra` / `extensions`
# ══════════════════════════════════════════════════════════════


def _exact_first(accepts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Put every ``exact`` offer at the front, keeping everything else in order.

    x402's client pays the FIRST entry it has a handler for, so an ``exact``
    entry listed third is one an x402 client walks past (ADR-016 rule 2). The
    encoder does the sort rather than trusting every caller to have read the ADR.
    """
    exact = [offer for offer in accepts if offer.get("scheme") == "exact"]
    if len(exact) == 0 or len(exact) == len(accepts):
        return list(accepts)
    return exact + [offer for offer in accepts if offer.get("scheme") != "exact"]


_MANDATE_FIELDS = ("required", "minPerTx", "coinType")


def resolve_mandate(
    accepts: list[dict[str, Any]],
    envelope_mandate: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """The one mandate this 402 declares, gathered from envelope and entries.

    A mandate authorizes the AGENT, not one price line, so it cannot differ per
    offer — the wire has exactly one slot for it, at ``extensions.s402.mandate``.
    In memory it is allowed to sit on each requirement, because that is where the
    facilitator and the schemes read it; this reconciles the two.

    Comparison is field-wise, not serialized: two mandates that differ only in
    key order are the same mandate.

    Raises:
        S402Error: ``INVALID_PAYLOAD`` if two of them disagree. Publishing one of
            two answers silently is the failure mode worth refusing.
    """
    found = envelope_mandate
    for offer in accepts or []:
        mandate = offer.get("mandate")
        if mandate is None:
            continue
        if found is None:
            found = mandate
            continue
        if any(found.get(f) != mandate.get(f) for f in _MANDATE_FIELDS):
            raise S402Error(
                "INVALID_PAYLOAD",
                "Conflicting mandate requirements on one 402: a mandate authorizes the agent, "
                "not a single offer, and the wire carries exactly one at extensions.s402.mandate. "
                f"Got {json.dumps(found)} and {json.dumps(mandate)}.",
            )
    return found


def _to_wire_requirement(req: dict[str, Any]) -> dict[str, Any]:
    """Project one s402 requirement into an x402 V2 ``PaymentRequirements``."""
    # Passthrough first, named s402 keys after: a key s402 names always wins over
    # a same-named key that arrived in `extra` from somewhere else.
    raw_extra = req.get("extra")
    extra: dict[str, Any] = dict(raw_extra) if _is_plain_object(raw_extra) else {}
    for key in _S402_EXTRA_KEYS:
        if req.get(key) is not None:
            extra[key] = req[key]

    max_timeout = req.get("maxTimeoutSeconds")
    if max_timeout is None:
        max_timeout = S402_DEFAULT_MAX_TIMEOUT_SECONDS

    out: dict[str, Any] = {}
    for key in ("scheme", "network", "asset", "amount", "payTo"):
        if req.get(key) is not None:
            out[key] = req[key]
    out["maxTimeoutSeconds"] = max_timeout
    out["extra"] = extra
    return out


def to_requirements_wire(required: dict[str, Any]) -> dict[str, Any]:
    """Project a 402 document into the x402 V2 ``PaymentRequired`` envelope it is.

    This is what ``encode_payment_required`` and ``encode_requirements_body`` put
    on the wire — one projection, not two.
    """
    raw_resource = required.get("resource")
    src = raw_resource if _is_plain_object(raw_resource) else {}
    resource = {key: src[key] for key in _RESOURCE_KEYS if src.get(key) is not None}

    raw_extensions = required.get("extensions")
    rest: dict[str, Any] = dict(raw_extensions) if _is_plain_object(raw_extensions) else {}
    carried_raw = rest.pop(S402_EXTENSION_KEY, None)
    carried = carried_raw if _is_plain_object(carried_raw) else {}

    s402_ext: dict[str, Any] = {"version": S402_WIRE_VERSION}
    mandate = resolve_mandate(required.get("accepts") or [], required.get("mandate"))
    if mandate is not None:
        s402_ext["mandate"] = mandate
    for key, value in carried.items():
        if key not in ("version", "mandate"):
            s402_ext[key] = value

    out: dict[str, Any] = {"x402Version": 2}
    if required.get("error") is not None:
        out["error"] = required["error"]
    out["resource"] = resource
    out["accepts"] = [_to_wire_requirement(o) for o in _exact_first(required.get("accepts") or [])]
    out["extensions"] = {**rest, S402_EXTENSION_KEY: s402_ext}
    return out


def _from_wire_requirement(raw: dict[str, Any]) -> dict[str, Any]:
    """Lift one wire ``accepts[]`` entry back to the flat s402 requirement.

    Unrecognized ``extra`` keys are KEPT (in ``extra``), not stripped: x402's
    ``extra`` is an open bag by spec, and a whitelist at this boundary is exactly
    where the next upstream field would go missing without erroring.
    """
    out: dict[str, Any] = {}
    for key in _X402_REQUIREMENT_KEYS:
        if key != "extra" and key in raw:
            out[key] = raw[key]

    raw_extra = raw.get("extra")
    extra: dict[str, Any] = dict(raw_extra) if _is_plain_object(raw_extra) else {}
    # Only an entry offering one of OUR schemes has an `extra` we own. A foreign
    # entry's `extra` is carried through whole: nothing lifted, nothing dropped.
    if raw.get("scheme") in VALID_SCHEMES:
        for key in _S402_EXTRA_KEYS:
            if key not in extra:
                continue
            out[key] = _pick_sub_object(key, extra[key]) if key in _SUB_OBJECT_KEYS else extra[key]
            del extra[key]
    if len(extra) > 0:
        out["extra"] = extra
    return out


def apply_foreign_expiry(required: dict[str, Any], now: int | None = None) -> None:
    """Give a foreign x402 offer an ``expiresAt`` derived from ``maxTimeoutSeconds``.

    Runs on every decode path for a 402 that carries no ``extensions.s402`` — a
    document from a server that has never heard of s402. Without it, inbound x402
    traffic bypasses stale-payment rejection entirely, because the expiry guards
    skip an undefined ``expiresAt``. An offer that states its own expiry is never
    overwritten, and s402's own documents are never touched: saying nothing about
    expiry is an answer, and it is ours.
    """
    for offer in required.get("accepts") or []:
        # Only offers we could actually pay. An entry naming a scheme we do not
        # implement is one no s402 payment will ever be built for.
        if offer.get("scheme") not in VALID_SCHEMES:
            continue
        if "expiresAt" in offer:
            continue
        timeout = offer.get("maxTimeoutSeconds")
        if timeout is None:
            timeout = S402_DEFAULT_MAX_TIMEOUT_SECONDS
        if timeout > 0:
            ref = now if now is not None else int(time.time() * 1000)
            offer["expiresAt"] = ref + timeout * 1000


def pick_requirements_fields(obj: dict[str, Any], now: int | None = None) -> dict[str, Any]:
    """Return a clean 402 document — the wire envelope lifted into s402's shape.

    Unknown envelope, entry and resource keys are stripped. Kept under its
    historical name because it is the same trust boundary it always was; what
    changed is the document it guards.
    """
    out: dict[str, Any] = {"x402Version": 2}
    if "error" in obj:
        out["error"] = obj["error"]

    raw_resource = obj.get("resource")
    src = raw_resource if _is_plain_object(raw_resource) else {}
    out["resource"] = {key: src[key] for key in _RESOURCE_KEYS if key in src}

    accepts = obj.get("accepts")
    entries = accepts if isinstance(accepts, list) else []
    out["accepts"] = [
        _from_wire_requirement(entry if _is_plain_object(entry) else {}) for entry in entries
    ]

    raw_extensions = obj.get("extensions")
    extensions: dict[str, Any] = dict(raw_extensions) if _is_plain_object(raw_extensions) else {}
    raw_s402_ext = extensions.get(S402_EXTENSION_KEY)
    s402_ext: dict[str, Any] | None = dict(raw_s402_ext) if _is_plain_object(raw_s402_ext) else None
    if s402_ext is not None:
        del extensions[S402_EXTENSION_KEY]
        if "mandate" in s402_ext:
            out["mandate"] = _pick_sub_object("mandate", s402_ext["mandate"])
        s402_ext.pop("version", None)
        s402_ext.pop("mandate", None)
        if len(s402_ext) > 0:
            extensions[S402_EXTENSION_KEY] = s402_ext
    if len(extensions) > 0:
        out["extensions"] = extensions

    # The mandate travels once, on the envelope, and is read per-requirement —
    # schemes and the facilitator take a single offer and never see the envelope.
    if "mandate" in out:
        for offer in out["accepts"]:
            offer["mandate"] = out["mandate"]
    if s402_ext is None:
        apply_foreign_expiry(out, now)

    return out


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
    """Validate the unlock sub-object (pay-to-decrypt, single-transaction).

    The Seal identity is `receiptId || nonce`, where `receiptId` is the object ID
    of the `UnlockReceipt` minted by `pay_and_mint`. That receipt does not exist
    when the 402 is written, so no identity field belongs here — it travels in the
    fulfillment (see `s402UnlockFulfillment` in the TypeScript types).
    """
    if not isinstance(value, dict):
        raise S402Error("INVALID_PAYLOAD", f"unlock must be a plain object, got {type(value).__name__}")
    _assert_string(value, "packageId", "unlock")
    _assert_optional_string(value, "contentDigest", "unlock")
    threshold = value.get("threshold")
    if not isinstance(threshold, int) or isinstance(threshold, bool) or threshold < 1:
        raise S402Error("INVALID_PAYLOAD", f"unlock.threshold must be a positive integer, got {type(threshold).__name__}")
    key_servers = value.get("keyServers")
    if not isinstance(key_servers, list) or len(key_servers) == 0:
        raise S402Error("INVALID_PAYLOAD", f"unlock.keyServers must be a non-empty array, got {type(key_servers).__name__}")
    for ks in key_servers:
        if not isinstance(ks, dict):
            raise S402Error("INVALID_PAYLOAD", f"unlock.keyServers[] must be a plain object, got {type(ks).__name__}")
        _assert_string(ks, "objectId", "unlock.keyServers[]")
        if not isinstance(ks.get("weight"), int) or isinstance(ks.get("weight"), bool):
            raise S402Error("INVALID_PAYLOAD", f"unlock.keyServers[].weight must be a number, got {type(ks.get('weight')).__name__}")


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
    """Validate the optional sub-objects on one ``accepts[]`` entry's ``extra``.

    ⚠️ ``mandate`` is deliberately NOT in this list. It is envelope-level since
    wire v2 and is validated at ``extensions.s402.mandate``. A ``mandate`` key
    inside an entry's ``extra`` belongs to whoever put it there — s402 does not
    own that address — and validating it would let an unrelated foreign key take
    down an otherwise payable 402.
    """
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


def _validate_extra_fields(extra: dict[str, Any], where: str) -> None:
    """Validate the s402 fields carried inside one ``accepts[]`` entry's ``extra``.

    Every check here was a top-level check before wire v2. It moved one level
    down with the fields it guards; none of it was relaxed.
    """
    if "protocolFeeBps" in extra:
        v = extra["protocolFeeBps"]
        # isinstance(True, int) is True in Python — reject bools explicitly (JS typeof true !== 'number')
        if (
            isinstance(v, bool)
            or not isinstance(v, (int, float))
            or (isinstance(v, float) and (not math.isfinite(v) or v != int(v)))
            or v < 0
            or v > 10000
        ):
            raise S402Error("INVALID_PAYLOAD", f"{where}: protocolFeeBps must be an integer between 0 and 10000, got {v}")

    if "expiresAt" in extra:
        v = extra["expiresAt"]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)) or v <= 0:
            raise S402Error("INVALID_PAYLOAD", f"{where}: expiresAt must be a positive finite number (Unix timestamp ms), got {v}")

    if "protocolFeeAddress" in extra:
        v = extra["protocolFeeAddress"]
        if not isinstance(v, str) or len(v) == 0:
            raise S402Error("INVALID_PAYLOAD", f"{where}: protocolFeeAddress must be a non-empty string, got {json.dumps(v)}")
        if _CONTROL_CHAR_RE.search(v):
            raise S402Error("INVALID_PAYLOAD", f"{where}: protocolFeeAddress contains control characters")

    if "facilitatorUrl" in extra:
        v = extra["facilitatorUrl"]
        if not isinstance(v, str):
            raise S402Error("INVALID_PAYLOAD", f"{where}: facilitatorUrl must be a string, got {type(v).__name__}")
        # Reject control characters (CRLF injection, null bytes) — defense-in-depth
        if _CONTROL_CHAR_RE.search(v):
            raise S402Error("INVALID_PAYLOAD", f"{where}: facilitatorUrl contains control characters (potential header injection)")
        # Validate URL scheme to prevent SSRF via dangerous protocols (file://, gopher://, ...)
        try:
            parsed = urlparse(v)
            if parsed.scheme not in ("https", "http"):
                raise S402Error("INVALID_PAYLOAD", f'{where}: facilitatorUrl must use https:// or http://, got "{parsed.scheme}:"')
            if parsed.username or parsed.password:
                raise S402Error("INVALID_PAYLOAD", f"{where}: facilitatorUrl must not contain embedded credentials (user:password@)")
        except S402Error:
            raise
        except Exception:
            raise S402Error("INVALID_PAYLOAD", f"{where}: facilitatorUrl is not a valid URL")

    if "settlementMode" in extra:
        if extra["settlementMode"] not in ("facilitator", "direct"):
            raise S402Error("INVALID_PAYLOAD", f'{where}: settlementMode must be "facilitator" or "direct", got {json.dumps(extra["settlementMode"])}')

    if "receiptRequired" in extra:
        if not isinstance(extra["receiptRequired"], bool):
            raise S402Error("INVALID_PAYLOAD", f"{where}: receiptRequired must be a boolean, got {type(extra['receiptRequired']).__name__}")

    if "extensions" in extra and not _is_plain_object(extra["extensions"]):
        raise S402Error("INVALID_PAYLOAD", f"{where}: extra.extensions must be a plain object")

    _validate_sub_objects(extra)


def _validate_requirement_entry(entry: Any, index: int) -> None:
    """Validate one ``accepts[]`` entry as it arrived on the wire."""
    where = f"accepts[{index}]"
    if not _is_plain_object(entry):
        raise S402Error("INVALID_PAYLOAD", f"{where} is not an object")

    missing: list[str] = []
    # Postel: the scheme name is NOT checked against s402's six. An x402 server
    # may offer `auth-capture`; a scheme we cannot pay is one we SKIP, and a
    # decoder that refuses the whole 402 over it turns a menu into a rejection.
    if not isinstance(entry.get("scheme"), str) or len(entry["scheme"]) == 0:
        missing.append("scheme (non-empty string)")
    if not isinstance(entry.get("network"), str):
        missing.append("network (string)")
    if not isinstance(entry.get("asset"), str):
        missing.append("asset (string)")
    if not isinstance(entry.get("amount"), str):
        missing.append("amount (string)")
    elif not is_valid_amount(entry["amount"]):
        raise S402Error("INVALID_PAYLOAD", f'{where}: invalid amount "{entry["amount"]}": must be a non-negative integer string')
    if not isinstance(entry.get("payTo"), str):
        missing.append("payTo (string)")
    elif len(entry["payTo"]) == 0:
        raise S402Error("INVALID_PAYLOAD", f"{where}: payTo must be a non-empty string")

    if missing:
        raise S402Error("INVALID_PAYLOAD", f"Malformed payment requirements: {where} missing {', '.join(missing)}")

    # Reject control characters in protocol-semantic identifier fields. These
    # feed into dict keys, error messages, and downstream logs — null bytes and
    # CRLF are never legitimate in scheme/network/asset/address identifiers.
    for field in ("scheme", "network", "asset", "payTo"):
        if _CONTROL_CHAR_RE.search(entry[field]):
            raise S402Error("INVALID_PAYLOAD", f"{where}: {field} contains control characters")

    if "maxTimeoutSeconds" in entry:
        v = entry["maxTimeoutSeconds"]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)) or v < 0:
            raise S402Error("INVALID_PAYLOAD", f"{where}: maxTimeoutSeconds must be a non-negative finite number, got {json.dumps(v)}")

    if "extra" in entry:
        if not _is_plain_object(entry["extra"]):
            raise S402Error("INVALID_PAYLOAD", f"{where}: extra must be a plain object")
        # s402's validators run only where s402 owns the keys. x402 ships schemes
        # we do not implement (`auth-capture`, `batch-settlement`); if one of them
        # puts an `escrow` or `expiresAt` key in its own `extra`, in its own
        # shape, that is not an error — rejecting the whole document over it would
        # make an entire menu unreadable because of one dish we were never going
        # to order. The offers we CAN pay are still validated to the letter.
        if entry["scheme"] in VALID_SCHEMES:
            _validate_extra_fields(entry["extra"], where)


def validate_requirements_shape(obj: Any) -> None:
    """Validate a decoded 402 document. Raises S402Error on invalid shape.

    Takes the WIRE envelope — ``{ x402Version: 2, resource, accepts: [...] }`` —
    not the lifted s402 view. Everything s402 adds is validated where it actually
    travels: inside each entry's ``extra``, and inside ``extensions.s402``.
    """
    if obj is None or not isinstance(obj, dict):
        raise S402Error("INVALID_PAYLOAD", "Payment requirements is not an object")

    # Version gate. The flat s402 v1 shape (`s402Version` + `accepts: [str]`) is
    # no longer emitted by anything and is not decoded here — reading it is an
    # intake obligation (ADR-013) discharged in compat, not a wire format.
    if "x402Version" not in obj:
        if "s402Version" in obj:
            raise S402Error(
                "INVALID_PAYLOAD",
                "This is the s402 v1 flat requirements shape, retired in wire v2. "
                "Use from_s402_v1_requirements() or normalize_requirements() from s402.compat.",
            )
        raise S402Error("INVALID_PAYLOAD", "Missing x402Version. An s402 402 is an x402 V2 PaymentRequired envelope.")
    if obj["x402Version"] != 2:
        raise S402Error(
            "INVALID_PAYLOAD",
            f"Unsupported x402Version {json.dumps(obj['x402Version'])}. "
            "The s402 wire is x402 V2; use normalize_requirements() from s402.compat for V1.",
        )

    # `resource` is mandatory on an x402 V2 envelope. Emission requires a
    # non-empty url; decode only requires the field to be there and to be a
    # string, so a peer with an empty url is still readable.
    if not _is_plain_object(obj.get("resource")):
        raise S402Error("INVALID_PAYLOAD", "Malformed payment requirements: missing resource (object with a url)")
    if not isinstance(obj["resource"].get("url"), str):
        raise S402Error("INVALID_PAYLOAD", "Malformed payment requirements: resource.url must be a string")

    if not isinstance(obj.get("accepts"), list):
        raise S402Error("INVALID_PAYLOAD", "Malformed payment requirements: missing accepts (array of requirement objects)")
    # Empty accepts is semantically invalid — the client cannot match any offer.
    if len(obj["accepts"]) == 0:
        raise S402Error("INVALID_PAYLOAD", "accepts array must contain at least one requirement")
    for index, entry in enumerate(obj["accepts"]):
        _validate_requirement_entry(entry, index)

    if "error" in obj and not isinstance(obj["error"], str):
        raise S402Error("INVALID_PAYLOAD", f"error must be a string, got {type(obj['error']).__name__}")

    if "extensions" in obj:
        if not _is_plain_object(obj["extensions"]):
            raise S402Error("INVALID_PAYLOAD", "extensions must be a plain object")
        if S402_EXTENSION_KEY in obj["extensions"]:
            s402_ext = obj["extensions"][S402_EXTENSION_KEY]
            if not _is_plain_object(s402_ext):
                raise S402Error("INVALID_PAYLOAD", "extensions.s402 must be a plain object")
            # ADR-006 version negotiation: the number is here, and a version this
            # build does not implement is refused rather than half-read.
            if "version" in s402_ext and s402_ext["version"] != S402_WIRE_VERSION:
                raise S402Error(
                    "INVALID_PAYLOAD",
                    f"Unsupported s402 wire version {json.dumps(s402_ext['version'])}. "
                    f'This library supports version "{S402_WIRE_VERSION}".',
                )
            if "mandate" in s402_ext:
                validate_mandate_shape(s402_ext["mandate"])


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
    """Encode a 402 document for the ``payment-required`` header.

    Emits the x402 V2 ``PaymentRequired`` envelope. s402's per-requirement fields
    are projected into each entry's ``extra``; ``mandate`` and the wire version
    are projected into ``extensions.s402``.
    """
    return _to_base64(json.dumps(to_requirements_wire(requirements), separators=(",", ":")))


def encode_payment_payload(payload: dict[str, Any]) -> str:
    """Encode payment payload for the x-payment header."""
    return _to_base64(json.dumps(payload, separators=(",", ":")))


def encode_settle_response(response: dict[str, Any]) -> str:
    """Encode settlement response for the payment-response header."""
    return _to_base64(json.dumps(response, separators=(",", ":")))


# ══════════════════════════════════════════════════════════════
# Decode (base64 string from HTTP header → object)
# ══════════════════════════════════════════════════════════════


def decode_payment_required(header: str, now: int | None = None) -> dict[str, Any]:
    """Decode and validate the 402 document from the ``payment-required`` header.

    Works on a PLAIN x402 V2 402 as well as an s402-profile one: the only
    difference between them is the presence of ``extensions.s402``, and its
    absence is not an error. What comes back is payable either way.

    Args:
        header: Base64-encoded JSON string from the HTTP header.
        now: Clock (epoch ms) for the foreign-expiry derivation applied to a 402
            that carries no ``extensions.s402``. Defaults to the system clock.
    """
    if not isinstance(header, str):
        raise S402Error("INVALID_PAYLOAD", f"payment-required header must be a string, got {type(header).__name__}")
    if len(header) > MAX_HEADER_BYTES:
        raise S402Error("INVALID_PAYLOAD", f"payment-required header exceeds maximum size ({len(header)} > {MAX_HEADER_BYTES})")
    try:
        parsed = json.loads(_from_base64(header))
    except Exception as e:
        raise S402Error("INVALID_PAYLOAD", f"Failed to decode payment-required header: {e}")
    validate_requirements_shape(parsed)
    return pick_requirements_fields(parsed, now)


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
    """Serialize a 402 document for a JSON body — the same envelope the header carries."""
    return json.dumps(to_requirements_wire(requirements), separators=(",", ":"))


def decode_requirements_body(body: str, now: int | None = None) -> dict[str, Any]:
    if not isinstance(body, str):
        raise S402Error("INVALID_PAYLOAD", f"s402 requirements body must be a string, got {type(body).__name__}")
    try:
        parsed = json.loads(body)
    except Exception as e:
        raise S402Error("INVALID_PAYLOAD", f"Failed to parse s402 requirements body: {e}")
    validate_requirements_shape(parsed)
    return pick_requirements_fields(parsed, now)


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
    """Detect 's402', 'x402', or 'unknown' from response headers.

    Since wire v2 the two share one envelope, so what separates them is the
    presence of ``extensions.s402`` — not a version field (ADR-016 rule 4).
    """
    payment_required = headers.get(S402_HEADERS["PAYMENT_REQUIRED"])
    if not payment_required:
        return "unknown"
    if len(payment_required) > MAX_HEADER_BYTES:
        return "unknown"
    try:
        decoded = json.loads(_from_base64(payment_required))
        if _is_plain_object(decoded):
            extensions = decoded.get("extensions")
            if _is_plain_object(extensions) and _is_plain_object(extensions.get(S402_EXTENSION_KEY)):
                return "s402"
            if "x402Version" in decoded:
                return "x402"
    except Exception:
        pass
    return "unknown"
