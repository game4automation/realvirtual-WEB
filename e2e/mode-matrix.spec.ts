// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The mode-switch matrix (plan-601 F2, tests 9.3 / 9.4).
 *
 * The matrix is **generated** from `viewer.modes.list()`
 * (`src/core/rv-mode-manager.ts:150`), so it keeps itself up to date: a newly
 * registered mode is covered the next time the spec runs, and the spec names
 * no mode count anywhere. N x (N-1) ordered pairs, on the dev default document
 * `DemoRealvirtualWeb.glb` — never a customer project.
 *
 * **The success contract (plan 2.2), and it is deliberately strict:**
 *
 * | Step | Condition |
 * |---|---|
 * | precondition | `viewer.modes.lockedMode === null` — CHECKED, not assumed (`main.ts` can lock a document by configuration) |
 * | establish `from` | `requestMode(from) === true` **and** `activeMode === from` |
 * | request `to` | `requestMode(to) === true` |
 * | measure success | `activeMode === to` after a rendered frame |
 * | trail | no `[rv-invariants]` line, no error-severity Problems entry |
 *
 * `requestMode` is the guarded, user-facing path (`rv-mode-manager.ts:185`);
 * `list()` returns REGISTERED modes, not enterable ones, which is exactly why
 * success is measured on `activeMode` and never on the requested value.
 *
 * **A rejection is a FAILURE here, not an expectation.** "A rejection is not an
 * error" would make every broken switch green. Rejections are expected in
 * exactly one place: the deliberately locked / guarded workspace in test 9.4
 * below.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect, type Page } from 'playwright/test';
import { watchJourney } from './_journey';
import { waitForViewerReady } from './_viewer-ready';

/** The dev project's default document — named explicitly, never implied. */
const DEMO_URL = '/?model=DemoRealvirtualWeb.glb';

/** The registered modes, in dropdown order. */
async function listModes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).viewer.modes.list().map((m: any) => m.id));
}

async function activeMode(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).viewer.modes.activeMode ?? null);
}

async function lockedMode(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).viewer.modes.lockedMode ?? null);
}

/** The guarded, user-facing switch — the path a dropdown click takes. */
async function requestMode(page: Page, id: string): Promise<boolean> {
  return page.evaluate((m: string) => (window as any).viewer.modes.requestMode(m), id);
}

/** Error-severity Problems entries, as `code` strings (the snapshot's projection). */
async function errorProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).viewer.collectStateSnapshot().problems);
}

test('every registered mode pair switches successfully', async ({ page }) => {
  test.setTimeout(900_000);

  const journey = watchJourney(page);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  const modes = await listModes(page);
  console.log(`[mode-matrix] ${modes.length} registered modes: ${modes.join(', ')} -> ${modes.length * (modes.length - 1)} pairs`);
  expect(modes.length, 'a matrix needs at least two registered modes').toBeGreaterThan(1);

  // ── Warm-up: enter every mode once, so the ONE-TIME lazy allocations of the
  //    modes exist before anything is measured.
  //
  // MEASURED 2026-10-14 on `DemoRealvirtualWeb.glb`: the first visit to `des`,
  // `planner` or `commissioning` creates the node
  // `DemoRealvirtualWebglb/Simulation`, which is NOT removed when the mode is
  // left — returning to `viewer` reads 315 -> 316 and I2 reports it. It is
  // created exactly once (every later cycle stays at 316), so it is a lazy
  // global, not a growing leak — but without this warm-up the matrix would
  // report that first allocation instead of the switches it exists to check.
  // Reported as a product finding (plan-601 Phase 2); the contract below is
  // NOT weakened: after the warm-up the matrix demands exact zero.
  // TWO passes, and the second one is not redundant: I2 records a mode's node
  // count when that mode is ENTERED, so a mode visited before the lazy node
  // existed carries the old count until it is entered again. One pass left
  // `viewer` and `hmi` with their pre-allocation numbers and the matrix read
  // 315 -> 316 for both.
  for (let pass = 0; pass < 2; pass++) {
    for (const mode of modes) {
      expect(await requestMode(page, mode), `warm-up requestMode('${mode}') must be accepted`).toBe(true);
      await journey.settle();
      expect(await activeMode(page), `warm-up must establish '${mode}'`).toBe(mode);
    }
  }
  const warmUpFindings = journey.invariantViolations();
  console.log(`[mode-matrix] warm-up findings (one-time lazy allocations): ${JSON.stringify(warmUpFindings)}`);
  journey.reset();

  for (const from of modes) {
    for (const to of modes) {
      if (from === to) continue;
      await test.step(`${from} -> ${to}`, async () => {
        // 1. Precondition — a locked workspace cannot carry the matrix.
        expect(await lockedMode(page), 'the matrix runs only on an unlocked document').toBeNull();

        // 2. Establish `from` AND prove it: an unestablished starting state
        //    makes the pair meaningless.
        expect(await requestMode(page, from), `requestMode('${from}') must be accepted`).toBe(true);
        await journey.settle();
        expect(await activeMode(page), `the starting mode '${from}' must be established`).toBe(from);

        // 3. Request the target.
        expect(await requestMode(page, to), `requestMode('${to}') must be accepted`).toBe(true);

        // 4. Measure success where it is defined: on `activeMode`.
        await journey.settle();
        expect(await activeMode(page), `'${to}' must be active after the switch`).toBe(to);

        // 5. Trail. I1 / I3 / I4 / I5 must be silent with zero tolerance.
        //    I2 is taken out of the PAIR check and asserted below in its own
        //    comparison geometry — see the I2 note under the loop.
        expect(nonI2(journey.invariantViolations()), `invariant violation around ${from} -> ${to}`).toEqual([]);
        expect(await errorProblems(page), `Problems entry around ${from} -> ${to}`).toEqual([]);
      });
    }
  }

  // ── I2 in the geometry it was built for (plan deviation, measured) ───────
  //
  // I2 records a mode's node count AT `mode-changed` and compares the next
  // entry into the same UI state against it (`rv-invariants.ts`
  // `checkNodeCountDrift`). That is a statement about a RETURN with the same
  // predecessor. In a generated matrix every mode is entered N-1 times from
  // N-1 different predecessors, and the modes allocate and free their nodes
  // LAZILY AFTER the switch — the layer's own documentation measures exactly
  // that for `commissioning` (315 -> 317 one frame later). MEASURED 2026-10-14
  // on `DemoRealvirtualWeb.glb`: the matrix therefore produces entry-time
  // artifacts such as `I2 nodeCount: 319 -> 316 (returning to
  // planner|-|layout-planner)` — a DROP, not growth, and not a leak.
  //
  // So I2 is asserted where it is well defined: a doubled return cycle per
  // mode, both returns from the same neighbour. The requirement there is exact
  // zero, no tolerance. The artifacts of the matrix are logged, never asserted
  // away silently.
  const i2Artifacts = journey.invariantViolations().filter((e) => e.includes('I2'));
  console.log(`[mode-matrix] I2 entry-time artifacts during the matrix: ${JSON.stringify(i2Artifacts)}`);
  journey.reset();

  for (const home of modes) {
    const neighbour = modes.find((m) => m !== home)!;
    await test.step(`return cycle ${home} <-> ${neighbour} (x2)`, async () => {
      for (let i = 0; i < 2; i++) {
        for (const mode of [neighbour, home]) {
          expect(await requestMode(page, mode), `requestMode('${mode}') must be accepted`).toBe(true);
          await journey.settle();
          expect(await activeMode(page)).toBe(mode);
        }
      }
      // The first return records, the second compares — so the second cycle
      // is the one that must be silent.
      expect(journey.invariantViolations(), `drift over the return cycle ${home} <-> ${neighbour}`).toEqual([]);
    });
    journey.reset();
  }

  await journey.assertClean();
});

