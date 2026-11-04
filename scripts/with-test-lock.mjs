// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Test lock wrapper (plan-606): holds the machine-wide test lock for the whole
 * lifetime of one test runner (heavy on H0, light on a shared slot, exclusive on all).
 *
 *   node scripts/with-test-lock.mjs [--] <vitest|playwright|path/to/script.mjs> [args…]
 *
 * 1. acquires `127.0.0.1:<RV_TEST_LOCK_PORT|47177>` (`scripts/test-lock.mjs`), waiting
 *    while its class is blocked; `RV_TEST_LOCK_TIMEOUT_SECONDS` defaults to 1800 s
 *    (exclusive: `RV_TEST_LOCK_EXCLUSIVE_TIMEOUT_SECONDS`, default 3600 s);
 * 2. starts the runner as its child WITHOUT a shell — `process.execPath` + the resolved
 *    CLI file, the arguments as an array, unchanged, `stdio: 'inherit'` (TTY, watch keys);
 * 3. waits for the child's `exit`, only then releases the lock, and exits with the
 *    child's code (`null`/signal or a spawn error → 1; a console-aborted child's
 *    `0xC000013A` is passed on unchanged).
 *
 * The lock is taken BEFORE the runner starts and released AFTER its process has
 * exited, so it brackets Playwright's `webServer` (started before `globalSetup`) and
 * every runner teardown.
 *
 * Child environment: `RV_TEST_LOCK_HELD=<wrapper pid>`, `RV_TEST_LOCK_PARENT_PID=<wrapper pid>`
 * and `NODE_OPTIONS=… --require "<scripts/test-lock-watchdog.cjs>"`, so every Node
 * descendant ends when the wrapper is gone (F10).
 *
 * Re-entrancy (F2a): started with `RV_TEST_LOCK_HELD` naming a LIVE process, the wrapper
 * does not bind — it just runs its child and passes the environment on unchanged
 * (`test:all` → `npm run test:node` → wrapper). A dead pid there is ignored.
 * `RV_TEST_LOCK=off` runs the child without any lock.
 *
 * Signals: on Windows a hard kill of the wrapper ends the whole non-detached tree via
 * the job object libuv puts children into; console Ctrl+C / Ctrl+Break reach the child
 * through the shared console, and the wrapper only waits (10 s grace, then
 * `taskkill /T /F`). On POSIX the wrapper forwards SIGINT/SIGTERM/SIGHUP to the child
 * (its process group when the child runs detached), waits, and sends SIGKILL only after
 * a 10 s grace — unmeasured, the dev machines are Windows.
 *
 * Maximum run time: the wrapper that HOLDS the lock (not a re-entering or `RV_TEST_LOCK=off`
 * one) ends a child still running after `RV_TEST_MAX_RUNTIME_MINUTES` (default 90, fractions
 * allowed, `0` disables) with the same hard kill (`taskkill /T /F` / process-group SIGKILL),
 * releases the lock and exits with 124 — a hung run no longer holds the lock for hours. The guard
 * of a direct vitest run (`tests/global-lock-guard.ts`) reuses `maxRuntime()` and the exit code.
 *
 * Startup limit: the same holding wrapper ends the tree and exits with 125 when a vitest run
 * has not started its first test FILE within `RV_TEST_STARTUP_TIMEOUT_SECONDS` (default 300,
 * fractions allowed, `0` disables) — the 2026-10-15 case of a browser run that hung for 74 min
 * with "no tests" and `rpc is closed`: no module event ever arrived. It is a guard against "no
 * module event received", not against every hang — a run hung AFTER a file started (or after an
 * import error, which is a module event too) is covered by the stall limit below. Until
 * plan-617 the window closed only at the first TEST, whose event the runner's update throttle
 * holds back until a synchronous first test or a long `beforeAll` has finished — a legitimate
 * run with a first test longer than the limit was killed. Progress comes from `scripts/test-progress-reporter.mjs`
 * (registered in both vitest configs) through the file named by `RV_TEST_LOCK_PROGRESS_FILE`,
 * which the holder creates in the temp dir and polls from its OWN event loop, so a blocked
 * vitest main thread cannot stop the limit. A window opens
 *   - at the child's spawn (after the lock is acquired — waiting for the lock does not count)
 *     when the runner is vitest (`vitest` or a `…/vitest.mjs` path): catches a vitest that
 *     never reaches its run;
 *   - when a re-entering wrapper whose runner is vitest starts (`expect` record) — `test:all`
 *     gives its node and its browser suite one window each;
 *   - at a `run-start` of a vitest process no window is open for yet;
 * and closes at that process's `module-start`, `first-test` or `run-end`, or when the process is gone.
 * A vitest process reports these startup events at most once, so watch-mode reruns are never limited;
 * a non-vitest runner without reporter records (Playwright, perf scripts) is never limited.
 * A direct `npx vitest run` (guard path, no wrapper) has no startup, per-file or stall limit; it
 * does have the maximum run time below — `tests/global-lock-guard.ts` enforces it in the vitest
 * process itself. That is deliberate and it is the whole coverage a bare run can get: all three
 * finer limits read the reporter's records from OUTSIDE the vitest process, which is the point of
 * them (a blocked vitest event loop cannot stop a clock that is not in it). In the guard the
 * clock would sit in the very process that hangs. A stall timer there is not just expensive, it
 * is not CONSTRUCTIBLE from the events a bare run has: the reporter writes nothing between a
 * file's start and its end, so a long healthy middle and a hang look identical (plan-900 E8) —
 * which is exactly why the wrapper gained a per-file DURATION limit instead of a stall limit.
 * For a bare run the maximum run time is therefore the only possible bound, and the way to get a
 * named file is to run through the wrapper.
 *
 * Per-file limit (plan-900): the holding wrapper ends the tree with exit 126 and NAMES THE FILE
 * when ONE test file has been running longer than `RV_TEST_FILE_TIMEOUT_SECONDS` (default 600,
 * fractions allowed, `0` disables — that `0` is the EMERGENCY STOP: a false alarm hard-kills the
 * whole tree and turns a previously green run red on every machine, and `test`, `test:node` and
 * `test:all` all go through this wrapper, so the way back needs no code change). It closes the
 * gap the startup limit leaves: that window covers only the FIRST file of a process, so every
 * later file hang used to fall into the 90-minute cap without a name — the reason
 * `npm run test:all` never ended by itself. The clock runs per FILE, from its `file-start`
 * (`onTestModuleQueued`, BEFORE the import — the only event a file hanging in its own import
 * still produces) to its `file-end`, in an in-flight map keyed by `(pid, spec)` with the
 * WRAPPER's receipt times. It is deliberately a DURATION limit, not a stall limit: between
 * `file-start` and `file-end` the reporter writes nothing about that file, so a long healthy
 * middle could not be told apart from a hang, and a heartbeat per test case would multiply the
 * write volume. The same clock doubles as an INACTIVITY clock on "no file event at all", but
 * only while the in-flight map is EMPTY (A3b, for a hang before any `file-start`: worker boot,
 * environment, the browser tester page) — with one shared limit, "inactivity due and map not
 * empty" is already the named case. A file's limit comes from `limitFor(spec)`, so a per-file
 * exception (A8) is later a data change in `FILE_TIMEOUT_OVERRIDES`, not a change to the clock.
 *
 * Stall limit: after the first module/file start, NO progress record for
 * `RV_TEST_STALL_MINUTES` (default 10, fractions allowed, `0` disables) ends the tree
 * with exit 123, naming unfinished files and counting expected files not yet started.
 * Every record refreshes the window; all reporting processes ending disarms it, so
 * watch-mode idle and reruns are exempt. Ten minutes leaves ample margin: our longest
 * legitimate browser test measured 82 s alone; the slowest file, laserwelding-station-flow,
 * took 280 s with a test-end at least every 82 s. Only the holding wrapper watches.
 *
 * WHICH OF THE TWO SILENCE CLOCKS IS IN CHARGE (plan-900 F6, decided 2026-10-27): the stall
 * limit (123) is the FALLBACK FOR A SWITCHED-OFF PER-FILE LIMIT, and nothing else. While 126 is
 * active, 123 is not armed at all — see `stallIsResponsible()`, which is the single place that
 * rule is written down. The reason it is now explicit instead of implicit: the stall watch
 * refreshes its window on EVERY record while the per-file watch refreshes only on FILE events,
 * so `since ≤ lastEventAt ≤ lastAt` always holds and with equal defaults (600 s / 10 min) the
 * per-file or A3b trigger is always due no later than the stall trigger — and it is evaluated
 * first. 123 was therefore UNREACHABLE at default configuration, and that fact rested on the
 * order of two statements. Now exactly one clock owns silence at any time, and re-sorting the
 * checks cannot change the semantics.
 *
 * WHO THE THREE ABORT CLOCKS ARE FOR (plan-2046, decided 2026-10-31): for runs NOBODY WATCHES.
 * The startup (125), per-file (126) and stall (123) limits are armed only when
 * `RV_TEST_UNATTENDED=1` is set, and every unattended start path sets it. Without it a run has
 * the test lock and the 90-minute cap (124) and nothing else, because a human in front of the run
 * is the better watchdog: they see a hang at once and abort file-exactly, while a false alarm
 * costs them the whole summary and makes the acceptance gate unrunnable. In that state a
 * switched-off 126 is a DECISION, not a failure, so 123 must NOT step in as its fallback — that
 * is the second half of `stallIsResponsible()`. `RV_TEST_LEGACY_CLOCKS=1` is the rollback and
 * restores the previous behaviour for every run. Which state a run had is on the wrapper's first
 * line (`clockSummary()`); the decision itself is in `clockState()`.
 * After releasing the lock, every limit kill prints FAILED with its exit code and cause;
 * the child's exit status cannot override a limit result (123 / 124 / 125).
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireClass, holderInfo, isEntryScript, isProcessAlive, lockConfig, LOCK_HOST } from './test-lock.mjs';
import { capacityMode, childEnvFor, classifyRun, reentryEnvFor } from './test-capacity.mjs';
import { PROGRESS_ENV, WRAPPER_SPAWN_ENV, writeProgress } from './test-progress-reporter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
export const WATCHDOG_PATH = path.join(here, 'test-lock-watchdog.cjs');
const SIGNAL_GRACE_MS = 10_000;
export const DEFAULT_MAX_RUNTIME_MINUTES = 90;
export const MAX_RUNTIME_EXIT_CODE = 124;
// Evidence for 300 (2026-10-16), measured with the `[test-progress] first test after …` line:
// the COLD browser case — a fresh worktree (empty Vite optimize cache, first Chromium launch)
// under foreign load — reached its first test after 72.2 s (75.2 s since wrapper start;
// plan-764 gate run); warm browser runs after 19.2 s and 3.6 s; the node suite after 0.8 s.
// Full browser suite in a fresh worktree, cold cache, quiet machine except a base load of
// ~1.48 cores (a CONNECT Vite dev server): first test after 61.5 s (62.7 s since wrapper
// start); warm after a test change (the everyday case) 9.8 s; warm otherwise 3.2–3.6 s.
// The worst measured case leaves a margin of about 4x, so the 300 s default stands.
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 300;
export const STARTUP_TIMEOUT_EXIT_CODE = 125;
export const STALL_EXIT_CODE = 123;
// Evidence for 600 (plan-900 P0, 2026-10-26): over a complete suite run (1992 files with a
// duration) 0 files are above 300 s and 0 above 600 s; the maximum was 251.5 s (a measuring
// spike with an external GLB source), the slowest LEGITIMATE file 200.1 s. 600 s is a factor of
// 2.39 over that maximum and — the argument that carries — LONGER THAN ANY HEALTHY SHARD
// (174.5–256.8 s wall): a per-file limit above the runtime of the whole shard a file sits in
// cannot fire in a healthy run by construction. 300 s would be a factor of 1.19 over the
// maximum, which three measured spreads eat up (±11 % for the same file on the same machine,
// 75 % workers, Vincent's machine unmeasured).
export const DEFAULT_FILE_TIMEOUT_SECONDS = 600;
export const FILE_TIMEOUT_EXIT_CODE = 126;
const PROGRESS_POLL_MS = 250;

