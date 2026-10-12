// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * G3 measurement harness of plan-754 (unified scene graph) — the protocol is
 * FIXED in the plan (§1 Akzeptanzkriterien, G3) and must not be tuned later:
 *
 *  - fresh tab per variant AND per run (never A and B in one tab — GC timing
 *    contaminates the heap); ONE browser context per model, so whatever the
 *    app caches across tabs is warm after the first run;
 *  - tab visible (headed Chromium, anti-throttle flags);
 *  - warm asset cache: the first run of every model is DISCARDED;
 *  - N = 5 measured runs, median;
 *  - fps   = mean of `viewer.currentFps` (refreshed every 500 ms) sampled over a
 *            5 s window at a fixed camera pose; the harness marks the viewer
 *            render-dirty every animation frame during the window, because the
 *            viewer renders on demand and an idle scene would otherwise report
 *            the fps of whatever happened to invalidate it;
 *  - calls / triangles = the `scene` bucket of rv-frame-stats
 *            (`viewer.getRendererInfo().frame.scene`), never `renderer.info` totals;
 *  - load  = `model-loaded` → `viewer.whenSceneReady()`. For a model without
 *            deferred placements this is a few ms by construction, so the report
 *            ALSO carries `nav→ready` (navigation start → scene ready: fetch +
 *            parse + loader phases + bake) as a supplementary column;
 *  - heap  = `performance.memory.usedJSHeapSize` after an explicit `gc()`
 *            (Chromium launched with `--js-flags=--expose-gc`).
 *
 * The same run also reads the Phase-0 removal report (`bakeRemovalReport`,
 * rv-bake-survival.ts) of the load — that is gate G1.
 *
 *   node scripts/perf-bake-gates.mjs                         # all four gate models
 *   node scripts/perf-bake-gates.mjs --models demo --runs 1  # wiring check
 *   node scripts/perf-bake-gates.mjs --variant B --ls rv.bake.destructive=1
 *
 * Options:
 *   --models <ids>    comma list of demo,delta,mauser,planner,nested (default: all that exist)
 *   --model <url>     an ad-hoc `?model=` URL instead (id = `custom`)
 *   --runs <n>        measured runs per model (default 5; +1 discarded warm-up)
 *   --window <s>      fps window in seconds (default 5)
 *   --variant <name>  label written into the report (default `A`)
 *   --ls <k=v,...>    localStorage entries set before the app boots (the A/B switch)
 *   --uncapped        ADDITIONAL flags `--disable-gpu-vsync --disable-frame-rate-limit`.
 *                     Not the plan's protocol (fps is then not vsync-capped) — the
 *                     report marks it; use it only as a second, more sensitive reading.
 *   --base <url>      drive an existing origin instead of starting Vite
 *   --port <n>        Vite port (default 5199, first free upward)
 *   --timeout <s>     load timeout per run (default 300)
 *   --out <name>      report base name under docs/perf/
 *   --verbose         forward the page console
 *
 * Private models are skipped (and reported as skipped) when the private sibling
 * repository is missing. The planner scene is skipped until its fixture exists
 * (`projects/TestScenes/models/PlannerGate30.glb`).
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fingerprint, fingerprintMarkdown, launch, parseArgs, reportBaseName, startServer, writeReport,
} from './lib/perf-bench-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRIVATE_PROJECTS = [
  resolve(HERE, '../../realvirtual-WebViewer-Private~/projects'),
  resolve(HERE, '../../realvirtual-web-pro/projects'),
].find((c) => existsSync(c)) ?? null;

/** The four gate models of plan-754 D14. `file` is relative to the private projects dir. */
const GATE_MODELS = {
  demo: { url: '/demo-realvirtual/DemoRealvirtualWeb.glb', file: null },
  delta: { url: '/private-assets/KinematicTest/Autonox-DELTA-RL5-1900-6kg.glb', file: 'KinematicTest/Autonox-DELTA-RL5-1900-6kg.glb' },
  mauser: { url: '/private-models/mauser3dhmi/MauserCageline30.glb', file: 'mauser3dhmi/models/MauserCageline30.glb' },
  planner: { url: '/private-models/TestScenes/PlannerGate30.glb', file: 'TestScenes/models/PlannerGate30.glb' },
  // plan-757 Phase 2b: a NESTED layout — two placements of PlannerGate30, each of
  // which places its 128 conveyors (three levels, 2 + 256 placements). Every
  // reference is a placement, recursively; the model itself draws nothing.
  nested: { url: '/private-models/TestScenes/NestedGate2.glb', file: 'TestScenes/models/NestedGate2.glb' },
};

