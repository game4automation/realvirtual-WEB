// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Long-run soak runner (plan-465, Phase 5).
 *
 * Holds ONE synthetic-line page open for hours, samples the probe continuously
 * and the heap every few minutes, and grades the result against §1.3. This is
 * the only tool in the repo that can answer "what happens to a scene left
 * running overnight" — every existing perf tool measures seconds.
 *
 *   node scripts/perf-soak.mjs --hours 8 --mu 2400 --load connect --gc-interval 5
 *   node scripts/perf-soak.mjs --hours 8 --mu 2400 --load connect --gc-interval 0   # control run
 *
 * `--gc-interval 0` is not an optimisation, it is a REQUIRED second run: forcing
 * a collection is what makes the heap slope meaningful, and it is also what
 * perturbs the timing distribution. Only the pair of runs — one with GC sampling,
 * one without — supports both halves of the claim (SOL #9).
 *
 * Output: a JSONL sample log plus the usual Markdown/JSON report under docs/perf/.
 * Ctrl-C stops cleanly and still writes the report for the time already covered.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cdpHeapAfterGc, fingerprint, fingerprintMarkdown, grade, heapSlopeMiBPerHour, launch,
  newPage, openCdp, parseArgs, perfUrl, reportBaseName, reportDir, startServer, writeReport,
} from './lib/perf-bench-lib.mjs';

const args = parseArgs(process.argv.slice(2));
const int = (key, fallback) => (args[key] === undefined ? fallback : Number(args[key]));

const hours = Number(args.hours ?? 8);
const gcIntervalMin = int('gc-interval', 5);
const load = ['none', 'browser', 'connect'].includes(args.load) ? args.load : 'none';
const sampleIntervalMs = int('sample-interval', 30) * 1000;
const headless = args.headless === true || args.headless === 'true';
const cfg = {
  mu: int('mu', 2400),
  sensors: int('sensors', 4),
  lanes: int('lanes', 24),
  plcs: int('plcs', 2),
  segments: int('segments', 9),
  seglen: int('seglen', 5),
  speed: int('speed', 1000),
  templates: int('templates', 1),
  seed: int('seed', 465),
};

if (load === 'connect' && !args.base) {
  console.error('load=connect needs --base <origin> (the running CONNECT gateway, e.g. http://localhost:5100)');
  process.exit(2);
}

let serverHandle = null;
let baseUrl = args.base ? String(args.base) : null;
if (!baseUrl) {
  serverHandle = await startServer({ port: int('port', 5199) });
  baseUrl = serverHandle.baseUrl;
}

const browser = await launch({ headless, antiThrottle: true });
const { page, errors } = await newPage(browser, { verbose: false });

// The soak measures the RUNNING line, so it drives the page itself rather than
// letting PerfTestPlugin own a fixed-length run: `mode=supported` with a
// duration far beyond the soak keeps the plugin's line standing for the whole
// time while this runner samples the probe directly.
const url = perfUrl(baseUrl, {
  scenario: 'line', mode: 'supported', duration: Math.ceil(hours * 3600) + 3600,
  mu: cfg.mu, sensors: cfg.sensors, load,
  lanes: cfg.lanes, plcs: cfg.plcs, segments: cfg.segments, seglen: cfg.seglen,
  speed: cfg.speed, templates: cfg.templates, seed: cfg.seed,
  // Same environment switches as the matrix (plan-465 fix 2026-09-06): defaults
  // are production shadows/effects with the demo model stripped, so an 8 h soak
  // measures the LINE ageing rather than the demo model ageing next to it.
  shadows: String(args.shadows ?? 'on'),
  effects: String(args.effects ?? 'on'),
  keepmodel: String(args.keepmodel ?? 'off'),
});
console.log(`soak: ${hours} h, ${cfg.mu} MUs, load=${load}, gc every ${gcIntervalMin || '-'} min`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 300_000 });
await page.waitForFunction(() => window.__rvSyntheticLine !== undefined, undefined, { timeout: 600_000 });
// Wait for the plugin to have built the line and started the probe.
await page.waitForFunction(
  () => window.__rvSyntheticLine.current() !== null,
  undefined,
  { timeout: 600_000 },
).catch(() => console.error('warning: no synthetic line reported after 10 min'));

const session = await openCdp(page);
await mkdir(reportDir, { recursive: true });
const baseName = String(args.out ?? reportBaseName(gcIntervalMin > 0 ? 'soak' : 'soak-control'));
const jsonl = createWriteStream(join(reportDir, `${baseName}.jsonl`), { flags: 'a' });

