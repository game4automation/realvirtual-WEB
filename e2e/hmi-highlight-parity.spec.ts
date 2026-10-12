// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.15 — HMI highlight / load parity tool for the loader bake.
 *
 * Phase 4a used it as the gate against the OLD pipeline (`rv.loader.bake`
 * off = baseline). Phase 4b deleted that pipeline and the flag, so the old
 * state can no longer be produced: the spec is now a REGRESSION TOOL between
 * two runs of the bake path. The committed `e2e/__baseline__/hmi-highlight-
 * parity/*.json|png` are the historical old-pipeline reference (2026-09-17);
 * re-record them from the current tree with `RV_PARITY_UPDATE=1` before using
 * the assertions as a regression check.
 *
 * One page per model: `?model=<url>`, wait for the load, deterministic
 * camera on a fixed pick node (a RuntimeMetadata node on Mauser, a Drive on
 * Toray / the demo), hover it through the REAL pointer path (page.mouse →
 * RaycastManager → pick backend), then select it through the selection
 * manager. Recorded per model: load time, `getRendererInfo()` (scene draw
 * calls / triangles, mesh count, bake stats), the resolved hover path, and a
 * hover + a select screenshot of the canvas.
 *
 * Two modes (env `RV_PARITY_MODE`):
 *  - `record` — runs the current code and WRITES `e2e/__baseline__/hmi-highlight-
 *    parity/<id>.json|-hover.png|-select.png` (the "previous run" of the next
 *    comparison). The orchestrator commits these.
 *  - default (`compare`) — runs the current code and ASSERTS against the
 *    recorded run: scene draw calls ≤ baseline × 1.1, load time
 *    ≤ baseline × 1.1 (+ 500 ms absolute slack for dev-server jitter —
 *    headless SwiftShader numbers are only meaningful RELATIVELY, same
 *    machine, same session; see perf-scale-smoke.spec.ts), hover resolves to
 *    the same node path, screenshot diff (pixelmatch, threshold 0.1) ≤ 3 % of
 *    the canvas. The 3 % absorbs the documented look change of Phase 4a: the
 *    HMI overlay FILL is kept through chunk proxies, the per-mesh
 *    `EdgesGeometry` lines of the old pairs are gone (plan-753 §5.4).
 *  - `RV_PARITY_UPDATE=1` rewrites the baseline in whatever mode runs.
 *
 * Without the private sibling repository the two private models are
 * skipped and only the public demo runs (the report says so).
 */

import { test, expect, type Page } from 'playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = resolve(HERE, '__baseline__/hmi-highlight-parity');
const PRIVATE_PROJECTS = [
  resolve(HERE, '../../realvirtual-WebViewer-Private~/projects'),
  resolve(HERE, '../../realvirtual-web-pro/projects'),
].find((c) => existsSync(c)) ?? null;

const MODE = process.env.RV_PARITY_MODE === 'baseline' || process.env.RV_PARITY_MODE === 'record' ? 'record' : 'compare';
const UPDATE = process.env.RV_PARITY_UPDATE === '1';
const LOAD_TIMEOUT_MS = 240_000;
const DRAW_CALL_FACTOR = 1.1;
const LOAD_FACTOR = 1.1;
const LOAD_SLACK_MS = 500;
const MAX_DIFF_RATIO = 0.03;

interface Case {
  id: string;
  url: string;
  /** Relative to the private projects dir; null = public. */
  privateFile: string | null;
  pick: 'metadata' | 'drive';
}

const CASES: Case[] = [
  { id: 'mauser', url: '/private-models/mauser3dhmi/MauserCageline30.glb', privateFile: 'mauser3dhmi/models/MauserCageline30.glb', pick: 'metadata' },
  { id: 'toray', url: '/private-models/Toray/Toray.glb', privateFile: 'Toray/models/Toray.glb', pick: 'drive' },
  { id: 'demo', url: '/demo-realvirtual/DemoRealvirtualWeb.glb', privateFile: null, pick: 'drive' },
];

