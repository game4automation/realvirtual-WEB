// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.9 — placement render parity on the bake pipeline (rewritten in
 * Phase 4b; the plan-745 arena / pick-bundle assertions this file used to
 * carry went with those pipelines).
 *
 * Three things live here:
 *
 *  1. **Baseline** — what a placement costs on the bake path: draw calls of
 *     the scene pass (`frame.scene`), triangles, per-phase drop time, and
 *     the bake registry (`web_status.bake` = `getRendererInfo().bake`): every
 *     placement is ONE bake instance, no scene-wide rebuild exists.
 *  2. **Slope** — repeating ONE asset shares its chunk geometries: the
 *     registry's `chunks` stays flat while `instances` / `chunkMeshes` grow
 *     linearly and the scene-pass draw calls grow by the asset's chunk count
 *     per repeat.
 *  3. **Session == reload** — place, save, re-open: the reloaded document is
 *     baked in place with a forced split at every placement root, so the
 *     bake counters and the consumer readings (meshes, shadow casters,
 *     clipping, pick resolution to the OWN placement root) agree.
 *
 * ## How to read the numbers
 *
 * Relatively, never absolutely. Headless Chromium renders through SwiftShader,
 * so every timing here is a property of the software rasteriser as much as of
 * the viewer. What IS meaningful across runs on one machine: the DELTA between
 * two configurations (session vs reload) and the counts (draw calls of one
 * framed view, chunk meshes, instances), which are rasteriser-independent.
 */

import { test, expect, type Page } from 'playwright/test';

/** 10 distinct assets × 5 placements — repetition is the whole point. */
const DISTINCT_ASSETS = 10;
const REPEATS_PER_ASSET = 5;
const TOTAL_PLACEMENTS = DISTINCT_ASSETS * REPEATS_PER_ASSET;

/** Parity run: smaller, because it survives a full save + re-open. */
const PARITY_DISTINCT = 3;
const PARITY_REPEATS = 4;
const PARITY_TOTAL = PARITY_DISTINCT * PARITY_REPEATS;

