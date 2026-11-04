// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Stress harness — pure part: findings, trend analysis, report rendering,
 * argument parsing and scenario validation. No browser, no processes, no I/O,
 * so `node scripts/stress/rv-stress-run.mjs --self-test` can check all of it.
 *
 * The goal of a stress run is to FIND PROBLEMS (hangs, leaks, wrong results,
 * crashes, slow UI) under sustained load. Everything here turns raw samples into
 * findings a developer can act on: severity, numbers, repro, product-vs-harness.
 */

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
export const CLASSIFICATIONS = Object.freeze(['product', 'harness', 'unclear']);

//! Default thresholds. A scenario may override any of them (`scenario.thresholds`),
//! the CLI may override the renderer cap (`--max-renderer-gb`).
export const DEFAULT_THRESHOLDS = Object.freeze({
  /** Abort the run when the machine's free commit drops below this (GB). */
  minFreeCommitGB: 6,
  /** Refuse to start below this free commit (GB). */
  preflightFreeCommitGB: 8,
  /** Abort when our renderer's private bytes exceed this (GB) — itself a critical finding. */
  maxRendererGB: 4,
  /** Renderer private-bytes growth that counts as a leak (MB/min, sustained). */
  rendererLeakMBPerMin: 20,
  /** JS heap (after gc) growth that counts as a leak (MB/min). */
  heapLeakMBPerMin: 5,
  /** Embedder (Blink/DOM/IDB) heap growth that counts as a leak (MB/min). */
  embedderLeakMBPerMin: 5,
  /** DOM node growth per minute that counts as a leak. */
  domNodesPerMin: 200,
  /** A trend needs at least this many minutes of samples to be judged. */
  minTrendMinutes: 3,
  /** ... and at least this linear fit quality (R²) to call it sustained. */
  minTrendR2: 0.6,
  /** Command/rAF round-trip that counts as a UI stall (ms). */
  rttStallMs: 1000,
  /** p95 round-trip above this is a "slow UI" finding (ms). */
  rttP95Ms: 250,
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * Creates a findings collector. Identical findings (same severity + title +
 * dedupKey) are merged and counted instead of repeated.
 */
export function createFindings() {
  const list = [];
  const index = new Map();
  return {
    list,
    /**
     * @param {object} f
     * @param {'critical'|'high'|'medium'|'low'} f.severity
     * @param {string} f.title one line, what is wrong
     * @param {string} [f.evidence] numbers / excerpt proving it
     * @param {string[]} [f.repro] numbered steps that reproduce it
     * @param {'product'|'harness'|'unclear'} [f.classification]
     * @param {string} [f.suspect] suspected file:line or module
     * @param {string} [f.dedupKey]
     * @param {object} [f.numbers] machine-readable measurements
     */
    add(f) {
      if (!SEVERITIES.includes(f.severity)) throw new Error(`unknown severity '${f.severity}'`);
      const classification = f.classification ?? 'unclear';
      if (!CLASSIFICATIONS.includes(classification)) throw new Error(`unknown classification '${classification}'`);
      const key = `${f.severity}|${f.title}|${f.dedupKey ?? ''}`;
      const prev = index.get(key);
      if (prev) { prev.count += 1; return prev; }
      const entry = {
        severity: f.severity,
        title: f.title,
        evidence: f.evidence ?? '',
        repro: f.repro ?? [],
        classification,
        suspect: f.suspect ?? '',
        numbers: f.numbers ?? null,
        at: f.at ?? new Date().toISOString(),
        count: 1,
      };
      index.set(key, entry);
      list.push(entry);
      return entry;
    },
    sorted() {
      return [...list].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
    },
    counts() {
      const c = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const f of list) c[f.severity] += 1;
      return c;
    },
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Percentile (0..100) of a numeric array, nearest-rank. `null` for an empty array. */
export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[rank];
}

/**
 * Least-squares line through `points` ({tMs, v}). Returns the slope per minute,
 * the fit quality R², the sample count and the time span in minutes.
 */
export function linearTrend(points) {
  const pts = points.filter(p => Number.isFinite(p.tMs) && Number.isFinite(p.v));
  const n = pts.length;
  if (n < 2) return { slopePerMin: 0, r2: 0, n, spanMin: 0, first: pts[0]?.v ?? null, last: pts[n - 1]?.v ?? null };
  const xs = pts.map(p => p.tMs / 60000);
  const ys = pts.map(p => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slopePerMin: slope, r2, n, spanMin: xs[n - 1] - xs[0], first: ys[0], last: ys[n - 1] };
}

// ---------------------------------------------------------------------------
// Sample analysis — the generic leak / stall detectors
// ---------------------------------------------------------------------------

//! Metric descriptors for the generic trend checks. `get` reads a sample row
//! (see rv-stress-core `takeSample`), `toMB` converts to the threshold unit.
const TREND_METRICS = [
  { key: 'rendererGB', label: 'renderer private bytes', unit: 'MB/min', toUnit: v => v * 1024, threshold: 'rendererLeakMBPerMin' },
  { key: 'heapMB', label: 'JS heap after gc', unit: 'MB/min', toUnit: v => v, threshold: 'heapLeakMBPerMin' },
  { key: 'embedderMB', label: 'embedder heap (DOM/Blink/IDB)', unit: 'MB/min', toUnit: v => v, threshold: 'embedderLeakMBPerMin' },
  { key: 'domNodes', label: 'DOM nodes', unit: 'nodes/min', toUnit: v => v, threshold: 'domNodesPerMin' },
];

/**
 * Turns the continuous samples of a run into generic findings: sustained memory
 * growth, UI stalls and slow round-trips. Samples tagged `phase` are analysed
 * per phase as well as over the whole run, because a leak that only exists while
 * a window is open (tonight's DES case) is diluted over a long mixed run.
 *
 * @param {Array<object>} samples rows with tMs and the metric keys above + rttMs
 * @param {object} [thresholds]
 * @returns {Array<object>} finding descriptors for `findings.add`
 */
export function analyzeSamples(samples, thresholds = DEFAULT_THRESHOLDS) {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const out = [];
  const groups = new Map([['whole run', samples]]);
  for (const s of samples) {
    if (!s.phase) continue;
    if (!groups.has(`phase ${s.phase}`)) groups.set(`phase ${s.phase}`, []);
    groups.get(`phase ${s.phase}`).push(s);
  }
  for (const [scope, rows] of groups) {
    for (const m of TREND_METRICS) {
      const tr = linearTrend(rows.map(r => ({ tMs: r.tMs, v: r[m.key] })));
      if (tr.n < 4 || tr.spanMin < th.minTrendMinutes) continue;
      const slope = m.toUnit(tr.slopePerMin);
      const limit = th[m.threshold];
      if (slope > limit && tr.r2 >= th.minTrendR2) {
        const severity = slope > limit * 5 ? 'critical' : 'high';
        out.push({
          severity,
          title: `sustained ${m.label} growth (${scope})`,
          evidence: `${slope.toFixed(1)} ${m.unit} over ${tr.spanMin.toFixed(1)} min, R²=${tr.r2.toFixed(2)}, ${fmt(m.toUnit(tr.first))} → ${fmt(m.toUnit(tr.last))}`,
          classification: 'product',
          dedupKey: `${m.key}|${scope}`,
          numbers: { metric: m.key, scope, slope, unit: m.unit, r2: tr.r2, spanMin: tr.spanMin, n: tr.n, limit },
        });
      }
    }
  }
  const rtts = samples.map(s => s.rttMs).filter(Number.isFinite);
  if (rtts.length) {
    const max = Math.max(...rtts);
    const p95 = percentile(rtts, 95);
    if (max >= th.rttStallMs) {
      const worst = samples.find(s => s.rttMs === max);
      out.push({
        severity: max >= th.rttStallMs * 10 ? 'high' : 'medium',
        title: 'UI stall (frame/command round-trip)',
        evidence: `max ${max} ms (p95 ${p95} ms, n=${rtts.length})${worst?.phase ? `, worst in phase ${worst.phase}` : ''}`,
        classification: 'product',
        numbers: { maxMs: max, p95Ms: p95, n: rtts.length },
      });
    } else if (p95 > th.rttP95Ms) {
      out.push({
        severity: 'low',
        title: 'slow UI round-trip',
        evidence: `p95 ${p95} ms (max ${max} ms, n=${rtts.length})`,
        classification: 'product',
        numbers: { maxMs: max, p95Ms: p95, n: rtts.length },
      });
    }
  }
  return out;
}

function fmt(v) {
  return Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) : 'n/a';
}

// ---------------------------------------------------------------------------
// Console errors
// ---------------------------------------------------------------------------

//! Console noise that comes from the dev harness, not the product: the Vite
//! optimizer re-bundling deps mid-run invalidates dynamic imports, and an HMR
//! socket drop is the dev server, not the app. Listed so they are reported as
//! `harness`, never silently dropped.
const HARNESS_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module: .*\/node_modules\/\.vite\/deps\//,
  /\[vite\] (server connection lost|failed to connect to websocket)/i,
  /Outdated Optimize Dep/i,
];

