// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-395 §2.11 — the expectation set stays honest.
 *
 * `tests/dev-asset-dependent-tests.json` is the checked-in answer to "which
 * tests load an internal asset". Two gates consume it, and both run a full
 * browser suite, which is minutes, not seconds:
 *
 *  - `suite_ExpectedIdsPassWithSibling` — with the private sibling, every id in
 *    the set is `passed`;
 *  - `suite_ExactlyExpectedIdsSkipWithoutSibling` — with `RV_NO_PRIVATE=1`,
 *    exactly that set is `skipped`.
 *
 * Both are run through `node scripts/gen-dev-asset-dependent-tests.mjs --verify
 * <report.json>`, because a vitest test that shells out two twenty-minute
 * vitest runs is a test nobody ever runs.
 *
 * What runs HERE, cheaply, every time, is the property those two gates depend
 * on and cannot check for themselves: that the file has not quietly gone stale.
 * A set that silently shrinks is exactly as dangerous as the mass-skip it was
 * built to catch — the guard would pass, over a set that no longer describes
 * anything.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTATIONS = resolve(REPO, 'tests/dev-asset-dependent-tests.json');

// The coverage check interrogates the publisher's git index. The community
// precheck stages the tracked files without `.git` (deliberate mirror
// fidelity), where `git ls-files` cannot answer — and a community clone only
// ever received tracked files, so the check is trivially satisfied there.
const IN_GIT_REPO = existsSync(resolve(REPO, '.git'));

interface Expectations {
  devAssetDependent: string[];
  knownFailing: { files: string[]; measured: string };
}

const load = (): Expectations => JSON.parse(readFileSync(EXPECTATIONS, 'utf8')) as Expectations;

/** The file half of an id (`tests/x.test.ts :: suite > title`). */
const fileOf = (id: string): string => id.split(' :: ')[0];

describe('devAssetDependent expectation set (plan-395 §2.11)', () => {
  it('exists and is not empty', () => {
    // The vacuous-pass check. An empty set makes both real gates trivially
    // true, which is precisely how a guard stops guarding.
    expect(existsSync(EXPECTATIONS), `${EXPECTATIONS} must be checked in`).toBe(true);
    expect(load().devAssetDependent.length).toBeGreaterThan(0);
  });

  it('is sorted and free of duplicates, so its diff is readable', () => {
    // Not cosmetic: the whole value of a checked-in set is that a change to it
    // shows up as a reviewable diff. Unsorted entries turn that into noise.
    const ids = load().devAssetDependent;
    expect([...new Set(ids)].length, 'duplicate ids').toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it('names only files that still exist and still carry the skip mechanic', () => {
    const stale = [...new Set(load().devAssetDependent.map(fileOf))].filter((file) => {
      const abs = resolve(REPO, file);
      if (!existsSync(abs)) return true;
      return !readFileSync(abs, 'utf8').includes('dev-asset-available');
    });
    expect(
      stale,
      'these are listed as dev-asset-dependent but no longer are (moved, renamed, or the '
      + 'skip mechanic was removed). Regenerate: node scripts/gen-dev-asset-dependent-tests.mjs '
      + '<report.json>',
    ).toEqual([]);
  });

  it.skipIf(!IN_GIT_REPO)('covers every browser test file that carries the skip mechanic', () => {
    // The direction that matters most. A file gaining the mechanic without
    // entering the set means the "exactly this set skips" gate would see it
    // skip and call that a regression — or, worse, the set is regenerated from
    // a run in which it already skipped, freezing the damage in.
    // Through git rather than a glob: it lists files and only files, it is what
    // the other plan-395 guards use, and it agrees with what actually ships.
    const carrying = execFileSync('git', ['-C', REPO, 'ls-files', 'tests'], { encoding: 'utf8' })
      .split('\n').map(l => l.trim()).filter(Boolean)
      .filter(f => f.endsWith('.test.ts') && !f.endsWith('.node.test.ts'))
      // The probe's own test carries the helper but must run in both worlds, so
      // it is deliberately not in the set (same exclusion as the generator).
      .filter(f => !f.endsWith('dev-asset-probe.test.ts'))
      .filter(f => readFileSync(resolve(REPO, f), 'utf8').includes('dev-asset-available'));

    const listed = new Set(load().devAssetDependent.map(fileOf));
    const missing = carrying.filter(f => !listed.has(f));

    expect(
      missing,
      'these carry the skip mechanic but are not in the expectation set. Regenerate it from a '
      + 'green run WITH the private sibling: npx vitest run --reporter=json --outputFile=r.json '
      + '&& node scripts/gen-dev-asset-dependent-tests.mjs r.json',
    ).toEqual([]);
  });

  it('records the known-failing set with a measurement date', () => {
    // The set exists so the guard is not red on day one and switched off in
    // week one. It is only defensible while it is dated and small.
    const { knownFailing } = load();
    expect(Array.isArray(knownFailing.files)).toBe(true);
    expect(knownFailing.measured).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