const say = (message) => process.stderr.write(`[test-lock] ${message}\n`);

/**
 * The CLI file a runner name stands for: `vitest` → `vitest/vitest.mjs`, `playwright` →
 * `<playwright>/cli.js` (`@playwright/test` first; `cli.js` is not in the package's
 * `exports`, so it is joined onto the resolved `package.json`), anything else → a script
 * path relative to `cwd`.
 */
export function resolveRunner(name, { cwd = process.cwd(), base = root } = {}) {
  const require = createRequire(path.join(base, 'package.json'));
  if (name === 'vitest') {
    return path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  }
  if (name === 'playwright') {
    for (const pkg of ['@playwright/test', 'playwright']) {
      try {
        return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'cli.js');
      } catch {
        /* try the next package */
      }
    }
    throw new Error('playwright CLI not found (neither @playwright/test nor playwright is installed)');
  }
  return path.resolve(cwd, name);
}

/**
 * `--require "<file>"` for NODE_OPTIONS. Backslashes become forward slashes: inside the
 * quotes NODE_OPTIONS treats `\` as an escape (a quoted `E:\a\b.cjs` arrives as `E:ab.cjs`).
 */
export function nodeOptionsRequire(file) {
  return `--require "${String(file).replace(/\\/g, '/')}"`;
}

