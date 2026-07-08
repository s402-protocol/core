# ADR-002: s402 is a Pure Protocol Repo — mcp-server Moves to SweeFi

**Status:** Accepted
**Date:** 2026-04-11
**Supersedes:** (none — refines the boundary that ADR-001 § Decision 1 named but did not enforce at the repo level)

## Context

ADR-001 (2026-04-11) formalized four protocol boundaries, including S7: *"the s402 protocol surface is chain-agnostic."* That ADR treated the boundary as a rule about code inside the `s402` package (`typescript/src/`). A follow-up read-only audit of sibling repos on 2026-04-11 revealed the boundary had already been broken in a less obvious way: the `s402` repo itself contains a `mcp-server/` folder whose `src/sui-exact.ts` imports `@mysten/sui` directly. The repo-level boundary test (`typescript/test/boundary.test.ts`) is scoped to `typescript/src/` only and therefore does not detect the violation.

This is a *repo-level* S7 violation. The `s402` npm package is chain-agnostic, but the `mcp-server/` folder inside the same repo is not — and to a contributor reading `ls s402/`, the distinction is invisible. The same AI-drift risk ADR-001 was written to warn against (four consecutive sessions adding Sui-specific address validation to `http.ts` before a human caught it) can happen in any sibling directory of `typescript/` just as easily as inside it.

The audit also surfaced that SweeFi already has the correctly-layered implementation:

- `sweefi/contracts/sources/` contains Move modules for all five schemes (`payment.move`, `stream.move`, `escrow.move`, `prepaid.move`, `seal_policy.move`) plus supporting modules (mandate, identity, math, admin). 426 Move test functions across 10 modules.
- `sweefi/packages/sui/src/s402/` has client/facilitator/server TypeScript adapters for all five schemes (exact, stream, escrow, prepaid, unlock). 669 tests in `@sweefi/sui`.
- `sweefi/packages/mcp/` is `@sweefi/mcp` v0.1.4 with 35 tools and 222 tests. Beta-grade, published to npm, consumed by real users.
- Testnet v11 is deployed at `0xb83e50365ba460aaa02e240902a40890bec88cd35bd2fc09afb6c79ec8ea9ac5` with three schemes demo'd live (exact/stream/escrow). *(Note 2026-07-02: that package is now ORPHANED — a pre-migration snapshot; the current testnet package is `0x5c158886776cdb4a12c7933717ba45f6ec7165586613820016d7fafbae48fdfa`, fresh 2026-06-16 deploy. Historical context above preserved as written.)*
- Grand total: **1,775 tests** (1,349 TypeScript + 426 Move).
- SweeFi already consumes `s402` from npm as a versioned dependency (`"s402": "^0.2.0"`).

SweeFi's own agent instructions (`sweefi/.claude/CLAUDE.md`) already codify the rule this ADR enforces, line-for-line:

> **Critical Boundaries — s402 is chain-agnostic. @sweefi/sui is chain-specific. NEVER put Sui logic in the s402 package.**

The rule already exists in the ecosystem. This ADR simply makes the s402 repo obey it.

## Decision

**s402 is a pure protocol repo.** The repository contains, and may only contain:

- `typescript/` — the `s402` npm package (wire types, scheme interfaces, HTTP middleware, client/server/facilitator primitives, test utilities). **Zero runtime dependencies. Zero chain-specific imports.**
- `python/` — the `s402` pip package (mirror implementation, same surface).
- `spec/` — language-agnostic specification artifacts: conformance test vectors (`spec/vectors/`), Allium behavioral specs (`spec/allium/`).
- `docs/` — VitePress documentation site deployed to `s402-protocol.org`, including ADRs.
- `demo-api/` — a minimal chain-agnostic example consuming the `s402` package from npm. Allowed because it imports only `s402`, never `@mysten/sui` or any other chain SDK. It is a usage example, not an implementation.
- `INVARIANTS.md`, `AGENTS.md`, `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md` — repo-level documentation.

The repository does **not** contain:

- Chain-specific adapters (`sui-*.ts`, `solana-*.ts`, `evm-*.ts`, etc.)
- Chain-specific imports (`@mysten/sui`, `@solana/web3.js`, `ethers`, `viem`, etc.)
- Move contracts, Anchor programs, Solidity contracts
- MCP server implementations
- Facilitator service implementations (beyond the abstract `s402Facilitator` class in `typescript/src/facilitator.ts`)

All of the above live in downstream *implementation* repos:

- **SweeFi** (`projects/sweefi-project/sweefi/`) — Sui implementation. `@sweefi/sui` is the adapter package, `@sweefi/mcp` is the canonical MCP server for Sui, `@sweefi/facilitator` is the hosted facilitator service, `@sweefi/solana` is an alpha Solana adapter, and the Move contracts live under `contracts/`.
- Future implementations (SweeFi-EVM, SweeFi-CosmWasm, third-party forks) follow the same pattern: one chain per repo, each consuming `s402` from npm.

### Effective immediately

