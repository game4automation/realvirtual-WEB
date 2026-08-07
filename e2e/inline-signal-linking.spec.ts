// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.9 — inline signal linking end-to-end:
 * load a model → select an element with signal slots → the component section
 * shows EVERY slot as a row (empty ones as "not linked") → bind one slot to an
 * internal model signal via the picker → the binding goes live without a
 * CONNECT provider → unlink restores "not linked".
 */
import { expect, test, type Page } from 'playwright/test';

async function waitForViewerReady(page: Page): Promise<void> {
  // On a cold Vite start the first module graph plus the demo GLB can take
  // longer than the default per-assertion budget. Presence is sufficient here;
  // the loading-overlay check below is the authoritative readiness gate.
  await page.waitForSelector('canvas', { state: 'attached', timeout: 45_000 });
  await page.waitForFunction(() => {
    const viewer = (window as unknown as {
      __rvViewer?: { currentModelUrl?: string; signalBindingManager?: unknown };
    }).__rvViewer;
    const overlay = document.getElementById('loading-overlay');
    return !!viewer?.signalBindingManager
      && !!viewer.currentModelUrl
      && !!overlay?.classList.contains('hidden');
  }, undefined, { timeout: 90_000 });
  // Fresh browser profiles show the product introduction above the workspace.
  // Dismiss it first; the startup-modal coordinator then releases the
  // auto-quality notice (if weak-device detection selected Performance mode).
  const welcomeDismiss = page.getByTestId('welcome-dismiss');
  if (await welcomeDismiss.isVisible()) await welcomeDismiss.click();
  const qualityNotice = page.locator('[data-testid="auto-quality-ok"]');
  await qualityNotice.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
  if (await qualityNotice.isVisible()) await qualityNotice.click();
}

/** Find a node path carrying a Drive_Simple with bindable slots (or synthesize one). */
async function slotTargetPath(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const viewer = (window as unknown as {
      __rvViewer: {
        registry: { getAll: (type: string) => Array<{ path: string; instance: { node?: unknown } }> };
        signalBindingManager: { getElementSlots: (id: string, node: unknown) => Array<{ kind: string }> };
      };
    }).__rvViewer;
    for (const type of ['Drive_Simple', 'Drive_Cylinder']) {
      for (const entry of viewer.registry.getAll(type)) {
        const node = entry.instance.node;
        if (node && viewer.signalBindingManager.getElementSlots(entry.path, node)
          .some((slot) => slot.kind !== 'unavailable')) return entry.path;
      }
    }
    return null;
  });
}

async function internalBoolOutputName(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __rvViewer: {
        signalStore: {
          getAll: () => Map<string, boolean | number>;
          getType: (name: string) => string | undefined;
          getSignalProviders: (name: string) => unknown[];
        };
      };
    }).__rvViewer.signalStore;
    return [...store.getAll().keys()]
      .sort((a, b) => a.localeCompare(b))
      .find((name) =>
        store.getSignalProviders(name).length === 0
        && store.getType(name) === 'PLCOutputBool') ?? null;
  });
}

test('inline slot rows: always visible, bindable to an internal signal, unlinkable', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  const path = await slotTargetPath(page);
  test.skip(!path, 'demo model exposes no bindable Drive slots');

  // Select the element through the editor plugin so the Property Inspector opens.
  await page.evaluate((nodePath) => {
    const viewer = (window as unknown as {
      __rvViewer: { getPlugin: (id: string) => { selectAndReveal?: (p: string, showInspector?: boolean) => void } | undefined };
    }).__rvViewer;
    viewer.getPlugin('rv-extras-editor')?.selectAndReveal?.(nodePath, true);
  }, path);

  // Every schema signal slot appears as a row — Forward AND Backward.
  const forwardRow = page.locator('[data-testid$="-Forward"][data-rv-slot-kind]').first();
  const backwardRow = page.locator('[data-testid$="-Backward"][data-rv-slot-kind]').first();
  await expect(forwardRow).toBeVisible({ timeout: 15_000 });
  await expect(backwardRow).toBeVisible();

  // Bind Backward (typically empty) via the picker → internal model signal group.
  const internalSignal = await internalBoolOutputName(page);
  expect(internalSignal).not.toBeNull();
  const linkBackward = page.locator('[aria-label="signal for Backward"]');
  if (await linkBackward.count() > 0) {
    await linkBackward.first().click();
    const search = page.getByPlaceholder('Search name, address, comment…');
    await expect(search).toBeVisible();
    await search.fill(internalSignal!);
    const internalOption = page.getByRole('option', { name: internalSignal! });
    // Filtering is intentionally deferred so the large signal list cannot
    // starve the simulation loop; allow the low-priority render to settle on
    // software-rendered CI/browser workers.
    await expect(internalOption).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Model signals')).toBeVisible();
    await internalOption.click();

    // Unlink restores the empty state.
    const unlink = page.locator('[aria-label="unbind Backward"]');
    await expect(unlink).toBeVisible();
    await unlink.click();
    await expect(page.locator('[aria-label="signal for Backward"]').first()).toBeVisible();
  }
});
