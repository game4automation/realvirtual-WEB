// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-503 F2: every `demos` document of the deployed demo project boots on the
 * LIVE CDN — model loaded, no page/console error (noise filtered), no 404
 * outside the allowlist, no Problems panel. Read-only; nothing is clicked
 * except the consent gate and the startup notices.
 *
 * The test title is part of the runner's contract (scripts/rv-demo-smoke.mjs
 * `expectedTitles()`, F14) — rename both together.
 */

import { expect, test } from 'playwright/test';
import {
  blockAnalytics, collectErrors, collectNotFound, criticalErrors, disallowedNotFound,
  waitForPlacementsMaterialized, waitForViewerReady,
} from '../_viewer-ready';
import { EXPECTED_DEMOS, LIVE_BASE_URL } from './_live-target';

for (const [key, docId] of Object.entries(EXPECTED_DEMOS)) {
  test(`boots ${key} demo without errors`, async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    const notFound = collectNotFound(page);
    await blockAnalytics(page);
    const t0 = Date.now();
    await page.goto(`?doc=${encodeURIComponent(docId)}&welcome=0`, { waitUntil: 'domcontentloaded' });
    const { modelUrl, dismissed } = await waitForViewerReady(page);
    const readyMs = Date.now() - t0;
    // A planner document is an empty shell — boot is only done when its placements are.
    if (key === 'planner') await waitForPlacementsMaterialized(page);
    await page.waitForTimeout(2_000);
    await expect(page.locator('[data-testid="problems-panel"]')).toHaveCount(0);
    const shot = testInfo.outputPath(`${key}.png`);
    await page.screenshot({ path: shot });
    await testInfo.attach(`${key}-screenshot`, { path: shot, contentType: 'image/png' });
    await testInfo.attach(`${key}-boot`, {
      body: JSON.stringify({ docId, modelUrl, readyMs, dismissed, notFound, rawErrors: errors }, null, 2),
      contentType: 'application/json',
    });
    expect(disallowedNotFound(notFound, LIVE_BASE_URL), '404 outside the allowlist (root project.json/models.json, optional *.kin.json and aasx/index.json, same-origin /health)').toEqual([]);
    expect(criticalErrors(errors), 'page/console errors on the live demo').toEqual([]);
  });
}
