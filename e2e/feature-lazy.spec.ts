// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Lazy feature plugins end to end (plan-652 §9.16).
 *
 * 1. HMI boot loads neither the editor body nor the DES body; hovering the
 *    Editor entry of the mode menu prefetches the editor body without switching,
 *    the click then activates the editor.
 * 2. The DES fixture loads DES only on entering DES mode (see the note at test 2).
 * 3. A blocked editor body keeps the viewer in its mode, leaves a
 *    `feature-load-failed` Problems entry with a Retry action, and the retry
 *    succeeds once the block is lifted (cache-bust re-import, no reload).
 *
 * Runs against the dev server (playwright.config.ts webServer); the dev-only
 * module imports in test 3 resolve the SAME module instances the app uses.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect, type Page } from 'playwright/test';
import { waitForViewerReady } from './_viewer-ready';

const DEMO_URL = '/?model=DemoRealvirtualWeb.glb&consent=decline';
const DES_MODEL = 'demo-realvirtual/Test-DES-Turntable-Loop.glb';
const EDITOR_BODY = /asset-editor\.body/;
const DES_BODY = /des\.body/;

function recordRequests(page: Page, pattern: RegExp): string[] {
  const seen: string[] = [];
  page.on('request', (req) => { if (pattern.test(req.url())) seen.push(req.url()); });
  return seen;
}

async function featureState(page: Page, id: string): Promise<{ state?: string; trigger?: string } | null> {
  return page.evaluate((fid: string) => {
    const s = (window as any).viewer.features.statuses().find((x: any) => x.id === fid);
    return s ? { state: s.state, trigger: s.trigger } : null;
  }, id);
}

async function activeMode(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).viewer.modes.activeMode ?? null);
}

test('HMI boot without editor/DES body; hover prefetches, click activates the editor', async ({ page }) => {
  test.setTimeout(240_000);
  const editorReqs = recordRequests(page, EDITOR_BODY);
  const desReqs = recordRequests(page, DES_BODY);

  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  expect(await activeMode(page)).not.toBe('editor');
  expect(editorReqs, 'no editor body at boot').toEqual([]);
  expect(desReqs, 'no DES body at boot').toEqual([]);
  expect((await featureState(page, 'asset-editor'))?.state).toBe('declared');
  expect((await featureState(page, 'des'))?.state).toBe('declared');

  const editorLabel: string = await page.evaluate(
    () => (window as any).viewer.modes.list().find((m: any) => m.id === 'editor').label,
  );
  await page.getByRole('button', { name: 'Switch workspace mode' }).click();
  const item = page.getByRole('menuitem').filter({ hasText: editorLabel }).first();
  await item.hover();
  await expect.poll(() => editorReqs.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await activeMode(page), 'hover alone does not switch').not.toBe('editor');

  await item.click();
  await expect.poll(() => activeMode(page), { timeout: 120_000 }).toBe('editor');
  expect((await featureState(page, 'asset-editor'))?.state).toBe('active');
});

// No GLB in the repos carries DES components (the DES fixture is a planner layout of
// plain conveyors; DES builds its stations in DES mode). The component-trigger path
// (`component:DES*` before model-loaded) is covered by tests/feature-des-prescan.test.ts;
// end to end, the DES fixture in DES mode loads the DES body on demand.
test('the DES fixture in DES mode loads DES on demand', async ({ page }) => {
  test.setTimeout(240_000);
  const desReqs = recordRequests(page, DES_BODY);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  await page.evaluate((url: string) => (window as any).viewer.loadModel(url), DES_MODEL);
  expect((await featureState(page, 'des'))?.state, 'a layout without DES components does not load DES').toBe('declared');
  expect(desReqs).toEqual([]);
  await page.evaluate(() => (window as any).viewer.modes.requestMode('des'));
  await expect.poll(() => activeMode(page), { timeout: 120_000 }).toBe('des');
  const des = await featureState(page, 'des');
  expect(des?.state).toBe('active');
  expect(des?.trigger).toBe('mode:des');
  expect(desReqs.length).toBeGreaterThan(0);
  expect((await featureState(page, 'asset-editor'))?.state).toBe('declared');
});

test('a blocked editor chunk leaves a Problems entry with Retry; retry succeeds', async ({ page }) => {
  test.setTimeout(240_000);
  await page.route(EDITOR_BODY, (route) => route.abort());
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  const before = await activeMode(page);

  await page.evaluate(() => Promise.resolve((window as any).viewer.modes.requestMode('editor')).catch(() => false));
  await expect.poll(() => featureState(page, 'asset-editor').then((s) => s?.state), { timeout: 60_000 }).toBe('failed');
  expect(await activeMode(page), 'the switch stays where it was').toBe(before);

  const problem = await page.evaluate(async () => {
    const store: any = await import(/* @vite-ignore */ '/src/core/hmi/problems-store.ts');
    const p = store.getProblems().find((x: any) => x.code === 'feature-load-failed');
    return p ? { title: p.title, action: p.action } : null;
  });
  expect(problem?.title).toMatch(/^Could not load /);
  expect(problem?.action?.label).toBe('Retry');
  expect(problem?.action?.commandId).toBe('feature.retry');

  // A failed import() stays failed in the page's module map; the retry re-imports the
  // chunk URL with a cache-bust query (plan-652 Abnahme-Befund 1) — no reload needed.
  await page.unroute(EDITOR_BODY);
  await page.evaluate(async (action: any) => {
    const reg: any = await import(/* @vite-ignore */ '/src/core/hmi/rv-command-registry.ts');
    await reg.commandRegistry.execute(action.commandId, action.args, { viewer: (window as any).viewer, origin: 'ui' });
  }, problem!.action);
  await expect.poll(() => featureState(page, 'asset-editor').then((s) => s?.state), { timeout: 120_000 }).toBe('active');
  await page.evaluate(() => (window as any).viewer.modes.requestMode('editor'));
  await expect.poll(() => activeMode(page), { timeout: 60_000 }).toBe('editor');
  const left = await page.evaluate(async () => {
    const store: any = await import(/* @vite-ignore */ '/src/core/hmi/problems-store.ts');
    return store.getProblems().filter((x: any) => x.code === 'feature-load-failed').length;
  });
  expect(left, 'the entry is cleared after a successful retry').toBe(0);
});
