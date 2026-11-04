// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { test, expect } from 'playwright/test';

// Smoke test: verify both WebGL and WebGPU modes boot without errors.
// Headless Chromium lacks real WebGPU → WebGPU mode falls back to WebGL backend.
// We still check that no JS errors occur and the "Ready" log appears.

for (const mode of ['webgl', 'webgpu'] as const) {
  test(`${mode}: viewer boots and loads demo scene without errors`, async ({ page }) => {
    const errors: string[] = [];
    const logs: string[] = [];

    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      const text = msg.text();
      logs.push(`[${msg.type()}] ${text}`);
      if (msg.type() === 'error') errors.push(text);
    });

    const url = mode === 'webgpu' ? '/?renderer=webgpu' : '/';
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for "Ready" log (up to 30s for model load)
    await expect(async () => {
      const hasReady = logs.some((l) => l.includes('Ready'));
      expect(hasReady).toBe(true);
    }).toPass({ timeout: 30_000, intervals: [500] });

    // Wait a bit more for any deferred render errors
    await page.waitForTimeout(2000);

    // Filter out known non-critical warnings
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('favicon.ico') &&
        !e.includes('net::ERR_') &&
        !e.includes('ResizeObserver'),
    );

    console.log(`\n=== ${mode.toUpperCase()} Console Logs ===`);
    for (const l of logs) console.log(l);

    if (criticalErrors.length > 0) {
      console.log(`\n=== ${mode.toUpperCase()} Errors ===`);
      for (const e of criticalErrors) console.log(e);
    }

    expect(criticalErrors).toHaveLength(0);
  });
}

/**
 * plan-745 F13 / review finding 13 — the WebGPU twin was never smoke-tested
 * for BATCHING, and `BatchNode` upstream is a moving target
 * (three.js#28753). A placement arena is a `BatchedMesh` created at RUNTIME,
 * long after the renderer picked its backend, so it is the one batching case
 * the load path never exercises.
 *
 * Skips cleanly when the environment has no real WebGPU (headless Chromium
 * normally falls back to the WebGL backend) or no planner — the point is to
 * catch a hard failure, not to assert a rasteriser.
 */
for (const mode of ['webgl', 'webgpu'] as const) {
  test(`${mode}: a placement arena builds and renders without errors`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

    const url = mode === 'webgpu' ? '/?mode=planner&renderer=webgpu' : '/?mode=planner';
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    type W = Window & typeof globalThis & { __rvViewer?: any; viewer?: any };
    // `__rvViewer` is published last in main.ts (after the plugins attach) and
    // the BatchTable only exists once a model has loaded — waiting for the
    // plugin object alone lands before either and skips for the wrong reason.
    const ready = await page.waitForFunction(
      () => {
        const v = (window as W).__rvViewer;
        return !!v?.getPlugin?.('layout-planner')?._viewer && !!v.batchTable;
      },
      null, { timeout: 120_000 },
    ).then(() => true).catch(() => false);

    const result = await page.evaluate(async (isReady: boolean) => {
      const w = window as W;
      const viewer = w.__rvViewer ?? w.viewer;
      const planner = viewer?.getPlugin?.('layout-planner');
      const backend = viewer?.rendererKind
        ?? (viewer?.renderer?.isWebGPURenderer ? 'webgpu' : 'webgl');
      if (!isReady || !planner) {
        return { skipped: 'planner or BatchTable unavailable (static merging off?)', backend };
      }

      const manifest = await (await fetch('/library/project.json')).json() as {
        documents: Array<{ id: string; name?: string; path?: string }>;
      };
      // A conveyor: real internals (drive + transport + snaps) and enough
      // meshes to actually produce arenas — the first catalog entry is a
      // two-mesh box that the bucket minimum leaves individual.
      const entry = manifest.documents.find((d) => d.id.includes('rollconveyor-2m') && d.path)
        ?? manifest.documents.find((d) => !!d.path);
      if (!entry) return { skipped: 'no usable library document', backend };
      const withUrl = { id: entry.id, name: entry.name, glbUrl: `/library/${entry.path}` };

      // Two placements of the SAME asset: the second one JOINS the arena the
      // first one created, which is the code path that has to work on both
      // backends (a second `setMatrixAt` + `addInstance` on a live BatchedMesh).
      await planner.placeComponent(withUrl, [0, 0, 0]);
      await planner.placeComponent(withUrl, [2500, 0, 0]);
      const deadline = Date.now() + 30_000;
      while ((planner.getPlacementArenaJoinsInFlight?.() ?? 0) > 0 && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 50));
      }
      viewer.frameSceneContent(false);
      await new Promise((res) => setTimeout(res, 600));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const info = viewer.getRendererInfo();
      const stats = viewer.batchTable.placementStats();
      return { backend, entry: entry.id, drawCalls: info.drawCalls, stats, skipped: null as string | null };
    }, ready);

    console.log(`\n=== ${mode.toUpperCase()} placement arena smoke ===\n`
      + JSON.stringify(result, null, 2));
    test.skip(!!result.skipped, `placement arena smoke skipped: ${result.skipped}`);

    const criticalErrors = errors.filter(
      (e) => !e.includes('favicon.ico') && !e.includes('net::ERR_')
        && !e.includes('ResizeObserver') && !e.includes('rvproject:')
        && !e.includes('409 (Conflict)')
        // Pre-existing WebGPU-backend limitation, nothing to do with batching:
        // the planner's snap/floor gizmos draw `LineLoop`s, which the WebGPU
        // renderer refuses. It fires once per gizmo per frame and would drown
        // out any real error, so it is filtered rather than tolerated in bulk.
        && !e.includes('THREE.LineLoop are not supported'),
    );
    if (criticalErrors.length > 0) console.log(`ERRORS: ${JSON.stringify(criticalErrors, null, 2)}`);
    expect(criticalErrors).toHaveLength(0);
    // Two placements, ONE shared arena set (F7) — on either backend. The
    // second placement JOINING a live BatchedMesh is the case the load path
    // never exercises, and the one `BatchNode` could plausibly break on.
    expect(result.stats.sets).toBe(1);
    expect(result.stats.placements).toBe(2);
    expect(result.stats.instances).toBeGreaterThan(0);
  });
}
