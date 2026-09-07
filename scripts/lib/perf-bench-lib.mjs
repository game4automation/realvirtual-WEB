// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * perf-bench-lib — shared plumbing for the plan-465 performance runners
 * (`perf-scale-matrix.mjs`, `perf-soak.mjs`, `perf-signal-load.mjs`).
 *
 * Deliberately scoped to the NEW runners. `arena-batch-bench.mjs` runs headless
 * on purpose (it measures CPU self-time, where a GPU would only add noise) and
 * `perf-renderer-matrix.mjs` / `mu-compute-bench.mjs` have their own contracts;
 * migrating them would change what they measure for no benefit (plan Alternative 4).
 *
 * What lives here is exactly what all three new runners need identically:
 * an isolated Vite server, a Chromium launched with background throttling off,
 * a machine fingerprint that makes a number citable, heap readings taken after a
 * forced GC, percentile maths, and report writing.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const reportDir = join(rootDir, 'docs', 'perf');

/**
 * Chromium flags that keep a measurement honest.
 *
 * Without these a run that loses focus — an unlocked screensaver, a notification,
 * the operator switching windows — silently drops to 1 Hz rAF and the whole
 * frame-time distribution becomes fiction. `--expose-gc` and
 * `--enable-precise-memory-info` are what make the heap numbers usable at all.
 */
export const ANTI_THROTTLE_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc',
];

// ── Vite server ──────────────────────────────────────────────────────────

/**
 * Start an isolated Vite dev server. Port 5199 upward by default so a runner
 * never fights the developer's own `npm run dev`.
 */
export async function startServer({ port = 5199, strictPort = false } = {}) {
  const server = await createServer({
    root: rootDir,
    logLevel: 'error',
    server: { host: '127.0.0.1', port, strictPort },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0];
  if (!baseUrl) {
    await server.close();
    throw new Error('Vite did not expose a local URL');
  }
  return { server, baseUrl, close: () => server.close() };
}

// ── Browser ──────────────────────────────────────────────────────────────

export async function launch({ headless = false, antiThrottle = true, extraArgs = [] } = {}) {
  return chromium.launch({
    headless,
    args: [...(antiThrottle ? ANTI_THROTTLE_ARGS : []), ...extraArgs],
  });
}

/** Open a page and forward its console/pageerror output to stdout. */
export async function newPage(browser, { width = 1600, height = 900, verbose = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  // The first-visit welcome modal covers the whole canvas and keeps React
  // re-rendering a full-screen overlay for the entire measurement. A fresh
  // Playwright profile is ALWAYS a first visit, so every perf run would show it
  // (plan-465 fix 2026-09-06). Same key the dialog's own close handler writes.
  await page.addInitScript(() => {
    try { localStorage.setItem('rv-welcome-dismissed', '1'); } catch { /* private mode */ }
  });
  const errors = [];
  page.on('pageerror', (err) => { errors.push(String(err)); console.error(`[page-error] ${err}`); });
  page.on('console', (msg) => {
    if (msg.type() === 'error') { errors.push(msg.text()); console.error(`[console-error] ${msg.text()}`); }
    else if (verbose) console.log(`[console] ${msg.text()}`);
  });
  return { page, errors };
}

// ── Fingerprint ──────────────────────────────────────────────────────────

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

/**
 * Machine + build identity. Every report carries this; a frame-time percentile
 * without it is not a number anyone can act on, and the whole point of the plan
 * is a CITABLE result.
 */
export async function fingerprint(page, browser, extra = {}) {
  const browserEnv = await page.evaluate(() => {
    let gpu = null;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      if (gl && dbg) {
        gpu = {
          vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
          renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
        };
      }
    } catch { /* headless / blocked extension */ }
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      longTaskObserver: PerformanceObserver.supportedEntryTypes.includes('longtask'),
      preciseHeap: typeof performance.memory?.usedJSHeapSize === 'number',
      gpu,
    };
  });
  return {
    timestamp: new Date().toISOString(),
    host: hostname(),
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    node: process.version,
    chromium: await browser.version(),
    gitCommit: gitCommit(),
    ...browserEnv,
    ...extra,
  };
}

// ── Heap via CDP ─────────────────────────────────────────────────────────

export async function openCdp(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.enable');
  await session.send('Performance.enable');
  return session;
}

/**
 * Used JS heap in bytes AFTER a forced collection.
 *
 * `measureUserAgentSpecificMemory()` is unreliable in headless Chromium
 * (playwright#34163, #37100), so the runner drives the protocol directly.
 * Forcing a collection is what makes a slope meaningful — an unforced reading
 * mostly measures where in the GC sawtooth the sample happened to land — but it
 * also perturbs timing, which is why every caller brackets it with the probe's
 * `markGc()` and the soak has a mandatory control run with `--gc-interval 0`.
 */
export async function cdpHeapAfterGc(session) {
  await session.send('HeapProfiler.collectGarbage');
  const { metrics } = await session.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null;
}

