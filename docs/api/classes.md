# Classes

The three core classes that coordinate the s402 protocol flow. Each is a registry of scheme implementations — you register only the schemes you need.

```typescript
import { s402Client, s402ResourceServer, s402Facilitator } from 's402';
```

## `s402Client`

Client-side scheme registry. Builds payment payloads from server requirements.

### `register(network, scheme)`

Register a scheme implementation for a specific network.

```typescript
register(network: string, scheme: s402ClientScheme): this;
```

Returns `this` for chaining:

```typescript
const client = new s402Client()
  .register('sui:mainnet', myExactScheme)
  .register('sui:mainnet', myPrepaidScheme);
```

### `createPayment(requirements)`

Build a payment payload for the given requirements. Auto-selects the best scheme — the first scheme in the server's `accepts` array that the client has a registered implementation for.

```typescript
async createPayment(
  requirements: s402PaymentRequirements,
): Promise<s402PaymentPayload>;
```

Accepts typed `s402PaymentRequirements`. For x402 input, normalize first via `normalizeRequirements()` from `s402/compat`.

**Throws:**
- `NETWORK_MISMATCH` — no schemes registered for the requirements' network
- `SCHEME_NOT_SUPPORTED` — none of the server's accepted schemes are registered

**Example:**

```typescript
const requirements = decodePaymentRequired(header);
const payment = await client.createPayment(requirements);
// payment.scheme will be the best match from requirements.accepts
```

### `supports(network, scheme)`

Check if the client can handle a specific scheme on a specific network.

```typescript
supports(network: string, scheme: s402Scheme): boolean;
```

---

## `s402ResourceServer`

Server-side scheme registry. Builds payment requirements for routes and processes incoming payments through a facilitator.

### `register(network, scheme)`

Register a server-side scheme for building requirements.

```typescript
register(network: string, scheme: s402ServerScheme): this;
```

### `setFacilitator(facilitator)`

Set the facilitator used for verification and settlement.

```typescript
setFacilitator(facilitator: s402Facilitator): this;
```

### `buildRequirements(config)`

Build payment requirements for a route from a config object.

```typescript
buildRequirements(config: s402RouteConfig): s402PaymentRequirements;
```

If a registered scheme has a custom builder, it is used. Otherwise, a generic requirements object is built from the config fields.

**Example:**

```typescript
const server = new s402ResourceServer();
server.setFacilitator(facilitator);

const requirements = server.buildRequirements({
  schemes: ['exact', 'prepaid'],
  price: '1000000',
  network: 'sui:mainnet',
  payTo: '0xrecipient...',
});
// requirements.accepts = ['exact', 'prepaid']
```

### `verify(payload, requirements)`

Verify a payment payload without broadcasting. Delegates to the facilitator.

```typescript
async verify(
  payload: s402PaymentPayload,
  requirements: s402PaymentRequirements,
): Promise<s402VerifyResponse>;
```

**Throws:** `FACILITATOR_UNAVAILABLE` if no facilitator is set.

### `settle(payload, requirements)`

Settle a pre-verified payment. Delegates to the facilitator.

```typescript
async settle(
  payload: s402PaymentPayload,
  requirements: s402PaymentRequirements,
): Promise<s402SettleResponse>;
```

### `process(payload, requirements)`

**Recommended path.** Expiration-guarded verify + settle in one call. Rejects expired requirements, verifies the payload, then settles.

```typescript
async process(
  payload: s402PaymentPayload,
  requirements: s402PaymentRequirements,
): Promise<s402SettleResponse>;
```

---

## `s402Facilitator`

Scheme dispatcher for verification and settlement. Routes each payment to the correct scheme implementation based on the payload's `scheme` field.

### `register(network, scheme)`

Register a scheme-specific facilitator for a network.

```typescript
register(network: string, scheme: s402FacilitatorScheme): this;
```

### `verify(payload, requirements)`

Verify a payment by dispatching to the correct scheme's verify logic.

```typescript
async verify(
  payload: s402PaymentPayload,
  requirements: s402PaymentRequirements,
): Promise<s402VerifyResponse>;
```

### `settle(payload, requirements)`

Settle a payment by dispatching to the correct scheme.

```typescript
async settle(
  payload: s402PaymentPayload,
  requirements: s402PaymentRequirements,
): Promise<s402SettleResponse>;
```

### `process(payload, requirements)`

Expiration-guarded verify + settle. The recommended path for production use.

```typescript
async process(
  payload: s402PaymentPayload,
  requirements: s402PaymentRequirements,
): Promise<s402SettleResponse>;
```

Sequence:
1. Check `requirements.expiresAt` — reject if expired (`REQUIREMENTS_EXPIRED`)
2. Call `scheme.verify()` — reject if invalid (`VERIFICATION_FAILED`)
3. Re-check `requirements.expiresAt` — latency guard (verification may be slow; reject stale requirements before spending gas)
4. Call `scheme.settle()` — return the settlement result

Atomicity comes from Sui PTBs in the scheme implementation, not from this method. This method provides the temporal guard.

### `supports(network, scheme)`

```typescript
supports(network: string, scheme: s402Scheme): boolean;
```

### `supportedSchemes(network)`

```typescript
supportedSchemes(network: string): s402Scheme[];
```

---

## `s402RouteConfig`

Per-route configuration used by `s402ResourceServer.buildRequirements()`.

```typescript
interface s402RouteConfig {
  schemes: s402Scheme[];           // Which schemes to accept
  price: string;                   // Amount in base units
  network: string;                 // e.g., "sui:mainnet"
  payTo: string;                   // Recipient address
  asset?: string;                  // Coin type (default: SUI)
  facilitatorUrl?: string;
  settlementMode?: s402SettlementMode;

  // Optional scheme-specific config
  mandate?: { required: boolean; minPerTx?: string };
  protocolFeeBps?: number;
  receiptRequired?: boolean;
  stream?: { ratePerSecond: string; budgetCap: string; minDeposit: string };
  escrow?: { seller: string; arbiter?: string; deadlineMs: string };
  unlock?: { encryptionId: string; walrusBlobId: string; encryptionPackageId: string };
  prepaid?: { ratePerCall: string; maxCalls?: string; minDeposit: string; withdrawalDelayMs: string };
}
```

## Scheme Interfaces

When building your own scheme implementation, implement one of these interfaces depending on the role:

| Interface | Role | Key Method |
|-----------|------|-----------|
| `s402ClientScheme` | Client | `createPayment(requirements)` |
| `s402ServerScheme` | Server | `buildRequirements(config)` |
| `s402FacilitatorScheme` | Facilitator | `verify()` + `settle()` |
| `s402DirectScheme` | Self-sovereign client | `settleDirectly(requirements)` |

See [Design Principles](/architecture) for details on why each scheme has its own verify logic.
