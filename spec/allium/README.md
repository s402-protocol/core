# s402 — Allium Behavioral Specs

This directory holds [Allium](https://juxt.github.io/allium/) behavioral
specifications for s402 protocol rules that are load-bearing enough to deserve
a spec artifact independent of the code that implements them.

## What Allium specs are for here

Allium is a purely descriptive, LLM-native specification language. It has no
compiler and no runtime. Its value in this repo is narrow and specific:

1. **Durable behavioral intent.** The spec captures *what* the protocol
   promises its users, not *how* a given implementation achieves it. If the
   TypeScript implementation swaps `TransactionDataBuilder.getDigestFromBytes`
   for a manual blake2b call, the spec does not change. Only the code does.
2. **Cross-session alignment.** When a new agent session picks up s402 work,
   reading the `.allium` file tells it the invariant in one page without
   forcing a grep through multiple source files.
3. **Contradiction surface.** When two protocol rules have incompatible
   preconditions, Allium's formal structure makes the conflict visible. This
   caught the April 2026 council's S13 proposal: the new rule it described
   was already entailed by `exact`'s signing flow, and writing both as
   Allium rules side-by-side would have surfaced the redundancy immediately.

## When to add a new spec

Add an `.allium` spec for any protocol rule where:

- The rule is called out in `INVARIANTS.md` (S1–Sn) **and**
- The rule spans more than one file or subsystem to implement **and**
- A contributor (human or AI) could plausibly re-derive the rule incorrectly
  if they only read the code

If any of those three conditions is false, the rule is either already local
to a single file (read the code) or is not load-bearing enough to compound.

## Naming

`<invariant-id>-<slug>.allium`, e.g. `s8-facilitator-accountability.allium`.

Slugs describe the *behavior*, not the implementation. "digest-assertion"
would be a bad slug because it names the mechanism rather than the property.

## How to update

Allium specs are append-only like ADRs. When a rule changes, write a new
spec file and mark the old one superseded in a frontmatter comment. Never
edit a rule body in place — that destroys the history of what the protocol
promised at each version.