/** `nodeOptions` with exactly one watchdog `--require` at the end (an inherited one is replaced). */
export function withWatchdog(nodeOptions, file = WATCHDOG_PATH) {
  const flag = nodeOptionsRequire(file);
  const rest = String(nodeOptions ?? '').split(flag).join(' ').replace(/\s+/g, ' ').trim();
  return rest ? `${rest} ${flag}` : flag;
}

/** Wrapper exit code for a child that ended with (`code`, `signal`). */
export function exitCodeFor(code, signal) {
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  void signal;
  return 1;
}

/**
 * `RV_TEST_MAX_RUNTIME_MINUTES` → { minutes, ms }: unset/empty/invalid → the default (90),
 * `0` → disabled (ms 0), fractions allowed (`0.02` ≈ 1.2 s).
 */
export function maxRuntime(env = process.env) {
  const raw = String(env.RV_TEST_MAX_RUNTIME_MINUTES ?? '').trim();
  const value = raw === '' ? NaN : Number(raw);
  const minutes = Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_RUNTIME_MINUTES;
  return { minutes, ms: Math.round(minutes * 60_000) };
}

/**
 * `RV_TEST_STARTUP_TIMEOUT_SECONDS` → { seconds, ms }: unset/empty/invalid → the default (300),
 * `0` → disabled (ms 0), fractions allowed.
 */
export function startupTimeout(env = process.env) {
  const raw = String(env.RV_TEST_STARTUP_TIMEOUT_SECONDS ?? '').trim();
  const value = raw === '' ? NaN : Number(raw);
  const seconds = Number.isFinite(value) && value >= 0 ? value : DEFAULT_STARTUP_TIMEOUT_SECONDS;
  return { seconds, ms: Math.round(seconds * 1000) };
}

/** `RV_TEST_STALL_MINUTES` → { minutes, ms }; invalid → 10, zero disables. */
export function stallTimeout(env = process.env) {
  const raw = String(env.RV_TEST_STALL_MINUTES ?? '').trim();
  const value = raw === '' ? NaN : Number(raw);
  const minutes = Number.isFinite(value) && value >= 0 ? value : 10;
  return { minutes, ms: Math.round(minutes * 60_000) };
}

/**
 * `RV_TEST_FILE_TIMEOUT_SECONDS` → { seconds, ms, roundedToZero } (plan-900): unset/empty/invalid
 * → the default (600), `0` → disabled (ms 0), fractions allowed. Same shape as the two parsers
 * above, with ONE addition they do not need: in seconds a positive value below 0.0005 rounds to
 * 0 ms and would switch the limit off silently — a plausible typo here, ten thousand times
 * smaller in minutes. `roundedToZero` makes that case sayable instead of silent.
 */
export function fileTimeout(env = process.env) {
  const raw = String(env.RV_TEST_FILE_TIMEOUT_SECONDS ?? '').trim();
  const value = raw === '' ? NaN : Number(raw);
  const seconds = Number.isFinite(value) && value >= 0 ? value : DEFAULT_FILE_TIMEOUT_SECONDS;
  const ms = Math.round(seconds * 1000);
  return { seconds, ms, roundedToZero: seconds > 0 && ms === 0 };
}

/**
 * Per-file overrides of the per-file limit (plan-900 A8/E20): `{ glob, seconds, why }` rows,
 * first match wins. DELIBERATELY EMPTY — this phase builds the hook, not the table, so a later
 * exception (a `tests/_spike-` glob with a VALUE, never "off") is a data change and not a change to
 * the clock. `0` in a row disables the limit for that glob and needs the same justification as
 * any other value.
 */
export const FILE_TIMEOUT_OVERRIDES = [];

/**
 * `glob` → RegExp over a `/`-normalised spec: `**` any depth, `*` within one segment, a trailing
 * `/` is a prefix.
 *
 * Two details that are not cosmetic (plan-900 F5):
 *   - `?` is ESCAPED, not treated as a wildcard. Left unescaped it becomes the regex quantifier,
 *     and `tests/a?.test.ts` then matched `tests/a.test.ts` as well — a glob that silently covers
 *     a file nobody named. It is escaped rather than turned into `[^/]` deliberately: these globs
 *     address real spec paths, where a single-character wildcard has no use, and a NEW wildcard
 *     would widen the set of files an override can switch a limit off for.
 *   - `/**` + `/` spans ZERO or more segments, as standard glob does, so `tests/**` + `/a.test.ts`
 *     also matches `tests/a.test.ts`. Mapping `**` to `.*` alone demanded both slashes and missed
 *     it. Safe to change today because both tables that use these globs (`FILE_TIMEOUT_OVERRIDES`
 *     here, `scripts/test-exclusions.txt`) are empty.
 */
