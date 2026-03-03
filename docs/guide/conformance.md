---
description: 133 machine-readable JSON test vectors for verifying s402 implementations in any language. Ship in the npm package — no TypeScript required.
---

# Conformance Test Vectors

s402 ships 133 machine-readable JSON test vectors that define correct protocol behavior. Use them to verify any s402 implementation — Go, Python, Rust, Java, or anything else — without reading a single line of TypeScript.

## Why This Matters

Most protocols define behavior in prose. Prose is ambiguous. s402 defines behavior in **executable JSON vectors** that any language can load and run. If your implementation passes all 133 vectors, it's s402-compliant.

The vectors cover:
- **Encode/decode** — requirements, payloads, settle responses (header + body transport)
- **Key stripping** — unknown fields MUST be stripped at decode (defense-in-depth)
- **Validation rejection** — 39 malformed inputs that MUST be rejected
- **Roundtrip identity** — encode → decode → re-encode = identical output
- **x402 compat** — normalizing x402 V1/V2 input to s402 format
- **Receipt format/parse** — the `X-S402-Receipt` wire format

## Getting the Vectors

### From npm (recommended)

```bash
npm pack s402
tar xzf s402-*.tgz
ls package/test/conformance/vectors/
```

The vectors ship in every `npm install s402` — no separate download needed.

### From source

```bash
git clone https://github.com/s402-protocol/core.git
ls core/test/conformance/vectors/
```

## Vector Format

Each JSON file is an array of test cases:

```json
[
  {
    "description": "Human-readable test name",
    "input": { ... },
    "expected": { ... },
    "shouldReject": false
  }
]
```

**Accept vectors** (`shouldReject: false`): Your implementation MUST produce `expected` when given `input`.

**Reject vectors** (`shouldReject: true`): Your implementation MUST reject the input. The `expectedErrorCode` field tells you which error to expect.

## Vector Files

| File | Count | What it tests |
|------|-------|---------------|
| `requirements-encode.json` | 17 | Object → base64 header |
| `requirements-decode.json` | 19 | Base64 header → object (including key stripping) |
| `payload-encode.json` | 8 | Payment payload → base64 header |
| `payload-decode.json` | 7 | Base64 header → payment payload |
| `settle-encode.json` | 5 | Settle response → base64 header |
| `settle-decode.json` | 6 | Base64 header → settle response |
| `body-transport.json` | 5 | JSON body transport (no base64) |
| `compat-normalize.json` | 10 | x402 V1/V2 → s402 normalization |
| `receipt-format.json` | 6 | Receipt fields → header string |
| `receipt-parse.json` | 4 | Header string → receipt fields |
| `validation-reject.json` | 39 | Malformed inputs that must fail |
| `roundtrip.json` | 7 | encode → decode → re-encode identity |

## Quick Start (Go example)

```go
package s402test

import (
    "encoding/json"
    "os"
    "testing"
)

type Vector struct {
    Description     string         `json:"description"`
    Input           map[string]any `json:"input"`
    Expected        map[string]any `json:"expected"`
    ShouldReject    bool           `json:"shouldReject"`
    ExpectedErrCode string         `json:"expectedErrorCode"`
}

func TestRequirementsEncode(t *testing.T) {
    data, _ := os.ReadFile("vectors/requirements-encode.json")
    var vectors []Vector
    json.Unmarshal(data, &vectors)

    for _, v := range vectors {
        t.Run(v.Description, func(t *testing.T) {
            result := EncodePaymentRequired(v.Input) // your implementation
            if result != v.Expected["header"] {
                t.Errorf("got %s, want %s", result, v.Expected["header"])
            }
        })
    }
}
```

## Quick Start (Python example)

```python
import json, pytest

def load_vectors(name):
    with open(f"vectors/{name}.json") as f:
        return json.load(f)

@pytest.mark.parametrize("v", load_vectors("requirements-encode"))
def test_requirements_encode(v):
    if v["shouldReject"]:
        with pytest.raises(S402Error):
            encode_payment_required(v["input"])
    else:
        result = encode_payment_required(v["input"])
        assert result == v["expected"]["header"]
```

## Key Implementation Notes

### Encoding scheme

s402 uses **Unicode-safe base64**:

1. `JSON.stringify(obj)` — serialize to JSON string
2. UTF-8 encode the string
3. Base64 encode the bytes

For ASCII-only content (the common case), this matches plain `btoa(json)`.

### Key stripping on decode

All decode functions MUST strip unknown keys. Only known fields survive. This is a security measure — untrusted HTTP input cannot inject arbitrary fields into your application.

The full list of known keys per decode path is documented in [`test/conformance/README.md`](https://github.com/s402-protocol/core/blob/main/test/conformance/README.md).

### JSON key ordering

Vectors use JavaScript's `JSON.stringify` key ordering (insertion order). Your serializer must produce keys in the same order to get identical base64 output. See the [conformance README](https://github.com/s402-protocol/core/blob/main/test/conformance/README.md#json-key-ordering) for language-specific guidance.

## Regenerating Vectors

If you modify s402's encoding logic:

```bash
npx tsx test/conformance/generate-vectors.ts
pnpm test  # verify conformance tests still pass
```

Vectors are generated from source — never hand-written. The generator runs the actual encode/decode functions and captures their output.
