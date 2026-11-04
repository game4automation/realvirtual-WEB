// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The test clock's own contract (plan-600 F3/F4, tests 9.13 and 9.16).
 *
 * F3 is proven HERE and with the FINAL helper, not with the spike's: two fresh
 * runs, UNROUNDED drive positions and transport counters compared at every
 * intermediate state. The spike rounded to six decimals and rendered once per
 * block of 60-600 ticks; this driver renders every 2 ticks, so its determinism
 * had to be shown again.
 *
 * F4 is proven by the failure paths: a `captureRenderFrame` that returns
 * `false` and a set `captureAbortReason` must make a test FAIL, not let it
 * fast-forward into the void.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect } from 'playwright/test';
import {
  FIXED_STEP_HZ,
  STEPS_PER_FRAME,
  advanceSim,
  armTestClock,
  readSimState,
  releaseTestClock,
  withTestClock,
  type SimState,
} from './_clock';
import { waitForViewerReady } from './_viewer-ready';

test.describe.configure({ mode: 'serial' });

/** Step blocks the two determinism runs walk — unequal on purpose. */
const STEP_SEQUENCE = [60, 60, 120, 300, 600];

/** Filled by the two determinism runs (fresh context each), compared in the third. */
const runs: Array<{ label: string; states: SimState[] }> = [];

async function determinismRun(page: import('playwright/test').Page, label: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  const states: SimState[] = [];
  await withTestClock(page, async () => {
    for (const steps of STEP_SEQUENCE) {
      await advanceSim(page, steps);
      states.push(await readSimState(page));
    }
  });
  runs.push({ label, states });
}

test('determinism run A', async ({ page }) => {
  test.setTimeout(180_000);
  await determinismRun(page, 'A');
  expect(runs[0].states).toHaveLength(STEP_SEQUENCE.length);
});

test('determinism run B', async ({ page }) => {
  test.setTimeout(180_000);
  await determinismRun(page, 'B');
  expect(runs[1].states).toHaveLength(STEP_SEQUENCE.length);
});

test('F3: two fresh runs are identical, unrounded, at every intermediate state', async () => {
  const [a, b] = runs;
  expect(a, 'determinism run A must have completed').toBeTruthy();
  expect(b, 'determinism run B must have completed').toBeTruthy();

  for (let i = 0; i < STEP_SEQUENCE.length; i++) {
    const sa = a.states[i];
    const sb = b.states[i];
    // Unrounded, field by field — a message that names the step and the drive.
    expect(sa.ticks, `tick count at state ${i}`).toBe(sb.ticks);
    expect(sa.simTime, `simTime at state ${i}`).toBe(sb.simTime);
    expect(sa.transport, `transport at state ${i}`).toEqual(sb.transport);
    expect(Object.keys(sa.drives).sort(), `drive set at state ${i}`).toEqual(Object.keys(sb.drives).sort());
    for (const name of Object.keys(sa.drives)) {
      expect(sa.drives[name], `drive ${name} at state ${i}`).toBe(sb.drives[name]);
    }
  }

  const last = a.states[a.states.length - 1];
  const totalSteps = STEP_SEQUENCE.reduce((s, n) => s + n, 0);
  // Ticks SINCE arming — `resetSimulation()` zeroes simTime but not
  // simTickCount, whose absolute value still holds the wall-clock-bound live
  // phase (measured 819 vs. 1007 on these two runs).
  expect(last.ticks).toBe(totalSteps);
  expect(last.simTime).toBeCloseTo(totalSteps / FIXED_STEP_HZ, 9);
  console.log(`[clock] F3 identical over ${Object.keys(last.drives).length} drives x ${STEP_SEQUENCE.length} states`);
});

test('9.16: step counts are exact, remainder blocks render, calls compose', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  await withTestClock(page, async () => {
    // advanceSim(0): no tick, and no frame either.
    const zero = await advanceSim(page, 0);
    expect(zero).toMatchObject({ steps: 0, frames: 0, totalSteps: 0, totalFrames: 0, nextTimeSec: 0 });
    expect(zero.ticks).toBe(0);

    // advanceSim(1): one tick, one (full-block-sized) frame.
    const one = await advanceSim(page, 1);
    expect(one.steps).toBe(1);
    expect(one.frames).toBe(1);
    expect(one.ticks).toBe(1);
    expect(one.nextTimeSec).toBeCloseTo(1 / FIXED_STEP_HZ, 12);

    // An ODD count: 5 steps = 2 + 2 + 1, and the smaller trailing block is
    // rendered too — otherwise the last tick would never reach the screen and
    // two calls would stop composing.
    const odd = await advanceSim(page, 5);
    expect(odd.steps).toBe(5);
    expect(odd.frames).toBe(Math.ceil(5 / STEPS_PER_FRAME));
    expect(odd.totalSteps).toBe(6);
    expect(odd.ticks).toBe(6);
    expect(odd.nextTimeSec).toBeCloseTo(6 / FIXED_STEP_HZ, 12);

    // Two consecutive calls: render time keeps running, totals accumulate.
    const next = await advanceSim(page, 4);
    expect(next.totalSteps).toBe(10);
    expect(next.ticks).toBe(10);
    expect(next.nextTimeSec).toBeCloseTo(10 / FIXED_STEP_HZ, 12);
    expect(next.nextTimeSec).toBeGreaterThan(odd.nextTimeSec);
  });
});

test('F4: a failing captureRenderFrame makes the test fail', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  await armTestClock(page);
  try {
    // Force the documented failure return (rv-viewer.ts:7471 "Returns false
    // when the frame failed — the caller aborts").
    await page.evaluate(() => {
      const v = (window as any).viewer;
      v.captureRenderFrame = () => false;
    });
    await expect(advanceSim(page, STEPS_PER_FRAME)).rejects.toThrow(/captureRenderFrame failed/);
  } finally {
    await releaseTestClock(page);
  }
});

test('F4: a set captureAbortReason makes the test fail', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  await armTestClock(page);
  try {
    // A model change inside the capture sets the reason (rv-viewer.ts:5151) but
    // enforces NOTHING: captureStep keeps counting and captureRenderFrame keeps
    // returning true. The helper's check is the only brake.
    const reason = await page.evaluate(() => {
      const v = (window as any).viewer;
      v.clearModel();
      return v.captureAbortReason ?? null;
    });
    expect(reason, 'a model change inside the capture must set an abort reason').toBeTruthy();
    await expect(advanceSim(page, STEPS_PER_FRAME)).rejects.toThrow(/capture was aborted/);
  } finally {
    await releaseTestClock(page);
  }
});

test('F4: the preflight reason is surfaced instead of a silent no-op', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  await armTestClock(page);
  try {
    // The exclusive lock: a second arm must name the reason, not arm quietly.
    await expect(armTestClock(page)).rejects.toThrow(/already armed/);
  } finally {
    await releaseTestClock(page);
  }

  // And after the release the clock can be armed again.
  await withTestClock(page, async () => {
    const r = await advanceSim(page, 2);
    expect(r.steps).toBe(2);
  });
});
