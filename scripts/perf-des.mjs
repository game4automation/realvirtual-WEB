// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * npm run perf:des -- [--sizes 1,2,4,8] [--repeats 3] [--sim-sec 28800] [--out-dir dir] [--smoke] [--script off|on|both|realistic|all]
 *
 * `--script` (plan-2212 Phase 4/4b) picks the yard variants, measured back to
 * back per repeat (same machine state):
 *  - `off` (default): the plain yard measurement as before (`yard:<n>`);
 *  - `on`: only the DENSE Model-Script variant (`yard+script:<n>` - every sink,
 *    60 s audit; tests/des/perf-des-script.ts);
 *  - `both`: plain + dense;
 *  - `realistic`: plain + the REALISTIC density (`yard+script-realistic:<n>` -
 *    one sink, 600 s audit, ~1 % of the events reach the script);
 *  - `all`: plain + dense + realistic.
 * With any value but `off` every yard run also reports `startupMs` (runner start
 * incl. the per-run script rebuild, yard bind, runtime start) and `runMs` =
 * startupMs + wallMs; script runs report `scriptInvocations` (sink callbacks +
 * audit dispatches) and `scriptAttachMs`. The report's `comparisons` put each
 * script scenario next to the plain one of the same size: `runMsRatio`,
 * `startupDeltaMs` and `usPerInvocation` = (runMs_script - runMs_plain) /
 * invocations (medians) - the Phase-4b budget (<= 50 us, ratio <= 1.10
 * realistic / <= 1.20 dense, startup delta <= 10 ms).
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './lib/rv-machine-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const METRICS = ['wallMs', 'simSeconds', 'totalEventsProcessed', 'eventsPerSecond', 'simHoursPerWallHour',
  'componentCount', 'muCount', 'liveMuCount', 'vehicles', 'stations', 'heapPeakBytes', 'heapSamples',
  'snapshotMs', 'snapshotBytes', 'restoreMs'];

export function summarise(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error('Expected nonempty finite numbers');
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] / 2 + sorted[mid] / 2), min: sorted[0], max: sorted.at(-1) };
}

export function buildReport(machine, runs, { createdAt = new Date().toISOString(), smoke = false, failures = [] } = {}) {
  for (const key of ['hostname', 'os', 'cpuModel', 'nodeVersion']) {
    if (typeof machine[key] !== 'string' || !machine[key]) throw new Error(`Missing machine.${key}`);
  }
  for (const key of ['cpuCount', 'totalMemoryBytes']) {
    if (!Number.isFinite(machine[key]) || machine[key] <= 0) throw new Error(`Invalid machine.${key}`);
  }
  for (const key of ['webViewerCommit', 'privateCommit']) {
    if (machine[key] !== null && (typeof machine[key] !== 'string' || !machine[key])) throw new Error(`Invalid machine.${key}`);
  }
  const groups = new Map();
  for (const run of runs) {
    if (!run.scenario || !run.sources || !Number.isFinite(run.size) || !Number.isFinite(run.requestedSimSeconds)) throw new Error('Invalid run identity');
    const restoreUnsupported = run.restore?.supported === false;
    if (run.restore !== undefined && (!restoreUnsupported || run.restore.reason !== 'agv-snapshot-restore-unsupported (plan-558)')) throw new Error('Invalid restore status');
    if (restoreUnsupported && run.metrics?.restoreMs !== undefined) throw new Error('Unsupported restore must not have a duration');
    for (const key of METRICS) {
      if (key === 'restoreMs' && restoreUnsupported) continue;
      if ((key === 'snapshotMs' || key === 'snapshotBytes') && run.snapshot?.supported === false) continue;
      if (!Number.isFinite(run.metrics?.[key])) throw new Error(`Missing/invalid metric ${key}`);
    }
    for (const [key, value] of Object.entries(run.metrics)) if (!Number.isFinite(value)) throw new Error(`Non-finite metric ${key}`);
    const group = groups.get(run.scenario) ?? [];
    group.push(run); groups.set(run.scenario, group);
  }
  const scenarios = [...groups].map(([scenario, samples]) => {
    const first = samples[0];
    if (samples.some(run => run.kind !== first.kind || run.requestedSimSeconds !== first.requestedSimSeconds || run.size !== first.size)) throw new Error(`Inconsistent runs: ${scenario}`);
    if (samples.some(run => run.restore?.supported !== first.restore?.supported)) throw new Error(`Inconsistent restore support: ${scenario}`);
    const keys = [...new Set(samples.flatMap(run => Object.keys(run.metrics)))];
    const metrics = Object.fromEntries(keys.map(key => {
      const values = samples.filter(run => key in run.metrics).map(run => run.metrics[key]);
      return [key, { ...summarise(values), samples: values.length }];
    }));
    return { scenario, kind: first.kind, size: first.size, requestedSimSeconds: first.requestedSimSeconds, repeats: samples.length, metrics,
      ...(first.restore ? { restore: first.restore } : {}), ...(first.snapshot ? { snapshot: first.snapshot } : {}), runs: samples };
  });
  const comparisons = compareScriptScenarios(scenarios);
  return { schemaVersion: 1, createdAt, smoke, status: failures.length ? 'failed' : 'ok', machine, scenarios,
    ...(comparisons.length ? { comparisons } : {}), failures };
}

