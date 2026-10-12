// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-503 F3: drag a placement of the served Layout Planner demo with the real
 * mouse, prove its WORLD transform moved and nothing else did, reload, and
 * assert the measured reload contract: **transient** (spike 2026-09-26, 3/3) —
 * a `?doc=` reload opens the read-only `bundled` document again and the
 * placement is back at its start position.
 *
 * Target: `ChainConveyor_1m` — visible in the start view at 1280×720, and a
 * 120 px drag moves it ALONE (spike: 707 mm, 0 collateral). NOT
 * `RollConveyor_2m_2`: a drag of it rotates its snap-connected chain of 10
 * placements by 180° (product finding, separate plan).
 *
 * `window.viewer` is READ for coordinates and state only (A1); every action is
 * the real mouse. The test title is part of the runner's contract
 * (scripts/rv-demo-smoke.mjs `JOURNEY_TITLES`, F14).
 */

import { expect, test, type Page } from 'playwright/test';
import { blockAnalytics, collectErrors, criticalErrors, waitForPlacementsMaterialized, waitForViewerReady } from '../_viewer-ready';
import { EXPECTED_DEMOS } from './_live-target';

const TARGET_NAME = 'ChainConveyor_1m';
/** World units are metres. */
const MIN_DRAG_M = 0.1;
const SAME_POSITION_M = 0.001;

interface Probe { id: string; sx: number; sy: number; world: [number, number, number] }

/** Reads id, projected bounding-box centre (viewport px) and world position of the target. */
async function probeTarget(page: Page): Promise<Probe> {
  return page.evaluate((name) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const v = (window as any).viewer;
    const lp = v.getPlugin('layout-planner');
    const V = v.scene.position.constructor;
    for (const [id, obj] of lp._objectMap as Map<string, any>) {
      if (obj.name !== name) continue;
      obj.updateWorldMatrix(true, true);
      const min = new V(Infinity, Infinity, Infinity);
      const max = new V(-Infinity, -Infinity, -Infinity);
      obj.traverse((o: any) => {
        if (!o.isMesh || !o.visible) return;
        const g = o.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox;
        for (let i = 0; i < 8; i++) {
          const p = new V(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)
            .applyMatrix4(o.matrixWorld);
          min.min(p); max.max(p);
        }
      });
      // The box centre, not the origin (origin y = 0, box centre y = 0.32 m).
      const centre = min.clone().add(max).multiplyScalar(0.5);
      const s = v.projectPoint(centre); // canvas-relative, SHARED Vector2 → copy now
      const sx = s.x; const sy = s.y;
      const rect = v.renderer.domElement.getBoundingClientRect(); // the render canvas, not canvas:first
      const w = obj.getWorldPosition(new V());
      return { id, sx: rect.left + sx, sy: rect.top + sy, world: [w.x, w.y, w.z] as [number, number, number] };
    }
    throw new Error(`placement ${name} not found`);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, TARGET_NAME);
}

/** World positions of every placement, by name. */
async function allWorld(page: Page): Promise<Record<string, [number, number, number]>> {
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const v = (window as any).viewer;
    const lp = v.getPlugin('layout-planner');
    const V = v.scene.position.constructor;
    const out: Record<string, [number, number, number]> = {};
    for (const obj of (lp._objectMap as Map<string, any>).values()) {
      const w = obj.getWorldPosition(new V());
      out[obj.name] = [w.x, w.y, w.z];
    }
    return out;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
}

async function openPlanner(page: Page): Promise<void> {
  await waitForViewerReady(page);
  await waitForPlacementsMaterialized(page);
  await page.waitForTimeout(1_500);
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test.afterEach(async ({ page }) => {
  // A6: nothing stays behind (a fresh context per test anyway). Bounded: a blocked
  // deleteDatabase must never turn a green journey into a timeout.
  await Promise.race([
    page.evaluate(async () => {
      localStorage.clear();
      for (const d of (await indexedDB.databases?.()) ?? []) if (d.name) indexedDB.deleteDatabase(d.name);
    }).catch(() => {}),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
});

test('drag moves the placement and reload follows the measured contract', async ({ page }, testInfo) => {
  // This journey boots the planner demo TWICE (open + reload). 120 s (the project limit) left no
  // headroom on a loaded dev PC (2026-09-27: 124 s with the body complete), so this one test gets
  // 180 s; with its retry it still fits the runner's 10-min budget (2×180 + ~150 s for the rest).
  test.setTimeout(180_000);
  const t0 = Date.now();
  const phases: Record<string, number> = {};
  const errors = collectErrors(page);
  await blockAnalytics(page);
  await page.goto(`?doc=${encodeURIComponent(EXPECTED_DEMOS.planner)}`, { waitUntil: 'domcontentloaded' });
  await openPlanner(page);
  phases.openMs = Date.now() - t0;

  const before = await probeTarget(page);
  const othersBefore = await allWorld(page);

  // Select by a real click on the box centre, then READ that the planner selected it —
  // a raycast miss must never look like "does not move".
  await page.mouse.click(before.sx, before.sy);
  await page.waitForTimeout(500);
  const selectedId = await page.evaluate(() => (window as unknown as {
    viewer: { getPlugin(id: string): { store: { getSnapshot(): { selectedId: string | null } } } };
  }).viewer.getPlugin('layout-planner').store.getSnapshot().selectedId);
  if (selectedId !== before.id) {
    const miss = testInfo.outputPath('raycast-miss.png');
    await page.screenshot({ path: miss });
    await testInfo.attach('raycast-miss', { path: miss, contentType: 'image/png' });
  }
  expect(selectedId, 'raycast missed the target placement').toBe(before.id);

  // Direct drag (canvas-interaction.ts) — real mouse, in steps.
  await page.mouse.move(before.sx, before.sy);
  await page.mouse.down();
  await page.mouse.move(before.sx + 120, before.sy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1_000);

  const after = await probeTarget(page);
  const movedM = dist(after.world, before.world);
  const othersAfter = await allWorld(page);
  const collateral = Object.keys(othersBefore)
    .filter((n) => n !== TARGET_NAME && dist(othersBefore[n], othersAfter[n] ?? othersBefore[n]) > SAME_POSITION_M);
  const shot = testInfo.outputPath('after-drag.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('after-drag', { path: shot, contentType: 'image/png' });
  expect(movedM, 'drag did not move the placement in world space').toBeGreaterThan(MIN_DRAG_M);
  expect(collateral, 'the drag moved other placements too').toEqual([]);

  phases.dragMs = Date.now() - t0;

  // Reload with no input in between; the URL still names the planner doc.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openPlanner(page);
  phases.reloadMs = Date.now() - t0;
  const reloaded = await probeTarget(page);
  const fromStart = dist(reloaded.world, before.world);
  const fromMoved = dist(reloaded.world, after.world);
  await testInfo.attach('reload-contract', {
    body: JSON.stringify({
      target: TARGET_NAME, id: before.id, contract: 'transient',
      worldBefore: before.world, worldAfterDrag: after.world, worldAfterReload: reloaded.world,
      dragDeltaMm: Math.round(movedM * 1000), reloadVsStartMm: Math.round(fromStart * 1000),
      reloadVsMovedMm: Math.round(fromMoved * 1000), collateral, phases,
    }, null, 2),
    contentType: 'application/json',
  });
  // Contract `transient`: the reload shows the bundled document again, at the start position.
  expect(fromStart, `after reload the placement is ${Math.round(fromStart * 1000)} mm from its start (contract: transient)`)
    .toBeLessThan(SAME_POSITION_M);

  expect(criticalErrors(errors), 'page/console errors during the planner journey').toEqual([]);
});
