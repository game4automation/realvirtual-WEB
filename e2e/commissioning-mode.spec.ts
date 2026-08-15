// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The commissioning workspace, end to end (plan-423 §9.6).
 *
 * The unit tests evaluate the visibility RULES; this one checks that the rules
 * reach the running page — that `?mode=commissioning` actually boots the mode,
 * that the operator chrome is gone from the DOM and that the two surfaces the
 * workspace exists for (Inspector/Hierarchy and CONNECT) are reachable.
 */

import { expect, test, type Page } from 'playwright/test';

async function waitForViewerReady(page: Page): Promise<void> {
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const viewer = (window as unknown as {
      __rvViewer?: { currentModelUrl?: string; modes?: { activeMode?: string | null } };
    }).__rvViewer;
    const overlay = document.getElementById('loading-overlay');
    return !!viewer?.currentModelUrl && !!overlay?.classList.contains('hidden');
  }, undefined, { timeout: 90_000 });
  // Two modal overlays can be in front of the toolbar on a fresh profile and
  // BOTH swallow clicks: the first-visit welcome (auto-opens everywhere except
  // the Viewer, which plan-387 gated) and the auto-quality notice, which
  // appears late — only once the renderer has judged the GPU. Neither is what
  // this spec is about, so they are dismissed, in whichever order they arrive.
  for (const testId of ['welcome-dismiss', 'auto-quality-ok', 'welcome-dismiss']) {
    const overlay = page.locator(`[data-testid="${testId}"]`);
    try {
      await overlay.first().waitFor({ state: 'visible', timeout: 5_000 });
    } catch {
      continue;   // not shown on this run — fine
    }
    await overlay.first().click();
    await overlay.first().waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

const activeMode = (page: Page) => page.evaluate(() => (window as unknown as {
  __rvViewer?: { modes?: { activeMode?: string | null } };
}).__rvViewer?.modes?.activeMode ?? null);

test.describe('commissioning workspace', () => {
  test('?mode=commissioning boots the mode', async ({ page }) => {
    await page.goto('/?mode=commissioning', { waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);
    expect(await activeMode(page)).toBe('commissioning');
  });

  test('the operator HMI is gone and the tools are there', async ({ page }) => {
    await page.goto('/?mode=commissioning', { waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);

    // OFF: no KPI cards, no message stack. Asserted through the demo content
    // the default model contributes, so an empty slot cannot pass by accident.
    await expect(page.locator('text=OEE')).toHaveCount(0);

    // ON: the CONNECT opener (activity bar) and the Signal Link tool.
    await expect(page.locator('button[aria-label*="CONNECT"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="signal-link-mode-toggle"]')).toHaveCount(1);
  });

  test('the CONNECT panel opens', async ({ page }) => {
    await page.goto('/?mode=commissioning', { waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);

    await page.locator('button[aria-label*="CONNECT"]').first().click();
    await page.waitForTimeout(500);
    // The panel occupies the left slot — the same reconciliation the viewer
    // workspace closes. Here it must stay open.
    expect(await page.evaluate(() => (window as unknown as {
      __rvViewer?: { leftPanelManager?: { activePanel?: string | null } };
    }).__rvViewer?.leftPanelManager?.activePanel ?? null)).toBe('connect');
  });

  test('the HMI workspace is unchanged next to it', async ({ page }) => {
    // The guard rail, live: switching to HMI brings the operator surface back.
    await page.goto('/?mode=hmi', { waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);
    expect(await activeMode(page)).toBe('hmi');
    await expect(page.locator('text=OEE').first()).toBeVisible();
  });
});
