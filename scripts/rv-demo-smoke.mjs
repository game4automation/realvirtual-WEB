// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Live demo smoke runner (plan-503 §2.4).
 *
 * Runs the `prod-demo` Playwright project against a DEPLOYED target and always
 * writes `<outDir>/smoke-result.json`. Six steps, each of which can end the run
 * with `status: 'failed'` and a `reason`:
 *
 *   1. runtime      — `<rootDir>/node_modules/playwright/cli.js` and a Chromium
 *                     under PLAYWRIGHT_BROWSERS_PATH exist        → runtime-missing
 *   2. reachability — GET <baseUrl>demo-realvirtual/project.json    → unreachable
 *   3. freshness    — the SERVED fingerprint (index.html sha256, manifest sha256,
 *                     Content-Length of every demos GLB) equals the EXPECTED one,
 *                     polled with backoff                          → stale-cdn
 *   4. playwright   — `node cli.js test --project=prod-demo --reporter=json,line`
 *                     (no npm lifecycle, F9)                       → timeout | crashed
 *                     Every spec opens its document with `&welcome=0` (plan-646 F14):
 *                     the `/demo` build shows a welcome window on each start, and the
 *                     smoke must measure the same page on `/demo` and `/dev`.
 *   5. report       — recursive flatten, three verdicts: completeness, result, frame
 *                                                     → report-unreadable | incomplete | tests
 *   6. result       — smoke-result.json written on EVERY path.
 *
 * The EXPECTED fingerprint comes from exactly two places, never from the live
 * site and never from a local rebuild (a rebuild is never byte-identical to a
 * deploy — spike § 4):
 *   - `expectedFile` (`--expected <file>`): `{ pair, baseUrl, demos, fingerprint }`,
 *     written by `bunny-deploy.mjs` from the STAGING dist right after the purge
 *     (the deploy path and `--retry-smoke`), or kept from such a run (manual runs);
 *   - `distDir` (`--dist <dir>`): the uploaded staging bytes themselves.
 * Without either the runner refuses to start. It never writes expected.json.
 *
 * `status: 'skipped'` exists only for `noSmoke`. Exit code (CLI): 0 = ok or
 * skipped, 3 = failed, 2 = usage error.
 * Only `node:` imports plus `./lib/rv-proc.mjs` (the ONE process helper, plan-587) — the runner
 * must work from a bare clone with node_modules.
 * No shebang in `scripts/*.mjs`: vite-node fails on the `#!` line after a CRLF checkout (2026-09-27, plan-503).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree } from './lib/rv-proc.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

//! Hard limit of the Playwright run (NFR: < 4 min without retry, 10 min hard).
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
//! Freshness poll budget after the purge (F7) and its interval.
export const DEFAULT_POLL_BUDGET_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
const PARTIAL_LOG_CHARS = 20_000;

/**
 * Test identities of the journeys (F14: basename(file) › describe… › title).
 * Mirrored from e2e/prod-demo/*.spec.ts; tests/playwright-config-prod-demo.node.test.ts
 * fails when they drift apart.
 */
export const JOURNEY_TITLES = Object.freeze([
  'hmi-journey.spec.ts › demo runs by itself and the HMI chrome is usable',
  'planner-journey.spec.ts › drag moves the placement and reload follows the measured contract',
  'editor-test-run-journey.spec.ts › editor test run of a display-named demo restores the original and keeps the drive forces',
]);

/** Test identity of one boot test of demo-smoke.spec.ts (it iterates the `demos` keys). */
export const bootTitle = (key) => `demo-smoke.spec.ts › boots ${key} demo without errors`;

/** The expected test identities for a set of demo keys. */
export function expectedTitles(demos) {
  return [...Object.keys(demos).map(bootTitle), ...JOURNEY_TITLES];
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

const defaultDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  spawn: nodeSpawn,
  readFile: (p) => readFileSync(p),
  writeFile: (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); },
  exists: (p) => existsSync(p),
  readdir: (p) => readdirSync(p),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  killTree,
};

// ─── Report parsing (step 5) ──────────────────────────────────────────────

