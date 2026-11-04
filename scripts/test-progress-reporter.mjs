// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Test progress reporter (plan-606 follow-up, 2026-10-16) — registered in BOTH vitest
 * configs through `testLockProgressPlugin()`.
 *
 * 1. Startup progress for the test lock wrapper (`scripts/with-test-lock.mjs`): when the
 *    wrapper that holds the lock passes `RV_TEST_LOCK_PROGRESS_FILE`, this reporter appends
 *    one JSON line per event — `run-start` (onTestRunStart), `module-start` (the first
 *    onTestModuleStart), `first-test` (onTestCaseReady) and `run-end` (onTestRunEnd) — each AT
 *    MOST ONCE per vitest process, written synchronously (`appendFileSync`). The wrapper's
 *    startup limit runs in the wrapper process, so a blocked vitest event loop cannot stop it;
 *    the records only tell it that the run got going. `module-start` is what closes the
 *    wrapper's startup window (plan-617): it comes from the worker's `suite-prepare` of a file
 *    (or `suite-failed-early` on an import error) and arrived on time in every measurement,
 *    while `first-test` (`test-prepare`) rides the runner's 100 ms update throttle and reaches
 *    the main process only after a synchronous first test or a long `beforeAll` has finished
 *    (measured 2026-10-17). `first-test` stays the measurement point and the strict-deps
 *    boundary. Every file start/end and final test result also writes a heartbeat, including
 *    watch reruns; only the first run is limited. Per FILE (plan-900) there are two further
 *    records, both carrying `spec` (the path relative to the vitest root, `/`-normalised):
 *    `file-start` from `onTestModuleQueued` — which fires BEFORE the setup files and before the
 *    module import, the only point at which a file hanging in its own import can still be named
 *    — and `file-end` from `onTestModuleEnd`. They feed the wrapper's per-file limit (exit 126);
 *    the once-per-process records above are untouched by them. At the first test
 *    file and at the first test it prints ONE stderr measurement line each —
 *    `[test-progress] first test file started after 3.1 s (run start <iso>, config <file>)` and
 *    `[test-progress] first test after 12.4 s (…) / 41.0 s since wrapper start` (the last part
 *    when the wrapper set `RV_TEST_WRAPPER_SPAWN_MS`) — the data for revisiting the startup
 *    limit's default.
 * 2. One skip line at the end of every run (stderr, so `--reporter=json` on stdout stays
 *    clean): `[test-skips] 111 skipped: 103 <note|file>, 8 <note|file>, … (+N more)`.
 *    Grouped by the `ctx.skip(note)` note when there is one, else as `file failed in setup: <file>`
 *    when a `beforeAll` of the file threw (vitest then skips the tests AND fails the file), else
 *    as `no reason given: <file>`; top 5
 *    groups. A run without skips prints `[test-skips] 0 skipped` — absence would be ambiguous
 *    for a gate (2026-10-16).
 * 3. Strict optimizeDeps (2026-10-16): a dependency Vite's optimizer discovers AFTER the run's
 *    first test re-optimizes mid-run and usually reloads the page ("Vite unexpectedly reloaded
 *    a test") — the run is unusable but still reports green. `configureServer` wraps, on every
 *    environment whose deps optimizer does discovery (the browser server's `client`),
 *    `depsOptimizer.registerMissingImport` (a NEW id = a discovery, named) and that
 *    environment's `hot.send` (a `full-reload` while discoveries are pending = the optimizer's
 *    reload) — structured hooks, no log parsing; see `watchDepsOptimizer`. The boundary is the
 *    FIRST TEST of the process: a discovery before it (cold cache, "Re-optimizing dependencies
 *    because vite config has changed", the first file's crawl) is legitimate and never counts.
 *    A hit prints `[test-deps] undeclared dependency discovered mid-run: <dep> — add it to
 *    optimizeDeps.include in vite.config.ts (the reload made this run unusable)` (at the reload;
 *    a discovery that re-optimized without a reload is named at run end), and every run ends
 *    with `[test-deps] 0 mid-run re-optimizations` or `[test-deps] N mid-run re-optimizations:
 *    <dep> (reloaded), …`. `RV_TEST_STRICT_DEPS` = `fail` (a hit makes the run exit non-zero),
 *    `warn` (lines only) or `off` (nothing at all); default `DEFAULT_STRICT_DEPS_MODE`.
 * 4. Failures at once (plan-617): vitest's default reporter prints assertion and stack only in
 *    its final summary, so a run ended by the wrapper (124 / 125) or by hand lost every cause.
 *    Every failure that reaches this process is printed to stderr when it arrives, one line
 *    each: `[test-fail] <file> :: <full test name> — <first error message> @ <first stack
 *    line>` (onTestCaseResult, final result only — a retried test that passes in the end prints
 *    nothing, one whose retries are exhausted prints one line), `… :: (suite <name>) — …` for a
 *    `beforeAll` / `afterAll` error of a describe (onTestSuiteResult) and `… :: (module) — …`
 *    for an import or file-level hook error (onTestModuleEnd). Each entity reports only its OWN
 *    errors (`errors()`), and no entity or error object is printed twice in a run. The first
 *    `FAIL_LIVE_LIMIT` (50) failures of a run are printed; the first one over the limit prints
 *    `[test-fail] limit of 50 reached — further failures only in the vitest summary` at once,
 *    and a run that ends regularly prints the remaining count. A failure still in the worker's
 *    update buffer when the run is killed is lost — only what already arrived here is kept.
 *
 * Registration: a Vite plugin with the vitest `configureVitest` hook APPENDS the reporter
 * instance to the resolved `reporters` — after vitest has merged config and CLI
 * `--reporter` — so the default (or the CLI-chosen) reporters stay exactly as they are.
 * The hook also removes `RV_TEST_LOCK_PROGRESS_FILE` from this process's environment, so
 * vitest children that tests spawn (fixtures, quarantine runs) never report into the
 * holder's file.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, cpus } from 'node:os';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';

const RECORD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Skipped tests of one module (.skip AND the non-selected siblings of an .only); 0 for module shapes without children. */
function countSkipped(module) {
  try {
    let n = 0;
    for (const test of module.children.allTests('skipped')) { void test; n += 1; }
    return n;
  } catch { return 0; }
}

/** Pure projection of final Vitest modules; milliseconds become summary seconds. */
export function buildRunRecord(modules, ctx) {
  const list = Array.from(modules);
  return {
    runId: ctx.runId, commitWeb: ctx.commitWeb, commitPrivate: ctx.commitPrivate,
    dirtyWeb: ctx.dirtyWeb, dirtyPrivate: ctx.dirtyPrivate,
    host: ctx.host, cores: ctx.cores, maxWorkers: String(ctx.maxWorkers),
    argv: [...ctx.argv], filtered: !!ctx.filtered, complete: !!ctx.complete,
    testFiles: list.length, skippedTests: list.reduce((sum, m) => sum + countSkipped(m), 0), durationS: (ctx.endedAt - ctx.startedAt) / 1000,
    importS: list.reduce((sum, m) => sum + (m.diagnostic().collectDuration || 0), 0) / 1000,
    testsS: list.reduce((sum, m) => sum + (m.diagnostic().duration || 0), 0) / 1000,
    redFiles: [...new Set(list.filter((m) => m.state() === 'failed' || m.errors().length > 0)
      .map((m) => relPath(m.moduleId, ctx.root)))],
  };
}

function gitValue(root, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { timeout: 1500, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

async function repoIdentity(root) {
  const [commit, status] = await Promise.all([
    gitValue(root, ['rev-parse', 'HEAD']),
    gitValue(root, ['status', '--porcelain', '--', '.', ':(exclude).test-runs']),
  ]);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

/** Best effort only: never affect runner output or exit status. */
export async function writeRunRecord(record, { directory = process.env.RV_TEST_RUN_RECORD_DIR || path.join(RECORD_ROOT, '.test-runs'), endedAt = Date.now(), pid = process.pid, log = stderrLine } = {}) {
  try {
    await mkdir(directory, { recursive: true });
    const stamp = new Date(endedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const name = `${stamp}-${record.commitWeb?.slice(0, 8) || 'unknown'}-${pid}-${record.runId}.json`;
    await writeFile(path.join(directory, name), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    const names = (await readdir(directory)).filter((f) => /^\d{8}T\d{6}Z-[a-z0-9]+-\d+-\d+\.json$/.test(f));
    const files = await Promise.all(names.map(async (f) => ({ name: f, time: (await stat(path.join(directory, f))).mtimeMs })));
    files.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
    for (const file of files.slice(200)) await unlink(path.join(directory, file.name));
  } catch {
    log('[test-run-record] warning: could not write or retain run record');
  }
}

export const PROGRESS_ENV = 'RV_TEST_LOCK_PROGRESS_FILE';
export const SKIP_LINE_TOP = 5;
/** Epoch ms of the wrapper's child spawn, set by every `with-test-lock.mjs` for its child. */
export const WRAPPER_SPAWN_ENV = 'RV_TEST_WRAPPER_SPAWN_MS';
export const NO_REASON = 'no reason given';
/** Selects the strict-deps mode (`fail` | `warn` | `off`); read once per vitest process. */
export const STRICT_DEPS_ENV = 'RV_TEST_STRICT_DEPS';
/**
 * Default strict-deps mode: `fail`. `optimizeDeps.include` in vite.config.ts was completed by
 * the discovery run of 2026-10-16 (full browser suite, fresh worktree, cold cache:
 * `[test-deps] 0 mid-run re-optimizations` after the `@microsoft/teams-js` and
 * `three/addons/controls/PointerLockControls.js` entries). `RV_TEST_STRICT_DEPS=warn`
 * downgrades a local run.
 */
export const DEFAULT_STRICT_DEPS_MODE = 'fail';
const STRICT_DEPS_MODES = new Set(['fail', 'warn', 'off']);

/** `RV_TEST_STRICT_DEPS` → `'fail' | 'warn' | 'off'`; unset or unknown → `DEFAULT_STRICT_DEPS_MODE`. */
export function strictDepsMode(env = process.env) {
  const v = String(env?.[STRICT_DEPS_ENV] ?? '').trim().toLowerCase();
  return STRICT_DEPS_MODES.has(v) ? v : DEFAULT_STRICT_DEPS_MODE;
}

/**
 * Appends one progress record (`{ ev, pid, ppid, t }` plus optional fields) to `file`; never throws.
 *
 * `spec` (plan-900) names the FILE of the wrapper's per-file limit: the path relative to the
 * vitest root, `/`-normalised. It is optional and written only when given, so a call without it
 * produces exactly the record it produced before plan-900, character for character — the
 * `fake-vitest` fixture writes its records through THIS function (plan-900 E15), so there must
 * never be a second writer that can drift from production. The field is `spec` and not `file`
 * because the first parameter is already called `file` and means the progress file.
 */
export function writeProgress(file, ev, { pid = process.pid, ppid = process.ppid, spec, ...extra } = {}) {
  if (!file) return;
  try {
    const record = { ...extra, ev, pid, ppid };
    if (spec !== undefined) record.spec = spec;
    appendFileSync(file, `${JSON.stringify({ ...record, t: Date.now() })}\n`);
  } catch {
    /* progress is advisory — a failed write must never fail the run */
  }
}

/**
 * `[{ key, count }]` → the skip line; `[test-skips] 0 skipped` when nothing was skipped.
 * Groups are sorted by count (desc), then key; the first `top` are named.
 */
export function formatSkipLine(groups, { top = SKIP_LINE_TOP } = {}) {
  const sorted = [...groups].filter((g) => g.count > 0)
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const total = sorted.reduce((sum, g) => sum + g.count, 0);
  if (total === 0) return '[test-skips] 0 skipped';
  const named = sorted.slice(0, top).map((g) => `${g.count} ${g.key}`);
  const more = sorted.length - named.length;
  return `[test-skips] ${total} skipped: ${named.join(', ')}${more > 0 ? `, … (+${more} more)` : ''}`;
}

export const FAILED_IN_SETUP = 'file failed in setup';

/**
 * Whether `test` was skipped because a setup hook of its file failed. vitest 4.0.18: a throwing
 * `beforeAll` makes the runner mark every task of that suite skipped (`markTasksAsSkipped`)
 * and record the error on the SUITE's result (`failTask`), so an ancestor — a `describe` or
 * the TestModule itself — reports `state() === 'failed'` with non-empty `errors()`.
 */
function failedInSetup(test, module) {
  const failed = (entity) => typeof entity?.errors === 'function' && entity.errors().length > 0
    && (typeof entity.state !== 'function' || entity.state() === 'failed');
  for (let p = test?.parent, hops = 0; p && hops < 64; p = p.parent, hops++) {
    if (failed(p)) return true;
    if (p === module) return false;
  }
  return failed(module);
}

/**
 * Skipped tests of `testModules` grouped by note; else, when a setup hook of their file
 * failed, as `file failed in setup: <file>`; else as `no reason given: <file>`
 * (module path relative to `root`).
 */
export function collectSkips(testModules, root = process.cwd()) {
  const counts = new Map();
  for (const module of testModules ?? []) {
    const file = path.relative(root, String(module.moduleId ?? '')).replace(/\\/g, '/') || String(module.moduleId);
    for (const test of module.children.allTests('skipped')) {
      const note = String(test.result()?.note ?? '').trim();
      const key = note || `${failedInSetup(test, module) ? FAILED_IN_SETUP : NO_REASON}: ${file}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].map(([key, count]) => ({ key, count }));
}

/** `2026-10-16T10:34:57.123Z` → `2026-10-16T10:34:57Z`. */
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The one measurement line printed at a process's first test:
 * `[test-progress] first test after 12.4 s (run start <iso>, config <file>)` plus
 * ` / 41.0 s since wrapper start` when the wrapper's spawn time is known.
 */
export function formatFirstTestLine({ now, runStart, config, wrapperSpawn }) {
  const since = (from) => ((now - from) / 1000).toFixed(1);
  const head = `[test-progress] first test after ${since(runStart)} s (run start ${isoSeconds(runStart)}, config ${config || 'default'})`;
  return Number.isFinite(wrapperSpawn) && wrapperSpawn > 0 ? `${head} / ${since(wrapperSpawn)} s since wrapper start` : head;
}

/**
 * The one measurement line printed at a process's first test FILE (`module-start`):
 * `[test-progress] first test file started after 3.1 s (run start <iso>, config <file>)` plus
 * ` / 4.0 s since wrapper start` when the wrapper's spawn time is known.
 */
export function formatModuleStartLine(input) {
  return formatFirstTestLine(input).replace('[test-progress] first test after', '[test-progress] first test file started after');
}

// ─── failures at once ([test-fail]) ─────────────────────────────────────────

/** Failures printed live per run; further ones are only counted. */
export const FAIL_LIVE_LIMIT = 50;
/** Longest message part of a `[test-fail]` line (characters, incl. the ellipsis). */
export const FAIL_MESSAGE_MAX = 300;
export const FAIL_LIMIT_LINE = `[test-fail] limit of ${FAIL_LIVE_LIMIT} reached — further failures only in the vitest summary`;

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const relPath = (file, root) => {
  const s = String(file ?? '');
  if (!s) return '';
  return (root && path.isAbsolute(s) ? path.relative(root, s) : s).replace(/\\/g, '/') || s;
};

/** The first error message of `error` on one line, at most `FAIL_MESSAGE_MAX` characters. */
export function failMessage(error) {
  let text = '';
  if (error !== null && error !== undefined) text = oneLine(typeof error === 'object' ? error.message : error);
  if (!text && error && typeof error === 'object' && error.name) text = oneLine(error.name);
  if (!text) text = '(no message)';
  return text.length > FAIL_MESSAGE_MAX ? `${text.slice(0, FAIL_MESSAGE_MAX - 1)}…` : text;
}

/**
 * The first stack line of `error`: vitest's parsed `stacks[0]` (`file:line:column`, the file
 * relative to `root`), else the first `at …` line of `error.stack`, else `no stack`.
 */
export function failStackLine(error, root) {
  if (!error || typeof error !== 'object') return 'no stack';
  const frame = Array.isArray(error.stacks) ? error.stacks.find((f) => f && f.file) : null;
  if (frame) {
    const where = [relPath(frame.file, root), frame.line, frame.column].filter((x) => x !== undefined && x !== null && x !== '').join(':');
    if (where) return oneLine(where);
  }
  const at = String(error.stack ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('at '));
  return at ? oneLine(at.slice(3)) : 'no stack';
}

/**
 * `[test-fail] <file> :: <label> — <message> @ <stack line>` — one line; `file` relative to
 * `root`, `label` the test's full name, `(suite <name>)` or `(module)`.
 */
export function formatFailLine({ file, label, error, root }) {
  return `[test-fail] ${relPath(file, root) || 'unknown file'} :: ${oneLine(label) || '(unnamed)'} — ${failMessage(error)} @ ${failStackLine(error, root)}`;
}

/** The run-end line for the failures over the live limit (`''` when there were none). */
export function formatFailRemainderLine(suppressed) {
  if (!(suppressed > 0)) return '';
  return `[test-fail] ${suppressed} further failure${suppressed === 1 ? '' : 's'} not shown live (limit ${FAIL_LIVE_LIMIT}) — see the vitest summary`;
}

/** Fresh per-RUN failure bookkeeping (replaced at every onTestRunStart). */
export function createFailState() {
  return { shown: 0, suppressed: 0, entities: new Set(), errors: new WeakSet() };
}

/**
 * Applies the live limit to one failure: `'show'` (print it), `'notice'` (the first one over
 * the limit — print `FAIL_LIMIT_LINE` instead) or `'suppress'` (count it only).
 */
export function noteFail(fails) {
  if (fails.shown < FAIL_LIVE_LIMIT) {
    fails.shown++;
    return 'show';
  }
  fails.suppressed++;
  return fails.suppressed === 1 ? 'notice' : 'suppress';
}

// ─── strict optimizeDeps ([test-deps]) ──────────────────────────────────────

/** The hit line for `deps`; `reloaded` = the optimizer reloaded the page after the first test. */
export function formatDepsHitLine(deps, { reloaded = true } = {}) {
  const list = deps.length ? deps.join(', ') : 'unknown (see "new dependencies optimized" above)';
  const what = deps.length > 1 ? 'them' : 'it';
  const why = reloaded
    ? 'the reload made this run unusable'
    : 're-optimized without a reload this time; the next discovery can reload and make a run unusable';
  return `[test-deps] undeclared dependency discovered mid-run: ${list} — add ${what} to optimizeDeps.include in vite.config.ts (${why})`;
}

/** `[{ dep, reloaded }]` → `[test-deps] 0 mid-run re-optimizations` or the named list. */
export function formatDepsSummary(hits) {
  if (!hits.length) return '[test-deps] 0 mid-run re-optimizations';
  const named = hits.map((h) => (h.reloaded ? `${h.dep} (reloaded)` : h.dep));
  return `[test-deps] ${hits.length} mid-run re-optimization${hits.length === 1 ? '' : 's'}: ${named.join(', ')}`;
}

/** Fresh per-process bookkeeping of the deps watcher: discoveries before / after the first test, hits. */
export function createDepsState(mode = strictDepsMode()) {
  return { mode, before: [], after: [], hits: new Map() };
}
const depsOf = (state) => (state.deps ??= createDepsState());
const pushUnique = (list, dep) => {
  if (!list.includes(dep)) list.push(dep);
};

/**
 * The optimizer discovered `dep` (an id it had not seen). Before the process's first test it
 * is only remembered (so a reload it causes AFTER the first test can still be named); after
 * it, it is a hit. Returns whether it counted.
 */
export function noteDepDiscovered(dep, state = processState()) {
  const deps = depsOf(state);
  const id = String(dep);
  if (!state.firstTest) {
    pushUnique(deps.before, id);
    return false;
  }
  pushUnique(deps.after, id);
  if (!deps.hits.has(id)) deps.hits.set(id, { dep: id, reloaded: false });
  return true;
}

/**
 * The environment sent a `full-reload`. It is the optimizer's reload only while discoveries
 * are pending (otherwise it is none of ours and ignored). Before the first test it is
 * legitimate. After it, the pending discoveries — those after the first test, else the
 * earlier ones whose re-optimization only now reloads the page — are reloaded hits.
 * Returns the line to print (`''` = nothing; always `''` in mode `off`).
 */
export function noteDepReload(state = processState()) {
  const deps = depsOf(state);
  const named = [...(deps.after.length ? deps.after : deps.before)];
  if (!named.length) return '';
  deps.before = [];
  deps.after = [];
  if (!state.firstTest) return '';
  for (const id of named) deps.hits.set(id, { dep: id, reloaded: true });
  return deps.mode === 'off' ? '' : formatDepsHitLine(named, { reloaded: true });
}

/**
 * The run-end decision: the lines to print (discoveries that never reloaded, then the
 * summary) and whether the run must fail. Clears the hits, so a watch rerun reports its own.
 */
export function depsRunEnd(state = processState()) {
  const deps = depsOf(state);
  const hits = [...deps.hits.values()];
  deps.hits.clear();
  if (deps.mode === 'off') return { lines: [], fail: false };
  const quiet = hits.filter((h) => !h.reloaded).map((h) => h.dep);
  const lines = quiet.length ? [formatDepsHitLine(quiet, { reloaded: false })] : [];
  lines.push(formatDepsSummary(hits));
  return { lines, fail: deps.mode === 'fail' && hits.length > 0 };
}

const WATCHED = Symbol.for('rv.testDepsWatched');
const stderrLine = (line) => process.stderr.write(`${line}\n`);

/**
 * Wraps the deps optimizer of every environment of `server` that does discovery (vite 6:
 * `environment.depsOptimizer` from `createDepsOptimizer`; disabled, `noDiscovery` and
 * explicit optimizers are left alone). Two structured hooks, each wrapped at most once:
 * - `depsOptimizer.registerMissingImport(id, resolved)` — what vite's import analysis and
 *   resolver call for a bare import that is not pre-bundled; an id absent from
 *   `metadata.optimized` / `chunks` / `discovered` is a NEW discovery (the id that
 *   "new dependencies optimized: <id>" logs later);
 * - `environment.hot.send` — the optimizer's `fullReload()` sends `{ type: 'full-reload' }`
 *   right after logging "optimized dependencies changed. reloading".
 * Both call straight through, so vite behaves exactly as before. Returns the number of
 * optimizers wrapped.
 */
export function watchDepsOptimizer(server, { state = processState(), log = stderrLine } = {}) {
  let wrapped = 0;
  for (const env of Object.values(server?.environments ?? {})) {
    const optimizer = env?.depsOptimizer;
    if (!optimizer || optimizer[WATCHED] || optimizer.options?.noDiscovery) continue;
    if (typeof optimizer.registerMissingImport !== 'function') continue;
    optimizer[WATCHED] = true;
    const register = optimizer.registerMissingImport;
    optimizer.registerMissingImport = function registerMissingImportWatched(id, ...rest) {
      try {
        const m = optimizer.metadata;
        if (m && !m.optimized?.[id] && !m.chunks?.[id] && !m.discovered?.[id]) noteDepDiscovered(id, state);
      } catch {
        /* a watcher, never a failure */
      }
      return register.call(this, id, ...rest);
    };
    const hot = env.hot;
    if (hot && typeof hot.send === 'function' && !hot[WATCHED]) {
      hot[WATCHED] = true;
      const send = hot.send;
      hot.send = function sendWatched(payload, ...rest) {
        if (payload && typeof payload === 'object' && payload.type === 'full-reload') {
          try {
            const line = noteDepReload(state);
            if (line) log(line);
          } catch {
            /* a watcher, never a failure */
          }
        }
        return send.call(this, payload, ...rest);
      };
    }
    wrapped++;
  }
  return wrapped;
}

// One state per vitest PROCESS — survives watch-mode reruns and config-change restarts
// (which re-import the config and with it this module).
const STATE_KEY = Symbol.for('rv.testLockProgress');
function processState() {
  globalThis[STATE_KEY] ??= {
    file: process.env[PROGRESS_ENV] || '',
    wrapperSpawn: Number(process.env[WRAPPER_SPAWN_ENV]) || 0,
    runStart: false,
    runStartAt: 0,
    moduleStart: false,
    firstTest: false,
    runEnd: false,
    deps: createDepsState(),
    fails: createFailState(),
  };
  return globalThis[STATE_KEY];
}

export class TestLockProgressReporter {
  constructor(state = processState(), { write = writeProgress, log = (line) => process.stderr.write(`${line}\n`), now = Date.now, failRun = () => { process.exitCode = 1; } } = {}) {
    this.state = state;
    this.write = write;
    this.log = log;
    this.now = now;
    this.failRun = failRun;
    this.root = process.cwd();
    this.config = '';
  }

  onInit(vitest) {
    this.vitest = vitest;
    if (vitest?.config?.root) this.root = vitest.config.root;
    const file = vitest?.vite?.config?.configFile;
    if (file) this.config = path.relative(process.cwd(), file).replace(/\\/g, '/') || path.basename(file);
  }

  onTestRunStart(specifications = []) {
    this.state.recordSequence = (this.state.recordSequence || 0) + 1;
    this.recordRun = { runId: this.state.recordSequence, startedAt: this.now() };
    this.state.fails = createFailState(); // per RUN, before the once-guard: a watch rerun reports its own
    if (this.state.runStart) return;
    this.state.runStart = true;
    this.state.runStartAt = this.now();
    this.write(this.state.file, 'run-start', { files: [...new Set(specifications.map((spec) => relPath(spec.moduleId, this.root)))] });
  }

  /**
   * A test file was handed to a worker (plan-900, E7): `file-start` with its `spec`, the only
   * event the wrapper's per-file limit can start a clock from. It fires BEFORE the setup files
   * and BEFORE the module import (`@vitest/runner` `onCollectStart` → `rpc().onQueued`), which
   * is why a file that hangs in its import — the five plan-900 hangers — is named at all:
   * `onTestModuleStart` never fires for those. Deliberately carries NO `file` field, so the
   * stall limit's own file bookkeeping (plan-617/58a95a1b) keeps counting a file as started at
   * `onTestModuleStart`, exactly as before.
   */
  onTestModuleQueued(testModule) {
    this.write(this.state.file, 'file-start', { spec: relPath(testModule?.moduleId, this.root) });
  }

  /**
   * The process's first test file started (`suite-prepare`, or `suite-failed-early` on an
   * import error): `module-start` closes the wrapper's startup window. Does NOT set
   * `state.firstTest` — the strict-deps boundary stays the first test.
   */
  onTestModuleStart(testModule) {
    this.write(this.state.file, 'file-start', { file: relPath(testModule?.moduleId, this.root) });
    if (this.state.moduleStart) return;
    this.state.moduleStart = true;
    this.write(this.state.file, 'module-start');
    try {
      const now = this.now();
      this.log(formatModuleStartLine({ now, runStart: this.state.runStartAt || now, config: this.config, wrapperSpawn: this.state.wrapperSpawn }));
    } catch {
      /* a measurement, never a failure */
    }
  }

  onTestCaseReady() {
    if (this.state.firstTest) return;
    this.state.firstTest = true;
    this.write(this.state.file, 'first-test');
    try {
      const now = this.now();
      this.log(formatFirstTestLine({ now, runStart: this.state.runStartAt || now, config: this.config, wrapperSpawn: this.state.wrapperSpawn }));
    } catch {
      /* a measurement, never a failure */
    }
  }

  /** A test's FINAL result (after its retries): a failure is printed at once. */
  onTestCaseResult(testCase) {
    this.write(this.state.file, 'test-end', { file: relPath(testCase?.module?.moduleId, this.root) });
    try {
      const result = testCase?.result?.();
      if (result?.state !== 'failed') return;
      this.reportFail(testCase, testCase.module, testCase.fullName, result.errors);
    } catch {
      /* a convenience, never a failure */
    }
  }

  /** A describe ended: its OWN errors (`beforeAll` / `afterAll`) are printed at once. */
  onTestSuiteResult(testSuite) {
    try {
      const errors = testSuite?.errors?.() ?? [];
      if (!errors.length) return;
      this.reportFail(testSuite, testSuite.module, `(suite ${testSuite.fullName ?? testSuite.name ?? ''})`, errors);
    } catch {
      /* a convenience, never a failure */
    }
  }

  /**
   * A test file ended: its OWN errors (import error, file-level hook) are printed at once. The
   * record carries `file` (stall limit) AND `spec` (plan-900 per-file limit) — one event, two
   * readers, so the two clocks can never disagree about when a file ended.
   */
  onTestModuleEnd(testModule) {
    const spec = relPath(testModule?.moduleId, this.root);
    this.write(this.state.file, 'file-end', { file: spec, spec });
    try {
      const errors = testModule?.errors?.() ?? [];
      if (!errors.length) return;
      this.reportFail(testModule, testModule, '(module)', errors);
    } catch {
      /* a convenience, never a failure */
    }
  }

  /** One `[test-fail]` line for `entity` (its first error not printed yet), within the run's limit. */
  reportFail(entity, module, label, errors) {
    const fails = (this.state.fails ??= createFailState());
    const key = entity?.id ?? entity;
    if (fails.entities.has(key)) return; // never the same entity twice in a run (defensive: vitest reports each once)
    fails.entities.add(key);
    const list = Array.isArray(errors) ? errors : [];
    const isObject = (e) => e !== null && typeof e === 'object';
    const fresh = list.filter((e) => !isObject(e) || !fails.errors.has(e));
    if (list.length && !fresh.length) return; // every error was printed already, by another entity
    for (const e of fresh) if (isObject(e)) fails.errors.add(e);
    const verdict = noteFail(fails);
    if (verdict === 'suppress') return;
    this.log(verdict === 'notice' ? FAIL_LIMIT_LINE : formatFailLine({ file: module?.moduleId, label, error: fresh[0], root: this.root }));
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const run = this.recordRun;
    this.recordRun = null;
    const endedAt = this.now();
    // Keep the existing progress/clock lifecycle independent of record I/O.
    const pendingRecord = run && reason !== 'interrupted'
      ? this.saveRunRecord(testModules, run, endedAt) : undefined;
    if (!this.state.runEnd) {
      this.state.runEnd = true;
      this.write(this.state.file, 'run-end');
    }
    try {
      const line = formatFailRemainderLine(this.state.fails?.suppressed ?? 0);
      if (line) this.log(line);
    } catch {
      /* a convenience, never a failure */
    }
    try {
      this.log(formatSkipLine(collectSkips(testModules, this.root)));
    } catch {
      /* the summary is a convenience — never fail a run over it */
    }
    let verdict = { lines: [], fail: false };
    try {
      verdict = depsRunEnd(this.state);
    } catch {
      /* bookkeeping trouble is never a hit */
    }
    for (const line of verdict.lines) this.log(line);
    // RV_TEST_STRICT_DEPS=fail: vitest only ever sets process.exitCode to 1 (never back to 0)
    // and exits with it, so this ends the run red although every test passed.
    if (verdict.fail) this.failRun();
    return pendingRecord;
  }

  async saveRunRecord(modules, run, endedAt) {
    try {
      const [web, privateRepo] = await Promise.all([
        repoIdentity(RECORD_ROOT), repoIdentity(path.resolve(RECORD_ROOT, '../realvirtual-WebViewer-Private~')),
      ]);
      const config = this.vitest?.config || {};
      const record = buildRunRecord(modules, {
        ...run, endedAt, root: this.root, commitWeb: web.commit, dirtyWeb: web.dirty,
        commitPrivate: privateRepo.commit, dirtyPrivate: privateRepo.dirty,
        host: hostname(), cores: cpus().length, maxWorkers: config.maxWorkers ?? 'unknown',
        argv: process.argv.slice(2), complete: true,
        filtered: run.runId > 1 || !!(this.vitest?.filenamePattern?.length || config.testNamePattern || config.changed || config.related || config.shard),
      });
      await writeRunRecord(record, { endedAt, log: this.log });
    } catch {
      this.log('[test-run-record] warning: could not build run record');
    }
  }
}

/**
 * The Vite plugin both vitest configs list: appends one reporter to the resolved reporters
 * (`configureVitest`) and watches the deps optimizer (`configureServer`, under vitest only).
 * Vitest browser mode loads vite.config.ts AGAIN for its own browser Vite server, so
 * `configureServer` also runs there — that server's `client` optimizer is the one serving the
 * tests. Both servers live in the vitest main process and share `processState()`.
 * Without `process.env.VITEST` (set by vitest itself) the hook is a no-op: the Playwright
 * `webServer` (a plain vite dev server), `npm run dev` and builds are never watched, and
 * `RV_TEST_STRICT_DEPS=fail` applies to vitest runs only.
 */
export function testLockProgressPlugin() {
  const seen = new WeakSet();
  return {
    name: 'rv-test-lock-progress',
    configureServer(server) {
      if (!process.env.VITEST) return; // a dev server or a build: nothing to watch
      try {
        watchDepsOptimizer(server);
      } catch {
        /* a watcher, never a failure */
      }
    },
    configureVitest({ vitest }) {
      const config = vitest.config;
      if (!config || seen.has(config) || !Array.isArray(config.reporters)) return; // once per resolved config (projects share it)
      seen.add(config);
      if (config.reporters.some((r) => r instanceof TestLockProgressReporter)) return;
      const state = processState();
      delete process.env[PROGRESS_ENV]; // children spawned by tests must not report into the holder's file
      delete process.env[WRAPPER_SPAWN_ENV]; // … nor measure against this run's wrapper
      config.reporters.push(new TestLockProgressReporter(state));
    },
  };
}
