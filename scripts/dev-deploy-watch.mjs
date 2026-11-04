// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * dev-deploy-watch.mjs — automatic /dev deploys (plan-488).
 *
 * A scheduled task in the developer's Windows session runs this script every 3 minutes. Each
 * tick fetches `origin/main` of the WebViewer and the Private repo into two watcher-owned
 * clones, and when the SHA pair moved it publishes that exact pair to
 * `https://web.realvirtual.io/dev/` by running `scripts/bunny-deploy.mjs --demo --path dev`
 * FROM THE CLONE as a non-detached child process.
 *
 * Self-contained on purpose (plan-488 §2.7): only `node:` imports plus `./rv-publish-lock.mjs`,
 * `./rv-notify.mjs` (plan-503) and `./lib/rv-proc.mjs` + `./lib/rv-dotenv.mjs` (plan-587) — all of
 * them copied by `--install`, which since plan-587 also creates the `lib\` subfolder under
 * `<root>\bin\`. The
 * task runs an INSTALLED copy under `<root>\bin\`, so a push that breaks this file can at most
 * fail one deploy, never the watcher itself. Update the copy with `--install`.
 *
 * Demo smoke (plan-503): the deploy child runs the public demo smoke against /dev/ after the purge
 * and exits 3 when the build is live but the smoke is red. The watcher books exit 3 as DEPLOY OK +
 * SMOKE FAILED (no backoff — the pair IS deployed), keeps `lastSmoke` in state.json, shows a
 * Windows notification on the transition to FAILED and keeps the smoke runtime (npm ci +
 * Playwright Chromium) of the web clone current. `--retry-smoke` re-runs only the smoke.
 * `--no-smoke` in `deployArgs` switches all of that off: no runtime refresh, no smoke booking.
 *
 * Load guards (2026-10-25): a tick that WOULD deploy is deferred — no attempt used, no backoff,
 * just a `DEFER …` line and the next tick tries again — while a foreign process holds the
 * machine-wide test lock (`scripts/test-lock.mjs`, port 47177) or while free physical memory is
 * below `minFreeMemoryMb` (default 3072), or the CPU is busier than `maxCpuPercent` (85) over a
 * 15 s sample; after `maxDeferMinutes` (60) only low memory still defers. The watcher lowers its own priority to below normal
 * before the deploy (`lowPriority`, default on), and every child — git, npm, Vite — inherits it.
 * `--dev-fast` in `deployArgs` selects the lighter /dev build profile of bunny-deploy.mjs.
 * Each deploy ends with one `TIMING …` line: the watcher's own steps plus the `[timing]` lines
 * the deploy child printed.
 *
 * Usage (see doc-deploy.md § "Automatic /dev deploys"):
 *   node scripts/dev-deploy-watch.mjs --install [--root <dir>] [--credentials <file>]… [--dry-run]
 *   node <root>\bin\dev-deploy-watch.mjs [--config <root>\config.json]      # one tick
 *   node <root>\bin\dev-deploy-watch.mjs --status [--json]
 *   node <root>\bin\dev-deploy-watch.mjs --retry
 *   node <root>\bin\dev-deploy-watch.mjs --retry-smoke                     # smoke only, no deploy
 *   node <root>\bin\dev-deploy-watch.mjs --enable | --disable
 *   node <root>\bin\dev-deploy-watch.mjs --uninstall [--dry-run]           # removes the task only
 *   node <root>\bin\dev-deploy-watch.mjs --purge [--dry-run]               # task + clones + state
 */

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, parse as parsePath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { constants as osConstants, cpus, freemem, setPriority as osSetPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { acquirePublishLock, LOCK_BUSY_CODE } from './rv-publish-lock.mjs';
import { mergeEnv, parseDotEnvText } from './lib/rv-dotenv.mjs';
import { spawnLogged } from './lib/rv-proc.mjs';
import { notifyWindows } from './rv-notify.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);

// ─── Constants ────────────────────────────────────────────────────────────

//! Instance lock of the watcher itself (tick step 1). Distinct from every `rv-publish-…` lock.
export const WATCHER_LOCK_NAME = 'rv-dev-deploy-watcher';
//! Name of the scheduled task `--install` registers.
export const DEFAULT_TASK_NAME = 'rv-dev-deploy-watch';
//! Attempts per SHA pair before the watcher gives up (plan-488 §2.5).
export const MAX_ATTEMPTS = 3;
//! Wait after attempt 1, 2, 3 before the next one may start.
export const BACKOFF_MS = Object.freeze([3 * 60_000, 15 * 60_000, 60 * 60_000]);
//! Limit for each `git fetch` (plan-488 §2.8).
export const FETCH_TIMEOUT_MS = 2 * 60_000;
//! Age above which a git lock file in a clone counts as orphaned (plan-547). A git op in the
//! watcher-only clones takes seconds; a lock older than this was left by a killed git.
export const STALE_LOCK_MINUTES = 10;
//! Consecutive FETCH FAILED ticks after which ONE notification is shown (plan-547).
export const FETCH_FAILURE_NOTIFY_AT = 3;
//! Staging + build limit handed to the deploy child (checked there right before the publish lock).
export const PREPUBLISH_TIMEOUT_SECONDS = 15 * 60;
//! Deadline of the whole deploy child, deliberately far above `PREPUBLISH_TIMEOUT_SECONDS`
//! (plan-587 F4, armed in Phase 4).
//!
//! It is NOT a build budget — the child enforces that itself right before the publish lock, and
//! does it better, because it knows what it is doing. This is the backstop for a child that
//! HANGS and therefore never reaches its own check: without it a wedged `npm ci` or a stalled
//! upload socket blocked every further deploy until somebody noticed.
//!
//! Generous on purpose: 45 minutes is roughly three times the longest healthy run, so a slow
//! machine never meets it. And it can only ever kill during the `build` phase the child reports
//! in `deployPhaseFile` — in `upload`, `published` or `smoke` the verdict is "do not kill", a
//! line in the log and continued watching. A phase file that is missing or unreadable counts as
//! "do not kill" too.
export const DEPLOY_TIMEOUT_MS = 45 * 60_000;
//! Credential keys without which no deploy starts. Only their PRESENCE is ever logged.
export const REQUIRED_CREDENTIALS = Object.freeze(['BUNNY_STORAGE_KEY', 'BUNNY_STORAGE_ZONE']);
//! Credential keys whose presence is logged but not required (purge is skipped without them).
export const OPTIONAL_CREDENTIALS = Object.freeze(['BUNNY_ACCOUNT_KEY', 'BUNNY_PULL_ZONE_ID']);
//! What the deploy child is started with. `--dev-fast` = the lighter /dev build profile; remove it
//! from `deployArgs` in config.json to build /dev exactly like /demo again.
export const DEFAULT_DEPLOY_ARGS = Object.freeze(['--demo', '--path', 'dev', '--dev-fast']);
//! Free physical memory below which a deploy is deferred to the next tick (`minFreeMemoryMb`, 0 = off).
export const DEFAULT_MIN_FREE_MEMORY_MB = 3072;
//! Machine-wide CPU busy share above which a deploy is deferred (`maxCpuPercent`, 0 = off), and
//! the window it is measured over (`cpuSampleMs`) — a short spike must not defer a deploy.
export const DEFAULT_MAX_CPU_PERCENT = 85;
export const DEFAULT_CPU_SAMPLE_MS = 15_000;
//! After this long deferring the same pair, the test lock and the CPU stop deferring it
//! (`maxDeferMinutes`); low memory always defers.
export const DEFAULT_MAX_DEFER_MINUTES = 60;
//! Port of the machine-wide test lock (`scripts/test-lock.mjs`; `RV_TEST_LOCK_PORT` overrides).
export const DEFAULT_TEST_LOCK_PORT = 47177;
//! Watcher options `--install` carries over from an existing config.json (operator decisions).
export const PRESERVED_CONFIG_KEYS = Object.freeze(['deployArgs', 'lowPriority', 'minFreeMemoryMb', 'deferWhileTestLockHeld', 'testLockPort', 'maxCpuPercent', 'cpuSampleMs', 'maxDeferMinutes', 'prepublishTimeoutSeconds', 'deployTimeoutMs']);
//! Folder names of the two clones — the deploy resolves the private repo as the web clone's sibling.
export const CLONE_DIRS = Object.freeze({ web: 'realvirtual-WebViewer~', private: 'realvirtual-WebViewer-Private~' });

//! Exit code of the deploy child for "deployed, but the demo smoke is red" (plan-503).
export const SMOKE_FAILED_EXIT = 3;
//! Folder of the smoke output (`RV_SMOKE_OUT_DIR`) and of the Playwright browsers, under `<root>`.
export const SMOKE_OUT_DIRNAME = 'last-smoke';
export const BROWSERS_DIRNAME = 'playwright-browsers';
//! Limit of each runtime install step (`npm ci`, `playwright install`).
export const RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60_000;
//! The runtime install, exactly these arguments everywhere (plan-503 A4): `--ignore-scripts`
//! because the postinstall would run `npm ci` in the private sibling clone, which has no `.npmrc`.
export const NPM_CI_ARGS = Object.freeze(['ci', '--ignore-scripts']);
//! Headless runs use only the headless shell (verified for `prod-demo`, plan-503 Phase 4).
export const PLAYWRIGHT_INSTALL_ARGS = Object.freeze(['install', 'chromium', '--only-shell']);
//! Hard limit of a `--retry-smoke` run (the runner itself stops at 10 min).
export const RETRY_SMOKE_TIMEOUT_MS = 12 * 60_000;

//! What `--install` copies into `<root>\bin\` — the watcher and its only three local imports.
//! Entries may carry a `/` (plan-587): the installer creates the target subfolder, so the shared
//! process helper lands at `<root>\bin\lib\rv-proc.mjs` and `./lib/rv-proc.mjs` resolves in the
//! installed copy exactly as it does in the repo. The alternative — a second, NAMED copy of the
//! helper inside this file plus a test comparing it against the lib version — was rejected: it
//! would preserve the duplication this plan removes.
export const INSTALLED_FILES = Object.freeze([
  'dev-deploy-watch.mjs', 'rv-publish-lock.mjs', 'rv-notify.mjs',
  'lib/rv-proc.mjs', 'lib/rv-dotenv.mjs',
]);

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

// ─── Pure decision logic (plan-488 §2.5) ──────────────────────────────────

//! The empty bookkeeping of a first run.
export function freshState() {
  return { version: 1, lastDeployed: null, lastFailed: null, attempt: null, inFlight: null, lastResult: null, lastSmoke: null, runtime: null };
}

//! Whether two `{ web, private }` SHA pairs are identical.
export function samePair(a, b) {
  return !!a && !!b && a.web === b.web && a.private === b.private;
}

const backoffFor = (attempts, backoffMs) => backoffMs[Math.min(Math.max(attempts, 1), backoffMs.length) - 1];

//! Decides what a tick does for the observed `pair`. Pure: state + pair + clock in, decision out.
//!
//! Returns `{ action, reason, state }`:
//! - `none`    — nothing to do (`up-to-date`, `backoff`, `failed`); `state` unchanged.
//! - `give-up` — the attempts are used up and the pair is not yet marked failed; `state` marks it.
//! - `deploy`  — `state` is the RESERVATION to persist before the child starts: attempts + 1,
//!   `nextRetryAt` and `inFlight` already set, so a watcher that dies afterwards has still used
//!   the attempt.
//!
//! A pair other than the tracked one always starts at attempt 1 (a new push resets the counter).
export function decideTick(state, pair, now, { maxAttempts = MAX_ATTEMPTS, backoffMs = BACKOFF_MS } = {}) {
  const current = state ?? freshState();
  if (samePair(current.lastDeployed, pair)) return { action: 'none', reason: 'up-to-date', state: current };
  const tracked = samePair(current.attempt?.pair, pair) ? current.attempt : null;
  const attempts = tracked?.attempts ?? 0;
  if (attempts >= maxAttempts) {
    if (tracked.status === 'failed') return { action: 'none', reason: 'failed', state: current };
    return {
      action: 'give-up',
      reason: 'attempts-exhausted',
      state: { ...current, attempt: { ...tracked, status: 'failed', nextRetryAt: null }, inFlight: null },
    };
  }
  if (tracked?.nextRetryAt != null && now < tracked.nextRetryAt) {
    return { action: 'none', reason: 'backoff', state: current };
  }
  const next = attempts + 1;
  return {
    action: 'deploy',
    reason: tracked ? 'retry' : 'new-pair',
    state: {
      ...current,
      attempt: { pair, attempts: next, status: 'in-flight', startedAt: now, nextRetryAt: now + backoffFor(next, backoffMs) },
      inFlight: { pair, startedAt: now },
    },
  };
}

//! Books the outcome of a deploy that `decideTick` reserved. Success clears the attempt and moves
//! `lastDeployed`; failure keeps the counter, sets the backoff from the END of the attempt, and marks
//! the pair `failed` once the attempts are used up.
//! `smoke` (plan-503) is the smoke outcome of a successful deploy (`lastSmoke` shape) and is booked
//! only with `ok` — a failed deploy leaves the last smoke as it was.
export function recordResult(state, pair, { ok, finishedAt, durationMs = null, exitCode = null, error = null, smoke = null },
  { maxAttempts = MAX_ATTEMPTS, backoffMs = BACKOFF_MS } = {}) {
  const lastResult = { pair, ok, at: finishedAt, durationMs, exitCode, ...(error ? { error } : {}) };
  if (ok) return { ...state, lastDeployed: pair, attempt: null, inFlight: null, lastResult, ...(smoke ? { lastSmoke: smoke } : {}) };
  const attempts = samePair(state.attempt?.pair, pair) ? state.attempt.attempts : 1;
  const failed = attempts >= maxAttempts;
  return {
    ...state,
    attempt: {
      ...(state.attempt ?? {}),
      pair,
      attempts,
      status: failed ? 'failed' : 'backoff',
      nextRetryAt: failed ? null : finishedAt + backoffFor(attempts, backoffMs),
    },
    inFlight: null,
    lastFailed: { pair, at: finishedAt, exitCode, ...(error ? { error } : {}) },
    lastResult,
  };
}

//! `--retry`: resets the counter of the tracked pair. Returns `{ changed, state }`.
export function applyRetry(state) {
  if (!state?.attempt) return { changed: false, state };
  return { changed: true, state: { ...state, attempt: { ...state.attempt, attempts: 0, status: 'pending', nextRetryAt: null }, inFlight: null } };
}

//! One word for `--status`: `idle`, `deployed`, `in-flight`, `backoff`, `pending` or `failed`.
export function summarizeStatus(state) {
  if (state?.attempt) return state.attempt.status;
  return state?.lastDeployed ? 'deployed' : 'idle';
}

// ─── State file (plan-488 §2.5) ───────────────────────────────────────────

const defaultFs = { readFileSync, writeFileSync, renameSync, unlinkSync };

//! Reads `state.json` and distinguishes the three cases a counter must survive:
//! - `missing`  — no file: a fresh state (first run).
//! - `corrupt`  — the file exists but is no valid state: it is renamed to `state.corrupt-<ts>.json`
//!   and a fresh state is returned. A rename that fails is an `io-error`.
//! - `io-error` — reading failed: NO state is returned, the tick must not deploy.
export function readState(statePath, { fs = defaultFs, now = Date.now } = {}) {
  let text;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', state: freshState() };
    return { kind: 'io-error', error };
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { kind: 'ok', state: { ...freshState(), ...parsed } };
  }
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const corruptPath = join(dirname(statePath), `state.corrupt-${stamp}-${randomBytes(2).toString('hex')}.json`);
  try {
    fs.renameSync(statePath, corruptPath);
  } catch (error) {
    return { kind: 'io-error', error };
  }
  return { kind: 'corrupt', state: freshState(), corruptPath };
}

//! Writes `state.json` atomically (temp file + rename). Throws when the state cannot be stored —
//! the caller then starts NO deploy.
export function writeStateAtomic(statePath, state, { fs = defaultFs } = {}) {
  const tmp = `${statePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, statePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
    throw error;
  }
}