const GLOB_ANY_DEPTH = '\u0000'; // a `**` that is not between two slashes
const GLOB_ANY_SEGMENTS = '\u0001'; // a whole `/**` + `/`
const globSegment = (part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&').split('*').join('[^/]*');
/** The regex BODY of a glob (no anchors), shared by both glob compilers. */
export function globRegExpBody(glob) {
  let pattern = String(glob).replace(/\\/g, '/');
  if (pattern.endsWith('/')) pattern += '**';
  return pattern
    .split('/**/').join(GLOB_ANY_SEGMENTS)
    .split('**').join(GLOB_ANY_DEPTH)
    .split(GLOB_ANY_SEGMENTS)
    .map((chunk) => chunk.split(GLOB_ANY_DEPTH).map(globSegment).join('.*'))
    .join('/(?:.*/)?');
}

export function specGlobToRegExp(glob) {
  return new RegExp(`^${globRegExpBody(glob)}$`);
}

/**
 * Override rows whose `seconds` cannot be a limit — not a finite number (a missing field, `'15
 * min'`, `'Infinity'`) or negative (plan-900 F1).
 *
 * This existed as a SILENT hole: `Math.round(Number(row.seconds) * 1000)` yielded `NaN`, and
 * `expired()` skips every entry with `!(entry.limitMs > 0)`, so one mistyped or incomplete row
 * freed its whole glob from the per-file limit permanently and without a word. That is the same
 * class `roundedToZero` was built against, on the other input path — and A8 exists precisely so
 * that someone fills this table later.
 */
export function invalidOverrides(overrides = FILE_TIMEOUT_OVERRIDES) {
  return (overrides ?? []).filter((row) => {
    const seconds = Number(row?.seconds);
    return !Number.isFinite(seconds) || seconds < 0;
  });
}

/**
 * The WARNING lines for a broken override table (plan-900 F1), as text, so the wording is testable
 * without a table in production. A warning + fallback to the default, not a hard abort, on purpose:
 * an unusable `RV_TEST_FILE_TIMEOUT_SECONDS` already falls back to the default rather than refusing
 * to run, so the table behaves like the environment variable; a typo in an exception table must not
 * turn every test run on every machine red (the fail-loud-never-fail-closed rule E17 follows for
 * the progress file); and the default is strictly SAFER than the status quo, which was no limit at
 * all. The line is printed by the holding wrapper, where the disabled-clock warnings live, so it is
 * impossible to miss.
 */
export function overrideWarnings(overrides = FILE_TIMEOUT_OVERRIDES, defaultSeconds = DEFAULT_FILE_TIMEOUT_SECONDS) {
  return invalidOverrides(overrides).map((row) => `FILE_TIMEOUT_OVERRIDES row ${row?.glob} has an unusable seconds value (${JSON.stringify(row?.seconds)}) — that glob falls back to the default ${defaultSeconds} s instead of running WITHOUT a per-file limit; fix the row`);
}

/**
 * The limit in ms for `spec`: the first matching override, else `defaultMs`. An override with an
 * unusable `seconds` (see `invalidOverrides`) does NOT free its glob from the limit — it falls back
 * to `defaultMs` and reports `invalid`, so a broken row is a warning, never a hole.
 */
export function limitFor(spec, { defaultMs, overrides = FILE_TIMEOUT_OVERRIDES } = {}) {
  for (const row of overrides) {
    if (typeof spec === 'string' && specGlobToRegExp(row.glob).test(spec)) {
      const seconds = Number(row.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) {
        return { ms: defaultMs, source: null, invalid: { glob: row.glob, seconds: row.seconds } };
      }
      return { ms: Math.round(seconds * 1000), source: row.glob };
    }
  }
  return { ms: defaultMs, source: null };
}

/**
 * The three clock states (plan-2046). The abort clocks exist for the case that a run hangs
 * UNNOTICED and holds the lock for hours — a case that only arises when nobody is watching. With
 * a human in front of the run, the human IS the watchdog: they abort at once and file-exactly,
 * because they read the output. For them a clock that shoots the run out from under their hands
 * after ten minutes is pure damage, and a false alarm costs the whole run its summary.
 *
 * - `off` (the interactive default): NONE of the three abort clocks (125 / 126 / 123) is armed.
 *   The maximum run time (124) and the test lock are NOT clocks in this sense and stay active in
 *   every state — the test lock is a resource lock, and 124 is the hard bound on lock holding.
 * - `unattended` (`RV_TEST_UNATTENDED=1`): all three are armed with today's semantics.
 * - `legacy` (`RV_TEST_LEGACY_CLOCKS=1`): the rollback. Restores the behaviour that existed
 *   before this switch for EVERY run, with or without the switch, and it beats
 *   `RV_TEST_UNATTENDED`. One variable for the whole old behaviour, so a rollback does not have to
 *   be assembled from parts.
 *
 * `unattended` and `legacy` are deliberately IDENTICAL in arming and measurement here: this phase
 * only decides WHETHER the clocks are armed, it does not touch what they measure. That keeps the
 * armed state at the behaviour that has been running for weeks, and leaves `legacy` as the one
 * switch that undoes this change completely.
 */
export const CLOCK_MODE = { OFF: 'off', UNATTENDED: 'unattended', LEGACY: 'legacy' };
const TRUTHY = new Set(['1', 'true', 'on']);
const FALSY = new Set(['', '0', 'false', 'off']);

/**
 * `RV_TEST_LEGACY_CLOCKS` / `RV_TEST_UNATTENDED` → `{ mode, warnings }`. `1`/`true`/`on` switch
 * on; unset, empty and `0`/`false`/`off` switch off; legacy beats unattended. An UNPARSABLE value
 * counts as OFF and produces a warning: a typo must not silently leave an unattended run without
 * protection, and must not silently shoot an interactive run down either — the line is the way out
 * of both.
 */
export function clockMode(env = process.env) {
  const warnings = [];
  const read = (name) => {
    const raw = String(env[name] ?? '').trim().toLowerCase();
    if (TRUTHY.has(raw)) return true;
    if (FALSY.has(raw)) return false;
    warnings.push(`${name}=${JSON.stringify(String(env[name]))} is not a recognised value (use 1, true, on — or 0 for off) — treated as OFF`);
    return false;
  };
  const legacy = read('RV_TEST_LEGACY_CLOCKS');
  const unattended = read('RV_TEST_UNATTENDED');
  return { mode: legacy ? CLOCK_MODE.LEGACY : unattended ? CLOCK_MODE.UNATTENDED : CLOCK_MODE.OFF, warnings };
}

/**
 * THE precedence rule between the two silence clocks (plan-900 F6, extended by plan-2046): the
 * stall limit (123) is in charge only while the per-file limit (126) is switched off — and, in the
 * `off` state, NEVER, because there a switched-off 126 is a DECISION and not a failure.
 *
 * This second half is the sharpest edge of the whole change. The old rule was `!(perFileMs > 0)`,
 * which arms 123 exactly when 126 is off. Switching 126 off without touching this function would
 * therefore arm 123 in every interactive run, and an interactive `npm test` would die of exit 123
 * after ten minutes of silence — worse than before and the exact inversion of the decision.
 */
export function stallIsResponsible(perFileMs, mode = CLOCK_MODE.LEGACY) {
  if (mode === CLOCK_MODE.OFF) return false;
  return !(perFileMs > 0);
}

/**
 * The ONE place that decides which clocks are armed in this run (plan-2046): mode, the parsed
 * values and the armed milliseconds per clock, in one object, so the decision is not spread over
 * `if`s at the use sites. In the `off` state all three are 0 — the single-clock variables still
 * parse and are reported, but they do NOT arm anything on their own; an interactive session that
 * wants a clock takes `RV_TEST_UNATTENDED=1` (or `RV_TEST_LEGACY_CLOCKS=1`), which is one word
 * instead of a second, half-armed state nobody can keep in their head.
 */
export function clockState(env = process.env) {
  const { mode, warnings } = clockMode(env);
  const startup = startupTimeout(env);
  const stall = stallTimeout(env);
  const perFile = fileTimeout(env);
  const armedMode = mode !== CLOCK_MODE.OFF;
  const perFileMs = armedMode ? perFile.ms : 0;
  return {
    mode,
    warnings,
    startup,
    stall,
    perFile,
    runtime: maxRuntime(env),
    armed: {
      startupMs: armedMode ? startup.ms : 0,
      perFileMs,
      stallMs: stallIsResponsible(perFileMs, mode) ? (armedMode ? stall.ms : 0) : 0,
    },
  };
}

/**
 * The state line for EVERY run of the holding wrapper (plan-2046 F-B4). Without it nobody can tell
 * afterwards which protection a given run had — the same lesson as the disabled-clock warnings
 * below: one line at the start settles in seconds what otherwise costs hours of diagnosis.
 */
export function clockSummary(state) {
  const { armed } = state;
  const secs = (ms) => `${(ms / 1000).toFixed(3).replace(/\.?0+$/, '')} s`;
  const names = [
    [armed.startupMs > 0, `startup ${secs(armed.startupMs)} (125)`],
    [armed.perFileMs > 0, `per-file ${secs(armed.perFileMs)} (126)`],
    [armed.stallMs > 0, `stall ${secs(armed.stallMs)} (123)`],
  ].filter(([on]) => on).map(([, text]) => text);
  const tail = state.runtime.ms > 0
    ? `maximum run time ${state.runtime.minutes} min (124) and the test lock stay active`
    : 'maximum run time DISABLED (124) — only the test lock is left';
  if (state.mode === CLOCK_MODE.OFF) {
    return `clocks: INTERACTIVE — no abort clock armed (125/126/123 off); ${tail}; an unattended run sets RV_TEST_UNATTENDED=1`;
  }
  const source = state.mode === CLOCK_MODE.LEGACY ? 'RV_TEST_LEGACY_CLOCKS' : 'RV_TEST_UNATTENDED';
  return `clocks: ${state.mode.toUpperCase()} (${source}) — armed: ${names.length ? names.join(', ') : 'none (all switched off per clock)'}; ${tail}`;
}

/**
 * Pure per-FILE bookkeeping of the holding wrapper (plan-900): an IN-FLIGHT MAP keyed by
 * `(pid, spec)` — never by `spec` alone, or the `file-end` of one process would delete the
 * entry of another process running the same spec, and an aborted earlier run would leave an
 * inherited deadline (E9, X6). Times are the WRAPPER's receipt times, never `rec.t` (E16): the
 * child stamps `t` before writing, so a late-appended older record could otherwise turn a clock
 * back. Due is the file whose OWN deadline is exceeded (the oldest of several), and only that
 * file is named. `expired()` evaluates the map FIRST; the inactivity variant (A3b) fires only
 * when the map is EMPTY and uses the SAME limit — with that, "inactivity due and map not empty"
 * is already the named case (proof in plan-900 E14), not a priority rule.
 */
export function createFileWatch(limitMs, { overrides = FILE_TIMEOUT_OVERRIDES } = {}) {
  const inFlight = new Map(); // `${pid}\u0000${spec}` → { pid, spec, since, limitMs, source }
  const expected = new Set();
  const startedSpecs = new Set();
  const runs = new Set();
  const ended = new Set();
  let armed = false;
  let lastEventAt = 0;
  let lastEvent = null; // { spec, pid, at } of the last FILE event (never of a run event)
  // A COUNTER, not a time: one poll tick hands every record of that read the same receipt time,
  // so "was there another file event since this one" cannot be decided from timestamps — within
  // one tick they are equal. The sequence number says which event was the last one.
  let seq = 0;
  const key = (pid, spec) => `${pid}\u0000${spec}`;
  const clearPid = (pid) => {
    for (const [k, entry] of inFlight) if (entry.pid === pid) inFlight.delete(k);
  };
  return {
    inFlight,
    onRecord(rec, now) {
      const pid = Number(rec?.pid);
      if (!Number.isInteger(pid) || pid <= 0) return;
      // Armed by any record of a reporting vitest process: a hang with no file event at all
      // (A3b/D3) must be covered too, and a runner without records (Playwright) never is. A
      // process that already reported `run-end` cannot re-arm it, so watch-mode reruns and
      // watch-mode idling are exempt — the same rule the stall limit follows.
      if (ended.has(pid)) return;
      if (rec.ev === 'run-start' || rec.ev === 'expect' || rec.ev === 'module-start' || rec.ev === 'file-start') {
        if (!armed) { armed = true; lastEventAt = Math.max(lastEventAt, now); }
      }
      if (!armed) return;
      if (rec.ev === 'run-start') {
        runs.add(pid);
        if (Array.isArray(rec.files)) for (const f of rec.files) if (typeof f === 'string' && f) expected.add(f);
      }
      if (rec.ev === 'run-end') {
        ended.add(pid);
        clearPid(pid);
        lastEventAt = Math.max(lastEventAt, now);
        // Every reporting process done: watch-mode idling must not be killed (as the stall limit does).
        if (runs.size && [...runs].every((id) => ended.has(id))) armed = false;
        return;
      }
      const spec = typeof rec.spec === 'string' && rec.spec ? rec.spec : null;
      if (!spec) return;
      if (rec.ev === 'file-start') {
        startedSpecs.add(spec);
        const limit = limitFor(spec, { defaultMs: limitMs, overrides });
        if (!inFlight.has(key(pid, spec))) inFlight.set(key(pid, spec), { pid, spec, since: now, seq: seq + 1, limitMs: limit.ms, source: limit.source });
      } else if (rec.ev === 'file-end') {
        inFlight.delete(key(pid, spec));
      } else return;
      seq += 1;
      lastEventAt = Math.max(lastEventAt, now);
      lastEvent = { spec, pid, at: now };
    },
    prune(isAlive) {
      for (const [k, entry] of inFlight) if (!isAlive(entry.pid)) inFlight.delete(k);
    },
    /** For the 124 message (A3d): what was still open at the cap, and how many files ever started. */
    status() {
      return { open: [...inFlight.values()].map((e) => e.spec), started: startedSpecs.size, expected: expected.size };
    },
    expired(now) {
      if (!(limitMs > 0) || !armed) return null;
      let due = null;
      for (const entry of inFlight.values()) {
        if (!(entry.limitMs > 0) || now - entry.since < entry.limitMs) continue;
        if (!due || entry.since < due.since) due = entry;
      }
      if (due) {
        return {
          kind: 'file', pid: due.pid, spec: due.spec, ranMs: now - due.since, limitMs: due.limitMs,
          source: due.source, sole: seq === due.seq, // its own file-start was the last file event
        };
      }
      // KNOWN LIMITATION of this inactivity clock, measured 2026-10-27 with a 2 s limit (plan-900
      // M3, left open deliberately): it is disarmed only by `run-end`. A vitest process that dies
      // WITHOUT one — a crash, a Ctrl+C, an OOM kill — leaves the watch armed with its last
      // `lastEventAt`, so the window keeps running across the run boundary and the next, healthy
      // run of the same wrapper can be ended by its predecessor's silence. It needs a small limit
      // to matter (at the 600 s default a new run produces a file event long before), which is why
      // it stays a documented edge and not a behaviour change in this phase.
      if (inFlight.size === 0 && now - lastEventAt >= limitMs) {
        return { kind: 'idle', idleMs: now - lastEventAt, last: lastEvent };
      }
      return null;
    },
  };
}

/**
 * Pure silence-window bookkeeping. Receipt times come from the holder, not the child's
 * clock. Every record refreshes the window; only a module/file start arms it. File state
 * is kept per process so parallel projects cannot finish each other's files. A process
 * that ended its first run cannot re-arm the watch with watch-rerun file events (the
 * reporter deliberately sends run-start/run-end only once per process).
 */
export function createStallWatch(limitMs) {
  const runs = new Set();
  const ended = new Set();
  const files = new Map();
  let armed = false;
  let lastAt = 0;
  let last = null;
  return {
    onRecord(rec, now) {
      lastAt = now;
      last = { ev: rec?.ev, file: rec?.file, t: now };
      const pid = Number(rec?.pid);
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (rec.ev === 'run-start') runs.add(pid);
      if (rec.ev === 'run-end') ended.add(pid);
      if (!ended.has(pid)) {
        if (!files.has(pid)) files.set(pid, new Map());
        const state = files.get(pid);
        if (rec.ev === 'run-start' && Array.isArray(rec.files)) {
          for (const file of rec.files) if (typeof file === 'string' && file && !state.has(file)) state.set(file, 'expected');
        }
        // A `spec`-bearing file-start is plan-900's per-file event from `onTestModuleQueued`; it
        // must NOT arm this window earlier than plan-617's `onTestModuleStart` did.
        if (rec.ev === 'module-start' || (rec.ev === 'file-start' && rec.spec === undefined)) armed = true;
        if (typeof rec.file === 'string' && rec.file) {
          if (rec.ev === 'file-start') state.set(rec.file, 'started');
          if (rec.ev === 'file-end') state.set(rec.file, 'finished');
        }
      }
      if (runs.size && [...runs].every((id) => ended.has(id))) armed = false;
    },
    expired(now) {
      if (!(limitMs > 0) || !armed || now - lastAt < limitMs) return null;
      const started = new Set();
      const expected = new Set();
      const finished = new Set();
      for (const [pid, state] of files) {
        if (ended.has(pid)) continue;
        for (const [file, status] of state) {
          (status === 'started' ? started : status === 'finished' ? finished : expected).add(file);
        }
      }
      return { idleMs: now - lastAt, last, started: [...started],
        notStarted: [...expected].filter((file) => !started.has(file) && !finished.has(file)) };
    },
  };
}

/** True for a runner that starts vitest: `vitest`, or a resolved CLI file named `vitest.mjs`. */
export function isVitestRunner(runner, cli = '') {
  return runner === 'vitest' || path.basename(String(cli)).toLowerCase() === 'vitest.mjs';
}

/**
 * Startup-window bookkeeping of the holding wrapper (pure; times are passed in). Keys are
 * pids. `open(pid, since, cause)` opens a window unless that pid already finished;
 * `onRecord(rec, now)` applies one progress record — a `run-start` whose `ppid` has an open
 * window (its re-entering wrapper's `expect`, or the holder's own child) takes that window
 * over with its original start time; `module-start` / `first-test` / `run-end` close that
 * process's window; `prune(isAlive)` closes windows of processes that are
 * gone; `expired(now)` → the first window open for `limitMs` or longer, else null.
 */
export function createStartupWatch(limitMs) {
  const pending = new Map(); // pid → { since, cause }
  const done = new Set();
  const close = (pid) => { pending.delete(pid); done.add(pid); };
  const open = (pid, since, cause) => {
    if (!done.has(pid) && !pending.has(pid)) pending.set(pid, { since, cause });
  };
  return {
    pending,
    open,
    onRecord(rec, now) {
      const pid = Number(rec?.pid);
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (rec.ev === 'expect') {
        open(pid, now, `vitest wrapper start, PID ${pid}`);
      } else if (rec.ev === 'run-start') {
        if (done.has(pid) || pending.has(pid)) return;
        const ppid = Number(rec.ppid);
        const parent = pending.get(ppid);
        if (parent) {
          close(ppid);
          pending.set(pid, parent);
        } else {
          pending.set(pid, { since: now, cause: `vitest run start, PID ${pid}` });
        }
      } else if (rec.ev === 'module-start' || rec.ev === 'first-test' || rec.ev === 'run-end'
        || (rec.ev === 'file-start' && rec.spec === undefined)) {
        // A `spec`-bearing file-start is plan-900's per-file event from `onTestModuleQueued`,
        // which fires BEFORE the import. Closing the startup window on it would hand every
        // import hang from the 125 window (300 s) to the per-file limit (600 s) and change
        // plan-617's behaviour; the per-file limit is an ADDITION, not a replacement.
        close(pid);
      }
    },
    prune(isAlive) {
      for (const pid of [...pending.keys()]) if (!isAlive(pid)) close(pid);
    },
    expired(now) {
      if (!(limitMs > 0)) return null;
      for (const [pid, entry] of pending) if (now - entry.since >= limitMs) return { pid, ...entry };
      return null;
    },
  };
}

/** The complete JSON lines appended to `file` since byte `offset` → { records, offset }. */
export function readProgress(file, offset = 0) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size <= offset) return { records: [], offset };
    const buffer = Buffer.alloc(size - offset);
    const n = readSync(fd, buffer, 0, buffer.length, offset);
    const end = buffer.subarray(0, n).lastIndexOf(0x0a);
    if (end < 0) return { records: [], offset }; // no complete line yet
    const records = [];
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
    }
    return { records, offset: offset + end + 1 };
  } catch {
    return { records: [], offset };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Strips one leading `--` (`with-test-lock -- vitest run`). */
export function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === '--') args.shift();
  const [runner, ...rest] = args;
  return { runner, args: rest };
}

