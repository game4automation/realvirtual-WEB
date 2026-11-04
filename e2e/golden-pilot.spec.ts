// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.12 / F6 — the golden mechanic proven on the pilot document
 * `DemoRealvirtualWeb.glb`: three checked-in goldens taken at defined
 * simulation states, compared in FRESH runs; a deliberately moved drive makes
 * it red; a missing golden makes it red.
 *
 * Note on `selection`: inside the test clock the capture clears the selection
 * (`src/core/rv-viewer.ts:7400`), so these goldens legitimately expect an empty
 * one. That is a property of the clock, not a special case in the collector.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect } from 'playwright/test';
import { advanceSimSeconds, withTestClock } from './_clock';
import { expectGolden, goldensAreUpdating } from './_golden';
import { waitForViewerReady } from './_viewer-ready';

/** The three states the goldens pin, in simulation seconds from the reset. */
const STEPS: ReadonlyArray<{ name: string; seconds: number }> = [
  { name: 'start', seconds: 0 },
  { name: 'after-2s', seconds: 2 },
  { name: 'after-10s', seconds: 8 },
];

/** Reads the snapshot through THE one collector exposed on the viewer. */
async function snapshot(page: import('playwright/test').Page): Promise<unknown> {
  return page.evaluate(() => (window as any).viewer.collectStateSnapshot());
}

test('F6: three state goldens of the pilot document', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  await withTestClock(page, async () => {
    for (const step of STEPS) {
      if (step.seconds > 0) await advanceSimSeconds(page, step.seconds);
      expectGolden(`golden-pilot/${step.name}`, await snapshot(page));
    }
  });
});

test('F6: a moved drive makes the golden red', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(goldensAreUpdating(), 'would record the tampered state as the golden');

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  await withTestClock(page, async () => {
    // Untampered first — the baseline must hold in THIS run too, otherwise a
    // red below would prove nothing.
    expectGolden('golden-pilot/start', await snapshot(page));

    const moved = await page.evaluate(() => {
      const v = (window as any).viewer;
      const drive = v.drives?.[0];
      if (!drive) return null;
      drive.currentPosition += 123.456;
      return drive.name as string;
    });
    expect(moved, 'the pilot document must have at least one drive').toBeTruthy();

    expect(() => expectGolden('golden-pilot/start', undefined), 'a tampered state must not match')
      .toThrow();
    const tampered = await snapshot(page);
    expect(() => expectGolden('golden-pilot/start', tampered), `moving ${moved} must make the golden red`)
      .toThrow();
  });
});

test('F6: a missing golden is red and is not created silently', async () => {
  test.skip(goldensAreUpdating(), 'RV_UPDATE_GOLDENS=1 creates goldens by design');
  expect(() => expectGolden('golden-pilot/__does-not-exist__', { a: 1 }))
    .toThrow(/does not exist/);
});
