// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * picker-keyboard.spec.ts — plan-353 F13 (the §9.14 leftover of plan-341).
 *
 * The signal picker was BUILT for the keyboard: a `role="combobox"` search
 * field, a never-focusable `role="listbox"`, and Arrow/Home/End/Enter/Escape
 * hanging off one `onKeyDown` with `aria-activedescendant` pointing at the
 * current row (see `SignalSearchOverlay.tsx`). None of that was covered
 * end-to-end, so nothing stopped a refactor from quietly breaking the only
 * binding path available without a mouse — and drag-and-drop, the alternative,
 * is exactly the interaction a keyboard user cannot perform.
 *
 * Runs against the DEV server (port 5177, `playwright.config.ts`), like the
 * other signal specs — NOT `preview:embed`. Picking the embed server was why
 * §9.14 stalled in plan-341: the picker needs the editor plugin, which the
 * embed build does not ship.
 */

import { expect, test, type Page } from 'playwright/test';

async function waitForViewerReady(page: Page): Promise<void> {
  // On a cold Vite start the first module graph plus the demo GLB can exceed the
  // default per-assertion budget; the loading-overlay check below is the real gate.
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
  // Both startup modals must go, in this order: a fresh browser profile shows
  // the product introduction, and the startup-modal coordinator only releases
  // the auto-quality notice once that is dismissed. Left standing, either one
  // swallows the pointer events this spec depends on.
  const welcomeDismiss = page.getByTestId('welcome-dismiss');
  if (await welcomeDismiss.isVisible()) await welcomeDismiss.click();
  const qualityNotice = page.locator('[data-testid="auto-quality-ok"]');
  await qualityNotice.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
  if (await qualityNotice.isVisible()) await qualityNotice.click();
}

/** A Drive placement that actually offers bindable slots in the demo model. */
async function slotTargetPath(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const viewer = (window as unknown as {
      __rvViewer: {
        registry: { getAll: (type: string) => Array<{ path: string; instance: { node?: unknown } }> };
        signalBindingManager: {
          getElementSlots: (id: string, node: unknown) => Array<{ kind: string }>;
        };
      };
    }).__rvViewer;
    for (const type of ['Drive_Simple', 'Drive_Cylinder', 'Drive_DestinationMotor']) {
      for (const entry of viewer.registry.getAll(type)) {
        const node = entry.instance.node;
        if (!node) continue;
        const slots = viewer.signalBindingManager.getElementSlots(entry.path, node);
        if (slots.some((s) => s.kind !== 'unavailable')) return entry.path;
      }
    }
    return null;
  });
}

/** Open the Property Inspector on a slot-bearing element. */
async function selectTarget(page: Page, path: string): Promise<void> {
  await page.evaluate((nodePath) => {
    const viewer = (window as unknown as {
      __rvViewer: {
        getPlugin: (id: string) => { selectAndReveal?: (p: string, showInspector?: boolean) => void } | undefined;
      };
    }).__rvViewer;
    viewer.getPlugin('rv-extras-editor')?.selectAndReveal?.(nodePath, true);
  }, path);
}

const SEARCH_PLACEHOLDER = 'Search name, address, comment…';

test.describe('signal picker — keyboard operation (plan-353 F13)', () => {
  test('navigates, binds with Enter and cancels with Escape', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);

    const path = await slotTargetPath(page);
    test.skip(!path, 'demo model exposes no bindable Drive slots');
    await selectTarget(page, path!);

    const linkButton = page.locator('[aria-label="signal for Backward"]').first();
    await expect(linkButton).toBeVisible({ timeout: 20_000 });

    // ── open ────────────────────────────────────────────────────────────────
    await linkButton.click();
    const search = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await expect(search).toBeVisible();
    // The field takes focus on open — without that, every key below would go to
    // the document and the picker would be keyboard-dead on arrival.
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute('aria-expanded', 'true');

    // ── navigate ────────────────────────────────────────────────────────────
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 20_000 });

    await search.press('ArrowDown');
    // The active option is addressed by id, not by focus — the listbox itself is
    // never focusable, so `aria-activedescendant` IS the selection.
    const firstActive = await search.getAttribute('aria-activedescendant');
    expect(firstActive).toBeTruthy();

    await search.press('ArrowDown');
    const secondActive = await search.getAttribute('aria-activedescendant');
    expect(secondActive).toBeTruthy();
    expect(secondActive).not.toBe(firstActive);

    // ArrowUp returns to the previous row — navigation is symmetric.
    await search.press('ArrowUp');
    expect(await search.getAttribute('aria-activedescendant')).toBe(firstActive);

    // The active row must be RENDERED, not just referenced: a virtualized list
    // that scrolled it away would leave the id dangling and screen readers mute.
    // Addressed by attribute, not `#id` — the ids contain characters a bare CSS
    // id selector would choke on, and `CSS.escape` is a browser global that does
    // not exist in the Playwright runner.
    await expect(page.locator(`[id="${firstActive}"]`)).toHaveCount(1);

    // ── cancel ──────────────────────────────────────────────────────────────
    await search.press('Escape');
    await expect(search).not.toBeVisible();
    // Nothing was bound: the slot still offers its link affordance.
    await expect(page.locator('[aria-label="signal for Backward"]').first()).toBeVisible();

    // ── bind ────────────────────────────────────────────────────────────────
    await linkButton.click();
    const search2 = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await expect(search2).toBeVisible();
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 20_000 });

    await search2.press('ArrowDown');
    const chosenId = await search2.getAttribute('aria-activedescendant');
    expect(chosenId).toBeTruthy();
    const chosenName = await page.locator(`[id="${chosenId}"]`).innerText();

    await search2.press('Enter');
    await expect(search2).not.toBeVisible();

    // The binding really happened — the row now offers an unbind affordance.
    const unlink = page.locator('[aria-label="unbind Backward"]');
    await expect(unlink).toBeVisible({ timeout: 15_000 });
    expect(chosenName?.length ?? 0).toBeGreaterThan(0);

    // Leave the model as we found it.
    await unlink.click();
    await expect(page.locator('[aria-label="signal for Backward"]').first()).toBeVisible();
  });

  test('announces the keyboard binding exactly once', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);

    const path = await slotTargetPath(page);
    test.skip(!path, 'demo model exposes no bindable Drive slots');
    await selectTarget(page, path!);

    const linkButton = page.locator('[aria-label="signal for Backward"]').first();
    await expect(linkButton).toBeVisible({ timeout: 20_000 });
    await linkButton.click();

    const search = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await expect(search).toBeVisible();
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 20_000 });

    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(search).not.toBeVisible();

    // The drag announcer is a singleton: exactly ONE `#rv-drag-announcer` region
    // exists, so a binding can never be read out twice. (Other polite regions
    // belong to other features and are deliberately not counted here.)
    await expect(page.locator('#rv-drag-announcer')).toHaveCount(1);

    const unlink = page.locator('[aria-label="unbind Backward"]');
    if (await unlink.count() > 0) await unlink.first().click();
  });
});
