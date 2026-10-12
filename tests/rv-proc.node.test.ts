// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The ONE process helper (`scripts/lib/rv-proc.mjs`, plan-587 Phase 3a).
 *
 * Before it there were two `killTree` with different behaviour outside Windows
 * and three copies of "spawn a child and write its output somewhere", one of
 * them without any time limit. These tests nail down what the plan asks for
 * (§9.2): the kill, the timeout with its `afterKill` hook, the log file — and
 * the phase-aware timeout of F4, whose whole point is that it does NOT kill a
 * child that is already publishing.
 *
 * Every child is a real `node -e` process; nothing is deployed and no network
 * is touched. Children are killed in `afterEach`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
// Typed through the sibling declaration file scripts/lib/rv-proc.d.mts.
import { killTree, spawnLogged, decideTimeoutKill, KILLABLE_PHASES } from '../scripts/lib/rv-proc.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */

const IS_WIN = process.platform === 'win32';

let base: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rv-proc-test-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

//! A node child that stays alive until it is killed.
const SLEEPER = 'setInterval(() => {}, 1000);';

describe('killTree (plan-587 F3)', () => {
  it('Test_KillTree_Windows_UsesTaskkillOnTheTree', () => {
    const calls: unknown[][] = [];
    const result = killTree(4242, {
      platform: 'win32',
      runSync: (...args: unknown[]) => { calls.push(args); return { status: 0 }; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('taskkill');
    expect(calls[0][1]).toEqual(['/PID', '4242', '/T', '/F']);
    expect(result).toMatchObject({ ok: true, target: 'tree', escalation: null });
  });

  it('Test_KillTree_NoPid_DoesNothing', () => {
    const calls: unknown[][] = [];
    expect(killTree(undefined, { platform: 'win32', runSync: (...a: unknown[]) => { calls.push(a); return { status: 0 }; } }))
      .toMatchObject({ ok: false, target: null });
    expect(calls).toEqual([]);
  });

  it('Test_KillTree_WindowsTaskkillThrows_IsReportedNotThrown', () => {
    expect(killTree(1, { platform: 'win32', runSync: () => { throw new Error('taskkill missing'); } }))
      .toMatchObject({ ok: false, target: 'tree' });
  });

  // The POSIX branch, driven through the seams: it proves the ORDER of signals
  // (group SIGTERM, pid fallback, SIGKILL escalation) on any platform. It does
  // NOT prove that a grandchild dies — see the next test and the module header.
  it('Test_KillTree_PosixBranch_SignalsGroupThenEscalates_SeamOnly', () => {
    const sent: Array<[number, string]> = [];
    let escalate: (() => void) | null = null;
    const result = killTree(777, {
      platform: 'linux',
      kill: (target: number, signal: string) => { sent.push([target, signal]); },
      schedule: (fn: () => void) => { escalate = fn; return 'timer'; },
      escalateAfterMs: 50,
    });
    expect(sent).toEqual([[-777, 'SIGTERM']]);
    expect(result).toMatchObject({ ok: true, target: 'group', escalation: 'timer' });
    escalate!();
    expect(sent).toEqual([[-777, 'SIGTERM'], [-777, 'SIGKILL']]);
  });

  it('Test_KillTree_PosixBranch_FallsBackToThePidWhenThereIsNoGroup_SeamOnly', () => {
    const sent: Array<[number, string]> = [];
    let escalate: (() => void) | null = null;
    killTree(555, {
      platform: 'darwin',
      kill: (target: number, signal: string) => {
        if (target < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        sent.push([target, signal]);
      },
      schedule: (fn: () => void) => { escalate = fn; return 'timer'; },
    });
    expect(sent).toEqual([[555, 'SIGTERM']]);
    escalate!();
    expect(sent).toEqual([[555, 'SIGTERM'], [555, 'SIGKILL']]);
    // A process that is gone entirely is reported, never thrown.
    expect(killTree(1, { platform: 'linux', kill: () => { throw new Error('ESRCH'); } }))
      .toMatchObject({ ok: false, target: null });
  });

  // §9.2 `Test_KillTree_Posix_KillsProcessGroup`. SKIPPED on win32 on purpose:
  // the development machine is Windows (plan-587 §4b M3), so the POSIX
  // behaviour is NOT MEASURABLE here and a green test would be a lie. The
  // reliability against Playwright's grandchildren is unmeasured even on POSIX
  // — see the module header of rv-proc.mjs.
  it.skipIf(IS_WIN)('Test_KillTree_Posix_KillsProcessGroup', async () => {
    const child = spawn(process.execPath, ['-e', SLEEPER], { detached: true, stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(child.pid)).toBe(true);
    const result = killTree(child.pid, { escalateAfterMs: 500 });
    expect(result).toMatchObject({ target: 'group', ok: true });
    const deadline = Date.now() + 5_000;
    while (alive(child.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(child.pid)).toBe(false);
  }, 20_000);
});

describe('decideTimeoutKill (plan-587 F4)', () => {
  const phaseFile = () => join(base, 'deploy-phase.json');
  const writePhase = (phase: unknown) => writeFileSync(phaseFile(), JSON.stringify({ phase, at: 1 }));

  it('kills without a phase file at all — the plain timeout of the three migrated callers', () => {
    expect(decideTimeoutKill(null)).toMatchObject({ kill: true, phase: null, reason: 'no-phase-file' });
  });

  it('kills in phase build and in no other phase', () => {
    writePhase('build');
    expect(decideTimeoutKill(phaseFile())).toMatchObject({ kill: true, phase: 'build' });
    for (const phase of ['upload', 'published', 'smoke']) {
      writePhase(phase);
      expect(decideTimeoutKill(phaseFile())).toMatchObject({ kill: false, phase });
    }
    expect(KILLABLE_PHASES).toEqual(['build']);
  });

  it('is conservative for a missing, corrupt or phase-less file: no kill', () => {
    expect(decideTimeoutKill(join(base, 'absent.json'))).toMatchObject({ kill: false, phase: null });
    writeFileSync(phaseFile(), '{not json');
    expect(decideTimeoutKill(phaseFile())).toMatchObject({ kill: false, phase: null });
    writeFileSync(phaseFile(), JSON.stringify({ at: 1 }));
    expect(decideTimeoutKill(phaseFile())).toMatchObject({ kill: false, phase: null });
    writePhase(17);
    expect(decideTimeoutKill(phaseFile())).toMatchObject({ kill: false, phase: null });
  });
});

describe('spawnLogged (plan-587 F4)', () => {
  it('Test_SpawnLogged_WritesLogFile', async () => {
    const logPath = join(base, 'child.log');
    const { pid, exit } = spawnLogged({
      file: process.execPath,
      args: ['-e', 'console.log("to stdout"); console.error("to stderr");'],
      logPath,
    });
    expect(pid).toBeGreaterThan(0);
    const result = await exit;
    expect(result).toMatchObject({ code: 0, timedOut: false, killed: false, error: null });
    const text = readFileSync(logPath, 'utf8');
    expect(text).toContain('to stdout');
    expect(text).toContain('to stderr');
    // The descriptor is closed right after the spawn — a truncating re-open proves no handle is held.
    writeFileSync(logPath, 'reopened');
    expect(readFileSync(logPath, 'utf8')).toBe('reopened');
  }, 30_000);

  it('captures stdout and stderr as strings when there is no log file (the runGit mode)', async () => {
    const { exit } = spawnLogged({
      file: process.execPath,
      args: ['-e', 'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(7);'],
    });
    const result = await exit;
    expect(result.code).toBe(7);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(existsSync(join(base, 'child.log'))).toBe(false);
  }, 30_000);

  it('reports a child that cannot be spawned instead of throwing', async () => {
    const { exit } = spawnLogged({ file: join(base, 'no-such-binary-rv587'), args: [] });
    const result = await exit;
    expect(result.code).toBe(-1);
    expect(String(result.error)).toMatch(/ENOENT|no-such-binary-rv587/);
    expect(result.timedOut).toBe(false);
  }, 30_000);

  it('refuses logPath and capture at the same time', () => {
    expect(() => spawnLogged({ file: process.execPath, args: [], logPath: join(base, 'x.log'), capture: true }))
      .toThrow(/mutually exclusive/);
  });

  it('Test_SpawnLogged_Timeout_KillsAndReports', async () => {
    const logPath = join(base, 'timeout.log');
    let afterKillRuns = 0;
    const { pid, exit } = spawnLogged({
      file: process.execPath,
      args: ['-e', SLEEPER],
      logPath,
      timeoutMs: 400,
      afterKill: () => { afterKillRuns += 1; },
    });
    const result = await exit;
    expect(result).toMatchObject({ timedOut: true, killed: true });
    expect(afterKillRuns).toBe(1);
    expect(readFileSync(logPath, 'utf8')).toMatch(/\[rv-proc\] timeout after 400 ms: killing the process tree/);
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('a throwing afterKill never breaks the result', async () => {
    const { exit } = spawnLogged({
      file: process.execPath,
      args: ['-e', SLEEPER],
      logPath: join(base, 'throwing.log'),
      timeoutMs: 300,
      afterKill: () => { throw new Error('heal failed'); },
    });
    await expect(exit).resolves.toMatchObject({ timedOut: true, killed: true });
  }, 30_000);

  it('Test_SpawnLogged_Timeout_PhaseBuild_Kills', async () => {
    const phaseFile = join(base, 'deploy-phase.json');
    writeFileSync(phaseFile, JSON.stringify({ phase: 'build', at: 1 }));
    const logPath = join(base, 'build.log');
    const { exit } = spawnLogged({ file: process.execPath, args: ['-e', SLEEPER], logPath, timeoutMs: 400, phaseFile });
    const result = await exit;
    expect(result).toMatchObject({ timedOut: true, killed: true, timeoutPhase: 'build' });
    expect(readFileSync(logPath, 'utf8')).toMatch(/killing the process tree — phase build/);
  }, 30_000);

  it.each(['upload', 'published', 'smoke'])('Test_SpawnLogged_Timeout_Phase%s_DoesNotKill', async (phase) => {
    const phaseFile = join(base, 'deploy-phase.json');
    writeFileSync(phaseFile, JSON.stringify({ phase, at: 1 }));
    const logPath = join(base, `${phase}.log`);
    // The child ends BY ITSELF well after the deadline: a kill would have cut it short,
    // so its own exit code 5 is the proof that it was left alone.
    const { exit } = spawnLogged({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(5), 1200);'],
      logPath,
      timeoutMs: 300,
      phaseFile,
    });
    const result = await exit;
    expect(result).toMatchObject({ code: 5, timedOut: true, killed: false, timeoutPhase: phase });
    expect(readFileSync(logPath, 'utf8')).toMatch(/NOT killed — phase .* a kill would abort a publish already underway/);
  }, 30_000);

  it('Test_SpawnLogged_Timeout_PhaseFileMissingOrCorrupt_DoesNotKill', async () => {
    for (const [name, write] of [
      ['absent', () => {}],
      ['corrupt', () => writeFileSync(join(base, 'phase-corrupt.json'), '{not json')],
    ] as Array<[string, () => void]>) {
      write();
      const logPath = join(base, `${name}.log`);
      const { exit } = spawnLogged({
        file: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(5), 1200);'],
        logPath,
        timeoutMs: 300,
        phaseFile: join(base, `phase-${name}.json`),
      });
      const result = await exit;
      expect(result).toMatchObject({ code: 5, timedOut: true, killed: false, timeoutPhase: null });
      expect(readFileSync(logPath, 'utf8')).toMatch(/NOT killed/);
    }
  }, 60_000);
});