// ─── Config, credentials, log ─────────────────────────────────────────────

//! Loads and validates `config.json`. Every path in it is absolute; nothing is derived at runtime
//! (a clone has no `.plastic` ancestor, plan-488 §2.2).
export function loadWatcherConfig(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const missing = ['root', 'nodePath', 'workspaceRoot'].filter((key) => typeof config[key] !== 'string' || !config[key]);
  if (typeof config.clones?.web !== 'string' || typeof config.clones?.private !== 'string') missing.push('clones.web/clones.private');
  if (!Array.isArray(config.credentialsFiles) || config.credentialsFiles.length === 0) missing.push('credentialsFiles');
  if (missing.length) throw new Error(`${configPath}: missing or invalid ${missing.join(', ')}`);
  return {
    watcherLockName: WATCHER_LOCK_NAME,
    taskName: DEFAULT_TASK_NAME,
    deployArgs: [...DEFAULT_DEPLOY_ARGS],
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    staleLockMinutes: STALE_LOCK_MINUTES,
    prepublishTimeoutSeconds: PREPUBLISH_TIMEOUT_SECONDS,
    branch: 'main',
    ...config,
  };
}

export const statePathOf = (config) => join(config.root, 'state.json');
export const logPathOf = (config) => join(config.root, 'watch.log');
export const enabledPathOf = (config) => join(config.root, 'enabled');
export const deployLogPathOf = (config) => join(config.root, 'last-deploy.log');
//! Where the deploy child reports its phase (plan-587 F4). Under `<root>`, not under the child's
//! own `tmpDir()`: the child runs from a CLONE, which has no `.plastic` ancestor of its own, so
//! both sides must agree on ONE path and the watcher is the side that owns a directory. Handed
//! to the child as `RV_DEPLOY_PHASE_FILE` and read by `spawnLogged` when the deadline passes.
export const deployPhaseFileOf = (config) => config.deployPhaseFile ?? join(config.root, 'deploy-phase.json');
//! plan-503: the smoke output dir handed to the deploy child as RV_SMOKE_OUT_DIR, the Playwright
//! browser folder (PLAYWRIGHT_BROWSERS_PATH), and the log of the runtime install / retry-smoke.
export const smokeOutDirOf = (config) => config.smokeOutDir ?? join(config.root, SMOKE_OUT_DIRNAME);
export const browsersPathOf = (config) => config.browsersPath ?? join(config.root, BROWSERS_DIRNAME);
export const runtimeLogPathOf = (config) => join(config.root, 'last-runtime.log');
export const retrySmokeLogPathOf = (config) => join(config.root, 'last-retry-smoke.log');
//! Whether the demo smoke is switched off for this watcher: `deployArgs` carry `--no-smoke`, the
//! flag the deploy child itself honours. ONE switch, read where it acts — no second config key that
//! could disagree with the child. Then the tick neither refreshes the smoke runtime (npm ci +
//! Playwright Chromium) nor books a smoke outcome, and `--retry-smoke` refuses with a message.
export const smokeDisabled = (config) => Array.isArray(config?.deployArgs) && config.deployArgs.includes('--no-smoke');

// ─── Demo smoke outcome (plan-503 §2.6) ───────────────────────────────────

//! Reads `<smokeOutDir>/smoke-result.json` after a deploy (or a --retry-smoke) and turns it into
//! the `lastSmoke` record. Never an optimistic default:
//! - exit 3 without a readable result            → failed, reason report-unreadable;
//! - exit 0 without a result (no smoke ran)      → skipped, reason no-smoke-result;
//! - a result that says failed                   → failed, whatever the exit code.
export function readSmokeOutcome(config, { exitCode, pair, at, fs = { readFileSync } }) {
  const reportPath = join(smokeOutDirOf(config), 'smoke-result.json');
  let result = null;
  try { result = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { result = null; }
  const base = { pair, at: new Date(at).toISOString(), reportPath };
  if (!result || typeof result.status !== 'string') {
    return exitCode === SMOKE_FAILED_EXIT
      ? { ...base, status: 'failed', reason: 'report-unreadable' }
      : { ...base, status: 'skipped', reason: 'no-smoke-result' };
  }
  const status = exitCode === SMOKE_FAILED_EXIT && result.status !== 'failed' ? 'failed' : result.status;
  return {
    ...base,
    status,
    ...(result.reason ? { reason: result.reason } : {}),
    failures: (result.failures ?? []).slice(0, 10).map((f) => {
      const title = String(f.title ?? '');
      if (title === '(global)' || title === '(runner)') return `${title} ${String(f.message ?? '').split('\n')[0].slice(0, 160)}`;
      return title.startsWith(String(f.spec)) ? title : `${f.spec} › ${title}`;
    }),
    ...(result.flaky?.length ? { flaky: result.flaky.length } : {}),
    ...(result.durationMs != null ? { durationMs: result.durationMs } : {}),
  };
}

//! The `watch.log` line of a smoke outcome.
export function smokeLogLine(smoke, label = 'SMOKE') {
  const failures = smoke.failures?.length ?? 0;
  const duration = smoke.durationMs != null ? ` duration=${(smoke.durationMs / 1000).toFixed(1)}s` : '';
  return `${label} ${String(smoke.status).toUpperCase()} ${pairText(smoke.pair)}${duration} failures=${failures}`
    + `${smoke.reason ? ` reason=${smoke.reason}` : ''}${smoke.flaky ? ` flaky=${smoke.flaky}` : ''} (see ${smoke.reportPath})`;
}

//! The Windows notification — suppressed with RV_DEV_DEPLOY_NO_NOTIFY=1 (tests that spawn a real
//! watcher process). Never throws.
export function defaultNotify(title, body) {
  if (process.env.RV_DEV_DEPLOY_NO_NOTIFY === '1') return { ok: false, skipped: true };
  return notifyWindows(title, body);
}

//! Whether this outcome is a NEW red (notify only on the transition, never on a lasting red).
export const isSmokeTransitionToFailed = (previous, next) => next?.status === 'failed' && previous?.status !== 'failed';

//! Title + body of the notification for a red smoke.
export function smokeNotification(smoke) {
  const first = smoke.failures?.[0] ?? (smoke.reason ? `reason=${smoke.reason}` : 'see report');
  const more = (smoke.failures?.length ?? 0) > 1 ? ` (+${smoke.failures.length - 1} more)` : '';
  return {
    title: 'realvirtual WEB /dev/ — SMOKE FAILED',
    body: `${first}${more}\n${smoke.reportPath}\nretry: dev-deploy-watch.mjs --retry-smoke`,
  };
}

//! Title + body of the notification for a pair the watcher gave up on (plan-547).
export function blockedNotification(pair, error) {
  return {
    title: 'realvirtual WEB /dev/ — DEPLOY BLOCKED',
    body: `${pairText(pair)}\n${error || 'attempts used up'}\nretry: dev-deploy-watch.mjs --retry`,
  };
}

//! Title + body of the notification for a streak of failing fetches (plan-547).
export function fetchFailingNotification(count, error) {
  return {
    title: 'realvirtual WEB /dev/ — FETCH FAILING',
    body: `${count} ticks in a row: ${error}\nno deploy until a fetch succeeds`,
  };
}

//! Parses a dotenv file with the shared parser of `lib/rv-dotenv.mjs` (plan-587 F7).
//!
//! The old comment here claimed this was "the way bunny-deploy.mjs's loadDotEnv does" it, and
//! nothing checked that claim. It was half true: the two regexes were character-identical, but
//! the MERGE differed — bunny keeps the FIRST non-empty value, this one the LAST (measured,
//! plan-587 §4b M2: `K=first`/`K=`/`K=third` yields `"first"` there and `"third"` here). Both
//! behaviours are preserved, so the policy is spelled out at each call site instead of being an
//! accident of the loop body. WITHIN one file the last assignment wins here; ACROSS files
//! `loadCredentials` below keeps the first non-empty one, which is unchanged.
export function parseEnvText(text) {
  return mergeEnv(parseDotEnvText(text), 'last');
}

//! Reads the credential files in precedence order (first file that sets a key wins, as in
//! loadDotEnv). Returns `{ values, present, missing }` — `present` maps key → boolean and is the
//! only thing ever logged.
export function loadCredentials(files) {
  const values = {};
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`credentials file ${file} is not readable (${error?.code ?? error?.message})`);
    }
    for (const [key, value] of Object.entries(parseEnvText(text))) {
      if (values[key] === undefined || values[key] === '') values[key] = value;
    }
  }
  const present = {};
  for (const key of [...REQUIRED_CREDENTIALS, ...OPTIONAL_CREDENTIALS]) present[key] = !!(values[key] && String(values[key]).trim());
  const missing = REQUIRED_CREDENTIALS.filter((key) => !present[key]);
  return { values, present, missing };
}

