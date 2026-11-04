// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-779 — the convention about absolute bundle budgets, as a test instead of as prose.
 *
 * ## Why this file exists
 *
 * On 08.08.2026 the entry-budget comment in `bundle-splitting.test.ts` wrote down a lesson:
 * *"Never add two branch-local absolute measurements again; measure both against their
 * merge-base."* On 22.10.2026, in that same comment block, the budget was pinned from
 * `fedb6670` — a commit on `feature/plan-652-lazy-feature-plugins` that did NOT contain
 * `bf533461`, the path-network planner UI merged to main 2 h 20 min earlier. The pin was
 * therefore over budget on the day it was written, and the comment even noticed the trunk
 * had grown and pinned the branch number anyway.
 *
 * A convention nobody has to pass is a convention that gets broken. These assertions are the
 * same rule in a position where it has to be answered:
 *
 *  - every pin carries the commit its measurement came from, and whether that commit sat on
 *    the merge target;
 *  - the commit is CHECKED against git, not believed: `git merge-base --is-ancestor <commit>
 *    <mergeTarget>`. A pin measured on a feature branch fails here while it is being made,
 *    which is the only moment the fix is cheap;
 *  - a budget may not sit far above the measurement it was pinned from, because a budget with
 *    20 % air in it is a number that no longer guards anything;
 *  - each pin names a guard, and that guard must really read the pin — otherwise this file
 *    becomes a collection of numbers nothing consumes.
 *
 * No build, no network: it reads one JSON file and asks git about commits.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import BUDGETS from './bundle-budgets.json';

const ROOT = resolve(__dirname, '..');

interface Pin {
  what: string;
  guard: string;
  budgetBytes: number;
  measuredBytes: number;
  measuredAt: { commit: string; date: string; onMergeTarget: boolean; how: string };
}

const PINS = BUDGETS.pins as unknown as Record<string, Pin>;
const MERGE_TARGET: string = BUDGETS.mergeTarget;

/** Max air between a budget and the measurement it was pinned from. */
const MAX_HEADROOM = 0.05;

/**
 * The trunk is `origin/<mergeTarget>`, not the bare branch name.
 *
 * Measured 2026-10-27: in a plan worktree the LOCAL `main` ref was 3d89e9f4 while
 * `origin/main` was 69bf8f9e, so `git merge-base --is-ancestor fd44db27 main` said
 * no about a commit that has been on the trunk for a day. Two truthful pin records
 * were reported as measured off-trunk, and the stated remedy — "re-measure on main
 * and pin that number" — would have replaced a correct record with a new build and
 * left the next worktree failing all the same.
 *
 * Preferring the remote-tracking ref is also STRICTER, not laxer: a local branch may
 * be stale (false red, the case above) and it may equally carry unpushed commits
 * (false green — a budget pinned on a tree nobody else has). `origin/<target>` is
 * the one tree every other checkout will actually build. The bare name stays as the
 * fallback for a checkout with no remote at all, and `null` keeps the existing
 * "not refutable here" branch intact.
 */
function resolveMergeTarget(): { ref: string; resolved: boolean } {
  for (const ref of [`origin/${MERGE_TARGET}`, MERGE_TARGET]) {
    if (git(['rev-parse', '--verify', `${ref}^{commit}`]) !== null) return { ref, resolved: true };
  }
  return { ref: MERGE_TARGET, resolved: false };
}