1. **`s402/mcp-server/` is removed in full.** The folder, its tests, its `package.json`, its README are all deleted in a single commit that references this ADR.
2. **The published npm package `s402-mcp@0.1.1`** is deprecated via `npm deprecate s402-mcp "s402-mcp has moved to @sweefi/mcp — install @sweefi/mcp instead"`. This is a manual step performed by the npm account owner; it does not unpublish the old version, it only adds an install-time warning. Existing installations continue to work indefinitely.
3. **Distribution pitches** (Claude Code onboarding, Cursor tool list, MCP registry listing, README badges, Twitter threads, blog posts, HN submissions) are updated to point at `@sweefi/mcp`, not `s402/mcp-server`.
4. **`s402/README.md`** adds a top-level "Reference implementations" section listing SweeFi with a link.
5. **The scope coverage table in ADR-001 § Decision 1** is superseded by SweeFi's coverage state. ADR-001 itself remains unchanged (ADRs are append-only); ADR-002 is the current source of truth for "which schemes implement S8 where."
6. **`spec/allium/s8-facilitator-accountability.allium`** has its `Implements:` header corrected to point at the `@sweefi/sui` target adapters rather than the now-deleted mcp-server paths.
7. **A CI guard** is added to `typescript/test/boundary.test.ts` (or a new `test/repo-boundary.test.ts`) that fails if any file under `s402/` (outside `demo-api/` and `docs/`) imports `@mysten/sui`, `@solana/web3.js`, `ethers`, `viem`, or any other known chain-specific SDK. This is stronger than the existing `src/`-only check and prevents a future side-door.

### What s402 still provides

The protocol repo keeps everything that makes a protocol adoptable:

- The wire format (serialized HTTP 402 payment requirements and responses)
- The `s402ClientScheme`, `s402ServerScheme`, `s402FacilitatorScheme` interfaces that any chain's adapter implements
- The `verifySettlement` interface on `s402ClientScheme` (new in v0.3.0, per ADR-001 Decision 1) — chain-agnostic signature, chain-specific body lives in each adapter
- The `DIGEST_MISMATCH` error code (new in v0.3.0)
- 132 conformance test vectors any implementation must pass
- The S1-S8 invariants in `INVARIANTS.md`
- The ADR series
- The Allium behavioral specs

An adapter author in a new chain reads `typescript/src/scheme.ts` + `spec/vectors/` + `INVARIANTS.md` and knows exactly what they have to implement. They never have to read, clone, or understand SweeFi-specific code.

## Alternatives Considered

**Alt A — Keep mcp-server as a "reference implementation," just move it to `examples/`.** Rejected. The problem isn't the folder name or location — it's the `@mysten/sui` dependency. As long as any artifact in the `s402` repo imports a chain-specific SDK, a new contributor's first `grep -r '@mysten' s402/` surfaces Sui code inside the protocol repo, and the AI-drift cycle from the February 2026 S7 incident repeats. Moving the folder without removing the dependency is cosmetic; removing the dependency means rewriting `mcp-server` into something that doesn't actually run, i.e., deleting it.

**Alt B — Refactor mcp-server to be chain-abstract with pluggable chain adapters loaded at runtime.** Rejected. MCP servers need a concrete signing keypair, a concrete transaction builder, and a concrete RPC client — all chain-specific. A "chain-abstract MCP server" is either (a) a thin shell that still requires the user to install one of `@sweefi/sui`/`@sweefi/solana`/etc. as a peer dependency (in which case the shell adds no value over `@sweefi/mcp` which already does this), or (b) a dynamic loader that adds indirection for no gain. Either way, the right home is SweeFi (or future sibling implementation repos), not s402.

**Alt C — Merge s402 and sweefi into one monorepo.** Rejected. This is analogous to merging the TCP/IP spec repo with the Linux kernel repo: two different things with different release cadences, audiences, and governance models. s402 is meant to be adopted by many implementations from many authors; SweeFi is one specific Sui-native implementation that happens to be first. Coupling them makes the protocol look like "the SweeFi protocol" rather than a neutral specification — and destroys the credibility that lets third-party chain implementations adopt it.

**Alt D — Leave `mcp-server/` where it is and just stop adding to it.** Rejected — this is the drift path. New contributors read the existing folder and assume it's load-bearing; AI sessions read the existing code and extend it; the violation calcifies into convention. The only durable fix is deletion plus this decision record explaining why the deletion is not a mistake.

**Alt E — Split `mcp-server` into its own dedicated repo, `s402-mcp-server`, under the same GitHub org as s402.** Rejected. A single-product npm package in its own repo still has the same boundary confusion: `s402-mcp-server` imports `@mysten/sui`, any reader assumes the s402 project endorses a Sui-first framing, and the neutrality of the protocol is still compromised. The correct home for a Sui-specific MCP server is a Sui-specific implementation repo. SweeFi already fills that role.

## Consequences

**Positive:**

