// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-477 §9.5 — the control window, end to end, on the real
 * `DemoRibbonSlitter.glb` of the internal Development project.
 *
 * The vitest suites prove the panel and the plugin in isolation. This file
 * answers what they cannot:
 *
 *  1. does the window actually REACH the screen — which needs the project to be
 *     open, because the binding lives in `project.json` (`scriptRef`), not in
 *     the file name (A5). The negative control is the same model without the
 *     project: no window, no error;
 *  2. does pressing a key bend the real web (a `zones[1].state` probe);
 *  3. do the position and the collapsed state survive a reload — the reason
 *     geometry is persisted at the end of a drag for a window that never closes;
 *  4. kiosk folds it away and gives it back (A1).
 *
 *   npx playwright test e2e/control-window.spec.ts
 *   RV_E2E_PORT=5477 npx playwright test e2e/control-window.spec.ts   # worktree port
 */

import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';
import { DEV_ASSETS_SKIP_REASON, HAS_DEV_ASSETS } from './dev-assets';

/** The deploy root of the Development project, as the dev server serves it. */
const PROJECT_ROOT = '/private-assets/Development/';
const WITH_PROJECT = `/?projectUrl=${encodeURIComponent(PROJECT_ROOT)}`;
/** The same model with NO project — the negative control (A5). */
const WITHOUT_PROJECT = `/?model=${encodeURIComponent(DEV_GLB.ribbonSlitter)}`;

const PANEL = '[data-ui-panel][role="region"][aria-label="Ribbon Tension"]';

/**
 * Keep the boot-time modals off the screen, by flag rather than by click.
 *
 * A click is a race: the welcome box appears some way into the boot, and its
 * other button ("Start demo") opens the DEMO project — which would close the
 * one this spec just opened. The flags are the same ones a returning user has.
 */
async function suppressStartupNotices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rv-welcome-dismissed', 'true');
      localStorage.setItem('rv-auto-quality-applied', 'true');
    } catch { /* private mode */ }
  });
}

/** Whatever still got through (a machine-specific dialog). Best effort. */
async function dismissStartupNotices(page: Page, timeout = 1_000): Promise<void> {
  for (const testId of ['auto-quality-ok', 'welcome-dismiss']) {
    const btn = page.getByTestId(testId);
    try {
      if (await btn.isVisible({ timeout })) {
        await btn.click({ timeout: 5_000 });
        await btn.waitFor({ state: 'detached', timeout: 5_000 });
      }
    } catch { /* not shown on this machine */ }
  }
}

/**
 * The same noise filter `ribbon-tension.spec.ts` uses: optional sidecar probes
 * 404 on a dev server, and a CONNECT gateway on the machine answers the
 * document handshake with 409 when another client owns the active document.
 * Neither is this feature.
 */
function critical(errors: string[]): string[] {
  return errors.filter(
    (e) => !e.includes('favicon.ico') && !e.includes('net::ERR_')
      && !e.includes('ResizeObserver') && !e.includes('404')
      && !e.includes('409 (Conflict)'),
  );
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  return errors;
}

/** Open the project and load the tension demo through it. */
async function openViaProject(page: Page): Promise<string[]> {
  const errors = collectErrors(page);
  await suppressStartupNotices(page);
  await page.goto(WITH_PROJECT, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  await dismissStartupNotices(page);
  // Let the project's OWN boot document finish first. Loading over a load in
  // flight aborts it as superseded, and the abort lands in the middle of the
  // plugin handover.
  await page.waitForFunction(
    () => !!(window as unknown as { viewer?: any }).viewer?.currentModelUrl,
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate((url) => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    // `pendingModelUrl` is the ORIGINAL url the engine resolves identity
    // against, and the app's own model switch sets it before calling
    // `loadModel`. Without it the plugin manager would still be resolving the
    // url of the model that is on screen — the boot document — and this spec
    // would silently test nothing.
    viewer.pendingModelUrl = url;
    return viewer.loadModel(url);
  }, DEV_GLB.ribbonSlitter);
  await page.waitForFunction(
    () => ((window as unknown as { viewer?: any }).viewer?.ribbonManager?.size ?? 0) > 0,
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(6_000);
  // The auto-quality notice waits for the welcome box to go and can therefore
  // arrive well AFTER the first sweep. A modal over the panel would turn every
  // interaction below into a timeout with a message about a selector, so the
  // wait is on the CONDITION — no modal left — rather than on a duration.
  await clearModals(page);
  return errors;
}

/**
 * Clear the boot modals at the SOURCE.
 *
 * The auto-quality notice is re-raised on a model load, so clicking its OK
 * button races the very load this spec performs — the dialog comes back and
 * keeps intercepting every click aimed at the panel underneath. Clearing the
 * store is the same call the OK button makes, and it cannot lose that race.
 */
async function clearModals(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ '/src/core/hmi/auto-quality.ts');
    (mod as { clearAutoQualityNotice(): void }).clearAutoQualityNotice();
  });
  await page.locator('[role="dialog"][aria-modal="true"]').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
}

/** The two set points the control window owns, straight off the model. */
function setPoints(page: Page): Promise<{ nip2MmPerS: number; loadN: number }> {
  return page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    const path = viewer.ribbonManager.groups.flatMap((g: any) => g.paths)[0];
    const roller = path.rollers.find((r: any) => r.node?.name === 'Nip_2');
    const dancer = path.dancers[0];
    return {
      nip2MmPerS: Math.round((roller.driveOnNode().targetSpeed * Math.PI / 180) * roller.radiusMm),
      loadN: Math.round(dancer.LoadN),
    };
  });
}