/** `git` in this repo, or null when the question cannot be asked here at all. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

describe('bundle budgets: the pin records are complete and plausible', () => {
  it('there is at least one pin, and the merge target is named', () => {
    expect(Object.keys(PINS).length).toBeGreaterThan(0);
    expect(MERGE_TARGET).toMatch(/^[\w./-]+$/);
  });

  for (const [id, pin] of Object.entries(PINS)) {
    it(`${id}: the record is complete`, () => {
      expect(pin.what, 'a pin must say WHICH artifact it measures').toBeTruthy();
      expect(pin.guard, 'a pin must name the guard that reads it').toBeTruthy();
      expect(Number.isInteger(pin.budgetBytes) && pin.budgetBytes > 0).toBe(true);
      expect(Number.isInteger(pin.measuredBytes) && pin.measuredBytes > 0).toBe(true);
      expect(pin.measuredAt.commit, `${id}: measuredAt.commit must be a git sha`).toMatch(/^[0-9a-f]{7,40}$/);
      expect(pin.measuredAt.date, `${id}: measuredAt.date must be ISO yyyy-mm-dd`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof pin.measuredAt.onMergeTarget, `${id}: measuredAt.onMergeTarget must be declared`).toBe('boolean');
      expect(pin.measuredAt.how, `${id}: measuredAt.how must say how it was measured`).toBeTruthy();
    });

    it(`${id}: the budget sits just above its measurement, not far above it`, () => {
      expect(
        pin.budgetBytes,
        `${id}: the budget is BELOW the measurement it was pinned from — one of the two numbers is wrong`,
      ).toBeGreaterThanOrEqual(pin.measuredBytes);
      const headroom = (pin.budgetBytes - pin.measuredBytes) / pin.measuredBytes;
      expect(
        headroom,
        `${id}: ${(headroom * 100).toFixed(1)} % air between measurement and budget. A budget that far above`
        + ' what was measured guards nothing — pin it just above the measurement (the history in'
        + ' bundle-splitting.test.ts uses ~2 %), or say in `note` why this one needs more.',
      ).toBeLessThanOrEqual(MAX_HEADROOM);
    });

    it(`${id}: the guard it names actually reads this pin`, () => {
      // Positive assertion over source: the guard file must mention the pin's key. (It may not
      // depend on distances or on neighbouring prose — it is a plain containment check, and the
      // string it looks for is the key, which is also what the consumer indexes with.)
      const file = pin.guard.split(/\s+/)[0];
      const text = readFileSync(resolve(ROOT, file), 'utf8');
      expect(text, `${file} does not mention the pin '${id}' — the record and its consumer have drifted`)
        .toContain(id);
    });

    it(`${id}: the record declares the measurement was taken on the merge target`, () => {
      // Asserted on its own, and NOT only when git cannot answer. A branch commit becomes an
      // ancestor of the trunk the moment the branch is merged, so the git check below goes green
      // retroactively — it bites while the pin is being made (the useful moment) and forgets
      // afterwards. The declaration is what keeps a known-bad pin visible until someone actually
      // re-measures: `entry-chunk` is red here as of 25.10.2026 by exactly that history, and it
      // clears when the entry is re-pinned from a build of main, not when the branch is merged.
      expect(
        pin.measuredAt.onMergeTarget,
        `${id}: the record says this budget was measured at ${pin.measuredAt.commit}, which was not on`
        + ` ${MERGE_TARGET} (${pin.measuredAt.how}). Such a number is missing everything that had already`
        + ` been merged to ${MERGE_TARGET} — re-measure on ${MERGE_TARGET} and pin that, then set`
        + ' onMergeTarget: true. Do not flip the flag without re-measuring.',
      ).toBe(true);
    });

    it(`${id}: git agrees that the pin commit is on the merge target`, () => {
      const commit = pin.measuredAt.commit;
      const known = git(['cat-file', '-e', `${commit}^{commit}`]) !== null;
      const target = resolveMergeTarget();
      const targetKnown = target.resolved;

      if (known && targetKnown) {
        // The refutable case, and the one that matters: git can answer, so believe git and not
        // the record. `--is-ancestor` exits 0 when <commit> is contained in <mergeTarget> — i.e.
        // when the measurement was taken on a tree the trunk actually has.
        const isAncestor = git(['merge-base', '--is-ancestor', commit, target.ref]) !== null;
        expect(
          isAncestor,
          `${id}: pinned at ${commit}, which is NOT on ${target.ref}. An absolute budget measured`
          + ' on a feature branch is measured on a tree the trunk does not have: everything merged to'
          + ` ${target.ref} in the meantime is missing from it, which is exactly how the entry budget`
          + ' was already violated on the day it was pinned (22.10.2026, see bundle-budgets.json $note).'
          + ` Re-measure on ${target.ref} and pin that number.`,
        ).toBe(true);
        return;
      }

      // Not refutable here (shallow clone, another machine, the commit garbage-collected, no git
      // at all). The declaration has its own assertion above, so there is nothing left to check —
      // and nothing is quietly skipped either: this case is only ever reached when the previous
      // test already passed on the record's own statement.
      console.warn(
        `[bundle-budget-provenance] ${id}: ${commit} or ${target.ref} is unknown in this checkout — `
        + 'the git cross-check could not be run; the declaration assertion above stands alone here.',
      );
    });
  }
});
