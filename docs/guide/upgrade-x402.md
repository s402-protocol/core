---
description: Migrating from x402 to s402 — drop-in wire compatibility, one-line middleware swap, and five optional schemes x402 doesn't express. Your existing x402 clients keep working.
---

# Migrating from x402

Already running x402? s402 reads your payments natively. The migration is a one-line middleware swap, your existing x402 clients keep working, and you optionally gain five more payment schemes.

This guide is for x402 server maintainers, x402 client maintainers, and AI coding agents upgrading projects that already speak x402.

## TL;DR

- s402 reads x402 V1 **and** V2 payments on every gate, and its 402 **is** an x402 V2 `PaymentRequired` envelope on every route
- Your x402 `exact` flow keeps working — **zero client changes and zero server options**
- Audited against x402 @ `2cc7e9a6` (2026-09-04); the pin lives in code as `X402_UPSTREAM_PIN`
- You gain on-chain NFT receipts, atomic PTB settlement on Sui, and typed errors with `retryable` + `suggestedAction`
- If you want them, five additional schemes are available: Upto, Prepaid, Escrow, Stream, Unlock

## What's the same

The transport: HTTP 402, base64-encoded JSON in headers. The header *names* are where the two protocols and their versions differ, and an `s402Gate` reads all of them:

| Leg | x402 V1 | x402 V2 | s402 native | `s402Gate` accepts |
|-----|---------|---------|-------------|--------------------|
| 402 → client | JSON body (`x402Version: 1`) | `PAYMENT-REQUIRED` | `payment-required` | emits the x402 V2 envelope, always |
| payment → server | `X-PAYMENT` | `PAYMENT-SIGNATURE` | `x-payment` | all three, always |
| receipt → client | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` | `payment-response` | answers in the dialect the payment arrived in |

*(Header names verified against `specs/transports-v1/http.md` and `specs/transports-v2/http.md` at x402 @ `2cc7e9a6`.)*

An x402 client sending an `exact` payment to an `s402Gate` is accepted with **zero client changes**, and it can read the 402 too, because that 402 is x402's own document. The round trip is proven against the unmodified upstream `@x402/fetch` in `typescript/test/interop-x402-client.test.ts`.

## Drop-in migration (server)

For `exact`-scheme traffic, the payload an x402 client signs is the same payload an s402 facilitator verifies. If you have an x402 server today using the `exact` scheme, your existing x402 clients work against an `s402Gate` with **zero client changes and zero server options**:

```typescript
const gate = s402Gate({
  server,
  requirements,
  // Required, because x402's V2 envelope requires it — not an interop switch.
  resource: { url: 'https://api.example.com/paid', mimeType: 'application/json' },
});
```

All three legs need nothing further: the 402 is an x402 V2 `PaymentRequired` envelope, the gate reads `PAYMENT-SIGNATURE` and `X-PAYMENT` unconditionally, and it answers an x402 payment with an x402-shaped `PAYMENT-RESPONSE`. Why there is only one grammar — s402 is a *profile* of x402, not a rival wire format — is [ADR-016](../adr/016-s402-402-is-an-x402-envelope.md).

If you are wiring headers by hand instead of using the gate, `encodePaymentRequired` already emits the envelope; `s402/compat/x402` adds `fromX402PayloadHeaders` for intake and `toX402SettleResponse` + `encodeX402SettleResponse` for the receipt.

```typescript
import {
  s402ResourceServer,
  s402Facilitator,
  encodePaymentRequired,
  decodePaymentPayload,
  encodeSettleResponse,
  S402_HEADERS,
} from 's402';

const server = new s402ResourceServer();
server.register(/* network */, /* your server scheme */);
server.setFacilitator(/* your facilitator */);

const requirements = server.buildRequirements({
  schemes: ['exact'],
  network: 'sui:mainnet',
  asset: '0x2::sui::SUI',
  price: '1000000',
  payTo: process.env.PAY_TO_ADDRESS!,
});

async function handlePaidRequest(req: Request): Promise<Response> {
  const header = req.headers.get(S402_HEADERS.PAYMENT);

  if (!header) {
    return new Response(JSON.stringify({ error: 'Payment Required' }), {
      status: 402,
      headers: { [S402_HEADERS.PAYMENT_REQUIRED]: encodePaymentRequired(requirements) },
    });
  }

  // decodePaymentPayload accepts x402 V1 `exact` payloads natively.
  const payload = decodePaymentPayload(header);
  const result = await server.process(payload, requirements);

  if (!result.success) {
    return new Response(JSON.stringify({ error: result.error }), { status: 402 });
  }

  return new Response(/* your content */, {
    headers: { [S402_HEADERS.PAYMENT_RESPONSE]: encodeSettleResponse(result) },
  });
}
```

**x402 V2 requirements need no conversion at all** — that envelope is s402's own document, so
`decodePaymentRequired` reads it directly. The compat layer is for the two RETIRED flat shapes,
x402 V1 and s402's own pre-v2 402:

```typescript
import { normalizeRequirements, fromS402V1Requirements } from 's402/compat/x402';

