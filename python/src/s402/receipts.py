"""s402 Receipt HTTP Helpers — chain-agnostic receipt header format/parse.

Format: v2:base64(signature):callNumber:timestampMs:base64(responseHash)
"""

from __future__ import annotations

import base64

from .errors import S402Error

S402_RECEIPT_HEADER = "X-S402-Receipt"
_HEADER_VERSION = "v2"


def _uint8_to_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _base64_to_bytes(b64: str) -> bytes:
    try:
        return base64.b64decode(b64)
    except Exception:
        preview = b64[:20] + ("..." if len(b64) > 20 else "")
        raise S402Error("INVALID_PAYLOAD", f'Invalid base64: "{preview}"')


def format_receipt_header(
    *,
    signature: bytes,
    call_number: int,
    timestamp_ms: int,
    response_hash: bytes,
) -> str:
    """Encode receipt fields into the X-S402-Receipt header value."""
    return ":".join([
        _HEADER_VERSION,
        _uint8_to_base64(signature),
        str(call_number),
        str(timestamp_ms),
        _uint8_to_base64(response_hash),
    ])


def parse_receipt_header(header: str) -> dict:
    """Decode an X-S402-Receipt header value back into typed fields.

    Returns dict with keys: version, signature (bytes), call_number (int),
    timestamp_ms (int), response_hash (bytes).
    """
    if not header:
        raise S402Error("INVALID_PAYLOAD", "Empty receipt header")

    parts = header.split(":")
    if len(parts) != 5:
        raise S402Error("INVALID_PAYLOAD", f"Malformed receipt header: expected 5 colon-separated parts, got {len(parts)}")

    version, sig_b64, call_number_str, timestamp_ms_str, hash_b64 = parts

    if version != _HEADER_VERSION:
        raise S402Error("INVALID_PAYLOAD", f'Unknown receipt header version: "{version}" (expected "{_HEADER_VERSION}")')

    try:
        call_number = int(call_number_str)
    except (ValueError, TypeError):
        raise S402Error("INVALID_PAYLOAD", f'Invalid receipt callNumber: not a valid integer "{call_number_str}"')

    try:
        timestamp_ms = int(timestamp_ms_str)
    except (ValueError, TypeError):
        raise S402Error("INVALID_PAYLOAD", f'Invalid receipt timestampMs: not a valid integer "{timestamp_ms_str}"')

    if call_number <= 0:
        raise S402Error("INVALID_PAYLOAD", f"Invalid receipt callNumber: must be positive, got {call_number}")
    if timestamp_ms <= 0:
        raise S402Error("INVALID_PAYLOAD", f"Invalid receipt timestampMs: must be positive, got {timestamp_ms}")

    signature = _base64_to_bytes(sig_b64)
    if len(signature) != 64:
        raise S402Error("INVALID_PAYLOAD", f"Receipt signature must be 64 bytes (Ed25519), got {len(signature)}")

    response_hash = _base64_to_bytes(hash_b64)
    if len(response_hash) != 32:
        raise S402Error("INVALID_PAYLOAD", f"Receipt responseHash must be 32 bytes (SHA-256), got {len(response_hash)}")

    return {
        "version": "v2",
        "signature": signature,
        "call_number": call_number,
        "timestamp_ms": timestamp_ms,
        "response_hash": response_hash,
    }
