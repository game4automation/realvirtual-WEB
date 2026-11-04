// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.9 — arena parity: the batched editor display draws and picks
 * what the unbatched tree would.
 *
 * The reference is the SAME scene in capture mode (`editorArena.enterCapture()`:
 * the sources back on their layers, the arenas masked out) — i.e. exactly what
 * the editor drew before plan-766, rendered by the same renderer, camera and
 * frame path a moment later. Three checks:
 *
 *  - pixels: at most {@link PIXEL_TOLERANCE_PCT} % of the pixels differ by more
 *    than 24/255 in any channel (measured in Chrome 2026-10-19: Toray 0.007 %,
 *    Mauser 0.0004 % once the scene has settled; the residue is float ordering), and the frame is
 *    not blank (colour bins) — two empty frames would agree trivially;
 *  - picks: 50 raster rays resolve to the same node paths with and without the
 *    arenas (picking runs on the sources either way — this pins that the arena
 *    install did not change it);
 *  - state golden (`e2e/_golden.ts`): the demo document's arena layout —
 *    arenas, instances, standalone meshes, draw-call estimate — is recorded and
 *    compared exactly, so a classification change shows up as a one-line diff.
 *    Record it deliberately with `RV_UPDATE_GOLDENS=1`.
 */

import { test, expect } from 'playwright/test';
import { HAS_PRIVATE_SOURCE } from './private-module-url';
import { enterEditorOn, installArenaHarness } from './_editor-arena';
import { expectGolden } from './_golden';

const DEMO_URL = '/?model=DemoRealvirtualWeb.glb';
/** Share of pixels allowed to differ (percent). */
const PIXEL_TOLERANCE_PCT = 0.5;

test.describe('plan-766 — editor arena parity (demo document)', () => {
  test.skip(!HAS_PRIVATE_SOURCE, 'needs the private sibling repository (asset-editor source)');
  test.setTimeout(150_000);

  test('pixels, picks and arena layout match the unbatched tree', async ({ page }) => {
    const stats = await enterEditorOn(page, DEMO_URL);
    await installArenaHarness(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      const v = w.viewer;
      const H = w.__rvArena;
      await H.frame();
      const arenaPix = H.grab();
      const arenaPicks = H.pickRays(50);
      v.editorArena.enterCapture();
      await H.frame();
      const sourcePix = H.grab();
      const sourcePicks = H.pickRays(50);
      v.editorArena.leaveCapture();
      await H.frame();
      const samePicks = arenaPicks.every((p: string | null, i: number) => p === sourcePicks[i]);
      return {
        diffPct: H.pixelDiff(arenaPix, sourcePix),
        bins: H.colourBins(arenaPix),
        samePicks,
        pickHits: arenaPicks.filter(Boolean).length,
        captureDepthAfter: v.editorArena.captureDepth,
      };
    });

    expect(result.bins, 'the arena frame is not blank').toBeGreaterThan(8);
    expect(result.diffPct, `pixel parity (≤ ${PIXEL_TOLERANCE_PCT} % differing pixels)`).toBeLessThanOrEqual(PIXEL_TOLERANCE_PCT);
    expect(result.pickHits, 'the pick raster hits the model').toBeGreaterThan(0);
    expect(result.samePicks, '50 rays resolve to the same paths with and without arenas').toBe(true);
    expect(result.captureDepthAfter).toBe(0);

    expectGolden('editor-arena-parity/demo-arena-layout', {
      arenas: stats.arenas,
      instances: stats.instances,
      standalone: stats.standalone,
      drawCallsEstimate: stats.drawCallsEstimate,
    });
  });
});