const args = parseArgs(process.argv.slice(2));
const runs = Number(args.runs ?? 5);
const windowS = Number(args.window ?? 5);
const variant = String(args.variant ?? 'A');
const timeoutMs = Number(args.timeout ?? 300) * 1000;
const lsEntries = String(args.ls ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((kv) => {
  const i = kv.indexOf('=');
  return i < 0 ? [kv, '1'] : [kv.slice(0, i), kv.slice(i + 1)];
});

const selected = [];
const skipped = [];
if (args.model) {
  selected.push({ id: 'custom', url: String(args.model) });
} else {
  const ids = String(args.models ?? Object.keys(GATE_MODELS).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    const m = GATE_MODELS[id];
    if (!m) { skipped.push({ id, reason: 'unknown model id' }); continue; }
    if (m.file && !(PRIVATE_PROJECTS && existsSync(resolve(PRIVATE_PROJECTS, m.file)))) {
      skipped.push({ id, reason: `fixture missing: ${m.file}` });
      continue;
    }
    selected.push({ id, url: m.url });
  }
}

function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Installed before any app code: timestamps `model-loaded` and `whenSceneReady`. */
function initScript(entries) {
  try {
    localStorage.setItem('rv-terms-accepted', '1');
    localStorage.setItem('rv-welcome-dismissed', 'true');
    localStorage.setItem('rv-auto-quality-applied', 'true');
    for (const [k, v] of entries) localStorage.setItem(k, v);
  } catch { /* private mode */ }
  const marks = { modelLoaded: null, sceneReady: null, hooked: false };
  window.__rvGate = marks;
  const timer = setInterval(() => {
    const v = window.__rvViewer ?? window.viewer;
    if (!v || typeof v.on !== 'function') return;
    clearInterval(timer);
    marks.hooked = true;
    const onLoaded = () => {
      if (marks.modelLoaded !== null) return;
      marks.modelLoaded = performance.now();
      Promise.resolve(v.whenSceneReady?.()).then(() => { marks.sceneReady = performance.now(); });
    };
    v.on('model-loaded', onLoaded);
    // The hook landed after the event (tiny model, slow poll): fall back to "now".
    if (v.lastLoadResult?.root) onLoaded();
  }, 2);
}

async function measureOnce(context, baseUrl, model) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('crash', () => console.error(`  [${model.id}] TAB CRASHED (renderer process died — usually out of memory)`));
  page.on('close', () => { if (args.verbose) console.error(`  [${model.id}] page closed`); });
  if (args.verbose) page.on('console', (msg) => console.log(`  [console:${msg.type()}] ${msg.text().slice(0, 300)}`));
  await page.addInitScript(initScript, lsEntries);
  try {
    await page.bringToFront();
    const url = new URL(`/?model=${encodeURIComponent(model.url)}`, baseUrl).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__rvGate?.sceneReady != null, null, { timeout: timeoutMs, polling: 100 });

    return await page.evaluate(async ({ windowS }) => {
      const v = window.__rvViewer ?? window.viewer;
      const THREE = await import(/* @vite-ignore */ '/node_modules/three/build/three.module.js');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Let load-time camera animations (model plugins) finish before posing.
      await sleep(1500);
      const root = v.lastLoadResult.root;
      root.updateMatrixWorld(true);
      // Fixed pose: deterministic function of the model bounds.
      const box = v.lastLoadResult.boundingBox?.clone?.() ?? new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      const dir = new THREE.Vector3(0.6, 0.5, 0.65).normalize();
      const pose = () => {
        v.camera.position.copy(center).addScaledVector(dir, size * 0.9);
        v.controls.target.copy(center);
        v.controls.update();
        v.camera.updateMatrixWorld(true);
      };
      pose();

      // fps window: keep the on-demand renderer busy every frame.
      let running = true;
      const pump = () => { if (!running) return; v.markRenderDirty(); requestAnimationFrame(pump); };
      requestAnimationFrame(pump);
      await sleep(1000); // settle: first currentFps refresh after posing
      pose();
      const fpsSamples = [];
      const frameMsSamples = [];
      const t0 = performance.now();
      while (performance.now() - t0 < windowS * 1000) {
        await sleep(500);
        fpsSamples.push(v.currentFps);
        frameMsSamples.push(v.currentFrameTime);
      }
      const frame = v.getRendererInfo().frame;
      const scene = { calls: frame.scene.calls, triangles: frame.scene.triangles };
      const total = { calls: frame.total.calls, triangles: frame.total.triangles };
      running = false;

      // Heap after an explicit gc (twice: weak refs / finalizers need a second pass).
      let heap = null;
      if (typeof window.gc === 'function') {
        window.gc(); await sleep(100); window.gc(); await sleep(100);
        heap = performance.memory?.usedJSHeapSize ?? null;
      }

      // Scene-graph size (what `updateMatrixWorld` / `projectObject` walk).
      // plan-757 Phase 0 adds the freeze picture: nodes still recomposing their
      // local matrix per frame (`matrixAutoUpdate`) and nodes the static freeze
      // took out of the world-matrix walk (`matrixWorldAutoUpdate === false`).
      let sceneNodes = 0; let sceneMeshes = 0; let chunkMeshes = 0;
      let matrixAutoUpdateNodes = 0; let frozenWorldNodes = 0;
      v.scene.traverse((o) => {
        sceneNodes++;
        if (o.matrixAutoUpdate) matrixAutoUpdateNodes++;
        if (!o.matrixWorldAutoUpdate) frozenWorldNodes++;
        if (o.isMesh) { sceneMeshes++; if (o.userData?._rvBakeChunk) chunkMeshes++; }
      });

      // Phase-0 removal report (G1) — the same module instance the app uses.
      let survival = null;
      try {
        const mod = await import(/* @vite-ignore */ '/src/core/engine/rv-bake-survival.ts');
        const last = mod.bakeRemovalReport[mod.bakeRemovalReport.length - 1] ?? null;
        if (last) {
          survival = {
            assetId: last.assetId, counts: last.counts, ms: last.ms,
            removalTopsTotal: last.removalTopsTotal, removalTopsSample: last.removalTops.slice(0, 10),
            unresolvedClaims: last.unresolvedClaims, g1Violations: last.g1Violations,
          };
        }
      } catch (e) { survival = { error: String(e) }; }

      const planner = v.getPlugin?.('layout-planner');
      const marks = window.__rvGate;
      return {
        loadMs: marks.sceneReady - marks.modelLoaded,
        navToSceneReadyMs: marks.sceneReady,
        fps: fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length,
        fpsSamples,
        frameMs: frameMsSamples.reduce((a, b) => a + b, 0) / frameMsSamples.length,
        scene, total, heap,
        sceneNodes, sceneMeshes, chunkMeshes, matrixAutoUpdateNodes, frozenWorldNodes,
        // plan-757 Phase 2b: the VIEWER's instancer owns every placement (nested included) — ask it first.
        bake: v.placements?.getBakeStats?.() ?? planner?.getBakeStats?.() ?? v.bakeRegistry?.stats?.() ?? null,
        placements: planner?.getPlacements?.()?.length ?? null,
        drives: v.lastLoadResult.drives?.length ?? null,
        loadTriangles: v.lastLoadResult.triangleCount ?? null,
        loadInfo: v.lastLoadInfo ?? null,
        camera: { pos: v.camera.position.toArray(), target: v.controls.target.toArray() },
        survival,
      };
    }, { windowS });
  } finally {
    await page.close();
    if (errors.length) console.error(`[${model.id}] page errors: ${errors.slice(0, 3).join(' | ')}`);
  }
}

