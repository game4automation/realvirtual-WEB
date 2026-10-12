// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-503 §2.5 / §9.5: LOCAL calibration of the HMI journey's motion
 * threshold (`MOTION_THRESHOLD`, e2e/_motion.ts). Runs in the `chromium`
 * project against the dev server — NEVER in `prod-demo`: it pauses the
 * simulation through `window.viewer`, which the live journey must not do
 * (decision log: live journeys are read-only and visitor-like).
 *
 * Three measurements with the journey's own clip and frames:
 *   - moving   : the demo runs by itself → max ratio ABOVE the threshold;
 *   - paused   : `setSimulationPaused('plan-503-calibration', true)` → the same
 *                machine clip stays BELOW it (renderer noise floor);
 *   - empty    : a clip of the same size away from the machine, running → BELOW.
 * The ratios are attached as `calibration` and logged, so a changed renderer or
 * demo shows up here first.
 */

import { expect, test } from 'playwright/test';
import { captureMotion, machineClip, MOTION_THRESHOLD, type Clip } from '../_motion';
import { blockAnalytics, waitForViewerReady } from '../_viewer-ready';

/** The public HMI demo (`demos.hmi` of public/demo-realvirtual/project.json). */
const HMI_DOC = 'doc_demorealvirtualweb_7l7hfw';

test('motion threshold separates the running demo from a still image', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await blockAnalytics(page);
  await page.goto(`/?doc=${HMI_DOC}`, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  await page.waitForTimeout(2_000);

  const { clip, drives } = await machineClip(page);
  expect(drives.length, 'no drive moves on its own — the demo does not run').toBeGreaterThan(0);
  const moving = await captureMotion(page, testInfo, clip, 'moving');

  // An equally sized clip in the canvas' upper band, left of or right of the machine.
  const canvas = await page.evaluate(() => {
    const r = (window as unknown as { viewer: { renderer: { domElement: HTMLCanvasElement } } }).viewer.renderer.domElement.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  const w = Math.min(clip.width, 200);
  const h = Math.min(clip.height, 120);
  const emptyX = clip.x - canvas.left > w + 10 ? Math.floor(canvas.left + 5) : Math.floor(canvas.right - w - 5);
  const empty: Clip = { x: emptyX, y: Math.floor(canvas.top + 5), width: w, height: h };
  const overlapsMachine = empty.x < clip.x + clip.width && empty.x + empty.width > clip.x
    && empty.y < clip.y + clip.height && empty.y + empty.height > clip.y;
  const still = await captureMotion(page, testInfo, empty, 'empty');

  await page.evaluate(() => (window as unknown as { viewer: { setSimulationPaused(reason: string, paused: boolean): void } })
    .viewer.setSimulationPaused('plan-503-calibration', true));
  await page.waitForTimeout(1_000);
  const paused = await captureMotion(page, testInfo, clip, 'paused');
  await page.evaluate(() => (window as unknown as { viewer: { setSimulationPaused(reason: string, paused: boolean): void } })
    .viewer.setSimulationPaused('plan-503-calibration', false));

  const calibration = { threshold: MOTION_THRESHOLD, clip, drives, empty, overlapsMachine, moving, paused, still };
  await testInfo.attach('calibration', { body: JSON.stringify(calibration, null, 2), contentType: 'application/json' });
  console.log(`[motion-calibration] ${JSON.stringify({
    threshold: MOTION_THRESHOLD,
    moving: moving.map((r) => +r.toFixed(5)), paused: paused.map((r) => +r.toFixed(5)), still: still.map((r) => +r.toFixed(5)),
    clip, overlapsMachine,
  })}`);

  expect(Math.max(...moving), 'running demo is not above the threshold').toBeGreaterThan(MOTION_THRESHOLD);
  expect(Math.max(...paused), 'paused simulation is not below the threshold').toBeLessThan(MOTION_THRESHOLD);
  if (!overlapsMachine) expect(Math.max(...still), 'empty clip is not below the threshold').toBeLessThan(MOTION_THRESHOLD);
});
