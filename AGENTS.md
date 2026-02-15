# s402 — Agent Manual

## What is this?

`s402` is the Sui-native HTTP 402 payment protocol. It defines chain-agnostic types, HTTP encoding/decoding, x402 compatibility, and error handling. **Zero runtime dependencies.**

## Architecture

```
src/
  index.ts        — Barrel export (public API)
  types.ts        — All protocol types, interfaces, constants
  scheme.ts       — Client/Server/Facilitator scheme interfaces
  client.ts       — s402Client class (scheme registry + payment builder)
  server.ts       — s402ResourceServer class (requirements builder)
  facilitator.ts  — s402Facilitator class (verify + settle dispatch)
  http.ts         — Base64 encode/decode for HTTP headers
  compat.ts       — Bidirectional x402 conversion
  errors.ts       — Typed error codes with recovery hints
```

## Key rules

- **Zero runtime deps.** This package must never add runtime dependencies. Chain-specific code belongs in `@sweepay/sui`.
- **ESM only.** No CommonJS.
- **Types are the product.** Most consumers import types only. Keep the type surface clean and well-documented.
- **Wire compatibility with x402.** The `exact` scheme must remain interoperable with x402 V1 and V2.

## Commands

```bash
pnpm run build      # Build with tsdown
pnpm run test       # Run 112 tests
pnpm run typecheck  # tsc --noEmit
```

## Sub-path exports

```typescript
import { ... } from 's402';          // Everything
import type { ... } from 's402/types';  // Types + constants
import { ... } from 's402/http';     // HTTP encode/decode
import { ... } from 's402/compat';   // x402 interop
import { ... } from 's402/errors';   // Error types
```
