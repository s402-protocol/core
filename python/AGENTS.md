# s402-python — Agent Manual

## What is this?

Python implementation of the s402 wire format specification. Encode/decode/validate HTTP 402 payment headers. Zero runtime dependencies. Passes the conformance test vectors from the TypeScript reference.

**The 402 IS an x402 V2 `PaymentRequired` envelope** — `{ x402Version: 2, resource, accepts: PaymentRequirements[], extensions }` (wire v2, ADR-016). One `accepts[]` entry per offered scheme, `exact` first. s402's per-requirement fields ride in that entry's `extra`; envelope-level fields ride in `extensions.s402`. Nothing emits the retired v1 flat shape (`s402Version` + `accepts: ["exact"]`); reading it is an intake obligation discharged in `compat.py`.

## Architecture

```
src/s402/
  __init__.py       — Public API (barrel export + __version__)
  errors.py         — S402Error class + 15 error codes with retryable flags
  http.py           — Encode/decode, wire projection, validation, key stripping (the big file)
  compat.py         — intake of the two retired flat shapes (x402 V1, s402 v1)
  receipts.py       — X-S402-Receipt header format/parse
  py.typed          — PEP 561 marker for typed package
```

## Key rules

- **Zero runtime deps.** This package must never add runtime dependencies.
- **Wire-compatible with TypeScript.** Same base64 encoding, same JSON key order, same validation rules. The conformance vectors in `../spec/vectors/` enforce this, and `typescript/src/http.ts` is the reference — when the two disagree, TypeScript is right and this is the bug.
- **Key order in `_S402_EXTRA_KEYS` is load-bearing.** The encoder writes an entry's passthrough `extra` keys first and the named s402 keys after, in that order, so decode → re-encode is byte-identical. Reordering that list breaks the roundtrip vectors.
- **An `extra` we do not own is carried through whole.** x402 ships schemes we do not implement; unknown keys inside an entry's `extra` are kept, not stripped, and s402's validators run only on entries whose scheme is one of ours. A menu is not made unreadable by one dish we were never going to order.
- **Chain-agnostic.** No chain-specific imports, validation, or constants.
- **camelCase in JSON.** The wire format uses camelCase (`payTo`, `s402Version`). Python functions use snake_case. JSON field names are NOT converted — they match the wire format exactly.

## Commands

```bash
pytest              # Run the conformance suite
pytest -v           # Verbose output (what CI runs)
mypy src/           # Type check (requires mypy installed)
```

## Conformance

Test vectors are read straight out of the monorepo at `../spec/vectors/` — there is no copy to keep in sync. They are generated FROM the TypeScript implementation, so a vector that looks wrong is a TypeScript ticket, never a reason to edit the JSON.

A vector carrying `input.now` must have it passed through to the decoder: those decode a document with no `extensions.s402`, where `expiresAt` is derived from `maxTimeoutSeconds`, and without the clock the expectation is not reproducible.

## Design decisions

### Why dicts, not dataclasses?

The wire format is JSON. Python's `json.loads` returns dicts. Converting to dataclasses and back adds overhead and complexity for zero benefit — the conformance vectors test against raw dicts, and downstream consumers (httpx, FastAPI) work with dicts.

### Why not TypedDict?

TypedDicts would improve IDE autocomplete for return types, but they don't validate at runtime. The validation happens in `validate_requirements_shape()` etc. — the dict is validated before it's returned. TypedDict would add type-level documentation but no safety.

Future versions may add TypedDict aliases for documentation purposes.

### Why `separators=(",", ":")`?

`json.dumps` defaults to `", "` and `": "` (with spaces). The TypeScript reference uses `JSON.stringify` which produces compact JSON with no spaces. Using `separators=(",", ":")` matches the TS output byte-for-byte, which is required for conformance vector compatibility.
