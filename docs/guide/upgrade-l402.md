---
description: Migrating from L402 (Lightning Labs) to s402 — consume L402 challenges natively via s402/compat/l402, coexist via Accept-Payment, and optionally graduate off Lightning to on-chain schemes.
---

# Migrating from L402

Already running an L402-gated API (Aperture or similar)? s402 is the first 402 protocol that reads L402 natively. Your Lightning-paying clients keep working; your s402 clients get six schemes Lightning structurally can't express.

This guide is for teams running Aperture-style Lightning paywalls who want to extend — not replace — their setup.

::: info Availability
L402 read-path lands in v0.7 — the code is in the `s402/compat/l402` entry point. Write-path emission (s402 server emitting an L402 challenge with an issued macaroon + fresh invoice) is not scoped: it requires a running Lightning node to mint invoices, which is out of scope for a wire-format library. Teams that want to emit L402 should keep using Aperture.
:::

## TL;DR

- s402 will read L402 / LSAT challenges via `s402/compat/l402` (shipping v0.7)
- Your existing Aperture deployment keeps working
- You gain six schemes Lightning structurally cannot express: Upto ceiling, Escrow with arbiter, Stream with on-chain rate cap, Unlock pay-to-decrypt, Prepaid batched settlement, Exact on any chain beyond Bitcoin
- Coexistence via `Accept-Payment`: advertise both L402 and s402 on the same endpoint

## When to pick s402 over L402

| Situation | Right tool |
|---|---|
| You need sub-millisecond payment finality | **s402 Prepaid on Sui** — ~400ms vs Lightning's multi-hop routing (variable, seconds) |
| Your API has variable pricing and you must bound the maximum charge | **s402 Upto** — the ceiling is enforced by a Move contract |
| You're running per-second billing (inference, video, live data) | **s402 Stream** — on-chain rate enforcement |
| Trustless commerce between unfamiliar parties with arbiter-backed disputes | **s402 Escrow** |
| Pay-to-decrypt content | **s402 Unlock** — via Sui SEAL + Walrus |
| You don't want to run a Lightning node | **s402** — chain-agnostic, hosted facilitator available |

## When to stay on L402

Lightning has properties s402 doesn't replicate:

- **Bitcoin-native settlement** — if your users prefer Bitcoin and your API ingests sats, Lightning is the path of least resistance
- **Existing Lightning wallet ecosystem** — Phoenix, Wallet of Satoshi, Breez, Zeus — huge installed base
- **Privacy via onion routing** — Lightning's source-route topology is stronger than most on-chain systems
- **You already run Aperture** — don't migrate for migration's sake

## Consuming an L402 challenge as an s402 client

This is the primary v0.7 capability — an s402 client receives a 402 from an Aperture server, lifts the challenge into s402 types, and routes it to the caller's Lightning wallet.

```typescript
import {
  parseWwwAuthenticateL402,
  fromL402Challenge,
} from 's402/compat/l402';

const res = await fetch('https://api.example.com/data');
if (res.status === 402) {
  const challenge = parseWwwAuthenticateL402(
    res.headers.get('WWW-Authenticate'),
  );
  if (challenge) {
    const requirements = fromL402Challenge(challenge);
    // requirements.network  === 'lightning:mainnet'
    // requirements.asset    === 'lightning:msat'
    // requirements.amount   === '250000000'            (for a 2500 μBTC invoice)
    // requirements.payTo    === 'lightning:invoice'    (sentinel — real destination is in the invoice)
    // requirements.extensions.l402.macaroon           (present back on retry)
    // requirements.extensions.l402.invoice            (pay this via a Lightning wallet)

    // Your Lightning wallet pays the invoice and returns the preimage.
    const preimage = await yourLightningWallet.pay(requirements.extensions.l402.invoice);

    // Retry with L402 Authorization.
    await fetch('https://api.example.com/data', {
      headers: {
        Authorization: `L402 ${requirements.extensions.l402.macaroon}:${preimage}`,
      },
    });
  }
}
```

`parseWwwAuthenticateL402` accepts both the modern `L402` and the legacy `LSAT` auth-scheme names — Aperture still emits `LSAT` on older deployments. The parsed output is always canonicalized to `L402`.

### BOLT-11 HRP decoding

`fromL402Challenge` calls `decodeBolt11Summary` internally to extract the amount and network from the invoice's human-readable part. This is a **partial** BOLT-11 decoder — it reads only the HRP (prefix + amount + multiplier) because full tagged-field parsing requires 500+ lines of bech32 code that the Lightning wallet already has.