/** Script variants and their scenario label prefix (plan-2212 Phase 4/4b). */
export const SCRIPT_VARIANTS = { dense: 'yard+script', realistic: 'yard+script-realistic' };

/**
 * plan-2212 Phase 4b: each with-script scenario next to the plain yard of the
 * same size (medians; only when both carry `runMs`): run-time ratio, startup
 * delta and the cost of one script invocation in microseconds.
 */
export function compareScriptScenarios(scenarios) {
  const out = [];
  for (const [variant, prefix] of Object.entries(SCRIPT_VARIANTS)) {
    for (const s of scenarios.filter(x => x.scenario.startsWith(`${prefix}:`))) {
      const plain = scenarios.find(x => x.scenario === `yard:${s.size}`);
      const m = s.metrics, p = plain?.metrics;
      if (!p?.runMs || !m.runMs || !m.scriptInvocations) continue;
      const delta = m.runMs.median - p.runMs.median;
      out.push({ variant, size: s.size, scenario: s.scenario, plain: plain.scenario,
        runMsRatio: m.runMs.median / p.runMs.median,
        startupDeltaMs: (m.startupMs?.median ?? 0) - (p.startupMs?.median ?? 0),
        invocations: m.scriptInvocations.median,
        usPerInvocation: delta * 1000 / m.scriptInvocations.median,
        eventsPerInvocation: m.totalEventsProcessed.median / m.scriptInvocations.median });
    }
  }
  return out;
}

export function machineMetadata(root = ROOT) {
  const commit = cwd => {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    return !result.error && result.status === 0 ? result.stdout.trim() : null;
  };
  const privateRoot = ['../realvirtual-WebViewer-Private~', '../realvirtual-web-pro'].map(p => path.resolve(root, p)).find(p => existsSync(p));
  const cpus = os.cpus();
  return {
    hostname: os.hostname(), os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpuModel: cpus[0]?.model ?? 'unknown', cpuCount: cpus.length, totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version, webViewerCommit: commit(root), privateCommit: privateRoot ? commit(privateRoot) : null,
  };
}

