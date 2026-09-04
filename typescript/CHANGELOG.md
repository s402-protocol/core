# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A payment payload may carry `network`, naming which `accepts[]` entry it answers, and every
  decoder now keeps it. Since wire v2 a 402 can offer the same scheme on several networks, so the
  scheme name alone cannot identify the offer — and the specification had told decoders to strip
  the field, which made a conformant peer or proxy hand the gate a payment it had to refuse as
  ambiguous. Specification §5.1 and §10.2, the Python decoder, and a new conformance vector now
  agree with what the TypeScript client already sent.

### Fixed

- The MCP and A2A carriers hold an outgoing 402 to the same schema the HTTP encoders do. They
  projected the document and skipped the check, so a 402 with a non-CAIP-2 network or an empty
  `resource.url` encoded cleanly on either carrier and was then refused by that carrier's own
  decoder.

### Changed

- **BREAKING (npm major, s402 wire v2): the `payment-required` header now carries an x402 V2
  `PaymentRequired` envelope on every route.** An unmodified x402 client (`@x402/fetch`,
  `x402Client` 2.25.0) pays an `s402Gate` with **zero client changes and zero server options** —
  the sentence the README has made since April, now with nothing to qualify it. The 402 looks like
  this on the wire:

  ```json
  {
    "x402Version": 2,
    "resource": { "url": "https://api.example.com/paid" },
    "accepts": [
      { "scheme": "exact", "network": "sui:mainnet", "asset": "0x2::sui::SUI",
        "amount": "1000000", "payTo": "0x…", "maxTimeoutSeconds": 60,
        "extra": { "facilitatorUrl": "https://…", "expiresAt": 1700000000000 } }
    ],
    "extensions": { "s402": { "version": "2" } }
  }
  ```

  What moved where, and why it is where it is:
  - **One `accepts[]` entry per offered scheme**, each a complete requirement — its own network,
    asset, amount and price. One 402 can now offer `exact` on Sui and `exact` on Base, which the
    old shape could not say at all. `exact` is listed first whenever it is offered, because an
    x402 client pays the first entry it has a handler for.
  - **s402's per-requirement fields ride in that entry's `extra`** — `facilitatorUrl`,
    `expiresAt`, the fee fields, `receiptRequired`, `settlementMode`, `settlementOverrides`, the
    per-scheme extras and the per-requirement `extensions` bag — keyed exactly as before. In
    memory they still sit at the top level of `s402PaymentRequirements`; the codec does the
    projection, so scheme and facilitator code reads what it always read.
  - **s402's envelope-level fields ride in `extensions.s402`** — `{ version: '2', mandate? }`.
    The *presence* of that key is what makes a 402 an s402-profile 402. `detectProtocol()` reads
    it instead of `s402Version`.
  - **A plain x402 402 with no `extensions.s402` decodes and is payable.** Unknown scheme names
    are skipped by the client, never refused by the decoder, and unknown keys inside an entry's
    `extra` are preserved — that bag is x402's and open by its own spec.

  Decision and reasoning: `docs/adr/016-s402-402-is-an-x402-envelope.md`.

- **`s402PaymentRequirements` is now one offer, not a list.** `accepts: s402Scheme[]` is replaced
  by `scheme: s402SchemeName`, and the new `s402PaymentRequired` is the document that holds the
  list. Everything that consumes a single requirement — client schemes, server schemes, the
  facilitator — is unchanged in shape.
- **`resource` is a required `s402Gate` option**, and `requirements` may now be one offer or an
  array of them. x402's envelope requires a `ResourceInfo`; this is that field, not an interop
  switch. `.check()` additionally returns `required` (the whole document) alongside the single
  offer the payment matched.
- **`decodePaymentRequired`, `decodeRequirementsBody`, `extractRequirementsFromResponse` and
  `normalizeRequirements` return `s402PaymentRequired`**; `encodePaymentRequired` and
  `encodeRequirementsBody` take it. `validateRequirementsShape` and `pickRequirementsFields`
  operate on the wire envelope, and their error messages name the entry (`accepts[0]: …`).
- **`s402Client.createPayment()` accepts the whole 402 document** and pays the first `accepts[]`
  entry it has a registered scheme for on that entry's network. A single offer still works.
- **`s402ResourceServer.buildRequirements()` returns one entry**; the new
  `buildPaymentRequired(config, resource)` returns the envelope, with one entry per scheme,
  `exact` first, and the mandate hoisted. The old "always include `exact` in `accepts`" invariant
  lives there now.
- **`toX402V2Requirements` / `toX402V2Envelope` are projections, not translations**, and no longer
  throw for non-`exact` schemes — every s402 scheme is expressible on an x402 envelope now.
  `toX402V2Envelope` accepts an array of offers.
- **MCP `_meta` and A2A `metadata` carry the same wire envelope the header does**, through one
  shared projection rather than three.
- The conformance vectors were regenerated against the envelope: 195 vectors across 14 files
  (`requirements-encode` 23, `requirements-decode` 28, `validation-reject` 59,
  `compat-normalize` 14).

- **A 402 is checked against x402's own schema before it is published.** Both encoders now refuse
  to emit a document the pinned `@x402/core` cannot parse, so a route that would have served an
  unreadable 402 fails at the gate instead. Newly refused: an empty or missing `resource.url`, a
  `network` that is not CAIP-2, a `maxTimeoutSeconds` of zero, an empty `asset`, a `serviceName`
  over 32 printable-ASCII characters, more than five `tags`, and an `iconUrl` over 2048
  characters. The same bounds apply on decode, except `resource.url`, which a peer may leave
  empty and which only emission requires. A 402 lifted out of a retired flat shape may carry a
  non-CAIP-2 network — those shapes predate the rule — and can be read but not re-emitted.
- **`s402Gate` requires an `exact` offer on every route**, checked when the gate is built (or when
  a `requirements` function runs). On the retired wire the builder added `exact` unconditionally;
  without this a hand-built offer list produced a 402 no unmodified x402 client can pay.
- **A payment payload may carry `network`**, naming the `accepts[]` entry it pays;
  `s402Client.createPayment` fills it in. The field is optional and existing payloads are
  unaffected. A route offering `exact` on two networks — the configuration the upgrade guide
  recommends — could not otherwise be paid by a native client at all.

### Added

- **`fromS402V1Requirements()`** in `s402/compat/x402` reads s402's OWN retired flat 402 —
  `{ s402Version: '1', accepts: ['exact', 'prepaid'], … }` — and expands it to one `accepts[]`
  entry per scheme with `exact` hoisted first. Understanding what a peer said is an obligation;
  saying it is not (ADR-013). Nothing emits v1.
- `normalizeRequirements()` gained one behavior it did not have: when a document carries no
  `extensions.s402` — a 402 from a server that has never heard of s402 — an entry with no
  `expiresAt` gets one derived from its `maxTimeoutSeconds`. Without it, inbound x402 traffic
  bypassed every S1 stale-payment guard, because those guards skip an undefined `expiresAt`.
  s402's own documents are never touched.
- `s402PaymentRequired`, `s402ResourceInfo`, `s402SchemeName`, `S402_WIRE_VERSION`,
  `S402_DEFAULT_MAX_TIMEOUT_SECONDS` and `toRequirementsWire` are exported.
- Conformance vectors for the cases wire v2 makes possible: two networks on one 402, an x402
  scheme s402 does not implement, foreign `extra` keys surviving a round trip, and a plain x402
  V2 402 decoding into something payable.

- **An unmodified x402 client can now pay an `s402Gate`, and there is a test that proves it against
  the real upstream packages.** `test/interop-x402-client.test.ts` runs `@x402/fetch`'s
  `wrapFetchWithPayment` over an `x402Client` (2.25.0, the version published from x402 @
  `2cc7e9a6`) against the gate in-process and asserts paid content, one handler run, and a receipt
  upstream's own decoder reads. Three pieces made it pass:
  - The 402 is emitted as an x402 V2 `PaymentRequired` envelope (header and body). This shipped
    first as an opt-in `x402: { resource }` gate option; **wire v2, above, made it the only 402
    grammar and removed the option before either was released.**
  - The gate reads x402 V2's `PAYMENT-SIGNATURE` and V1's `X-PAYMENT` unconditionally, through
    `fromX402PayloadHeaders`, and remembers which dialect the payment arrived in (`dialect` on the
    `.check()` result).
  - An x402-dialect payment gets an x402-shaped receipt: `toX402SettleResponse` maps `txDigest` →
    `transaction`, adds `network`, and keeps s402's fields alongside. Native payments get exactly
    what they got before.
