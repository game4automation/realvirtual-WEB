// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Stress runner — runs ONE scenario against a viewer under sustained load,
 * samples memory and responsiveness the whole time, enforces the stop rules and
 * writes a findings report. Driven by the `/stresstest` skill.
 *
 *   node scripts/stress/rv-stress-run.mjs --list
 *   node scripts/stress/rv-stress-run.mjs --self-test            (no browser)
 *   node scripts/stress/rv-stress-run.mjs <scenario> --serve [--duration 30m] [--report <dir>]
 *   node scripts/stress/rv-stress-run.mjs <scenario> --base http://127.0.0.1:5391 [...]
 *   ... --community        serve the community build (VITE_PUBLIC_BUILD=1)
 *   ... --no-warmup        skip the throw-away first load (default: warm-up with --serve)
 *   ... --min-free-gb N    stop when machine free commit < N GB (default 6)
 *   ... any further --key value pairs go to the scenario (e.g. --batches 2)
 *
 * Scenarios are modules `scenarios/<id>.mjs` exporting `scenario` (shape:
 * see validateScenario in rv-stress-analysis.mjs). They are looked up here, in
 * every `--scenarios <dir>`, and in the private sibling repo's
 * `scripts/stress/scenarios/` when that checkout exists (commercial scenarios).
 *
 * Exit codes: 0 = ran, no critical/high finding · 1 = ran, critical/high found ·
 * 2 = scenario unknown, invalid or a stub · 3 = preflight refused (memory, build) ·
 * 4 = harness error.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLDS, analyzeSamples, consoleFindings, createFindings, linearTrend, parseArgs,
  parseDuration, percentile, renderMarkdown, summarizeSamples, validateScenario, classifyConsoleError,
} from './rv-stress-analysis.mjs';
import {
  WEB_ROOT, findFreePort, heapProbe, machineProbe, makeCommandDriver, openViewer, reloadViewer, rttProbe, sleep, startVite, viteServersOf,
} from './rv-stress-core.mjs';
import { findWorkspaceRoot, tmpDir } from '../lib/rv-machine-paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PRIVATE_ROOT = resolve(WEB_ROOT, '..', 'realvirtual-WebViewer-Private~');

// ---------------------------------------------------------------------------
// Scenario discovery
// ---------------------------------------------------------------------------

function scenarioDirs(extra) {
  const dirs = [join(here, 'scenarios'), ...extra.map(d => resolve(d))];
  const priv = join(PRIVATE_ROOT, 'scripts', 'stress', 'scenarios');
  if (existsSync(priv)) dirs.push(priv);
  return dirs.filter(d => existsSync(d));
}

