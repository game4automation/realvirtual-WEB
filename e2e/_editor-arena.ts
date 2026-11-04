// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared scaffolding for the plan-766 editor-arena specs
 * (`editor-batched-display`, `editor-arena-parity`, `editor-arena-perf`).
 *
 * Two things live here:
 *  - {@link enterEditorOn} — boot a URL, optionally hand the editor a
 *    `builtinModel` base through the pending-open store, enter the editor and
 *    wait until `viewer.editorArena` is BUILT on that model (the editor's
 *    activation is fire-and-forget, so "requestMode resolved" is not "ready");
 *  - {@link installArenaHarness} — the measurement harness of the plan's
 *    acceptance (Sektion 1): `renderer.render` wrapped with `performance.now()`,
 *    `renderer.info` reset per frame, a 2°-step camera orbit, a 12-point hover
 *    raster, a 50-ray pick raster and a canvas grab for pixel comparisons.
 *    Installed as `window.__rvArena`.
 *
 * Module imports inside `page.evaluate` go through `new Function('p', 'return
 * import(p)')`: a literal `import()` in the callback would be rewritten by
 * Playwright's serializer (see `editor-rebind-after-modes.spec.ts`).
 */

import type { Page } from 'playwright/test';
import { waitForViewerReady } from './_viewer-ready';
import { privateModuleUrl } from './private-module-url';

/** The asset-editor pending-open store (private repo, addressed through `/@fs`). */
const PENDING_OPEN_MODULE = privateModuleUrl('plugins/asset-editor/pending-open-store.ts');

export interface EditorArenaStats {
  arenas: number;
  instances: number;
  standalone: number;
  drawCallsEstimate: number;
  grows: number;
  captureDepth: number;
}

/**
 * Boot `url`, enter the editor and wait for the arenas.
 *
 * `builtin` (optional) is the model URL the editor should open as a
 * `builtinModel` base — needed when the editor would otherwise resume a
 * different, last-edited asset. `rootMatch` is a substring of the model root's
 * name that must be on screen before the wait ends.
 */
export async function enterEditorOn(
  page: Page,
  url: string,
  opts: { builtin?: { url: string; name: string }; rootMatch?: string; timeoutMs?: number } = {},
): Promise<EditorArenaStats> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  await page.evaluate(async ({ pendingModule, builtin }) => {
    const w = window as unknown as Record<string, any>;
    if (builtin) {
      const dyn = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
      const mod = await dyn(pendingModule);
      mod.setPendingAssetOpen({ kind: 'builtinModel', url: builtin.url, name: builtin.name });
    }
    await w.viewer.modes.requestMode('editor');
  }, { pendingModule: PENDING_OPEN_MODULE, builtin: opts.builtin ?? null });
  await page.waitForFunction(
    (match) => {
      const v = (window as unknown as Record<string, any>).viewer;
      if (v?.modes?.activeMode !== 'editor' || !v.editorArena?.isBuilt) return false;
      return !match || String(v.currentModelRoot?.name ?? '').includes(match);
    },
    opts.rootMatch ?? '',
    { timeout: opts.timeoutMs ?? 90_000, polling: 250 },
  );
  return arenaStats(page);
}

export async function arenaStats(page: Page): Promise<EditorArenaStats> {
  return page.evaluate(() => (window as unknown as Record<string, any>).viewer.editorArena.stats());
}

/** Install `window.__rvArena` (idempotent). */
export async function installArenaHarness(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    if (w.__rvArena) return;
    const v = w.viewer;
    const r = v.renderer;
    const raf = () => new Promise<void>((res) => requestAnimationFrame(() => res()));
    const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
    const med = (a: number[]) => { const s = sorted(a); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    const p95 = (a: number[]) => { const s = sorted(a); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
    if (!r.__rvArenaWrapped) {
      const orig = r.render.bind(r);
      r.__acc = 0;
      r.__passes = 0;
      r.render = function (s: unknown, c: unknown) {
        const t = performance.now();
        try { return orig(s, c); } finally { r.__acc += performance.now() - t; r.__passes++; }
      };
      r.__rvArenaWrapped = true;
    }
    async function frame() {
      r.info.reset(); r.__acc = 0; r.__passes = 0;
      v.markRenderDirty(); await raf(); await raf();
      return { ms: r.__acc, calls: r.info.render.calls, passes: r.__passes };
    }
    async function orbit(n = 20, stepDeg = 2) {
      const t = v.controls.target;
      const cam = v.camera;
      const off = cam.position.clone().sub(t);
      const ms: number[] = [], calls: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = stepDeg * Math.PI / 180;
        const x = off.x * Math.cos(a) - off.z * Math.sin(a);
        const z = off.x * Math.sin(a) + off.z * Math.cos(a);
        off.x = x; off.z = z;
        cam.position.copy(t).add(off); cam.lookAt(t); cam.updateMatrixWorld();
        r.info.reset(); r.__acc = 0; r.__passes = 0; v.markRenderDirty(); await raf();
        ms.push(r.__acc); calls.push(r.info.render.calls);
      }
      return { renderMsMedian: med(ms), renderMsP95: p95(ms), callsMedian: med(calls) };
    }
    function rasterPoint(i: number, cols: number, rows: number, margin: number) {
      const el = r.domElement.getBoundingClientRect();
      const gx = ((i % cols) + 0.5) / cols;
      const gy = (Math.floor(i / cols) % rows + 0.5) / rows;
      return { clientX: el.left + el.width * (margin + (1 - 2 * margin) * gx), clientY: el.top + el.height * (margin + (1 - 2 * margin) * gy) };
    }
    function hover(n = 12) {
      const ts: number[] = [];
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const p = rasterPoint(i, 4, 3, 0.25);
        const t0 = performance.now();
        const h = v.raycastManager.raycastForRVNodeDetailed(p);
        ts.push(performance.now() - t0);
        if (h) hits++;
      }
      return { medianMs: med(ts), p95Ms: p95(ts), hits };
    }
    function pickRays(n = 50): (string | null)[] {
      const out: (string | null)[] = [];
      for (let i = 0; i < n; i++) out.push(v.raycastManager.raycastForRVNodeDetailed(rasterPoint(i, 10, 5, 0.15))?.path ?? null);
      return out;
    }
    function grab(): Uint8ClampedArray {
      v.renderFrameForCapture();
      const c = r.domElement as HTMLCanvasElement;
      const tmp = document.createElement('canvas');
      tmp.width = c.width; tmp.height = c.height;
      const ctx = tmp.getContext('2d')!;
      ctx.drawImage(c, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    }
    /** Percentage of pixels whose any channel differs by more than `tol`. */
    function pixelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, tol = 24): number {
      let diff = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > tol || Math.abs(a[i + 1] - b[i + 1]) > tol || Math.abs(a[i + 2] - b[i + 2]) > tol) diff++;
      }
      return (diff / (a.length / 4)) * 100;
    }
    /** Distinct coarse colours in a grab — guards against comparing two blank frames. */
    function colourBins(a: Uint8ClampedArray): number {
      const bins = new Set<number>();
      for (let i = 0; i < a.length; i += 4 * 97) bins.add(((a[i] >> 4) << 8) | ((a[i + 1] >> 4) << 4) | (a[i + 2] >> 4));
      return bins.size;
    }
    w.__rvArena = { frame, orbit, hover, pickRays, grab, pixelDiff, colourBins };
  });
}
