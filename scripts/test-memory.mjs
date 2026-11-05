// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Free-memory gate of the test lock (plan-2247).
 *
 * `scripts/with-test-lock.mjs` checks free commit before AND after it takes the lock. A failed
 * recheck releases the whole lock before waiting again. A run below its threshold waits without
 * holding the lock or any port, so it never
 * blocks another run; it is visible while it waits through one file per waiting process in the
 * wait directory, which `node scripts/test-lock.mjs status` lists as
 * `[test-lock] WAITING for memory: PID … (class …, need N GB, have X GB, since …)`.
 *
 * Measurement (same as `Tools/mem-gate/mem-gate.mjs`): Windows `FreeVirtualMemory` (free commit),
 * Linux `MemAvailable`.
 *
 * Environment:
 *   RV_TEST_MIN_FREE_GB            threshold in GB for every class (`0` = gate off); the CLI option
 *                                  `--min-free-gb <n>` of with-test-lock wins over it
 *   RV_TEST_MEMORY_WAIT_SECONDS    how long a run waits for memory before exit 1 (default 1800)
 *   RV_TEST_MEMORY_POLL_SECONDS    re-measure interval (default 30)
 *   RV_TEST_MEMORY_QUERY_TIMEOUT_SECONDS  bound of one memory query (default 10); a query that
 *                                  does not answer in time counts as UNKNOWN - the run keeps waiting
 *   RV_TEST_MEMORY_WAIT_DIR        wait directory (default `<os.tmpdir()>/rv-test-lock-waiting`)
 *   RV_TEST_MEMORY_FAKE_FILE       TEST SEAM: a file holding the "free GB" number (or `stall`), read
 *                                  on every measurement instead of the operating system
 * Defaults per class: light 8 GB, heavy 10 GB, exclusive 10 GB.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MIN_FREE_GB = Object.freeze({ light: 8, heavy: 10, exclusive: 10 });
export const DEFAULT_MEMORY_WAIT_SECONDS = 1800;
export const DEFAULT_MEMORY_POLL_SECONDS = 30;
export const DEFAULT_MEMORY_QUERY_TIMEOUT_SECONDS = 10;

const nonNegative = (value) => {
  const raw = String(value ?? '').trim();
  if (raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const positive = (value, fallback) => {
  const n = nonNegative(value);
  return n !== undefined && n > 0 ? n : fallback;
};

/** Threshold for `klass`: CLI option, else `RV_TEST_MIN_FREE_GB`, else the class default; `0` = off. */
export function minFreeGbFor(klass, { option, env = process.env } = {}) {
  const fromOption = nonNegative(option);
  if (fromOption !== undefined) return fromOption;
  const fromEnv = nonNegative(env.RV_TEST_MIN_FREE_GB);
  if (fromEnv !== undefined) return fromEnv;
  return DEFAULT_MIN_FREE_GB[klass] ?? DEFAULT_MIN_FREE_GB.heavy;
}

export function memoryConfig(env = process.env) {
  return {
    waitSeconds: positive(env.RV_TEST_MEMORY_WAIT_SECONDS, DEFAULT_MEMORY_WAIT_SECONDS),
    pollSeconds: positive(env.RV_TEST_MEMORY_POLL_SECONDS, DEFAULT_MEMORY_POLL_SECONDS),
    waitDir: env.RV_TEST_MEMORY_WAIT_DIR || path.join(os.tmpdir(), 'rv-test-lock-waiting'),
    queryTimeoutMs: positive(env.RV_TEST_MEMORY_QUERY_TIMEOUT_SECONDS, DEFAULT_MEMORY_QUERY_TIMEOUT_SECONDS) * 1000,
  };
}

/**
 * Free commit in GB, asynchronously and bounded: the PowerShell/CIM query
 * is killed after `timeoutMs` (`RV_TEST_MEMORY_QUERY_TIMEOUT_SECONDS`, default 10) or on `signal`,
 * and resolves NaN ("unknown") instead of blocking the event loop - a stalled query must neither
 * pass the gate nor stop the deadline and the signal handlers. NaN = unknown, never "enough".
 * Test seam `RV_TEST_MEMORY_FAKE_FILE`: the file holds the number, or `stall` for a query that
 * never answers.
 */
export function readFreeGb(env = process.env, { timeoutMs = memoryConfig(env).queryTimeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let child = null;
    let timer = null;
    const onAbort = () => finish(NaN);
    function finish(value) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      resolve(value);
    }
    timer = setTimeout(() => finish(NaN), Math.max(1, timeoutMs));
    if (signal?.aborted) { finish(NaN); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (env.RV_TEST_MEMORY_FAKE_FILE) {
      let text = '';
      try { text = readFileSync(env.RV_TEST_MEMORY_FAKE_FILE, 'utf8').trim(); } catch { finish(NaN); return; }
      if (text === 'stall') return; // never answers: only the timeout or the signal ends it
      finish(nonNegative(text) ?? NaN);
      return;
    }
    if (process.platform !== 'win32') {
      try {
        const m = /MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'));
        finish(m ? Number(m[1]) / 1024 / 1024 : NaN);
      } catch { finish(NaN); }
      return;
    }
    try {
      child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory'], { encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        const kb = Number(String(stdout ?? '').trim());
        finish(!error && Number.isFinite(kb) && kb > 0 ? kb / 1024 / 1024 : NaN);
      });
    } catch { finish(NaN); }
  });
}

