/**
 * Doc consistency — every conformance-vector count printed in the repo's prose
 * must match what spec/vectors/ actually contains.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * On 2026-08-16 (DAN-855) this repo stated the size of its own conformance
 * suite THREE different ways, and all three were wrong:
 *
 *   README.md            "133 machine-readable JSON test vectors"
 *   specification.md §0  "161 vectors across 13 files"
 *   specification.md §13 "the 161 machine-readable conformance test vectors"
 *   spec/vectors/        167 vectors across 14 files   <- the truth, that day
 *
 * (Those four numbers are the 2026-08-16 snapshot, kept as the record of the
 * incident. They are NOT a current count — the current count is whatever
 * actualCounts() reads off disk, which is the whole point of this file.)
 *
 * The first two are cosmetic. The third is NORMATIVE: §13 "Conformance"
 * criterion 5 defines what makes an implementation s402-conformant, so a
 * third-party implementer in Go or Rust was told they were conformant at 161
 * vectors, leaving six shipped vectors outside the definition of conformance.
 *
 * A count written into prose is a derived value stored by hand. It rots
 * silently every time a vector is added, and nothing fails when it does. Three
 * independent numbers in one repo is what that rot looks like once it has been
 * running for a while. This test is the thing that fails.
 *
 * ── WHY THESE PATHS AND NOT THE OTHER ONES ──────────────────────────────────
 *
 * There are two vector directories and only one of them exists everywhere:
 *
 *   spec/vectors/                        tracked, canonical, in every clone
 *   typescript/test/conformance/vectors/ GITIGNORED — a copy that
 *                                        scripts/prepare-publish.sh makes for
 *                                        `npm pack`
 *
 * The prose says the vectors "ship in the npm package", which points at the
 * copy — so the naive reading is to count the copy. A check keyed there passes
 * on any machine that has ever packed and is red on its first CI run, because a
 * fresh checkout correctly does not have that directory. Every path read below
 * is tracked and present in every checkout. conformance.test.ts resolves
 * spec/vectors/ the same way, for the same reason.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const VECTORS_DIR = join(REPO_ROOT, 'spec', 'vectors');

/**
 * The canonical claim phrasing, held as a SOURCE STRING rather than a shared
 * RegExp object. A regex carrying /g is stateful (`lastIndex`), and
 * `expect(...).toMatch(re)` calls `.test()` internally, which advances that
 * state — sharing one global regex across `matchAll` and `toMatch` makes
 * results depend on assertion order, which is an intermittent false green.
 * Every use below builds a fresh regex.
 *
 * Keeping the phrasing identical in both documents is deliberate: it is what
 * lets one narrow pattern cover them, instead of a loose pattern that would
 * match numbers it was never meant to.
 */
const CLAIM_PATTERN = String.raw`(\d+)\s+vectors\s+across\s+(\d+)\s+files`;
const claimsIn = (text: string) => [...text.matchAll(new RegExp(CLAIM_PATTERN, 'g'))];

/**
 * Documents that state the count, and the minimum number of times each must
 * state it. The minimum is the anti-vacuum guard: without it, rewording a
 * sentence yields zero matches, zero comparisons, and a green test that has
 * verified nothing.
 */
const DOCS = [
  { label: 'docs/specification.md', rel: ['docs', 'specification.md'], minClaims: 2 },
  { label: 'README.md', rel: ['README.md'], minClaims: 1 },
] as const;

function actualCounts(): { files: number; vectors: number } {
  const files = readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  let vectors = 0;
  for (const f of files) {
    const parsed: unknown = JSON.parse(readFileSync(join(VECTORS_DIR, f), 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(
        `spec/vectors/${f} is not a top-level JSON array — this test counts array ` +
          `entries and would silently undercount a different shape.`,
      );
    }
    vectors += parsed.length;
  }

  return { files: files.length, vectors };
}

describe('conformance-vector counts stated in prose', () => {
  const actual = actualCounts();

  it('spec/vectors/ is non-empty (guards against counting nothing)', () => {
    expect(actual.files).toBeGreaterThan(0);
    expect(actual.vectors).toBeGreaterThan(0);
  });

  for (const doc of DOCS) {
    const path = join(REPO_ROOT, ...doc.rel);

    it(`${doc.label} states the count at least ${doc.minClaims}x`, () => {
      const claims = claimsIn(readFileSync(path, 'utf8'));
      expect(
        claims.length,
        `expected the "<N> vectors across <M> files" claim at least ${doc.minClaims} ` +
          `time(s) in ${doc.label}. If the wording changed deliberately, update ` +
          `CLAIM_PATTERN in this file — do not delete the assertion, or this check ` +
          `silently stops checking.`,
      ).toBeGreaterThanOrEqual(doc.minClaims);
    });

    it(`${doc.label} counts match spec/vectors/ on disk`, () => {
      const claims = claimsIn(readFileSync(path, 'utf8')).map((m) => ({
        vectors: Number(m[1]),
        files: Number(m[2]),
      }));
      for (const claim of claims) {
        expect(claim).toEqual({ vectors: actual.vectors, files: actual.files });
      }
    });
  }

  it('specification.md §13 still binds conformance to the vector set', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'specification.md'), 'utf8');

    // indexOf returning -1 must fail loudly. `slice(-1)` hands back the
    // document's last character, which is a non-empty string, so a "not empty"
    // assertion would PASS on a missing section.
    const start = doc.indexOf('## 13. Conformance');
    expect(start, 'the "## 13. Conformance" heading is gone from the spec').toBeGreaterThan(-1);

    const section = doc.slice(start);
    expect(section).toMatch(/conformance test vector/i);
    expect(section).toMatch(new RegExp(CLAIM_PATTERN));
  });
});