export function parseOptions(argv) {
  const options = { sizes: [1, 2, 4, 8], repeats: 3, simSec: 28800, outDir: path.join(tmpDir(), 'perf-des'), smoke: false, script: 'off' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--smoke') { options.smoke = true; continue; }
    if (!['--sizes', '--repeats', '--sim-sec', '--out-dir', '--script'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--sizes') options.sizes = value.split(',').map(Number);
    if (flag === '--repeats') options.repeats = Number(value);
    if (flag === '--sim-sec') options.simSec = Number(value);
    if (flag === '--out-dir') options.outDir = path.resolve(value);
    if (flag === '--script') options.script = value;
  }
  if (!['off', 'on', 'both', 'realistic', 'all'].includes(options.script)) throw new Error('--script expects off, on, both, realistic or all');
  if (options.sizes.some(n => !Number.isInteger(n) || n < 1 || n > 16)) throw new Error('--sizes expects integers 1..16');
  if (!Number.isInteger(options.repeats) || options.repeats < 1) throw new Error('--repeats expects a positive integer');
  if (!Number.isFinite(options.simSec) || options.simSec <= 0) throw new Error('--sim-sec expects a positive number');
  options.sizes = [...new Set(options.sizes)];
  if (options.smoke) Object.assign(options, { sizes: [1], repeats: 1, simSec: 600 });
  return options;
}

/** The yard variants one `--script` value measures per repeat ('' = plain). */
export function yardVariants(script) {
  return { off: [''], on: ['dense'], both: ['', 'dense'], realistic: ['', 'realistic'], all: ['', 'dense', 'realistic'] }[script];
}

export function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  mkdirSync(options.outDir, { recursive: true });
  const runDir = mkdtempSync(path.join(options.outDir, 'runs-'));
  const machine = machineMetadata(), runs = [], failures = [];
  const child = (args, env = {}) => {
    const result = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `Child exited ${result.status} (signal ${result.signal ?? 'none'})`);
  };
  const measure = (scenario, size, repeat, glb = '', script = '') => {
    const label = script ? SCRIPT_VARIANTS[script] : scenario;
    const out = path.join(runDir, `${label}-${size}-${repeat}.json`);
    try {
      child([path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.perf-des.config.ts', 'tests/des/perf-des-run.perf.test.ts'], {
        RV_PERF_DES_GLB: glb, RV_PERF_DES_OUT: out, RV_PERF_DES_SCENARIO: scenario, RV_PERF_DES_SIM_SEC: String(options.simSec),
        RV_PERF_DES_SCRIPT: script, RV_PERF_DES_TIMING: options.script !== 'off' ? '1' : '',
      });
      const run = JSON.parse(readFileSync(out, 'utf8'));
      if (run.scenario !== (scenario === 'yard' ? `${label}:${size}` : 'warehouse-synthetic')) throw new Error('Unexpected scenario result');
      buildReport(machine, [run]); // Reject malformed output before aggregation.
      runs.push(run);
    } catch (error) { failures.push({ scenario, size, repeat, error: String(error) }); }
  };
  for (const size of options.sizes) {
    const dir = path.join(runDir, `yard-${size}`);
    mkdirSync(dir);
    const glb = path.join(dir, 'PalletYard.glb'), manifest = path.join(dir, 'project.json');
    writeFileSync(manifest, '{"documents":[]}\n');
    try { child(['tools/des-examples/pallet-yard.mjs', '--size', String(size), glb, manifest]); }
    catch (error) { failures.push({ scenario: 'yard', size, error: String(error) }); continue; }
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      for (const variant of yardVariants(options.script)) measure('yard', size, repeat, glb, variant);
    }
  }
  for (let repeat = 1; repeat <= options.repeats; repeat++) measure('warehouse', 0, repeat);
  const report = buildReport(machine, runs, { smoke: options.smoke, failures });
  const file = path.join(options.outDir, `${report.createdAt.slice(0, 10)}-${machine.hostname}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.table(report.scenarios.map(s => ({ scenario: s.scenario, runs: s.repeats,
    'events/s': Math.round(s.metrics.eventsPerSecond.median), 'sim-h/wall-h': Math.round(s.metrics.simHoursPerWallHour.median),
    'heap MiB': +(s.metrics.heapPeakBytes.median / 1048576).toFixed(1), 'snapshot ms': s.snapshot?.supported === false ? 'n/a' : +s.metrics.snapshotMs.median.toFixed(2),
    'restore ms': s.restore?.supported === false ? 'n/a' : +s.metrics.restoreMs.median.toFixed(2),
  })));
  if (report.comparisons) console.table(report.comparisons.map(c => ({ scenario: c.scenario, 'runMs ratio': +c.runMsRatio.toFixed(3),
    'startup Δ ms': +c.startupDeltaMs.toFixed(1), invocations: c.invocations, 'µs/invocation': +c.usPerInvocation.toFixed(1),
    'events/invocation': +c.eventsPerInvocation.toFixed(1) })));
  console.log(`Report: ${file}`);
  if (failures.length) { console.error(failures); process.exitCode = 1; }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
