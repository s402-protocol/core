"""s402 — Chain-agnostic HTTP 402 wire format for AI agent payments.

Six payment schemes: exact, upto, prepaid, stream, escrow, unlock.
The 402 IS an x402 V2 `PaymentRequired` envelope (wire v2, ADR-016).
Zero dependencies.
"""

__version__ = "0.2.0"

from .errors import S402Error, S402ErrorCode
from .http import (
    S402_VERSION,
    S402_WIRE_VERSION,
    S402_DEFAULT_MAX_TIMEOUT_SECONDS,
    S402_EXTENSION_KEY,
    S402_HEADERS,
    S402_CONTENT_TYPE,
    is_valid_amount,
    encode_payment_required,
    decode_payment_required,
    encode_payment_payload,
    decode_payment_payload,
    encode_settle_response,
    decode_settle_response,
    encode_requirements_body,
    decode_requirements_body,
    encode_payload_body,
    decode_payload_body,
    encode_settle_body,
    decode_settle_body,
    detect_protocol,
    validate_requirements_shape,
    to_requirements_wire,
    apply_foreign_expiry,
    resolve_mandate,
    pick_requirements_fields,
    pick_payload_fields,
    pick_settle_response_fields,
)
from .compat import (
    normalize_requirements,
    from_x402_requirements,
    from_x402_envelope,
    from_s402_v1_requirements,
    x402_payment_flow_of,
    is_s402,
    is_x402,
    is_x402_envelope,
)
from .receipts import (
    S402_RECEIPT_HEADER,
    format_receipt_header,
    parse_receipt_header,
)

__all__ = [
    # Errors
    "S402Error",
    "S402ErrorCode",
    # Constants
    "S402_VERSION",
    "S402_WIRE_VERSION",
    "S402_DEFAULT_MAX_TIMEOUT_SECONDS",
    "S402_EXTENSION_KEY",
    "S402_HEADERS",
    "S402_CONTENT_TYPE",
    "S402_RECEIPT_HEADER",
    # Validation
    "is_valid_amount",
    "validate_requirements_shape",
    "to_requirements_wire",
    "apply_foreign_expiry",
    "resolve_mandate",
    # Header transport
    "encode_payment_required",
    "decode_payment_required",
    "encode_payment_payload",
    "decode_payment_payload",
    "encode_settle_response",
    "decode_settle_response",
    # Body transport
    "encode_requirements_body",
    "decode_requirements_body",
    "encode_payload_body",
    "decode_payload_body",
    "encode_settle_body",
    "decode_settle_body",
    # Detection
    "detect_protocol",
    # Key stripping
    "pick_requirements_fields",
    "pick_payload_fields",
    "pick_settle_response_fields",
    # Compat
    "normalize_requirements",
    "from_x402_requirements",
    "from_x402_envelope",
    "from_s402_v1_requirements",
    "x402_payment_flow_of",
    "is_s402",
    "is_x402",
    "is_x402_envelope",
    # Receipts
    "format_receipt_header",
    "parse_receipt_header",
]
