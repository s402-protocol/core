# s402-python — Agent Manual

## What is this?

Python implementation of the s402 wire format specification. Encode/decode/validate HTTP 402 payment headers. Zero runtime dependencies. Passes all 132 conformance test vectors from the TypeScript reference.

## Architecture

```
src/s402/
  __init__.py       — Public API (barrel export + __version__)
  errors.py         — S402Error class + 15 error codes with retryable flags
  http.py           — Encode/decode, validation, key stripping (the big file)
  compat.py         — x402 V1/V2 → s402 normalization
  receipts.py       — X-S402-Receipt header format/parse
  py.typed          — PEP 561 marker for typed package
```

## Key rules

- **Zero runtime deps.** This package must never add runtime dependencies.
- **Wire-compatible with TypeScript.** Same base64 encoding, same JSON key order, same validation rules. The 132 conformance vectors enforce this.
- **Chain-agnostic.** No chain-specific imports, validation, or constants.
- **camelCase in JSON.** The wire format uses camelCase (`payTo`, `s402Version`). Python functions use snake_case. JSON field names are NOT converted — they match the wire format exactly.

## Commands

```bash
pytest              # Run 132 conformance tests
pytest -v           # Verbose output
mypy src/           # Type check (requires mypy installed)
```

## Conformance

Test vectors live in `tests/vectors/` — copied from the TypeScript reference at `test/conformance/vectors/`. When the TS vectors are updated, copy them here and re-run:

```bash
cp ../s402/test/conformance/vectors/* tests/vectors/
pytest
```

## Design decisions

### Why dicts, not dataclasses?

The wire format is JSON. Python's `json.loads` returns dicts. Converting to dataclasses and back adds overhead and complexity for zero benefit — the conformance vectors test against raw dicts, and downstream consumers (httpx, FastAPI) work with dicts.

### Why not TypedDict?

TypedDicts would improve IDE autocomplete for return types, but they don't validate at runtime. The validation happens in `validate_requirements_shape()` etc. — the dict is validated before it's returned. TypedDict would add type-level documentation but no safety.

Future versions may add TypedDict aliases for documentation purposes.

### Why `separators=(",", ":")`?

`json.dumps` defaults to `", "` and `": "` (with spaces). The TypeScript reference uses `JSON.stringify` which produces compact JSON with no spaces. Using `separators=(",", ":")` matches the TS output byte-for-byte, which is required for conformance vector compatibility.
