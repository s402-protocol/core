# LESSONS — s402

Append-only failure log. Every recurring mistake gets encoded here (or stronger:
a lint/test) so the next agent never repeats it. Read after `AGENTS.md` +
`CHANGELOG.md`. See the DannyOS LESSONS.md convention in `.claude/CLAUDE.md`.

---

## [2026-06-28] — A code generator that CI never runs rots silently

**Mistake:** `test/conformance/generate-vectors.ts` imported `../../src/compat.js`, but that file was moved to `src/compat/x402.js` during the 0.7.0 compat reorg. The generator had been broken (unrunnable — `ERR_MODULE_NOT_FOUND`) ever since, and nobody noticed for two releases.

**Why it happened:** the reorg updated `src/` and `test/` importers, but the generator is a **script that nothing in CI executes** — only the conformance *runner* (`conformance.test.ts`) runs, and it reads the already-*committed* JSON vectors, never regenerating them. So a broken generator produces no red CI. The path move was caught everywhere it was *exercised*, and missed in the one place it wasn't.

**Fix:** corrected the import to `../../src/compat/x402.js`. Verified the fix by regenerating: existing vectors came back byte-for-byte identical (no committed drift), confirming the generator is sound again. (Encoded as this LESSONS entry; a stronger encoding — a CI test that runs the generator and asserts `git diff --exit-code spec/vectors/` — is a tracked follow-up so the generator can never silently rot again.)

**For future agents:** when you move or rename a module, grep **every** importer including `scripts/`, `test/**` tooling, and generators — not just `src/` — because anything CI doesn't execute won't tell you it broke; and treat "we have a code generator" as a CI obligation (run it, assert no diff), not just a dev convenience.

---

## [2026-06-28] — Indexing a plain object with an untrusted string key walks the prototype chain

**Mistake:** Trust-boundary code looked up an attacker-controlled string in a plain object literal — `A2A_STATUS_ENUM[raw]` (`transport.ts`) and `S402_PAYLOAD_INNER_KEYS[scheme]` (`http.ts`). For `raw='constructor'`/`'__proto__'`/`'toString'` these return an *inherited* member (the `Object` constructor, a function) instead of `undefined`. The A2A one returned a function where a `PaymentStatus` string was typed (and survived `?? fallback`, since the inherited member is truthy); the http one threw a raw `TypeError` (`for...of` on a non-iterable) instead of a typed `s402Error`. Caught in the pre-publish adversarial review, not by tests.

**Why it happened:** `obj[key]` in JS reads through the prototype chain, and TypeScript's `Record<string, T>` index signature *types the result as `T`* (no `| undefined`), so the type checker gives false confidence that the lookup is safe. The `?? fallback` idiom only catches `null`/`undefined`, not inherited-but-truthy members. The bug is invisible until someone feeds a prototype key — and no test did.

**Fix:** `Object.prototype.hasOwnProperty.call(map, key)` guards before indexing (both sites), plus regression tests in `test/security-hardening.test.ts` that feed `constructor`/`__proto__`/`toString`/`valueOf`/`hasOwnProperty` to every such lookup.

**For future agents:** never index a plain object with an untrusted key at a trust boundary — use `Object.prototype.hasOwnProperty.call(map, key)`, a `Map`, or `Object.create(null)`. Treat `Record<string, T>` indexing as `T | undefined` regardless of what TS says, and when you add a lookup keyed by decoded/network input, add a prototype-key test (`constructor`, `__proto__`) alongside the happy path.

---

## [2026-07-18] — A linter that filters transformed output can be dead code that never filters anything

**Mistake:** CI's S7 boundary check "stripped comments" with `grep -v "^\s*//"` (and `^\s*\*`, `^\s*/\*`) — but its input was `grep -rn` output, where every line starts with `file:line:`, so the `^`-anchored patterns could never match anything. The stripper was dead code since birth; the check's *real* behavior was "zero textual mentions in src/". The first-ever mentions (a JSDoc line **about** the no-imports rule in `transport.ts`, and an example coin type in `compat/mpp.ts`) failed CI on main at v0.8.0.

**Why it happened:** the filter was written against a mental model of raw source lines, but the pipeline feeds prefixed grep output — and until v0.8.0 there were zero mentions of any kind in `src/`, so the broken and intended semantics agreed. A green check that has never fired on a positive validates nothing.

**Fix:** patterns re-anchored after the `:line:` prefix in `ci.yml`; both doc mentions reworded anyway (defense in depth — the strict reading was fine prose too).

**For future agents:** when you write a filter over tool output, test it against a KNOWN-POSITIVE — one line that must be stripped and one that must survive — before trusting green. A linter that has never caught anything is unverified, not passing.

---

## [2026-07-18] — npm E404 on a publish PUT means auth failure, not "package missing"

**Mistake:** the Release npm job died with `404 Not Found - PUT https://registry.npmjs.org/s402 — 's402@0.8.0' is not in this registry`, which reads like a registry or package-name problem. The actual cause: the `NPM_TOKEN` repository secret is expired/revoked — npm deliberately answers unauthorized publish PUTs with 404 (not 401/403) to avoid leaking package existence. The same dead token had already shown up as a local 401 on `npm whoami` (2026-07-07).

**Why it happened:** npm's obfuscated status code, plus a long-lived secret nothing monitors — tokens rot silently, and the workflow only exercises this one at release time, the worst possible moment to find out.

**Fix:** idempotency guard added to the npm job (the manual interactive-2FA ritual and the tag workflow can no longer race — v0.8.0's manual publish beat CI by 5 seconds); PyPI split onto `py-v*` tags (v0.8.0 tag failed against pyproject 0.1.0). Durable fix queued in READY-QUEUE: npm **Trusted Publisher** (OIDC) for `s402`, same pattern as `pinia-colada-plugin-normalizer` — no token, no rot, provenance attested.

**For future agents:** on npm publish failures, treat E404-on-PUT as *authentication* first. And treat any long-lived registry token in CI as a rot liability — prefer OIDC trusted publishing; failing that, add a scheduled `npm whoami` canary so token death is discovered before release day.
