"""s402 Conformance Test Runner — verifies Python implementation against conformance test vectors.

These vectors are the SAME ones used by the TypeScript reference implementation.
Passing all of them proves the Python implementation is wire-compatible.
"""

import json
import base64
from pathlib import Path

import pytest

from s402 import (
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
    S402Error,
)
from s402.compat import normalize_requirements
from s402.receipts import format_receipt_header, parse_receipt_header

VECTORS_DIR = Path(__file__).parent.parent.parent / "spec" / "vectors"


def load_vectors(filename: str) -> list[dict]:
    with open(VECTORS_DIR / filename) as f:
        return json.load(f)


# ══════════════════════════════════════════════════════════════
# Requirements encode
# ══════════════════════════════════════════════════════════════


class TestRequirementsEncode:
    vectors = load_vectors("requirements-encode.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_encode(self, vector: dict) -> None:
        result = encode_payment_required(vector["input"])
        assert result == vector["expected"]["header"]


# ══════════════════════════════════════════════════════════════
# Requirements decode
# ══════════════════════════════════════════════════════════════


class TestRequirementsDecode:
    vectors = load_vectors("requirements-decode.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_decode(self, vector: dict) -> None:
        # `now` is present only on vectors decoding a document with no
        # extensions.s402, where expiresAt is derived from maxTimeoutSeconds.
        # Runners must pass it, or the expectation is not reproducible.
        result = decode_payment_required(
            vector["input"]["header"], vector["input"].get("now")
        )
        assert result == vector["expected"]


# ══════════════════════════════════════════════════════════════
# Payload encode
# ══════════════════════════════════════════════════════════════


class TestPayloadEncode:
    vectors = load_vectors("payload-encode.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_encode(self, vector: dict) -> None:
        result = encode_payment_payload(vector["input"])
        assert result == vector["expected"]["header"]


# ══════════════════════════════════════════════════════════════
# Payload decode
# ══════════════════════════════════════════════════════════════


class TestPayloadDecode:
    vectors = load_vectors("payload-decode.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_decode(self, vector: dict) -> None:
        result = decode_payment_payload(vector["input"]["header"])
        assert result == vector["expected"]


# ══════════════════════════════════════════════════════════════
# Settle encode
# ══════════════════════════════════════════════════════════════


class TestSettleEncode:
    vectors = load_vectors("settle-encode.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_encode(self, vector: dict) -> None:
        result = encode_settle_response(vector["input"])
        assert result == vector["expected"]["header"]


# ══════════════════════════════════════════════════════════════
# Settle decode
# ══════════════════════════════════════════════════════════════


class TestSettleDecode:
    vectors = load_vectors("settle-decode.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_decode(self, vector: dict) -> None:
        result = decode_settle_response(vector["input"]["header"])
        assert result == vector["expected"]


# ══════════════════════════════════════════════════════════════
# Body transport
# ══════════════════════════════════════════════════════════════


class TestBodyTransport:
    vectors = load_vectors("body-transport.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_body(self, vector: dict) -> None:
        msg_type = vector["input"]["type"]
        value = vector["input"]["value"]

        # Test encode
        if msg_type == "requirements":
            encoded = encode_requirements_body(value)
            decoded = decode_requirements_body(encoded)
        elif msg_type == "payload":
            encoded = encode_payload_body(value)
            decoded = decode_payload_body(encoded)
        elif msg_type == "settle":
            encoded = encode_settle_body(value)
            decoded = decode_settle_body(encoded)
        else:
            pytest.fail(f"Unknown body transport type: {msg_type}")

        assert encoded == vector["expected"]["body"]
        assert decoded == vector["expected"]["decoded"]


# ══════════════════════════════════════════════════════════════
# Compat normalization
# ══════════════════════════════════════════════════════════════


class TestCompatNormalize:
    vectors = load_vectors("compat-normalize.json")
    # Fixed reference timestamp for deterministic maxTimeoutSeconds → expiresAt conversion
    COMPAT_REFERENCE_NOW = 1700000000000  # 2023-11-14T22:13:20Z

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_normalize(self, vector: dict) -> None:
        if vector.get("shouldReject"):
            with pytest.raises(S402Error):
                normalize_requirements(vector["input"], now=self.COMPAT_REFERENCE_NOW)
        else:
            result = normalize_requirements(vector["input"], now=self.COMPAT_REFERENCE_NOW)
            assert result == vector["expected"]


# ══════════════════════════════════════════════════════════════
# Receipt format
# ══════════════════════════════════════════════════════════════


class TestReceiptFormat:
    vectors = load_vectors("receipt-format.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_format(self, vector: dict) -> None:
        inp = vector["input"]
        result = format_receipt_header(
            signature=bytes(inp["signature"]),
            call_number=int(inp["callNumber"]),
            timestamp_ms=int(inp["timestampMs"]),
            response_hash=bytes(inp["responseHash"]),
        )
        assert result == vector["expected"]["header"]


# ══════════════════════════════════════════════════════════════
# Receipt parse
# ══════════════════════════════════════════════════════════════


class TestReceiptParse:
    vectors = load_vectors("receipt-parse.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_parse(self, vector: dict) -> None:
        result = parse_receipt_header(vector["input"]["header"])
        expected = vector["expected"]
        assert result["version"] == expected["version"]
        assert result["call_number"] == int(expected["callNumber"])
        assert result["timestamp_ms"] == int(expected["timestampMs"])
        assert list(result["signature"]) == expected["signature"]
        assert list(result["response_hash"]) == expected["responseHash"]


# ══════════════════════════════════════════════════════════════
# Validation reject
# ══════════════════════════════════════════════════════════════


class TestValidationReject:
    vectors = load_vectors("validation-reject.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_reject(self, vector: dict) -> None:
        inp = vector["input"]
        expected_code = vector["expectedErrorCode"]

        # Dispatch based on vector type (matches TS conformance runner)
        decode_as = inp.get("decodeAs")

        # Receipt vectors use RECEIPT_PARSE_ERROR as a convention — receipts
        # are a separate subsystem. We verify they raise S402Error.
        is_receipt = expected_code == "RECEIPT_PARSE_ERROR"

        with pytest.raises(S402Error) as exc_info:
            if decode_as == "payload":
                decode_payment_payload(inp["header"])
            elif decode_as == "compat":
                normalize_requirements(inp.get("json", inp))
            elif is_receipt:
                parse_receipt_header(inp.get("header", ""))
            else:
                decode_payment_required(inp["header"])

        if not is_receipt:
            assert exc_info.value.code == expected_code


# ══════════════════════════════════════════════════════════════
# Roundtrip
# ══════════════════════════════════════════════════════════════


class TestRoundtrip:
    vectors = load_vectors("roundtrip.json")

    @pytest.mark.parametrize("vector", vectors, ids=[v["description"] for v in vectors])
    def test_roundtrip(self, vector: dict) -> None:
        msg_type = vector["input"]["type"]
        transport = vector["input"]["transport"]
        value = vector["input"]["value"]
        expected = vector["expected"]

        if msg_type == "requirements":
            if transport == "header":
                encoded = encode_payment_required(value)
                decoded = decode_payment_required(encoded)
                re_encoded = encode_payment_required(decoded)
            else:
                encoded = encode_requirements_body(value)
                decoded = decode_requirements_body(encoded)
                re_encoded = encode_requirements_body(decoded)
        elif msg_type == "payload":
            if transport == "header":
                encoded = encode_payment_payload(value)
                decoded = decode_payment_payload(encoded)
                re_encoded = encode_payment_payload(decoded)
            else:
                encoded = encode_payload_body(value)
                decoded = decode_payload_body(encoded)
                re_encoded = encode_payload_body(decoded)
        elif msg_type == "settle":
            if transport == "header":
                encoded = encode_settle_response(value)
                decoded = decode_settle_response(encoded)
                re_encoded = encode_settle_response(decoded)
            else:
                encoded = encode_settle_body(value)
                decoded = decode_settle_body(encoded)
                re_encoded = encode_settle_body(decoded)
        else:
            pytest.fail(f"Unknown roundtrip type: {msg_type}")

        assert encoded == expected["firstEncode"]
        assert re_encoded == expected["reEncode"]
        assert expected["identical"] is True
        assert encoded == re_encoded


# ── ADR-016 rework, item 8: the retired v1 flat 402 is still ours ──────────
#
# Mirrors `test/adr016-findings.test.ts` in the TypeScript implementation. A
# client that returns "unknown" for a v1 402 cannot tell a server mid-upgrade
# from a route that wants no payment, so it neither pays nor errors.

def _v1_header() -> str:
    return base64.b64encode(json.dumps({
        "s402Version": "1",
        "accepts": ["exact"],
        "network": "sui:mainnet",
        "asset": "0x2::sui::SUI",
        "amount": "1000",
        "payTo": "0xabc",
    }).encode()).decode()


def test_detect_protocol_calls_a_v1_flat_402_s402():
    from s402.http import detect_protocol
    assert detect_protocol({"payment-required": _v1_header()}) == "s402"


def test_detect_protocol_still_says_unknown_without_a_header():
    from s402.http import detect_protocol
    assert detect_protocol({}) == "unknown"
    assert detect_protocol({"payment-required": "not base64 at all"}) == "unknown"


def test_detect_protocol_calls_a_plain_x402_envelope_x402():
    from s402.http import detect_protocol
    header = base64.b64encode(json.dumps({
        "x402Version": 2,
        "resource": {"url": "https://api.example.com/paid"},
        "accepts": [{"scheme": "exact", "network": "sui:mainnet", "asset": "SUI",
                     "amount": "1000", "payTo": "0xabc", "maxTimeoutSeconds": 60, "extra": {}}],
    }).encode()).decode()
    assert detect_protocol({"payment-required": header}) == "x402"