- The S7 boundary is enforceable at the repo level, not just at the package level. After deletion, `grep -r '@mysten' s402/` returns zero results (excluding historical ADR mentions). The new CI guard prevents regression.
- The two-repo structure mirrors the HTTP ecosystem pattern: one neutral spec repo, many chain-specific implementations. It makes the protocol legible to new contributors in a way a mixed repo never could.
- `@sweefi/mcp` becomes the single canonical Sui MCP server instead of one of two competing implementations. No more parallel drift, no more "which one should I install?" confusion.
- Distribution becomes cleaner: MCP registry, Claude Code, Cursor, and NPM searches all resolve to one package that is actively maintained, thoroughly tested (222 tests, 35 tools), and production-grade.
- The s402 repo becomes smaller, more focused, and cheaper to audit. An auditor reading `s402/` sees only the protocol — not a mixed bag of protocol + reference + product.
- Future chain implementations (EVM, Solana, Cosmos) have an unambiguous pattern to follow: "write your own `@yourprotocol/chain` package, consume s402 from npm, implement the three interfaces, pass the conformance vectors." No ambiguity about "should we add our adapter to the s402 repo?"

**Negative:**

- We lose the "clone s402 and run the MCP server in one command" one-click demo path. Replaced by `pnpm add @sweefi/mcp` (or whatever install flow SweeFi documents), which is arguably better for real users but less convenient for read-only exploration.
- Git history for `mcp-server/` becomes archival-only. Future reads of old commits (e.g., `3a96c9d`) will find files that no longer exist at HEAD. Mitigation: the deletion commit message explicitly references this ADR.
- External contributors who fork `s402` expecting to find a runnable example will need to be pointed at SweeFi or `demo-api/`. The README update handles this.
- The published `s402-mcp@0.1.1` npm package becomes a deprecated island. Existing installations continue to work but receive no updates. The `npm deprecate` notice handles communication; no migration path is planned for existing users (they install `@sweefi/mcp` manually).

**Risks & watch-fors:**

- **SweeFi must stay in sync with s402 protocol changes.** When s402 adds a new scheme, interface method, or required field, SweeFi's adapters must implement it before their next release. Mitigation: SweeFi's CI runs the s402 conformance vectors against its adapters (`pnpm test` reads `spec/vectors/` from the installed `s402` package). If SweeFi falls behind a protocol change, its CI fails loudly.
- **Phantom `mcp-server/` in old branches.** Any in-flight branches or forks that still contain the folder will need rebasing. Mitigation: merge or close open branches before the deletion commit lands. At the time of this ADR, there are no open branches on `main` referencing `mcp-server/`.
- **Other future chain implementations need the same discipline.** The next chain that joins s402 must be onboarded against this ADR explicitly so they don't ship a `s402/evm-mcp/` or `s402/solana-mcp/` folder. Mitigation: CONTRIBUTING.md will link this ADR under "How to add a new chain implementation."
- **The `npm deprecate` notice can be missed.** Users installing `s402-mcp` via a lock file pin will not see the notice. Mitigation: the deletion commit also updates the `s402-mcp@0.1.1` `README.md` with a "MOVED" banner (a final published version `0.1.2` that is effectively a redirect). This is a manual post-deletion republish step.
- **Cross-repo conformance tests do not yet exist.** SweeFi's CI does not currently run s402 conformance vectors. This ADR creates the need; a follow-up must actually wire it up in SweeFi.

## Follow-ups

- [ ] **This session:** Delete `s402/mcp-server/` in a commit referencing this ADR
- [ ] **This session:** Update `spec/allium/s8-facilitator-accountability.allium` `Implements:` header to point at SweeFi's planned `packages/sui/src/s402/*/client.ts` paths
- [ ] **This session:** Add the "grep sibling repos before implementing" lesson to `s402/AGENTS.md`
- [ ] **This session:** Mirror the same rule to `sweefi/AGENTS.md`
- [ ] **This session:** Prepare `s402@0.3.0` CHANGELOG entry + `pnpm publish --dry-run` gauntlet
- [ ] **Manual (Danny):** `pnpm publish` from `s402/typescript/` to ship v0.3.0
- [ ] **Manual (Danny):** `npm deprecate s402-mcp "..."` and optionally publish a final `s402-mcp@0.1.2` with a MOVED banner
- [x] **Next session (SweeFi):** Back-port `verifySettlement` into all five scheme client classes in `sweefi/packages/sui/src/s402/*/client.ts`. Bump `s402` dep from `^0.2.0` to `^0.3.0`. Done 2026-04-11.
- [x] **Next session (SweeFi):** File `sweefi/docs/adr/010-facilitator-causal-binding.md` mirroring S8 in SweeFi's ADR style, referencing this ADR and s402 ADR-001 as the source. Done 2026-04-11.
- [ ] **Next session (SweeFi):** Wire s402 conformance test vectors into SweeFi CI so protocol changes are caught automatically
- [ ] **Follow-up:** Add repo-level CI guard — fail if any file under `s402/` (outside `demo-api/` and `docs/`) imports a chain-specific SDK
- [ ] **Follow-up:** Update `s402/README.md` with a "Reference implementations" section linking SweeFi
- [ ] **Follow-up:** Update `s402/CONTRIBUTING.md` with a "How to add a new chain implementation" section linking this ADR
- [ ] **Follow-up:** Update `s402-protocol.org` documentation site with a "Sui implementation" page that points at SweeFi rather than walking the reader through `mcp-server/`