async function loadAllScenarios(extra) {
  const found = [];
  for (const dir of scenarioDirs(extra)) {
    for (const f of readdirSync(dir).filter(n => n.endsWith('.mjs')).sort()) {
      const file = join(dir, f);
      try {
        const mod = await import(pathToFileURL(file).href);
        found.push({ file, scenario: mod.scenario, problems: validateScenario(mod.scenario) });
      } catch (e) {
        found.push({ file, scenario: null, problems: [`import failed: ${String(e).slice(0, 200)}`] });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Self-test (pure logic only — no browser, no processes)
// ---------------------------------------------------------------------------

async function selfTest(extra) {
  let n = 0;
  const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
  t('parseDuration', () => {
    assert.equal(parseDuration('90s'), 90000);
    assert.equal(parseDuration('15m'), 900000);
    assert.equal(parseDuration('2h'), 7200000);
    assert.equal(parseDuration('5'), 300000);
    assert.throws(() => parseDuration('5 min'));
  });
  t('parseArgs keeps scenario options', () => {
    const o = parseArgs(['des-experiments', '--serve', '--duration', '10m', '--batches', '2', '--quick', '--report', 'x']);
    assert.equal(o.scenario, 'des-experiments');
    assert.equal(o.serve, true);
    assert.equal(o.durationMs, 600000);
    assert.equal(o.report, 'x');
    assert.deepEqual(o.scenarioArgs, { batches: '2', quick: true });
    const c = parseArgs(['x', '--community', '--no-warmup', '--min-free-gb', '8']);
    assert.equal(c.community, true);
    assert.equal(c.warmup, false);
    assert.equal(c.minFreeGB, 8);
  });
  t('linearTrend slope and fit', () => {
    const pts = [0, 1, 2, 3, 4, 5].map(m => ({ tMs: m * 60000, v: 100 + 10 * m }));
    const tr = linearTrend(pts);
    assert.ok(Math.abs(tr.slopePerMin - 10) < 1e-9);
    assert.ok(tr.r2 > 0.999);
    assert.equal(linearTrend([{ tMs: 0, v: 1 }]).slopePerMin, 0);
  });
  t('percentile', () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([5, 1, 3, 2, 4], 100), 5);
    assert.equal(percentile([], 50), null);
  });
  t('analyzeSamples flags a renderer leak (0.2 GB/min, window-open phase)', () => {
    const rows = [];
    for (let i = 0; i <= 20; i++) rows.push({ tMs: i * 30000, rendererGB: 1 + 0.1 * i, heapMB: 120, embedderMB: 40, domNodes: 3000, rttMs: 20, phase: i > 4 ? 'window-open' : 'idle' });
    const f = analyzeSamples(rows);
    const leak = f.find(x => x.title.includes('renderer private bytes'));
    assert.ok(leak, 'renderer leak expected');
    assert.equal(leak.severity, 'critical'); // 204.8 MB/min > 5 × 20
    assert.ok(!f.some(x => x.title.includes('JS heap')), 'flat heap must not be flagged');
  });
  t('analyzeSamples ignores flat noise and short spans', () => {
    const rows = [];
    for (let i = 0; i <= 20; i++) rows.push({ tMs: i * 30000, rendererGB: 1 + (i % 2 ? 0.02 : -0.02), heapMB: 120 + (i % 3), rttMs: 15 });
    assert.equal(analyzeSamples(rows).length, 0);
    const short = [0, 1, 2, 3, 4].map(i => ({ tMs: i * 10000, rendererGB: 1 + i }));
    assert.equal(analyzeSamples(short).length, 0, 'under minTrendMinutes');
  });
  t('analyzeSamples flags stalls', () => {
    const rows = [0, 1, 2, 3].map(i => ({ tMs: i * 15000, rttMs: i === 2 ? 12000 : 20 }));
    const f = analyzeSamples(rows);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'high');
  });
  t('console classification', () => {
    assert.equal(classifyConsoleError('[scene-store] autosave failed: TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:5391/node_modules/.vite/deps/three_examples_jsm_exporters_GLTFExporter__js.js?v=0fb5de44'), 'harness');
    assert.equal(classifyConsoleError('TypeError: cannot read properties of undefined'), 'product');
    const f = consoleFindings([
      { kind: 'console', text: 'boom 1' }, { kind: 'console', text: 'boom 2' }, { kind: 'pageerror', text: 'Error: x' }, { kind: 'crash', text: 'gone' },
    ]);
    assert.equal(f.length, 3);
    assert.equal(f.find(x => x.title.startsWith('console')).numbers.count, 2);
    assert.equal(f.find(x => x.title === 'renderer crashed').severity, 'critical');
  });
  t('findings dedup and sort', () => {
    const fc = createFindings();
    fc.add({ severity: 'low', title: 'a' });
    fc.add({ severity: 'critical', title: 'b' });
    fc.add({ severity: 'low', title: 'a' });
    assert.equal(fc.list.length, 2);
    assert.equal(fc.sorted()[0].severity, 'critical');
    assert.equal(fc.list[0].count, 2);
    assert.throws(() => fc.add({ severity: 'urgent', title: 'x' }));
  });
  t('renderMarkdown', () => {
    const md = renderMarkdown({
      scenario: { id: 'x' }, startedAt: 's', endedAt: 'e', wallMs: 60000, outcome: 'completed', target: { url: 'u' }, options: {},
      counts: { critical: 1, high: 0, medium: 0, low: 0 }, findings: [{ severity: 'critical', title: 'leak', classification: 'product', evidence: '1', repro: ['a'], count: 1 }],
      summary: summarizeSamples([{ tMs: 0, rendererGB: 1, rttMs: 10 }, { tMs: 60000, rendererGB: 2, rttMs: 30 }]), checks: [{ name: 'c', ok: false, detail: 'd' }],
    });
    assert.match(md, /\[CRITICAL\] leak/);
    assert.match(md, /Renderer private/);
    assert.match(md, /\| c \| FAIL \|/);
  });
  const all = await loadAllScenarios(extra);
  for (const s of all) {
    t(`scenario ${s.scenario?.id ?? s.file} valid (${s.scenario?.status ?? '?'})`, () => assert.deepEqual(s.problems, [], `${s.file}: ${s.problems.join('; ')}`));
  }
  const ids = all.map(s => s.scenario?.id);
  t('scenario ids unique', () => assert.equal(new Set(ids).size, ids.length));
  console.log(`self-test: ${n} checks passed`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function gitHead(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).toString().trim(); } catch { return null; }
}

function defaultReportDir(id) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = process.env.RV_STRESS_OUT
    ? resolve(process.env.RV_STRESS_OUT)
    : findWorkspaceRoot(WEB_ROOT) ? join(tmpDir(), 'stress') : resolve(WEB_ROOT, '..', 'stress-reports');
  return join(base, `${id}-${stamp}`);
}

