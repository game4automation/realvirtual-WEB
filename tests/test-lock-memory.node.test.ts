// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2247: the test lock waits for free memory — CHECK, THEN LOCK, THEN START. A waiting run holds
 * no lock and no port and is visible in `test-lock.mjs status`. The free memory is injected through
 * `RV_TEST_MEMORY_FAKE_FILE`, the wait directory through `RV_TEST_MEMORY_WAIT_DIR`, and every test
 * uses its own port block, never the real lock port 47177.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const WRAPPER = path.join(SCRIPTS, 'with-test-lock.mjs');
const CHILD = path.join(__dirname, 'fixtures', 'test-lock', 'capacity-child.mjs');

interface MemMod {
  minFreeGbFor(klass: string, o?: { option?: string; env?: Record<string, string | undefined> }): number;
  DEFAULT_MIN_FREE_GB: Record<string, number>;
  readFreeGb(env: Record<string, string | undefined>, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<number>;
}
interface WrapMod { parseArgs(argv: string[]): { runner?: string; args: string[]; minFreeGb?: string } }
interface LockMod { lightPorts(base: number): number[]; probeLock(o: { port: number }): Promise<{ state: string }> }
const lock = (await import(pathToFileURL(path.join(SCRIPTS, 'test-lock.mjs')).href)) as LockMod;

const temporary: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill(); } catch { /* gone */ } }
  for (const d of temporary.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-memory-')); temporary.push(d); return d; };

function bindable(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen({ port, host: '127.0.0.1' }, () => s.close(() => res(true)));
  });
}
let nextBase = 40000 + Math.floor(Math.random() * 6000);
async function allocBase(): Promise<number> {
  for (;;) {
    nextBase += 31;
    if (nextBase > 47000) nextBase = 40000;
    const ports = [nextBase, ...lock.lightPorts(nextBase)];
    if ((await Promise.all(ports.map(bindable))).every(Boolean)) return nextBase;
  }
}

interface Box { base: number; dir: string; waitDir: string; memFile: string }
async function box(gb: number): Promise<Box> {
  const dir = tmp();
  const memFile = path.join(dir, 'free-gb.txt');
  fs.writeFileSync(memFile, String(gb));
  return { base: await allocBase(), dir, waitDir: path.join(dir, 'waiting'), memFile };
}
function env(b: Box, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('RV_TEST_') || k.startsWith('VITEST')) delete e[k];
  Object.assign(e, {
    RV_TEST_LOCK_PORT: String(b.base), RV_TEST_LOCK_POLL_SECONDS: '0.05',
    RV_TEST_MEMORY_FAKE_FILE: b.memFile, RV_TEST_MEMORY_WAIT_DIR: b.waitDir, RV_TEST_MEMORY_POLL_SECONDS: '0.1',
  });
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete e[k]; else e[k] = v; }
  return e;
}
function run(args: string[], e: NodeJS.ProcessEnv, preload?: string) {
  const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), WRAPPER, ...args], {
    env: e, stdio: preload ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  const exited = new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
  return { child, exited, output: () => out };
}
const reports = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith('child-'));
const waitFor = async (what: string, fn: () => boolean, ms = 20000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
};
const waitEntries = (b: Box) => { try { return fs.readdirSync(b.waitDir).filter((n) => n.endsWith('.json')); } catch { return []; } };
function status(e: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string }>((res) => {
    const c = spawn(process.execPath, [path.join(SCRIPTS, 'test-lock.mjs'), 'status'], { env: e });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.once('exit', (code) => res({ code, stdout }));
  });
}