- **`X402_UPSTREAM_PIN`** in `s402/compat/x402` names the x402 repo, sha, date and npm version this
  layer was audited against. "Compatible with x402" now carries a date. Note the repo: development
  moved to `x402-foundation/x402`; `coinbase/x402` is frozen at `dd927a26`.
- `x402PayloadDialect`, `toX402SettleResponse`, `encodeX402SettleResponse`, `encodeX402V2Envelope`
  exported from `s402/compat/x402`; `@x402/core` and `@x402/fetch` added as pinned
  devDependencies (test-only; zero runtime dependencies unchanged).
- **One demo you can run in sixty seconds, with no wallet, no keys and no network** — `pnpm demo`.
  It encodes a 402 into a single HTTP header, decodes it from the client side, absorbs an x402 V1
  payment body through the compat layer, and runs the 167 published conformance vectors against
  the code in your clone. Source: `typescript/examples/quickstart.mjs`.
  The demo reports **how many malformed headers were refused *and how many leaked through***,
  because a suite that only ever watches things pass cannot distinguish a working validator from
  one that returns `true` unconditionally. That counter was itself verified by poisoning a vector
  and confirming the run turns red and exits non-zero.
- **A README that says what is true today, and how to check it.** Two new sections: *What Is True
  Today* (shipped / published / partial / not-runnable, per component) and *Receipts* (a command
  for every claim the README makes about itself).
- **`demo-api/` is reachable again.** It was absent from `pnpm-workspace.yaml`, had no README, and
  depended on a published `s402@^0.6.0` while this repo ships `0.9.0` — so it was neither wired to
  the workspace nor documented anywhere. It is now a workspace package on `workspace:*`, it
  typechecks against the current source, and it has a README with the verified route (`/api/joke`,
  not `/api/data`), the decoded 402 body, and an explicit statement that its facilitator is a mock
  that settles nothing.
- **`settlement_pending` is understood on intake, and it is never read as a failure.** x402 #3083
  specified a non-terminal settle outcome — the transaction was broadcast, the wait for its
  confirmation failed — and upstream now ships it in the reference resource server. Reading it as
  a failure is the retry that pays twice, which is why upstream's own server re-settles the *same*
  broadcast rather than building a new payload. `fromX402SettleResponse()` and
  `fromX402SettleResponseHeaders()` classify an x402 settle result as `settled | pending | failed`
  and mark both `settled` and `pending` as not retryable — the same answer for different reasons:
  one has been paid, the other may have been. `pending` survives even when the transaction hash is
  missing, which x402 forbids; a server violating its own spec leaves us unable to *name* the
  transaction, which is not the same as it not existing.

- **The `exact` scheme's payment flow is readable.** x402 #3240 / #3267 gave `exact` an `upfront`
  flow (settle → resource → respond) signalled by `accepts[].extra.paymentFlow`. `exact` is the
  only scheme s402 accepts inbound, so the scheme the entire interop claim rests on acquired a
  second mode — and the intake type had no `extra` field at all, so the mode was not merely unread
  but unreadable. `extra` is now on the intake type and `x402PaymentFlowOf()` reports the flow,
  with an absent value meaning `authorization` because that is what the spec says absence means. An
  unrecognized flow throws rather than defaulting: the guess a client wants least is the one that
  says "you have not been charged." Emission is unchanged and was already correct.

- **ADR-013 records where compatibility stops.** Understanding what x402 says on intake and saying
  it on s402's own wire are different decisions, and the second belongs to ADR-007. The record
  states the boundary as an absence — nothing in `compat/` may collapse a pending onto
  `success: false` — and notes that ADR-007 already defines `s402EnvelopePending` while `gate.ts`
  still emits the legacy flat shape, so the emission question is half-answered rather than
  unexamined. `s402SettleResponse` is untouched.

- **21 new tests** across `test/compat-mpp.test.ts` (8, alternate credential header) and
  `test/compat-x402-settlement.test.ts` (13, settlement classification and payment flow). Every one
  was watched failing before the code that makes it pass was written.

- **Every ADR now records whether it was actually built.** All twelve carry an `Implementation:`
  field (`shipped` · `in-progress` · `not-started` · `upheld`), each determined against the code
  rather than the prose. `Status: Accepted` only ever meant *decided* — so a decision that shipped
  and one that was ratified and quietly never built were indistinguishable on the page. The
  conceived-to-shipped ratio is now countable: **7 of 12 shipped.** Two findings fell straight out
  of the exercise: ADR-004's extensions framework ships as the `s402/extensions` subpath while its
  `Status` still reads *Proposed*, and ADR-010's S16 turns out to be half-built — version binding
  is enforced in the envelope, its scheme-digest half blocked on ADR-006.
- **A regression test that fails when a documented vector count drifts from reality**
  (`test/spec-doc-counts.test.ts`). It counts `spec/vectors/` and compares against every
  `"<N> vectors across <M> files"` claim in `README.md` and `docs/specification.md`, and it
  refuses to pass vacuously: if the wording changes so no claim is found, the test fails rather
  than silently verifying nothing. Counts written into prose are derived values maintained by
  hand, and three independent wrong numbers in one repo is what that looks like after a while.
- **The README now says who s402 is for and who it is not for.** Deciding whether s402 fits
  was previously left to the reader to infer from feature tables; it now says plainly that
  EVM-only users wanting `exact` should use x402, and that s402 is a wire format rather than a
  payments product.

- **`settlement_pending` is understood on intake, and it is never read as a failure.** x402 #3083
  specified a non-terminal settle outcome — the transaction was broadcast, the wait for its
  confirmation failed — and upstream now ships it in the reference resource server. Reading it as
  a failure is the retry that pays twice, which is why upstream's own server re-settles the *same*
  broadcast rather than building a new payload. `fromX402SettleResponse()` and
  `fromX402SettleResponseHeaders()` classify an x402 settle result as `settled | pending | failed`
  and mark both `settled` and `pending` as not retryable — the same answer for different reasons:
  one has been paid, the other may have been. `pending` survives even when the transaction hash is
  missing, which x402 forbids; a server violating its own spec leaves us unable to *name* the
  transaction, which is not the same as it not existing.

- **The `exact` scheme's payment flow is readable.** x402 #3240 / #3267 gave `exact` an `upfront`
  flow (settle → resource → respond) signalled by `accepts[].extra.paymentFlow`. `exact` is the
  only scheme s402 accepts inbound, so the scheme the entire interop claim rests on acquired a
  second mode — and the intake type had no `extra` field at all, so the mode was not merely unread
  but unreadable. `extra` is now on the intake type and `x402PaymentFlowOf()` reports the flow,
  with an absent value meaning `authorization` because that is what the spec says absence means. An
  unrecognized flow throws rather than defaulting: the guess a client wants least is the one that
  says "you have not been charged." Emission is unchanged and was already correct.

- **ADR-013 records where compatibility stops.** Understanding what x402 says on intake and saying
  it on s402's own wire are different decisions, and the second belongs to ADR-007. The record
  states the boundary as an absence — nothing in `compat/` may collapse a pending onto
  `success: false` — and notes that ADR-007 already defines `s402EnvelopePending` while `gate.ts`
  still emits the legacy flat shape, so the emission question is half-answered rather than
  unexamined. `s402SettleResponse` is untouched.

- **21 new tests** across `test/compat-mpp.test.ts` (8, alternate credential header) and
  `test/compat-x402-settlement.test.ts` (13, settlement classification and payment flow). Every one
  was watched failing before the code that makes it pass was written.

- **Every ADR now records whether it was actually built.** All twelve carry an `Implementation:`
  field (`shipped` · `in-progress` · `not-started` · `upheld`), each determined against the code
  rather than the prose. `Status: Accepted` only ever meant *decided* — so a decision that shipped
  and one that was ratified and quietly never built were indistinguishable on the page. The
  conceived-to-shipped ratio is now countable: **7 of 12 shipped.** Two findings fell straight out
  of the exercise: ADR-004's extensions framework ships as the `s402/extensions` subpath while its
  `Status` still reads *Proposed*, and ADR-010's S16 turns out to be half-built — version binding
  is enforced in the envelope, its scheme-digest half blocked on ADR-006.
