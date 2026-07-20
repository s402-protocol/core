---
description: s402 positioning — the three-pillar USP. Expressiveness (six schemes), universal read (every 402 dialect), on-chain enforcement (Move invariants). Single source of truth for landing page, pitch, and grant copy.
---

# Positioning

> **One-line:** s402 is the universal HTTP 402 server — it speaks every 402 dialect on the wire, offers six payment schemes no other protocol can express, and enforces every invariant on-chain instead of in server policy.

This page is the canonical positioning document. The landing page, pitch deck, grant applications, and outbound messages all pull from here. If it isn't written here, it isn't official positioning yet.

## The Three-Pillar USP

s402's defensibility comes from three pillars that compound. Any one in isolation is commoditizable. Together they are uncopyable without a year of dedicated engineering and a Sui-native settlement layer.

### Pillar 1 — Expressiveness

**Six payment schemes as first-class protocol primitives.**

| Scheme | Use case | Competitors |
|---|---|---|
| **Exact** | One-shot per-call pricing | x402, MPP Charge |
| **Upto** | Variable-price APIs with ceiling | x402 (upto) |
| **Prepaid** | Deposit + batch for high-frequency access | MPP Session (partial) |
| **Escrow** | Arbiter-backed disputes | None |
| **Stream** | Per-second billing (inference, video) | None |
| **Unlock** | Pay-to-decrypt via SEAL + Walrus | None |

x402 ships 4 schemes (exact, upto, auth-capture, batch-settlement — the latter two added in 2026 as escrow/channel responses to the stateless-flow races Ling et al. measured in production, arXiv:2605.30998). MPP ships 1 formally registered intent. L402 ships 1. s402 ships 6. Note the direction of travel: x402's new schemes are escrow and pre-funded channels — the shapes s402 launched with — bought on EVM at the cost of capital lockup and a trusted capture authorizer. Unlock still has no equivalent in any competing protocol (threshold crypto), and s402's escrow/stream reach the same safety atomically, without pre-funding.

### Pillar 2 — Universal Read

**One server speaks every 402 dialect on the wire.**

| Dialect | Status | Module |
|---|---|---|
| **x402 V1/V2** (Coinbase) | ✅ Production | `s402/compat/x402` |
| **MPP Charge** — crypto rails (Stripe/Tempo) | ✅ v0.6 | `s402/compat/mpp` |
| **MPP Accept-Payment** | ✅ v0.6 | `s402/compat/mpp` |
| **MPP Session** | 📋 v0.7 | `s402/compat/mpp` |
| **L402** (Lightning Labs) | 📋 v0.7 | `s402/compat/l402` |
| **IETF `draft-ryan-httpauth-payment`** | 🟡 Partial via MPP | (reference impl path) |
| **Google AP2** (Agent Payments Protocol) | 📋 research | `s402/compat/ap2` |
| **ERC-7824 statechannels** | 📋 watch | — |

Any client speaking any dialect in the "Production" rows can hit an s402 server unchanged. A new dialect becomes a sub-path export (`s402/compat/*`) with its own conformance vectors — zero core pollution.

### Pillar 3 — On-Chain Enforcement

**Every scheme's invariants are Move contracts, not server policies.**

- **Upto ceiling** — enforced by the Move contract; a server cannot overcharge even if compromised.
- **Stream rate** — physically bounded by the on-chain meter; no overdraw.
- **Prepaid balance** — atomic debit; double-spend impossible.
- **Escrow release** — arbiter-signed on-chain; no custodian can freeze.
- **Unlock threshold** — SEAL + Walrus; no single party holds the key.

x402 relies on server honesty + facilitator trust. MPP relies on Tempo's permissioned validator set + Stripe's fiat ledger. s402 relies on a permissionless public chain. This is not a marketing difference — it is a structural difference in what can go wrong and who bears the loss.

## Why the Three Compound

- **Expressiveness without universal read** = a better protocol nobody can reach. Clients stay on what they have.
- **Universal read without expressiveness** = a translator with nothing to say. Clients use the source protocol directly.
- **Neither without on-chain enforcement** = a web2 payment rail wearing a crypto costume. Agents gain nothing over Stripe.

The full pitch only works when all three land in the same sentence: **"You can pay us with any 402 dialect you already speak, we offer schemes your current protocol structurally cannot express, and every invariant is enforced by a Move contract rather than our server."**

## The Absorption Principle

s402 absorbs every 402 dialect we discover in production. This is a standing commitment, not a roadmap item.

**Rule:** when a new 402 dialect is identified in-the-wild, a compat layer plan is opened within two weeks. Each compat layer:

1. Lives in its own sub-path export (`s402/compat/{name}`) with zero core imports.
2. Implements the read path first (decode, translate to s402 types). Write path is a separate milestone.
3. Passes its own conformance vectors sourced from the dialect's canonical spec.
4. Documents exactly what it does *not* translate (e.g., processor methods, session intents, bespoke auth).

**Explicit non-goals:**
- We do not absorb fiat rails (Visa, ACH, card networks) — that requires becoming a card network, not writing code.
- We do not absorb protocols we cannot read structurally (closed-source, undocumented wire formats).
- We do not fork source spec semantics — we translate, never redefine.

## What s402 Is Not

Clarity in positioning requires clarity in what we refuse.

- **Not a wallet.** Wallets sign payments; s402 is the server/resource/facilitator side.
- **Not a card network.** MPP wins on fiat rails; we coexist via `Accept-Payment`.
- **Not a chain.** s402 is chain-agnostic wire format; Sui is where all six schemes land natively today because of object model + PTB + SEAL, not because we are "a Sui protocol."
- **Not a subset of x402 or MPP.** We translate them; we are strictly larger in surface, enforcement model, and scheme count.
- **Not closed.** Apache-2.0, community adapters welcome, 161 conformance vectors public.

## The Tagline Hierarchy

Use the tightest one that fits the audience.

- **One word:** Universal.
- **One line:** The universal HTTP 402 server.
- **Two lines:** Every 402 dialect on the wire. Six schemes no one else can express. Every invariant enforced on-chain.
- **Paragraph:** s402 is the universal HTTP 402 protocol for AI agents. It reads x402, MPP, and every other 402 dialect in production, so any agent can pay any s402 endpoint unchanged. It offers six payment schemes — Exact, Upto, Prepaid, Escrow, Stream, Unlock — three of which no other protocol can structurally express. And every scheme's invariants are enforced by Move contracts on a permissionless public chain, not by server policy.

## How to Use This Document

- **Landing page copy** — hero tagline from the one-line, feature grid from the three pillars.
- **Pitch deck** — one slide per pillar, one slide on absorption, one on non-goals.
- **Grant apps** — three-pillar USP as the "why" section; absorption principle as the "defensibility" section.
- **Outbound messages** — tailor the tagline depth to the recipient's technical level; never shorten the three-pillar claim when it fits.
- **When positioning drifts** — fix it here first, then propagate. Don't let the landing page and pitch deck drift apart.

## Change Log

- **2026-04-20** — initial version. Three-pillar USP codified. Absorption principle added. Non-goals locked.