describe('plan-2247 thresholds and options (pure)', () => {
  it('defaults per class, env override, CLI option wins, 0 switches off', async () => {
    const mem = (await import(pathToFileURL(path.join(SCRIPTS, 'test-memory.mjs')).href)) as MemMod;
    expect(mem.DEFAULT_MIN_FREE_GB).toEqual({ light: 8, heavy: 10, exclusive: 10 });
    expect(mem.minFreeGbFor('light', { env: {} })).toBe(8);
    expect(mem.minFreeGbFor('heavy', { env: {} })).toBe(10);
    expect(mem.minFreeGbFor('exclusive', { env: {} })).toBe(10);
    expect(mem.minFreeGbFor('heavy', { env: { RV_TEST_MIN_FREE_GB: '6' } })).toBe(6);
    expect(mem.minFreeGbFor('heavy', { option: '4', env: { RV_TEST_MIN_FREE_GB: '6' } })).toBe(4);
    expect(mem.minFreeGbFor('heavy', { env: { RV_TEST_MIN_FREE_GB: '0' } })).toBe(0);
    const wrap = (await import(pathToFileURL(WRAPPER).href)) as WrapMod;
    expect(wrap.parseArgs(['--min-free-gb', '4', '--', 'vitest', 'run'])).toEqual({ runner: 'vitest', args: ['run'], minFreeGb: '4' });
    expect(wrap.parseArgs(['--min-free-gb=0', 'vitest', 'run', '--min-free-gb', '9'])).toEqual({ runner: 'vitest', args: ['run', '--min-free-gb', '9'], minFreeGb: '0' });
    expect(wrap.parseArgs(['--', 'vitest', 'run'])).toEqual({ runner: 'vitest', args: ['run'] });
  });
});

describe('plan-2247 the wrapper waits for memory without the lock', { timeout: 60_000 }, () => {
  it('T1: below the threshold the child does not start and the lock is not taken; with enough memory it starts', async () => {
    const b = await box(3);
    const dir = tmp();
    const a = run(['--min-free-gb', '8', CHILD, dir], env(b));
    await waitFor('waiting line', () => /WAITING for memory/.test(a.output()));
    await new Promise((r) => setTimeout(r, 400));
    expect(reports(dir)).toHaveLength(0);
    expect((await lock.probeLock({ port: b.base })).state).toBe('free');
    fs.writeFileSync(b.memFile, '12');
    expect(await a.exited, a.output()).toBe(0);
    expect(reports(dir)).toHaveLength(1);
    expect(a.output()).toMatch(/memory ok: 12\.0 GB free >= 8 GB/);
  });

  it('T2: a waiting run does not block another run, which takes the lock and finishes', async () => {
    const b = await box(3);
    const dirA = tmp();
    const a = run([CHILD, dirA], env(b, { RV_TEST_MIN_FREE_GB: '8' }));
    await waitFor('A waits', () => /WAITING for memory/.test(a.output()));
    const dirB = tmp();
    const bRun = run([CHILD, dirB, 'hold'], env(b, { RV_TEST_MIN_FREE_GB: '2' }));
    await waitFor('B child', () => reports(dirB).length === 1);
    expect((await lock.probeLock({ port: b.base })).state).toBe('held'); // B holds it, A never did
    fs.writeFileSync(path.join(dirB, 'release'), '');
    expect(await bRun.exited, bRun.output()).toBe(0);
    expect(reports(dirA)).toHaveLength(0); // A is still waiting
    expect(a.child.exitCode).toBeNull();
  });

  it('T3: status lists the waiting run, exit code unchanged (0 free)', async () => {
    const b = await box(3);
    const a = run([CHILD, tmp()], env(b, { RV_TEST_MIN_FREE_GB: '8' }));
    await waitFor('wait entry', () => waitEntries(b).length === 1);
    const s = await status(env(b));
    expect(s.code, s.stdout).toBe(0);
    expect(s.stdout).toContain(`127.0.0.1:${b.base} is free`);
    expect(s.stdout).toMatch(new RegExp(`\\[test-lock\\] WAITING for memory: PID ${a.child.pid} \\(class heavy, need 8\\.0 GB, have 3\\.0 GB, since [^)]+\\)`));
  });

  it('T4: giving up after the wait time exits 1 and removes the entry; a killed waiter disappears from status', async () => {
    const b = await box(3);
    const dir = tmp();
    const a = run([CHILD, dir], env(b, { RV_TEST_MIN_FREE_GB: '8', RV_TEST_MEMORY_WAIT_SECONDS: '1' }));
    await waitFor('wait entry', () => waitEntries(b).length === 1);
    expect(await a.exited, a.output()).toBe(1);
    expect(a.output()).toMatch(/waited \d+ s for 8 GB free, have 3\.0 GB/);
    expect(waitEntries(b)).toHaveLength(0);
    expect(reports(dir)).toHaveLength(0);

    const k = run([CHILD, tmp()], env(b, { RV_TEST_MIN_FREE_GB: '8' }));
    await waitFor('wait entry', () => waitEntries(b).length === 1);
    k.child.kill(); // a hard kill on Windows; no handler can run, so the reader must clean up
    await k.exited;
    const s = await status(env(b));
    expect(s.stdout).not.toContain('WAITING for memory');
    expect(waitEntries(b)).toHaveLength(0);
  });
});