- **A regression test that fails when a documented vector count drifts from reality**
  (`test/spec-doc-counts.test.ts`). It counts `spec/vectors/` and compares against every
  `"<N> vectors across <M> files"` claim in `README.md` and `docs/specification.md`, and it
  refuses to pass vacuously: if the wording changes so no claim is found, the test fails rather
  than silently verifying nothing. Counts written into prose are derived values maintained by
  hand, and three independent wrong numbers in one repo is what that looks like after a while.
- **The README now says who s402 is for and who it is not for.** Deciding whether s402 fits
  was previously left to the reader to infer from feature tables; it now says plainly that
  EVM-only users wanting `exact` should use x402, and that s402 is a wire format rather than a
  payments product.

### Removed

- **The `x402` gate option is gone.** It selected between two 402 grammars; there is one now, so
  the choice it offered no longer exists. Replace `x402: { resource }` with `resource`. Its
  `maxTimeoutSeconds` and `extra` move onto the requirement itself; its `extensions` becomes the
  gate's `extensions`.
- **`s402ServiceEntry.accepts` is renamed `schemes`.** It was a list of scheme NAMES sitting one
  type away from an `accepts` that now means a list of requirement OBJECTS — the exact ambiguity
  ADR-016 removed from the header. Its sibling `s402Discovery` already called it `schemes`.
- **The flat 402 shape is gone from the wire and from the types**: no `s402Version` on a 402, no
  `accepts` of scheme-name strings, no `mandate` or `extensions` at the top level of a requirement.
  `s402Version` is unchanged on payment payloads and settlement responses — those legs did not move.

### Fixed

- **A payment could be settled against an offer it did not make.** When a 402 offered several
  entries, the gate matched the payment on its scheme NAME and fell back to the first entry when
  nothing matched — so a client paying the $5 offer on a route that also lists a $1 one was
  charged against whichever was listed first, and a payment naming a price nobody offered was
  charged anyway. An x402 V2 payment carries `accepted`, the full requirement the client chose;
  the gate now matches on all five economic fields (scheme, network, asset, amount, payTo) and
  **refuses** when nothing matches instead of falling back. A native payment names the network it
  paid on (see the `network` field below), and is refused as ambiguous only when two offers that
  are genuinely different contracts remain.
- **`s402ResourceServer.buildRequirements()` silently dropped `config.mandate`.** Every route that
  configured an AP2 mandate emitted a 402 with no mandate on it and nothing said so. `mandate` is
  a field on the requirement again — that is where a facilitator and a scheme implementation read
  it, since both are handed one offer and never see the envelope. On the wire it still travels
  once, at `extensions.s402.mandate`, and the encoder now refuses two entries that disagree about
  it rather than publishing one of the two answers.
- **A plain x402 402 decoded through `decodePaymentRequired` had no expiry.** The derivation of
  `expiresAt` from `maxTimeoutSeconds` — the thing that keeps S1 stale-payment rejection working
  for a peer that has never heard of s402 — lived only in `normalizeRequirements`, while the docs
  named `decodePaymentRequired` as the path for exactly those 402s. It now runs on every decode
  path from one shared helper. `decodePaymentRequired` and `decodeRequirementsBody` take an
  optional clock so the derivation is testable and the conformance vectors stay reproducible.
- **One unreadable offer could make a whole 402 unreadable.** s402's fail-hard validators for
  `escrow` / `upto` / `expiresAt` and the rest ran on every entry's `extra`, including entries
  naming schemes s402 does not implement. An x402 `auth-capture` offer using an `escrow` key in
  its own shape would take down the `exact` offer beside it. Those validators now run only on
  entries whose scheme is one of s402's six; a foreign entry's `extra` is carried through whole,
  and nothing is lifted out of it.
- **A mandate written with its fields in a different order read as a conflict.** The
  agreement check between two offers compared serialized JSON, so `{ required, minPerTx }` and
  `{ minPerTx, required }` — the same mandate — refused the 402. Comparison is field-wise now, and
  the check runs at `s402Gate()` construction for a static `requirements` array rather than on
  every 402: an operator who misconfigures it learns once, at boot, not once per request. The
  encode-time check remains for a dynamic `requirements` function, which cannot be inspected until
  it runs.
- **`s402Gate` accepted an empty `requirements` array**, emitted a 402 with `"accepts": []` that no
  decoder — including its own — will read, and then handed `undefined` to `verify`. It is refused
  at gate construction now, and at resolve time for a dynamic `requirements` function.
- **`exact` is sorted to the front of `accepts[]` by the encoder** rather than left to each
  caller. x402's client pays the first entry it has a handler for, so an `exact` entry listed
  third is one an x402 client walks past. ADR-016 stated the rule; stating it was not enforcing it.

- **The README's headline compatibility sentence was false on the first leg of the round trip.**
  "An x402 client can talk to an s402 server with zero modifications" had stood since April with
  no test. Run against the unmodified upstream client it failed immediately: the client could not
  read s402's 402 (`No client registered for x402 version: undefined`), and had it been handed the
  requirements some other way, its V2 payment under `PAYMENT-SIGNATURE` would have been answered
  with another 402. The gate's own comment said x402 clients were "accepted out of the box" — true
  of V1's header and payload shape, false of V2's, and V2 is what the upstream client sends. The
  sentence now says what the test proves: zero client changes, one server option. The migration
  guide's header table also claimed x402 V1 uses `payment-required` / `payment-response`; V1 uses
  a JSON body and `X-PAYMENT-RESPONSE` (`specs/transports-v1/http.md`). Corrected.

- **An MPP challenge could select a different HTTP field for the credential, and s402 threw the
  parameter away.** mpp-specs #328 (`ccab885`, 2026-08-25) lets a Payment challenge carry
  `header="Payment-Authorization"` so a resource can keep `Authorization` for ordinary
  authentication. `parseAuthParams` preserved the parameter; the struct returned by
  `parseWwwAuthenticatePayment` dropped it. The consequence was not a parse error — s402 would
  have handed back a credential destined for `Authorization` on a challenge that selected
  `Payment-Authorization`, and the spec is explicit that a credential arriving in any other field
  "MUST NOT satisfy the challenge." A client that cannot honour the selection is told, in the same
  sentence, that it MUST NOT send a credential at all. The parameter now survives intake, an
  unrecognized value is refused outright rather than passed along for someone to answer, and
  `mppCredentialHeaderName()` names the field the challenge chose. Emitting it is supported too,
  with the eighth HMAC binding slot it implies documented at the point of use.

- **A compatibility claim in `compat/x402.ts` had outlived its target.** The module said s402's
  outbound `payment-response` matched x402 V2's `PAYMENT-RESPONSE` case-insensitively, "so no emit
  change is needed to be read by x402 clients." The header *name* still matches. The claim was
  about the whole response, and x402 V2 has since added a third settlement state, so matching the
  name says nothing about matching what is inside it. The comment now says what is true and points
  at the open decision instead of implying there is not one.
- **Every `s402/compat` import in the README failed at module resolution.** The README told you
  to `import { normalizeRequirements, … } from 's402/compat'` in four places — the opening
  paragraph, the compat example, the sub-path export table, and Design Principle 2. That subpath
  is not exported; copying the example produced
  `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './compat' is not defined by "exports"`. The
  real path is **`s402/compat/x402`**, which exports all five documented functions. The sub-path
  table was also missing six real entries (`server`, `receipts`, `extensions`, `test-utils`,
  `compat/mpp`, `compat/l402`).
- **The README described a published package as unreleased.** Design Principle 1 called the Sui
  reference implementation `@sweefi/sui`, *"coming soon"* — while `@sweefi/sui` is on npm and
  `@sweefi/server` alongside it. The same document simultaneously described that implementation
  in the **present tense** two paragraphs earlier, so one fact appeared in two tenses. Both now
  say what is true: it is published, and it lives in a separate package.
- **The demo API misreported the protocol version it speaks.** `GET /api/catalog` returned a
  hardcoded `"version": "0.3"` while `S402_VERSION` is `"1"`. Anyone curling the catalog to see
  what the protocol advertises got a number that contradicts every payload the same server emits.
