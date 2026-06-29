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
