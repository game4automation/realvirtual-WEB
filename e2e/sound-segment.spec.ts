// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.10 / C4 — the Sound segment of the view cluster:
 * a model without `Sound` shows no segment; adding one (generic component
 * command) shows it, removing it hides it, undo brings it back; a click turns
 * sound on (context `running`), a second click off (`suspended`); the hover
 * slider changes the master volume; after a reload the setting persists and NO
 * AudioContext exists before the first gesture.
 *
 * The first test runs everywhere; the add/remove part needs the asset editor
 * (private sibling) and skips in a public-only checkout.
 */

import { expect, test, type Page } from 'playwright/test';
import { waitForViewerReady } from './_viewer-ready';
import { HAS_PRIVATE_SOURCE } from './private-module-url';

const DEMO_URL = '/?model=DemoRealvirtualWeb.glb';

async function soundCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = (window as unknown as Record<string, any>).viewer;
    return v.getPlugin('sound-system')?.sceneStore.getSnapshot().count ?? -1;
  });
}

async function exec(page: Page, id: string, args: unknown): Promise<void> {
  await page.evaluate(async ({ id: cmd, args: a }) => {
    const dyn = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    const { commandRegistry } = await dyn('/src/core/hmi/rv-command-registry.ts');
    await commandRegistry.execute(cmd, a, { origin: 'mcp' });
  }, { id, args });
}

async function contextState(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const dyn = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    const m = await dyn('/src/core/audio/rv-audio-engine.ts');
    return m.getSharedAudioContext()?.state ?? null;
  });
}

test('no Sound in the scene → no Sound segment in the view cluster', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  expect(await soundCount(page)).toBe(0);
  await expect(page.getByTestId('view-cluster')).toBeVisible();
  await expect(page.getByTestId('view-cluster').getByTestId('sound-segment')).toHaveCount(0);
});

test('add → segment, click on/off, hover volume, remove/undo, persistence without a context', async ({ page }) => {
  test.skip(!HAS_PRIVATE_SOURCE, 'needs the asset editor (private sibling) to add a component');
  test.setTimeout(240_000);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  const path = await page.evaluate(() => {
    const v = (window as unknown as Record<string, any>).viewer;
    const all = v.registry.getAll('Drive') as Array<{ path: string }>;
    return all.length ? all[0].path : null;
  });
  test.skip(!path, 'demo model has no Drive');

  await page.evaluate(async () => { await (window as unknown as Record<string, any>).viewer.modes.requestMode('editor'); });
  await page.waitForFunction(() => (window as unknown as Record<string, any>).viewer?.editorArena?.isBuilt, undefined, { timeout: 90_000 });
  await exec(page, 'editor.addComponent', { path, type: 'Sound' });
  await expect.poll(() => soundCount(page)).toBe(1);
  const segment = page.getByTestId('view-cluster').getByTestId('sound-segment');
  await expect(segment).toBeVisible();

  // Click → on, context running; click → off, suspended.
  await page.getByTestId('sound-toggle').click();
  await expect.poll(() => contextState(page)).toBe('running');
  await page.getByTestId('sound-toggle').click();
  await expect.poll(() => contextState(page)).toBe('suspended');

  // Hover → popover with the slider; the command changes the master volume.
  await segment.hover();
  await expect(page.getByTestId('sound-popover')).toBeVisible();
  await exec(page, 'view.sound', { on: true });
  await exec(page, 'view.soundVolume', { value: 0.25 });
  await expect.poll(() => page.evaluate(() => {
    const v = (window as unknown as Record<string, any>).viewer;
    return v.getPlugin('sound-system')?.engine?.master?.gain?.value ?? null;
  }), { timeout: 5_000 }).toBeCloseTo(0.25, 1);

  // Remove → segment gone; undo → back.
  await exec(page, 'editor.removeComponent', { path, componentType: 'Sound' });
  await expect.poll(() => soundCount(page)).toBe(0);
  await expect(segment).toHaveCount(0);
  await exec(page, 'editor.undo', {});
  await expect.poll(() => soundCount(page)).toBe(1);

  // Reload: the stored "on" persists, but no context exists before a gesture.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page, { notices: [] });
  expect(await page.evaluate(() => localStorage.getItem('rv-sound-enabled'))).toBe('true');
  expect(await page.evaluate(() => (window as unknown as Record<string, any>).viewer.getPlugin('sound-system')?.engine ?? null)).toBeNull();
});