let stopped = false;
process.on('SIGINT', () => { console.log('\nSIGINT — finishing and writing the report'); stopped = true; });

const started = Date.now();
const endAt = started + hours * 3600_000;
const heapSamples = [];
let lastGcAt = 0;
let sampleCount = 0;

while (!stopped && Date.now() < endAt) {
  await new Promise((r) => setTimeout(r, sampleIntervalMs));
  if (stopped) break;

  let heapUsed = null;
  const nowMs = Date.now();
  const doGc = gcIntervalMin > 0 && nowMs - lastGcAt >= gcIntervalMin * 60_000;
  if (doGc) {
    lastGcAt = nowMs;
    // Bracket the forced collection so the frames it stalls are recorded in the
    // probe's EXCLUDED histograms and never reach the reported percentiles.
    await page.evaluate(() => window.__rvPerfProbe?.markGc(true));
    heapUsed = await cdpHeapAfterGc(session).catch(() => null);
    await page.evaluate((h) => {
      window.__rvPerfProbe?.setHeapUsed(h ?? undefined);
      window.__rvPerfProbe?.markGc(false);
    }, heapUsed);
  }

  const snapshot = await page.evaluate(() => {
    const probe = window.__rvPerfProbe;
    const tm = window.__rvViewer?.transportManager;
    const r = probe?.report?.();
    return {
      frameMs: r?.frameMs ?? null,
      stepMs: r?.stepMs ?? null,
      transportMs: r?.transportMs ?? null,
      lostSimSeconds: r?.lostSimSeconds ?? 0,
      pausedSeconds: r?.pausedSeconds ?? 0,
      longTasks: r?.longTasks ?? 0,
      longTaskMsMax: r?.longTaskMsMax ?? 0,
      last: r?.last ?? null,
      latency: r?.latency ?? null,
      liveMUs: tm?.mus.length ?? 0,
      spawned: tm?.totalSpawned ?? 0,
      consumed: tm?.totalConsumed ?? 0,
      surfaces: tm?.surfaces.length ?? 0,
      sensors: tm?.sensors.length ?? 0,
    };
  }).catch((e) => ({ error: String(e) }));

  const row = { t: Date.now() - started, gcForced: doGc, heapUsed, ...snapshot };
  if (heapUsed !== null) heapSamples.push({ t: row.t, heapUsed });
  jsonl.write(`${JSON.stringify(row)}\n`);
  sampleCount++;
  if (sampleCount % 10 === 0 || doGc) {
    const mins = (row.t / 60000).toFixed(1);
    console.log(`  ${mins} min · MUs ${row.liveMUs} · frame p95 ${row.frameMs?.p95?.toFixed(1) ?? '-'} ms`
      + ` · lost ${row.lostSimSeconds.toFixed(2)} s${heapUsed !== null ? ` · heap ${(heapUsed / 1024 ** 2).toFixed(1)} MiB` : ''}`);
  }
}

const final = await page.evaluate(() => ({
  probe: window.__rvPerfProbe?.reportJSON?.() ?? null,
  results: window.__PERF_RESULTS__ ?? null,
  rendererInfo: window.__rvViewer?.getRendererInfo?.() ?? null,
  store: window.__rvViewer?.signalStore?.stats?.() ?? null,
})).catch(() => ({ probe: null, results: null, rendererInfo: null, store: null }));

jsonl.end();
const fp = await fingerprint(page, browser, { hours, gcIntervalMin, load, cfg, headless })
  .catch(() => ({ timestamp: new Date().toISOString(), host: 'unknown' }));
await browser.close();
await serverHandle?.close();

const runtimeSeconds = (Date.now() - started) / 1000;
const slope = heapSlopeMiBPerHour(heapSamples);
const probe = final.probe ?? {};
const verdict = grade({
  frameP95: probe.frameMs?.p95 ?? Infinity,
  frameP99: probe.frameMs?.p99 ?? Infinity,
  lostSimSeconds: probe.lostSimSeconds ?? 0,
  runtimeSeconds,
  // A control run takes no heap samples, so it cannot be graded on the leak
  // criterion — and must not silently pass it either.
  ...(gcIntervalMin > 0 ? { heapSlope: slope } : {}),
  stationary: final.results?.stationarity?.reached,
});

const { mdPath, jsonPath } = await writeReport(baseName, {
  markdown: renderMarkdown(),
  json: { fingerprint: fp, options: { hours, gcIntervalMin, load, cfg, headless }, verdict, heapSamples, final, runtimeSeconds, pageErrors: errors.slice(0, 50) },
});
console.log(`\nReport: ${mdPath}\n        ${jsonPath}\n        ${join(reportDir, `${baseName}.jsonl`)}`);