//! Flattens Playwright's JSON report: suites nest (file → describe → …), specs
//! carry tests (one per project), tests carry results (one per retry).
//! Identity (F14) = basename(spec.file) › nested describe titles › spec.title. The
//! top-level FILE suite's title is ignored: on Windows it is the platform path
//! (`prod-demo\x.spec.ts`) while `file` says `prod-demo/x.spec.ts` (measured 2026-09-26).
export function flattenReport(report) {
  const out = [];
  const walk = (suite, trail, file, isFileSuite = false) => {
    const f = suite.file ?? file;
    const here = !isFileSuite && suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const title = [basename(String(spec.file ?? f ?? '').replace(/\\/g, '/')), ...here, spec.title].join(' › ');
        out.push({ title, status: test.status, projectName: test.projectName, results: test.results ?? [] });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here, f);
  };
  for (const suite of report.suites ?? []) walk(suite, [], suite.file, true);
  return out;
}

//! Decodes JSON body attachments (reload-contract, motion, *-boot) of the LAST result.
function observationsOf(results) {
  const last = results[results.length - 1];
  const obs = {};
  for (const a of last?.attachments ?? []) {
    if (a.contentType === 'application/json' && a.body) {
      try { obs[a.name] = JSON.parse(Buffer.from(a.body, 'base64').toString('utf8')); } catch { /* not JSON */ }
    }
  }
  return obs;
}

const globalFailure = (e) => ({ spec: '(global)', title: '(global)', message: String(e?.message ?? e).slice(0, 2000), attachments: [] });

//! The three verdicts of step 5. Returns `{ status, reason?, executed, failures, flaky, observations, durations, retries }`.
//! Only Playwright's final verdict per test counts (`expected | unexpected | flaky`, after retries);
//! `skipped` never counts as executed.
export function judgeReport(report, expected, exitCode) {
  const tests = flattenReport(report);
  const counted = tests.filter((t) => ['expected', 'unexpected', 'flaky'].includes(t.status));
  const executed = counted.map((t) => t.title);
  const failures = [];
  const flaky = [];
  const observations = {};
  const durations = {};
  for (const t of counted) {
    observations[t.title] = observationsOf(t.results);
    durations[t.title] = t.results.reduce((s, r) => s + (r.duration ?? 0), 0);
    if (t.status === 'flaky') flaky.push(t.title);
    if (t.status === 'unexpected') {
      const last = t.results[t.results.length - 1] ?? {};
      failures.push({
        spec: t.title.split(' › ')[0],
        title: t.title,
        message: String(last.error?.message ?? last.errors?.[0]?.message ?? 'failed').slice(0, 2000),
        attachments: (last.attachments ?? []).filter((a) => a.path).map((a) => a.path),
      });
    }
  }
  const retries = tests.reduce((s, t) => s + Math.max(0, t.results.length - 1), 0);
  const base = { executed, failures, flaky, observations, durations, retries };
  const globalErrors = report.errors ?? [];
  // (a) completeness — global errors (e.g. _live-target.ts throwing at import) explain WHY tests are missing.
  const missing = expected.filter((title) => !executed.includes(title));
  if (missing.length > 0) {
    return {
      ...base, status: 'failed', reason: 'incomplete',
      failures: [
        ...failures,
        ...globalErrors.map(globalFailure),
        ...missing.map((title) => ({ spec: title.split(' › ')[0], title, message: 'expected test did not run', attachments: [] })),
      ],
    };
  }
  // (b) result
  if (failures.length > 0) return { ...base, status: 'failed', reason: 'tests' };
  // (c) frame — a non-zero exit or a global error with every test green is still red.
  if (exitCode !== 0 || globalErrors.length > 0) {
    return {
      ...base, status: 'failed', reason: 'tests',
      failures: globalErrors.length ? globalErrors.map(globalFailure) : [globalFailure(`playwright exit ${exitCode}`)],
    };
  }
  return { ...base, status: 'ok' };
}

// ─── Fingerprint (step 3) ─────────────────────────────────────────────────

