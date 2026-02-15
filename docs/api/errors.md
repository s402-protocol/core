# Errors

Every s402 error is typed, tells you whether it's retryable, and suggests what to do next. No guessing.

```typescript
import { s402Error, s402ErrorCode, createS402Error } from 's402/errors';
```

## Error Codes

| Code | Retryable | Suggested Action |
|------|-----------|------------------|
| `INSUFFICIENT_BALANCE` | No | Top up wallet balance or try with a smaller amount |
| `MANDATE_EXPIRED` | No | Request a new mandate from the delegator |
| `MANDATE_LIMIT_EXCEEDED` | No | Request mandate increase or split across transactions |
| `STREAM_DEPLETED` | Yes | Top up the stream deposit |
| `ESCROW_DEADLINE_PASSED` | No | Create a new escrow with a later deadline |
| `SEAL_DECRYPTION_FAILED` | Yes | Re-request SEAL key with a fresh session key |
| `FINALITY_TIMEOUT` | Yes | Transaction submitted but not confirmed — retry finality check |
| `FACILITATOR_UNAVAILABLE` | Yes | Fall back to direct settlement if signer is available |
| `INVALID_PAYLOAD` | No | Check payload format and re-sign the transaction |
| `SCHEME_NOT_SUPPORTED` | No | Use the "exact" scheme (always supported for x402 compat) |
| `NETWORK_MISMATCH` | No | Ensure client and server are on the same Sui network |
| `SIGNATURE_INVALID` | No | Re-sign the transaction with the correct keypair |
| `REQUIREMENTS_EXPIRED` | Yes | Re-fetch payment requirements from the server |
| `VERIFICATION_FAILED` | No | Check payment amount and transaction structure |

## `s402Error` Class

Extends `Error` with typed fields for programmatic error handling.

```typescript
class s402Error extends Error {
  readonly code: s402ErrorCodeType;
  readonly retryable: boolean;
  readonly suggestedAction: string;

  constructor(code: s402ErrorCodeType, message?: string);
  toJSON(): s402ErrorInfo;
}
```

**Example:**

```typescript
try {
  const payment = await client.createPayment(requirements);
} catch (err) {
  if (err instanceof s402Error) {
    console.log(err.code);            // 'NETWORK_MISMATCH'
    console.log(err.retryable);       // false
    console.log(err.suggestedAction); // 'Ensure client and server...'

    if (err.retryable) {
      // safe to retry
    }
  }
}
```

## `createS402Error(code, message?)`

Create an error info object without throwing.

```typescript
function createS402Error(
  code: s402ErrorCodeType,
  message?: string,
): s402ErrorInfo;
```

Returns:

```typescript
interface s402ErrorInfo {
  code: s402ErrorCodeType;
  message: string;
  retryable: boolean;
  suggestedAction: string;
}
```

Useful for building error responses in facilitators and servers:

```typescript
const errorInfo = createS402Error('INSUFFICIENT_BALANCE', 'Need 1 SUI, have 0.5');
// { code: 'INSUFFICIENT_BALANCE', message: '...', retryable: false, suggestedAction: '...' }
```

## `s402ErrorCode`

Const object containing all error code strings. Use for type-safe comparisons:

```typescript
import { s402ErrorCode } from 's402/errors';

if (err.code === s402ErrorCode.FINALITY_TIMEOUT) {
  // retry...
}
```

## Handling Errors in Practice

```typescript
import { s402Error, s402ErrorCode } from 's402';

async function payWithRetry(client, requirements, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await client.createPayment(requirements);
    } catch (err) {
      if (!(err instanceof s402Error)) throw err;
      if (!err.retryable) throw err;

      // Handle specific retryable errors
      if (err.code === s402ErrorCode.REQUIREMENTS_EXPIRED) {
        requirements = await refetchRequirements();
        continue;
      }
      if (err.code === s402ErrorCode.FACILITATOR_UNAVAILABLE) {
        // fall back to direct settlement
        return await settleDirectly(requirements);
      }
    }
  }
  throw new Error('Max retries exceeded');
}
```