describe('plan-2247 round 2: memory is valid when the lock is taken', { timeout: 60_000 }, () => {
  it.each(['heavy', 'light', 'exclusive'])('T6: %s releases all ports when memory falls during acquisition, waits visibly and lets another holder run', async (klass) => {
    const b = await box(12);
    const dirB = tmp();
    const exclusive = { RV_TEST_CAPACITY: 'budget', RV_TEST_LOCK_CLASS: 'exclusive', RV_TEST_MIN_FREE_GB: '2' };
    const holder = run([CHILD, dirB, 'hold'], env(b, exclusive));
    await waitFor('holder child', () => reports(dirB).length === 1);
    const dirA = tmp();
    const a = run([CHILD, dirA], env(b, { RV_TEST_CAPACITY: 'budget', RV_TEST_LOCK_CLASS: klass, RV_TEST_MIN_FREE_GB: '10' }));
    await waitFor('A passed the first memory check', () => /memory ok: 12\.0 GB/.test(a.output()));
    await waitFor('A blocked behind the holder', () => a.output().includes(`class ${klass} waiting for`));
    expect(reports(dirA)).toHaveLength(0);
    expect(holder.child.exitCode).toBeNull();
    fs.writeFileSync(b.memFile, '3'); // memory falls while A is blocked
    fs.writeFileSync(path.join(dirB, 'release'), '');
    expect(await holder.exited, holder.output()).toBe(0);
    await waitFor('A re-waits', () => /memory re-check after taking the lock: 3\.0 GB < 10 GB/.test(a.output()));
    await waitFor('A wait entry', () => waitEntries(b).length === 1);
    const s = await status(env(b));
    expect(s.code, s.stdout).toBe(0);
    expect(s.stdout).toContain(`WAITING for memory: PID ${a.child.pid} (class ${klass}, need 10.0 GB, have 3.0 GB`);
    expect(reports(dirA)).toHaveLength(0); // the child never started at 3 GB
    for (const port of [b.base, ...lock.lightPorts(b.base)]) {
      expect((await lock.probeLock({ port })).state, `port ${port}`).toBe('free');
    }
    // An exclusive follower needs H0 AND all marks: no class may leave anything held.
    const dirC = tmp();
    const c = run([CHILD, dirC, 'hold'], env(b, { ...exclusive, RV_TEST_LOCK_EXCLUSIVE_TIMEOUT_SECONDS: '5' }));
    await waitFor('C acquires every port while A still waits', () => reports(dirC).length === 1);
    expect(reports(dirA)).toHaveLength(0);
    fs.writeFileSync(path.join(dirC, 'release'), '');
    expect(await c.exited, c.output()).toBe(0);
    expect(reports(dirC)).toHaveLength(1);
    expect(a.child.exitCode).toBeNull();
    fs.writeFileSync(b.memFile, '12');
    expect(await a.exited, a.output()).toBe(0);
    expect(reports(dirA)).toHaveLength(1);
  });
});

