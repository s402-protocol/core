---
description: Migrating from x402 to s402 — drop-in wire compatibility, one-line middleware swap, and five optional schemes x402 doesn't express. Your existing x402 clients keep working.
---

# Migrating from x402

Already running x402? s402 reads your payments natively. The migration is a one-line middleware swap, your existing x402 clients keep working, and you optionally gain five more payment schemes.

This guide is for x402 server maintainers, x402 client maintainers, and AI coding agents upgrading projects that already speak x402.

## TL;DR

- s402 is **wire-compatible with x402 V1** and reads x402 V2 via a compat layer
- Your x402 `exact` flow keeps working — no client changes required
- You gain on-chain NFT receipts, atomic PTB settlement on Sui, and typed errors with `retryable` + `suggestedAction`
- If you want them, five additional schemes are available: Upto, Prepaid, Escrow, Stream, Unlock

## What's the same

The wire format. s402 uses the same three HTTP headers as x402 V1:

| Header | Direction | x402 V1 | s402 |
|--------|-----------|---------|------|
| `payment-required` | Server → Client | ✅ | ✅ |
| `x-payment` | Client → Server | ✅ | ✅ |
| `payment-response` | Server → Client | ✅ | ✅ |

An x402 client sending an `exact` payment to an s402 server works with **zero code changes**. Detection is automatic via `detectProtocol()`.

## Drop-in migration (server)

If you have an x402 server today, swap one import:

```typescript
// Before
import { verifyX402Payment } from 'x402';

// After
import { normalizeRequirements, verifyPayment } from 's402/compat';

// Your existing handler, unchanged in shape:
async function handlePaidRequest(req: Request): Promise<Response> {
  const header = req.headers.get('x-payment');
  if (!header) {
    return new Response('Payment Required', {
      status: 402,
      headers: {
        'payment-required': buildPaymentRequired({
          accepts: ['exact'],
          network: 'sui:mainnet',
          asset: '0x2::sui::SUI',
          amount: '1000000',
          payTo: process.env.PAY_TO_ADDRESS!,
        }),
      },
    });
  }

  // Works with payloads from x402 V1 clients OR s402 clients
  const normalized = normalizeRequirements(header);
  const verified = await verifyPayment(normalized);

  if (!verified.ok) {
    return new Response(verified.error.suggestedAction, { status: 402 });
  }

  return deliverContent();
}
```

That's the migration. One import swap. Your existing clients continue to work.

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

Yes. s402 servers read x402 V1 `x-payment` headers natively. For x402 V2, use the compat layer.

### Do I have to switch chains?

No. s402 is a chain-agnostic **wire format**. It doesn't force a chain. Sui happens to be the most expressive chain for s402 (it's the only chain today where every scheme is natively implementable), but the wire format runs anywhere.

### Do I have to give up x402?

No. You can speak both simultaneously. Use `detectProtocol()` on incoming payloads and route to the right handler.

### What about x402 V2's multi-chain support?

The x402 V2 compat layer handles V2 inputs. See [`s402/compat`](/api/compat) for the full API.

### Is there gas sponsorship?

Facilitator-level today (the facilitator pays gas on behalf of the payer). A protocol-level `feePayer` field is on the roadmap — tracked separately.

### What about MPP?

MPP support is planned via a dedicated compat module. See [Migrating from MPP](/guide/upgrade-mpp) for the full story.

## Next steps

- **[See the six schemes](/guide/which-scheme)** — decide which ones match your use cases
- **[Compare s402 vs x402 vs MPP](/comparison)** — the honest three-way breakdown
- **[Quickstart](/guide/quickstart)** — build an s402 server from scratch in 5 minutes

If you hit a migration snag, [file an issue](https://github.com/s402-protocol/core/issues) — we want the transition to be boring.
