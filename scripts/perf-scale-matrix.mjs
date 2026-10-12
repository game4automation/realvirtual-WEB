// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Scaling-matrix runner (plan-465, Phase 4).
 *
 * Sweeps MU count x sensor density x signal load x renderer over the synthetic
 * line and grades every cell against the acceptance criteria in §1.3, so the
 * report can name the LAST SUPPORTED cell per axis instead of a vague "it got
 * slow somewhere".
 *
 *   node scripts/perf-scale-matrix.mjs --mu 500,1000,2400 --sensors 1,4 \
 *        --load none,browser --renderer webgl --duration 300 --runs 3
 *
 * Options:
 *   --mu, --sensors, --load, --renderer   comma-separated axes
 *   --shadows on,off    shadow-pass axis (default `on` = production behaviour)
 *   --effects on,off    MU spawn/vanish clip-effect axis (default `on`)
 *   --proto <list>   A/B switches passed through to the page as `?proto=`
 *                    (`refslowpick`, `refaabb`, `walk`, `bounds`; comma-separated,
 *                    empty = PRODUCTION). ONE cell per invocation — the comma
 *                    list arms them TOGETHER, it is not an axis.
 *                    plan-473: `refslowpick`/`refaabb` turn a production
 *                    optimisation OFF, i.e. `--proto refslowpick,refaabb` is the
 *                    REFERENCE side of an F2/F3 ABBA pair and no `--proto` at
 *                    all is the optimised side. `fastpath`/`union` are gone.
 *   --hooks on|off   plan-469 region-attribution hooks (default `on`). The `off`
 *                    cell prices the instrumentation itself.
 *   --refrate <n>    plan-473 F4: the source rate (MU/s) a REFERENCE run of this
 *                    configuration reached. Passed to the page as `?refrate=`
 *                    and used by the run-validity gate to grade the source
 *                    throughput (±15 %). Omitted = the gate can only require
 *                    `> 0` and says so in the report.
 *   --gcprofile      plan-469: run a CDP CPU profile over the observation window
 *                    and report the share of samples attributed to V8's
 *                    `(garbage collector)` node. This is a DEDICATED run — the
 *                    sampling profiler itself costs time, so its step figures
 *                    must NOT be quoted as a baseline. Chosen over
 *                    `--js-flags=--trace-gc`, whose output goes to the browser
 *                    PROCESS stdout, which Playwright does not surface.
 *   --geometry primitive,library     plan-469 Phase 0d: belt VISUALS. `library`
 *                    draws RollConveyor-*.glb on every segment as InstancedMesh;
 *                    the transport topology is identical either way.
 *   --muasset primitive,cartonbox,pallet   MU template: box primitive, CartonBox.glb
 *                    or EuropalletLoaded.glb. `pallet` defaults `mulen`/`mugap` to
 *                    1200/300 mm (the asset is scaled to `mulen` along the belt).
 *   --robots 0,25,50,100             six-axis robots standing beside the line
 *                    (6 rotary drives each). They never touch the material flow.
 *   --robotmotion static,erratic     robots hold their pose, or re-target every
 *                    axis the moment it arrives (deliberately incoherent).
 *   --keepmodel off,on  keep the loaded demo GLB next to the line (default
 *                       `off`: with it on, draw calls and the shadow pass are
 *                       properties of that model, not of the MU count)
 *   --lanes --plcs --segments --seglen --speed --templates   line geometry
 *   --duration <s>   observation window per run (default 300, §1.3)
 *   --runs <n>       measured runs per cell (default 3)
 *   --mode           supported (default) | smoke
 *   --headless       headless Chromium — SMOKE ONLY. SwiftShader frame times are
 *                    meaningless as a scale statement (§5.2); the runner marks
 *                    every such report accordingly.
 *   --base <url>     drive an EXISTING origin instead of starting Vite. Required
 *                    for `load=connect`, whose page must be same-origin with the
 *                    CONNECT gateway (e.g. --base http://localhost:5100).
 *   --port <n>       Vite port (default 5199, first free upward)
 *   --out <name>     report base name under docs/perf/
 *
 * The measurement runs themselves are the operator's job on a real GPU machine;
 * a `--mode smoke --duration 10 --mu 100` invocation is the wiring check.
 */

import {
  cdpHeapAfterGc, detectGpu, fingerprint, fingerprintMarkdown, gpuArgs, grade, launch, newPage,
  openCdp, parseArgs, perfUrl, reportBaseName, startServer, waitForPerfResults, writeReport,
} from './lib/perf-bench-lib.mjs';
import { evaluateCellValidity, renderCellsMarkdown, summariseCell, validateCellsConfig } from './lib/perf-cells-report.mjs';

const args = parseArgs(process.argv.slice(2));
const list = (key, fallback) => String(args[key] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
const int = (key, fallback) => (args[key] === undefined ? fallback : Number(args[key]));

/**
 * plan-492: `cells` is its OWN scenario, not one more axis on the MU loop.
 *
 * The two scenarios share nothing but the runner: the line's axes (`mu`,
 * `sensors`, `load`, `geometry`, `muasset`, `robots`) describe a material flow
 * that the cell matrix deliberately does not have, and its steady-state gate is
 * meaningless for a scene with no MUs in it. An axis that cannot apply is
 * therefore refused in plain words instead of being quietly ignored.
 */
const scenario = String(args.scenario ?? 'line') === 'cells' ? 'cells' : 'line';

const muAxis = list('mu', '500,1000,2400').map(Number);
const sensorAxis = list('sensors', '1').map(Number);
const loadAxis = list('load', 'none');
const rendererAxis = list('renderer', 'webgl');
// Environment axes (plan-465 fix 2026-09-06). `shadows` defaults to `on` — that
// is production behaviour, and the product's "shadows dirty whenever the MU
// count changes" rule is deliberately NOT changed here; the axis only makes its
// price visible. `effects`/`keepmodel` default to the plugin's own defaults.
const shadowAxis = list('shadows', 'on');
const effectsAxis = list('effects', 'on');
const keepModelAxis = list('keepmodel', 'off');
// plan-469 Phase 0d realistic-scene axes. Every default is the plan-465 cell, so
// an existing invocation of this runner measures exactly what it measured before.
const geometryAxis = list('geometry', 'primitive');
const muAssetAxis = list('muasset', 'primitive');
const robotAxis = list('robots', '0').map(Number);
const robotMotionAxis = list('robotmotion', 'static');
const STAGE_ORDER = ['drives', 'transport', 'behaviors', 'visuals'];
// plan-469: NOT axes — one setting per invocation, so an A/B pair is two runs of
// the runner against the same cell and the report says which side it is.
// Declared HERE, not next to `renderPlan469`: the report is rendered from the
// top-level `finally` below, which executes before any `const` further down the
// module body is initialised (temporal dead zone).
const REGION_ORDER = [
  'sources', 'surfaceGrid', 'pick', 'transportExcl', 'accumulation',
  'muAabbGrid', 'sensors', 'sinks', 'removal', 'poolMatrices',
  'adjacency', 'growth',
];

const proto = String(args.proto ?? '').split(',').map((x) => x.trim()).filter(Boolean).join(',');
const hooks = args.hooks === undefined ? 'on' : (String(args.hooks) === 'off' ? 'off' : 'on');
const refRate = args.refrate === undefined || !Number.isFinite(Number(args.refrate))
  ? null : Number(args.refrate);
const gcProfile = args.gcprofile === true || args.gcprofile === 'true';
const durationS = int('duration', 300);
const runs = int('runs', 3);
const mode = args.mode === 'smoke' ? 'smoke' : 'supported';
const headless = args.headless === true || args.headless === 'true';
const geom = {
  lanes: int('lanes', 24),
  plcs: int('plcs', 2),
  segments: int('segments', 9),
  seglen: int('seglen', 5),
  speed: int('speed', 1000),
  templates: int('templates', 1),
  seed: int('seed', 465),
};

// ── plan-492: the cell-matrix scenario ──────────────────────────────────

const cellsAxis = list('cells', '4').map(Number);
const cellMotionAxis = list('cellmotion', 'none');
const cellConvAxis = list('cellconv', '3').map(Number);
const allowLarge = args['allow-large'] === true || args.allowlarge === true;
const gpuMode = String(args.gpu ?? 'default') === 'swiftshader' ? 'swiftshader' : 'default';

if (scenario === 'cells') {
  const check = validateCellsConfig({ cells: cellsAxis, conv: cellConvAxis, motion: cellMotionAxis, allowLarge, raw: args });
  if (!check.ok) {
    for (const e of check.errors) console.error(e);
    process.exit(2);
  }
  await runCellsScenario();
  process.exit(0);
}

async function runCellsScenario() {
  let server = null;
  let base = args.base ? String(args.base) : null;
  if (!base) { server = await startServer({ port: int('port', 5199) }); base = server.baseUrl; }
  const browser = await launch({ headless, antiThrottle: true, extraArgs: gpuArgs(gpuMode) });

  {
    const warm = await browser.newPage();
    console.log('warming up the dev server (first-request dependency optimisation)...');
    await warm.goto(base, { waitUntil: 'domcontentloaded', timeout: 300_000 }).catch((e) => {
      console.error(`warmup navigation failed: ${e.message}`);
    });
    await warm.close();
  }

  const out = [];
  let failure = null;
  try {
    for (const renderer of rendererAxis) {
      for (const motion of cellMotionAxis) {
        for (const conv of cellConvAxis) {
          for (const n of cellsAxis) {
            const label = `cells=${n} conv=${conv} motion=${motion} renderer=${renderer}`;
            console.log(`
=== cell ${label}`);
            const cell = { cells: n, conv, motion, renderer, runs: [], label };
            for (let run = 0; run < runs; run++) {
              const { page, errors } = await newPage(browser, { verbose: false });
              const url = perfUrl(base, {
                scenario: 'cells', mode, duration: durationS, renderer,
                cells: n, cellconv: conv, cellmotion: motion,
                shadows: shadowAxis[0], effects: effectsAxis[0],
                ...(proto ? { proto } : {}),
              });
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
              const session = await openCdp(page);
              let results;
              try {
                results = await waitForPerfResults(page, (durationS + 600) * 1000);
              } catch (err) {
                results = { pass: false, reason: `timeout waiting for __PERF_RESULTS__: ${err.message}` };
              }
              const gpu = await detectGpu(page);
              const heapAfterGc = await cdpHeapAfterGc(session).catch(() => null);
              cell.runs.push({ ...results, ...gpu, heapAfterGc, pageErrors: errors.slice(0, 10) });
              console.log(`  run ${run + 1}/${runs}: ${results.pass ? 'PASS' : 'FAIL'}`
                + `${results.reason ? ` — ${results.reason}` : ''} [${gpu.gpu}]`);
              await page.close();
              // A configuration that cannot be BUILT will not build next time.
              if (results.reason && /cell matrix invalid|could not open|must be/.test(results.reason)) break;
            }
            summariseCell(cell);
            cell.validity = evaluateCellValidity(cell);
            if (!cell.validity.valid) console.log(`  INVALID: ${cell.validity.reason}`);
            out.push(cell);
          }
        }
      }
    }
  } catch (err) {
    failure = err;
    console.error(err);
  } finally {
    const page0 = await browser.newPage();
    await page0.goto(base, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const fp = await fingerprint(page0, browser, { headless, mode, durationS, runs })
      .catch(() => ({ timestamp: new Date().toISOString(), host: 'unknown' }));
    await page0.close().catch(() => {});
    await browser.close();
    await server?.close();

    // plan-492 R9: scenario AND prototype in the file name, so an A/B pair of
    // runs leaves two reports instead of silently overwriting the first.
    const baseName = String(args.out ?? `${reportBaseName('cells')}${proto ? `-${proto.replace(/[^a-z0-9]+/gi, '-')}` : ''}`);
    const options = { scenario: 'cells', mode, durationS, runs, headless, gpuMode, proto,
      axes: { cellsAxis, cellConvAxis, cellMotionAxis, rendererAxis } };
    const { mdPath, jsonPath } = await writeReport(baseName, {
      markdown: renderCellsMarkdown(fingerprintMarkdown(fp), out, options),
      json: { fingerprint: fp, options, cells: out },
    });
    console.log(`
Report: ${mdPath}
        ${jsonPath}`);
    if (failure) process.exit(1);
  }
}

if (loadAxis.includes('connect') && !args.base) {
  console.error(
    'load=connect needs --base <origin> pointing at the running CONNECT gateway '
    + '(e.g. --base http://localhost:5100). CONNECT delivers the viewer same-origin; '
    + 'a Vite page cannot reach its WebSocket.',
  );
  process.exit(2);
}

let serverHandle = null;
let baseUrl = args.base ? String(args.base) : null;
if (!baseUrl) {
  serverHandle = await startServer({ port: int('port', 5199) });
  baseUrl = serverHandle.baseUrl;
}

const browser = await launch({ headless, antiThrottle: true });

// Cold Vite start optimises dependencies on the first request, which can take
// minutes. Pay that once here rather than charging it to the first cell (whose
// navigation would otherwise time out and look like a measurement failure).
{
  const warm = await browser.newPage();
  console.log('warming up the dev server (first-request dependency optimisation)...');
  await warm.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 300_000 }).catch((e) => {
    console.error(`warmup navigation failed: ${e.message}`);
  });
  // Not just "loaded": wait until the dev-only perf hooks exist. They sit at the
  // end of the engine's on-demand transform chain, so the FIRST page pays a
  // minute or more that has nothing to do with the measurement.
  await warm.waitForFunction(() => window.__rvSyntheticLine !== undefined, undefined, { timeout: 600_000 })
    .catch((e) => console.error(`warmup: perf hooks never appeared — ${e.message}`));
  await warm.close();
}
const cells = [];
let aborted = null;

try {
  for (const renderer of rendererAxis) {
    for (const load of loadAxis) {
      for (const sensors of sensorAxis) {
       for (const shadows of shadowAxis) {
        for (const effects of effectsAxis) {
         for (const keepmodel of keepModelAxis) {
          for (const geometry of geometryAxis) {
          for (const muasset of muAssetAxis) {
          for (const robotmotion of robotMotionAxis) {
          for (const robots of robotAxis) {
          for (const mu of muAxis) {
          const label = `mu=${mu} sensors=${sensors} load=${load} renderer=${renderer}`
            + ` shadows=${shadows} effects=${effects} keepmodel=${keepmodel}`
            + ` geometry=${geometry} muasset=${muasset} robots=${robots}/${robotmotion}`;
          console.log(`\n=== cell ${label}`);
          const cell = {
            mu, sensors, load, renderer, shadows, effects, keepmodel,
            geometry, muasset, robots, robotmotion, runs: [], label,
          };

          for (let run = 0; run < runs; run++) {
            const { page, errors } = await newPage(browser, { verbose: false });
            const url = perfUrl(baseUrl, {
              scenario: 'line', mode, duration: durationS, mu, sensors, load, renderer,
              lanes: geom.lanes, plcs: geom.plcs, segments: geom.segments,
              seglen: geom.seglen, speed: geom.speed, templates: geom.templates,
              seed: geom.seed, shadows, effects, keepmodel,
              geometry, muasset, robots, robotmotion,
              ...(proto ? { proto } : {}), hooks,
              ...(refRate !== null ? { refrate: refRate } : {}),
            });
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
            const session = await openCdp(page);
            if (gcProfile) {
              // 1 ms sampling: fine enough to resolve a 5-10 ms GC pause, coarse
              // enough that a 300 s profile stays a few hundred MB of samples.
              await session.send('Profiler.enable');
              await session.send('Profiler.setSamplingInterval', { interval: 1000 });
              await session.send('Profiler.start');
            }

            // Generous: warmup (fill time + 30 s) plus the observation window plus
            // the stationarity timeout the plugin itself applies.
            const timeoutMs = (durationS * 2 + 600) * 1000;
            let results;
            try {
              results = await waitForPerfResults(page, timeoutMs);
            } catch (err) {
              results = { pass: false, reason: `timeout waiting for __PERF_RESULTS__: ${err.message}` };
            }

            let gc = null;
            if (gcProfile) {
              gc = await stopGcProfile(session).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
              console.log(`  gc profile: ${gc?.error ? gc.error : `${(gc.gcShare * 100).toFixed(2)} % of samples, ~${gc.gcMs.toFixed(0)} ms of ${gc.totalMs.toFixed(0)} ms`}`);
            }
            const heapAfterGc = await cdpHeapAfterGc(session).catch(() => null);
            cell.runs.push({ ...results, heapAfterGc, ...(gc ? { gc } : {}), pageErrors: errors.slice(0, 10) });
            console.log(`  run ${run + 1}/${runs}: ${results.pass ? 'PASS' : 'FAIL'}`
              + `${results.reason ? ` — ${results.reason}` : ''}`);
            await page.close();

            // A cell that cannot even be BUILT (invalid plan) will not become
            // valid on the next run — stop wasting 20 minutes per repetition.
            if (results.reason && /invalid configuration/.test(results.reason)) break;
          }

          summarise(cell);
          cells.push(cell);
          }
          }
          }
          }
          }
         }
        }
       }
      }
    }
  }
} catch (err) {
  aborted = err;
  console.error(err);
} finally {
  const page0 = await browser.newPage();
  await page0.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const fp = await fingerprint(page0, browser, { headless, mode, durationS, runs, geom })
    .catch(() => ({ timestamp: new Date().toISOString(), host: 'unknown' }));
  await page0.close().catch(() => {});
  await browser.close();
  await serverHandle?.close();

  const baseName = String(args.out ?? reportBaseName('matrix'));
  const { mdPath, jsonPath } = await writeReport(baseName, {
    markdown: renderMarkdown(fp, cells, { headless, mode, durationS, runs, geom }),
    json: { fingerprint: fp, options: { mode, durationS, runs, geometry: geom, headless, proto, hooks, refRate, gcProfile, axes: { geometryAxis, muAssetAxis, robotAxis, robotMotionAxis } }, cells },
  });
  console.log(`\nReport: ${mdPath}\n        ${jsonPath}`);
  if (aborted) process.exit(1);
}

/**
 * Stop the CDP CPU profile and reduce it to V8's garbage-collector share.
 *
 * The sampling profiler attributes a sample to `(garbage collector)` whenever the
 * VM was inside a collection at that instant, so the SAMPLE share is a direct,
 * unbiased estimate of the wall-clock fraction spent collecting — which is
 * exactly the number plan-469 needs to decide whether the rare long steps are GC
 * (§2.4 F6) rather than inferring it from missing attribution.
 */
async function stopGcProfile(session) {
  const { profile } = await session.send('Profiler.stop');
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  let total = 0;
  let gcHits = 0;
  const gcIds = new Set();
  for (const node of profile.nodes) {
    total += node.hitCount ?? 0;
    if (node.callFrame?.functionName === '(garbage collector)') {
      gcHits += node.hitCount ?? 0;
      gcIds.add(node.id);
    }
  }
  const gcShare = total > 0 ? gcHits / total : 0;
  return {
    gcShare,
    gcSamples: gcHits,
    totalSamples: total,
    totalMs: durationMs,
    gcMs: gcShare * durationMs,
    method: 'CDP Profiler sample share of V8 "(garbage collector)" (1 ms sampling interval)',
  };
}

/** Collapse the runs of one cell into the median-run figures and a §1.3 grade. */
function summarise(cell) {
  const ok = cell.runs.filter((r) => r.probe?.frameMs);
  if (ok.length === 0) {
    cell.summary = { supported: false, checks: [], reason: cell.runs[0]?.reason ?? 'no probe data' };
    return;
  }
  const byP95 = [...ok].sort((a, b) => a.probe.frameMs.p95 - b.probe.frameMs.p95);
  const median = byP95[Math.floor(byP95.length / 2)];
  const probe = median.probe;

  // plan-469 (SOL #8): grade and report EVERY run, not only the median one.
  // The median-by-frame-p95 run is not necessarily the median STEP run, and a
  // cell whose occupancy drifted between runs is not one measurement.
  cell.perRun = ok.map((r, i) => {
    const pr = r.probe;
    const reg = pr.regions ?? null;
    return {
      run: i + 1,
      liveMUs: pr.last?.liveMUs ?? 0,
      frameP95: pr.frameMs.p95,
      stepP50: pr.stepMs?.p50 ?? 0,
      stepP95: pr.stepMs?.p95 ?? 0,
      stepMax: pr.stepMs?.max ?? 0,
      transportP95: pr.transportMs?.p95 ?? 0,
      longSteps: reg ? reg.longSteps.length + reg.longStepsTruncated : null,
      coverageP50: reg ? reg.coverageP50 : null,
      hitRates: reg ? reg.hitRates : null,
      regions: reg ? reg.exclusive : null,
      stationary: r.stationarity?.reached ?? null,
      // plan-473 F4: the four §1.3 conditions individually, plus the metric header.
      validity: r.validity ?? null,
      aoMode: r.env?.aoMode ?? null,
      drawMetric: pr.drawMetric ?? null,
      lostSimSeconds: pr.lostSimSeconds ?? 0,
      runtimeSeconds: (pr.durationMs ?? 0) / 1000,
      env: r.env ?? null,
      // plan-469 Phase 0d
      stages: pr.stages ?? null,
      renderPasses: pr.renderPasses ?? null,
      worldMatrix: pr.worldMatrix ?? null,
      frameP50: pr.frameMs.p50,
      frameP99: pr.frameMs.p99,
    };
  });
  const live = cell.perRun.map((r) => r.liveMUs).filter((n) => n > 0);
  const spread = live.length > 0 ? (Math.max(...live) - Math.min(...live)) / Math.max(...live) : 0;
  cell.occupancySpread = spread;
  cell.occupancyComparable = spread <= 0.05;
  const runtimeSeconds = (probe.durationMs ?? 0) / 1000;
  cell.median = {
    frameP50: probe.frameMs.p50,
    frameP95: probe.frameMs.p95,
    frameP99: probe.frameMs.p99,
    frameMax: probe.frameMs.max,
    stepP95: probe.stepMs?.p95 ?? 0,
    transportP95: probe.transportMs?.p95 ?? 0,
    // plan-473 F4: the DEFINED draw-call figure — median over the measurement
    // window of the draws issued across ALL passes of a frame. The old
    // `probe.last.drawCalls` was an end-state snapshot of whichever pass
    // three.js happened to reset last, and is kept only as a fallback for
    // reports produced before the metric existed.
    drawCalls: probe.drawMetric ? Math.round(probe.drawMetric.calls.p50) : (probe.last?.drawCalls ?? 0),
    drawMetric: probe.drawMetric ?? null,
    triangles: probe.drawMetric
      ? Math.round(probe.drawMetric.triangles.p50 * 1000)
      : (probe.last?.triangles ?? 0),
    liveMUs: probe.last?.liveMUs ?? 0,
    pools: probe.last?.pools ?? 0,
    poolCapacity: probe.last?.poolCapacity ?? 0,
    signals: probe.last?.signals ?? 0,
    lostSimSeconds: probe.lostSimSeconds ?? 0,
    runtimeSeconds,
    longTasks: probe.longTasks ?? 0,
    heapAfterGc: median.heapAfterGc,
    jitterP95: probe.jitterMs?.p95 ?? null,
    flushP95: probe.flushMs?.p95 ?? null,
    coalescedGaps: probe.latency?.coalescedGaps ?? 0,
    // Reported SEPARATELY from the observation window: since the probe is reset
    // after warmup, `runtimeSeconds` is the window alone and the fill phase is
    // no longer hidden inside the percentiles.
    fillPhaseS: median.fillPhaseS ?? 0,
    env: median.env ?? null,
    aoMode: median.env?.aoMode ?? null,
    validity: median.validity ?? null,
    regions: probe.regions ?? null,
    // plan-469 Phase 0d
    stages: probe.stages ?? null,
    renderPasses: probe.renderPasses ?? null,
    worldMatrix: probe.worldMatrix ?? null,
    scene: median.plan?.scene ?? null,
  };
  if (mode === 'smoke') {
    // A smoke run is a wiring check, usually headless. Grading it against the
    // §1.3 frame criteria would print "not supported" about SwiftShader, which
    // is a statement about the rasteriser and not about the configuration.
    cell.summary = {
      supported: median.pass === true,
      graded: false,
      checks: [{ name: 'smoke: line built and ran', ok: median.pass === true, value: median.stationarity?.reason ?? '' }],
      reason: median.reason,
    };
    return;
  }
  cell.summary = grade({
    frameP95: cell.median.frameP95,
    frameP99: cell.median.frameP99,
    lostSimSeconds: cell.median.lostSimSeconds,
    runtimeSeconds,
    stationary: median.stationarity?.reached,
  });
  cell.summary.graded = true;
  cell.summary.reason = median.reason;
}

/** Human verdict for one cell — a smoke cell is explicitly NOT graded. */
function cellVerdict(c) {
  if (!c.summary) return '**no** (no data)';
  if (c.summary.graded === false) {
    return c.summary.supported ? 'ran (smoke — not graded)' : `**failed to run** (${c.summary.checks[0]?.value ?? c.summary.reason})`;
  }
  if (c.summary.supported) return '**yes**';
  const broken = c.summary.checks.filter((x) => !x.ok).map((x) => x.name).join('; ');
  return `**no** (${broken || c.summary.reason})`;
}

/**
 * plan-473 F4 — the run-validity gate, per run and per condition.
 *
 * This REPLACES the old `stationary` column, which graded the source against
 * the rate the configuration asks for while the line physically tops out near
 * half of it, and therefore read FAIL in every cell. A run that fails any of
 * the four conditions did not measure what it claims to and its percentiles
 * must not be quoted.
 */
function renderValidity(allCells) {
  const out = ['## Run validity (plan-473 §1.3)', ''];
  const rows = [];
  for (const c of allCells) {
    for (const r of c.perRun ?? []) {
      if (!r.validity) continue;
      rows.push({ cell: c.label ?? String(c.mu), run: r.run, v: r.validity });
    }
  }
  if (rows.length === 0) {
    out.push('_No validity data — smoke mode, or a report predating plan-473 F4._');
    return out.join('\n');
  }
  out.push('| cell | run | occupancy | source | sink | sim-time loss | valid |');
  out.push('|---|---:|---|---|---|---|---|');
  const cellOf = (v, name) => {
    const c = v.checks.find((x) => x.name === name);
    return c ? `${c.ok ? 'ok' : '**FAIL**'} — ${c.detail}` : '—';
  };
  for (const row of rows) {
    out.push(`| ${row.cell} | ${row.run} | ${cellOf(row.v, 'occupancy')} | ${cellOf(row.v, 'sourceThroughput')} `
      + `| ${cellOf(row.v, 'sinkThroughput')} | ${cellOf(row.v, 'simTimeLoss')} `
      + `| ${row.v.valid ? '**yes**' : 'no'} |`);
  }
  if (rows.some((r) => r.v.referenceMissing)) {
    out.push('');
    out.push('> No reference source rate was supplied (`--refrate`), so the source condition');
    out.push('> could only be graded as `> 0`. Establish it from a reference run and pass it in.');
  }
  return out.join('\n');
}

/** plan-469 Phase 0b: per-run criteria, live MUs per run, region attribution,
 *  hit rates and the long-step list — the numbers the spike exists to produce. */
function renderPlan469(allCells) {
  const out = [];
  out.push('## plan-469 — per-run figures');
  out.push('');
  out.push('Every run is listed and graded on its own (the median-by-frame-p95 run above is');
  out.push('not necessarily the median STEP run, SOL #8). `live MUs` is the actual belt');
  out.push('occupancy of that run — A/B comparisons are only valid within ±5 %.');
  out.push('');
  out.push('| cell | proto | hooks | run | live MUs | step p50/p95/max (ms) | transport p95 | frame p95 | long steps | coverage | stationary |');
  out.push('|---|---|---|---:|---:|---|---:|---:|---:|---:|---|');
  for (const c of allCells) {
    for (const r of c.perRun ?? []) {
      out.push(`| ${c.mu} | ${r.env?.proto ?? '?'} | ${r.env?.hooks ?? '?'} | ${r.run} | ${r.liveMUs} `
        + `| ${r.stepP50.toFixed(2)} / ${r.stepP95.toFixed(2)} / ${r.stepMax.toFixed(1)} `
        + `| ${r.transportP95.toFixed(2)} | ${r.frameP95.toFixed(1)} `
        + `| ${r.longSteps ?? '—'} | ${r.coverageP50 === null ? '—' : (r.coverageP50 * 100).toFixed(1) + ' %'} `
        + `| ${r.stationary === null ? '—' : (r.stationary ? 'yes' : 'no')} |`);
    }
    if (c.occupancySpread !== undefined) {
      out.push(`| ${c.mu} | | | **spread** | ${(c.occupancySpread * 100).toFixed(1)} % `
        + `| ${c.occupancyComparable ? 'comparable (≤ 5 %)' : '**NOT comparable (> 5 %)**'} | | | | | |`);
    }
  }

  out.push('');
  out.push('## plan-469 — transport-step attribution (exclusive ms per tick)');
  out.push('');
  out.push('Regions are EXCLUSIVE: a nested region (`accumulation` inside the per-MU');
  out.push('transport body, `adjacency` inside it) is subtracted from its parent. Per-MU');
  out.push('regions are the per-tick SUM over all MUs. `sum` is the sum of the exclusive');
  out.push('regions, `total` the instrumented transport step; the rest is unattributed.');
  out.push('');
  out.push('`performance.now()` is clamped to 100 us in this (not cross-origin-isolated)');
  out.push('context, so a single per-MU region visit reads as 0 or 0.1 ms. The boundaries');
  out.push('CHAIN, so the per-tick SUM telescopes and is exact to one clock tick; the split');
  out.push('between regions is an unbiased stratified sample that converges over the run.');
  out.push('Region histograms use 0.05 ms bins (half the clock tick) and every percentile is');
  out.push('clamped to the value actually observed, so a region that never ran reports 0.');
  out.push('');
  const withRegions = allCells.filter((c) => c.median?.regions);
  if (withRegions.length === 0) {
    out.push('_No region data — the run was made with `--hooks off`._');
    return out.join('\n');
  }
  out.push('| cell | ' + REGION_ORDER.map((r) => `${r} p50/p95`).join(' | ') + ' | sum p95 | total p95 | coverage p50 |');
  out.push('|---|' + REGION_ORDER.map(() => '---').join('|') + '|---:|---:|---:|');
  for (const c of withRegions) {
    const reg = c.median.regions;
    const cells2 = REGION_ORDER.map((name) => {
      const e = reg.exclusive[name];
      return e ? `${e.p50.toFixed(2)}/${e.p95.toFixed(2)}` : '—';
    });
    out.push(`| ${c.mu} | ${cells2.join(' | ')} | ${reg.sumExclusive.p95.toFixed(2)} `
      + `| ${reg.total.p95.toFixed(2)} | ${(reg.coverageP50 * 100).toFixed(1)} % |`);
  }

  out.push('');
  out.push('### Share of the step (p95 exclusive / p95 total)');
  out.push('');
  out.push('| cell | ' + REGION_ORDER.join(' | ') + ' |');
  out.push('|---|' + REGION_ORDER.map(() => '---:').join('|') + '|');
  for (const c of withRegions) {
    const reg = c.median.regions;
    const tot = reg.total.p95 || 1;
    out.push(`| ${c.mu} | ` + REGION_ORDER.map((name) => {
      const e = reg.exclusive[name];
      return e ? `${((e.p95 / tot) * 100).toFixed(1)} %` : '—';
    }).join(' | ') + ' |');
  }

  out.push('');
  out.push('## plan-469 - simulation stages (exclusive ms per fixed step)');
  out.push('');
  out.push('The four stages of `ContinuousRunner.tick()`. `transport` here and `total` in the');
  out.push('attribution table above are the SAME span measured by two instruments - they must');
  out.push('agree to within one clock tick, which is what makes the two tables comparable.');
  out.push('');
  const withStages = allCells.filter((c) => c.median?.stages);
  if (withStages.length === 0) {
    out.push('_No stage data (run made with `--hooks off`, or a build without the stage seam)._');
  } else {
    out.push('| cell | robots | ' + STAGE_ORDER.map((x) => `${x} p50/p95`).join(' | ') + ' | ticks |');
    out.push('|---|---:|' + STAGE_ORDER.map(() => '---').join('|') + '|---:|');
    for (const c of withStages) {
      const st = c.median.stages.perTick;
      out.push(`| ${c.mu} | ${c.robots ?? 0} | ` + STAGE_ORDER.map((n) => {
        const e = st[n];
        return e ? `${e.p50.toFixed(2)}/${e.p95.toFixed(2)}` : '-';
      }).join(' | ') + ` | ${c.median.stages.ticks} |`);
    }
  }

  out.push('');
  out.push('## plan-469 - render passes (main vs shadow)');
  out.push('');
  out.push('`total` is the whole render callback; `shadow` is measured across');
  out.push('`WebGLShadowMap.render` alone (a dev-only wrapper on the live renderer, not a');
  out.push('patch of three.js); `main` is the difference. Draws and triangles are split the');
  out.push('same way, via `renderer.info` deltas with `autoReset` off. Triangles are reported');
  out.push('in THOUSANDS. A `shadow pass seen` of `no` means the renderer never entered the');
  out.push('shadow pass, so the split is trivially all-main.');
  out.push('');
  const withPasses = allCells.filter((c) => c.median?.renderPasses);
  if (withPasses.length === 0) {
    out.push('_No render-pass data (run made with `--hooks off`, or no renderer handed to the probe)._');
  } else {
    out.push('| cell | shadows | main ms p50/p95 | shadow ms p50/p95 | total ms p95 | main draws p50 | shadow draws p50 | main kTris p50 | shadow kTris p50 | shadow pass seen |');
    out.push('|---|---|---|---|---:|---:|---:|---:|---:|---|');
    for (const c of withPasses) {
      const r = c.median.renderPasses;
      out.push(`| ${c.mu} | ${c.shadows} | ${r.mainMs.p50.toFixed(2)}/${r.mainMs.p95.toFixed(2)} `
        + `| ${r.shadowMs.p50.toFixed(2)}/${r.shadowMs.p95.toFixed(2)} | ${r.totalMs.p95.toFixed(2)} `
        + `| ${r.mainDraws.p50.toFixed(0)} | ${r.shadowDraws.p50.toFixed(0)} `
        + `| ${r.mainTriangles.p50.toFixed(0)} | ${r.shadowTriangles.p50.toFixed(0)} `
        + `| ${r.shadowPassObserved ? 'yes' : 'no'} |`);
    }
  }

  out.push('');
  out.push('## plan-469 - world-matrix work');
  out.push('');
  out.push('Counted by dev-only wrappers on `Object3D.prototype.updateWorldMatrix` /');
  out.push('`updateMatrixWorld` (installed on the live prototype for the run, never a patch');
  out.push('in `node_modules`). `recomposed` is the subset that actually recomputed a world');
  out.push('matrix - the call count alone hides a fan-out that walks a thousand clean nodes.');
  out.push('');
  const withWm = allCells.filter((c) => c.median?.worldMatrix);
  if (withWm.length === 0) {
    out.push('_No world-matrix data (run made with `--hooks off`)._');
  } else {
    out.push('| cell | robots | uWM/tick | uMW/tick | recomposed/tick | uMW/frame | recomposed/frame | ticks | frames |');
    out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const c of withWm) {
      const w = c.median.worldMatrix;
      out.push(`| ${c.mu} | ${c.robots ?? 0} | ${w.perTick.updateWorldMatrix.toFixed(0)} `
        + `| ${w.perTick.updateMatrixWorld.toFixed(0)} | ${w.perTick.recomposed.toFixed(0)} `
        + `| ${w.perFrame.updateMatrixWorld.toFixed(0)} | ${w.perFrame.recomposed.toFixed(0)} `
        + `| ${w.ticks} | ${w.frames} |`);
    }
  }

  out.push('');
  out.push('## plan-469 - realistic-scene composition');
  out.push('');
  out.push('What the scene generator actually built. `MU instanced` is read BACK off');
  out.push('`RVSource.useInstancing` after `init()` - whether a library asset instances is a');
  out.push('property of the asset, never an assumption.');
  out.push('');
  const withScene = allCells.filter((c) => c.median?.scene);
  if (withScene.length === 0) {
    out.push('_No scene composition recorded (older plugin, or a plan that failed to build)._');
  } else {
    out.push('| cell | geometry | conveyor draws | conveyor tris | clones avoided | MU asset | MU meshes | MU tris | MU instanced | robots | robot drives | robot meshes | motion |');
    out.push('|---|---|---:|---:|---:|---|---:|---:|---|---:|---:|---:|---|');
    for (const c of withScene) {
      const g = c.median.scene;
      out.push(`| ${c.mu} | ${g.geometry} | ${g.conveyorDraws} | ${g.conveyorTriangles} `
        + `| ${g.conveyorClonesAvoided} | ${g.muAsset} | ${g.muMeshCount} | ${g.muTriangles} `
        + `| ${g.muInstanced ? '**yes**' : '**no (clone path)**'} | ${g.robots} | ${g.robotDrives} `
        + `| ${g.robotMeshes} | ${g.robotMotion} |`);
    }
  }

  out.push('');
  out.push('## plan-469 - hit rates (F1b)');
  out.push('');
  out.push('| cell | pick fast-path (i)-(vi) | accum span stable | clone share of MU-AABB | samples (pick / accum / aabb) |');
  out.push('|---|---:|---:|---:|---|');
  for (const c of withRegions) {
    const h = c.median.regions.hitRates;
    out.push(`| ${c.mu} | ${(h.pickFastPath * 100).toFixed(1)} % | ${(h.accumSpanStable * 100).toFixed(1)} % `
      + `| ${(h.cloneShare * 100).toFixed(1)} % | ${h.pickSamples} / ${h.accumSamples} / ${h.aabbSamples} |`);
  }

  const gcRuns = [];
  for (const c of allCells) for (const r of c.runs ?? []) if (r.gc) gcRuns.push({ mu: c.mu, gc: r.gc });
  if (gcRuns.length > 0) {
    out.push('');
    out.push('## plan-469 — GC share (measured separately, never inferred)');
    out.push('');
    out.push(`Method: ${gcRuns[0].gc.method ?? 'n/a'}. The sampling profiler itself costs time,`);
    out.push('so the step figures of a `--gcprofile` run are NOT a baseline.');
    out.push('');
    out.push('| cell | GC share of samples | GC ms | window ms | samples (gc / total) |');
    out.push('|---|---:|---:|---:|---|');
    for (const g of gcRuns) {
      if (g.gc.error) { out.push(`| ${g.mu} | — | — | — | failed: ${g.gc.error} |`); continue; }
      out.push(`| ${g.mu} | ${(g.gc.gcShare * 100).toFixed(2)} % | ${g.gc.gcMs.toFixed(0)} | ${g.gc.totalMs.toFixed(0)} `
        + `| ${g.gc.gcSamples} / ${g.gc.totalSamples} |`);
    }
  }

  out.push('');
  out.push('## plan-469 — long steps (> 100 ms)');
  out.push('');
  let anyLong = false;
  for (const c of withRegions) {
    const reg = c.median.regions;
    if (reg.longSteps.length === 0 && reg.longStepsTruncated === 0) continue;
    anyLong = true;
    out.push(`### cell ${c.mu} MUs — ${reg.longSteps.length + reg.longStepsTruncated} long step(s)`
      + (reg.longStepsTruncated ? ` (${reg.longStepsTruncated} not recorded, cap reached)` : ''));
    out.push('');
    out.push('| tick | total (ms) | sum excl. | top regions (excl. ms) | grew | adjacency | grid rebuild |');
    out.push('|---:|---:|---:|---|---|---|---|');
    for (const l of reg.longSteps.slice(0, 40)) {
      const top = Object.entries(l.exclusiveByRegion)
        .filter(([, v]) => v > 0.05)
        .sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') || '— (nothing attributed)';
      out.push(`| ${l.tick} | ${l.totalMs.toFixed(1)} | ${l.sumExclusiveMs.toFixed(1)} | ${top} `
        + `| ${l.poolGrew ? '**yes**' : 'no'} | ${l.adjacencyRebuilt ? '**yes**' : 'no'} | ${l.surfaceGridRebuilt ? '**yes**' : 'no'} |`);
    }
    out.push('');
  }
  if (!anyLong) out.push('_No transport step exceeded 100 ms in the median run of any cell._');
  return out.join('\n');
}