describe('plan-2247 round 2: the memory query is bounded and cancellable', { timeout: 60_000 }, () => {
  it('T7a: readFreeGb with a stalled reader resolves NaN at the timeout and on abort', async () => {
    const mem = (await import(pathToFileURL(path.join(SCRIPTS, 'test-memory.mjs')).href)) as MemMod;
    const dir = tmp();
    const f = path.join(dir, 'stall.txt');
    fs.writeFileSync(f, 'stall');
    const t0 = Date.now();
    expect(await mem.readFreeGb({ RV_TEST_MEMORY_FAKE_FILE: f }, { timeoutMs: 200 })).toBeNaN();
    expect(Date.now() - t0).toBeLessThan(3000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t1 = Date.now();
    expect(await mem.readFreeGb({ RV_TEST_MEMORY_FAKE_FILE: f }, { timeoutMs: 30_000, signal: ac.signal })).toBeNaN();
    expect(Date.now() - t1).toBeLessThan(3000);
  });

  it('T7b: the wait entry exists while the FIRST query stalls, a stalled reading never passes, and the deadline still ends the wait', async () => {
    const b = await box(3);
    fs.writeFileSync(b.memFile, 'stall');
    const dir = tmp();
    const t0 = Date.now();
    const a = run([CHILD, dir], env(b, { RV_TEST_MIN_FREE_GB: '8', RV_TEST_MEMORY_QUERY_TIMEOUT_SECONDS: '20', RV_TEST_MEMORY_WAIT_SECONDS: '2' }));
    await waitFor('wait entry during the first query', () => waitEntries(b).length === 1);
    expect(JSON.parse(fs.readFileSync(path.join(b.waitDir, `${a.child.pid}.json`), 'utf8')).haveGb).toBeNull();
    const s = await status(env(b));
    expect(s.code, s.stdout).toBe(0);
    expect(s.stdout).toMatch(new RegExp(`WAITING for memory: PID ${a.child.pid} \\(class heavy, need 8\\.0 GB, have \\? GB`));
    expect(await a.exited, a.output()).toBe(1);
    expect(Date.now() - t0).toBeLessThan(10_000); // far below the 20 s query timeout: the deadline bounds the query
    expect(reports(dir)).toHaveLength(0);
    expect(waitEntries(b)).toHaveLength(0);
  });

  it('T7c: a timed-out query counts as unknown and keeps waiting; a later good reading passes', async () => {
    const b = await box(3);
    fs.writeFileSync(b.memFile, 'stall');
    const dir = tmp();
    const a = run([CHILD, dir], env(b, { RV_TEST_MIN_FREE_GB: '8', RV_TEST_MEMORY_QUERY_TIMEOUT_SECONDS: '0.3' }));
    await waitFor('waiting line', () => /WAITING for memory/.test(a.output()));
    await new Promise((r) => setTimeout(r, 800));
    expect(reports(dir)).toHaveLength(0);
    expect(a.output()).toContain('unknown (memory query timed out or failed)');
    expect(waitEntries(b)).toHaveLength(1);
    fs.writeFileSync(b.memFile, 'unreadable');
    await new Promise((r) => setTimeout(r, 400));
    expect(reports(dir)).toHaveLength(0);
    fs.writeFileSync(b.memFile, '12');
    expect(await a.exited, a.output()).toBe(0);
    expect(reports(dir)).toHaveLength(1);
  });

  it('T7d: a signal during a stalled first query promptly removes the entry through the handler', async () => {
    const b = await box(3);
    fs.writeFileSync(b.memFile, 'stall');
    const dir = tmp();
    // Windows child.kill() terminates without running handlers. Deliver the same process signal
    // event over IPC so the handler and its cleanup are exercised on every platform.
    const preload = path.join(b.dir, 'signal.cjs');
    fs.writeFileSync(preload, "process.once('message', () => process.emit('SIGINT'));\n");
    const a = run([CHILD, dir], env(b, {
      RV_TEST_MIN_FREE_GB: '8', RV_TEST_MEMORY_QUERY_TIMEOUT_SECONDS: '30', RV_TEST_MEMORY_WAIT_SECONDS: '60',
    }), preload);
    await waitFor('measuring entry', () => waitEntries(b).length === 1);
    expect(JSON.parse(fs.readFileSync(path.join(b.waitDir, `${a.child.pid}.json`), 'utf8')).haveGb).toBeNull();
    const t0 = Date.now();
    a.child.send!('SIGINT');
    expect(await a.exited, a.output()).toBe(130);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(a.output()).toContain('SIGINT before the run started');
    expect(waitEntries(b)).toHaveLength(0); // removed by the handler, before a status read
    expect(reports(dir)).toHaveLength(0);
    expect((await status(env(b))).stdout).not.toContain('WAITING for memory');
  });
});
