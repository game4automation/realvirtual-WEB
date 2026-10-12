// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-488 §9 group A — the named-pipe publish lock.
 *
 * The lock is only as good as the lifetime of the process that owns it, so these tests use REAL
 * child processes. Every pipe name carries this run's PID and a random suffix, so a test can never
 * collide with a real `rv-publish-…` lock of a deploy running on the same machine. Every spawned
 * process is killed in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import { acquirePublishLock, normalizeLockName, tryListenPipe, LOCK_BUSY_CODE, MAX_LOCK_NAME_LENGTH } from '../scripts/rv-publish-lock.mjs';

type Lock = { name: string; release(): Promise<void> };
type Acquire = (name: string, options?: Record<string, unknown>) => Promise<Lock>;
const acquire = acquirePublishLock as Acquire;

const LOCK_URL = pathToFileURL(resolve(__dirname, '../scripts/rv-publish-lock.mjs')).href;
const isWindows = process.platform === 'win32';

const uniqueName = (label: string) => `rv-test-488-${label}-${process.pid}-${randomBytes(4).toString('hex')}`;
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  }
});

//! Spawns a node process running `body` as an ES module with `acquirePublishLock` in scope.
function spawnNode(body: string, args: string[] = []): ChildProcess {
  const source = `import { acquirePublishLock } from ${JSON.stringify(LOCK_URL)};\n${body}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, '--', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs = 15000): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = '';
    let errors = '';
    const timer = setTimeout(() => rejectLine(new Error(`timeout waiting for ${pattern}; stdout=${buffer} stderr=${errors}`)), timeoutMs);
    child.stderr!.on('data', (chunk) => { errors += String(chunk); });
    child.stdout!.on('data', (chunk) => {
      buffer += String(chunk);
      const match = buffer.split(/\r?\n/).find((line) => pattern.test(line));
      if (match) { clearTimeout(timer); resolveLine(match); }
    });
    child.once('exit', (code) => {
      const match = buffer.split(/\r?\n/).find((line) => pattern.test(line));
      if (match) return;
      clearTimeout(timer);
      rejectLine(new Error(`process exited (${code}) before ${pattern}; stdout=${buffer} stderr=${errors}`));
    });
  });
}

const exited = (child: ChildProcess) => new Promise<number | null>((resolveExit) => {
  if (child.exitCode !== null || child.signalCode !== null) resolveExit(child.exitCode);
  else child.once('exit', (code) => resolveExit(code));
});

//! A holder process: acquires `name`, prints HELD, releases when a line arrives on stdin.
function spawnHolder(name: string): ChildProcess {
  return spawnNode(`
    const lock = await acquirePublishLock(process.argv[1], { timeoutMs: 0 });
    console.log('HELD');
    process.stdin.once('data', async () => { await lock.release(); console.log('RELEASED'); process.exit(0); });
  `, [name]);
}

describe.skipIf(!isWindows)('rv-publish-lock — named pipe mutex (plan-488 §9 A)', () => {
  it('a second acquisition waits until the first one releases', async () => {
    const name = uniqueName('wait');
    const holder = spawnHolder(name);
    await waitForLine(holder, /^HELD$/);

    const waits: string[] = [];
    let acquired = false;
    const pending = acquire(name, { timeoutMs: 20000, pollMs: 50, onWait: (n: string) => waits.push(n) })
      .then((lock) => { acquired = true; return lock; });
    await new Promise((r) => setTimeout(r, 400));
    expect(acquired).toBe(false);
    expect(waits).toEqual([name]);

    holder.stdin!.write('release\n');
    await waitForLine(holder, /^RELEASED$/);
    const lock = await pending;
    expect(acquired).toBe(true);
    await lock.release();
  });

  it('a hard-killed holder frees the lock without any orphan logic', async () => {
    const name = uniqueName('kill');
    const holder = spawnHolder(name);
    await waitForLine(holder, /^HELD$/);
    await expect(acquire(name, { timeoutMs: 0 })).rejects.toMatchObject({ code: LOCK_BUSY_CODE });

    execFileSync('taskkill', ['/F', '/PID', String(holder.pid)], { stdio: 'ignore' });
    await exited(holder);
    const lock = await acquire(name, { timeoutMs: 0 });
    await lock.release();
  });

  it('race: many processes at once — exactly one winner', async () => {
    const name = uniqueName('race');
    const participants = 12;
    const goAt = Date.now() + 2500;
    const racers = Array.from({ length: participants }, () => spawnNode(`
      while (Date.now() < Number(process.argv[2])) await new Promise((r) => setTimeout(r, 5));
      try {
        const lock = await acquirePublishLock(process.argv[1], { timeoutMs: 0 });
        console.log('WON');
        setTimeout(async () => { await lock.release(); process.exit(0); }, 1500);
      } catch (error) {
        console.log(error.code === 'RV_LOCK_BUSY' ? 'BUSY' : 'ERROR ' + error.code);
        process.exit(0);
      }
    `, [name, String(goAt)]));
    const results = await Promise.all(racers.map((racer) => waitForLine(racer, /^(WON|BUSY|ERROR.*)$/, 30000)));
    await Promise.all(racers.map(exited));
    expect(results.filter((r) => r === 'WON')).toHaveLength(1);
    expect(results.filter((r) => r === 'BUSY')).toHaveLength(participants - 1);
  }, 60000);

  it('only EADDRINUSE counts as busy — any other listen error throws at once, without waiting', async () => {
    // The raw OS behaviour the rule protects against: an over-long pipe name fails with EACCES.
    await expect((tryListenPipe as (p: string) => Promise<unknown>)(`\\\\.\\pipe\\${'x'.repeat(260)}`))
      .rejects.toMatchObject({ code: 'EACCES' });

    let calls = 0;
    const waits: string[] = [];
    const eacces = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    const started = Date.now();
    await expect(acquire(uniqueName('eacces'), {
      timeoutMs: 60000, pollMs: 10, onWait: (n: string) => waits.push(n),
      listen: async () => { calls++; throw eacces; },
    })).rejects.toBe(eacces);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);

    // A name beyond the limit never reaches the OS.
    expect(() => normalizeLockName('n'.repeat((MAX_LOCK_NAME_LENGTH as number) + 1))).toThrow(/limit is 200/);
    await expect(acquire('n'.repeat(201), { timeoutMs: 60000 })).rejects.toThrow(/limit is 200/);
  });

  it('timeout 0 is exactly one attempt; a busy lock past the deadline throws RV_LOCK_BUSY', async () => {
    let calls = 0;
    const busy = () => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    await expect(acquire(uniqueName('once'), { timeoutMs: 0, listen: async () => { calls++; throw busy(); } }))
      .rejects.toMatchObject({ code: LOCK_BUSY_CODE });
    expect(calls).toBe(1);

    const name = uniqueName('deadline');
    const held = await acquire(name, { timeoutMs: 0 });
    const started = Date.now();
    await expect(acquire(name, { timeoutMs: 300, pollMs: 50 })).rejects.toMatchObject({ code: LOCK_BUSY_CODE });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await held.release();
  });

  it('release() is idempotent and a new acquisition succeeds afterwards', async () => {
    const name = uniqueName('idem');
    const lock = await acquire(name, { timeoutMs: 0 });
    const first = lock.release();
    const second = lock.release();
    expect(second).toBe(first);
    await first;
    await lock.release();
    const again = await acquire(name, { timeoutMs: 0 });
    await again.release();
  });

  it('normalizes names: backslashes and control characters cannot escape the pipe namespace', () => {
    expect(normalizeLockName('  rv-publish-zone:dev\\x\n ')).toBe('rv-publish-zone:dev/x_');
    expect(() => normalizeLockName('   ')).toThrow(/empty/);
  });
});

describe('rv-publish-lock — platform guard', () => {
  it('throws on a non-Windows platform instead of silently not locking', async () => {
    await expect(acquire(uniqueName('posix'), { platform: 'linux' })).rejects.toThrow(/Windows named pipe.*linux/);
  });
});

