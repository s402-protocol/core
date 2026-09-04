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

---

## [2026-08-16] — A guard that is red on a clean checkout is the guard getting deleted, not enforced

**Mistake:** while fixing DAN-860 I added `scripts/check-vector-sync.sh` plus a CI job asserting that `spec/vectors/` and `typescript/test/conformance/vectors/` stay identical. It passed locally three ways — healthy `0`, planted drift `1`, missing-dir `2` — and then failed on the very first CI run with `published dir missing`. `typescript/test/conformance/vectors/` is **gitignored build output**: `typescript/scripts/prepare-publish.sh` copies `spec/vectors/*.json` into it during `prepublishOnly`. A clean checkout correctly does not have it, so the check would have been red on every commit forever.

**Why it happened:** I inferred the relationship between the two directories from their *contents* — byte-identical across all 14 files — and wrote "kept in sync by discipline" into an ADR, a PR body, and a Linear comment before reading `.gitignore` or `package.json`'s `files` array. Identical bytes are equally consistent with "two hand-maintained copies" and "one is generated from the other," and only the second is true. DAN-860's own criterion 4 made the same inference in the other direction, calling it a "stale duplicate ... a trap with no upside" — it is neither stale nor a duplicate, and deleting it would strip the conformance vectors from the published npm package.

**Fix:** the script and the CI job were removed before merge; `ci.yml` is byte-identical to `main`. The accurate account of both directories is in ADR-012's Consequences. The genuinely uncovered gap — `spec/vectors/` is itself generated by `test/conformance/generate-vectors.ts` from the live `encode`/`decode` functions, and nothing asserts the tracked vectors still match what the code produces — is recorded there too, and deliberately *not* built, because `tsx` is not an installed dependency and the check could not be watched green.

**For future agents:** before adding any gate, run it against a **fresh clone**, not your working tree — your tree contains generated artifacts, local caches and untracked files that CI will not have, and those are exactly what a naive gate keys on. Two more rules earned here: identical file contents tell you *what* is true, never *why*, so read `.gitignore` and the packaging manifest before concluding two directories are peers; and ship no gate you have not watched go green in the environment that will run it — an unverified gate is worse than an absent one, because its red is indistinguishable from a real defect and the cheapest way to make it stop is to delete it.

---

## [2026-08-31] — A whitelist at a struct boundary is where a new spec parameter goes missing, and nothing errors

**Mistake:** mpp-specs #328 added a `header` auth-param to the Payment challenge on 2026-08-25, selecting `Payment-Authorization` for the credential instead of `Authorization`. `parseAuthParams` in `compat/mpp.ts` preserved it faithfully — the function's own doc comment says unknown params are kept so callers can ignore them per §5.1.2. Then `parseWwwAuthenticatePayment` returned an explicit nine-field object literal, and `header` died there. The same nine-field whitelist existed a second time in `decodeMppCredential`. Neither parse failed. Nothing logged. s402 would have handed a caller a credential bound for `Authorization` on a challenge that selected a different field — which the spec does not call a mismatch, it calls it a `MUST NOT`.

**Why it happened:** the two halves of the parser have opposite defaults, and only one of them is visible when you read the function that matters. `parseAuthParams` is permissive by design and says so. The struct literal below it is restrictive by design and says nothing — a field list reads as a description of the type, not as a filter with a policy. So the layer that *documents* its treatment of unknown parameters is not the layer that *decides* it.

**Fix:** `header` added to `MppChallenge`, `MppCredential.challenge` and `ToMppChargeInput`, with a value the spec forbids now throwing rather than being silently carried; `mppCredentialHeaderName()` added so a caller can ask which field a challenge selected instead of assuming; a comment sits on the return literal naming it as the trust boundary it is. Eight tests in `test/compat-mpp.test.ts`, each watched failing first.

**For future agents:** when a parser separates *reading* from *keeping*, the keeping step is the trust boundary and it needs the comment, not the reading step. A hand-written field list in a return statement is a policy about the future — every parameter the spec adds after you wrote it is dropped, at no cost to any test, until someone reads the upstream diff. If you touch one of these, ask what upstream has added since it was written, and prefer a check that fails loudly on an unrecognized value over one that quietly discards it.

---

## [2026-08-31] — "Compatible with x402" has two readings, and only one of them is a bug fix

**Mistake:** none shipped, but the near-miss is worth the entry. x402 added `settlement_pending`, a non-terminal settle outcome. Reading it as a failure is the retry that pays twice, so "make s402 compatible" reads as an obvious bug fix — right up to the point where you notice the natural place to put the fix is `s402SettleResponse`, which is s402's own wire format and governed by ADR-007. The fix and the protocol change look like the same task from inside the work.

**Why it happened:** compatibility is stated as a property of a system, and a system has two ends. Understanding what a peer says on intake and saying it yourself on emission are different obligations, and only the first is implied by "be compatible." The one-word overload is what makes the slide invisible.