const server = args.base ? null : await startServer({ port: Number(args.port ?? 5199) });
const baseUrl = args.base ? String(args.base) : server.baseUrl;
const extraArgs = args.uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
const browser = await launch({ headless: false, extraArgs });
const report = { variant, runs, windowS, uncapped: !!args.uncapped, localStorage: Object.fromEntries(lsEntries), skipped, models: {} };
let fp = null;

try {
  for (const model of selected) {
    console.log(`\n== ${model.id} (${model.url}) — variant ${variant}, ${runs} runs + 1 discarded`);
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const measured = [];
    let failed = null;
    for (let i = 0; i <= runs; i++) {
      try {
        const r = await measureOnce(context, baseUrl, model);
        const tag = i === 0 ? 'warm-up (discarded)' : `run ${i}`;
        console.log(`  ${tag}: load ${r.loadMs.toFixed(0)} ms, fps ${r.fps.toFixed(1)}, scene ${r.scene.calls} calls / ${r.scene.triangles} tris, heap ${r.heap === null ? 'n/a' : (r.heap / 1048576).toFixed(1) + ' MiB'}`);
        if (i > 0) measured.push(r);
        if (!fp) {
          const page = await context.newPage();
          await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
          fp = await fingerprint(page, browser).catch(() => null);
          await page.close();
        }
      } catch (e) {
        failed = String(e);
        console.error(`  run ${i} FAILED: ${failed}`);
        break;
      }
    }
    await context.close();
    const last = measured[measured.length - 1] ?? null;
    report.models[model.id] = {
      url: model.url,
      failed,
      measuredRuns: measured.length,
      median: measured.length === 0 ? null : {
        loadMs: median(measured.map((r) => r.loadMs)),
        navToSceneReadyMs: median(measured.map((r) => r.navToSceneReadyMs)),
        fps: median(measured.map((r) => r.fps)),
        frameMs: median(measured.map((r) => r.frameMs)),
        sceneCalls: median(measured.map((r) => r.scene.calls)),
        sceneTriangles: median(measured.map((r) => r.scene.triangles)),
        heapBytes: median(measured.map((r) => r.heap)),
        sceneNodes: median(measured.map((r) => r.sceneNodes)),
        chunkMeshes: median(measured.map((r) => r.chunkMeshes)),
        matrixAutoUpdateNodes: median(measured.map((r) => r.matrixAutoUpdateNodes)),
        frozenWorldNodes: median(measured.map((r) => r.frozenWorldNodes)),
      },
      placements: last?.placements ?? null,
      callsPerPlacement: last?.placements ? median(measured.map((r) => r.scene.calls)) / last.placements : null,
      // plan-757 Phase 2b: the bake picture of the last run (assets, instances — nested placements
      // are instances too), for the report's two right-hand columns.
      bake: last?.bake ?? null,
      survival: last?.survival ?? null,
      runs: measured,
    };
  }
} finally {
  await browser.close();
  if (server) await server.close();
}