interface PhaseTiming { phase: string; ms: number }
interface PlacementTiming {
  op: string;
  id: string;
  mode?: string;
  phases: PhaseTiming[];
  totalMs: number;
  firstFrameMs?: number;
  drawCallsAfter?: number;
  requestedBvhRebuild?: boolean;
}
interface BakeStats { instances: number; assets: number; chunks: number; chunkMeshes: number; keepMeshes: number; drawCalls: number }
/** What `__rv753.counts()` answers — the parity vector. */
interface Counts {
  drawCalls: number;
  triangles: number;
  bake: BakeStats;
  /** Chunk meshes actually in the scene graph (`_rvBakeChunk`), incl. the in-place model's. */
  chunkMeshesInScene: number;
  placements: number;
}
interface Baseline {
  placed: number;
  failures: string[];
  assetsUsed: string[];
  before: Counts;
  after: Counts;
  timings: PlacementTiming[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = Window & typeof globalThis & { __rvViewer?: any; viewer?: any; __rv753?: any };

const MODULE_PATHS = { sceneStore: '/src/core/hmi/scene/scene-store-singleton.ts' };

/**
 * Install `window.__rv753` — the in-page harness (pattern `__rv410` in
 * `editor-continuity.spec.ts`). Everything a parity assertion needs is sampled
 * INSIDE the page: draw calls off the renderer's frame stats, bake counters
 * off the `BakeRegistry`, pick resolution off the RaycastManager.
 */
async function installHarness(page: Page): Promise<void> {
  await page.evaluate(async (paths) => {
    const w = window as W;
    const sceneStore = await import(/* @vite-ignore */ paths.sceneStore);
    // __rvViewer is published LAST in main.ts (after the plugins are attached).
    const viewer = w.__rvViewer;
    const planner = () => viewer.getPlugin('layout-planner');
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    w.__rv753 = {
      viewer,
      planner,
      store: () => sceneStore.getSceneStore(),

      /** Wait for the async bake BVHs and the debounced frames. */
      async quiesce(timeoutMs = 30_000) {
        // Deferred reload placements instantiate asynchronously after the load.
        await planner().whenPlacementsMaterialized?.();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const pending = [...viewer.bakeRegistry.instances].some((i: any) => i.asset?.ready && !i.asset.bvhReady);
          if (!pending) break;
          await sleep(50);
        }
        await sleep(400);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      },

      /** Frame the layout, then sample. Framing is MANDATORY before any
       *  draw-call read — otherwise one measures frustum culling. */
      async sample(): Promise<Counts> {
        viewer.frameSceneContent(false);
        await sleep(250);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        return w.__rv753.counts();
      },

      counts(): Counts {
        const info = viewer.getRendererInfo();
        let chunkMeshesInScene = 0;
        viewer.scene.traverse((n: any) => { if (n.isMesh && n.userData?._rvBakeChunk) chunkMeshesInScene++; });
        return {
          drawCalls: info.frame.scene.calls,
          triangles: info.frame.scene.triangles,
          bake: info.bake,
          chunkMeshesInScene,
          placements: w.__rv753.placementPaths().length,
        };
      },

      /**
       * A real pick through the FULL resolution pipeline (`raycastRay` — the
       * same entry point `web_camera_fly` uses), fired straight down onto the
       * node's bounding-box centre. Returns the resolved node path.
       */
      pickAt(path: string): string | null {
        const node = viewer.registry?.getNode(path);
        if (!node) return null;
        node.updateWorldMatrix(true, true);
        const min = { x: Infinity, y: Infinity, z: Infinity };
        const max = { x: -Infinity, y: -Infinity, z: -Infinity };
        let any = false;
        node.traverse((n: any) => {
          if (!n.isMesh || n.userData?._highlightOverlay) return;
          const g = n.geometry;
          if (!g?.attributes?.position) return;
          if (!g.boundingBox) g.computeBoundingBox();
          const b = g.boundingBox.clone();
          b.applyMatrix4(n.matrixWorld);
          min.x = Math.min(min.x, b.min.x); min.y = Math.min(min.y, b.min.y); min.z = Math.min(min.z, b.min.z);
          max.x = Math.max(max.x, b.max.x); max.y = Math.max(max.y, b.max.y); max.z = Math.max(max.z, b.max.z);
          any = true;
        });
        if (!any) return null;
        const centre = node.position.clone();
        centre.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        const origin = centre.clone();
        origin.y = max.y + 10_000;
        const dir = centre.clone().sub(origin).normalize();
        return viewer.raycastManager?.raycastRay(origin, dir)?.path ?? null;
      },

      /** Which pick geometry answers for a node: its own bake instance
       *  (planner placement), the in-place model bake, or aux targets. */
      pickKind(path: string): string {
        const node = viewer.registry?.getNode(path);
        if (!node) return 'no-node';
        const inst = viewer.bakeRegistry.instanceOf(node);
        if (inst) return inst.inPlace ? 'in-place' : 'placement';
        for (let p = node.parent; p; p = p.parent) {
          const i = viewer.bakeRegistry.instanceOf(p);
          if (i) return i.inPlace ? 'in-place' : 'placement';
        }
        return 'aux';
      },

      /** The per-consumer reading. Compared placed-vs-loaded, never absolute. */
      consumerReading(path: string): any {
        const node = viewer.registry?.getNode(path);
        if (!node) return null;
        let chunkMeshes = 0; let castShadow = 0; let clipped = 0; let visible = 0; let keepMeshes = 0; let keepVisible = 0;
        node.traverse((n: any) => {
          if (!n.isMesh || n.userData?._highlightOverlay) return;
          if (n.userData?._rvBakeChunk) {
            chunkMeshes++;
            if (n.castShadow) castShadow++;
            if (n.visible) visible++;
            const mats = Array.isArray(n.material) ? n.material : [n.material];
            if (mats.some((m: any) => m?.clippingPlanes?.length > 0)) clipped++;
          } else if (n.layers.mask !== 0) {
            keepMeshes++;
            let eff = n.visible;
            for (let p = n.parent; p && eff; p = p.parent) eff = p.visible;
            if (eff) keepVisible++;
          }
        });
        const rv = (node.userData?.realvirtual ?? {}) as Record<string, unknown>;
        return {
          chunkMeshes,
          keepMeshes,
          keepVisible,
          castShadow,
          visible,
          clipped,
          pickKind: w.__rv753.pickKind(path),
          pick: w.__rv753.pickAt(path),
          aasLink: !!rv.AASLink,
          webMarkers: Object.keys(rv).filter((k) => k.startsWith('Web')).sort(),
          sensorViz: (() => { let n = 0; node.traverse((c: any) => { if (c.name?.endsWith('_sensorViz')) n++; }); return n; })(),
        };
      },

      /** Place `repeats` copies of the first `distinct` catalog entries. */
      async placeGrid(distinct: number, repeats: number): Promise<any> {
        const manifest = await (await fetch('/library/project.json')).json();
        const entries = manifest.documents
          .filter((d: any) => !!d.path)
          .slice(0, distinct)
          .map((d: any) => ({ id: d.id, name: d.name, glbUrl: `/library/${d.path}` }));
        if (entries.length < distinct) throw new Error(`catalog has only ${entries.length} usable entries`);
        const failures: string[] = [];
        const ids: string[] = [];
        for (let r = 0; r < repeats; r++) {
          for (let i = 0; i < entries.length; i++) {
            try {
              const id = await planner().placeComponent(entries[i], [i * 2500, 0, r * 2500]);
              ids.push(typeof id === 'string' ? id : '');
            } catch (e) {
              failures.push(`${entries[i].id}: ${(e as Error).message}`);
            }
          }
        }
        return { failures, ids, assetsUsed: entries.map((e: any) => e.id) };
      },

      /** Every placement root in the LIVE TREE, depth-first, never descending past one. */
      placementPaths(): string[] {
        const root = viewer.currentModelRoot;
        if (!root) return [];
        const out: string[] = [];
        const isAnchor = (n: any): boolean => {
          const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
          return !!rv && (!!rv.LayoutObject || !!rv.PlacementMeta);
        };
        const walk = (n: any): void => {
          if (n !== root && isAnchor(n)) {
            const p = viewer.registry?.getPathForNode(n);
            if (p) out.push(p);
            return;
          }
          for (const c of n.children) walk(c);
        };
        walk(root);
        return out;
      },

      /**
       * Save the scene and open it again — the reload half of the parity claim.
       * Document route where a project allows it, baked GLB bytes over a blob
       * URL otherwise; both run the full loader (in-place bake).
       */
      async roundTrip(name: string): Promise<{ route: string; bytes: number; error: string | null }> {
        const store = sceneStore.getSceneStore();
        try {
          const id = await store.saveAs(name);
          await store.openDocument(id);
          return { route: 'document', bytes: -1, error: null };
        } catch (documentError) {
          try {
            const bytes = await store.exportSceneGlb();
            const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
            await store.openBuiltin(url, name, { updateUrl: false });
            return { route: `glb-blob (document route unavailable: ${documentError})`, bytes: bytes.byteLength, error: null };
          } catch (e) {
            return { route: 'none', bytes: 0, error: String(e) };
          }
        }
      },
    };
  }, MODULE_PATHS);
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?mode=planner', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as W).__rvViewer?.getPlugin?.('layout-planner'),
    null, { timeout: 120_000 });
  await page.waitForFunction(
    () => !!(window as W).__rvViewer?.getPlugin?.('layout-planner')?._viewer,
    null, { timeout: 120_000 },
  );
  await installHarness(page);
}

