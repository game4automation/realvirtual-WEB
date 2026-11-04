// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.9 — `Sound` is configurable over MCP without a tool of its own:
 * the generic component command behind `web_editor_add_component`
 * (`web_execute("editor.addComponent", …)`) attaches it to a Drive_Cylinder with
 * `Variant = Hard`; the component resolves Cylinder/Hard and the inspector shows
 * the Type row with "Hard".
 *
 * Needs the asset editor (private sibling) — skips in a public-only checkout.
 * In-page imports go through `new Function('p', 'return import(p)')` (see
 * `_editor-arena.ts`).
 */

import { expect, test } from 'playwright/test';
import { waitForViewerReady } from './_viewer-ready';
import { HAS_PRIVATE_SOURCE } from './private-module-url';

const DEMO_URL = '/?model=DemoRealvirtualWeb.glb';

test('Sound via the generic MCP component command on a cylinder, Variant=Hard visible in the inspector', async ({ page }) => {
  test.skip(!HAS_PRIVATE_SOURCE, 'needs the asset editor (private sibling)');
  test.setTimeout(180_000);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  const path = await page.evaluate(() => {
    const v = (window as unknown as Record<string, any>).viewer;
    const all = v.registry.getAll('Drive_Cylinder') as Array<{ path: string }>;
    return all.length ? all[0].path : null;
  });
  test.skip(!path, 'demo model has no Drive_Cylinder');

  await page.evaluate(async () => { await (window as unknown as Record<string, any>).viewer.modes.requestMode('editor'); });
  await page.waitForFunction(() => (window as unknown as Record<string, any>).viewer?.editorArena?.isBuilt, undefined, { timeout: 90_000 });

  const result = await page.evaluate(async (p) => {
    const dyn = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    const { commandRegistry } = await dyn('/src/core/hmi/rv-command-registry.ts');
    const r = await commandRegistry.execute('editor.addComponent',
      { path: p, type: 'Sound', propsJson: JSON.stringify({ Variant: 'Hard' }) }, { origin: 'mcp' });
    const { getRegisteredSounds } = await dyn('/src/core/engine/rv-sound.ts');
    const sound = [...getRegisteredSounds()].find((s: any) => s.node?.userData?.realvirtual?.Sound);
    return { ok: !!r, kind: sound?.kind ?? null, variant: sound?.variant ?? null };
  }, path);
  expect(result.kind).toBe('Cylinder');
  expect(result.variant).toBe('Hard');

  await page.evaluate((p) => { (window as unknown as Record<string, any>).viewer.selectionManager.select(p); }, path);
  const row = page.getByTestId('rv-sound-variant');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByRole('combobox')).toHaveText('Hard');
});