function renderMarkdown() {
  const first = probe.first ?? {};
  const last = probe.last ?? {};
  const l = [];
  l.push(`# realvirtual WEB — soak report (plan-465)${gcIntervalMin > 0 ? '' : ' — GC CONTROL RUN'}`);
  l.push('');
  if (gcIntervalMin === 0) {
    l.push('> Control run: **no forced GC**. Timing here is free of collection stalls,');
    l.push('> but there is no heap trend — read it together with the GC-sampled run.');
    l.push('');
  }
  l.push('## Machine fingerprint');
  l.push('');
  l.push(fingerprintMarkdown(fp));
  l.push('');
  l.push(`## Configuration\n`);
  l.push(`- Requested ${hours} h, actually ran ${(runtimeSeconds / 3600).toFixed(2)} h`);
  l.push(`- Load: \`${load}\`; GC sampling every ${gcIntervalMin || 0} min; probe sampled every ${sampleIntervalMs / 1000} s`);
  l.push(`- Line: ${JSON.stringify(cfg)}`);
  l.push('');
  l.push('## Result');
  l.push('');
  l.push(`**${verdict.supported ? 'SUPPORTED' : 'NOT SUPPORTED'}** against the §1.3 criteria.`);
  l.push('');
  l.push('| criterion | value | verdict |');
  l.push('|---|---:|---|');
  for (const c of verdict.checks) {
    l.push(`| ${c.name} | ${typeof c.value === 'number' ? c.value.toFixed(3) : String(c.value)} | ${c.ok ? 'pass' : '**fail**'} |`);
  }
  l.push('');
  l.push('## Timing (whole run, excluding hidden/GC-forced values)');
  l.push('');
  l.push('| metric | p50 | p95 | p99 | max | samples |');
  l.push('|---|---:|---:|---:|---:|---:|');
  for (const [name, m] of [['frame', probe.frameMs], ['fixed step', probe.stepMs], ['transport', probe.transportMs], ['signal jitter', probe.jitterMs], ['flush', probe.flushMs]]) {
    if (!m) continue;
    l.push(`| ${name} (ms) | ${m.p50.toFixed(2)} | ${m.p95.toFixed(2)} | ${m.p99.toFixed(2)} | ${m.max.toFixed(2)} | ${m.count} |`);
  }
  l.push('');
  l.push(`- Lost simulation time: **${(probe.lostSimSeconds ?? 0).toFixed(2)} s** of ${runtimeSeconds.toFixed(0)} s`
    + ` (clamp ${(probe.clampedSeconds ?? 0).toFixed(2)} s + backlog ${(probe.droppedBacklogSeconds ?? 0).toFixed(2)} s);`
    + ` paused ${(probe.pausedSeconds ?? 0).toFixed(2)} s`);
  l.push(`- Long tasks: ${probe.longTasks ?? 0} (longest ${(probe.longTaskMsMax ?? 0).toFixed(0)} ms)`);
  if (probe.latency) {
    l.push(`- Signal path: ${probe.latency.samples} timestamped updates, ${probe.latency.coalescedGaps} coalesced away, ${probe.latency.restarts} publisher restart(s)`);
  }
  l.push('');
  l.push('## Growth (start vs end)');
  l.push('');
  l.push('| quantity | start | end |');
  l.push('|---|---:|---:|');
  for (const k of ['liveMUs', 'pools', 'poolCapacity', 'signals', 'listeners', 'resolveCache', 'geometries', 'textures', 'drawCalls', 'triangles']) {
    if (first[k] === undefined && last[k] === undefined) continue;
    l.push(`| ${k} | ${first[k] ?? '-'} | ${last[k] ?? '-'} |`);
  }
  l.push('');
  if (gcIntervalMin > 0) {
    l.push(`Heap slope after GC: **${slope.toFixed(2)} MiB/h** over ${heapSamples.length} samples`
      + ` (limit 5 MiB/h).`);
    if (heapSamples.length >= 2) {
      l.push('');
      l.push(`First ${(heapSamples[0].heapUsed / 1024 ** 2).toFixed(1)} MiB → last ${(heapSamples[heapSamples.length - 1].heapUsed / 1024 ** 2).toFixed(1)} MiB.`);
    }
    l.push('');
    l.push('> A 24 h figure quoted from this run is an **extrapolation of the fitted slope**,');
    l.push('> explicitly labelled as such — it is not a measurement (SOL #9).');
  }
  l.push('');
  return l.join('\n');
}
