// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2200 (core): capacity classes of the test lock - light / heavy / exclusive, the worker
 * budget, `status` and the default timeout. Real sockets and real wrapper processes; every test
 * uses its own port block (base .. base+22) found by probing, never the real lock port 47177.
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
const FIX = path.join(__dirname, 'fixtures', 'test-lock');

interface Handle { port: number; ports?: number[]; release(): Promise<void> }
interface LockMod {
  lockConfig(env?: Record<string, string | undefined>): { timeoutSeconds: number };
  lightPorts(base: number): number[];
  acquireClass(o: { klass: string; port: number; timeoutSeconds?: number; pollSeconds?: number; log?: (m: string) => void; info?: Record<string, unknown> }): Promise<Handle>;
  holderInfo(argv: string[], extra?: Record<string, unknown>): Record<string, unknown>;
  acquire(o: { port: number; info: Record<string, unknown>; timeoutSeconds?: number }): Promise<Handle>;
  probeLock(o: { port: number }): Promise<{ state: string }>;
}
interface CapMod {
  capacityMode(env: Record<string, string | undefined>, cores?: number): 'budget' | 'single';
  classifyRun(runner: string, args: string[], env?: Record<string, string | undefined>, cwd?: string): string;
  workerBudget(klass: string, env: Record<string, string | undefined>, cores: number): number | undefined;
  childEnvFor(klass: string, env: Record<string, string | undefined>, cores?: number): { set: Record<string, string>; unset: string[] };
  reentryEnvFor(env: Record<string, string | undefined>, cores?: number): { set: Record<string, string>; unset: string[] };
}
const lock = (await import(pathToFileURL(path.join(SCRIPTS, 'test-lock.mjs')).href)) as LockMod;
const cap = (await import(pathToFileURL(path.join(SCRIPTS, 'test-capacity.mjs')).href)) as CapMod;

const temporary: string[] = [];
const handles: Handle[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.release();
  for (const c of children.splice(0)) { try { c.kill(); } catch { /* gone */ } }
  for (const d of temporary.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-capacity-')); temporary.push(d); return d; };

function bindable(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen({ port, host: '127.0.0.1' }, () => s.close(() => res(true)));
  });
}
let nextBase = 48000 + Math.floor(Math.random() * 4000);
async function allocBase(): Promise<number> {
  for (;;) {
    nextBase += 31;
    if (nextBase > 60000) nextBase = 48000;
    const ports = [nextBase, ...lock.lightPorts(nextBase)];
    if ((await Promise.all(ports.map(bindable))).every(Boolean)) return nextBase;
  }
}
const quiet = () => undefined;
const take = async (klass: string, port: number, timeoutSeconds = 5) => {
  const h = await lock.acquireClass({ klass, port, timeoutSeconds, pollSeconds: 0.05, log: quiet, info: lock.holderInfo(['t', klass], { class: klass }) });
  handles.push(h);
  return h;
};
// a heavy/exclusive bind blocked by a holder of THIS test process trips the same-process guard instead of waiting: both mean blocked
const refuses = (klass: string, port: number) => lock.acquireClass({ klass, port, timeoutSeconds: 0.4, pollSeconds: 0.05, log: quiet })
  .then((h) => { handles.push(h); return 'acquired'; }, (e: Error) => (e.name === 'TestLockTimeoutError' || e.message.includes('held by THIS process') ? 'timeout' : `error ${e.message}`));