//! What the CDN serves right now: sha256 of index.html and of the demo manifest, and per
//! demos GLB the `Content-Length` of a HEAD with `Accept-Encoding: identity` — Bunny gzips
//! GLBs for a client that accepts it and then sends NEITHER Content-Length NOR ETag, and a
//! GLB never carries an ETag at all (measured 2026-09-26). `Last-Modified` is only recorded.
export async function servedFingerprint(baseUrl, glbPaths, deps = defaultDeps) {
  const noCache = { 'Cache-Control': 'no-cache' };
  const get = async (url) => {
    const res = await deps.fetch(url, { headers: noCache, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const indexHtml = sha256(await get(`${baseUrl}index.html`));
  const manifest = sha256(await get(`${baseUrl}demo-realvirtual/project.json`));
  const glbs = {};
  for (const path of glbPaths) {
    const head = await deps.fetch(`${baseUrl}demo-realvirtual/${path}`, {
      method: 'HEAD', headers: { ...noCache, 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(15_000),
    });
    const lastModified = head.headers?.get?.('last-modified') ?? null;
    glbs[path] = { size: Number(head.headers?.get?.('content-length') ?? NaN), ...(lastModified ? { lastModified } : {}) };
  }
  return { indexHtml, manifest, glbs };
}

//! The fingerprint of an UPLOADED build, from its dist/ (the staging dist inside deployPublic,
//! after SEO injection and manifest pruning). Returns `{ demos, fingerprint }`; the demo ids come
//! from THIS manifest, never from the live one.
export function distFingerprint(distDir, deps = defaultDeps) {
  const manifestBuf = deps.readFile(join(distDir, 'demo-realvirtual', 'project.json'));
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  const demos = manifest.demos ?? {};
  const byId = new Map((manifest.documents ?? []).map((d) => [d.id, d]));
  const glbs = {};
  for (const id of Object.values(demos)) {
    const path = byId.get(id)?.path;
    if (!path) continue;
    glbs[path] = { size: deps.readFile(join(distDir, 'demo-realvirtual', path)).length };
  }
  return {
    demos,
    fingerprint: { indexHtml: sha256(deps.readFile(join(distDir, 'index.html'))), manifest: sha256(manifestBuf), glbs },
  };
}

//! Whether the served fingerprint is the expected one (html + manifest + every GLB size).
export function sameFingerprint(expected, served) {
  if (!served || expected.indexHtml !== served.indexHtml || expected.manifest !== served.manifest) return false;
  for (const [path, want] of Object.entries(expected.glbs ?? {})) {
    if (served.glbs?.[path]?.size !== want.size) return false;
  }
  return true;
}

// ─── Runner ───────────────────────────────────────────────────────────────

//! Runs the six steps. Never throws for an expected failure; always writes smoke-result.json.
//! Throws only for a usage error (no `distDir` and no `expectedFile`, no outDir, no base URL).
//! `opts`: baseUrl?, distDir? | expectedFile?, outDir, rootDir?, browsersPath?, pair?,
//! timeoutMs?, pollBudgetMs?, pollIntervalMs?, noSmoke?, deps?.
export async function runDemoSmoke(opts) {
  const deps = { ...defaultDeps, ...(opts.deps ?? {}) };
  if (!opts.outDir) throw new Error('runDemoSmoke: outDir is required');
  if (!opts.noSmoke && !opts.distDir && !opts.expectedFile) {
    throw new Error('runDemoSmoke: pass distDir (the uploaded staging dist) or expectedFile (an expected.json of a deploy). '
      + 'There is no default: a local rebuild is never byte-identical to a deploy, and the live site must not confirm itself.');
  }
  const outDir = resolve(opts.outDir);
  const rootDir = resolve(opts.rootDir ?? ROOT);
  const browsersPath = opts.browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? null;
  const pollBudgetMs = opts.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = deps.now();
  const reportPath = join(outDir, 'smoke-result.json');
  const playwrightReportPath = join(outDir, 'playwright-report.json');
  const steps = {};
  let baseUrl = opts.baseUrl ? withSlash(opts.baseUrl) : null;
  let pair = opts.pair ?? null;
  let expected = [];
  let demos = {};
  let fingerprint = null;

  const finish = (fields) => {
    const result = {
      status: fields.status,
      ...(fields.reason ? { reason: fields.reason } : {}),
      expected,
      executed: fields.executed ?? [],
      failures: fields.failures ?? [],
      flaky: fields.flaky ?? [],
      fingerprint,
      demos,
      pair,
      steps,
      reportPath,
      ...(fields.playwrightRan ? { playwrightReportPath } : {}),
      outDir,
      durationMs: deps.now() - startedAt,
      baseUrl,
      ...(fields.observations ? { observations: fields.observations } : {}),
      ...(fields.durations ? { durations: fields.durations } : {}),
      ...(fields.retries !== undefined ? { retries: fields.retries } : {}),
      ...(fields.detail ? { detail: fields.detail } : {}),
      ...(fields.partialLog ? { partialLog: fields.partialLog } : {}),
    };
    deps.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };

  if (opts.noSmoke) return finish({ status: 'skipped' });

  // 0. The expected stand — read first, it may carry the base URL and the pair.
  let want;
  try {
    if (opts.expectedFile) {
      const file = JSON.parse(deps.readFile(opts.expectedFile).toString('utf8'));
      if (!file?.fingerprint?.indexHtml || !file?.demos) throw new Error('no fingerprint/demos in it');
      want = { demos: file.demos, fingerprint: file.fingerprint };
      baseUrl = baseUrl ?? (file.baseUrl ? withSlash(file.baseUrl) : null);
      pair = pair ?? file.pair ?? null;
    } else {
      want = distFingerprint(opts.distDir, deps);
    }
  } catch (error) {
    return finish({ status: 'failed', reason: 'expected-unreadable', detail: `${opts.expectedFile ?? opts.distDir}: ${error?.message ?? error}` });
  }
  if (!baseUrl) return finish({ status: 'failed', reason: 'expected-unreadable', detail: 'no base URL (pass --base-url or an expected.json with baseUrl)' });
  demos = want.demos;
  expected = expectedTitles(demos);
  fingerprint = want.fingerprint;

  // 1. runtime
  let t = deps.now();
  const cli = join(rootDir, 'node_modules', 'playwright', 'cli.js');
  let hasBrowser = false;
  try {
    hasBrowser = !!browsersPath && deps.exists(browsersPath)
      && deps.readdir(browsersPath).some((name) => /^chromium/.test(String(name)));
  } catch { hasBrowser = false; }
  steps.runtime = { ms: deps.now() - t, cli: deps.exists(cli), browser: hasBrowser, browsersPath };
  if (!steps.runtime.cli || !hasBrowser) {
    return finish({ status: 'failed', reason: 'runtime-missing', detail: steps.runtime.cli ? `no chromium* under ${browsersPath ?? '(PLAYWRIGHT_BROWSERS_PATH unset)'}` : `missing ${cli}` });
  }

  // 2. reachability
  t = deps.now();
  try {
    const res = await deps.fetch(`${baseUrl}demo-realvirtual/project.json`, { signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    steps.reachability = { ms: deps.now() - t };
    return finish({ status: 'failed', reason: 'unreachable', detail: String(error?.message ?? error) });
  }
  steps.reachability = { ms: deps.now() - t };

  // 3. freshness — poll with backoff until the served bytes are the uploaded ones.
  t = deps.now();
  const deadline = deps.now() + pollBudgetMs;
  let served = null;
  let polls = 0;
  for (;;) {
    polls += 1;
    try { served = await servedFingerprint(baseUrl, Object.keys(fingerprint.glbs ?? {}), deps); } catch (error) { served = { error: String(error?.message ?? error) }; }
    if (!served.error && sameFingerprint(fingerprint, served)) break;
    if (deps.now() >= deadline) {
      steps.freshness = { ms: deps.now() - t, polls, served };
      return finish({ status: 'failed', reason: 'stale-cdn', detail: `served fingerprint never matched the expected one within ${pollBudgetMs} ms` });
    }
    await deps.sleep(pollIntervalMs);
  }
  steps.freshness = { ms: deps.now() - t, polls, served };

  // 4. playwright — directly through the CLI, no npm lifecycle (F9).
  t = deps.now();
  const env = {
    ...process.env,
    RV_SMOKE_BASE_URL: baseUrl,
    RV_SMOKE_EXPECTED_DEMOS: JSON.stringify(demos),
    PLAYWRIGHT_JSON_OUTPUT_NAME: playwrightReportPath,
    ...(browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
  };
  const child = deps.spawn(process.execPath, [cli, 'test', '--project=prod-demo', '--reporter=json,line', `--output=${join(outDir, 'artifacts')}`], {
    cwd: rootDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  // The JSON report is written only at the END — the `line` output is what survives a kill.
  let lineLog = '';
  const keep = (d) => { lineLog = (lineLog + d).slice(-PARTIAL_LOG_CHARS); };
  child.stdout?.on?.('data', keep);
  child.stderr?.on?.('data', keep);
  let timer;
  const exit = await new Promise((resolveExit) => {
    timer = setTimeout(() => { deps.killTree(child.pid); resolveExit({ timedOut: true }); }, timeoutMs);
    child.on('error', (error) => resolveExit({ code: -1, error: String(error?.message ?? error) }));
    child.on('exit', (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer);
  steps.playwright = { ms: deps.now() - t, exit };
  if (exit.timedOut) {
    return finish({ status: 'failed', reason: 'timeout', playwrightRan: true, detail: `playwright exceeded ${timeoutMs} ms — process tree killed`, partialLog: lineLog });
  }
  if (exit.signal || exit.code === null || exit.code === -1) {
    return finish({ status: 'failed', reason: 'crashed', playwrightRan: true, detail: exit.error ?? `signal ${exit.signal}`, partialLog: lineLog });
  }

  // 5. report
  let report;
  try {
    report = JSON.parse(deps.readFile(playwrightReportPath).toString('utf8'));
  } catch (error) {
    return finish({ status: 'failed', reason: 'report-unreadable', playwrightRan: true, detail: String(error?.message ?? error), partialLog: lineLog });
  }
  // 6. result
  return finish({ ...judgeReport(report, expected, exit.code), playwrightRan: true });
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const USAGE = `Usage: node scripts/rv-demo-smoke.mjs --expected <expected.json> [--base-url <url>] [--out <dir>]
       node scripts/rv-demo-smoke.mjs --dist <uploaded staging dist> --base-url <url> [--out <dir>]
  --expected   expected.json of a deploy ({ pair, baseUrl, demos, fingerprint }), e.g. <watcher root>\\last-smoke\\expected.json
  --dist       ONLY the staging dist that was uploaded (deploy path) — never a local rebuild
  --out        output dir (default <repo>/.smoke/<timestamp>/)
  --timeout-ms, --poll-budget-ms   limits (default ${DEFAULT_TIMEOUT_MS} / ${DEFAULT_POLL_BUDGET_MS})`;

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--base-url') out.baseUrl = value();
    else if (a === '--out') out.outDir = value();
    else if (a === '--dist') out.distDir = value();
    else if (a === '--expected') out.expectedFile = value();
    else if (a === '--timeout-ms') out.timeoutMs = Number(value());
    else if (a === '--poll-budget-ms') out.pollBudgetMs = Number(value());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.expectedFile && !out.distDir) throw new Error('--expected <file> is required (or --dist <uploaded staging dist> on the deploy path)');
  if (out.distDir && !out.baseUrl) throw new Error('--dist needs --base-url');
  out.outDir = out.outDir ?? join(ROOT, '.smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`rv-demo-smoke: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const r = await runDemoSmoke(opts);
  console.log(`SMOKE ${r.status.toUpperCase()}${r.reason ? ` reason=${r.reason}` : ''} duration=${(r.durationMs / 1000).toFixed(1)}s failures=${r.failures.length}${r.flaky.length ? ` flaky=${r.flaky.length}` : ''}`);
  for (const f of r.failures.slice(0, 10)) console.log(`  ✗ ${f.title}: ${f.message.split('\n')[0]}`);
  if (r.detail) console.log(`  ${r.detail}`);
  console.log(`SMOKE_REPORT=${r.reportPath}`);
  process.exitCode = r.status === 'failed' ? 3 : 0;
}