async function run(opts) {
  const all = await loadAllScenarios(opts.scenarioDirs);
  const entry = all.find(s => s.scenario?.id === opts.scenario);
  if (!entry) { console.error(`unknown scenario '${opts.scenario}'. Known: ${all.map(s => s.scenario?.id).filter(Boolean).join(', ')}`); return 2; }
  const sc = entry.scenario;
  if (entry.problems.length) { console.error(`scenario '${sc.id}' invalid: ${entry.problems.join('; ')}`); return 2; }
  if (sc.status === 'stub') {
    console.error(`scenario '${sc.id}' is a STUB — not implemented yet. TODO:\n${sc.todo.map(x => `  - [ ] ${x}`).join('\n')}`);
    return 2;
  }

  const th = { ...DEFAULT_THRESHOLDS, ...(sc.thresholds ?? {}) };
  if (opts.maxRendererGB) th.maxRendererGB = opts.maxRendererGB;
  if (opts.minFreeGB) th.minFreeCommitGB = opts.minFreeGB;
  const durationMs = opts.durationMs ?? parseDuration(sc.defaults?.duration ?? '20m');

  // --- preflight ---------------------------------------------------------
  const pre = machineProbe(null);
  if (pre.freeCommitGB !== null && pre.freeCommitGB < th.preflightFreeCommitGB) {
    console.error(`preflight: free commit ${pre.freeCommitGB.toFixed(1)} GB < ${th.preflightFreeCommitGB} GB — not starting (memory rule).`);
    return 3;
  }
  if (sc.requires.build === 'commercial' && !existsSync(PRIVATE_ROOT)) {
    console.error(`preflight: scenario needs the commercial build, but ${PRIVATE_ROOT} is missing.`);
    return 3;
  }
  // The build a scenario needs decides the dev server: community = VITE_PUBLIC_BUILD=1.
  const community = opts.community || sc.requires.build === 'community';
  if (community && sc.requires.build === 'commercial') { console.error('preflight: --community contradicts a commercial scenario'); return 3; }
  if (opts.serve) {
    // Commercial and community dev servers of the same checkout share node_modules/.vite.
    const others = viteServersOf(WEB_ROOT);
    if (others.length) {
      console.error(`preflight: a Vite server already runs from this worktree (pid ${others.map(o => o.pid).join(', ')}) — `
        + 'never two dev servers (commercial + community) from one checkout; stop yours or use another worktree. Foreign processes are not touched.');
      return 3;
    }
  }
  if (!opts.base && !opts.serve) { console.error('give --base <url> or --serve'); return 2; }

  const outDir = resolve(opts.report ?? defaultReportDir(sc.id));
  mkdirSync(outDir, { recursive: true });
  const logFile = join(outDir, 'run.log');
  const log = (...a) => {
    const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    console.log(s);
    appendFileSync(logFile, s + '\n');
  };
  log(`stress ${sc.id} → ${outDir} (duration ${(durationMs / 60000).toFixed(1)} min, free commit ${pre.freeCommitGB?.toFixed(1) ?? 'n/a'} GB)`);
  if (opts.dryRun) { log('dry run: preflight passed, nothing started'); return 0; }

  const findings = createFindings();
  const checks = [];
  const metrics = {};
  const samples = [];
  const stopHooks = [];
  const startedAt = new Date();
  const t0 = Date.now();
  let vite = null;
  let session = null;
  let stopReason = null;
  let outcome = 'completed';
  let phase = null;
  let sampling = true;

  const requestStop = async (reason) => {
    if (stopReason) return;
    stopReason = reason;
    log(`STOP requested: ${reason}`);
    for (const h of stopHooks) { try { await h(reason); } catch (e) { log(`stop hook failed: ${e}`); } }
  };

  const takeSample = async (tag = null) => {
    const m = machineProbe(session?.browserPid ?? null);
    const row = { tMs: Date.now() - t0, at: new Date().toISOString(), phase, tag, freeCommitGB: m.freeCommitGB, rendererGB: m.rendererGB, gpuGB: m.gpuGB };
    // Guard first, from the machine probe alone: it must work while the page is blocked.
    if (m.freeCommitGB !== null && m.freeCommitGB < th.minFreeCommitGB) {
      findings.add({ severity: 'low', title: 'run stopped: machine free commit below limit', evidence: `${m.freeCommitGB.toFixed(1)} GB < ${th.minFreeCommitGB} GB`, classification: 'unclear' });
      void requestStop(`machine free commit ${m.freeCommitGB.toFixed(1)} GB < ${th.minFreeCommitGB} GB`);
    }
    if (m.rendererGB !== null && m.rendererGB > th.maxRendererGB) {
      findings.add({
        severity: 'critical', title: `renderer exceeded ${th.maxRendererGB} GB`, classification: 'product',
        evidence: `${m.rendererGB.toFixed(2)} GB after ${(row.tMs / 60000).toFixed(1)} min${phase ? ` in phase ${phase}` : ''}`,
        numbers: { rendererGB: m.rendererGB, tMs: row.tMs, phase },
      });
      void requestStop(`renderer ${m.rendererGB.toFixed(2)} GB > ${th.maxRendererGB} GB`);
    }
    if (session) {
      const timeout = new Promise(r => setTimeout(() => r({ pageProbeTimeout: true }), 30000).unref());
      Object.assign(row, await Promise.race([heapProbe(session.page, session.cdp), timeout]));
      row.rttMs = await rttProbe(session.page);
    }
    samples.push(row);
    appendFileSync(join(outDir, 'samples.jsonl'), JSON.stringify(row) + '\n');
    return row;
  };

  let exitCode = 0;
  try {
    // --- target ------------------------------------------------------------
    let base = opts.base;
    if (opts.serve) {
      const port = opts.port ?? await findFreePort(5300, 5399);
      vite = await startVite({ port, log, env: community ? { VITE_PUBLIC_BUILD: '1' } : {} });
      base = vite.base;
      log(`build: ${community ? 'community (VITE_PUBLIC_BUILD=1)' : 'commercial dev'}`);
    }
    // `--url-<key> <value>` overrides one query parameter of the scenario's URL (e.g. --url-doc <id>).
    const query = { ...sc.requires.url };
    for (const [k, v] of Object.entries(opts.scenarioArgs)) if (k.startsWith('url-')) query[k.slice(4)] = v;
    // A cold dev server re-optimises dependencies on the first load and reloads the page
    // mid-boot; that load is thrown away so it cannot pose as a product finding.
    if (opts.warmup ?? opts.serve) {
      const w = await openViewer({ base, query, headed: false, ready: sc.ready ?? null, commands: sc.requires.commands ?? [], log: (m) => log(`warm-up: ${m}`) }).catch(e => { log(`warm-up load failed (ignored): ${String(e).slice(0, 200)}`); return null; });
      if (w) await w.browser.close().catch(() => {});
    }
    session = await openViewer({ base, query, commands: sc.requires.commands ?? [], headed: opts.headed, ready: sc.ready ?? null, log });
    const driver = makeCommandDriver(session.page, { log });
    if (session.missingCommands?.length) {
      findings.add({ severity: 'high', title: 'required commands never registered', evidence: session.missingCommands.join(', '), classification: 'unclear' });
    }

    const ctx = {
      page: session.page, cdp: session.cdp, browser: session.browser, url: session.url,
      cmd: driver.cmd, must: driver.must, log, sleep,
      args: opts.scenarioArgs, options: { durationMs }, outDir, thresholds: th,
      deadline: t0 + durationMs,
      remainingMs: () => t0 + durationMs - Date.now(),
      stopRequested: () => !!stopReason || Date.now() > t0 + durationMs,
      onStop: (fn) => stopHooks.push(fn),
      phase: (name) => { phase = name; log(`— phase ${name}`); },
      sample: (tag) => takeSample(tag),
      finding: (f) => { const e = findings.add(f); log(`FINDING ${f.severity} ${f.title} ${f.evidence ?? ''}`); return e; },
      check: (name, ok, detail = '', onFail = null) => {
        checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
        log(`CHECK ${ok ? 'pass' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600));
        if (!ok && onFail) ctx.finding({ evidence: typeof detail === 'string' ? detail : JSON.stringify(detail), ...onFail, title: onFail.title ?? `check failed: ${name}` });
        return !!ok;
      },
      metric: (k, v) => { metrics[k] = v; },
      build: community ? 'community' : 'commercial',
      rtt: () => rttProbe(session.page),
      samples: () => samples,
      reload: () => reloadViewer(session.page, { ready: sc.ready ?? null, commands: sc.requires.commands ?? [], log }),
      screenshot: async (name) => { const p = join(outDir, `${name}.png`); await session.page.screenshot({ path: p }).catch(() => {}); return p; },
      hang: (what, r) => ctx.finding({
        severity: 'critical', title: `hang: ${what} did not answer`, classification: 'unclear',
        evidence: `${r.reason} — the harness gave up; check whether the page is still responsive (rtt samples) before calling it a product hang`,
      }),
    };

    // --- continuous sampler --------------------------------------------------
    await takeSample('start');
    const sampler = (async () => {
      while (sampling) {
        await sleep(opts.sampleSec * 1000);
        if (!sampling) break;
        await takeSample().catch(e => log(`sample failed: ${e}`));
        if (Date.now() > t0 + durationMs && !stopReason) log('duration reached — scenario should wind down');
      }
    })();

    // --- scenario ------------------------------------------------------------
    try {
      if (sc.setup) await sc.setup(ctx);
      const runP = sc.run(ctx);
      // After a stop request the scenario gets a grace period to wind down.
      const grace = (async () => { while (!stopReason) await sleep(1000); await sleep(120000); return 'grace-expired'; })();
      const r = await Promise.race([runP.then(() => 'done'), grace]);
      if (r === 'grace-expired') { outcome = 'stopped'; log('scenario did not wind down within 120 s after stop'); }
      else if (stopReason) outcome = 'stopped';
    } catch (e) {
      outcome = 'aborted';
      log(`scenario threw: ${e?.stack ?? e}`);
      findings.add({ severity: 'high', title: 'scenario aborted with an exception', evidence: String(e?.stack ?? e).slice(0, 800), classification: 'unclear' });
      await ctx.screenshot('abort');
    } finally {
      try { if (sc.teardown) await sc.teardown(ctx); } catch (e) { log(`teardown failed: ${e}`); }
    }
    sampling = false;
    await takeSample('end').catch(() => {});
    await Promise.race([sampler, sleep(35000)]);
  } catch (e) {
    outcome = 'harness-error';
    exitCode = 4;
    log(`harness error: ${e?.stack ?? e}`);
    findings.add({ severity: 'high', title: 'harness error', evidence: String(e?.stack ?? e).slice(0, 800), classification: 'harness' });
  } finally {
    sampling = false;
    if (session) await session.browser.close().catch(() => {});
    if (vite) vite.stop();
  }

  // --- analysis + report -----------------------------------------------------
  for (const f of analyzeSamples(samples, th)) findings.add(f);
  for (const f of consoleFindings(session?.errors ?? [])) findings.add(f);
  const sorted = findings.sorted();
  const report = {
    scenario: { id: sc.id, title: sc.title ?? sc.id, file: entry.file },
    startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), wallMs: Date.now() - t0,
    outcome, stopReason,
    target: { url: session?.url ?? opts.base, commit: gitHead(WEB_ROOT), privateCommit: existsSync(PRIVATE_ROOT) ? gitHead(PRIVATE_ROOT) : null },
    options: { durationMs, sampleSec: opts.sampleSec, scenarioArgs: opts.scenarioArgs, thresholds: th, build: (opts.community || sc.requires.build === 'community') ? 'community' : 'commercial' },
    counts: findings.counts(),
    findings: sorted,
    checks,
    metrics,
    summary: summarizeSamples(samples),
    consoleErrors: (session?.errors ?? []).slice(0, 200),
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(report));
  const c = report.counts;
  console.log(`\n${sc.id}: ${outcome}${stopReason ? ` (${stopReason})` : ''} — ${c.critical} critical, ${c.high} high, ${c.medium} medium, ${c.low} low`);
  console.log(`report: ${join(outDir, 'report.md')}`);
  if (exitCode) return exitCode;
  return c.critical || c.high ? 1 : 0;
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) { await selfTest(opts.scenarioDirs); return 0; }
  if (opts.list || !opts.scenario) {
    for (const s of await loadAllScenarios(opts.scenarioDirs)) {
      const sc = s.scenario;
      console.log(`${(sc?.id ?? '?').padEnd(20)} ${(sc?.status ?? 'invalid').padEnd(6)} ${sc?.requires?.build ?? ''}  ${sc?.description?.split('\n')[0] ?? s.problems.join('; ')}`);
    }
    return 0;
  }
  return run(opts);
}

main().then(code => process.exit(code ?? 0), e => { console.error(e?.stack ?? e); process.exit(4); });
