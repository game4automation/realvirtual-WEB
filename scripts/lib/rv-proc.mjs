// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-proc.mjs — the ONE "spawn a child, log it, limit it, kill its tree" helper
 * for the Node tooling (plan-587 Phase 3a).
 *
 * Before this file there were two `killTree` with DIFFERENT behaviour outside
 * Windows and three copies of "spawn a child and write its output somewhere",
 * one of them without any time limit. Everything about starting, logging,
 * limiting and ending a child process lives here now.
 *
 * Three properties worth knowing before changing anything:
 *
 * 1. **The Windows path is measured, the POSIX path is NOT.** On Windows
 *    `taskkill /T /F` ends the whole tree, and the watcher's own test proves it
 *    (a Playwright grandchild dies with the runner). On POSIX `killTree` signals
 *    the process GROUP (`-pid`) with `SIGTERM`, falls back to the bare pid, and
 *    escalates to `SIGKILL` after a grace period — but **nobody has measured
 *    whether that reaches the grandchildren**. Playwright starts its browser in
 *    a group of its own, and a group kill aimed at the runner does not
 *    necessarily reach it. This is the documented non-guarantee of plan-587
 *    §4 Phase 3b ("ends the runner, not guaranteed its grandchildren"), not an
 *    oversight: the development machine is `win32`, so the question was not
 *    answerable here (§4b M3). Do not turn it into a promise without a
 *    measurement on a POSIX machine.
 *
 * 2. **The timeout is phase-aware, and the phase is REPORTED, never guessed**
 *    (F4). When the deadline passes and a `phaseFile` was given, that file is
 *    read (`{ phase, at }`, written atomically by the child) and the child is
 *    killed ONLY in phase `build`. In `upload`, `published` or `smoke` a kill
 *    would abort a publish that is already underway, so the helper only writes a
 *    note into the log and keeps watching. A missing or unreadable phase file is
 *    the conservative case: **no kill**, note in the log. Parsing the child's
 *    LOG for its phase is explicitly not the mechanism — the output goes
 *    straight into a file, reading it back would be delayed and format
 *    dependent.
 *
 * 3. **One `openSync`/`closeSync` pair.** The log handle is opened once, handed
 *    to the child as stdout AND stderr, and closed in a `finally` — the three
 *    copies this file replaces each had their own pair.
 *
 * Zero dependencies: Node built-ins only, so the copy the deploy watcher
 * installs under `<root>\bin\lib\` stays self-contained.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';

//! Grace period between `SIGTERM` and `SIGKILL` on POSIX. Unused on Windows
//! (`taskkill /F` is immediate and has no polite stage).
export const KILL_ESCALATION_MS = 5_000;

//! The ONLY phase in which an expired deadline kills the child (F4): during the
//! build nothing is published yet, so a kill costs a retry and nothing else.
export const KILLABLE_PHASES = Object.freeze(['build']);

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};

const message = (error) => String(error?.message ?? error);

//! Ends a process and, as far as the platform allows, its children.
//!
//! Windows: `taskkill /PID <pid> /T /F` — the whole tree, measured (the smoke
//! runner's Playwright grandchild dies with it).
//!
//! POSIX: `SIGTERM` to the process GROUP (`-pid`), with the bare pid as a
//! fallback for a child that was not spawned `detached`, and a `SIGKILL` to the
//! same target after `escalateAfterMs`.
//!
//! **The POSIX reliability is NOT measured.** A group kill aimed at the runner
//! does not necessarily reach a grandchild that opened its own process group —
//! which is exactly what Playwright does with its browser. Treat this as "ends
//! the runner, not guaranteed its grandchildren" until somebody measures it on
//! a POSIX machine (plan-587 §4b M3 / §4 Phase 3b). The escalation is here
//! because the fassung this replaces (`rv-demo-smoke.mjs`) sent `SIGTERM` and
//! then gave up, so a child ignoring the signal simply survived.
//!
//! Returns `{ platform, ok, target, escalation }`; never throws.
export function killTree(pid, {
  escalateAfterMs = KILL_ESCALATION_MS,
  platform = process.platform,
  runSync = nodeSpawnSync,
  kill = (target, signal) => process.kill(target, signal),
  schedule = defaultSchedule,
} = {}) {
  if (!pid) return { platform, ok: false, target: null, escalation: null };

  if (platform === 'win32') {
    let status = -1;
    try {
      status = runSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })?.status ?? -1;
    } catch { /* best effort — the caller reports the timeout either way */ }
    return { platform, ok: status === 0, target: 'tree', escalation: null };
  }

  // POSIX: the group first, the single process as a fallback.
  let target = null;
  try {
    kill(-pid, 'SIGTERM');
    target = 'group';
  } catch {
    try {
      kill(pid, 'SIGTERM');
      target = 'pid';
    } catch { /* already gone */ }
  }
  if (!target) return { platform, ok: false, target: null, escalation: null };

  const signalTarget = target === 'group' ? -pid : pid;
  const escalation = escalateAfterMs > 0
    ? schedule(() => { try { kill(signalTarget, 'SIGKILL'); } catch { /* exited in the grace period */ } }, escalateAfterMs)
    : null;
  return { platform, ok: true, target, escalation };
}

//! Reads the phase a child reported (`{ phase, at }`) and decides whether an
//! expired deadline may kill it. Pure apart from the file read.
//!
//! Returns `{ kill, phase, reason }`. No `phaseFile` at all means a plain
//! timeout (`reason: 'no-phase-file'`, `kill: true`) — the three callers that
//! have no phase reporting keep their old behaviour. A phase file that is
//! missing or unreadable is the CONSERVATIVE case: `kill: false`, because the
//! child may be in the middle of a publish.
export function decideTimeoutKill(phaseFile, { killablePhases = KILLABLE_PHASES, readFile = readFileSync } = {}) {
  if (!phaseFile) return { kill: true, phase: null, reason: 'no-phase-file' };
  let phase;
  try {
    phase = JSON.parse(String(readFile(phaseFile, 'utf8')))?.phase;
  } catch (error) {
    return { kill: false, phase: null, reason: `phase unreadable (${message(error)})` };
  }
  if (typeof phase !== 'string' || phase === '') return { kill: false, phase: null, reason: 'phase missing in phase file' };
  if (killablePhases.includes(phase)) return { kill: true, phase, reason: `phase ${phase}` };
  return { kill: false, phase, reason: `phase ${phase} — a kill would abort a publish already underway` };
}

//! Spawns a child, routes its output, enforces a time limit and resolves its
//! outcome. The one spawn/log/timeout place of the Node tooling.
//!
//! Options:
//! - `file`, `args`, `cwd`, `env`, `detached`, `stdin` — as for `child_process.spawn`
//! - `logPath` — stdout AND stderr go into this file (`'w'`, truncating), on ONE
//!   descriptor that is closed again right after the spawn
//! - `capture` — collect stdout/stderr as strings instead (the default when
//!   there is no `logPath`); both at once is not supported
//! - `timeoutMs` — deadline; `null`/`0` = none
//! - `phaseFile` — the child's `{ phase, at }` file (see `decideTimeoutKill`)
//! - `afterKill()` — runs once after a KILLED child has closed, i.e. the moment
//!   its leftovers (lock files …) may be removed. A throwing hook never breaks
//!   the result.
//!
//! Returns `{ pid, exit }` — `pid` synchronously (callers pass it on), `exit` a
//! promise that NEVER rejects and resolves
//! `{ code, signal, timedOut, killed, timeoutPhase, error, stdout, stderr, pid }`.
//! Resolution happens on `close`, not on `exit`, so captured output is complete
//! and a killed tree has really ended.
export function spawnLogged({
  file,
  args = [],
  cwd = undefined,
  env = undefined,
  logPath = null,
  capture = !logPath,
  timeoutMs = null,
  afterKill = null,
  phaseFile = null,
  killablePhases = KILLABLE_PHASES,
  detached = false,
  stdin = 'ignore',
  windowsHide = true,
  deps = {},
}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const open = deps.openSync ?? openSync;
  const close = deps.closeSync ?? closeSync;
  const append = deps.appendFileSync ?? appendFileSync;
  const readFile = deps.readFileSync ?? readFileSync;
  const endTree = deps.killTree ?? killTree;

  if (logPath && capture) throw new Error('spawnLogged: logPath and capture are mutually exclusive');

  const note = (line) => {
    if (!logPath) return;
    try { append(logPath, `[rv-proc] ${line}\n`); } catch { /* the note must never break the run */ }
  };

  let child;
  let out = null;
  try {
    if (logPath) out = open(logPath, 'w');
    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached,
        windowsHide,
        stdio: logPath ? [stdin, out, out] : [stdin, 'pipe', 'pipe'],
      });
    } finally {
      if (out !== null) close(out);
    }
  } catch (error) {
    return { pid: undefined, exit: Promise.resolve(failed(message(error))) };
  }

  let stdout = '';
  let stderr = '';
  if (capture) {
    child.stdout?.on?.('data', (chunk) => { stdout += chunk; });
    child.stderr?.on?.('data', (chunk) => { stderr += chunk; });
  }

  let timedOut = false;
  let killed = false;
  let timeoutPhase = null;
  let error = null;
  let timer = null;

  const exit = new Promise((resolveExit) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveExit({ ...result, pid: child.pid, stdout, stderr, timedOut, killed, timeoutPhase, error });
    };

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        const verdict = decideTimeoutKill(phaseFile, { killablePhases, readFile });
        timeoutPhase = verdict.phase;
        if (!verdict.kill) {
          note(`timeout after ${timeoutMs} ms: NOT killed — ${verdict.reason}; still watching`);
          return;
        }
        note(`timeout after ${timeoutMs} ms: killing the process tree — ${verdict.reason}`);
        killed = true;
        endTree(child.pid);
      }, timeoutMs);
    }

    child.on('error', (spawnError) => {
      error = message(spawnError);
      if (capture) stderr += error;
      // `close` still arrives for a child that failed to spawn; a child that
      // errors without closing would otherwise hang the caller forever.
      settle({ code: -1, signal: null });
    });
    child.on('close', (code, signal) => {
      if (killed && afterKill) {
        try { afterKill(); } catch { /* the heal is best effort; the timeout is reported either way */ }
      }
      settle({ code: code ?? -1, signal: signal ?? null });
    });
  });

  return { pid: child.pid, exit };
}

function failed(error) {
  return {
    code: -1, signal: null, timedOut: false, killed: false, timeoutPhase: null,
    error, stdout: '', stderr: error, pid: undefined,
  };
}