/** The state of the demo zone between Nip_1 and Nip_2. */
function zoneState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    const path = viewer.ribbonManager.groups.flatMap((g: any) => g.paths)[0];
    return String(path.zones[1].state);
  });
}

/**
 * Set a UI context from the page.
 *
 * There is deliberately no window-level setter in production code, so the spec
 * reaches the store the way the app does: under Vite's dev server the app's own
 * module URL is importable, and an import of it yields the SAME module instance
 * the running app holds — not a second copy.
 */
async function setUIContext(page: Page, ctx: string, active: boolean): Promise<void> {
  await page.evaluate(async ([c, a]) => {
    const mod = await import(/* @vite-ignore */ '/src/core/hmi/ui-context-store.ts');
    (mod as { setContext(ctx: string, active: boolean): void }).setContext(c as string, a as boolean);
  }, [ctx, active] as const);
}

test.describe('control window (plan-477)', () => {
  test.skip(!HAS_DEV_ASSETS, DEV_ASSETS_SKIP_REASON);
  // Each test boots the project (which loads its own default document), then
  // loads the tension demo over it, then lets the line settle — well past the
  // 60 s default of a spec that navigates once.
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test('is on screen without any action, has no close button, and ignores Escape (A5, F1)', async ({ page }) => {
    const errors = await openViaProject(page);

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('Close window')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();

    expect(critical(errors)).toEqual([]);
  });

  test('the negative control: the same model with no project has no window and no error (A5)', async ({ page }) => {
    const errors = collectErrors(page);
    await suppressStartupNotices(page);
    await page.goto(WITHOUT_PROJECT, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 60_000 });
    await dismissStartupNotices(page);
    await page.waitForFunction(
      () => ((window as unknown as { viewer?: any }).viewer?.ribbonManager?.size ?? 0) > 0,
      undefined,
      { timeout: 60_000 },
    );

    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(critical(errors)).toEqual([]);
  });

  test('a latched situation bends the real web (F11)', async ({ page }) => {
    await openViaProject(page);

    await page.locator(PANEL).getByRole('button', { name: 'Slack' }).click();
    await page.waitForTimeout(9_000);
    expect(await zoneState(page)).toBe('slack');

    await page.locator(PANEL).getByRole('button', { name: 'Overstretched' }).click();
    await page.waitForTimeout(9_000);
    expect(await zoneState(page)).toBe('over');

    // The Reset key is a DEMO reset (F12): it restores the two SET POINTS and
    // the latch, and touches nothing else.
    //
    // It deliberately does NOT put the web back in band, and cannot: the strain
    // in a zone is the integral of the speed DIFFERENCE across it, so once the
    // web has been stretched, running both nips at 800 mm/s again holds the
    // stretch rather than undoing it. Draining it is what the global
    // `resetSimulation()` is for. Measured here, not assumed: the zone stays
    // `above` for at least a minute after the key.
    await page.locator(PANEL).getByRole('button', { name: 'Reset' }).click();
    await page.waitForTimeout(2_000);
    await expect(page.locator(PANEL).getByRole('button', { name: 'Normal' }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(await setPoints(page)).toEqual({ nip2MmPerS: 800, loadN: 100 });
  });

  test('dragging the slider does not move the window (F9)', async ({ page }) => {
    await openViaProject(page);
    const panel = page.locator(PANEL);
    const before = await panel.boundingBox();

    const thumb = panel.locator('.MuiSlider-thumb').first();
    const box = (await thumb.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const after = await panel.boundingBox();
    expect(after!.x).toBeCloseTo(before!.x, 0);
    expect(after!.y).toBeCloseTo(before!.y, 0);
  });

  test('position and collapsed state survive a reload (§2.5, F2)', async ({ page }) => {
    await openViaProject(page);
    const panel = page.locator(PANEL);

    // Drag it by the title bar — the only moment a never-closing window has to
    // write its geometry.
    const handle = panel.locator('[data-drag-handle]');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 - 120, hb.y + hb.height / 2 - 80, { steps: 10 });
    await page.mouse.up();
    const moved = (await panel.boundingBox())!;

    await panel.getByLabel('Collapse panel').click();
    await expect(panel.getByLabel('Expand panel')).toBeVisible();

    // Open it again from scratch — a fresh page, a fresh mount, the same
    // localStorage. A bare `page.reload()` would not do: the project boots its
    // own default document, which is not this one.
    await openViaProject(page);
    const restored = page.locator(PANEL);
    await expect(restored).toBeVisible({ timeout: 60_000 });
    await expect(restored.getByLabel('Expand panel')).toBeVisible();

    // Expand again, then compare the position it came back with.
    await restored.getByLabel('Expand panel').click();
    const back = (await restored.boundingBox())!;
    expect(Math.abs(back.x - moved.x)).toBeLessThan(4);
    expect(Math.abs(back.y - moved.y)).toBeLessThan(4);
  });

  test('kiosk folds it away and gives it back (A1)', async ({ page }) => {
    await openViaProject(page);
    const panel = page.locator(PANEL);
    await expect(panel.getByLabel('Collapse panel')).toBeVisible();

    await setUIContext(page, "kiosk", true);
    await expect(panel).toBeVisible();                       // title bar stays
    await expect(panel.getByRole('slider')).toHaveCount(0);  // content is gone

    await setUIContext(page, "kiosk", false);
    await expect(panel.getByRole('slider')).toHaveCount(2);
  });
});
