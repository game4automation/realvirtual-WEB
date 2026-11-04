// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-503 F4: the served HMI demo runs BY ITSELF — no input, no 3D buttons, no
 * signals, nothing paused (decision log: the live journey is read-only and
 * visitor-like). Motion is proven by a pixel diff of a MACHINE clip (e2e/_motion.ts,
 * threshold calibrated locally by e2e/prod-demo-calibration/motion-threshold.spec.ts),
 * then the 2D chrome a visitor sees: the bottom bar and the hierarchy panel.
 *
 * The test title is part of the runner's contract (scripts/rv-demo-smoke.mjs
 * `JOURNEY_TITLES`, F14) — rename both together.
 */

import { expect, test } from 'playwright/test';
import { captureMotion, machineClip, MOTION_THRESHOLD } from '../_motion';
import { blockAnalytics, collectErrors, criticalErrors, waitForViewerReady } from '../_viewer-ready';
import { EXPECTED_DEMOS } from './_live-target';

test('demo runs by itself and the HMI chrome is usable', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await blockAnalytics(page);
  await page.goto(`?doc=${encodeURIComponent(EXPECTED_DEMOS.hmi)}&welcome=0`, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  await page.waitForTimeout(2_000);

  // 1. Motion — which drives move is read, not configured (no fixed names).
  const { clip, drives, overlaps } = await machineClip(page);
  expect(drives.length, 'no drive moves on its own — the demo does not run').toBeGreaterThan(0);
  expect(clip.width * clip.height, 'machine clip is empty').toBeGreaterThan(40 * 40);
  const ratios = await captureMotion(page, testInfo, clip, 'machine');
  await testInfo.attach('motion', {
    body: JSON.stringify({ clip, drives, overlaps, ratios, threshold: MOTION_THRESHOLD }, null, 2),
    contentType: 'application/json',
  });
  expect(Math.max(...ratios), `machine clip shows no motion (ratios ${ratios.map((r) => r.toFixed(4)).join(' / ')})`)
    .toBeGreaterThan(MOTION_THRESHOLD);

  // 2. Bottom-right view cluster (plan-578): a fresh visitor has no saved camera
  // bookmark, so the numbered `Camera n` segments do not exist yet — the one
  // segment that is always there is "save current view".
  const camAdd = page.getByTestId('camera-bookmark-add');
  await expect(camAdd).toBeVisible();
  const viewport = page.viewportSize();
  const box = await camAdd.boundingBox();
  expect(viewport && box, 'camera bookmark button has no box').toBeTruthy();
  expect(box!.y + box!.height, 'camera bookmarks are not in the bottom bar').toBeGreaterThan(viewport!.height - 64);

  // 3. Hierarchy panel opens and closes (2D chrome, not a 3D button).
  const hierarchyButton = page.getByRole('button', { name: 'Hierarchy', exact: true });
  const tree = page.locator('[role="tree"][aria-label="Scene hierarchy"]');
  await hierarchyButton.click();
  await expect(tree).toBeVisible({ timeout: 10_000 });
  await hierarchyButton.click();
  await expect(tree).toBeHidden({ timeout: 10_000 });

  await expect(page.locator('[data-testid="problems-panel"]')).toHaveCount(0);
  expect(criticalErrors(errors), 'page/console errors during the HMI journey').toEqual([]);
});