// Auto-detects: wire v2 / x402 V2 envelope, x402 V1 flat, or s402 v1 flat.
const required = normalizeRequirements(JSON.parse(atob(headerFromUpstream)));
// Always returns s402PaymentRequired — pick an offer and call server.process().
await server.process(payload, required.accepts[0]);
```

`fromS402V1Requirements()` is the same job for s402's own past: a v1 `accepts: ['exact','prepaid']`
becomes one `accepts[]` entry per scheme, `exact` first. Nothing emits v1.

That's the migration. Your existing clients continue to work.

## What you gain without changing app code

Just by speaking s402 on the server side:

1. **On-chain NFT receipts.** Every payment produces an auditable on-chain proof. x402's receipts are off-chain HTTP headers that can be lost; s402 mints them as Sui objects.
2. **Atomic PTB settlement on Sui.** x402 is two-step (verify, then settle). s402 on Sui runs verify + settle + deliver in a single Programmable Transaction Block. No temporal gap, no "looks valid but money didn't move" race.
3. **Typed errors with recovery hints.** Every s402 error carries `code`, `retryable`, and `suggestedAction`. Agents can self-recover without human intervention.

```typescript
try {
  await facilitator.settle(payload, requirements);
} catch (e) {
  if (e instanceof S402Error) {
    console.log(e.code);            // 'INSUFFICIENT_BALANCE'
    console.log(e.retryable);       // false
    console.log(e.suggestedAction); // 'Top up wallet balance...'
  }
}
```

## What you unlock if you opt in

x402 expresses one payment pattern: one call, one payment. s402 has six. Staying on s402's `exact` scheme is fine — everything below is opt-in.

| Scheme | When to reach for it |
|---|---|
| **[Prepaid](/schemes/prepaid)** | High-frequency agent traffic. 500× gas savings via deposit-then-claim. $0.014 per 1,000 calls on Sui. Rate cap enforced by a Move contract. |
| **[Upto](/schemes/upto)** | Variable pricing with a hard ceiling the server cannot exceed. The ceiling is on-chain — it is literally impossible for the server to charge more than the client authorized. |
| **[Stream](/schemes/stream)** | Per-second billing for inference, video, real-time data. On-chain rate enforcement — the meter cannot run faster than contracted. |
| **[Escrow](/schemes/escrow)** | Trustless commerce between unfamiliar parties, with an optional arbiter for disputes. |
| **[Unlock](/schemes/unlock)** | Pay-to-decrypt content via Sui SEAL threshold encryption + Walrus storage. Cannot be built on EVM — requires native threshold crypto with on-chain access control. |

## FAQ

### Do my x402 clients still work?

Yes — and since wire v2 they can read the 402 as well, with no option set. s402 servers read x402 V1 `X-PAYMENT` and V2 `PAYMENT-SIGNATURE` payloads on every gate.

### Do I have to switch chains?

No. s402 is a chain-agnostic **wire format**. It doesn't force a chain. Sui happens to be the most expressive chain for s402 (it's the only chain today where every scheme is natively implementable), but the wire format runs anywhere.

### Do I have to give up x402?

No. You can speak both simultaneously. Use `detectProtocol()` on incoming payloads and route to the right handler.

### What about x402 V2's multi-chain support?

V2 *is* s402's wire now — a V2 envelope decodes natively, multi-chain offers included: one 402 can offer `exact` on Sui and `exact` on Base as two `accepts[]` entries. See [`s402/compat/x402`](/api/compat) for what compat still covers.

### Is there gas sponsorship?

Facilitator-level today (the facilitator pays gas on behalf of the payer). A protocol-level `feePayer` field is on the roadmap — tracked separately.

### What about MPP?

MPP support is planned via a dedicated compat module. See [Migrating from MPP](/guide/upgrade-mpp) for the full story.

## Next steps

- **[See the six schemes](/guide/which-scheme)** — decide which ones match your use cases
- **[Compare s402 vs x402 vs MPP](/comparison)** — the honest three-way breakdown
- **[Quickstart](/guide/quickstart)** — build an s402 server from scratch in 5 minutes

If you hit a migration snag, [file an issue](https://github.com/s402-protocol/core/issues) — we want the transition to be boring.