- **Gas figures were stated without their conditions.** The comparison table presented modelled
  estimates as flat facts and omitted the case the project's own whitepaper is careful to name:
  **x402 on Solana (~$0.25 per 1K calls) is cheaper than s402 Exact on Sui (~$7.00) for one-shot
  calls.** The table now marks the numbers as modelled, links the method, and states where a
  competitor wins.

- **The documented size of the conformance suite was wrong everywhere it appeared.** The repo
  stated it three different ways — `README.md` said 133 vectors, `docs/specification.md` said
  161 in two places — while `spec/vectors/` holds **167 vectors across 14 files**. All three now
  report the real number. The consequential one was §13 *Conformance*, criterion 5: that clause
  defines what makes an implementation s402-conformant, so an implementer in Go, Python or Rust
  reading the spec was told they conformed at 161 vectors, leaving six shipped vectors outside
  the definition of conformance.
- **The README told you to look for the conformance vectors in a directory that does not exist
  in a clone.** It pointed at `test/conformance/vectors/`, which is generated by
  `scripts/prepare-publish.sh` at publish time and is git-ignored. Cloning the repo and following
  the instructions produced *No such file or directory*. The README now points clones at
  `spec/vectors/` — the canonical, version-controlled location — and explains how the two paths
  relate, so the npm path stays correct for package consumers.

- **An architecture decision record claimed a CI check that has never existed.** ADR-006 stated,
  in the present tense, that `scripts/compute-scheme-digests.mjs` "runs in CI and writes
  `spec/scheme-digests.json`", failing any PR that changed a scheme doc without updating digests.
  Neither file appears in any commit on any branch, and CI has no such job. It was the only ADR
  carrying an `Implementation:` field, so the project's single answer to "was this built?" was
  false. The paragraph is now marked as an unbuilt plan and the record reads
  `Implementation: not-started`.

- **A native s402 receipt read through the x402 bridge came back with its transaction digest
  erased.** `PAYMENT-RESPONSE` is x402 V2's settle header *and* s402's own
  (`S402_HEADERS.PAYMENT_RESPONSE`), so `fromX402SettleResponseHeaders()` — documented to return
  `null` for a native receipt so callers fall back to the native decoder — could never do so: it
  matched on the name and consumed everything. A native `{ success: true, txDigest, receiptId }`
  came back as `state: 'settled', transaction: ''`, telling the caller no transaction hash existed
  when one did. The body now decides the dialect, the way `x402PayloadDialect` already did on the
  payload side: s402's own receipt fields return `null`, x402's are classified, and
  `X-PAYMENT-RESPONSE` needs no check because only x402 sends it.

- **A failed settlement holding a broadcast transaction hash invited a second payment.**
  `fromX402SettleResponse()` marked every non-pending failure `retryable: true`, but upstream
  `@x402/core` forwards `transaction` on any `errorReason` — so a caller trusting the flag would
  build a fresh payload while holding the hash of a transaction that may already have landed. That
  is the same double-pay this classifier was written to prevent, arriving under an ordinary error
  instead of `settlement_pending`. A `failed` outcome is now retryable only when its `transaction`
  is empty; a hash in hand is a reconciliation, never a retry.

- **A payment carrying both protocol markers was answered in the wrong dialect.**
  `x402PayloadDialect()` classified an `X-PAYMENT` payload as x402 on the presence of
  `x402Version` alone, while `isX402()`, the note atop `http.ts`, and three existing tests all say
  a payload carrying both `x402Version` and `s402Version` is native s402 — s402 is the superset.
  A native client that included the x402 marker would have had its receipt translated into x402's
  shape, losing `txDigest` and the s402 receipt fields it was waiting for. The dialect check now
  requires `s402Version` to be absent, matching every other detector in the module.