interface Record_ {
  mode: string;
  url: string;
  loadMs: number;
  scene: { calls: number; triangles: number };
  meshCount: number;
  bake: unknown;
  pickPath: string;
  hoveredPath: string | null;
  hoverStrategy: string | null;
  selectStrategy: string | null;
  drives: number;
  camera: { pos: number[]; target: number[] };
}

type W = Window & typeof globalThis & { viewer?: any; __rvViewer?: any };

async function loadModel(page: Page, c: Case): Promise<number> {
  await page.goto(`/?model=${encodeURIComponent(c.url)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const v = (window as W).__rvViewer ?? (window as W).viewer;
      return !!v?.lastLoadResult?.root && !!v?.raycastManager;
    },
    null,
    { timeout: LOAD_TIMEOUT_MS, polling: 250 },
  );
  // Wall clock from navigation start (same dev server, same session — relative).
  return page.evaluate(() => Math.round(performance.now()));
}

/** Frame the pick node from a fixed direction and return its canvas pixel. */
async function frameAndRecord(page: Page, c: Case, baselinePath: string | null): Promise<Record_ & { px: number; py: number }> {
  return page.evaluate(async ({ pick, baselinePath }) => {
    const w = window as W;
    const v = w.__rvViewer ?? w.viewer;
    const THREE = await import(/* @vite-ignore */ '/node_modules/three/build/three.module.js');
    const root = v.lastLoadResult.root;
    const registry = v.lastLoadResult.registry;
    // Pick node: the recorded baseline path when present, else the first
    // DFS node of the requested kind that has geometry under it.
    let node: any = baselinePath ? registry.getNode(baselinePath) : null;
    if (!node) {
      root.traverse((o: any) => {
        if (node) return;
        const isKind = pick === 'metadata' ? !!o.userData?._rvMetadata : !!o.userData?.realvirtual?.Drive;
        if (!isKind) return;
        let hasMesh = false;
        o.traverse((m: any) => { if (m.isMesh) hasMesh = true; });
        if (hasMesh) node = o;
      });
    }
    if (!node) throw new Error('no pick node of kind ' + pick);
    const path = registry.getPathForNode(node);
    const box = new THREE.Box3().setFromObject(node);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const dir = new THREE.Vector3(0.6, 0.5, 0.65).normalize();
    v.camera.position.copy(center).addScaledVector(dir, size * 2.2);
    v.controls.target.copy(center);
    v.controls.update();
    v.camera.updateMatrixWorld(true);
    v.renderFrameForCapture();
    // Project the center to canvas pixels.
    const ndc = center.clone().project(v.camera);
    const canvas: HTMLCanvasElement = v.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    const px = r.left + (ndc.x + 1) / 2 * r.width;
    const py = r.top + (1 - ndc.y) / 2 * r.height;
    return {
      mode: '', url: '', loadMs: 0,
      scene: { calls: 0, triangles: 0 }, meshCount: 0, bake: null,
      pickPath: path, hoveredPath: null, hoverStrategy: null, selectStrategy: null,
      drives: v.lastLoadResult.drives.length,
      camera: { pos: v.camera.position.toArray(), target: v.controls.target.toArray() },
      px, py,
    };
  }, { pick: c.pick, baselinePath });
}

async function canvasShot(page: Page): Promise<Buffer> {
  const canvas = page.locator('canvas').first();
  const bb = await canvas.boundingBox();
  await page.evaluate(() => (((window as W).__rvViewer ?? (window as W).viewer) as any).renderFrameForCapture());
  return page.screenshot({ clip: bb ?? undefined, animations: 'disabled' });
}

function diffRatio(a: Buffer, b: Buffer): { ratio: number; diff: PNG | null } {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return { ratio: 1, diff: null };
  const diff = new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, diff.data, A.width, A.height, { threshold: 0.1 });
  return { ratio: n / (A.width * A.height), diff };
}

for (const c of CASES) {
  test(`hmi highlight parity: ${c.id} (${MODE})`, async ({ page }) => {
    test.setTimeout(LOAD_TIMEOUT_MS + 120_000);
    if (c.privateFile && !(PRIVATE_PROJECTS && existsSync(resolve(PRIVATE_PROJECTS, c.privateFile)))) {
      test.skip(true, `private model missing: ${c.privateFile}`);
      return;
    }
    const jsonPath = resolve(BASELINE_DIR, `${c.id}.json`);
    const hoverPath = resolve(BASELINE_DIR, `${c.id}-hover.png`);
    const selectPath = resolve(BASELINE_DIR, `${c.id}-select.png`);
    const writing = MODE === 'record' || UPDATE || !existsSync(jsonPath);
    const baseline: Record_ | null = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;

    // Startup overlays (terms / welcome / auto-quality) span the viewport and
    // would be what the canvas screenshot shows — pre-accept them, same keys
    // as control-window.spec.ts + the WelcomeModal terms key.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('rv-terms-accepted', '1');
        localStorage.setItem('rv-welcome-dismissed', 'true');
        localStorage.setItem('rv-auto-quality-applied', 'true');
      } catch { /* private mode */ }
    });
    // No loader flag any more (plan-753 Phase 4b): both modes run the bake path.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const loadMs = await loadModel(page, c);
    await page.waitForTimeout(1500); // async BVH / first frames settle
    // Whatever overlay still got through (best effort, same as collision.spec.ts).
    for (const testId of ['auto-quality-ok', 'welcome-dismiss']) {
      try {
        const btn = page.getByTestId(testId);
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 3_000 });
          await btn.waitFor({ state: 'detached', timeout: 3_000 });
        }
      } catch { /* not shown */ }
    }
    // Project HMIs (Mauser KPI panel, Toray parts list) draw over the canvas
    // centre — hide the HMI layer (deterministic in both modes) so the
    // screenshot compares the 3D view, and log what still sits on the centre
    // pixel. A blocking dialog (the first Phase-4a run compared two identical
    // terms dialogs and reported a 0 % diff) would show up here as DIALOG/BUTTON.
    try {
      const hmi = page.getByRole('button', { name: /Toggle HMI/ });
      if (await hmi.isVisible({ timeout: 500 })) await hmi.click({ timeout: 3_000 });
    } catch { /* no HMI toggle */ }
    await page.waitForTimeout(300);
    const covered = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return 'no canvas';
      const r = c.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === c || (top?.tagName === 'CANVAS') ? '' : (top?.tagName ?? 'null') + '#' + (top?.id ?? '') + '.' + (top?.className ?? '');
    });
    if (covered) console.log(`[parity:${c.id}] canvas centre covered by ${covered}`);
    expect(covered, 'blocking dialog over the canvas').not.toMatch(/^(DIALOG|BUTTON)/);
    const rec = await frameAndRecord(page, c, baseline?.pickPath ?? null);
    rec.mode = MODE;
    rec.url = c.url;
    rec.loadMs = loadMs;

    // Hover: the pointer first (the real DOM path), then — deterministic in a
    // headless page, where pointer hover is not guaranteed to land — a ray
    // from the camera through the node centre via the SAME resolution chain
    // (`updateFromXRController` → `_doRaycast` → backends → gates).
    await page.mouse.move(rec.px, rec.py);
    await page.waitForTimeout(300);
    const hover = await page.evaluate(({ target }) => {
      const v = ((window as W).__rvViewer ?? (window as W).viewer) as any;
      const rm = v.raycastManager;
      const origin = v.camera.position.clone();
      const dir = origin.clone().set(target[0], target[1], target[2]).sub(origin).normalize();
      rm.updateFromXRController(origin, dir);
      v.renderFrameForCapture();
      return {
        path: rm.hoveredNodePath ?? null,
        strategy: v.highlighter?._lastStrategy ?? null,
      };
    }, { target: rec.camera.target });
    rec.hoveredPath = hover.path;
    rec.hoverStrategy = hover.strategy;
    const hoverShot = await canvasShot(page);

    // Select through the selection manager.
    const sel = await page.evaluate((path: string) => {
      const v = ((window as W).__rvViewer ?? (window as W).viewer) as any;
      v.selectionManager.select(path);
      v.renderFrameForCapture();
      const info = v.getRendererInfo();
      return {
        strategy: v.highlighter?._lastStrategy ?? null,
        scene: { calls: info.frame.scene.calls, triangles: info.frame.scene.triangles },
        meshCount: info.meshCount,
        bake: info.bake,
      };
    }, rec.pickPath);
    rec.selectStrategy = sel.strategy;
    rec.scene = sel.scene;
    rec.meshCount = sel.meshCount;
    rec.bake = sel.bake;
    const selectShot = await canvasShot(page);

    const { px: _px, py: _py, ...record } = rec;
    console.log(`[parity:${c.id}] mode=${MODE} load=${loadMs}ms scene=${rec.scene.calls} calls/${rec.scene.triangles} tris `
      + `meshes=${rec.meshCount} drives=${rec.drives} pick=${rec.pickPath} hovered=${rec.hoveredPath} `
      + `hover=${rec.hoverStrategy} select=${rec.selectStrategy} bake=${JSON.stringify(rec.bake)}`);

    const critical = errors.filter((e) => !e.includes('favicon') && !e.includes('ResizeObserver'));
    expect(critical, 'page errors').toEqual([]);

    if (writing) {
      mkdirSync(BASELINE_DIR, { recursive: true });
      writeFileSync(jsonPath, JSON.stringify(record, null, 2) + '\n');
      writeFileSync(hoverPath, hoverShot);
      writeFileSync(selectPath, selectShot);
      console.log(`[parity:${c.id}] run recorded → ${jsonPath}`);
      return;
    }

    // Parity assertions against the recorded run.
    const b = baseline!;
    const hoverDiff = existsSync(hoverPath) ? diffRatio(readFileSync(hoverPath), hoverShot) : null;
    const selectDiff = existsSync(selectPath) ? diffRatio(readFileSync(selectPath), selectShot) : null;
    console.log(`[parity:${c.id}] baseline load=${b.loadMs}ms scene=${b.scene.calls}/${b.scene.triangles} `
      + `→ bake load=${loadMs}ms scene=${rec.scene.calls}/${rec.scene.triangles} `
      + `hoverDiff=${hoverDiff ? (hoverDiff.ratio * 100).toFixed(2) : 'n/a'}% selectDiff=${selectDiff ? (selectDiff.ratio * 100).toFixed(2) : 'n/a'}%`);
    // Keep the run's artefacts next to the baseline for inspection (gitignored by name).
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(resolve(BASELINE_DIR, `${c.id}.bake-run.json`), JSON.stringify(record, null, 2) + '\n');
    writeFileSync(resolve(BASELINE_DIR, `${c.id}-hover.bake-run.png`), hoverShot);
    writeFileSync(resolve(BASELINE_DIR, `${c.id}-select.bake-run.png`), selectShot);
    if (hoverDiff?.diff) writeFileSync(resolve(BASELINE_DIR, `${c.id}-hover.diff.png`), PNG.sync.write(hoverDiff.diff));
    if (selectDiff?.diff) writeFileSync(resolve(BASELINE_DIR, `${c.id}-select.diff.png`), PNG.sync.write(selectDiff.diff));

    expect(rec.scene.calls, 'scene draw calls').toBeLessThanOrEqual(Math.ceil(b.scene.calls * DRAW_CALL_FACTOR));
    expect(loadMs, 'load time').toBeLessThanOrEqual(b.loadMs * LOAD_FACTOR + LOAD_SLACK_MS);
    expect(rec.hoveredPath, 'hover resolves to the same node').toBe(b.hoveredPath);
    if (hoverDiff) expect(hoverDiff.ratio, 'hover screenshot diff').toBeLessThanOrEqual(MAX_DIFF_RATIO);
    if (selectDiff) expect(selectDiff.ratio, 'select screenshot diff').toBeLessThanOrEqual(MAX_DIFF_RATIO);
  });
}