const shortSha = (sha) => String(sha ?? '').slice(0, 10);
const pairText = (pair) => (pair ? `web=${shortSha(pair.web)} private=${shortSha(pair.private)}` : 'web=? private=?');

//! Sends ONE notification and books a failure to send it in the log. The try/catch is the point:
//! `notify` goes through PowerShell and can throw, and two of the four call sites used to carry a
//! copy of this body WITHOUT it — one of them inside the try of the deploy step, where a throwing
//! notification booked a deploy that had gone live as a failure (plan-587, F4 neighbouring finding).
export function notificationSender(notify, log) {
  return ({ title, body }) => {
    let sent;
    try { sent = notify(title, body); } catch (error) { sent = { ok: false, error: String(error?.message ?? error) }; }
    if (!sent?.ok && !sent?.skipped) log(`NOTIFY FAILED ${sent?.error ?? ''}`);
  };
}

//! Appends one timestamped line to watch.log (rotated to watch.log.1 above 5 MB). Never throws.
export function appendLog(config, message, { now = Date.now } = {}) {
  const path = logPathOf(config);
  try {
    if (existsSync(path) && statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
  } catch { /* rotation is best effort */ }
  try {
    appendFileSync(path, `${new Date(now()).toISOString()} ${message}\n`);
  } catch { /* the log must never break a tick */ }
}

// ─── Git ─────────────────────────────────────────────────────────────────

//! Runs git with a hard time limit. Resolves `{ code, stdout, stderr, timedOut }`; never rejects.
//! `afterKill()` (plan-547) runs once after a timed-out git was killed AND its `close` arrived —
//! the moment its orphaned lock files can be removed. A throwing hook never breaks the result.
export async function runGit(args, { cwd, timeoutMs = FETCH_TIMEOUT_MS, afterKill = null } = {}) {
  const { exit } = spawnLogged({
    file: 'git',
    args,
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs,
    afterKill,
  });
  const result = await exit;
  return {
    code: result.timedOut || result.error ? -1 : result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    timedOut: result.timedOut,
  };
}

const sameFsPath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

//! The reset guard (plan-488 §2.2, R2). `git reset --hard` may only ever run in one of the two
//! clone paths of config.json, and only when that path is REALLY that directory: the target must
//! literally be a configured clone path, its `realpath` (junctions and symlinks resolved) must be
//! the same path, and it must hold a `.git`. Returns the verified path or throws.
export function assertResetTarget(target, config) {
  const literal = resolve(target);
  const allowed = [config.clones.web, config.clones.private].map((p) => resolve(p));
  if (!allowed.some((p) => sameFsPath(p, literal))) {
    throw new Error(`Refusing git reset --hard in ${literal}: not one of the clone paths in config.json.`);
  }
  let real;
  try { real = realpathSync.native(literal); } catch (error) {
    throw new Error(`Refusing git reset --hard in ${literal}: path does not resolve (${error?.code ?? error?.message}).`);
  }
  if (!sameFsPath(resolve(real), literal)) {
    throw new Error(`Refusing git reset --hard in ${literal}: it resolves to ${real} (junction or symlink).`);
  }
  if (!existsSync(join(literal, '.git'))) {
    throw new Error(`Refusing git reset --hard in ${literal}: not a git clone.`);
  }
  return literal;
}

// ─── Stale git locks (plan-547) ──────────────────────────────────────────

//! Lists the git lock files of a clone, relative to the clone with `/` separators:
//! `.git/*.lock`, `.git/refs/**/*.lock`, `.git/objects/info/**/*.lock`, `.git/objects/pack/*.lock`.
//! No loose-object walk; symlinks and junctions are never followed.
function listGitLocks(gitDir) {
  const found = [];
  const walk = (dir, rel, recursive) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isFile() && entry.name.endsWith('.lock')) found.push(childRel);
      else if (recursive && entry.isDirectory()) walk(join(dir, entry.name), childRel, true);
    }
  };
  walk(gitDir, '.git', false);
  walk(join(gitDir, 'refs'), '.git/refs', true);
  walk(join(gitDir, 'objects', 'info'), '.git/objects/info', true);
  walk(join(gitDir, 'objects', 'pack'), '.git/objects/pack', false);
  return found;
}

//! Removes orphaned git lock files of one clone (plan-547). A lock whose mtime is older than
//! `maxAgeMs` is unlinked and logged as `STALE LOCK REMOVED <clone>/<path> age=<min>m`; a younger
//! one is left alone and returned in `tooYoung`. `force` removes every lock regardless of age (the
//! watcher just killed the git that held it) and tags the log line `(after kill)`. A stale `gc.pid`
//! is only logged. With `config`, the path must pass `assertResetTarget` first; a refusal is logged
//! and nothing is touched. Without a `.git` directory it is a no-op. Never throws.
//! Returns `{ removed, tooYoung, failed, refused }` — entries are `{ path, ageMs }` (+ `error`).
export function healStaleGitLocks(clonePath, { now = Date.now, maxAgeMs = STALE_LOCK_MINUTES * 60_000, log = () => {}, config = null, force = false } = {}) {
  const result = { removed: [], tooYoung: [], failed: [], refused: null };
  let target = clonePath;
  if (config) {
    try { target = assertResetTarget(clonePath, config); } catch (error) {
      result.refused = String(error?.message ?? error).replace(/^Refusing git reset --hard/, 'Refusing the lock sweep');
      log(`LOCK SWEEP REFUSED ${result.refused}`);
      return result;
    }
  }
  const gitDir = join(target, '.git');
  try { if (!statSync(gitDir).isDirectory()) return result; } catch { return result; }
  const label = basename(target);
  const at = now();
  const minutes = (ms) => Math.max(0, Math.round(ms / 60_000));
  for (const rel of listGitLocks(gitDir)) {
    const abs = join(target, ...rel.split('/'));
    let ageMs;
    try { ageMs = at - statSync(abs).mtimeMs; } catch { continue; } // vanished meanwhile
    if (!force && !(ageMs > maxAgeMs)) {
      result.tooYoung.push({ path: `${label}/${rel}`, ageMs });
      continue;
    }
    try {
      unlinkSync(abs);
      result.removed.push({ path: `${label}/${rel}`, ageMs });
      log(`STALE LOCK REMOVED ${label}/${rel} age=${minutes(ageMs)}m${force ? ' (after kill)' : ''}`);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      result.failed.push({ path: `${label}/${rel}`, ageMs, error: error?.code ?? error?.message });
      log(`STALE LOCK NOT REMOVED ${label}/${rel} age=${minutes(ageMs)}m: ${error?.code ?? error?.message}`);
    }
  }
  const gcPid = join(gitDir, 'gc.pid');
  try {
    const ageMs = at - statSync(gcPid).mtimeMs;
    if (ageMs > maxAgeMs) log(`STALE GC PID ${label}/.git/gc.pid age=${minutes(ageMs)}m (left in place)`);
  } catch { /* no gc.pid */ }
  return result;
}

//! The `afterKill` hook of a clone's git calls: removes THAT clone's locks without an age gate.
const healAfterKill = (clonePath, config, log) => () => {
  healStaleGitLocks(clonePath, { config, log, force: true });
};