describe('capacity classification and worker budget (pure)', () => {
  const big = { RV_TEST_CAPACITY_CORES: '32' };
  it('mode: budget from 24 threads, single below, explicit override wins', () => {
    expect(cap.capacityMode({ RV_TEST_CAPACITY_CORES: '32' })).toBe('budget');
    expect(cap.capacityMode({ RV_TEST_CAPACITY_CORES: '24' })).toBe('budget');
    expect(cap.capacityMode({ RV_TEST_CAPACITY_CORES: '23' })).toBe('single');
    expect(cap.capacityMode({ RV_TEST_CAPACITY_CORES: '6' })).toBe('single');
    expect(cap.capacityMode({ RV_TEST_CAPACITY_CORES: '6', RV_TEST_CAPACITY: 'budget' })).toBe('budget');
    expect(cap.capacityMode({ RV_TEST_CAPACITY_CORES: '32', RV_TEST_CAPACITY: 'single' })).toBe('single');
  });

  it('light: an explicit list of up to 20 existing test files; everything doubtful is heavy', () => {
    const f = (n: number) => Array.from({ length: n }, () => 'tests/test-lock-capacity.node.test.ts');
    expect(cap.classifyRun('vitest', ['run', ...f(1)], big, ROOT)).toBe('light');
    expect(cap.classifyRun('vitest', ['run', ...f(20)], big, ROOT)).toBe('light');
    expect(cap.classifyRun('vitest', ['run', ...f(21)], big, ROOT)).toBe('heavy');
    expect(cap.classifyRun('vitest', ['run', '--config', 'vitest.node.config.ts', ...f(2)], big, ROOT)).toBe('light');
    expect(cap.classifyRun('vitest', ['run'], big, ROOT)).toBe('heavy');
    expect(cap.classifyRun('vitest', ['run', 'test-lock-capacity'], big, ROOT)).toBe('heavy'); // a filter, not a file
    expect(cap.classifyRun('vitest', ['run', 'tests/does-not-exist.test.ts'], big, ROOT)).toBe('heavy');
    expect(cap.classifyRun('vitest', ['run', 'tests/*.test.ts'], big, ROOT)).toBe('heavy');
    expect(cap.classifyRun('vitest', [...f(1)], big, ROOT)).toBe('heavy'); // watch mode
    expect(cap.classifyRun('vitest', ['run', '--coverage', ...f(1)], big, ROOT)).toBe('heavy');
    expect(cap.classifyRun('playwright', ['test', 'e2e/x.spec.ts'], big, ROOT)).toBe('heavy');
    expect(cap.classifyRun('scripts/run-all-tests.mjs', [], big, ROOT)).toBe('heavy');
  });

  it('exclusive: perf scripts, perf/gpu configs; explicit class wins; single mode is always heavy', () => {
    expect(cap.classifyRun('scripts/perf-des.mjs', [], big, ROOT)).toBe('exclusive');
    expect(cap.classifyRun('playwright', ['test', 'e2e/perf-smoke.spec.ts', '--headed'], big, ROOT)).toBe('exclusive');
    expect(cap.classifyRun('vitest', ['run', '--config', 'vitest.perf-des.config.ts'], big, ROOT)).toBe('exclusive');
    expect(cap.classifyRun('vitest', ['run', '--config', 'vitest.gpu.config.ts'], big, ROOT)).toBe('exclusive');
    expect(cap.classifyRun('vitest', ['run'], { ...big, RV_TEST_LOCK_CLASS: 'light' }, ROOT)).toBe('light');
    expect(cap.classifyRun('vitest', ['run', '--class=exclusive'], big, ROOT)).toBe('exclusive');
    expect(cap.classifyRun('vitest', ['run'], { ...big, RV_TEST_LOCK_CLASS: 'nonsense' }, ROOT)).toBe('heavy');
    const six = { RV_TEST_CAPACITY_CORES: '6' };
    expect(cap.classifyRun('scripts/perf-des.mjs', [], six, ROOT)).toBe('heavy');
    expect(cap.classifyRun('vitest', ['run', 'tests/test-lock-capacity.node.test.ts'], six, ROOT)).toBe('heavy');
  });

  it('budget: heavy = 12 on 32 threads, light = 4, exclusive/single none; RV_TEST_MAX_WORKERS percent is respected', () => {
    expect(cap.workerBudget('heavy', {}, 32)).toBe(12);
    expect(cap.workerBudget('light', {}, 32)).toBe(4);
    expect(cap.workerBudget('exclusive', {}, 32)).toBeUndefined();
    expect(cap.childEnvFor('heavy', { RV_TEST_CAPACITY_CORES: '32' }).set).toEqual({ RV_TEST_LOCK_CLASS: 'heavy', VITEST_MAX_WORKERS: '12' });
    expect(cap.childEnvFor('light', { RV_TEST_CAPACITY_CORES: '32' }).set.VITEST_MAX_WORKERS).toBe('4');
    expect(cap.childEnvFor('heavy', { RV_TEST_CAPACITY_CORES: '32', RV_TEST_MAX_WORKERS: '7' }).set.VITEST_MAX_WORKERS).toBe('7');
    expect(cap.childEnvFor('heavy', { RV_TEST_CAPACITY_CORES: '32', RV_TEST_MAX_WORKERS: '100%' }).set.VITEST_MAX_WORKERS).toBeUndefined();
    const ex = cap.childEnvFor('exclusive', { RV_TEST_CAPACITY_CORES: '32', VITEST_MAX_WORKERS: '12' });
    expect(ex.set.VITEST_MAX_WORKERS).toBeUndefined();
    expect(ex.unset).toContain('VITEST_MAX_WORKERS');
    // single mode touches nothing: an inherited worker limit survives exactly as before
    expect(cap.childEnvFor('heavy', { RV_TEST_CAPACITY_CORES: '6', VITEST_MAX_WORKERS: '2' })).toEqual({ set: {}, unset: [] });
    expect(cap.reentryEnvFor({ RV_TEST_CAPACITY_CORES: '6', RV_TEST_MAX_WORKERS: '1' })).toEqual({ set: {}, unset: [] });
  });

  it('explicit RV_TEST_MAX_WORKERS beats an inherited budget, on a fresh run and on re-entry', () => {
    const inherited = { RV_TEST_CAPACITY_CORES: '32', VITEST_MAX_WORKERS: '12' };
    expect(cap.childEnvFor('heavy', { ...inherited, RV_TEST_MAX_WORKERS: '100%' }).unset).toContain('VITEST_MAX_WORKERS');
    expect(cap.reentryEnvFor({ ...inherited, RV_TEST_MAX_WORKERS: '1' }).set).toEqual({ VITEST_MAX_WORKERS: '1' });
    expect(cap.reentryEnvFor({ ...inherited, RV_TEST_MAX_WORKERS: '100%' }).unset).toEqual(['VITEST_MAX_WORKERS']);
    expect(cap.reentryEnvFor(inherited)).toEqual({ set: {}, unset: [] });
  });
});