| BOLT-11 multiplier | Conversion to msat |
|---|---|
| (none) | `amount * 10^11` |
| `m` (milli-BTC) | `amount * 10^8` |
| `u` (micro-BTC) | `amount * 10^5` |
| `n` (nano-BTC) | `amount * 10^2` |
| `p` (pico-BTC) | `amount / 10` (amount must be multiple of 10) |

### What's not in the read path yet

- **Macaroon caveat decoding** — the macaroon is passed through opaque; we do not decode or enforce caveats (expiry, capability bindings). Clients that need caveat introspection should use `node-macaroon` or equivalent.
- **Preimage verification** — server-side, requires Lightning node access. Out of scope for a wire-format library.
- **Invoice tagged-field parsing** — node pubkey, routing hints, payment hash, description — all inside the invoice but left for the Lightning wallet that actually pays.
- **BOLT-12 offers** — the newer offer-based protocol is not yet supported; spec is still evolving.

## Coexistence pattern via `Accept-Payment`

Advertise both L402 and s402 on the same endpoint; each client pays its native way.

```typescript
import { parseAcceptPayment, selectBestScheme, S402_HEADERS } from 's402';

async function handle(req: Request): Promise<Response> {
  const preferred = parseAcceptPayment(req.headers.get(S402_HEADERS.ACCEPT_PAYMENT));

  const supported = [
    's402/prepaid',     // s402 high-frequency native
    's402/exact',       // s402 one-shot
    'l402/lightning',   // L402 Lightning (advertised but emitted by your Aperture path)
  ];

  const chosen = selectBestScheme(preferred, supported);

  if (chosen?.startsWith('l402/')) {
    return routeToApertureHandler(req);   // your existing L402 path
  }

  return buildS402Challenge(chosen ?? 's402/exact');
}
```

L402 clients pay via Lightning (routed to Aperture). s402 clients pay via s402 (Sui, EVM, etc.). Neither client stack changes.

## Honest comparison

| Dimension | L402 | s402 |
|---|---|---|
| **Schemes** | 1 (Lightning invoice + macaroon) | 6 (Exact, Upto, Prepaid, Escrow, Stream, Unlock) |
| **Settlement** | Lightning Network (Bitcoin) | Chain-agnostic (Sui native; EVM + Solana via schemes) |
| **Finality** | Seconds (multi-hop routing) | ~400ms on Sui |
| **Enforcement** | Macaroon caveats (server-signed) | Move contracts (on-chain) |
| **Node requirement** | Must run Lightning node | Hosted facilitator available |
| **Multi-chain** | Bitcoin only | Any chain with an s402 adapter |
| **Pricing model** | Per-call (one invoice per request) | Per-call + batch + streaming + unlock |

L402 wins on Bitcoin-native settlement and a mature Lightning wallet ecosystem. s402 wins on expressiveness, finality, enforcement model, and multi-chain reach.

## FAQ

### Do I need to migrate off Aperture?

No. The coexistence pattern is first-class — advertise both and let clients pick.

### Does s402 emit L402 challenges?

No. L402 emission requires minting BOLT-11 invoices, which requires a Lightning node. That's Aperture's job. If you need to emit L402, keep Aperture in the path.

### Can I reuse my Aperture macaroon infrastructure with s402?

Not directly — macaroons are L402-specific. s402 uses signed receipt claims (NFT receipts on Sui, or HTTP header receipts for lightweight flows). The two are conceptually similar (bearer tokens with expiry + caveats) but structurally incompatible on the wire.

### What happens to the `payTo` field since Lightning invoices don't expose a traditional address?

`payTo` is set to the sentinel `"lightning:invoice"`. The real destination (node pubkey + payment hash) is inside the BOLT-11 invoice, which the Lightning wallet decodes itself. The sentinel exists only to satisfy the s402 schema.

### Why is `asset` set to `"lightning:msat"` instead of a token identifier?

Lightning payments are denominated in millisatoshi — they don't carry a token identifier. The `lightning:msat` string is an s402 convention that signals "this amount is in millisatoshi, pay via Lightning Network."

## Next steps

- **[See the six schemes](/guide/which-scheme)** — match each scheme to a use case
- **[Migrating from x402](/guide/upgrade-x402)** — if you're also running x402
- **[Migrating from MPP](/guide/upgrade-mpp)** — if you're also running MPP (Stripe/Tempo)
- **[Positioning](/positioning)** — the three-pillar USP

If you're running Aperture and want to pilot s402 alongside it, [file an issue](https://github.com/s402-protocol/core/issues) — we'll help you wire up the coexistence pattern.