async function fetchClone(clonePath, config, log = () => {}) {
  const branch = config.branch ?? 'main';
  const fetch = await runGit(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { cwd: clonePath, timeoutMs: config.fetchTimeoutMs, afterKill: healAfterKill(clonePath, config, log) });
  if (fetch.code !== 0) {
    return { ok: false, error: fetch.timedOut ? `git fetch timed out after ${Math.round(config.fetchTimeoutMs / 1000)} s` : `git fetch exit ${fetch.code}: ${fetch.stderr.split(/\r?\n/)[0] ?? ''}` };
  }
  const sha = await runGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`],
    { cwd: clonePath, timeoutMs: config.fetchTimeoutMs, afterKill: healAfterKill(clonePath, config, log) });
  if (sha.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha.stdout)) return { ok: false, error: `git rev-parse failed: ${sha.stderr}` };
  return { ok: true, sha: sha.stdout };
}

//! `git clean` keeps `node_modules` (plan-503): the smoke runtime lives there, and a clean that
//! removes it would force a 150 s `npm ci` on every tick. `-e` excludes it at any depth.
export const CLEAN_ARGS = Object.freeze(['clean', '-ffdxq', '-e', 'node_modules']);

async function resetClone(clonePath, sha, config, log = () => {}) {
  const target = assertResetTarget(clonePath, config);
  for (const args of [['reset', '--hard', '--quiet', sha], [...CLEAN_ARGS]]) {
    const result = await runGit(args, { cwd: target, timeoutMs: config.fetchTimeoutMs, afterKill: healAfterKill(target, config, log) });
    if (result.code !== 0) throw new Error(`git ${args[0]} in ${target} failed: ${result.stderr || `exit ${result.code}`}`);
  }
}

// ─── Deploy child ────────────────────────────────────────────────────────

//! Starts the deploy from the web clone and resolves its exit code. The child is deliberately NOT
//! detached (plan-488 §2.1 step 8, R6/R12): libuv ties it to the watcher, so it can never outlive
//! the watcher and read from clones the next tick resets.
export function startDeployChild(config, env) {
  const script = join(config.clones.web, 'scripts', 'bunny-deploy.mjs');
  // Remove the PREVIOUS run's phase record before starting (plan-587 F4). It would otherwise
  // still say `published`, and a child that hangs before reporting anything — a wedged module
  // load, a node that never starts — would inherit that run's "do not kill" verdict. Gone, the
  // verdict for an unreadable file is still "do not kill", but the log then names the real
  // reason instead of a stale phase.
  try { rmSync(deployPhaseFileOf(config), { force: true }); } catch { /* best effort */ }
  const { pid, exit } = spawnLogged({
    file: config.nodePath,
    args: [script, ...config.deployArgs],
    cwd: config.clones.web,
    env,
    logPath: deployLogPathOf(config),
    detached: false,
    // ARMED since plan-587 Phase 4: `bunny-deploy.mjs` now reports `build`/`upload`/`published`/
    // `smoke` into the file below (atomically), so the deadline has a verdict to consult instead
    // of a guess. 45 minutes, and a kill only while the child is still building — see
    // DEPLOY_TIMEOUT_MS and `decideTimeoutKill` in lib/rv-proc.mjs. A config may override both;
    // `deployTimeoutMs: null` switches the deadline off again.
    timeoutMs: config.deployTimeoutMs === undefined ? DEPLOY_TIMEOUT_MS : config.deployTimeoutMs,
    phaseFile: deployPhaseFileOf(config),
  });
  return {
    pid,
    exit: exit.then((result) => ({
      code: result.code,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.timedOut ? { timedOut: true, killed: result.killed } : {}),
    })),
  };
}

//! The environment of the deploy child: the watcher's own, the credential values, an explicit
//! workspace root (a clone cannot find one) and the pre-publish limit (plan-488 §2.8). plan-503 adds
//! the smoke's browser folder, its output dir and the SHA pair it is checking.
export function deployEnv(config, credentials, baseEnv = process.env, pair = null) {
  return {
    ...baseEnv,
    ...credentials.values,
    RV_WORKSPACE_ROOT: config.workspaceRoot,
    RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS: String(config.prepublishTimeoutSeconds ?? PREPUBLISH_TIMEOUT_SECONDS),
    RV_DEV_DEPLOY_WATCH: '1',
    // plan-587 F4: the ONE path both sides use for the phase record. The child must not compute
    // it itself — it runs from a clone with no workspace root of its own.
    RV_DEPLOY_PHASE_FILE: deployPhaseFileOf(config),
    PLAYWRIGHT_BROWSERS_PATH: browsersPathOf(config),
    RV_SMOKE_OUT_DIR: smokeOutDirOf(config),
    ...(pair ? { RV_SMOKE_PAIR: JSON.stringify(pair) } : {}),
  };
}

// ─── Load guards, priority and timing (2026-10-25) ───────────────────────

//! Asks the test-lock port who holds it (the same `GET /` as `scripts/test-lock.mjs`, inlined —
//! the installed copy stays self-contained). Resolves the holder `{ pid, argv, … }` or null
//! (free, foreign program, no answer within `timeoutMs`). Never rejects.
export function probeTestLock({ port = DEFAULT_TEST_LOCK_PORT, timeoutMs = 1000 } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolvePromise(value); } };
    let req;
    try {
      req = httpGet({ host: '127.0.0.1', port, path: '/', agent: false, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            done(parsed && parsed.rvTestLock === 1 && Number.isInteger(parsed.pid) ? parsed : null);
          } catch { done(null); }
        });
        res.on('error', () => done(null));
      });
    } catch { done(null); return; }
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

//! Decides whether a tick that would deploy is deferred. Pure. `holder` = probeTestLock's answer,
//! `freeBytes` = free physical memory, `ownLockPid` = `RV_TEST_LOCK_HELD` of this process (a
//! watcher started INSIDE a lock-holding run — the tests — must not wait for its own lock).
//! Returns `{ reason, detail }` or null.
//! `cpuPercent` = machine-wide CPU busy share over the sample window (sampleCpuBusy). `overdue`
//! = the pair has waited longer than `maxDeferMinutes`: then the test lock and the CPU no longer
//! defer it (a machine that is always busy must not stop /dev for good) — low memory still does.
export function deferReason(config, { holder = null, freeBytes = null, ownLockPid = null, cpuPercent = null, overdue = false } = {}) {
  const minMb = Number(config?.minFreeMemoryMb ?? DEFAULT_MIN_FREE_MEMORY_MB);
  if (minMb > 0 && Number.isFinite(freeBytes) && freeBytes < minMb * 1024 * 1024) {
    return { reason: 'low-memory', detail: `free memory ${(freeBytes / 1024 ** 3).toFixed(1)} GB < ${(minMb / 1024).toFixed(1)} GB` };
  }
  if (overdue) return null;
  if (config?.deferWhileTestLockHeld !== false && holder && Number(holder.pid) !== Number(ownLockPid)) {
    const argv = Array.isArray(holder.argv) ? holder.argv.join(' ') : '';
    return { reason: 'test-lock', detail: `test lock held by PID ${holder.pid}${argv ? ` (${argv.slice(0, 160)})` : ''}` };
  }
  const maxCpu = Number(config?.maxCpuPercent ?? DEFAULT_MAX_CPU_PERCENT);
  if (maxCpu > 0 && Number.isFinite(cpuPercent) && cpuPercent > maxCpu) {
    return { reason: 'cpu-busy', detail: `CPU ${Math.round(cpuPercent)} % > ${maxCpu} % over ${Math.round(Number(config?.cpuSampleMs ?? DEFAULT_CPU_SAMPLE_MS) / 1000)} s` };
  }
  return null;
}

//! Machine-wide CPU busy share in percent over `ms` (two `os.cpus()` snapshots). Resolves null
//! when it cannot be measured. Never rejects.
export async function sampleCpuBusy(ms = DEFAULT_CPU_SAMPLE_MS, readCpus = cpus) {
  const total = () => readCpus().reduce((acc, cpu) => {
    const t = cpu.times;
    acc.idle += t.idle; acc.all += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, all: 0 });
  try {
    const a = total();
    await new Promise((r) => setTimeout(r, ms));
    const b = total();
    const all = b.all - a.all;
    return all > 0 ? (100 * (all - (b.idle - a.idle))) / all : null;
  } catch {
    return null;
  }
}

//! Lowers the priority of THIS process to below normal (`lowPriority`, default on). Children
//! started afterwards inherit it: on Windows a child of a BELOW_NORMAL process gets
//! BELOW_NORMAL unless it asks otherwise, and neither git, npm nor Vite asks. Returns true when
//! applied; never throws.
export function lowerOwnPriority(config, setPriority = osSetPriority) {
  if (config?.lowPriority === false) return false;
  try {
    setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch {
    return false;
  }
}

//! Folder under `<root>` that keeps the deploy log of every failed attempt, and how many it keeps.
export const FAILED_LOGS_DIRNAME = 'failed-deploys';
export const FAILED_LOGS_KEEP = 20;

//! Copies `last-deploy.log` of a failed attempt to `<root>\failed-deploys\deploy-<time>-<web>-<private>.log`
//! before the next attempt overwrites it, and prunes the folder to the newest FAILED_LOGS_KEEP.
//! Returns the copy's path or null; never throws.
export function preserveFailedDeployLog(config, pair, at = Date.now()) {
  try {
    const dir = join(config.root, FAILED_LOGS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
    const target = join(dir, `deploy-${stamp}-${shortSha(pair?.web)}-${shortSha(pair?.private)}.log`);
    copyFileSync(deployLogPathOf(config), target);
    const files = readdirSync(dir).filter((name) => /^deploy-.*\.log$/.test(name)).sort();
    for (const name of files.slice(0, Math.max(0, files.length - FAILED_LOGS_KEEP))) {
      try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
    }
    return target;
  } catch {
    return null;
  }
}

//! The `[timing] <step> <seconds>s` lines bunny-deploy.mjs printed, as `step=<s>s` pairs in order.
export function parseDeployTimings(text) {
  const pairs = [];
  for (const match of String(text ?? '').matchAll(/^\[timing\] ([\w.-]+) ([\d.]+)s\s*$/gm)) pairs.push(`${match[1]}=${match[2]}s`);
  return pairs;
}

// ─── Smoke runtime in the web clone (plan-503 F12) ────────────────────────

//! SHA-256 of `<clone>/package-lock.json`, or null when there is none.
export function lockHashOf(clonePath, fs = { readFileSync }) {
  try { return createHash('sha256').update(fs.readFileSync(join(clonePath, 'package-lock.json'))).digest('hex'); } catch { return null; }
}

//! Whether the runtime the smoke needs is on disk: the Playwright CLI in the clone and a
//! `chromium*` folder under the browser path.
export function runtimePresent(config, fs = { existsSync, readdirSync }) {
  const cli = fs.existsSync(join(config.clones.web, 'node_modules', 'playwright', 'cli.js'));
  let browser = false;
  try { browser = fs.readdirSync(browsersPathOf(config)).some((name) => /^chromium/.test(String(name))); } catch { browser = false; }
  return { cli, browser };
}

//! Decides whether the runtime must be (re)installed: missing CLI, missing browser, or a lockfile
//! whose hash differs from the one of the last installation. Pure.
export function runtimeNeedsInstall(state, present, lockHash) {
  if (!present.cli) return 'playwright-cli-missing';
  if (!present.browser) return 'browser-missing';
  if (!state?.runtime?.lockHash || state.runtime.lockHash !== lockHash) return 'lockfile-changed';
  return null;
}

//! The two install commands, as `[file, args, options]`. `npm` runs through the npm-cli.js next to
//! the configured node when there is one (no shell, no PATH lookup), else through `npm` on PATH.
export function runtimeInstallCommands(config) {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPathOf(config) };
  const npmCli = join(dirname(config.nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npm = existsSync(npmCli)
    ? [config.nodePath, [npmCli, ...NPM_CI_ARGS]]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', [...NPM_CI_ARGS], { shell: process.platform === 'win32' }];
  const options = { cwd: config.clones.web, env, timeout: RUNTIME_INSTALL_TIMEOUT_MS };
  return [
    [npm[0], npm[1], { ...options, ...(npm[2] ?? {}) }],
    [config.nodePath, [join(config.clones.web, 'node_modules', 'playwright', 'cli.js'), ...PLAYWRIGHT_INSTALL_ARGS], options],
  ];
}

const commandText = ([file, args]) => [file, ...args].join(' ');

//! Tick step 7a: makes sure the smoke runtime of the web clone is current. Returns
//! `{ runtime, action: 'none' | 'installed' | 'failed' | 'unmanaged', reason?, error? }`; never throws.
//! `deps.runner(file, args, options)` → `{ status, stdout, stderr }` (test seam).
//! Unmanaged = a config from before plan-503 (no `browsersPath`): nothing is installed, the smoke
//! then ends `runtime-missing` — visible, not silent. `--install` writes `browsersPath`.
export function ensureRuntime(config, state, deps = {}) {
  if (typeof config.browsersPath !== 'string' || !config.browsersPath) return { runtime: state?.runtime ?? null, action: 'unmanaged' };
  const lockHash = lockHashOf(config.clones.web);
  if (!lockHash) return { runtime: state?.runtime ?? null, action: 'failed', reason: 'no-lockfile', error: `no package-lock.json in ${config.clones.web}` };
  const reason = runtimeNeedsInstall(state, (deps.present ?? runtimePresent)(config), lockHash);
  if (!reason) return { runtime: state.runtime, action: 'none' };
  const runner = deps.runner ?? runCommand;
  const logFile = runtimeLogPathOf(config);
  try { writeFileSync(logFile, `${new Date((deps.now ?? Date.now)()).toISOString()} runtime install (${reason})\n`); } catch { /* log is best effort */ }
  try { mkdirSync(browsersPathOf(config), { recursive: true }); } catch { /* the install reports it */ }
  for (const command of runtimeInstallCommands(config)) {
    const result = runner(command[0], command[1], command[2]);
    try { appendFileSync(logFile, `$ ${commandText(command)}\nexit ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n`); } catch { /* best effort */ }
    if (result.status !== 0) {
      return { runtime: state?.runtime ?? null, action: 'failed', reason, error: `${commandText(command)} exited ${result.status}: ${String(result.stderr || result.stdout || '').trim().split(/\r?\n/).pop() ?? ''}` };
    }
  }
  return {
    action: 'installed',
    reason,
    runtime: { lockHash, installedAt: new Date((deps.now ?? Date.now)()).toISOString(), browsersPath: browsersPathOf(config) },
  };
}

// ─── One tick (plan-488 §2.1) ─────────────────────────────────────────────

//! Runs one watcher tick. Resolves `{ outcome, … }`; the outcome names the step that ended it:
//! `watcher-busy`, `disabled`, `credentials-missing`, `credentials-unreadable`, `git-locked`,
//! `fetch-failed`, `state-unreadable`, `idle`, `deferred`, `gave-up`, `state-unwritable`, `deployed`,
//! `deploy-failed`.
//! `deps` are test seams: `now`, `acquire`, `afterCapture(pair)`, `stateFs`, `startDeploy`, `notify`,
//! `probeTestLock`, `freeMemory`, `cpuBusy(ms)`, `setPriority`.
export async function runTick(config, deps = {}) {
  const now = deps.now ?? Date.now;
  const acquire = deps.acquire ?? acquirePublishLock;
  const notify = deps.notify ?? defaultNotify;
  const stateFs = deps.stateFs ?? defaultFs;
  const log = (message) => appendLog(config, message, { now });
  const sendNotification = notificationSender(notify, log);

  // 1. One watcher at a time — a busy instance lock ends the tick silently.
  let lock;
  try {
    lock = await acquire(config.watcherLockName ?? WATCHER_LOCK_NAME, { timeoutMs: 0 });
  } catch (error) {
    if (error?.code === LOCK_BUSY_CODE) return { outcome: 'watcher-busy' };
    throw error;
  }
  try {
    // 2. The switch.
    if (!existsSync(enabledPathOf(config))) {
      log('SKIP disabled (no enabled file)');
      return { outcome: 'disabled' };
    }

    let credentials;
    try {
      credentials = loadCredentials(config.credentialsFiles);
    } catch (error) {
      log(`SKIP credentials unreadable: ${error?.message ?? error}`);
      return { outcome: 'credentials-unreadable' };
    }
    if (credentials.missing.length) {
      log(`SKIP credentials missing: ${credentials.missing.join(', ')} (no deploy)`);
      return { outcome: 'credentials-missing', missing: credentials.missing };
    }

    // 2a. Orphaned git locks (plan-547): a git killed mid-operation leaves its lock behind and every
    //     later git op in that clone fails at once. Only here — inside the watcher lock — and only
    //     locks older than staleLockMinutes. A younger lock ends the tick before any attempt is used.
    const maxAgeMs = (config.staleLockMinutes ?? STALE_LOCK_MINUTES) * 60_000;
    for (const clonePath of [config.clones.web, config.clones.private]) {
      const swept = healStaleGitLocks(clonePath, { now, maxAgeMs, log, config });
      const blocking = swept.tooYoung[0] ?? swept.failed[0];
      if (blocking) {
        log(`SKIP git-locked ${blocking.path} age=${Math.max(0, Math.round(blocking.ageMs / 1000))}s (no deploy, no attempt used)`);
        return { outcome: 'git-locked', path: blocking.path };
      }
    }

    // 3. + 4. Fetch both clones, capture the pair. One failure ends the tick with nothing changed
    //     but the fetch-failure streak (plan-547).
    const fetchStarted = now();
    const web = await fetchClone(config.clones.web, config, log);
    const priv = web.ok ? await fetchClone(config.clones.private, config, log) : null;
    const fetchEnded = now();
    if (!web.ok || !priv?.ok) {
      const error = !web.ok ? `web: ${web.error}` : `private: ${priv.error}`;
      log(`FETCH FAILED ${error} (no deploy, no attempt used)`);
      // Count only on a cleanly readable state: io-error and corrupt (read-only here, no rename) skip it.
      const counted = readState(statePathOf(config), { fs: { ...stateFs, renameSync: () => { throw Object.assign(new Error('read-only'), { code: 'EREADONLY' }); } }, now });
      if (counted.kind === 'ok' || counted.kind === 'missing') {
        const fetchFailures = (Number(counted.state.fetchFailures) || 0) + 1;
        let stored = false;
        try {
          writeStateAtomic(statePathOf(config), { ...counted.state, fetchFailures }, { fs: stateFs });
          stored = true;
        } catch (writeError) {
          log(`STATE NOT WRITABLE fetch failure count ${writeError?.code ?? writeError?.message}`);
        }
        if (stored && fetchFailures === FETCH_FAILURE_NOTIFY_AT) sendNotification(fetchFailingNotification(fetchFailures, error));
      }
      return { outcome: 'fetch-failed' };
    }
    const pair = { web: web.sha, private: priv.sha };
    if (deps.afterCapture) await deps.afterCapture(pair);

    // 5. Decide.
    const read = readState(statePathOf(config), { fs: stateFs, now });
    if (read.kind === 'io-error') {
      log(`STATE UNREADABLE ${read.error?.code ?? read.error?.message} ${pairText(pair)} (no deploy)`);
      return { outcome: 'state-unreadable', pair };
    }
    if (read.kind === 'corrupt') log(`STATE CORRUPT moved to ${read.corruptPath}; starting fresh`);
    // A successful fetch of both clones ends a fetch-failure streak (plan-547). Reset in memory so
    // every later write (reservation, booking, give-up) keeps 0; idle ticks write it below.
    const priorFetchFailures = Number(read.state.fetchFailures) || 0;
    const current = priorFetchFailures > 0 ? { ...read.state, fetchFailures: 0 } : read.state;
    if (priorFetchFailures > 0) log(`FETCH RECOVERED after ${priorFetchFailures} failed tick${priorFetchFailures === 1 ? '' : 's'}`);
    const decision = decideTick(current, pair, now());
    // 5a. Load guards: a deploy is deferred while free memory is low, while a foreign test run
    //     holds the machine-wide test lock, or while the CPU is busy over a sample window. Nothing
    //     is reserved and no backoff starts — the next tick simply decides again. `deferred` in
    //     state.json remembers since when a deploy has been pending (any pair); past maxDeferMinutes only low memory
    //     still defers it.
    if (decision.action === 'deploy') {
      const lockPort = Number(config.testLockPort ?? process.env.RV_TEST_LOCK_PORT ?? DEFAULT_TEST_LOCK_PORT) || DEFAULT_TEST_LOCK_PORT;
      // Since the FIRST deferral of the pending deploy, whatever pair it was: pushes arrive every few
      // minutes, and a clock that restarted per pair would never reach the limit.
      const since = Number.isFinite(Number(current.deferred?.since)) && current.deferred?.since != null ? Number(current.deferred.since) : null;
      const overdue = since != null && now() - since > Number(config.maxDeferMinutes ?? DEFAULT_MAX_DEFER_MINUTES) * 60_000;
      const freeBytes = (deps.freeMemory ?? freemem)();
      const holder = overdue || config.deferWhileTestLockHeld === false ? null : await (deps.probeTestLock ?? probeTestLock)({ port: lockPort });
      const maxCpu = Number(config.maxCpuPercent ?? DEFAULT_MAX_CPU_PERCENT);
      const cpuPercent = overdue || !(maxCpu > 0) ? null
        : await (deps.cpuBusy ?? sampleCpuBusy)(Number(config.cpuSampleMs ?? DEFAULT_CPU_SAMPLE_MS));
      const deferred = deferReason(config, { holder, freeBytes, ownLockPid: process.env.RV_TEST_LOCK_HELD ?? null, cpuPercent, overdue });
      if (deferred) {
        const waiting = { ...current, deferred: { pair, since: since ?? now() } };
        try { writeStateAtomic(statePathOf(config), waiting, { fs: stateFs }); } catch (error) {
          log(`STATE NOT WRITABLE defer ${error?.code ?? error?.message}`);
        }
        const waited = since != null ? ` waiting ${Math.round((now() - since) / 60_000)} min` : '';
        log(`DEFER ${deferred.reason}: ${deferred.detail} ${pairText(pair)}${waited} (no attempt used, next tick retries)`);
        return { outcome: 'deferred', reason: deferred.reason, pair };
      }
      if (overdue) log(`DEFER LIMIT ${pairText(pair)} waited over ${config.maxDeferMinutes ?? DEFAULT_MAX_DEFER_MINUTES} min — deploying despite test lock / CPU load`);
      if (current.deferred) decision.state = { ...decision.state, deferred: null };
    }
    if (decision.action === 'none') {
      if (priorFetchFailures > 0) {
        try { writeStateAtomic(statePathOf(config), current, { fs: stateFs }); } catch (error) {
          log(`STATE NOT WRITABLE fetch failure reset ${error?.code ?? error?.message}`);
        }
      }
      const until = decision.reason === 'backoff' ? ` until ${new Date(read.state.attempt.nextRetryAt).toISOString()}` : '';
      log(`IDLE ${decision.reason}${until} ${pairText(pair)}`);
      return { outcome: 'idle', reason: decision.reason, pair };
    }
    if (decision.action === 'give-up') {
      let stored = false;
      try {
        writeStateAtomic(statePathOf(config), decision.state, { fs: stateFs });
        stored = true;
      } catch (error) {
        log(`STATE NOT WRITABLE give-up ${error?.code ?? error?.message} ${pairText(pair)}`);
      }
      log(`GIVING UP ${pairText(pair)} after ${decision.state.attempt.attempts} attempts (--retry to try again)`);
      // Only a stored give-up notifies — an unstored one repeats next tick and must not toast twice.
      if (stored) {
        const last = samePair(read.state.lastFailed?.pair, pair) ? read.state.lastFailed : null;
        const error = last ? (last.error ?? `exit=${last.exitCode}`) : 'the last attempt never finished (watcher killed or crashed)';
        sendNotification(blockedNotification(pair, error));
      }
      return { outcome: 'gave-up', pair };
    }

    // 6. Reserve the attempt BEFORE anything runs. Not storable → no deploy.
    try {
      writeStateAtomic(statePathOf(config), decision.state, { fs: stateFs });
    } catch (error) {
      log(`STATE NOT WRITABLE ${error?.code ?? error?.message} ${pairText(pair)} (no deploy)`);
      return { outcome: 'state-unwritable', pair };
    }
    const attempt = decision.state.attempt.attempts;
    const present = Object.entries(credentials.present).map(([key, has]) => `${key}=${has ? 'present' : 'absent'}`).join(' ');
    log(`DEPLOY START attempt ${attempt}/${MAX_ATTEMPTS} ${pairText(pair)} credentials: ${present}`);

    const started = now();
    let result;
    let runtime = decision.state.runtime ?? null;
    let smoke = null;
    let childStartedAt = null;
    const timing = [`fetch=${((fetchEnded - fetchStarted) / 1000).toFixed(1)}s`];
    if (lowerOwnPriority(config, deps.setPriority)) log('priority: below normal (deploy child, npm and vite inherit it)');
    try {
      // 7. Exactly the captured SHAs — never origin/main again. `git clean` keeps node_modules.
      const resetStarted = now();
      await resetClone(config.clones.web, pair.web, config, log);
      await resetClone(config.clones.private, pair.private, config, log);
      timing.push(`reset=${((now() - resetStarted) / 1000).toFixed(1)}s`);
      // 7a. The smoke runtime (plan-503 F12): reinstalled when missing or when the lockfile moved.
      //     A failed install does not stop the deploy — the smoke then ends runtime-missing.
      //     With `--no-smoke` in deployArgs nothing of this runs and no smoke is booked.
      const noSmoke = smokeDisabled(config);
      if (noSmoke) log('runtime: skipped (smoke disabled)');
      const runtimeStarted = now();
      const rt = noSmoke ? { runtime, action: 'skipped' } : (deps.ensureRuntime ?? ensureRuntime)(config, decision.state, {
        now, ...(deps.runtimeRunner ? { runner: deps.runtimeRunner } : {}), ...(deps.runtimePresent ? { present: deps.runtimePresent } : {}),
      });
      runtime = rt.runtime ?? runtime;
      if (rt.action === 'installed') {
        log(`RUNTIME INSTALL ${rt.reason} ok duration=${((now() - runtimeStarted) / 1000).toFixed(1)}s (see last-runtime.log)`);
      } else if (rt.action === 'failed') {
        log(`RUNTIME FAILED ${rt.reason ?? ''} ${rt.error ?? ''} (see last-runtime.log; the smoke will report runtime-missing)`);
        sendNotification({ title: 'realvirtual WEB /dev/ — SMOKE RUNTIME FAILED', body: `${rt.error ?? rt.reason}\n${runtimeLogPathOf(config)}` });
      }
      // A smoke-result.json of an earlier run must never be read as this run's.
      if (!noSmoke) {
        try { rmSync(join(smokeOutDirOf(config), 'smoke-result.json'), { force: true }); } catch { /* best effort */ }
      }
      // 8. The deploy child, non-detached. Exit 3 = deployed, smoke red (plan-503).
      const childStarted = now();
      childStartedAt = childStarted;
      const child = (deps.startDeploy ?? startDeployChild)(config, deployEnv(config, credentials, process.env, pair));
      const exit = await child.exit;
      timing.push(`deploy-child=${((now() - childStarted) / 1000).toFixed(1)}s`);
      try { timing.push(...parseDeployTimings(readFileSync(deployLogPathOf(config), 'utf8'))); } catch { /* no log */ }
      const deployed = exit.code === 0 || exit.code === SMOKE_FAILED_EXIT;
      result = { ok: deployed, exitCode: exit.code, ...(exit.error ? { error: exit.error } : {}) };
      if (deployed && !noSmoke) smoke = readSmokeOutcome(config, { exitCode: exit.code, pair, at: now() });
    } catch (error) {
      result = { ok: false, exitCode: null, error: String(error?.message ?? error) };
    }
    const finishedAt = now();
    const booked = { ...recordResult(decision.state, pair, { ...result, smoke, finishedAt, durationMs: finishedAt - started }), runtime };

    // 9. Book the result.
    try {
      writeStateAtomic(statePathOf(config), booked, { fs: stateFs });
    } catch (error) {
      log(`STATE NOT WRITABLE after deploy ${error?.code ?? error?.message} (the reservation stands)`);
    }
    // 10. Log.
    const seconds = ((finishedAt - started) / 1000).toFixed(1);
    log(`TIMING ${timing.join(' ')} ${pairText(pair)}`);
    if (result.ok) {
      log(`DEPLOY OK ${pairText(pair)} duration=${seconds}s${result.exitCode === SMOKE_FAILED_EXIT ? ' (exit 3: live, smoke red)' : ''}`);
      if (smoke) {
        log(smokeLogLine(smoke));
        // Notify only on the transition to red — a lasting red must not toast every 3 minutes.
        if (isSmokeTransitionToFailed(read.state.lastSmoke, smoke)) sendNotification(smokeNotification(smoke));
      }
      return { outcome: 'deployed', pair, smoke: smoke?.status ?? null };
    }
    // The child wrote last-deploy.log only when it was started; keep a copy before the next attempt overwrites it.
    const kept = childStartedAt !== null ? preserveFailedDeployLog(config, pair, finishedAt) : null;
    log(`DEPLOY FAILED ${pairText(pair)} duration=${seconds}s exit=${result.exitCode}${result.error ? ` error=${result.error}` : ''} (see ${kept ?? 'last-deploy.log'})`);
    if (booked.attempt.status === 'failed') {
      log(`GIVING UP ${pairText(pair)} after ${booked.attempt.attempts} attempts (--retry to try again)`);
      sendNotification(blockedNotification(pair, `exit=${result.exitCode}${result.error ? ` ${result.error}` : ` (see ${deployLogPathOf(config)})`}`));
    }
    return { outcome: 'deploy-failed', pair };
  } finally {
    await lock.release();
  }
}

// ─── Status / retry / switch ─────────────────────────────────────────────

//! Collects what `--status` shows.
export function collectStatus(config) {
  const read = readState(statePathOf(config), { fs: { ...defaultFs, renameSync: () => { throw Object.assign(new Error('read-only status'), { code: 'EREADONLY' }); } } });
  const state = read.state ?? null;
  return {
    root: config.root,
    enabled: existsSync(enabledPathOf(config)),
    stateFile: read.kind,
    status: state ? summarizeStatus(state) : 'unknown',
    lastDeployed: state?.lastDeployed ?? null,
    attempt: state?.attempt ?? null,
    lastResult: state?.lastResult ?? null,
    lastFailed: state?.lastFailed ?? null,
    lastSmoke: state?.lastSmoke ?? null,
    runtime: state?.runtime ?? null,
    fetchFailures: Number(state?.fetchFailures) || 0,
  };
}

//! The human form of `--status`.
export function formatStatus(status) {
  const when = (ms) => (ms ? new Date(ms).toISOString() : '-');
  const lines = [
    `dev-deploy watcher  ${status.root}`,
    `  switch      : ${status.enabled ? 'enabled' : 'DISABLED'}`,
    `  status      : ${status.status}${status.stateFile === 'io-error' ? ' (state.json unreadable)' : ''}`,
    `  deployed    : ${status.lastDeployed ? pairText(status.lastDeployed) : '-'}`,
  ];
  if (status.attempt) {
    lines.push(`  attempt     : ${status.attempt.attempts}/${MAX_ATTEMPTS} ${status.attempt.status} ${pairText(status.attempt.pair)}`
      + `${status.attempt.nextRetryAt ? ` next ${when(status.attempt.nextRetryAt)}` : ''}`);
  }
  if (status.lastResult) {
    lines.push(`  last result : ${status.lastResult.ok ? 'OK' : `FAILED exit=${status.lastResult.exitCode}`} ${when(status.lastResult.at)} `
      + `${pairText(status.lastResult.pair)}${status.lastResult.durationMs != null ? ` ${(status.lastResult.durationMs / 1000).toFixed(1)}s` : ''}`);
  }
  if (status.lastSmoke) {
    const s = status.lastSmoke;
    const detail = s.failures?.length ? ` — ${s.failures[0]}${s.failures.length > 1 ? ` (+${s.failures.length - 1} more)` : ''}` : (s.reason ? ` — ${s.reason}` : '');
    lines.push(`  last smoke  : ${String(s.status).toUpperCase()} ${s.at ?? '-'} ${pairText(s.pair)}${detail}`
      + `${s.status === 'failed' ? ` (see ${s.reportPath}; --retry-smoke)` : ''}`);
  } else {
    lines.push('  last smoke  : -');
  }
  if (status.fetchFailures > 0) lines.push(`  fetch fails : ${status.fetchFailures}`);
  if (status.runtime) lines.push(`  runtime     : installed ${status.runtime.installedAt} lock=${String(status.runtime.lockHash).slice(0, 12)} browsers=${status.runtime.browsersPath}`);
  return lines.join('\n');
}

// ─── --retry-smoke (plan-503 §2.6) ───────────────────────────────────────

//! Starts `node <web clone>/scripts/rv-demo-smoke.mjs --expected <file> --out <smokeOutDir>` and
//! resolves `{ code, timedOut }`. Over the limit the process tree is killed through
//! `rv-proc.killTree`: Playwright runs a worker and a browser below the runner. On Windows that is
//! `taskkill /T /F` and reaches the whole tree; outside Windows it ends the runner and is NOT
//! measured against its grandchildren (plan-587 §4b M3).
export function runSmokeChild(config, expectedFile, { timeoutMs = config.retrySmokeTimeoutMs ?? RETRY_SMOKE_TIMEOUT_MS } = {}) {
  const script = join(config.clones.web, 'scripts', 'rv-demo-smoke.mjs');
  const { pid, exit } = spawnLogged({
    file: config.nodePath,
    args: [script, '--expected', expectedFile, '--out', smokeOutDirOf(config)],
    cwd: config.clones.web,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPathOf(config) },
    logPath: retrySmokeLogPathOf(config),
    detached: false,
    timeoutMs,
  });
  return exit.then((result) => ({
    code: result.code,
    timedOut: result.timedOut,
    ...(result.error ? { error: result.error } : {}),
    pid,
  }));
}

//! `--retry-smoke`: re-runs ONLY the demo smoke against the stand the last deploy recorded in
//! `<smokeOutDir>/expected.json` (`{ pair, baseUrl, demos, fingerprint }`) and books the outcome as
//! `lastSmoke` of THAT pair. Deploys nothing. Takes the watcher's instance lock and WAITS for a
//! running tick (it never ends silently). Keeps the runtime current first, like a tick.
//! `deps`: acquire, runSmoke(config, expectedFile) → { code, timedOut }, notify, now, out,
//! lockTimeoutMs, runtimeRunner, runtimePresent.
export async function retrySmoke(config, deps = {}) {
  const now = deps.now ?? Date.now;
  const acquire = deps.acquire ?? acquirePublishLock;
  const out = deps.out ?? ((line) => console.log(line));
  const notify = deps.notify ?? defaultNotify;
  const log = (message) => appendLog(config, message, { now });
  const sendNotification = notificationSender(notify, log);
  if (smokeDisabled(config)) {
    out('smoke is disabled (deployArgs contain --no-smoke) — nothing to retry. Remove --no-smoke from config.json to turn it back on.');
    return { smoke: null, exit: null, disabled: true };
  }
  const expectedFile = join(smokeOutDirOf(config), 'expected.json');
  if (!existsSync(expectedFile)) {
    throw new Error(`No ${expectedFile} — nothing to retry. A deploy writes it right after the purge.`);
  }
  const lock = await acquire(config.watcherLockName ?? WATCHER_LOCK_NAME, {
    timeoutMs: deps.lockTimeoutMs ?? 30 * 60_000,
    onWait: () => out('a watcher tick is running — waiting for it to finish …'),
  });
  try {
    // Read INSIDE the lock: a tick that just finished may have written a newer stand.
    let expected;
    try { expected = JSON.parse(readFileSync(expectedFile, 'utf8')); } catch (error) {
      throw new Error(`${expectedFile} is unreadable: ${error?.message ?? error}`);
    }
    const pair = expected?.pair ?? null;
    const read = readState(statePathOf(config), { now });
    if (read.kind === 'io-error') throw new Error(`state.json unreadable: ${read.error?.message}`);
    log(`SMOKE RETRY START ${pairText(pair)} ${expected?.baseUrl ?? ''}`);
    const rt = (deps.ensureRuntime ?? ensureRuntime)(config, read.state, {
      now, ...(deps.runtimeRunner ? { runner: deps.runtimeRunner } : {}), ...(deps.runtimePresent ? { present: deps.runtimePresent } : {}),
    });
    if (rt.action === 'installed') log(`RUNTIME INSTALL ${rt.reason} ok (see last-runtime.log)`);
    else if (rt.action === 'failed') log(`RUNTIME FAILED ${rt.reason ?? ''} ${rt.error ?? ''} (see last-runtime.log)`);
    try { rmSync(join(smokeOutDirOf(config), 'smoke-result.json'), { force: true }); } catch { /* best effort */ }
    const exit = await (deps.runSmoke ?? runSmokeChild)(config, expectedFile);
    // Any non-zero exit of the runner (3 = red, 2 = usage, a kill) without a result is red, never skipped.
    const smoke = readSmokeOutcome(config, { exitCode: exit.code === 0 ? 0 : SMOKE_FAILED_EXIT, pair, at: now() });
    if (exit.timedOut && !smoke.reason) smoke.reason = 'timeout';
    const next = { ...read.state, lastSmoke: smoke, runtime: rt.runtime ?? read.state.runtime ?? null };
    writeStateAtomic(statePathOf(config), next);
    log(smokeLogLine(smoke, 'SMOKE RETRY'));
    if (isSmokeTransitionToFailed(read.state.lastSmoke, smoke)) sendNotification(smokeNotification(smoke));
    out(`smoke ${String(smoke.status).toUpperCase()} ${pairText(pair)}${smoke.reason ? ` reason=${smoke.reason}` : ''} — ${smoke.reportPath}`);
    return { smoke, exit };
  } finally {
    await lock.release();
  }
}

// ─── Install / uninstall / purge (plan-488 §2.6, Phase 3) ────────────────

//! Nearest ancestor holding `.plastic` (same rule as scripts/lib/rv-machine-paths.mjs, inlined so
//! the installed copy stays self-contained).
export function findWorkspaceRoot(startDir) {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, '.plastic'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const xmlEscape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quoteArg = (value) => `"${String(value).replace(/"/g, '\\"')}"`;