describe('capacity classes on the lock', { timeout: 60_000 }, () => {
  it('default wait is 1800 s', () => {
    expect(lock.lockConfig({}).timeoutSeconds).toBe(1800);
  });

  it('light runs share the machine with each other and with one heavy run', async () => {
    const base = await allocBase();
    const heavy = await take('heavy', base);
    const l1 = await take('light', base);
    const l2 = await take('light', base);
    expect(new Set([heavy.port, l1.port, l2.port]).size).toBe(3);
    expect((await lock.probeLock({ port: base })).state).toBe('held'); // exactly one heavy place (the wrapper test asserts the waiting)
  });

  it('twenty light slots, the 21st waits and gets the first one released', async () => {
    const base = await allocBase();
    const held: Handle[] = [];
    for (let i = 0; i < 20; i++) held.push(await take('light', base));
    expect(await refuses('light', base)).toBe('timeout');
    const waiting = lock.acquireClass({ klass: 'light', port: base, timeoutSeconds: 10, pollSeconds: 0.05, log: quiet });
    await held[3].release();
    const got = await waiting;
    handles.push(got);
    expect(got.port).toBe(held[3].port);
  });

  it('exclusive waits for light and heavy holders, stops new light runs meanwhile, and holds everything', async () => {
    const base = await allocBase();
    const light = await take('light', base);
    const heavy = await take('heavy', base);
    expect(await refuses('exclusive', base)).toBe('timeout');
    // the failed exclusive attempt released everything it had bound
    expect((await lock.probeLock({ port: base + 20 })).state).toBe('free');

    await heavy.release();
    const exclusive = lock.acquireClass({ klass: 'exclusive', port: base, timeoutSeconds: 10, pollSeconds: 0.05, log: quiet });
    // while it waits for the light holder it already owns H0 and the free marks: a new light run is held back
    await new Promise((r) => setTimeout(r, 600));
    expect(await refuses('light', base)).toBe('timeout');
    expect(await refuses('heavy', base)).toBe('timeout');
    await light.release();
    const ex = await exclusive;
    handles.push(ex);
    expect(await refuses('light', base)).toBe('timeout');
    expect(await refuses('heavy', base)).toBe('timeout');
    expect(await refuses('exclusive', base)).toBe('timeout');
    await ex.release();
    const after = await take('light', base);
    expect(after.port).toBeGreaterThan(base);
  });

  it('status lists every holder including light ones (exit 1) and is free otherwise (exit 0)', async () => {
    const base = await allocBase();
    // async: the lock servers live in THIS process and must keep answering while the CLI probes them
    const status = () => new Promise<{ status: number | null; stdout: string }>((res) => {
      const c = spawn(process.execPath, [path.join(SCRIPTS, 'test-lock.mjs'), 'status'], { env: { ...process.env, RV_TEST_LOCK_PORT: String(base) } });
      let stdout = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.once('exit', (code) => res({ status: code, stdout }));
    });
    const free = await status();
    expect(free.status, free.stdout).toBe(0);
    expect(free.stdout).toContain(`127.0.0.1:${base} is free`);
    await take('light', base);
    await take('light', base);
    const onlyLight = await status();
    expect(onlyLight.status, onlyLight.stdout).toBe(1);
    expect(onlyLight.stdout.match(/light/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);
    await take('heavy', base);
    const all = await status();
    expect(all.status).toBe(1);
    expect(all.stdout).toContain(`HELD by PID ${process.pid}`);
    expect(all.stdout.split('PID ').length - 1).toBeGreaterThanOrEqual(3);
  });
});

describe('capacity through the wrapper', { timeout: 90_000 }, () => {
  const wrapperPath = path.join(SCRIPTS, 'with-test-lock.mjs');
  function env(base: number, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(e)) if (k.startsWith('RV_TEST_LOCK') || k.startsWith('VITEST') || k.startsWith('RV_TEST_CAPACITY') || k === 'RV_TEST_MAX_WORKERS') delete e[k];
    e.RV_TEST_UNATTENDED = '1';
    e.RV_TEST_LOCK_PORT = String(base);
    e.RV_TEST_LOCK_POLL_SECONDS = '0.05';
    for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete e[k]; else e[k] = v; }
    return e;
  }
  function run(args: string[], e: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, [wrapperPath, ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
    return { exited, output: () => out };
  }
  const waitFor = async (what: string, fn: () => boolean, ms = 20000): Promise<void> => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const reports = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith('child-'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { klass: string; workers: string | null });
  const CHILD = path.join(FIX, 'capacity-child.mjs');
  const PERF = path.join(FIX, 'perf-capacity-child.mjs');
  const budget = { RV_TEST_CAPACITY: 'budget', RV_TEST_CAPACITY_CORES: '32' };

  it('two light runs and one heavy run hold the lock at the same time, with their worker budgets', async () => {
    const base = await allocBase();
    const dir = tmp();
    const runs = [
      run([CHILD, dir, 'hold'], env(base, { ...budget, RV_TEST_LOCK_CLASS: 'light' })),
      run([CHILD, dir, 'hold'], env(base, { ...budget, RV_TEST_LOCK_CLASS: 'light' })),
      run([CHILD, dir, 'hold'], env(base, { ...budget })),
    ];
    await waitFor('three children', () => reports(dir).length === 3);
    const r = reports(dir);
    expect(r.filter((x) => x.klass === 'light').map((x) => x.workers)).toEqual(['4', '4']);
    expect(r.filter((x) => x.klass === 'heavy').map((x) => x.workers)).toEqual(['12']);
    fs.writeFileSync(path.join(dir, 'release'), '');
    for (const x of runs) expect(await x.exited, x.output()).toBe(0);
  });

  it('a perf run (exclusive) waits for everything and blocks every other class', async () => {
    const base = await allocBase();
    const dirLight = tmp();
    const light = run([CHILD, dirLight, 'hold'], env(base, { ...budget, RV_TEST_LOCK_CLASS: 'light' }));
    await waitFor('light child', () => reports(dirLight).length === 1);

    const dirPerf = tmp();
    const perf = run([PERF, dirPerf, 'hold'], env(base, { ...budget }));
    await new Promise((r) => setTimeout(r, 800));
    expect(reports(dirPerf)).toHaveLength(0); // waits for the light holder

    const late = run([CHILD, tmp()], env(base, { ...budget, RV_TEST_LOCK_CLASS: 'light', RV_TEST_LOCK_TIMEOUT_SECONDS: '1' }));
    expect(await late.exited).toBe(1); // held back by the waiting exclusive run

    fs.writeFileSync(path.join(dirLight, 'release'), '');
    expect(await light.exited).toBe(0);
    await waitFor('perf child', () => reports(dirPerf).length === 1);
    expect(reports(dirPerf)[0]).toMatchObject({ klass: 'exclusive', workers: null });

    const heavyLate = run([CHILD, tmp()], env(base, { ...budget, RV_TEST_LOCK_TIMEOUT_SECONDS: '1' }));
    expect(await heavyLate.exited).toBe(1);
    fs.writeFileSync(path.join(dirPerf, 'release'), '');
    expect(await perf.exited, perf.output()).toBe(0);
  });

  it('6-thread simulation falls back to the single lock: no parallel light, no worker budget', async () => {
    const base = await allocBase();
    const dir = tmp();
    const e = { RV_TEST_CAPACITY_CORES: '6', RV_TEST_LOCK_CLASS: 'light' };
    const first = run([CHILD, dir, 'hold'], env(base, e));
    await waitFor('first child', () => reports(dir).length === 1);
    expect(reports(dir)[0].workers).toBeNull();
    const second = run([CHILD, tmp()], env(base, { ...e, RV_TEST_LOCK_TIMEOUT_SECONDS: '1' }));
    expect(await second.exited, second.output()).toBe(1);
    fs.writeFileSync(path.join(dir, 'release'), '');
    expect(await first.exited).toBe(0);
  });

  it('a class-carrying heavy holder does not block light; a classless (older checkout) holder on the base port blocks heavy AND light', async () => {
    const base = await allocBase();
    const heavy = await take('heavy', base);
    const light = run([CHILD, tmp()], env(base, { ...budget, RV_TEST_LOCK_CLASS: 'light' }));
    expect(await light.exited, light.output()).toBe(0);
    await heavy.release();

    const old = await lock.acquire({ port: base, info: lock.holderInfo(['old-perf']), timeoutSeconds: 5 });
    handles.push(old); // what an older wrapper binds: exactly the base port, no class in its answer
    const blockedLight = run([CHILD, tmp()], env(base, { ...budget, RV_TEST_LOCK_CLASS: 'light', RV_TEST_LOCK_TIMEOUT_SECONDS: '1' }));
    expect(await blockedLight.exited).toBe(1);
    const blockedHeavy = run([CHILD, tmp()], env(base, { ...budget, RV_TEST_LOCK_TIMEOUT_SECONDS: '1' }));
    expect(await blockedHeavy.exited).toBe(1);
  });
});
