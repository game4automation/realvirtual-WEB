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
  cdpHeapAfterGc, fingerprint, fingerprintMarkdown, grade, launch, newPage, openCdp,
  parseArgs, perfUrl, reportBaseName, startServer, waitForPerfResults, writeReport,
} from './lib/perf-bench-lib.mjs';

const args = parseArgs(process.argv.slice(2));
const list = (key, fallback) => String(args[key] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
const int = (key, fallback) => (args[key] === undefined ? fallback : Number(args[key]));

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
const durationS = int('duration', 300);
const runs = int('runs', 3);
const mode = args.mode === 'smoke' ? 'smoke' : 'supported';
const headless = args.headless === true || args.headless === 'true';
const geometry = {
  lanes: int('lanes', 24),
  plcs: int('plcs', 2),
  segments: int('segments', 9),
  seglen: int('seglen', 5),
  speed: int('speed', 1000),
  templates: int('templates', 1),
  seed: int('seed', 465),
};

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
          for (const mu of muAxis) {
          const label = `mu=${mu} sensors=${sensors} load=${load} renderer=${renderer}`
            + ` shadows=${shadows} effects=${effects} keepmodel=${keepmodel}`;
          console.log(`\n=== cell ${label}`);
          const cell = { mu, sensors, load, renderer, shadows, effects, keepmodel, runs: [], label };

          for (let run = 0; run < runs; run++) {
            const { page, errors } = await newPage(browser, { verbose: false });
            const url = perfUrl(baseUrl, {
              scenario: 'line', mode, duration: durationS, mu, sensors, load, renderer,
              lanes: geometry.lanes, plcs: geometry.plcs, segments: geometry.segments,
              seglen: geometry.seglen, speed: geometry.speed, templates: geometry.templates,
              seed: geometry.seed, shadows, effects, keepmodel,
            });
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
            const session = await openCdp(page);

            // Generous: warmup (fill time + 30 s) plus the observation window plus
            // the stationarity timeout the plugin itself applies.
            const timeoutMs = (durationS * 2 + 600) * 1000;
            let results;
            try {
              results = await waitForPerfResults(page, timeoutMs);
            } catch (err) {
              results = { pass: false, reason: `timeout waiting for __PERF_RESULTS__: ${err.message}` };
            }

            const heapAfterGc = await cdpHeapAfterGc(session).catch(() => null);
            cell.runs.push({ ...results, heapAfterGc, pageErrors: errors.slice(0, 10) });
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
} catch (err) {
  aborted = err;
  console.error(err);
} finally {
  const page0 = await browser.newPage();
  await page0.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const fp = await fingerprint(page0, browser, { headless, mode, durationS, runs, geometry })
    .catch(() => ({ timestamp: new Date().toISOString(), host: 'unknown' }));
  await page0.close().catch(() => {});
  await browser.close();
  await serverHandle?.close();

  const baseName = String(args.out ?? reportBaseName('matrix'));
  const { mdPath, jsonPath } = await writeReport(baseName, {
    markdown: renderMarkdown(fp, cells, { headless, mode, durationS, runs, geometry }),
    json: { fingerprint: fp, options: { mode, durationS, runs, geometry, headless }, cells },
  });
  console.log(`\nReport: ${mdPath}\n        ${jsonPath}`);
  if (aborted) process.exit(1);
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
  const runtimeSeconds = (probe.durationMs ?? 0) / 1000;
  cell.median = {
    frameP50: probe.frameMs.p50,
    frameP95: probe.frameMs.p95,
    frameP99: probe.frameMs.p99,
    frameMax: probe.frameMs.max,
    stepP95: probe.stepMs?.p95 ?? 0,
    transportP95: probe.transportMs?.p95 ?? 0,
    drawCalls: probe.last?.drawCalls ?? 0,
    triangles: probe.last?.triangles ?? 0,
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
  lines.push(`- Line geometry: ${JSON.stringify(opts.geometry)}`);
  lines.push('- Debug plugins: **off** (`DebugEndpointPlugin` and the MCP bridge are not installed under `?perf`)');
  lines.push('- Welcome modal: suppressed (`rv-welcome-dismissed`)');
  lines.push('- `fill (s)` is the warmup the line needed to fill; the probe is reset AFTER it,');
  lines.push('  so `window (s)` and every percentile cover the observation window only.');
  lines.push('');
  lines.push('## Cells');
  lines.push('');
  lines.push('| MUs | sensors/seg | load | renderer | shadows | effects | model | frame p50/p95/p99 (ms) | step p95 | transport p95 | draws | live MUs | pools (cap) | fill (s) | window (s) | lost sim (s) | supported |');
  lines.push('|---:|---:|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|');
  for (const c of allCells) {
    const m = c.median;
    if (!m) {
      lines.push(`| ${c.mu} | ${c.sensors} | ${c.load} | ${c.renderer} | ${c.shadows} | ${c.effects} | ${c.keepmodel} `
        + `| — | — | — | — | — | — | — | — | — | **no** (${c.summary?.reason ?? 'no data'}) |`);
      continue;
    }
    lines.push(
      `| ${c.mu} | ${c.sensors} | ${c.load} | ${c.renderer} | ${c.shadows} | ${c.effects} | ${c.keepmodel} `
      + `| ${m.frameP50.toFixed(1)} / ${m.frameP95.toFixed(1)} / ${m.frameP99.toFixed(1)} `
      + `| ${m.stepP95.toFixed(2)} | ${m.transportP95.toFixed(2)} | ${m.drawCalls} | ${m.liveMUs} `
      + `| ${m.pools} (${m.poolCapacity}) | ${m.fillPhaseS.toFixed(0)} | ${m.runtimeSeconds.toFixed(0)} `
      + `| ${m.lostSimSeconds.toFixed(3)} `
      + `| ${cellVerdict(c)} |`,
    );
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