**Fix:** ADR-013 states the boundary and states it as an absence — nothing in `compat/` may collapse a pending onto `success: false`. There is deliberately no `toS402SettleResponse()` counterpart to the intake classifier, and the reason is documented in the code at the place someone would go looking for it.

**For future agents:** when a task says "be compatible with X", split it into *what must we understand* and *what must we say* before writing anything. The second half is almost always a wire-format decision that belongs to whoever owns the format. If you find you cannot do the first without the second, that is a finding to write up, not a call to make.

---

## [2026-09-04] — A compatibility sentence with no test was false for five months

**Mistake:** the README, the API docs, the migration guide and a comment in `gate.ts` all said an x402 client could pay an s402 server "with zero modifications" / "out of the box." No test executed the sentence. The first one that did — the unmodified upstream `@x402/fetch` against `s402Gate` — failed on the first leg: the client could not read s402's 402 at all, and its V2 payment header would have been ignored on the second. The sentence was true only of x402 **V1** payload intake, which is not what the current upstream client sends.

**Why it happened:** "wire-compatible" was asserted from shared header *names* and a shared `exact` payload shape, and never from a round trip. Compatibility is a property of a conversation, not of a schema — three legs, each a boundary, and a claim about the whole conversation needs the whole conversation run. The claim also aged silently: x402 V2 renamed the client→server header and restructured the payload after the sentence was written, and nothing in the repo could notice.

**Fix:** `test/interop-x402-client.test.ts` runs the real upstream client end to end (the strongest available encoding — it fails the day upstream drifts). `X402_UPSTREAM_PIN` dates the claim in code. The prose everywhere now says what the test proves: zero client changes, one server option. ADR-015 records why the 402 half is opt-in.

**For future agents:** any sentence of the form "X works with Y unmodified" is a test, not a fact, until a real X is run against a real Y in CI — install the real X as a pinned devDependency and drive it; never re-implement X's client to prove X's client works. And put a sha next to every compatibility claim, because a claim without a date cannot be found stale.

---

## [2026-09-04] — A type's "do not touch" list and its dependency graph are different documents

**Mistake:** DAN-1078's packet named `envelope.ts`, `compat/mpp.ts` and `compat/l402.ts` as
DO-NOT-TOUCH (another ticket was editing `mpp.ts`), and in the same breath required removing
`accepts` from `s402PaymentRequirements`. All three read or construct that field. The two
instructions could not both be obeyed: with the field gone the package does not compile, so
"do not touch" would have meant "do not ship." Four lines in three protected files had to change
(`accepts: ['exact']` → `scheme: 'exact'` twice, and one `accepts.includes()` cross-check).

**Why it happened:** the exclusion list was written from *authorship* — who else is editing what —
and the change was scoped from the *wire format*. Neither view shows the compile graph. A field on
a widely-shared type is not a local edit no matter how small its diff, and `grep -rn '\.accepts'`
would have surfaced the conflict in one command before the ticket was cut.

**Fix:** the four lines were changed, and each is called out in the delivery report as a
conflict-risk hunk for whoever holds the concurrent `mpp.ts` ticket. This entry.

**For future agents:** before accepting a DO-NOT-TOUCH list on a task that removes or renames a
field on a shared type, grep for every consumer of that field and compare the two sets. If they
intersect, say so before writing code — the intersection is either a packet defect or a hidden
second ticket, and finding out at the typecheck is the expensive way.

---

## [2026-09-04] — A trust-boundary whitelist inside someone else's extension bag is a rejection you do not own

**Mistake:** wire v2 moved s402's per-requirement fields into each `accepts[]` entry's `extra`, and
the sub-object validator was carried down with them unchanged — including its `mandate` check. But
`mandate` had moved the *other* way, up to `extensions.s402`. The result: a foreign x402 402
carrying an unrelated `extra.mandate` key was rejected outright with
`mandate.required must be a boolean`, for a key at an address s402 does not own. An otherwise
payable 402 would have failed on a name collision.

**Why it happened:** two fields moved in the same change, in opposite directions, and the validator
list was copied rather than re-derived. The file argues two comments above that `extra` is x402's
bag and open by spec; the validator immediately below it disagreed, and nothing made them meet.

**Fix:** `mandate` removed from `validateSubObjects`, with a comment at the deletion saying why the
absence is deliberate; two regression tests in `test/http.test.ts` — a foreign `extra.mandate`
passes through untouched, and the mandate that IS ours still fails validation at
`extensions.s402.mandate`.

**For future agents:** validation belongs at the address that owns the key. When you move a field
between levels, move its validator with it and re-derive the list at the destination — a carried-over
whitelist inside a bag defined by someone else's spec turns their forward compatibility into your
rejection.