async function main() {
  const { runner, args } = parseArgs(process.argv.slice(2));
  if (!runner) {
    say('usage: node scripts/with-test-lock.mjs [--] <vitest|playwright|path/to/script.mjs> [args…]');
    return 2;
  }

  let cli;
  try {
    cli = resolveRunner(runner);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!existsSync(cli)) {
    say(`runner not found: ${cli}`);
    return 1;
  }

  const config = lockConfig();
  const env = { ...process.env };
  let lock = null;
  const heldBy = Number(process.env.RV_TEST_LOCK_HELD);

  if (config.disabled) {
    say('RV_TEST_LOCK=off — running without the machine-wide test lock');
  } else if (Number.isInteger(heldBy) && heldBy > 0 && heldBy !== process.pid && isProcessAlive(heldBy)) {
    say(`re-entering — lock held by live PID ${heldBy}, no bind, environment unchanged`);
    { const patch = reentryEnvFor(process.env); Object.assign(env, patch.set); for (const key of patch.unset) delete env[key]; }
    // Tells the holder a vitest run is coming, so its startup limit gives this run a window.
    if (isVitestRunner(runner, cli)) writeProgress(process.env[PROGRESS_ENV], 'expect');
  } else {
    const klass = classifyRun(runner, args, process.env);
    try {
      lock = await acquireClass({ klass, info: holderInfo([runner, ...args], { class: klass }), port: config.port });
    } catch (error) {
      say(error instanceof Error ? error.message.replace(/^\[test-lock\] /, '') : String(error));
      return 1;
    }
    say(`acquired ${LOCK_HOST}:${lock.port} (PID ${process.pid})`);
    const patch = childEnvFor(klass, process.env);
    Object.assign(env, patch.set);
    for (const key of patch.unset) delete env[key];
    say(`class ${klass}, workers ${env.VITEST_MAX_WORKERS ?? 'default'}, capacity ${capacityMode(process.env)}`);
    env.RV_TEST_LOCK_HELD = String(process.pid);
    env.RV_TEST_LOCK_PARENT_PID = String(process.pid);
    env.NODE_OPTIONS = withWatchdog(process.env.NODE_OPTIONS);
  }

  // Progress limits — only the holding wrapper owns a progress file and watches it.
  // plan-2046: WHETHER they are armed is decided once, in `clockState()`.
  const clocks = clockState();
  const { startup, stall, perFile, runtime } = clocks;
  // A clock that is OFF must say so in EVERY log, including a green run. Evidence (2026-10-27): a
  // wrapped run hung for 33 minutes without any limit firing, and because the switch-off lived in
  // an environment variable in someone's shell it cost two sessions several hours of diagnosis
  // and produced a wrong defect report. One line at the start would have settled it in seconds.
  // Only the HOLDING wrapper enforces these clocks, so only it warns, and a clock that runs
  // normally says nothing — otherwise the line becomes noise and nobody reads it.
  // F6: exactly one silence clock is in charge, and it is decided here, not by evaluation order.
  // IN CHARGE, not ARMED: with an explicit `RV_TEST_STALL_MINUTES=0` 123 is in charge AND
  // switched off, which is exactly the case the warning below exists for.
  const stallActive = stallIsResponsible(clocks.armed.perFileMs, clocks.mode);
  if (lock) {
    // plan-2046 F-B4: the state of this run, in every run, green ones included.
    say(clockSummary(clocks));
    for (const text of clocks.warnings) say(`WARNING: ${text}`);
    // In the INTERACTIVE state all three abort clocks are off BY DECISION, so the lines below
    // would be three warnings about an intended state in every single run — the fastest way to
    // teach everyone to stop reading them. The state line above already says it.
    const off = clocks.mode === CLOCK_MODE.OFF ? [] : [
      [startup.ms <= 0, `startup window DISABLED (RV_TEST_STARTUP_TIMEOUT_SECONDS=${startup.seconds}) — a run that never reports a module event will not be ended (exit 125)`],
      [perFile.ms <= 0, `per-file limit DISABLED (RV_TEST_FILE_TIMEOUT_SECONDS=${perFile.seconds}) — a single file that hangs will not be named or ended (exit 126); the stall limit (exit 123) is the fallback`],
      // Only warned about while it IS the clock in charge: with 126 active the stall limit is
      // dormant BY DESIGN (F6), and a line about it would be noise in every normal run.
      [stallActive && stall.ms <= 0, `stall limit DISABLED (RV_TEST_STALL_MINUTES=${stall.minutes}) — silence after a file has started will not be ended (exit 123)`],
    ];
    // The cap is the one bound that holds in EVERY state, so its absence is warned about in every
    // state too — in the interactive state it is the only thing left besides the test lock.
    off.push([runtime.ms <= 0, `maximum run time DISABLED (RV_TEST_MAX_RUNTIME_MINUTES=${runtime.minutes}) — nothing will end this run, and it holds the lock while it lasts (exit 124)`]);
    for (const [disabled, text] of off) if (disabled) say(`WARNING: ${text}`);
    for (const text of overrideWarnings(FILE_TIMEOUT_OVERRIDES, perFile.seconds)) say(`WARNING: ${text}`);
    if (clocks.armed.perFileMs <= 0 && perFile.roundedToZero && clocks.mode !== CLOCK_MODE.OFF) {
      // Switched off by ACCIDENT, which deserves the louder line: in seconds a value below
      // 0.0005 rounds to 0 ms, and that is a plausible typo (plan-900 § 1.2).
      say(`WARNING: RV_TEST_FILE_TIMEOUT_SECONDS=${perFile.seconds} rounds to 0 ms — the per-file limit is OFF BY ACCIDENT; use 0 to mean off, or a value of at least 0.001`);
    }
  }
  let progressFile = null;
  /** E17/A5c: set when the per-file limit was never armed because no progress file exists. */
  let perFileUnarmed = '';
  if (lock || config.disabled) delete env[PROGRESS_ENV]; // a stale inherited path must not collect records
  if (lock && (clocks.armed.startupMs > 0 || clocks.armed.stallMs > 0 || clocks.armed.perFileMs > 0)) {
    const candidate = path.join(os.tmpdir(), `rv-test-lock-progress-${process.pid}-${Date.now()}.jsonl`);
    try {
      writeFileSync(candidate, '');
      progressFile = candidate;
      env[PROGRESS_ENV] = progressFile;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      perFileUnarmed = `no progress file: ${reason}`;
      // Fail LOUD, never fail-closed: a %TEMP% error must not make every test run red (E17).
      say(`progress limits off — the startup limit (125), the stall limit (123) and the per-file limit (126) are all inactive in this run — cannot create ${candidate}: ${reason}`);
    }
  }

  // POSIX, non-interactive: own process group, so a forwarded signal reaches the whole tree.
  // Interactive (TTY stdin) the child stays in the foreground group, or it could not read the
  // terminal (watch keys) — the terminal then delivers Ctrl+C to it directly.
  const detached = process.platform !== 'win32' && !process.stdin.isTTY;
  // Measurement only (the reporter's `[test-progress]` line): every wrapper — holding,
  // re-entering or lock-off — stamps its own child's spawn time.
  env[WRAPPER_SPAWN_ENV] = String(Date.now());
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', env, detached, windowsHide: false });

  let aborting = false;
  let killTimer = null;
  const hardKill = () => {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(detached ? -child.pid : child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  };
  const onSignal = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (aborting) {
      say(`${signal} again — killing child tree ${child.pid} now`);
      hardKill();
      return;
    }
    aborting = true;
    if (process.platform === 'win32') {
      // A console event: the child received the same event through the shared console.
      say(`${signal} — waiting up to ${SIGNAL_GRACE_MS / 1000} s for child ${child.pid}, then taskkill /T /F`);
    } else {
      const forward = detached || signal !== 'SIGINT';
      if (forward) {
        try { process.kill(detached ? -child.pid : child.pid, signal); } catch { /* already gone */ }
      }
      say(`${signal} — ${forward ? 'forwarded, ' : ''}waiting up to ${SIGNAL_GRACE_MS / 1000} s for child ${child.pid}, then SIGKILL`);
    }
    killTimer = setTimeout(hardKill, SIGNAL_GRACE_MS);
  };
  // Maximum run time — only the wrapper that actually holds the lock enforces it.
  let limitExit = null;
  let limitCause = '';
  let runtimeTimer = null;
  let fileWatch = null; // plan-900; also read by the 124 message (A3d)
  const limit = runtime;
  if (lock && limit.ms > 0) {
    const startedAt = new Date().toISOString(); // the run start (the child was just spawned)
    runtimeTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null || limitExit !== null) return;
      limitExit = MAX_RUNTIME_EXIT_CODE;
      limitCause = `run exceeded RV_TEST_MAX_RUNTIME_MINUTES=${limit.minutes}`;
      // A3d: a run that falls into the cap DESPITE the per-file limit is no longer mute — what
      // was still in flight, and how many files ever reached a `file-start`.
      const state = fileWatch?.status();
      const note = state
        ? `; in-flight files: ${state.open.length ? `${state.open.slice(0, 10).join(', ')}${state.open.length > 10 ? ` (+${state.open.length - 10} more)` : ''}` : 'none'}; files with a file-start: ${state.started}/${state.expected || 'unknown'}`
        : `; note: the per-file limit was not active in this run${perFileUnarmed ? ` (${perFileUnarmed})` : ''}`;
      say(`run exceeded RV_TEST_MAX_RUNTIME_MINUTES=${limit.minutes} (started ${startedAt}, argv ${[runner, ...args].join(' ')}) — ending the test tree and releasing the lock${note}`);
      hardKill();
    }, limit.ms);
    runtimeTimer.unref(); // never keeps the wrapper alive on its own; the child's exit does
  }

  // Startup, per-file and stall limits — polled here, in the wrapper, never in vitest.
  let progressTimer = null;
  if (progressFile) {
    const watch = createStartupWatch(clocks.armed.startupMs);
    // F6: a 0 here is what "the per-file limit owns silence" MEANS — the stall watch is not armed,
    // so its place in the checks below is irrelevant to the outcome.
    const stallWatch = createStallWatch(clocks.armed.stallMs);
    fileWatch = createFileWatch(clocks.armed.perFileMs);
    if (isVitestRunner(runner, cli)) watch.open(child.pid, Date.now(), 'the vitest start');
    let offset = 0;
    progressTimer = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null || limitExit !== null) return;
      const now = Date.now();
      const read = readProgress(progressFile, offset);
      offset = read.offset;
      for (const rec of read.records) {
        watch.onRecord(rec, now);
        stallWatch.onRecord(rec, now);
        fileWatch.onRecord(rec, now);
      }
      watch.prune((pid) => pid === child.pid || isProcessAlive(pid));
      fileWatch.prune((pid) => pid === child.pid || isProcessAlive(pid));
      const hit = watch.expired(now);
      if (!hit) {
        // The per-file limit is evaluated BEFORE the stall limit, so a file that is over its own
        // budget is named even when both clocks come due in the same tick (A3c/E14). Since F6 that
        // order is a convenience, not the rule: while 126 is active the stall watch is built with a
        // limit of 0 and `stallWatch.expired()` is always null, so swapping these two checks cannot
        // change what happens. The rule itself is `stallIsResponsible()`.
        const file = fileWatch.expired(now);
        if (file) {
          limitExit = FILE_TIMEOUT_EXIT_CODE;
          if (file.kind === 'file') {
            const ran = (file.ranMs / 1000).toFixed(1);
            const budget = `${(file.limitMs / 1000).toFixed(3).replace(/\.?0+$/, '')} s${file.source ? ` via the override ${file.source}` : ''}`;
            const sole = file.sole ? ' (no other file event since its start — a second, unnamed stall is not excluded; see plan-900 F6)' : '';
            limitCause = `${file.spec} ran for RV_TEST_FILE_TIMEOUT_SECONDS=${perFile.seconds} (${ran} s, budget ${budget}, PID ${file.pid})${sole}`;
          } else {
            const last = file.last ? `${file.last.spec} @ ${new Date(file.last.at).toISOString()}` : 'none in this run';
            limitCause = `no test file event for RV_TEST_FILE_TIMEOUT_SECONDS=${perFile.seconds} (${(file.idleMs / 1000).toFixed(1)} s; last file event: ${last}) — the stalled file is NOT named; see plan-900 F6`;
          }
          say(`${limitCause} — ending the test tree and releasing the lock; RV_TEST_FILE_TIMEOUT_SECONDS=0 disables this limit`);
          hardKill();
          return;
        }
        const stalled = stallWatch.expired(now);
        if (!stalled) return;
        limitExit = STALL_EXIT_CODE;
        const names = stalled.started.slice(0, 10).join(', ');
        const more = stalled.started.length - 10;
        const unfinished = names ? `${names}${more > 0 ? ` (+${more} more)` : ''}`
          : 'none (hang outside a file: collection, a hook between files, or teardown)';
        limitCause = `no test progress for ${(stalled.idleMs / 60_000).toFixed(1)} min (RV_TEST_STALL_MINUTES=${stall.minutes}; last event ${stalled.last.ev}${stalled.last.file ? ` ${stalled.last.file}` : ''} at ${new Date(stalled.last.t).toISOString()}) — files started but not finished: ${unfinished}; not started: ${stalled.notStarted.length}${stalled.notStarted.length ? ` (${stalled.notStarted.slice(0, 5).join(', ')}${stalled.notStarted.length > 5 ? ', …' : ''})` : ''}`;
        say(`${limitCause} — ending the test tree and releasing the lock; RV_TEST_STALL_MINUTES=0 disables this limit`);
        hardKill();
        return;
      }
      limitExit = STARTUP_TIMEOUT_EXIT_CODE;
      limitCause = `no test file started within RV_TEST_STARTUP_TIMEOUT_SECONDS=${startup.seconds}`;
      const waited = ((now - hit.since) / 1000).toFixed(1);
      say(`no test file started within RV_TEST_STARTUP_TIMEOUT_SECONDS=${startup.seconds} (waited ${waited} s since ${hit.cause}, argv ${[runner, ...args].join(' ')}) — ending the test tree and releasing the lock; RV_TEST_STARTUP_TIMEOUT_SECONDS=0 disables this limit`);
      hardKill();
    }, PROGRESS_POLL_MS);
    progressTimer.unref();
  }

  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, () => onSignal(signal));

  const code = await new Promise((resolveCode) => {
    child.once('error', (error) => {
      say(`spawn error: ${error.message}`);
      resolveCode(1);
    });
    child.once('exit', (exitCode, signal) => resolveCode(exitCodeFor(exitCode, signal)));
  });
  if (killTimer) clearTimeout(killTimer);
  if (runtimeTimer) clearTimeout(runtimeTimer);
  if (progressTimer) clearInterval(progressTimer);
  if (progressFile) {
    try { rmSync(progressFile, { force: true }); } catch { /* temp file, best effort */ }
  }
  const result = limitExit ?? code;

  if (lock) {
    await lock.release();
    say(`released ${LOCK_HOST}:${lock.port} (child exit ${code})`);
  }
  if (limitExit !== null) say(`FAILED (exit ${result}): ${limitCause}`);
  return result;
}

if (isEntryScript(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      say(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