- **An empty `payment-signature` header broke payment for clients that sent none.** Both the
  dialect check and `fromX402PayloadHeaders()` tested the header for presence rather than
  truthiness, so `payment-signature: ""` counted as an x402 payment — and because that header is
  read first, it also hid a perfectly valid `X-PAYMENT` sitting behind it. A request with an empty
  header and a real native payload was rejected with an `INVALID_PAYLOAD` 402 carrying no
  requirements (`JSON.parse('')` on the empty value), leaving the client nothing to retry against.
  Both sites now use a truthiness check, matching x402's own server (`getHeader('payment-signature')
  || getHeader('x-payment')`).


- **A 402 assembled by hand published routes with the spending authorization removed.**
  `toX402V2Envelope` built its `accepts[]` offer by offer, and a mandate lives in
  `extensions.s402` — which only the whole-document projection writes — so it was silently
  dropped, and s402's own decoder then read the result as a foreign x402 402 and stamped a 60s
  expiry the server never set. It goes through the same projection the header encoder uses, and
  the two are asserted byte-identical.
- **A checksummed address or a re-serialized amount was refused as a different contract.** An x402
  V2 payment whose `accepted` carried the same offer with `payTo` checksummed differently, or
  `amount` as a number, came back `SCHEME_NOT_SUPPORTED`. Identifiers now compare
  case-insensitively and amounts numerically. An `accepted` truncated to `{ scheme, network }` —
  which is all upstream's type promises — matches the route; one that states a price matching
  nothing still fails.
- **An `exact` offer whose `extra.paymentFlow` this build cannot name is refused again.** The
  check existed on the retired flat path and did not survive the move, so an `auth-capture` flow
  was carried through and paid as plain `exact`. A foreign scheme's own flow is still not graded.
- **A `maxTimeoutSeconds` of zero produced an offer with no expiry at all**, which walks past every
  stale-payment guard — the one outcome the derivation exists to prevent. Zero is now refused on
  the wire, and a zero reaching `applyForeignExpiry` directly derives an already-expired offer.
- **A 402 in the retired flat shape read as "no payment required".** `detectProtocol` returned
  `unknown` for it — the same answer as a response with no `payment-required` header — and
  `extractRequirementsFromResponse` returned `null`, so during a rolling upgrade a client neither
  paid nor errored. Both read it now, in TypeScript and in Python.
- **A route's mandate never reached the facilitator.** `s402Gate`'s `mandate` option was written
  onto the envelope only, and a scheme is handed one offer and never sees the envelope — so a
  mandate-required route verified as mandate-free. The gate now copies it down the way the decode
  side always has, onto copies rather than the caller's own objects.
- **`pnpm demo` crashed on its first line**, and `demo-api`, `mcp-demo`, the joke-api example and
  `@sweefi/server` did not compile against wire v2. None of it was visible because
  `typescript/tsconfig.json` included only `src`; `test` and `examples` are in it now, which is
  the fix for the class rather than the instances.

## [0.8.0] - 2026-06-28

The transport-abstraction release (ADR-011): **one seam, three carriers — HTTP, MCP, and A2A.**
`s402` now speaks the surfaces agents actually use, with opt-in x402 inbound bridges for each,
the protocol core staying chain-agnostic (S7) and x402-free throughout. Purely additive.

### Added

- **Transport abstraction (`PaymentTransport`) — ADR-011, Chunk 1a-i.** A chain-agnostic seam that maps the canonical `{ PaymentRequirements, PaymentPayload, SettleResponse }` to a carrier's out-of-band metadata slot, so payment can ride any carrier (HTTP today; MCP `_meta` and A2A task-state next). Motivated by x402 V2 moving all protocol data into headers and defining `transports-v2/` for HTTP/MCP/A2A — this is the seam that lets s402 match and then leapfrog that (x402 has only an A2A *spec*, no impl).
  - `PaymentTransport<TFrame>` interface + `httpTransport` (`src/transport.ts`). `TFrame` is the carrier-native container — `Headers` for HTTP; the `_meta` record for MCP; task metadata for A2A.
  - **Stateful-ready by design (ADR-011 blind-spot review):** every method threads an optional `PaymentCarrierContext` (`correlationId` + lifecycle `status`) so the *stateful* A2A carrier (task lifecycle: `input-required → completed/failed`, `taskId` correlation) becomes a thin adapter rather than forcing an interface break later. HTTP ignores `correlationId` (no wire slot) and *derives* `status`; A2A populates both.
  - New barrel exports: `httpTransport`, and types `PaymentTransport`, `PaymentCarrierContext`, `PaymentStatus`, `Decoded`.
  - **10 unit tests** at `test/transport.test.ts` proving `httpTransport` is byte-identical to the raw `http.ts` codec (encode equivalence + roundtrip), correct status derivation, null-on-absent, case-insensitive reads, and trust-boundary error propagation.
- **x402 inbound payload bridge — `fromX402PayloadHeaders()` in `s402/compat/x402` (ADR-011, Chunk 1a-ii).** The opt-in inbound half of "s402 servers transparently accept x402 clients" (ADR-005): reads an x402 payload header — `PAYMENT-SIGNATURE` (x402 V2) or `X-PAYMENT` (V1) — base64-decodes it, and normalizes the shape to an s402 payload via `fromX402Payload`. Returns `null` when absent so callers fall back to the native `x-payment` path. Lives in the **opt-in compat layer**, keeping the protocol core x402-free (AGENTS.md). **8 unit tests** at `test/compat-x402-inbound.test.ts` (V1/V2 normalization, case-insensitive read, header preference, null-on-absent, malformed/non-object/no-s402-equivalent rejection).
  - **ALL-CAPS emit was rejected**, not deferred: the Fetch `Headers` API byte-lowercases field names and HTTP/2 (RFC 9113 §8.2.1) requires lowercase — so uppercase emit is a no-op/spec violation. Lowercase emit is correct by design. Outbound interop is already covered: `payment-response` matches x402 V2's `PAYMENT-RESPONSE` case-insensitively.
- **MCP transport (`mcpTransport`) — payment in the JSON-RPC `_meta` slot (ADR-011, Chunk 1a-iii).** `s402` now speaks MCP, the surface agents actually use. `mcpTransport` (`PaymentTransport<McpMetaFrame>`) maps the canonical objects to/from `_meta['s402/payment']` as **structured JSON** (MCP's idiom — not base64), validated through the SAME canonical `validate*Shape`/`pick*Fields` as the HTTP path, so untrusted MCP input crosses the identical trust boundary. **Zero MCP-SDK dependency** — it is pure object-mapping; the SDK wiring lives in the Sui-aware `@sweefi/mcp` that consumes it. New barrel exports: `mcpTransport`, `S402_MCP_META_KEY`, type `McpMetaFrame`. Two private validators (`validatePayloadShape`, `validateSettleShape`) are now exported from `s402/http` so non-HTTP carriers reuse them.
  - **x402-over-MCP inbound bridge — `fromX402PayloadMeta()` in `s402/compat/x402`.** The MCP analogue of `fromX402PayloadHeaders`: reads `_meta['x402/payment']` and normalizes via `fromX402Payload`. Opt-in, in compat, keeping core `mcpTransport` x402-free.
  - **12 unit tests** at `test/mcp-transport.test.ts` (round-trips, status derivation, null-on-absent, wrong-decoder rejection, unknown-key stripping, x402 bridge).
  - Cross-language MCP conformance vectors are **deferred to a follow-up** (Chunk 1a-iv) — covered by TS unit tests for now; the language-agnostic JSON vectors touch the generator + Python runner.
- **A2A transport (`a2aTransport`) — payment on the Agent-to-Agent task lifecycle (ADR-011, Chunk 2). The leapfrog: x402 has only an A2A *spec*; s402 now ships the implementation.** `a2aTransport` (`PaymentTransport<A2aMetadataFrame>`) maps the canonical objects onto A2A task/message `metadata` under `s402.payment.*` keys (`status`, `required`, `payload`, `receipts`, `correlationId`), mirroring x402's `x402.payment.*` convention. A2A is fully stateful, so — unlike HTTP/MCP — the lifecycle **status is carried explicitly and READ back** (not derived), and `ctx.correlationId` threads the `taskId`. Settlement uses A2A's plural `receipts` array. Validation routes through the same canonical `validate*Shape`/`pick*Fields` — identical trust boundary across all three carriers. New barrel exports: `a2aTransport`, `S402_A2A_KEYS`, type `A2aMetadataFrame`.
  - **x402-over-A2A inbound bridge — `fromX402PayloadA2A()` in `s402/compat/x402`.** Completes the opt-in x402-inbound trio (HTTP · MCP · A2A); reads `metadata['x402.payment.payload']` and normalizes via `fromX402Payload`. Core `a2aTransport` stays x402-free.
  - **13 unit tests** at `test/a2a-transport.test.ts`, including the defining check that A2A *reads* the explicit status rather than deriving it.
- **Cross-language conformance vectors for the MCP + A2A carriers (ADR-011, Chunk 1a-iv).** `spec/vectors/transport-carriers.json` — 6 vectors (3 MCP + 3 A2A) pinning the wire contract (encoded frame + decoded value + carrier status/correlation) for other-language implementations. A new `Conformance: transport-carriers` block in the TS runner validates them; the Python runner is untouched (it loads only named files), so it stays green until a Python codec exists.

### Fixed

- **Conformance vector generator restored.** `test/conformance/generate-vectors.ts` imported `../../src/compat.js`, which moved to `compat/x402.js` in the 0.7.0 compat reorg — the generator had been broken/unrunnable since (nothing in CI exercises it; only the runner reads the committed vectors). Fixed the import; regenerating now reproduces the existing vectors byte-for-byte (confirming no committed drift) plus the new transport file. See `LESSONS.md`.

### Security

Pre-publish adversarial review (2026-06-28) hardened three trust-boundary issues before the 0.8.0 publish (regression tests in `test/security-hardening.test.ts`):

- **A2A status decode** (`transport.ts`) — `a2aStatus` indexed a plain enum object with an attacker-controlled key, so a malicious A2A peer sending `s402.payment.status: "constructor"` (or `__proto__` / `toString` / …) got back an inherited prototype member (a function/object) instead of a `PaymentStatus`. Now `hasOwnProperty`-guarded.
- **MPP empty challenge id** (`compat/mpp.ts`) — `parseWwwAuthenticatePayment` and `decodeMppCredential` accepted an empty `id` (`typeof "" === 'string'`); MPP hardened `id` to MUST-be-non-empty (an empty id is replay-ambiguous). Now rejected for all required auth-params.
- **`pickPayloadFields`** (`http.ts`) — the exported helper indexed the scheme map with an untrusted key; `scheme: "constructor"` threw a raw `TypeError` on a direct call. Now `hasOwnProperty`-guarded.
- **Defense-in-depth:** 64KB size cap added to the MPP base64url decoder (mirrors the HTTP header cap).
- **`s402Gate` now verifies BEFORE serving (security-first default).** The payment is cryptographically verified before the protected handler runs; an invalid payment is rejected with a 402 and the handler **never executes** (no compute, no side effects). `verifyBeforeServe: false` opts into optimistic serve-then-settle for idempotent / side-effect-free handlers. Previously the handler ran before verification (body was withheld on failure, but side effects executed) — that was the highest-severity finding in the pre-publish review. Regression tests in `test/gate.test.ts` prove the handler does not run on an invalid payment.

### Changed

- **1098 tests across 28 files** (was 1032 at 0.7.0). The transport refactor (1a-i) is **behavior-preserving**: `httpTransport` delegates to the existing `http.ts` `encode*/decode*` functions and `S402_HEADERS` — same header names, same base64 — so all pre-existing tests pass unchanged as the regression proof. Chunks 1a-ii (x402 HTTP inbound bridge), 1a-iii (`mcpTransport` + x402 `_meta` bridge), and 2 (`a2aTransport` + x402 A2A bridge) are purely additive; no core wire change. The two newly-exported validators are additive to `s402/http`. **One seam, three carriers: HTTP, MCP, A2A.**

### Compatibility

- **Purely additive.** No changes to existing types, scheme interfaces, wire format, or conformance vectors. `httpTransport` is opt-in; the root barrel adds exports but changes no existing ones.

## [0.7.0] - 2026-04-22

### Added

- **`s402/compat-l402` — L402 read-path interop (DAN-344).** New entry point for consuming Lightning Labs' L402 (formerly LSAT) challenges as native s402 types. L402 is the oldest 402 dialect in production — shipping this turns the "universal read" positioning pillar from aspirational into airtight.
  - `parseWwwAuthenticateL402(header)` — RFC 9110 auth-params parser accepting both `L402` and legacy `LSAT` auth-schemes (canonicalized to `L402` in output). Handles quoted-string + unquoted-token forms. Enforces required `macaroon` and `invoice` params.
  - `decodeBolt11Summary(invoice)` — partial BOLT-11 decoder over the human-readable part only. Extracts network (`lightning:mainnet|testnet|regtest|signet`) and amount (converting m/u/n/p multipliers to millisatoshi with BigInt arithmetic). Rejects pico-BTC amounts not divisible by 10.
  - `fromL402Challenge(challenge)` — translates an L402 challenge into `s402PaymentRequirements` with `scheme: 'exact'`, `asset: 'lightning:msat'`, sentinel `payTo: 'lightning:invoice'` (real destination lives in the invoice). Surfaces macaroon + invoice in `extensions.l402` for retry construction. Rejects amountless invoices as spec violations. Stamps a conservative `expiresAt = now + 60s` so that **S1 (stale payment rejection) stays load-bearing** for L402-derived requirements — the real BOLT-11 expiry tag is not decoded in v0.7 (scope deferral); the 60s floor guards against stale-invoice replay, with the tradeoff that long-expiry invoices trigger a re-fetch after 60s.
  - **Signet prefix support**: recognizes both the canonical current-BOLT-11 prefix (`lntbs`, core-lightning + recent LND) and the legacy prefix (`lnsb`, older LND emissions). Both canonicalize to `lightning:signet` in the parsed output.
- **~20 unit tests** at `test/compat-l402.test.ts` covering all four multiplier classes, all four network prefixes, LSAT/L402 alias handling, amountless invoices, malformed HRPs, and end-to-end header-to-requirements flows.
- **Positioning document** at `docs/positioning.md` — canonical three-pillar USP: expressiveness (6 schemes), universal read (every 402 dialect), on-chain enforcement (Move invariants). Single source of truth for landing page, pitch, and grant copy.
- **Universal 402 Absorption** project tracker on Linear ([project link](https://linear.app/dannydevs/project/universal-402-absorption-f6e181082db4)) with child issues DAN-344 (L402), DAN-345 (MPP Session), DAN-346 (MPP write path), DAN-347 (Google AP2), DAN-348 (IETF reference impl), DAN-349 (ERC-7824 watch).

### Scope (intentionally deferred)

- **L402 write path** — emitting L402 challenges requires a Lightning node to mint BOLT-11 invoices; out of scope for a wire-format library. Teams that need emission should keep Aperture in the path.
- **Macaroon caveat decoding** — passed through opaque in v0.7; caveat introspection delegated to `node-macaroon` or equivalent.
- **Full BOLT-11 tagged-field decoding** — node pubkey, routing hints, payment hash, description. Lightning wallets already decode these; we do not duplicate their work.
- **BOLT-12 offers** — newer offer-based protocol, spec still evolving.

### Changed

- `docs/integrations.md` — added L402 compat-layer row (✅ v0.7).
- `docs/guide/upgrade-l402.md` — new migration guide covering consumption, coexistence via `Accept-Payment`, BOLT-11 multiplier table, and honest comparison with L402.

### Breaking

- **Minimum Node.js bumped to 20** (from 18). Node 18 reached end-of-life April 2025; `envelope.ts`'s `computeTxBinding` relies on `globalThis.crypto.subtle` which is only available unflagged in Node 19+. `engines.node` updated to `>=20`, CI matrix dropped Node 18, README/docs updated. Node 20 and Node 22 remain fully supported.

### Compatibility

- **Non-compat consumers are additive.** No changes to existing types, scheme interfaces, wire format, or conformance vectors.
- **Compat sub-path exports reorganized**: all three compat layers now live under `s402/compat/*` for symmetry and clearer intent.
  - `s402/compat` → **`s402/compat/x402`** (breaking rename — x402 is now explicit, not the unlabeled default)
  - `s402/compat-mpp` → **`s402/compat/mpp`**
  - `s402/compat-l402` → **`s402/compat/l402`** (new in this release; shipped under the new path from day one)
  - Source tree moved from flat `src/compat.ts`, `src/compat-mpp.ts`, `src/compat-l402.ts` to `src/compat/x402.ts`, `src/compat/mpp.ts`, `src/compat/l402.ts`. Pre-1.0 minor bump licenses the rename; no backward-compat aliases shipped — consumers update imports once.
  - **Migration**: find-replace `'s402/compat'` → `'s402/compat/x402'`, `'s402/compat-mpp'` → `'s402/compat/mpp'`, `'s402/compat-l402'` → `'s402/compat/l402'`. Exported symbol names are unchanged.
- Root `s402` entry still pulls no compat bundle — compat layers remain opt-in.

## [0.6.0] - 2026-04-19

### Added

- **`s402/compat-mpp` — MPP read-path interop (DAN-339).** New entry point for consuming Stripe/Tempo Machine Payment Protocol 402 responses as native s402 types. All parsing is grounded against the actual MPP spec drafts in `tempoxyz/mpp-specs` (draft-httpauth-payment-00, draft-payment-intent-charge-00), not hearsay.
  - `parseWwwAuthenticatePayment(header)` — RFC 9110 auth-params parser for `WWW-Authenticate: Payment`. Handles quoted-string escapes, unquoted tokens, enforces required `id`/`realm`/`method`/`intent`/`request`, preserves optional `digest`/`expires`/`description`/`opaque`.
  - `parseMppAcceptPayment(header)` — method/intent pair grammar with wildcards on either side (`tempo/charge`, `tempo/*`, `*/session`, `*/*`) and q-values per core spec §6.1. Stable sort by descending q, preserves client order on ties.
  - `matchMppRange(range, method, intent)` — specificity scoring (exact=2, one-wild=1, all-wild=0, no-match=−1) for the "prefer most specific matching range" rule.
  - `decodeMppChargeRequest(challenge)` — decodes the base64url JCS `request` blob for the charge intent. Validates `amount` as non-negative integer, requires `currency`, preserves `methodDetails` untouched.
  - `decodeMppCredential(authorizationHeader)` — base64url-nopad `Authorization: Payment <...>` decoder with trust-boundary shape validation on `challenge` and `payload`.
  - `fromMppChargeChallenge(challenge, now?)` — translates blockchain-method Charge challenges (`tempo`/`evm`/`solana`/`lightning`/`stellar`) into `s402PaymentRequirements` with `scheme: 'exact'`. Resolves network via `eip155:{chainId}` / `tempo:{chainId}` conventions, carries challenge provenance into `extensions.mpp` for downstream routing, rejects processor-based methods (Stripe/card have no payTo in the Charge request), rejects expired challenges.
- **40 spec-grounded unit tests** at `test/compat-mpp.test.ts` drawn from the spec's own §5.1.4 / §6.1 / §Request Schema fixtures.
- **ADR-005 — Interop When Possible, Superset When Wise.** The governing strategic principle behind the compat layer: absorb x402/MPP as payment-in formats where their design is legitimate; superset them on primitives their business models forbid. See `docs/adr/005-interop-superset-principle.md`.

### Scope (intentionally deferred to v0.7+)

- Session intent (cumulative voucher ↔ Prepaid translation shim)
- Method-specific credential-tier dispatch (EVM `permit2`/`authorization`/`transaction`/`hash`; Tempo `transaction`/`hash`/`proof`)
- HMAC-SHA256 challenge-binding verification (server-side, needs secret)
- Write path — emitting MPP-shaped `WWW-Authenticate: Payment` challenges from an s402 server

### Changed

- **956 tests across 21 files** (was 916). The 40 new compat-mpp tests join 30 unit + 6 live-server integration tests for `Accept-Payment` that shipped earlier in the 0.5 dev cycle.
- Migration guide (`docs/guide/upgrade-mpp.md`) updated to reference real exported APIs rather than placeholder code.
- `docs/integrations.md` compat-layer table updated: MPP Charge (read) is 🟡 v0.3, MPP `Accept-Payment` is ✅ Production, MPP Charge (write) and Session remain 📋 roadmap.

### Compatibility

- **Purely additive.** No changes to existing types, scheme interfaces, wire format, or conformance vectors. Existing 0.5.x consumers require no code changes.
- **New sub-path export**: `s402/compat-mpp` sits alongside the existing `s402/compat` (x402 interop). Both are opt-in — importing from the root `s402` entry does not pull the compat bundles.

## [0.5.0] - 2026-04-12

### Added

- **`upto` scheme V2 features (DAN-284).** Two new fields close x402's upto overcharge vulnerability:
  - `estimatedAmount` on `s402UptoExtra` — server's advisory cost estimate so clients can set tight ceilings
  - `settlementCeiling` on `s402UptoPayload` — client-chosen, on-chain-enforced cap. Move contract rejects `actualAmount > settlementCeiling`. Must satisfy `1 <= settlementCeiling <= maxAmount`. See ADR-003 §Decision 3 and §Decision 8.
- **Extension system (DAN-285, ADR-004).** Typed, lifecycle-aware plugin architecture:
  - Three actor-specific interfaces: `s402ClientExtension`, `s402ServerExtension`, `s402FacilitatorExtension`
  - Four facilitator hooks in pipeline order: `beforeVerify` → `afterVerify` → `beforeSettle` → `afterSettle`
  - `s402ExtensionRegistry` with dependency ordering via Kahn's topological sort
  - Critical vs advisory error handling: `critical: true` extensions throw, advisory extensions log and continue
  - `getExtensionData<T>()` / `setExtensionData()` type-safe helpers
  - `./extensions` sub-path export added to package.json
- **`skipVerify` option on `process()`.** New `s402ProcessOptions` interface with `skipVerify?: boolean`. Eliminates the verify() dry-run RPC round-trip (~200-400ms) for chains where failed transactions cost zero gas (Sui PTBs). All pre-flight checks (expiration, scheme-mismatch, dedup) still run.
- **`EXTENSION_FAILED` error code** — `retryable: false`, for critical extension pipeline failures.
- **154 conformance test vectors** (was ~130). New vectors for: upto requirements with estimatedAmount, upto payloads with settlementCeiling, settle responses with actualAmount/depositId, V2 rejection vectors, upto roundtrips, mandate.minPerTx validation.

### Fixed

- **Settle response type validation (M1).** `validateSettleShape` now rejects non-string `actualAmount` and `depositId` — a malicious facilitator could previously inject numeric types that passed through to consumer code.
- **Prepaid payload amount validation (M2).** `ratePerCall` and `maxCalls` in payload now validated with `isValidAmount()`, matching the requirements-side validation. Previously only type-checked as strings.
- **Mandate minPerTx amount validation (L1).** `mandate.minPerTx` now validated with `isValidAmount()` for consistency with other amount fields.
- **afterSettle error observability.** Catch block now forwards to `extensionErrorHandler` instead of silently swallowing critical extension errors (the settlement result is still never changed — tx is already on-chain).
- **Stale comment in validatePayloadShape.** Updated to document upto's scheme-specific inner keys alongside prepaid and unlock.

### Changed

- **831 tests across 17 files** (was 798). New coverage: standalone verify/settle guard tests, V2 validation edge cases, settle response type checks, prepaid amount validation, extension system integration.
- Conformance README updated with `estimatedAmount` in upto sub-object keys and `settlementCeiling` in payload inner keys.

## [0.4.0] - 2026-04-11

### Changed
- **BREAKING: `verifySettlement` is now required on `s402ClientScheme` (DAN-280).** The `?` was removed — every scheme implementation MUST provide `verifySettlement()`. Schemes that cannot verify locally (e.g. unlock-TX2) should return `{ verified: false, reason: '...' }`. All 5 SweeFi adapters already implement this method; only custom third-party implementations that relied on the optional marker will need updating.
- Updated JSDoc: `@since 0.4.0 — required (was optional in 0.3.0)`
- `mockExactClientScheme()` in `test-utils.ts` now includes `verifySettlement()` returning `{ verified: false }` with reason `'mock scheme'`

### Added
- **S8 conformance test vectors (DAN-282).** `spec/vectors/settlement-verification.json` — 7 chain-agnostic test vectors covering the `verifySettlement` interface contract: matching digest, mismatched digest (malicious facilitator), settle failed, missing txDigest, invalid base64, stream scheme, and non-verifiable scheme. Each vector includes `expectedShape`, `invariants`, and implementation `notes`.

### Compatibility
- **BREAKING for 0.3.x consumers**: implementations that omitted `verifySettlement` will now fail type-checking. Add a stub returning `{ verified: false, expectedDigest: '', actualDigest: null, reason: 'not implemented' }` to restore compilation.
- Wire format: unchanged from v0.3.0.

## [0.3.0] - 2026-04-11

This release closes the facilitator causal-binding hole identified in the April 2026 scale-fragility review, and establishes s402 as a pure chain-agnostic protocol repo (no Sui code anywhere). Chain-specific implementations now live in downstream adapter repos — the canonical Sui reference is `@sweefi/sui` in the SweeFi monorepo.

### Added

- **`verifySettlement` — client-side causal-binding check (S8 Facilitator Accountability).** New optional method on `s402ClientScheme`. For all client-signed schemes (`exact`, `stream`, `escrow`, `unlock` TX1), this is a **local, offline comparison**: derive the expected transaction digest from the signed BCS bytes and compare to `SettleResponse.txDigest`. No RPC call required. Closes the causal-binding hole where a malicious facilitator could substitute an unrelated-but-real transaction digest — that digest would correspond to different signed bytes the client never produced, and the check would reject it. Interface-only in this release; concrete implementations land in `@sweefi/sui` per ADR-002. See `typescript/src/scheme.ts` and `INVARIANTS.md` § S8 for the full contract and copy-paste implementation template.
- **`s402SettlementVerification` type** — return shape for `verifySettlement`: `{ verified, expectedDigest, actualDigest, reason? }`.
- **`DIGEST_MISMATCH` error code** — `retryable: false`, with a `suggestedAction` warning callers NOT to retry on mismatch. Retrying is dangerous: the signed bytes may have already landed on-chain under the *expected* digest (the facilitator may simply be lying about what it broadcast), and a fresh retry would double-pay. The correct failure mode is to mark the payment as non-settled and stop trusting the facilitator. See `typescript/src/errors.ts`.
- **S8. Facilitator Accountability** — first-class safety invariant alongside S1–S7. Full statement, formal proof for the `exact` scheme on Sui (by blake2b-256 collision resistance), per-scheme scope table, and a copy-paste implementation template for downstream Sui adapters now live in `INVARIANTS.md` § S8. The Allium behavioral spec is at `spec/allium/s8-facilitator-accountability.allium`.
- **ADR-001 — Protocol Boundaries.** Documents four decisions from the scale-fragility council: (1) facilitator trust boundary sealed by client-side digest verification, (2) receipt cardinality is a non-guarantee at the protocol layer, (3) scheme cap at five with burden-of-proof for any new scheme, (4) extension hygiene rules. See `docs/adr/001-protocol-boundaries.md`.
- **ADR-002 — s402 is a pure protocol repo.** Decides that this repo contains NO chain-specific code at any path — not in `typescript/src/`, not in a sibling package, not anywhere. All Sui-specific implementation moves to SweeFi. Corollary: the S7 chain-agnostic boundary is now enforced repo-wide, not just inside `src/`. See `docs/adr/002-s402-is-pure-protocol.md`.

### Removed

- **`mcp-server/` directory deleted.** The Sui-specific MCP server that previously shipped in this repo has been relocated to `@sweefi/mcp` (canonical implementation in the SweeFi repo) per ADR-002. **This does not affect the npm `s402` package** — `mcp-server` was a separate consumer of this package, not part of it. Users who were installing from the repo directly should migrate to `npx @sweefi/mcp`; a forthcoming `npm deprecate s402-mcp` will redirect the legacy standalone package to the new name.

### Changed

- **S7 scope strengthened to repo-level.** `INVARIANTS.md` § S7 scope note now reads: "chain-specific code lives in downstream implementation repos (e.g. `@sweefi/sui` for the Sui implementation) which consume this package from npm and add chain validation on top. Per ADR-002, the s402 repo itself contains NO chain-specific imports at the repo level — the protocol-pure boundary is enforced repo-wide, not just inside `src/`."
- **`INVARIANTS.md` Sui references rewritten as downstream pointers.** Prior revisions of the S8 proof block referenced a reference implementation at `mcp-server/src/sui-exact.ts`. That path no longer exists; the proof block now points at `sweefi/packages/sui/src/s402/exact/client.ts` as the canonical Sui adapter per ADR-002.
- **Demo API distribution surfaces** (`demo-api/public/index.html` served at `demo.s402-protocol.org`, and `demo-api/src/server.ts`) now reference `@sweefi/mcp` with the correct `SUI_PRIVATE_KEY` / `SUI_NETWORK` environment variables, matching SweeFi's documented `mcpServers` config shape. Outside the npm package scope but noted here for consumers browsing the monorepo.

### Compatibility

- **TypeScript type compatibility**: `verifySettlement` is optional on `s402ClientScheme`, and `DIGEST_MISMATCH` is a purely additive enum member. Existing adapter implementations compile unchanged against `^0.3.0`.
- **Wire format**: unchanged from v0.2.3. The 132 conformance test vectors in `test/conformance/vectors/` still pass byte-for-byte against v0.3.0.
- **Minor-bump rationale**: the 0.2.3 → 0.3.0 jump reflects the semantic significance of adding a new safety invariant (S8) and the repo-level architectural decisions (ADR-001/002), not a breaking wire-format change. Under semver 0.x, minor bumps are treated as breaking by `^0.x.y` ranges — consumers should expect to opt-in explicitly.

## [0.2.1] - 2026-03-02

### Added

- **Conformance test vectors ship in npm package** — 133 machine-readable JSON test vectors across 12 files now included via `test/conformance/vectors`. Cross-language implementors (Go, Python, Rust) can `npm pack s402` to get the vectors without cloning the repo.
- **API stability declaration** — `API-STABILITY.md` classifies all 83 exports as stable, experimental, or internal.

### Fixed

- Barrel export JSDoc updated to chain-agnostic wording (was "Sui-native").

## [0.2.0] - 2026-03-01

### Added

- **Receipt HTTP helpers** — `s402/receipts` sub-path export with `formatReceiptHeader()`, `parseReceiptHeader()`, `S402_RECEIPT_HEADER`. Chain-agnostic receipt wire format (`v2:base64(sig):callNumber:timestampMs:base64(hash)`) for v0.2 signed usage receipts.
- **S7 chain-agnostic boundary invariant** — formal safety invariant enforced by `test/boundary.test.ts`. Greps `src/` for chain-specific patterns (Sui address regex, Solana base58, Ethereum imports) and fails the build if any are found.
- **v0.2 prepaid type extensions** — `providerPubkey` and `disputeWindowMs` fields on `s402PrepaidExtra` for signed receipt mode.
- **Body transport** — `application/s402+json` content type for large payloads that don't fit in HTTP headers.
- **Formal safety invariants** (S1-S7) documented in AGENTS.md.

### Fixed

- **Chain-agnostic payTo/protocolFeeAddress validation** — removed Sui-specific address regex (`/^0x[0-9a-fA-F]{64}$/`) from `http.ts`. Replaced with chain-agnostic checks (non-empty string, no control characters). Chain-specific validation belongs in `@sweefi/sui`.
- **x402 compat validation parity** — `normalizeRequirements()` now runs `validateRequirementsShape()` on x402 conversion output, ensuring identical validation regardless of input format.
- **Prepaid pairing invariant enforcement** — `providerPubkey` and `disputeWindowMs` must both be present (v0.2) or both absent (v0.1). Was documented in JSDoc but not enforced at wire decode.
- **Receipt BigInt coercion** — `parseReceiptHeader()` rejects empty strings and whitespace-only strings that JavaScript's `BigInt()` would silently coerce to `0n`.
- **Removed Sui default for `asset`** — `s402RouteConfig.asset` is now required (was optional with `'0x2::sui::SUI'` default). Chain-specific defaults don't belong in the protocol layer.

### Changed

- **BREAKING**: `s402RouteConfig.asset` is now required (was optional).
- JSDoc on `s402PaymentRequirements` updated to chain-agnostic wording (network, asset, amount fields).
- **Conformance test suite** — 133 machine-readable JSON test vectors across 12 files for cross-language implementation verification. Covers encode/decode, body transport, compat normalization, receipt format/parse, validation rejection, key-stripping, and roundtrip identity. Vectors ship in the npm package.
- **API stability declaration** — `API-STABILITY.md` classifies all 83 exports as stable/experimental/internal.
- 405 tests across 12 suites (was 207 at v0.1.0).

## [0.1.8] - 2026-02-27

### Added

- Body transport (`application/s402+json`) for large payloads
- v0.2 prepaid type extensions (`providerPubkey`, `disputeWindowMs`)
- `FUNDING.yml` and cross-linked SweeFi in README

## [0.1.7] - 2026-02-25

### Added

- Formal safety invariants (Lamport-style proofs)
- `isValidU64Amount()` magnitude checks

## [0.1.6] - 2026-02-19

### Fixed

- **Security audit patches** (15 true positives, H-1 through M-6, L-2):
  - H-1: `process()` wraps `resolveScheme`/`verify`/`settle` in try/catch — unhandled rejections no longer crash server middleware; returns `{success: false}` instead
  - H-2: In-flight dedup `Set` on `process()` — concurrent identical payloads can no longer both reach `scheme.settle()`
  - H-3: `Promise.race()` timeouts — 5s for verify, 15s for settle — prevents hanging RPC calls from exhausting the event loop
  - M-1: `facilitatorUrl` in x402 compat now validated via `new URL()` — rejects `javascript:`, `file://`, and other non-http(s) schemes (SSRF guard)
  - M-2: `isValidAmount` → `isValidU64Amount` on decode — rejects amounts above u64 max at the wire boundary
  - M-5: Settle catch returns `SETTLEMENT_FAILED` (`retryable: true`) instead of `VERIFICATION_FAILED` (`retryable: false`) — agents can now retry on transient RPC failures
  - M-6: `payTo` validation tightened from `startsWith('0x')` to full Sui address regex `/^0x[0-9a-fA-F]{64}$/` — rejects `'0x'` alone and non-hex chars
  - L-2: `expiresAt` guard extended to reject `<= 0` — negative timestamps and zero are now invalid at decode time

## [0.1.5] - 2026-02-19

### Changed

- Author updated to SweeInc brand name
- Renamed `@sweepay/*` → `@sweefi/*` across all documentation

## [0.1.4] - 2026-02-18

_Version bump for npm publish after license change._

## [0.1.3] - 2026-02-18

### Changed

- License changed from MIT to Apache-2.0
- Documentation consolidated (removed codebase-tour, added complete guide)
- Updated tagline to "HTTP 402 payment protocol"

### Added

- CI and npm version badges to README

## [0.1.2] - 2026-02-16

### Added

- CI workflow (GitHub Actions) with tag-based npm releases
- Separate build job for Node 22

## [0.1.1] - 2026-02-16

### Fixed

- Facilitator `verify()` and `settle()` now have the same defense-in-depth guards as `process()`:
  - Reject non-number `expiresAt` values (prevents silent bypass with string types)
  - Reject payload schemes not in `requirements.accepts` (scheme-mismatch guard)
- `protocolFeeBps` validation now requires an integer (rejects `50.5`)
- Sub-object fields (stream, escrow, unlock, prepaid, mandate) are now stripped of unknown keys at the trust boundary, matching the top-level field stripping behavior
- `process()` now catches exceptions thrown by `scheme.settle()` and returns them as error results instead of propagating unhandled

### Added

- `isValidU64Amount()` — validates amount strings fit in a Sui u64 (format + magnitude check). The existing `isValidAmount()` remains format-only for chain-agnostic use.

## [0.1.0] - 2026-02-15

### Added

- Five payment scheme types: exact, prepaid, escrow, unlock, stream
- HTTP header encoding/decoding (base64 JSON wire format)
- Client, server, and facilitator scheme registries
- Optional x402 compat layer (`s402/compat`) — normalizes V1 and V2 formats
- Typed error codes with `retryable` flag and `suggestedAction` for agent self-recovery
- Sub-path exports: `s402/types`, `s402/http`, `s402/compat`, `s402/errors`
- Property-based fuzz testing via fast-check
- 207 tests, zero runtime dependencies

[0.8.0]: https://github.com/s402-protocol/core/compare/v0.7.0...v0.8.0
[0.4.0]: https://github.com/s402-protocol/core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/s402-protocol/core/compare/v0.2.3...v0.3.0
[0.2.1]: https://github.com/s402-protocol/core/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/s402-protocol/core/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/s402-protocol/core/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/s402-protocol/core/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/s402-protocol/core/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/s402-protocol/core/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/s402-protocol/core/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/s402-protocol/core/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/s402-protocol/core/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/s402-protocol/core/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/s402-protocol/core/releases/tag/v0.1.0