async function measureBaseline(page: Page): Promise<Baseline> {
  return page.evaluate(async ({ distinct, repeats }) => {
    const w = window as W;
    const h = w.__rv753;
    const planner = h.planner();
    if (!planner) throw new Error('layout-planner plugin not available');
    planner.clearPlacementTimings();
    const before = await h.sample();
    const { failures, ids, assetsUsed } = await h.placeGrid(distinct, repeats);
    await h.quiesce();
    const after = await h.sample();
    return {
      placed: ids.length,
      failures,
      assetsUsed,
      before,
      after,
      timings: JSON.parse(JSON.stringify(planner.getPlacementTimings())) as PlacementTiming[],
    };
  }, { distinct: DISTINCT_ASSETS, repeats: REPEATS_PER_ASSET });
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function logCounts(label: string, c: Counts): void {
  console.log(`  ${label.padEnd(9)} scene calls=${String(c.drawCalls).padStart(4)} tris=${String(c.triangles).padStart(8)}`
    + `  bake(assets=${c.bake.assets} chunks=${c.bake.chunks} instances=${c.bake.instances}`
    + ` chunkMeshes=${c.bake.chunkMeshes} keep=${c.bake.keepMeshes} drawCalls=${c.bake.drawCalls})`
    + `  chunkMeshesInScene=${c.chunkMeshesInScene}  placements=${c.placements}`);
}

const CRITICAL = (e: string): boolean =>
  !e.includes('favicon.ico') && !e.includes('net::ERR_')
  && !e.includes('ResizeObserver') && !e.includes('rvproject:')
  && !e.includes('409 (Conflict)');

test('plan-753: synthetic 50-placement baseline — one bake instance per placement, no scene-wide rebuild', async ({ page }) => {
  test.setTimeout(300_000);

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await boot(page);
  const b = await measureBaseline(page);

  const registers = b.timings.filter((t) => t.op === 'registerPlaced' && t.mode !== 'light');
  const totals = registers.map((t) => t.totalMs);
  const firstFrames = registers.map((t) => t.firstFrameMs ?? 0).filter((x) => x > 0);
  const phaseNames = [...new Set(registers.flatMap((t) => t.phases.map((p) => p.phase)))];

  console.log('\n=== plan-753 — synthetic placement layout (bake path) ===');
  console.log(`Layout: ${b.placed}/${TOTAL_PLACEMENTS} placements, `
    + `${DISTINCT_ASSETS} distinct assets × ${REPEATS_PER_ASSET} (public library catalog)`);
  if (b.failures.length) console.log(`Failures: ${b.failures.join(' | ')}`);
  logCounts('before', b.before);
  logCounts('after', b.after);
  console.log(`registerPlaced total  : median ${median(totals).toFixed(2)} ms, `
    + `max ${Math.max(0, ...totals).toFixed(2)} ms, sum ${totals.reduce((a, c) => a + c, 0).toFixed(0)} ms`);
  for (const phase of phaseNames) {
    const xs = registers.map((t) => t.phases.find((p) => p.phase === phase)?.ms ?? 0);
    console.log(`  ${phase.padEnd(22)}: median ${median(xs).toFixed(2)} ms, sum ${xs.reduce((a, c) => a + c, 0).toFixed(0)} ms`);
  }
  console.log(`first frame after drop: median ${median(firstFrames).toFixed(2)} ms (n=${firstFrames.length})`);
  console.log(`scene draw calls per placement: ${((b.after.drawCalls - b.before.drawCalls) / Math.max(1, b.placed)).toFixed(2)}`);

  // Override-material contract: every `scene.overrideMaterial` pass renders the
  // chunk meshes too; render the layout once in toon mode — a shader-compile
  // error would show up here and nowhere else.
  await page.evaluate(async () => {
    const viewer = (window as W).__rv753.viewer;
    const previous = viewer.renderMode;
    viewer.renderMode = 'toon';
    viewer.markRenderDirty?.();
    await new Promise((res) => setTimeout(res, 600));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    viewer.renderMode = previous;
    await new Promise((res) => requestAnimationFrame(res));
  });

  expect(errors.filter(CRITICAL)).toEqual([]);
  expect(b.failures).toEqual([]);
  expect(b.placed).toBe(TOTAL_PLACEMENTS);
  expect(registers.length).toBe(TOTAL_PLACEMENTS);
  expect(b.after.drawCalls).toBeGreaterThan(0);
  // Every placement is ONE bake instance; the distinct assets are baked once each.
  expect(b.after.bake.instances - b.before.bake.instances).toBe(TOTAL_PLACEMENTS);
  expect(b.after.bake.assets - b.before.bake.assets).toBe(DISTINCT_ASSETS);
  expect(b.after.chunkMeshesInScene).toBe(b.after.bake.chunkMeshes);
  // No placement asked for a scene-wide pick rebuild (there is none to ask for).
  expect(registers.some((t) => t.requestedBvhRebuild)).toBe(false);
});

/**
 * Repeating ONE asset shares its chunk geometries: `chunks` stays at the
 * asset's chunk count while instances / chunk meshes grow linearly.
 */
test('plan-753: repeating ONE asset shares its chunks', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);

  const series = await page.evaluate(async (repeats: number) => {
    const w = window as W;
    const h = w.__rv753;
    const planner = h.planner();
    const manifest = await (await fetch('/library/project.json')).json() as {
      documents: Array<{ id: string; name: string; path?: string }>;
    };
    const doc = manifest.documents.find((d) => d.id.includes('rollconveyor-2m') && d.path)
      ?? manifest.documents.find((d) => !!d.path)!;
    const withUrl = { id: doc.id, name: doc.name, glbUrl: `/library/${doc.path}` };

    const settle = async () => {
      await h.quiesce(20_000);
      const c: Counts = await h.sample();
      return { drawCalls: c.drawCalls, chunks: c.bake.chunks, instances: c.bake.instances, chunkMeshes: c.bake.chunkMeshes };
    };

    const points: Array<{ n: number; drawCalls: number; chunks: number; instances: number; chunkMeshes: number }> = [];
    points.push({ n: 0, ...await settle() });
    for (let i = 0; i < repeats; i++) {
      await planner.placeComponent(withUrl, [i * 2500, 0, 0]);
      points.push({ n: i + 1, ...await settle() });
    }
    return { entryId: entry.id, points };
  }, 8);

  console.log(`\n=== plan-753 — repetition (${series.entryId}) ===`);
  for (const p of series.points) {
    console.log(`  n=${String(p.n).padStart(2)}  scene calls=${String(p.drawCalls).padStart(4)}`
      + `  chunks=${p.chunks}  instances=${p.instances}  chunkMeshes=${p.chunkMeshes}`);
  }
  const first = series.points[0];
  const one = series.points[1];
  const last = series.points[series.points.length - 1];
  const chunksPerInstance = one.chunkMeshes - first.chunkMeshes;
  const slopeFromTwo = (last.drawCalls - series.points[2].drawCalls) / Math.max(1, last.n - 2);
  console.log(`  chunk meshes per placement: ${chunksPerInstance}; scene draw calls per repeat (from n=2): ${slopeFromTwo.toFixed(2)}`);

  expect(series.points).toHaveLength(9);
  // The asset is baked ONCE: the shared chunk count does not grow with repeats.
  expect(last.chunks).toBe(one.chunks);
  expect(last.instances - first.instances).toBe(8);
  // Every repeat hangs the same number of chunk meshes (shared geometry).
  expect(last.chunkMeshes - first.chunkMeshes).toBe(8 * chunksPerInstance);
  // Draw calls grow by at most the asset's chunk count per repeat (plus the
  // occasional keep mesh); never by its mesh count.
  expect(slopeFromTwo).toBeLessThanOrEqual(chunksPerInstance + 2);
});

