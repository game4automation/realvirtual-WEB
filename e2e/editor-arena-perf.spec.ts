// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.9 — the acceptance harness of Sektion 1 as a spec.
 *
 * Toray FA-11 (the acceptance model) in the editor with arenas: render CPU
 * median over 20 orbit frames (`renderer.render` wrapped with
 * `performance.now()`, summed over every pass of a frame), draw calls
 * (`renderer.info.render.calls` after `info.reset()`), hover latency at 12
 * raster points, and the same orbit in capture mode (the unbatched tree) as
 * the in-run reference. Thresholds are the plan's NFR: ≤ 10 ms, ≤ 150 calls.
 *
 * Mauser (the stress model, ≤ 150 ms Richtwert, not an acceptance limit) runs
 * only with `RV_E2E_ARENA_MAUSER=1` — its load alone takes a minute.
 *
 * Skips without the private project assets: the models are customer data and
 * live in the private sibling repository only.
 */

import { test, expect } from 'playwright/test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAS_PRIVATE_SOURCE } from './private-module-url';
import { enterEditorOn, installArenaHarness } from './_editor-arena';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRIVATE_PROJECTS = resolve(HERE, '../../realvirtual-WebViewer-Private~/projects');

const TORAY_FILE = 'TacomaPlant_R20_2024-05-16_C-CutoutTest-3DView-3DOrtho-FA-11Workcell.glb';
const TORAY_URL = `/private-assets/Toray/${TORAY_FILE}`;
const HAS_TORAY = existsSync(resolve(PRIVATE_PROJECTS, 'Toray', TORAY_FILE));

const MAUSER_URL = '/private-models/mauser3dhmi/MauserCageline30.glb';
const HAS_MAUSER = existsSync(resolve(PRIVATE_PROJECTS, 'mauser3dhmi', 'models', 'MauserCageline30.glb'));
const RUN_MAUSER = process.env.RV_E2E_ARENA_MAUSER === '1';

interface PerfReading {
  arena: { renderMsMedian: number; renderMsP95: number; callsMedian: number };
  unbatched: { renderMsMedian: number; renderMsP95: number; callsMedian: number };
  hover: { medianMs: number; p95Ms: number; hits: number };
  buildMs: number;
}

async function measure(page: import('playwright/test').Page, frames = 20): Promise<PerfReading> {
  await installArenaHarness(page);
  return page.evaluate(async (n) => {
    const w = window as any;
    const v = w.viewer;
    const H = w.__rvArena;
    await H.orbit(3);
    const arena = await H.orbit(n);
    const hover = H.hover(12);
    v.editorArena.enterCapture();
    await H.orbit(2);
    const unbatched = await H.orbit(n);
    v.editorArena.leaveCapture();
    const t0 = performance.now();
    v.editorArena.rebuild();
    const buildMs = performance.now() - t0;
    await H.frame();
    return { arena, unbatched, hover, buildMs };
  }, frames);
}

test.describe('plan-766 — editor arena performance harness', () => {
  test.skip(!HAS_PRIVATE_SOURCE || !HAS_TORAY, 'needs the private sibling repository with the Toray FA-11 project');
  test.setTimeout(300_000);

  test('Toray FA-11: render CPU ≤ 10 ms and ≤ 150 draw calls per frame', async ({ page }, info) => {
    const stats = await enterEditorOn(page, `/?model=${TORAY_URL}`, {
      builtin: { url: TORAY_URL, name: 'TacomaPlant FA-11' },
      rootMatch: 'FA-11',
      timeoutMs: 180_000,
    });
    const r = await measure(page);
    info.annotations.push({ type: 'arena-perf', description: JSON.stringify({ stats, ...r }) });
    expect(stats.arenas).toBeGreaterThan(0);
    expect(r.arena.callsMedian, 'draw calls per frame (all passes)').toBeLessThanOrEqual(150);
    expect(r.arena.renderMsMedian, 'render CPU median over 20 orbit frames').toBeLessThanOrEqual(10);
    // The in-run reference: the arenas must beat the unbatched tree clearly.
    expect(r.arena.renderMsMedian * 3).toBeLessThan(r.unbatched.renderMsMedian);
    expect(r.hover.hits).toBeGreaterThan(0);
    expect(r.buildMs, 'arena build (plan budget 0.2 s)').toBeLessThanOrEqual(400);
  });

  test('Mauser (stress, RV_E2E_ARENA_MAUSER=1): render CPU ≤ 150 ms', async ({ page }, info) => {
    test.skip(!RUN_MAUSER || !HAS_MAUSER, 'stress model: set RV_E2E_ARENA_MAUSER=1 (and have the mauser3dhmi project)');
    test.setTimeout(600_000);
    const stats = await enterEditorOn(page, `/?model=${MAUSER_URL}`, {
      builtin: { url: MAUSER_URL, name: 'MauserCageline30' },
      rootMatch: 'Mauser',
      timeoutMs: 300_000,
    });
    const r = await measure(page, 10);
    info.annotations.push({ type: 'arena-perf', description: JSON.stringify({ stats, ...r }) });
    expect(r.arena.renderMsMedian, 'render CPU median (Richtwert)').toBeLessThanOrEqual(150);
    expect(r.arena.renderMsMedian * 3).toBeLessThan(r.unbatched.renderMsMedian);
    expect(r.buildMs, 'arena build (plan budget 1 s)').toBeLessThanOrEqual(1500);
  });
});