const isAlive = (pid) => {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

/** Live waiting runs in `dir`; entries of dead PIDs (and unreadable ones) are removed. */
export function listWaiting(dir = memoryConfig().waitDir) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return []; }
  const live = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let entry = null;
    try { entry = JSON.parse(readFileSync(file, 'utf8')); } catch { /* torn or foreign */ }
    if (entry && isAlive(entry.pid)) { live.push(entry); continue; }
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  return live.sort((a, b) => String(a.since).localeCompare(String(b.since)));
}

/** The status line for one waiting run (parsed by rv-plan-board `parseTestLock`). */
export function formatWaiting(entry) {
  // `haveGb: null` = still measuring or the last query timed out: printed as `?` (the board parser accepts it).
  const gb = (n) => (n !== null && n !== undefined && Number.isFinite(Number(n)) ? Number(n).toFixed(1) : '?');
  return `[test-lock] WAITING for memory: PID ${entry.pid} (class ${entry.class}, need ${gb(entry.needGb)} GB, have ${gb(entry.haveGb)} GB, since ${entry.since})`;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const finish = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
  if (signal?.aborted) finish();
});

/**
 * Waits until at least `needGb` GB are free. Holds NO lock and NO port while it waits. The wait
 * entry `<waitDir>/<pid>.json` is written BEFORE the first measurement (`haveGb: null` = still
 * measuring), so even a stalled first query is visible; it is removed when this returns, throws, or
 * the process exits. An unknown reading (NaN: timed out, unreadable) keeps waiting - it never
 * passes. `deadline` (ms epoch) lets a caller that re-enters the wait keep ONE overall wait budget.
 * Resolves `{ ok: true, haveGb, waitedMs }` or `{ ok: false, message }` (the caller exits 1).
 */
export async function waitForMemory({
  klass, needGb, argv = [], env = process.env, log = (m) => process.stderr.write(`${m}\n`),
  read = (opts) => readFreeGb(env, opts), signal, deadline: givenDeadline, reason = '',
} = {}) {
  if (!(needGb > 0)) return { ok: true, haveGb: NaN, waitedMs: 0, skipped: true };
  const { waitSeconds, pollSeconds, waitDir, queryTimeoutMs } = memoryConfig(env);
  const started = Date.now();
  const deadline = givenDeadline ?? started + waitSeconds * 1000;
  let have = NaN;
  const file = path.join(waitDir, `${process.pid}.json`);
  const since = new Date().toISOString();
  const write = () => {
    try {
      mkdirSync(waitDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ pid: process.pid, argv, class: klass, needGb, haveGb: Number.isFinite(have) ? have : null, since }));
    } catch { /* visibility is best effort; waiting still works */ }
  };
  const remove = () => { try { rmSync(file, { force: true }); } catch { /* gone */ } };
  process.once('exit', remove);
  write();
  const gb = (n) => (Number.isFinite(n) ? `${n.toFixed(1)} GB` : 'unknown (memory query timed out or failed)');
  try {
    let first = true;
    for (;;) {
      if (signal?.aborted) return { ok: false, message: 'aborted while waiting for memory' };
      const left = deadline - Date.now();
      if (left > 0) {
        try { have = await read({ timeoutMs: Math.max(1, Math.min(queryTimeoutMs, left)), signal }); }
        catch { have = NaN; }
      }
      if (signal?.aborted) return { ok: false, message: 'aborted while waiting for memory' };
      if (Date.now() < deadline && Number.isFinite(have) && have >= needGb) {
        return { ok: true, haveGb: have, waitedMs: Date.now() - started };
      }
      write();
      if (first || Date.now() >= deadline) {
        log(`[test-lock] WAITING for memory${reason ? ` (${reason})` : ''}: class ${klass} needs ${needGb} GB free, have ${gb(have)} - no lock held; re-check every ${pollSeconds} s (${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} s left; RV_TEST_MIN_FREE_GB=0 disables)`);
      }
      first = false;
      if (Date.now() >= deadline) {
        return { ok: false, message: `waited ${Math.round((Date.now() - started) / 1000)} s for ${needGb} GB free, have ${gb(have)} - gave up (RV_TEST_MEMORY_WAIT_SECONDS=${waitSeconds}; RV_TEST_MIN_FREE_GB=0 disables the check)` };
      }
      await sleep(Math.max(1, Math.min(pollSeconds * 1000, deadline - Date.now())), signal);
    }
  } finally {
    remove();
    process.removeListener('exit', remove);
  }
}
