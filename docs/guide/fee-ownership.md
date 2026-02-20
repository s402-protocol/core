# Fee Ownership & Trust Model

> **Decision**: Protocol fees are owned by the Facilitator, not the Resource Server.
> The `protocolFeeBps` field in HTTP requirements is advisory only.

## The Problem

s402 payment requirements include an optional `protocolFeeBps` field — a number between 0 and 10000 representing the protocol fee in basis points. The field appears in the Resource Server's 402 response.

This creates a trust problem: the Resource Server is a potentially adversarial party (their interests differ from the client's fee minimization). Allowing them to set a fee that flows to a third party (the Facilitator) with no on-chain enforcement is a trust model inversion.

Five failure modes arise from this design:

1. **Fee inflation** — a malicious merchant sets `protocolFeeBps: 10000` (100%). Without on-chain enforcement, the SDK must decide how to react — and every SDK implementation will choose differently.
2. **Direction ambiguity** — does the client pay `amount + fee` on top, or does the facilitator deduct the fee from `amount`? Both readings are valid English. The spec must be explicit.
3. **Optional field collapse** — if `protocolFeeBps` is omitted, what does the facilitator charge? 0? Its own configured rate? A mismatch between HTTP disclosure and actual charge is a disclosure failure.
4. **Facilitator substitution** — a malicious Resource Server sets `facilitatorUrl` to their own endpoint and `protocolFeeBps: 0`. The client sees "no fee" and a plausible URL. The fake facilitator pockets the payment.
5. **Multi-scheme inconsistency** — for Prepaid and Stream schemes, the fee applies across multiple micro-settlements. If the Resource Server changes `protocolFeeBps` between refreshes, the client's total cost is unpredictable.

## The Decision

**The Facilitator owns the fee. The Resource Server cannot override it.**

This matches every mature payments network:
- Visa sets interchange rates. Merchants cannot override them.
- Stripe charges its own fee. Sellers cannot configure what Stripe takes.
- Uniswap's fee is set at pool creation by governance — not per-transaction by the seller.

## How It Works

### The Facilitator's canonical fee schedule

The SweeFi hosted facilitator (and any conforming s402 facilitator) exposes a signed fee schedule:

```
GET https://facilitator.sweefi.com/.well-known/s402-facilitator
```

```json
{
  "feeBps": 50,
  "feeRecipient": "0xabc...facilitator_address",
  "minFeeUsd": "0.01",
  "maxAmountPerTx": "1000000000",
  "validUntil": 1800000000,
  "signature": "..."
}
```

Clients cache this with the `validUntil` TTL. The signature is the enforcement mechanism.

### The `protocolFeeBps` HTTP field is advisory

The field in `s402PaymentRequirements` exists for one purpose: **transparent UI disclosure**. It lets the client show the user "you will pay X + 0.5% fee" before the transaction is signed. It does not affect what the smart contract does.

**The source of truth is on-chain.** For Sui, this is `ProtocolState.protocolFeeBps`. The Move contract enforces this value unconditionally — it cannot be overridden by PTB arguments.

### Semantics of `amount`

```
amount:         What the Resource Server requires the provider to receive (net of fees)
facilitatorFee: amount × feeBps / 10000 (from the facilitator's signed schedule)
clientPays:     amount + facilitatorFee
```

No ambiguity. The merchant declares their net requirement. The client pays that plus the facilitator's fee.

### Validation rules

| Party | What they MUST do |
|-------|------------------|
| **Resource Server** | May include `protocolFeeBps` as a courtesy; MUST NOT include it if they don't know the facilitator's rate |
| **Client** | SHOULD verify `protocolFeeBps` in requirements matches `/.well-known/s402-facilitator`; MUST warn user if mismatch |
| **Facilitator** | MUST reject settlements where the encoded fee does not match its on-chain `ProtocolState` |
| **Smart Contract** | MUST enforce fee from `ProtocolState`, not from transaction arguments |

## What This Means for Self-Hosted Facilitators

Anyone running their own s402 facilitator (the reference implementation is open-source) sets their own fee schedule via their `ProtocolState` object. Their `/.well-known/s402-facilitator` endpoint reflects that schedule. Clients connecting to their facilitator URL will see and verify the correct rate.

The protocol does not enforce a specific fee amount — it enforces **fee ownership**. The Facilitator controls their rate; the Resource Server cannot override it; the client is always shown the true cost before signing.

## See Also

- [`s402PaymentRequirements`](/api/#s402PaymentRequirements) — wire format reference
- [Security Model](/security) — full threat model and trust boundaries
- [Architecture](/architecture) — three-actor model (Client, Resource Server, Facilitator)