function renderMarkdown(fp, allCells, opts) {
  const lines = [];
  lines.push('# realvirtual WEB — scaling matrix (plan-465)');
  lines.push('');
  if (opts.headless) {
    lines.push('> **Headless run — not a scale statement.** Chromium falls back to SwiftShader,');
    lines.push('> so the frame times below say only that the configuration RUNS (§5.2).');
    lines.push('');
  }
  lines.push('## Machine fingerprint');
  lines.push('');
  lines.push(fingerprintMarkdown(fp));
  lines.push('');
  lines.push(`## Parameters\n\n- Mode: \`${opts.mode}\`, ${opts.runs} run(s) x ${opts.durationS} s observation`);
  lines.push(`- Line geometry: ${JSON.stringify(opts.geom)}`);
  lines.push(`- plan-469: \`--proto ${proto || '(none — reference path)'}\`, \`--hooks ${hooks}\``
    + (gcProfile ? ', **CDP CPU profile running** (GC cell — step figures not a baseline)' : ''));
  // plan-473 F4: AO, shadows and the draw metric belong in the HEADER. AO is a
  // default-ON screen-space pass that was never protocolled, so two reports
  // could differ by a whole post pass without saying so; and a draw-call number
  // is meaningless without its pass scope and aggregation.
  const aoModes = [...new Set(allCells.map((c) => c.median?.aoMode).filter(Boolean))];
  const shadowModes = [...new Set(allCells.map((c) => c.shadows).filter(Boolean))];
  const drawMetric = allCells.map((c) => c.median?.drawMetric).find(Boolean) ?? null;
  lines.push(`- plan-473 F4: ambient occlusion \`${aoModes.join(',') || 'unknown'}\`, shadows \`${shadowModes.join(',') || 'unknown'}\``
    + (refRate !== null ? `, reference source rate \`${refRate}\` MU/s` : ', no reference source rate supplied'));
  lines.push(drawMetric
    ? `- Draw metric: **${drawMetric.scope}** aggregated as **${drawMetric.aggregation}** `
      + `(hooks-independent; the \`draws\` column is \`calls.p50\` over the window)`
    : '- Draw metric: _not recorded_ (no renderer handed to the probe, or a report predating plan-473 F4)');
  lines.push('- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)');
  lines.push('- Welcome modal: suppressed (`rv-welcome-dismissed`)');
  lines.push('- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,');
  lines.push('  so `window (s)` and every percentile cover the observation window only.');
  lines.push('');
  lines.push('## Cells');
  lines.push('');
  lines.push('| MUs | sensors/seg | load | renderer | shadows | effects | model | geometry | MU asset | robots | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |');
  lines.push('|---:|---:|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|');
  for (const c of allCells) {
    const m = c.median;
    if (!m) {
      lines.push(`| ${c.mu} | ${c.sensors} | ${c.load} | ${c.renderer} | ${c.shadows} | ${c.effects} | ${c.keepmodel} `
        + `| ${c.geometry} | ${c.muasset} | ${c.robots}/${c.robotmotion} `
        + `| — | — | — | — | — | — | — | — | — | **no** (${c.summary?.reason ?? 'no data'}) |`);
      continue;
    }
    lines.push(
      `| ${c.mu} | ${c.sensors} | ${c.load} | ${c.renderer} | ${c.shadows} | ${c.effects} | ${c.keepmodel} `
      + `| ${c.geometry} | ${c.muasset} | ${c.robots}/${c.robotmotion} `
      + `| ${m.frameP50.toFixed(1)} / ${m.frameP95.toFixed(1)} / ${m.frameP99.toFixed(1)} `
      + `| ${m.stepP95.toFixed(2)} | ${m.transportP95.toFixed(2)} | ${m.drawCalls} | ${m.liveMUs} `
      + `| ${m.pools} (${m.poolCapacity}) | ${m.fillPhaseS.toFixed(0)} | ${m.runtimeSeconds.toFixed(0)} `
      + `| ${m.lostSimSeconds.toFixed(3)} `
      + `| ${cellVerdict(c)} |`,
    );
  }
  lines.push('');
  // plan-473 F4 — the four §1.3 run-validity conditions, per run and individually.
  try {
    lines.push(renderValidity(allCells));
  } catch (err) {
    console.error('renderValidity failed:', err);
  }
  lines.push('');
  // A rendering bug must never destroy a 3-hour measurement: the raw numbers are
  // in the JSON either way, so a failure here becomes a note in the Markdown.
  try {
    lines.push(renderPlan469(allCells));
  } catch (err) {
    console.error('renderPlan469 failed:', err);
    lines.push('## plan-469 sections could not be rendered');
    lines.push('');
    lines.push('```');
    lines.push(String(err && err.stack ? err.stack : err));
    lines.push('```');
    lines.push('');
    lines.push('The raw per-run data (regions, hit rates, long steps) is in the JSON next to this file.');
  }
  lines.push('');
  if (opts.mode === 'smoke') {
    lines.push('## Verdict');
    lines.push('');
    lines.push('This was a **smoke** run: it proves the harness chain works end to end');
    lines.push('(runner → Vite → `?perf&scenario=line` → `__PERF_RESULTS__` → this report).');
    lines.push('It makes no scale statement — run `--mode supported` on a real GPU for that.');
  } else {
    lines.push('## Last supported cell per load column');
    lines.push('');
    for (const load of [...new Set(allCells.map((c) => c.load))]) {
      const supported = allCells.filter((c) => c.load === load && c.summary?.supported);
      const best = supported.sort((a, b) => a.mu - b.mu).pop();
      lines.push(`- \`load=${load}\`: ${best ? `${best.mu} MUs (${best.sensors} sensors/segment, ${best.renderer})` : 'none of the measured cells met §1.3'}`);
    }
    lines.push('');
    lines.push('Criteria: frame p95 <= 33.3 ms, p99 <= 66 ms, lost sim time <= 0.1 %, stationarity reached (see `docs/perf/README.md`).');
  }
  lines.push('');
  return lines.join('\n');
}