/** Invariant lines other than I2 — see the I2 note in the matrix test. */
function nonI2(lines: readonly string[]): string[] {
  return lines.filter((e) => !/\bI2\b/.test(e));
}

/**
 * plan-601 test 9.4 — the ONLY place a rejection is expected.
 *
 * Both guarded paths are exercised with a DELIBERATELY installed obstacle:
 * `lock()` (the kiosk / single-purpose deployment) and a registered exit guard
 * (the asset editor's unsaved-changes veto). In both cases the switch must be
 * refused, the old mode must stay active, and the workspace must still be
 * operable — proven by removing the obstacle and switching for real.
 */
test('a locked or guarded workspace rejects a mode switch', async ({ page }) => {
  test.setTimeout(300_000);

  const journey = watchJourney(page);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  const modes = await listModes(page);
  const home = await activeMode(page);
  expect(home, 'the document must boot into a mode').not.toBeNull();
  const other = modes.find((m) => m !== home);
  expect(other, 'a second registered mode is needed to be refused').toBeTruthy();

  // ── (a) lock() ──────────────────────────────────────────────────────────
  await page.evaluate((m: string) => (window as any).viewer.modes.lock(m), home!);
  expect(await lockedMode(page)).toBe(home);

  expect(await requestMode(page, other!), 'a locked workspace must refuse a foreign mode').toBe(false);
  await journey.settle();
  expect(await activeMode(page), 'a refused switch must leave the mode untouched').toBe(home);
  // The workspace is still operable: the locked mode itself is accepted and
  // the canvas is still there.
  expect(await requestMode(page, home!), 'the locked mode itself stays requestable').toBe(true);
  await expect(page.locator('canvas').first()).toBeVisible();

  await page.evaluate(() => (window as any).viewer.modes.unlock());
  expect(await lockedMode(page)).toBeNull();

  // ── (b) a vetoing exit guard ────────────────────────────────────────────
  await page.evaluate((m: string) => {
    const modesApi = (window as any).viewer.modes;
    (window as any).__rv601Unguard = modesApi.registerExitGuard(m, () => false);
  }, home!);

  expect(await requestMode(page, other!), 'a vetoing exit guard must refuse the switch').toBe(false);
  await journey.settle();
  expect(await activeMode(page), 'a vetoed switch must leave the mode untouched').toBe(home);

  await page.evaluate(() => { (window as any).__rv601Unguard(); delete (window as any).__rv601Unguard; });

  // ── Operable again: the same switch now goes through. ───────────────────
  expect(await requestMode(page, other!), 'without lock and guard the switch must work').toBe(true);
  await journey.settle();
  expect(await activeMode(page)).toBe(other);

  await journey.assertClean();
});
