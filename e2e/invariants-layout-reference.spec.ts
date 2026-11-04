// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.15 — **F9 for the corrected I5 contract.**
 *
 * A document with DELAYED materialising references (`DemoPlanner.glb`) must not
 * trigger I5. This is the exact false alarm that "one frame after
 * `model-loaded`" would have produced: `model-loaded` fires at
 * `rv-viewer.ts:5020`, BEFORE `placements.sealLoad()` (`:5023`) and before
 * `whenLoadingIdle()` (`:5042`), and `:634-638` says outright that the
 * references of a layout document arrive seconds later. A baseline taken there
 * would count those later materialisations as a leak on the next return cycle.
 *
 * The spec proves two things, in this order:
 *
 *  1. that this document really does exercise the risk — the renderer counters
 *     at `model-loaded` differ from those at the load-bound completion. If they
 *     did not, the test would pass without meaning anything;
 *  2. that a full mode return cycle afterwards reports no I5 (nor any other
 *     invariant), i.e. the layer took its baseline at the right point.
 *
 * Without this spec the contract is asserted, not demonstrated.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect } from 'playwright/test';
import { collectErrors, waitForViewerReady } from './_viewer-ready';

/** The layout document of the dev project — `public/demo-realvirtual/project.json`. */
const LAYOUT_MODEL = 'demo-realvirtual/DemoPlanner.glb';

/** Renderer counters I5 compares. */
async function memory(page: import('playwright/test').Page): Promise<{ geometries: number; textures: number }> {
  return page.evaluate(() => {
    const info = (window as any).viewer.renderer?.info?.memory;
    return { geometries: info?.geometries ?? -1, textures: info?.textures ?? -1 };
  });
}

/** One rendered frame — the join point the deferred invariants execute at. */
async function renderedFrame(page: import('playwright/test').Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test('a delayed materialising reference does not trigger I5', async ({ page }) => {
  test.setTimeout(240_000);

  const errors = collectErrors(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  // Load the layout document, sampling at BOTH markers in one go.
  //
  // Note on the load-bound marker: the `placements-materialized` listener is
  // registered BEFORE `loadModel`, so what is awaited is THIS load's event.
  // `whenPlacementsMaterialized()` alone is not enough after a second load —
  // it can still be settled from the previous one and then resolves at once
  // (measured: the counters came back unchanged because the wait was a no-op).
  // That is the same failure mode as the forbidden early `whenSceneReady()`.
  const measured = await page.evaluate(async (url: string) => {
    const v = (window as any).viewer;
    const sample = () => {
      const m = v.renderer?.info?.memory;
      return {
        geometries: m?.geometries ?? -1,
        textures: m?.textures ?? -1,
        nodes: v.registry?.size?.nodes ?? -1,
        placementsState: v.placements?.state ?? null,
      };
    };
    const atModelLoaded = new Promise<ReturnType<typeof sample>>((resolve) => {
      v.on('model-loaded', () => resolve(sample()));
    });
    const materialized = new Promise<{ total: number; materialized: number }>((resolve) => {
      v.on('placements-materialized', (info: any) => resolve(info));
    });

    await v.loadModel(url);
    const loaded = await atModelLoaded;
    const info = await materialized;
    // One ACTUALLY rendered frame after the load-bound completion — the point
    // the baseline is taken at.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    return { loaded, info, completion: sample() };
  }, LAYOUT_MODEL);

  const { loaded, info, completion } = measured;
  console.log(`[9.15] at model-loaded: ${JSON.stringify(loaded)}`);
  console.log(`[9.15] placements: ${JSON.stringify(info)}`);
  console.log(`[9.15] at load-bound completion: ${JSON.stringify(completion)}`);

  // (1) This document must really exercise the risk the contract exists for:
  //     references that arrive AFTER `model-loaded`. Otherwise the silence
  //     below would prove nothing.
  expect(info.materialized, 'DemoPlanner.glb must place references').toBeGreaterThan(0);
  expect(loaded.placementsState, 'at model-loaded the placements must still be in flight').not.toBe('idle');
  expect(completion.placementsState).toBe('idle');
  expect(
    completion.nodes,
    `nodes must grow after model-loaded (${loaded.nodes} -> ${completion.nodes})`,
  ).toBeGreaterThan(loaded.nodes);
  expect(
    completion.geometries,
    `geometries must grow after model-loaded (${loaded.geometries} -> ${completion.geometries})`,
  ).toBeGreaterThan(loaded.geometries);

  // (2) A full return cycle through another mode and back must stay silent.
  //     A baseline taken one frame after `model-loaded` would now report
  //     exactly this growth as an I5 leak.
  const before = errors.length;
  for (const mode of ['commissioning', 'hmi']) {
    await page.evaluate((m: string) => (window as any).viewer.modes.setMode(m), mode);
    await renderedFrame(page);
    await renderedFrame(page);
  }

  const invariantErrors = errors.slice(before).filter((e) => e.includes('[rv-invariants]'));
  expect(invariantErrors, 'a layout document must not make the invariant layer fire').toEqual([]);
});