// ── Statistics ───────────────────────────────────────────────────────────
// Intentionally duplicated from src/core/engine/perf/rv-perf-probe.ts: Node
// cannot import the TypeScript source, and adding a build step to a benchmark
// runner would cost more than five lines of arithmetic.

/** Nearest-rank percentile (`p` in 0..1) — the same definition the probe uses. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}

export function percentiles(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : 0,
    count: values.length,
  };
}

/** Least-squares heap slope in MiB/h over `{t (ms), heapUsed (bytes)}` samples. */
export function heapSlopeMiBPerHour(samples) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    if (typeof s.heapUsed !== 'number') continue;
    n++; sx += s.t; sy += s.heapUsed; sxx += s.t * s.t; sxy += s.t * s.heapUsed;
  }
  if (n < 2) return 0;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (((n * sxy - sx * sy) / denom) * 3_600_000) / (1024 * 1024);
}

// ── Acceptance criteria (§1.3) ───────────────────────────────────────────

export const CRITERIA = {
  frameP95Ms: 33.3,
  frameP99Ms: 66,
  lostSimTimeFraction: 0.001,
  heapSlopeMiBPerHour: 5,
};

/**
 * Grade one cell/soak against §1.3. Returned as a list of named checks rather
 * than a bare boolean so a report can show WHICH criterion a configuration
 * broke — "not supported" without the reason is not actionable.
 */
export function grade({ frameP95, frameP99, lostSimSeconds, runtimeSeconds, heapSlope, stationary }) {
  const checks = [
    { name: 'frame p95 <= 33.3 ms', ok: frameP95 <= CRITERIA.frameP95Ms, value: frameP95 },
    { name: 'frame p99 <= 66 ms', ok: frameP99 <= CRITERIA.frameP99Ms, value: frameP99 },
  ];
  if (runtimeSeconds > 0) {
    const fraction = lostSimSeconds / runtimeSeconds;
    checks.push({
      name: 'lost sim time <= 0.1 %',
      ok: fraction <= CRITERIA.lostSimTimeFraction,
      value: fraction,
    });
  }
  if (typeof heapSlope === 'number') {
    checks.push({
      name: 'heap slope <= 5 MiB/h',
      ok: heapSlope <= CRITERIA.heapSlopeMiBPerHour,
      value: heapSlope,
    });
  }
  if (stationary !== undefined) {
    checks.push({ name: 'stationarity reached', ok: !!stationary, value: stationary });
  }
  return { supported: checks.every((c) => c.ok), checks };
}

// ── Page driving ─────────────────────────────────────────────────────────

/** Build a `?perf&...` URL from a plain options object. */
export function perfUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  url.searchParams.set('perf', '');
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  // `?perf&scenario=...` — the viewer checks `params.has('perf')`, and a bare
  // flag reads better in the docs than `perf=`.
  return url.toString().replace('perf=&', 'perf&').replace(/perf=$/, 'perf');
}

/** Wait for the PerfTestPlugin to publish, then return the raw results object. */
export async function waitForPerfResults(page, timeoutMs) {
  await page.waitForFunction(() => window.__PERF_RESULTS__ !== undefined, undefined, { timeout: timeoutMs });
  return page.evaluate(() => window.__PERF_RESULTS__);
}

// ── Reports ──────────────────────────────────────────────────────────────

/** `docs/perf/<date>-<host>-<kind>` — the naming the plan persists runs under. */
export function reportBaseName(kind) {
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${hostname().toLowerCase()}-${kind}`;
}

export async function writeReport(baseName, { markdown, json }) {
  await mkdir(reportDir, { recursive: true });
  const mdPath = join(reportDir, `${baseName}.md`);
  const jsonPath = join(reportDir, `${baseName}.json`);
  await writeFile(mdPath, markdown, 'utf8');
  await writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  return { mdPath, jsonPath };
}

/** Render the fingerprint as the Markdown header every report starts with. */
export function fingerprintMarkdown(fp) {
  return [
    `- **Host:** ${fp.host} (${fp.os})`,
    `- **CPU:** ${fp.cpu} (${fp.logicalCpus} logical)`,
    `- **RAM:** ${(fp.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB`,
    `- **GPU:** ${fp.gpu ? `${fp.gpu.vendor} — ${fp.gpu.renderer}` : 'unavailable (WEBGL_debug_renderer_info blocked)'}`,
    `- **Chromium:** ${fp.chromium}, Node ${fp.node}`,
    `- **DPR/viewport:** ${fp.devicePixelRatio} @ ${fp.viewport.width}x${fp.viewport.height}`,
    `- **Commit:** ${fp.gitCommit}`,
    `- **Long-task observer:** ${fp.longTaskObserver ? 'yes' : 'no'}; precise heap: ${fp.preciseHeap ? 'yes' : 'no'}`,
    `- **Timestamp:** ${fp.timestamp}`,
  ].join('\n');
}

/** Minimal `--flag value` / `--flag` argv parser (no dependency worth adding). */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
