// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `npm run perf:first-frame -- <url> [n=5] [--label <prefix>] [--target-ms 3000]
 *                              [--max-longtask-ms 500] [--repeat [k]] [--report-only]`
 *
 * n cold runs (a fresh browser each, one after the other), then the median
 * table and the plan-598 verdict:
 *   - an invalid or aborted run fails the series — it is NOT filtered out;
 *   - every valid run must stay free of long tasks > max-longtask-ms before
 *     the endpoint;
 *   - the median of the endpoint ("Bild sichtbar") must be ≤ target-ms.
 * `--repeat [k]` additionally runs repeat.cjs (first visit + k repeats with a
 * persistent profile, target 2.0 s). `--report-only` prints everything but
 * always exits 0 (baselines before the plan's goal is reached).
 *
 * Exit code: 0 pass, 1 acceptance violation, 2 invalid/aborted run.
 * Results: scripts/perf/first-frame/runs/ (git-ignored; OUT_DIR overrides).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEFAULT_TARGET_MS, DEFAULT_MAX_LONGTASK_MS, ensureOutDir, median, seriesVerdict,
} = require('./lib.cjs');

function parseArgs(argv) {
  const o = { url: null, n: 5, label: null, targetMs: DEFAULT_TARGET_MS, maxLongTaskMs: DEFAULT_MAX_LONGTASK_MS, repeat: 0, reportOnly: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') o.label = argv[++i];
    else if (a === '--target-ms') o.targetMs = Number(argv[++i]);
    else if (a === '--max-longtask-ms') o.maxLongTaskMs = Number(argv[++i]);
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '--repeat') { const k = Number(argv[i + 1]); if (Number.isFinite(k) && !String(argv[i + 1]).startsWith('--')) { o.repeat = k; i++; } else o.repeat = 2; }
    else pos.push(a);
  }
  o.url = pos[0] ?? null;
  if (pos[1] !== undefined) o.n = Number(pos[1]);
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.url || !(opts.n > 0)) {
  console.error('usage: npm run perf:first-frame -- <url> [n=5] [--label p] [--target-ms 3000] [--max-longtask-ms 500] [--repeat [k]] [--report-only]');
  process.exit(64);
}
const outDir = ensureOutDir();
const prefix = opts.label || `ff-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const phaseMs = (r, name) => {
  for (const t of r.tables || []) for (const a of t.args || []) {
    if (Array.isArray(a)) { const x = a.find((o) => o && o.phase === name); if (x) return Math.round(x.ms); }
  }
  return null;
};

const rows = [];
for (let i = 1; i <= opts.n; i++) {
  const label = `${prefix}-${i}`;
  const res = spawnSync(process.execPath, [path.join(__dirname, 'measure.cjs'), opts.url, label, 'none', '1'], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 240000,
  });
  process.stdout.write(res.stdout || '');
  let r = null;
  try { r = JSON.parse(fs.readFileSync(path.join(outDir, `${label}.json`), 'utf8')); } catch { /* no result */ }
  if (!r) {
    rows.push({ run: i, valid: false, invalidReason: `no result file (exit ${res.status}${res.error ? ', ' + res.error.message : ''})` });
    continue;
  }
  rows.push({
    run: i,
    valid: r.valid,
    invalidReason: r.invalidReason,
    endpointAt: r.endpointAt,
    endpointKind: r.endpointKind,
    modelLoadedAt: r.modelLoadedAt,
    glbStart: r.glbStart,
    glbEnd: r.glbEnd,
    compileAsync: phaseMs(r, 'compileAsync'),
    bake: phaseMs(r, 'bake'),
    programs: r.programs,
    renderCalls: r.renderCalls,
    longTaskSum: r.longTaskSum,
    maxLongTask: r.maxLongTask,
    manifestRequests: (r.manifestRequests || []).length,
    gpu: r.gpu,
    buildHash: r.buildHash,
  });
}

console.table(rows.map(({ gpu, buildHash, invalidReason, ...rest }) => rest));
const gpus = [...new Set(rows.map((r) => r.gpu).filter(Boolean))];
const builds = [...new Set(rows.map((r) => r.buildHash).filter(Boolean))];
console.log('GPU  ', gpus.join(' | ') || '(unknown)');
console.log('BUILD', builds.join(' | ') || '(unknown)');
if (builds.includes('dev')) {
  console.log('  ! build hash "dev": this is an UNBUNDLED dev server, not a production build — not comparable to a deploy');
}
const valid = rows.filter((r) => r.valid);
const med = (k) => median(valid.map((r) => r[k]));
const summary = {
  url: opts.url, runs: rows.length, valid: valid.length,
  bildSichtbar: med('endpointAt'), modelLoaded: med('modelLoadedAt'), glbStart: med('glbStart'), glbEnd: med('glbEnd'),
  compileAsync: med('compileAsync'), programs: med('programs'), longTaskSum: med('longTaskSum'), groessterTask: med('maxLongTask'),
};
console.log('MEDIAN', JSON.stringify(summary));
const verdict = seriesVerdict(rows, { targetMs: opts.targetMs, maxLongTaskMs: opts.maxLongTaskMs });
fs.writeFileSync(path.join(outDir, `${prefix}-series.json`), JSON.stringify({ opts, rows, summary, verdict, gpus, builds }, null, 1));
for (const reason of verdict.reasons) console.log('  ✗', reason);
console.log(verdict.ok ? 'COLD SERIES: PASS' : `COLD SERIES: FAIL (exit ${verdict.exitCode})`);

let exitCode = verdict.exitCode;
if (opts.repeat > 0) {
  const rep = spawnSync(process.execPath, [path.join(__dirname, 'repeat.cjs'), opts.url, String(opts.repeat), `${prefix}-repeat`], {
    stdio: 'inherit', timeout: 900000,
  });
  const repExit = rep.status ?? 2;
  exitCode = Math.max(exitCode, repExit);
}
process.exit(opts.reportOnly ? 0 : exitCode);