//! The windowless launcher of the task: `conhost.exe --headless`. The task action itself must not
//! open a console (a console program started by the scheduler flashes a window every 3 minutes;
//! "hidden task" only hides the task in the UI and `windowsHide` only affects children). conhost in
//! headless mode hosts the console of its client without any window and exits only when that
//! client (node) has exited, so the watcher lives until its tick is done.
export function taskAction(config, { systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  return {
    command: join(systemRoot, 'System32', 'conhost.exe'),
    arguments: ['--headless', quoteArg(config.nodePath), quoteArg(join(config.root, 'bin', 'dev-deploy-watch.mjs')),
      '--config', quoteArg(join(config.root, 'config.json'))].join(' '),
    workingDirectory: config.root,
  };
}

//! Task Scheduler XML for the watcher task (plan-488 §2.6): interactive ("only when logged on"),
//! every 3 minutes and at logon, IgnoreNew, NO execution time limit (PT0S), runs on battery,
//! never wakes the machine, catches up missed runs.
export function buildTaskXml(config, { userId, startBoundary = '2026-01-01T00:00:00', systemRoot } = {}) {
  if (!userId) throw new Error('buildTaskXml needs the user id the task runs as.');
  const action = taskAction(config, systemRoot ? { systemRoot } : {});
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>realvirtual WEB: publishes origin/main of the WebViewer and Private repos to /dev (plan-488). Managed by dev-deploy-watch.mjs --install / --uninstall.</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    '      <Repetition>',
    '        <Interval>PT3M</Interval>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    `      <StartBoundary>${xmlEscape(startBoundary)}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xmlEscape(userId)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(userId)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(action.command)}</Command>`,
    `      <Arguments>${xmlEscape(action.arguments)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(action.workingDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

//! Default command runner: synchronous, windowless. Returns `{ status, stdout, stderr }`.
export function runCommand(file, args, options = {}) {
  const result = spawnSync(file, args, { windowsHide: true, encoding: 'utf8', ...options });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? (result.error ? result.error.message : '')).trim(),
  };
}

const realOrResolved = (path) => { try { return realpathSync.native(path); } catch { return resolve(path); } };

const SID_PATTERN = /^S-1-\d+(-\d+)+$/i;

//! The Windows `whoami.exe`, by absolute path. A bare `whoami` resolves through PATH, and a shell
//! started from Git Bash puts MSYS `/usr/bin/whoami` first, which prints `AzureAD+ThomasStrigl`
//! (MSYS joins domain and user with `+`) — a name Windows cannot resolve.
export function whoamiPath({ systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  return join(systemRoot, 'System32', 'whoami.exe');
}

//! Determines the current account by its SID via `whoami.exe /user /fo csv /nh`, which prints one
//! line `"DOMAIN\user","S-1-…"`. `runner` is `(file, args) => { status, stdout, stderr }`.
//! Throws when the command fails or no SID can be read — the task must never be registered for a
//! guessed account name.
export function resolveCurrentAccount(runner = runCommand, { systemRoot } = {}) {
  const exe = whoamiPath(systemRoot ? { systemRoot } : {});
  let result;
  try {
    result = runner(exe, ['/user', '/fo', 'csv', '/nh']);
  } catch (error) {
    throw new Error(`Cannot determine the current account: ${exe} failed (${error?.message ?? error}).`);
  }
  if (!result || result.status !== 0) {
    throw new Error(`Cannot determine the current account: ${exe} /user exited with ${result?.status} (${String(result?.stderr ?? '').trim() || 'no output'}).`);
  }
  const line = String(result.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const [name, sid] = fields.length >= 2 ? fields : line.split(',').map((f) => f.trim());
  if (!sid || !SID_PATTERN.test(sid)) {
    throw new Error(`Cannot determine the current account: no SID in the output of ${exe} /user (${JSON.stringify(line)}).`);
  }
  return { name: name || '(unknown)', sid: sid.toUpperCase() };
}

//! After a real registration: reads the task back (`schtasks /Query /TN … /XML`) and checks that it
//! exists and that its principal is the SID it was registered for. Task Scheduler exports the SID
//! for a SID principal; the account name `whoami` reported is accepted as the same account.
//! Throws on a missing task or a different principal.
export function verifyRegisteredTask(taskName, account, schtasks = runCommand) {
  const query = schtasks('schtasks', ['/Query', '/TN', taskName, '/XML']);
  if (!query || query.status !== 0 || !String(query.stdout ?? '').includes('<Task')) {
    throw new Error(`Task ${taskName} was not found after registration (schtasks /Query: ${String(query?.stderr || query?.stdout || '').trim() || `exit ${query?.status}`}).`);
  }
  const principal = /<Principal\b[^>]*>([\s\S]*?)<\/Principal>/.exec(query.stdout)?.[1] ?? '';
  const userId = (/<UserId>([^<]*)<\/UserId>/.exec(principal)?.[1] ?? '').trim();
  const matches = userId.toUpperCase() === account.sid.toUpperCase()
    || (account.name && userId.toLowerCase() === account.name.toLowerCase());
  if (!matches) {
    throw new Error(`Task ${taskName} is registered for "${userId || '(no principal)'}", expected ${account.name} (${account.sid}).`);
  }
  return { userId };
}

//! Resolves everything `--install` needs from the canonical checkout, without changing anything.
//! `options`: root, credentials[], taskName, nodePath, scriptDir, env, systemRoot. `deps`: git
//! (runner for read-only git queries), whoami (runner for `whoami.exe /user /fo csv /nh`).
//! The account is resolved FIRST, so a failure aborts before anything else runs.
export function resolveInstallPlan(options = {}, deps = {}) {
  const account = resolveCurrentAccount(deps.whoami ?? runCommand, options.systemRoot ? { systemRoot: options.systemRoot } : {});
  const env = options.env ?? process.env;
  const git = deps.git ?? runCommand;
  const scriptDir = resolve(options.scriptDir ?? SCRIPT_DIR);
  const canonicalWeb = resolve(scriptDir, '..');
  const workspaceRoot = options.workspaceRoot ?? (env.RV_WORKSPACE_ROOT ? resolve(env.RV_WORKSPACE_ROOT) : findWorkspaceRoot(canonicalWeb));
  if (!workspaceRoot) {
    throw new Error(`--install must run from the canonical checkout: no .plastic ancestor above ${canonicalWeb} `
      + '(a worktree or a clone is not a source for the watcher). Set RV_WORKSPACE_ROOT only if this checkout really is canonical.');
  }
  const canonicalPrivate = join(dirname(canonicalWeb), CLONE_DIRS.private);
  if (!existsSync(canonicalPrivate)) throw new Error(`Private sibling not found: ${canonicalPrivate}`);

  const root = resolve(options.root ?? join(dirname(workspaceRoot), 'rv-dev-deploy'));
  for (const source of [canonicalWeb, canonicalPrivate]) {
    const rel = relative(source, root);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new Error(`--root ${root} must not live inside the checkout ${source}.`);
    }
  }
  if (parsePath(root).root === root) throw new Error(`--root must not be a drive root: ${root}`);

  const remoteOf = (dir) => {
    const result = git('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    if (result.status !== 0 || !result.stdout) throw new Error(`Cannot read the origin remote of ${dir}: ${result.stderr}`);
    return result.stdout.split(/\r?\n/)[0].trim();
  };
  const autocrlfOf = (dir) => {
    const result = git('git', ['-C', dir, 'config', '--get', 'core.autocrlf']);
    return result.status === 0 && result.stdout ? result.stdout.trim() : null;
  };

  const credentialsFiles = (options.credentials?.length ? options.credentials : ['.env.production', '.env'].map((name) => join(canonicalWeb, name)))
    .map((file) => resolve(file));
  const existingCredentials = credentialsFiles.filter((file) => existsSync(file));

  const config = {
    version: 1,
    root: realOrResolved(root),
    clones: { web: join(realOrResolved(root), 'clones', CLONE_DIRS.web), private: join(realOrResolved(root), 'clones', CLONE_DIRS.private) },
    remotes: { web: remoteOf(canonicalWeb), private: remoteOf(canonicalPrivate) },
    autocrlf: { web: autocrlfOf(canonicalWeb), private: autocrlfOf(canonicalPrivate) },
    credentialsFiles: options.credentials?.length ? credentialsFiles : existingCredentials,
    nodePath: resolve(options.nodePath ?? process.execPath),
    workspaceRoot: resolve(workspaceRoot),
    taskName: options.taskName ?? DEFAULT_TASK_NAME,
    watcherLockName: WATCHER_LOCK_NAME,
    deployArgs: [...DEFAULT_DEPLOY_ARGS],
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    staleLockMinutes: STALE_LOCK_MINUTES,
    prepublishTimeoutSeconds: PREPUBLISH_TIMEOUT_SECONDS,
    branch: 'main',
    installedFrom: canonicalWeb,
    // plan-503: the demo smoke's browsers and output, both outside the clones.
    browsersPath: join(realOrResolved(root), BROWSERS_DIRNAME),
    smokeOutDir: join(realOrResolved(root), SMOKE_OUT_DIRNAME),
  };
  return {
    config,
    sources: { web: canonicalWeb, private: canonicalPrivate, scriptDir },
    credentialsMissing: config.credentialsFiles.length === 0 || config.credentialsFiles.some((file) => !existsSync(file)),
    account,
    userId: account.sid,
  };
}

//! `--install` (plan-488 Phase 3). Idempotent: creates `<root>`, clones both repos (or verifies an
//! existing clone's origin), sets `core.autocrlf` like the canonical checkout, copies the watcher and
//! the lock into `<root>\bin\`, writes `config.json`, creates the `enabled` switch on the FIRST
//! install only, and (re)registers the scheduled task with `schtasks /Create /XML … /F`.
//! `dryRun` prints every step and changes nothing (read-only git queries still run).
//! The task runs as the current account, written as its SID into `<Principal>` and `<LogonTrigger>`;
//! after a real registration the task is read back and its principal verified.
//! `deps`: git (runner), schtasks (runner), whoami (runner), out (line printer).
export function install(options = {}, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const git = deps.git ?? runCommand;
  const schtasks = deps.schtasks ?? runCommand;
  const dryRun = !!options.dryRun;
  const plan = resolveInstallPlan(options, deps);
  const { config, sources, account } = plan;
  if (plan.credentialsMissing) {
    const message = `No credentials file found (${config.credentialsFiles.join(', ') || '.env.production / .env in the checkout'}); pass --credentials <file>.`;
    if (!dryRun) throw new Error(message);
    out(`WARN ${message}`);
  }
  let configPath = join(config.root, 'config.json');
  const firstInstall = !existsSync(configPath);
  // A reinstall keeps the deployArgs of the existing config.json (e.g. an added --no-smoke) and
  // the watcher options of PRESERVED_CONFIG_KEYS: they are operator decisions, not something the
  // installer derives.
  if (!firstInstall) {
    try {
      const previous = JSON.parse(readFileSync(configPath, 'utf8'));
      if (Array.isArray(previous.deployArgs) && previous.deployArgs.every((arg) => typeof arg === 'string')) config.deployArgs = previous.deployArgs;
      for (const key of PRESERVED_CONFIG_KEYS) {
        if (key === 'deployArgs' || previous[key] === undefined) continue;
        config[key] = previous[key];
      }
    } catch { /* unreadable: the defaults are written */ }
  }
  const prefix = dryRun ? '[dry-run] would ' : '';
  const step = (text) => out(`${prefix}${text}`);

  out(`dev-deploy watcher install${dryRun ? ' (dry run — nothing is changed)' : ''}`);
  out(`  source      : ${sources.web}`);
  out(`  root        : ${config.root}`);
  out(`  node        : ${config.nodePath}`);
  out(`  workspace   : ${config.workspaceRoot}`);
  out(`  credentials : ${config.credentialsFiles.join(', ') || '(none)'}`);
  out(`  deploy args : ${config.deployArgs.join(' ')}`);
  out(`  task        : ${config.taskName} as ${account.name} (${account.sid})`);

  step(`create ${join(config.root, 'bin')} and ${join(config.root, 'clones')}`);
  if (!dryRun) {
    mkdirSync(join(config.root, 'bin'), { recursive: true });
    mkdirSync(join(config.root, 'clones'), { recursive: true });
    // The reset guard compares against these paths literally, so they must be the real ones.
    const realRoot = realpathSync.native(config.root);
    if (realRoot !== config.root) {
      config.root = realRoot;
      config.clones = { web: join(realRoot, 'clones', CLONE_DIRS.web), private: join(realRoot, 'clones', CLONE_DIRS.private) };
      config.browsersPath = join(realRoot, BROWSERS_DIRNAME);
      config.smokeOutDir = join(realRoot, SMOKE_OUT_DIRNAME);
      configPath = join(realRoot, 'config.json');
    }
  }
  const xml = buildTaskXml(config, { userId: plan.userId });

  for (const key of ['web', 'private']) {
    const clonePath = config.clones[key];
    const remote = config.remotes[key];
    const autocrlf = config.autocrlf[key];
    if (existsSync(join(clonePath, '.git'))) {
      const actual = git('git', ['-C', clonePath, 'remote', 'get-url', 'origin']);
      if (actual.status !== 0 || actual.stdout.trim() !== remote) {
        throw new Error(`Existing clone ${clonePath} has origin "${actual.stdout.trim()}", expected "${remote}". Remove it or run --purge.`);
      }
      out(`  clone ${key} : exists, origin verified`);
    } else {
      if (existsSync(clonePath)) throw new Error(`${clonePath} exists but is not a git clone. Remove it first.`);
      step(`git clone ${autocrlf != null ? `-c core.autocrlf=${autocrlf} ` : ''}--branch ${config.branch} ${remote} ${clonePath}`);
      if (!dryRun) {
        const cloned = git('git', ['clone', ...(autocrlf != null ? ['-c', `core.autocrlf=${autocrlf}`] : []), '--branch', config.branch, remote, clonePath]);
        if (cloned.status !== 0) throw new Error(`git clone ${remote} failed: ${cloned.stderr}`);
      }
    }
    if (autocrlf != null) {
      step(`set core.autocrlf=${autocrlf} in ${clonePath}`);
      if (!dryRun) {
        const set = git('git', ['-C', clonePath, 'config', 'core.autocrlf', autocrlf]);
        if (set.status !== 0) throw new Error(`git config core.autocrlf in ${clonePath} failed: ${set.stderr}`);
      }
    }
  }

  for (const file of INSTALLED_FILES) {
    const target = join(config.root, 'bin', file);
    step(`copy ${join(sources.scriptDir, file)} -> ${target}`);
    if (!dryRun) {
      // An entry may name a subfolder (`lib/rv-proc.mjs`, plan-587); a plain copyFileSync into
      // a folder that does not exist yet fails with ENOENT, so create it first.
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(sources.scriptDir, file), target);
    }
  }

  // plan-503: the smoke runtime of the web clone, once up front (a tick repeats it when needed).
  // A failure here does not abort the install — the next tick retries and logs RUNTIME FAILED.
  step(`create ${config.smokeOutDir} and ${config.browsersPath}`);
  if (!dryRun) {
    mkdirSync(config.smokeOutDir, { recursive: true });
    mkdirSync(config.browsersPath, { recursive: true });
  }
  if (smokeDisabled(config)) {
    out('  runtime     : skipped (smoke disabled)');
  } else if (dryRun) {
    for (const command of runtimeInstallCommands(config)) step(`run in ${config.clones.web}: ${commandText(command)} (PLAYWRIGHT_BROWSERS_PATH=${config.browsersPath})`);
  } else if (!lockHashOf(config.clones.web)) {
    out(`  runtime     : no package-lock.json in ${config.clones.web} — nothing to install`);
  } else {
    const statePath = statePathOf(config);
    const read = readState(statePath);
    const state = read.state ?? freshState();
    const rt = ensureRuntime(config, state, deps.runtimeRunner ? { runner: deps.runtimeRunner } : {});
    if (rt.action === 'installed' || rt.action === 'none') {
      out(`  runtime     : ${rt.action === 'installed' ? `installed (${rt.reason})` : 'current'} — ${config.browsersPath}`);
      if (rt.action === 'installed' && read.kind !== 'io-error') writeStateAtomic(statePath, { ...state, runtime: rt.runtime });
    } else {
      out(`  WARN runtime : ${rt.error ?? rt.reason} (see ${runtimeLogPathOf(config)}; the next tick retries)`);
    }
  }

  step(`write ${configPath}`);
  if (!dryRun) {
    const tmp = `${configPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(tmp, configPath);
  }
  if (firstInstall) {
    step(`create switch ${enabledPathOf(config)} (first install)`);
    if (!dryRun) writeFileSync(enabledPathOf(config), 'delete this file to pause automatic /dev deploys\n');
  } else {
    out(`  switch      : left as it is (${existsSync(enabledPathOf(config)) ? 'enabled' : 'disabled'})`);
  }

  const xmlPath = join(config.root, 'task.xml');
  step(`write ${xmlPath} and run: schtasks /Create /TN ${config.taskName} /XML ${xmlPath} /F`);
  if (dryRun) {
    out('--- task.xml ---');
    out(xml);
    return { dryRun: true, config, xml };
  }
  writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  const created = schtasks('schtasks', ['/Create', '/TN', config.taskName, '/XML', xmlPath, '/F']);
  if (created.status !== 0) throw new Error(`schtasks /Create failed: ${created.stderr || created.stdout}`);
  verifyRegisteredTask(config.taskName, account, schtasks);
  out(`  verified    : task ${config.taskName} exists, principal ${account.sid}`);
  out(`installed. Check with: node ${join(config.root, 'bin', 'dev-deploy-watch.mjs')} --status`);
  return { dryRun: false, config, xml };
}

//! `--uninstall`: removes the scheduled task only; clones, state and log stay.
export function uninstall(config, { dryRun = false } = {}, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const schtasks = deps.schtasks ?? runCommand;
  const taskName = config.taskName ?? DEFAULT_TASK_NAME;
  const query = schtasks('schtasks', ['/Query', '/TN', taskName]);
  if (query.status !== 0) {
    out(`task ${taskName} is not registered — nothing to remove`);
    return { removed: false };
  }
  if (dryRun) {
    out(`[dry-run] would run: schtasks /Delete /TN ${taskName} /F`);
    return { removed: false, dryRun: true };
  }
  const deleted = schtasks('schtasks', ['/Delete', '/TN', taskName, '/F']);
  if (deleted.status !== 0) throw new Error(`schtasks /Delete failed: ${deleted.stderr || deleted.stdout}`);
  out(`task ${taskName} removed (clones and state kept in ${config.root}; --purge deletes them)`);
  return { removed: true };
}

//! `--purge`: uninstall plus deleting `<root>` — refused while a tick runs (the watcher lock is busy)
//! and unless `<root>` really is a watcher root (config.json + clones inside, not a drive root).
export async function purge(config, configPath, { dryRun = false } = {}, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const root = resolve(config.root);
  if (!sameFsPath(resolve(dirname(configPath)), root)) throw new Error(`Refusing to purge: ${configPath} does not live in root ${root}.`);
  if (parsePath(root).root === root) throw new Error(`Refusing to purge a drive root: ${root}`);
  if (!existsSync(join(root, 'config.json')) || !existsSync(join(root, 'clones'))) {
    throw new Error(`Refusing to purge ${root}: it does not look like a watcher root (config.json and clones\\ expected).`);
  }
  const lock = await (deps.acquire ?? acquirePublishLock)(config.watcherLockName ?? WATCHER_LOCK_NAME, { timeoutMs: 0 }).catch((error) => {
    if (error?.code === LOCK_BUSY_CODE) throw new Error('A watcher tick is running right now — try --purge again when it has finished.');
    throw error;
  });
  try {
    uninstall(config, { dryRun }, deps);
    if (dryRun) {
      out(`[dry-run] would delete ${root}`);
      return { purged: false, dryRun: true };
    }
    rmSync(root, { recursive: true, force: true });
    out(`deleted ${root}`);
    return { purged: true };
  } finally {
    await lock.release();
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  const multi = { credentials: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (['config', 'root', 'task-name', 'node', 'credentials'].includes(name)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      if (name === 'credentials') multi.credentials.push(value);
      else values[name] = value;
    } else {
      flags.add(name);
    }
  }
  return { flags, values, multi };
}

function defaultConfigPath() {
  return resolve(SCRIPT_DIR, '..', 'config.json');
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, values, multi } = parseArgs(argv);
  const dryRun = flags.has('dry-run');
  if (flags.has('install')) {
    install({ root: values.root, credentials: multi.credentials, taskName: values['task-name'], nodePath: values.node, dryRun });
    return 0;
  }
  const configPath = resolve(values.config ?? defaultConfigPath());
  const config = loadWatcherConfig(configPath);
  if (flags.has('status')) {
    const status = collectStatus(config);
    console.log(flags.has('json') ? JSON.stringify(status, null, 2) : formatStatus(status));
    return 0;
  }
  if (flags.has('retry')) {
    const read = readState(statePathOf(config));
    if (read.kind === 'io-error') throw new Error(`state.json unreadable: ${read.error?.message}`);
    const retried = applyRetry(read.state);
    if (!retried.changed) { console.log('nothing to retry'); return 0; }
    writeStateAtomic(statePathOf(config), retried.state);
    appendLog(config, `RETRY requested ${pairText(retried.state.attempt.pair)} (counter reset)`);
    console.log(`counter reset for ${pairText(retried.state.attempt.pair)} — the next tick deploys it`);
    return 0;
  }
  if (flags.has('retry-smoke')) {
    const { smoke } = await retrySmoke(config);
    return smoke?.status === 'failed' ? SMOKE_FAILED_EXIT : 0;
  }
  if (flags.has('enable') || flags.has('disable')) {
    if (flags.has('enable')) writeFileSync(enabledPathOf(config), 'delete this file to pause automatic /dev deploys\n');
    else if (existsSync(enabledPathOf(config))) unlinkSync(enabledPathOf(config));
    appendLog(config, flags.has('enable') ? 'SWITCH enabled' : 'SWITCH disabled');
    console.log(flags.has('enable') ? 'enabled' : 'disabled');
    return 0;
  }
  if (flags.has('uninstall')) { uninstall(config, { dryRun }); return 0; }
  if (flags.has('purge')) { await purge(config, configPath, { dryRun }); return 0; }
  const result = await runTick(config);
  return result.outcome === 'deploy-failed' ? 1 : 0;
}

if (process.argv[1] && sameFsPath(realOrResolved(process.argv[1]), realOrResolved(SCRIPT_PATH))) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`dev-deploy-watch: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