/**
 * Session == reload (Reload = Planner-Instanzen, 2026-09-17): the loader
 * defers every saved placement to the planner, which instantiates the asset's
 * shared BakedAsset under the empty root — structurally the live placement.
 * So the bake counters agree exactly and both sides pick as 'placement'.
 */
test('plan-753: session == reload (bake counters, consumer readings)', async ({ page }) => {
  test.setTimeout(420_000);

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await boot(page);

  const result = await page.evaluate(async ({ distinct, repeats }) => {
    const w = window as W;
    const h = w.__rv753;
    const { failures, ids } = await h.placeGrid(distinct, repeats);
    await h.quiesce();
    const session: Counts = await h.sample();
    const sessionPaths: string[] = h.placementPaths();
    const sessionReadings = sessionPaths.map((p: string) => h.consumerReading(p));

    const trip = await h.roundTrip(`plan753-parity-${Date.now().toString(36)}`);
    await h.quiesce();
    const reload: Counts = await h.sample();
    const reloadPaths: string[] = h.placementPaths();
    const reloadReadings = reloadPaths.map((p: string) => h.consumerReading(p));

    return {
      failures, placed: ids.length, route: trip.route, reopenError: trip.error,
      session, reload, sessionPaths, reloadPaths, sessionReadings, reloadReadings,
    };
  }, { distinct: PARITY_DISTINCT, repeats: PARITY_REPEATS });

  console.log('\n=== plan-753 — session vs reload ===');
  console.log(`Layout: ${result.placed}/${PARITY_TOTAL} placements`
    + ` (${PARITY_DISTINCT} distinct × ${PARITY_REPEATS}), round trip via ${result.route}`);
  if (result.reopenError) console.log(`Re-open error: ${result.reopenError}`);
  logCounts('session', result.session);
  logCounts('reload', result.reload);
  for (let i = 0; i < result.sessionReadings.length; i++) {
    console.log(`  [${i}] placed ${result.sessionPaths[i]}: ${JSON.stringify(result.sessionReadings[i])}`);
    console.log(`  [${i}] loaded ${result.reloadPaths[i] ?? '—'}: ${JSON.stringify(result.reloadReadings[i] ?? null)}`);
  }

  expect(result.failures).toEqual([]);
  expect(result.placed).toBe(PARITY_TOTAL);
  expect(result.reopenError).toBeNull();
  expect(result.reloadPaths.length).toBe(result.sessionPaths.length);

  const s = result.session;
  const r = result.reload;
  // The reload instantiates every placement from the same per-asset bake the
  // session used: same placements, same chunk meshes, same shared assets and
  // instances — no in-place bake of a mesh-less layout document.
  expect(r.placements).toBe(s.placements);
  expect(r.chunkMeshesInScene).toBe(s.chunkMeshesInScene);
  expect(r.bake?.assets).toBe(s.bake?.assets);
  expect(r.bake?.instances).toBe(s.bake?.instances);
  // Triangles of the framed scene pass agree (same geometry; the framing is
  // re-fitted after the reload, so frustum culling may differ by a few %.
  // Measured 196k vs 192k = 2.04% on 2026-09-17 with identical bake counters).
  expect(Math.abs(r.triangles - s.triangles) / Math.max(1, s.triangles)).toBeLessThanOrEqual(0.05);
  console.log(`  scene calls session→reload: ${s.drawCalls} → ${r.drawCalls} (informational — culling differs per framing)`);

  // Consumer parity per placement: same chunk / keep meshes, shadow casters,
  // visibility, clipping; a pick resolves to the OWN placement root on both
  // sides; both sides pick through a bake instance (placement / in-place).
  for (let i = 0; i < result.sessionReadings.length; i++) {
    const a = result.sessionReadings[i] as Record<string, unknown>;
    const b = result.reloadReadings[i] as Record<string, unknown>;
    expect(b.chunkMeshes, `chunkMeshes[${i}]`).toBe(a.chunkMeshes);
    expect(b.keepMeshes, `keepMeshes[${i}]`).toBe(a.keepMeshes);
    expect(b.castShadow, `castShadow[${i}]`).toBe(a.castShadow);
    expect(b.visible, `visible[${i}]`).toBe(a.visible);
    expect(b.clipped, `clipped[${i}]`).toBe(a.clipped);
    expect(a.pickKind).toBe('placement');
    expect(b.pickKind).toBe('placement');
    // A pick resolves to the OWN placement root on both sides. The one
    // legitimate asymmetry is an MU TEMPLATE placement (e.g. a carton box):
    // the session clone renders, but the loader hides MU templates when the
    // MU component registers them (pre-existing load semantics, not a pick
    // rule) — a hidden node is transparent to the visibility gate.
    const loadedVisible = (b.visible as number) + (b.keepVisible as number) > 0;
    if (loadedVisible) {
      expect(b.pick === null, `pick nullness[${i}]`).toBe(a.pick === null);
    } else {
      expect(b.pick, `hidden on reload (MU template) [${i}]`).toBeNull();
    }
    if (a.pick !== null) expect(a.pick).toBe(result.sessionPaths[i]);
    if (b.pick !== null) expect(b.pick).toBe(result.reloadPaths[i]);
    expect(b.aasLink).toBe(a.aasLink);
    expect(b.webMarkers).toEqual(a.webMarkers);
    expect(b.sensorViz).toBe(a.sensorViz);
  }

  expect(errors.filter(CRITICAL)).toEqual([]);
});