const fmt = (n, d = 0) => (n === null || n === undefined ? 'n/a' : Number(n).toFixed(d));
const lines = [
  `# plan-754 G3 measurement — variant ${variant}`,
  '',
  fp ? fingerprintMarkdown(fp) : '- fingerprint unavailable',
  `- **Protocol:** fresh tab per run, headed, first run discarded, N=${runs} median, fps = mean of viewer.currentFps over ${windowS} s at a fixed pose, scene bucket of rv-frame-stats, load = model-loaded → whenSceneReady, heap after gc()${args.uncapped ? ' — **UNCAPPED (not the plan protocol)**' : ''}`,
  lsEntries.length ? `- **localStorage:** ${lsEntries.map(([k, v]) => `${k}=${v}`).join(', ')}` : '- **localStorage:** (none)',
  '',
  '| Model | runs | load ms | nav→ready ms | fps | frame ms | scene calls | scene tris | heap MiB | scene nodes | chunk meshes | matrixAutoUpdate nodes | frozen world nodes | bake assets | instances |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const [id, m] of Object.entries(report.models)) {
  const md = m.median;
  lines.push(md
    ? `| ${id} | ${m.measuredRuns} | ${fmt(md.loadMs)} | ${fmt(md.navToSceneReadyMs)} | ${fmt(md.fps, 1)} | ${fmt(md.frameMs, 1)} | ${fmt(md.sceneCalls)} | ${fmt(md.sceneTriangles)} | ${md.heapBytes === null ? 'n/a' : fmt(md.heapBytes / 1048576, 1)} | ${fmt(md.sceneNodes)} | ${fmt(md.chunkMeshes)} | ${fmt(md.matrixAutoUpdateNodes)} | ${fmt(md.frozenWorldNodes)} | ${m.bake ? fmt(m.bake.assets) : 'n/a'} | ${m.bake ? fmt(m.bake.instances ?? m.bake.placements?.instances) : 'n/a'} |`
    : `| ${id} | 0 | FAILED: ${m.failed ?? 'no measured run'} | | | | | | | | | | |`);
}
lines.push('', '## G1 — Phase-0 removal report', '',
  '| Model | nodes | survivors | removed | removed meshes | merged survivor meshes | releasable geometries | instanced tris | tag-only chunk boundaries | unresolved refs | unresolved claims | G1 violations | ms |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [id, m] of Object.entries(report.models)) {
  const s = m.survival;
  if (!s || !s.counts) { lines.push(`| ${id} | no report${s?.error ? ': ' + s.error : ''} | | | | | | | | | | | |`); continue; }
  const c = s.counts;
  lines.push(`| ${id} | ${c.nodes} | ${c.survivors} | ${c.removed} | ${c.removedMeshes} | ${c.mergedSurvivorMeshes} | ${c.releasableGeometries} | ${c.instancedTriangles} | ${c.tagOnlyChunkBoundaries} | ${c.unresolvedReferences} | ${c.unresolvedClaims} | ${s.g1Violations.length} | ${fmt(s.ms, 1)} |`);
}
for (const [id, m] of Object.entries(report.models)) {
  if (m.callsPerPlacement !== null) lines.push('', `Draw calls per placement (${id}): ${fmt(m.callsPerPlacement, 2)} (${m.placements} placements)`);
}
if (skipped.length) lines.push('', '## Skipped', '', ...skipped.map((s) => `- ${s.id}: ${s.reason}`));

const baseName = String(args.out ?? `${reportBaseName('bake-gates')}-${variant}`);
const { mdPath, jsonPath } = await writeReport(baseName, { markdown: lines.join('\n') + '\n', json: { fingerprint: fp, ...report } });
console.log('\n' + lines.join('\n'));
console.log(`\nReport: ${mdPath}\n        ${jsonPath}`);