/** Classifies one console/page error line. */
export function classifyConsoleError(text) {
  return HARNESS_ERROR_PATTERNS.some(re => re.test(text)) ? 'harness' : 'product';
}

/**
 * Groups raw error lines (`{kind:'console'|'pageerror'|'crash', text}`) into
 * findings: one per distinct message (digits normalised), with a count.
 */
export function consoleFindings(errors) {
  const groups = new Map();
  for (const e of errors) {
    const norm = e.text.replace(/\d+/g, '#').replace(/\?v=[0-9a-f]+/g, '').slice(0, 200);
    const key = `${e.kind}|${norm}`;
    const g = groups.get(key) ?? { kind: e.kind, sample: e.text, count: 0, firstAt: e.at ?? null };
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    const classification = g.kind === 'crash' ? 'product' : classifyConsoleError(g.sample);
    const severity = g.kind === 'crash' ? 'critical' : g.kind === 'pageerror' ? 'high' : classification === 'harness' ? 'low' : 'medium';
    return {
      severity,
      title: g.kind === 'crash' ? 'renderer crashed' : `${g.kind === 'pageerror' ? 'uncaught exception' : 'console error'}: ${g.sample.slice(0, 90)}`,
      evidence: `${g.count}× — ${g.sample.slice(0, 400)}`,
      classification,
      dedupKey: g.sample.slice(0, 200),
      numbers: { count: g.count, firstAt: g.firstAt },
    };
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Renders the markdown findings report. `report` is the object written to report.json. */
export function renderMarkdown(report) {
  const L = [];
  const c = report.counts ?? { critical: 0, high: 0, medium: 0, low: 0 };
  L.push(`# Stress report — ${report.scenario.id}`);
  L.push('');
  L.push(`- **Started:** ${report.startedAt} · **Ended:** ${report.endedAt} · **Wall:** ${(report.wallMs / 60000).toFixed(1)} min`);
  L.push(`- **Outcome:** ${report.outcome}${report.stopReason ? ` — ${report.stopReason}` : ''}`);
  L.push(`- **Target:** ${report.target.url}`);
  if (report.target.commit) L.push(`- **Commit:** ${report.target.commit}`);
  L.push(`- **Options:** \`${JSON.stringify(report.options)}\``);
  L.push(`- **Findings:** ${c.critical} critical · ${c.high} high · ${c.medium} medium · ${c.low} low`);
  L.push('');
  if (report.summary?.memory) {
    const m = report.summary.memory;
    L.push('## Measurements');
    L.push('');
    L.push('| Metric | Start | Peak | End | Trend |');
    L.push('|---|---|---|---|---|');
    for (const row of m) L.push(`| ${row.label} | ${row.start} | ${row.peak} | ${row.end} | ${row.trend} |`);
    L.push('');
    if (report.summary.rtt) L.push(`Round-trip (rAF via page.evaluate): p50 ${report.summary.rtt.p50} ms · p95 ${report.summary.rtt.p95} ms · max ${report.summary.rtt.max} ms · n=${report.summary.rtt.n}`);
    L.push('');
  }
  if (report.metrics && Object.keys(report.metrics).length) {
    L.push('## Scenario metrics');
    L.push('');
    for (const [k, v] of Object.entries(report.metrics)) L.push(`- **${k}:** ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    L.push('');
  }
  L.push('## Findings');
  L.push('');
  if (!report.findings.length) L.push('_No findings._');
  report.findings.forEach((f, i) => {
    L.push(`### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}${f.count > 1 ? ` (×${f.count})` : ''}`);
    L.push('');
    L.push(`- **Classification:** ${f.classification}`);
    if (f.evidence) L.push(`- **Evidence:** ${f.evidence}`);
    if (f.suspect) L.push(`- **Suspect:** \`${f.suspect}\``);
    if (f.repro?.length) {
      L.push('- **Repro:**');
      f.repro.forEach((s, j) => L.push(`  ${j + 1}. ${s}`));
    }
    L.push('');
  });
  if (report.checks?.length) {
    L.push('## Checks');
    L.push('');
    L.push('| Check | Result | Detail |');
    L.push('|---|---|---|');
    for (const ch of report.checks) L.push(`| ${ch.name} | ${ch.ok ? 'pass' : 'FAIL'} | ${String(ch.detail ?? '').replace(/\|/g, '/').slice(0, 160)} |`);
    L.push('');
  }
  L.push('## Files');
  L.push('');
  L.push('- `report.json` — this report, machine-readable');
  L.push('- `samples.jsonl` — one memory/responsiveness sample per line');
  L.push('- `run.log` — harness log');
  return L.join('\n') + '\n';
}

/** Builds the start/peak/end/trend table rows for the report. */
export function summarizeSamples(samples) {
  const rows = [];
  const defs = [
    { key: 'rendererGB', label: 'Renderer private (GB)', d: 2, slope: v => `${(v * 1024).toFixed(1)} MB/min` },
    { key: 'gpuGB', label: 'GPU process private (GB)', d: 2, slope: v => `${(v * 1024).toFixed(1)} MB/min` },
    { key: 'heapMB', label: 'JS heap after gc (MB)', d: 1, slope: v => `${v.toFixed(2)} MB/min` },
    { key: 'embedderMB', label: 'Embedder heap (MB)', d: 1, slope: v => `${v.toFixed(2)} MB/min` },
    { key: 'domNodes', label: 'DOM nodes', d: 0, slope: v => `${v.toFixed(0)}/min` },
    { key: 'listeners', label: 'JS event listeners', d: 0, slope: v => `${v.toFixed(0)}/min` },
    { key: 'freeCommitGB', label: 'Machine free commit (GB)', d: 1, slope: v => `${(v * 1024).toFixed(0)} MB/min` },
  ];
  for (const def of defs) {
    const vals = samples.map(s => s[def.key]).filter(Number.isFinite);
    if (!vals.length) continue;
    const tr = linearTrend(samples.map(s => ({ tMs: s.tMs, v: s[def.key] })));
    const peak = def.key === 'freeCommitGB' ? Math.min(...vals) : Math.max(...vals);
    rows.push({
      label: def.label,
      start: vals[0].toFixed(def.d),
      peak: peak.toFixed(def.d) + (def.key === 'freeCommitGB' ? ' (min)' : ''),
      end: vals[vals.length - 1].toFixed(def.d),
      trend: tr.n >= 2 ? `${def.slope(tr.slopePerMin)} (R² ${tr.r2.toFixed(2)})` : 'n/a',
    });
  }
  const rtts = samples.map(s => s.rttMs).filter(Number.isFinite);
  const rtt = rtts.length ? { p50: percentile(rtts, 50), p95: percentile(rtts, 95), max: Math.max(...rtts), n: rtts.length } : null;
  return { memory: rows, rtt };
}

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

/**
 * Parses a duration: `90` (minutes), `90s`, `15m`, `2h`. Returns milliseconds.
 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(String(text).trim());
  if (!m) throw new Error(`bad duration '${text}' (use 90s, 15m, 2h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'm';
  return Math.round(n * (unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000));
}

/**
 * Parses `rv-stress-run.mjs` arguments. Unknown `--key value` pairs are kept
 * in `scenarioArgs` so a scenario can define its own options (`--batches 2`).
 */
export function parseArgs(argv) {
  const opts = {
    scenario: null, list: false, selfTest: false, base: null, serve: false, port: null,
    durationMs: null, report: null, headed: false, maxRendererGB: null, minFreeGB: null, sampleSec: 15,
    scenarioDirs: [], scenarioArgs: {}, dryRun: false, community: false, warmup: null,
  };
  const known = new Set(['--base', '--port', '--duration', '--report', '--max-renderer-gb', '--min-free-gb', '--sample-sec', '--scenarios']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--serve') opts.serve = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--community') opts.community = true;
    else if (a === '--warmup') opts.warmup = true;
    else if (a === '--no-warmup') opts.warmup = false;
    else if (known.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === '--base') opts.base = v.replace(/\/$/, '');
      else if (a === '--port') opts.port = Number(v);
      else if (a === '--duration') opts.durationMs = parseDuration(v);
      else if (a === '--report') opts.report = v;
      else if (a === '--max-renderer-gb') opts.maxRendererGB = Number(v);
      else if (a === '--min-free-gb') opts.minFreeGB = Number(v);
      else if (a === '--sample-sec') opts.sampleSec = Number(v);
      else if (a === '--scenarios') opts.scenarioDirs.push(v);
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts.scenarioArgs[key] = next; i++; } else opts.scenarioArgs[key] = true;
    } else if (!opts.scenario) opts.scenario = a;
    else throw new Error(`unexpected argument '${a}'`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Scenario contract
// ---------------------------------------------------------------------------

/**
 * Checks a scenario module's `scenario` export against the common shape.
 * Returns a list of problems (empty = valid).
 */
export function validateScenario(s) {
  const p = [];
  if (!s || typeof s !== 'object') return ['module has no `scenario` export'];
  if (typeof s.id !== 'string' || !/^[a-z0-9-]+$/.test(s.id)) p.push('id must be kebab-case');
  if (typeof s.description !== 'string' || s.description.length < 10) p.push('description missing');
  if (!['ready', 'stub'].includes(s.status)) p.push("status must be 'ready' or 'stub'");
  if (!s.requires || typeof s.requires !== 'object') p.push('requires missing');
  else {
    if (!['any', 'community', 'commercial'].includes(s.requires.build)) p.push("requires.build must be 'any' | 'community' | 'commercial'");
    if (!s.requires.url || typeof s.requires.url !== 'object') p.push('requires.url (query params) missing');
  }
  if (!Array.isArray(s.checks)) p.push('checks must list the invariants the scenario asserts');
  if (s.status === 'ready') {
    if (typeof s.run !== 'function') p.push('ready scenario needs run(ctx)');
  } else if (!Array.isArray(s.todo) || !s.todo.length) {
    p.push('stub scenario needs a todo checklist');
  }
  for (const fn of ['setup', 'teardown', 'ready']) if (s[fn] !== undefined && typeof s[fn] !== 'function') p.push(`${fn} must be a function`);
  return p;
}
