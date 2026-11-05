// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-606 — machine-wide test lock: module, wrapper, watchdog, guard, Playwright order.
 *
 * Real child processes throughout. Ports come from a per-test allocator (a candidate in
 * 47200–47999 that binds on 127.0.0.1 AND 0.0.0.0 right now) — never the production
 * lock port 47177, never 5177/5187. Ordering is done with ready/release barrier files
 * and log lines, never with sleeps; the only time bounds are the ones under test
 * (one poll, the deadline, ≤ 5 s tree teardown).
 *
 * Every safety-relevant check is paired with a NEGATIVE CONTROL that runs the same check
 * against a deliberately broken variant (a wrong-address holder, an early-releasing
 * wrapper fixture, a watchdog-less process, a lock-less second run, …) and asserts the
 * check DOES flag it — so a check that cannot fail would turn this suite red.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts takes `*.node.test.ts`).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// ─── typed views of the .mjs modules ────────────────────────────────────────

interface Holder { rvTestLock: 1; pid: number; startedAt: string; cwd: string; argv: string[] }
interface Probe { state: 'free' | 'held' | 'unknown'; port: number; holder?: Holder }
interface LockHandle { port: number; info: Holder; server: net.Server; release(): Promise<void> }
interface AcquireOptions {
  info?: object;
  port?: number;
  timeoutSeconds?: number;
  pollSeconds?: number;
  log?: (message: string) => void;
  onBusy?: () => Promise<void> | void;
}
// Loaded by URL: the .mjs modules carry no declaration files, so they are typed here.
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');
const lock = (await import(pathToFileURL(path.join(SCRIPTS_DIR, 'test-lock.mjs')).href)) as {
  LOCK_HOST: string;
  acquire(options?: AcquireOptions): Promise<LockHandle>;
  probeLock(options: { port: number }): Promise<Probe>;
  describeHolder(options: { port: number }): Promise<Holder | null>;
  holderInfo(argv: string[]): Holder;
  isProcessAlive(pid: unknown): boolean;
  lockConfig(env?: Record<string, string | undefined>): { disabled: boolean; port: number; timeoutSeconds: number; pollSeconds: number };
};
const wrapper = (await import(pathToFileURL(path.join(SCRIPTS_DIR, 'with-test-lock.mjs')).href)) as {
  WATCHDOG_PATH: string;
  nodeOptionsRequire(file: string): string;
  withWatchdog(nodeOptions: string | undefined, file?: string): string;
  exitCodeFor(code: number | null, signal: string | null): number;
  parseArgs(argv: string[]): { runner: string | undefined; args: string[] };
  maxRuntime(env?: Record<string, string | undefined>): { minutes: number; ms: number };
  MAX_RUNTIME_EXIT_CODE: number;
  STALL_EXIT_CODE: number;
  stallTimeout(env?: Record<string, string | undefined>): { minutes: number; ms: number };
  createStallWatch(limitMs: number): {
    onRecord(rec: Partial<ProgressRecord>, now: number): void;
    expired(now: number): { idleMs: number; last: { ev: string; file?: string; t: number }; started: string[]; notStarted: string[] } | null;
  };
  startupTimeout(env?: Record<string, string | undefined>): { seconds: number; ms: number };
  STARTUP_TIMEOUT_EXIT_CODE: number;
  isVitestRunner(runner: string, cli?: string): boolean;
  createStartupWatch(limitMs: number): StartupWatch;
  readProgress(file: string, offset?: number): { records: ProgressRecord[]; offset: number };
  DEFAULT_FILE_TIMEOUT_SECONDS: number;
  FILE_TIMEOUT_EXIT_CODE: number;
  FILE_TIMEOUT_OVERRIDES: GlobLimit[];
  fileTimeout(env?: Record<string, string | undefined>): { seconds: number; ms: number; roundedToZero: boolean };
  specGlobToRegExp(glob: string): RegExp;
  limitFor(spec: string, options: { defaultMs: number; overrides?: GlobLimit[] }): { ms: number; source: string | null; invalid?: { glob: string; seconds: unknown } };
  invalidOverrides(overrides?: GlobLimit[]): GlobLimit[];
  overrideWarnings(overrides?: GlobLimit[], defaultSeconds?: number): string[];
  stallIsResponsible(perFileMs: number, mode?: string): boolean;
  createFileWatch(limitMs: number, options?: { overrides?: GlobLimit[] }): FileWatch;
  CLOCK_MODE: { OFF: string; UNATTENDED: string; LEGACY: string };
  clockMode(env?: Record<string, string | undefined>): { mode: string; warnings: string[] };
  clockState(env?: Record<string, string | undefined>): ClockState;
  clockSummary(state: ClockState): string;
};
interface ClockState {
  mode: string;
  warnings: string[];
  startup: { seconds: number; ms: number };
  stall: { minutes: number; ms: number };
  perFile: { seconds: number; ms: number; roundedToZero: boolean };
  runtime: { minutes: number; ms: number };
  armed: { startupMs: number; perFileMs: number; stallMs: number };
}
// `seconds` stays a `number` DELIBERATELY (plan-900 F7): `FILE_TIMEOUT_OVERRIDES` is the A8 hook
// that exists to be filled, so the compiler should reject `seconds: '15 min'` where it is WRITTEN.
// The F1 runtime check is the load-bearing protection (it must hold for a row that bypasses the
// type — a JSON import, an `any`), but giving up the type at the very place whose failure case we
// just repaired would be the wrong trade. The F1 test casts instead.
interface GlobLimit { glob: string; seconds: number; why?: string }
interface FileDue { kind: 'file'; pid: number; spec: string; ranMs: number; limitMs: number; source: string | null; sole: boolean }
interface IdleDue { kind: 'idle'; idleMs: number; last: { spec: string; pid: number; at: number } | null }
interface FileWatch {
  inFlight: Map<string, { pid: number; spec: string; since: number; limitMs: number; source: string | null }>;
  onRecord(rec: Partial<ProgressRecord>, now: number): void;
  prune(isAlive: (pid: number) => boolean): void;
  status(): { open: string[]; started: number; expected: number };
  expired(now: number): FileDue | IdleDue | null;
}
interface ProgressRecord { ev: string; pid: number; ppid?: number; t?: number; file?: string; files?: string[]; spec?: string }
interface StartupWatch {
  pending: Map<number, { since: number; cause: string }>;
  open(pid: number, since: number, cause: string): void;
  onRecord(rec: Partial<ProgressRecord>, now: number): void;
  prune(isAlive: (pid: number) => boolean): void;
  expired(now: number): { pid: number; since: number; cause: string } | null;
}
interface SkipGroup { key: string; count: number }
type StrictDepsMode = 'fail' | 'warn' | 'off';
interface DepsHit { dep: string; reloaded: boolean }
interface DepsState { mode: StrictDepsMode; before: string[]; after: string[]; hits: Map<string, DepsHit> }
interface FailState { shown: number; suppressed: number; entities: Set<unknown>; errors: WeakSet<object> }
interface ProgressState { file: string; wrapperSpawn?: number; runStart: boolean; runStartAt?: number; moduleStart?: boolean; firstTest: boolean; runEnd: boolean; deps?: DepsState; fails?: FailState }
interface ProgressReporter {
  root: string;
  onTestRunStart(specifications?: { moduleId: string }[]): void;
  onTestModuleQueued(module?: unknown): void;
  onTestModuleStart(module?: unknown): void;
  onTestCaseReady(): void;
  onTestCaseResult(testCase: unknown): void;
  onTestSuiteResult(testSuite: unknown): void;
  onTestModuleEnd(testModule: unknown): void;
  onTestRunEnd(modules: unknown[]): void;
}
const progress = (await import(pathToFileURL(path.join(SCRIPTS_DIR, 'test-progress-reporter.mjs')).href)) as {
  PROGRESS_ENV: string;
  writeProgress(file: string, ev: string, fields?: { pid?: number; ppid?: number; spec?: string; file?: string; files?: string[] }): void;
  formatSkipLine(groups: SkipGroup[], options?: { top?: number }): string;
  formatFirstTestLine(input: { now: number; runStart: number; config?: string; wrapperSpawn?: number }): string;
  formatModuleStartLine(input: { now: number; runStart: number; config?: string; wrapperSpawn?: number }): string;
  FAIL_LIVE_LIMIT: number;
  FAIL_MESSAGE_MAX: number;
  FAIL_LIMIT_LINE: string;
  failMessage(error: unknown): string;
  failStackLine(error: unknown, root?: string): string;
  formatFailLine(input: { file?: string; label?: string; error?: unknown; root?: string }): string;
  formatFailRemainderLine(suppressed: number): string;
  createFailState(): FailState;
  WRAPPER_SPAWN_ENV: string;
  collectSkips(modules: unknown[], root?: string): SkipGroup[];
  TestLockProgressReporter: new (state: ProgressState, deps?: { write?: (file: string, ev: string) => void; log?: (line: string) => void; now?: () => number; failRun?: () => void }) => ProgressReporter;
  testLockProgressPlugin(): { configureVitest(ctx: { vitest: { config: { reporters: unknown[] } } }): void; configureServer(server: unknown): void };
  STRICT_DEPS_ENV: string;
  DEFAULT_STRICT_DEPS_MODE: StrictDepsMode;
  strictDepsMode(env?: Record<string, string | undefined>): StrictDepsMode;
  createDepsState(mode?: StrictDepsMode): DepsState;
  noteDepDiscovered(dep: string, state?: ProgressState): boolean;
  noteDepReload(state?: ProgressState): string;
  depsRunEnd(state?: ProgressState): { lines: string[]; fail: boolean };
  formatDepsHitLine(deps: string[], options?: { reloaded?: boolean }): string;
  formatDepsSummary(hits: DepsHit[]): string;
  watchDepsOptimizer(server: unknown, options?: { state?: ProgressState; log?: (line: string) => void }): number;
};

// ─── harness ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'test-lock');
const WRAPPER = path.join(ROOT, 'scripts', 'with-test-lock.mjs');
const STATUS = path.join(ROOT, 'scripts', 'test-lock.mjs');
const WATCHDOG = path.join(ROOT, 'scripts', 'test-lock-watchdog.cjs');
const VITEST_CLI = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FAILING_CONFIG = path.join(FIX, 'vitest.failing.config.mjs');
const isWin = process.platform === 'win32';

interface Proc {
  child: ChildProcess;
  pid: number;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

const live: Proc[] = [];
const strayPids: number[] = [];
const tmpDirs: string[] = [];
const usedPorts = new Set<number>();

afterEach(() => {
  for (const p of live.splice(0)) {
    if (p.child.exitCode === null && p.child.signalCode === null) killTree(p.pid);
  }
  for (const pid of strayPids.splice(0)) if (lock.isProcessAlive(pid)) killTree(pid);
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function killTree(pid: number): void {
  if (isWin) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Hard kill of ONE process (no tree): `taskkill /F` on Windows, SIGKILL elsewhere. */
function hardKill(pid: number): void {
  if (isWin) spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
  else process.kill(pid, 'SIGKILL');
}

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-test-lock-'));
  tmpDirs.push(dir);
  return dir;
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host }, () => server.close(() => resolve(true)));
  });
}

function bindError(port: number, host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'ERR'));
    server.listen({ port, host }, () => server.close(() => resolve(null)));
  });
}

/** A port in 47200–47999 that is free on 127.0.0.1 and 0.0.0.0 right now. */
async function allocPort(): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const port = 47200 + Math.floor(Math.random() * 800);
    if (usedPorts.has(port)) continue;
    if (await canBind(port, '127.0.0.1') && await canBind(port, '0.0.0.0')) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error('no free test port in 47200–47999');
}

/** The test process environment without any lock / watchdog / vitest-worker state. */
function cleanEnv(port: number, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('RV_TEST_LOCK') || key.startsWith('RV_TL_') || key.startsWith('VITEST')) delete env[key];
  }
  // plan-2046: the three abort clocks are armed only by RV_TEST_UNATTENDED, and an unattended
  // AutoRun child has it set, so an inherited value would decide these tests instead of the test
  // itself. Both switches are therefore dropped and the ARMED state is the baseline here, because
  // that is the state every clock case below describes. The INTERACTIVE default (nothing armed) is
  // not assumed anywhere — it is pinned by its own cases, which pass RV_TEST_UNATTENDED: undefined
  // (see the describe 'with-test-lock clock states (plan-2046)').
  delete env.RV_TEST_LEGACY_CLOCKS;
  env.RV_TEST_UNATTENDED = '1';
  const nodeOptions = String(env.NODE_OPTIONS ?? '')
    .split(wrapper.nodeOptionsRequire(WATCHDOG)).join(' ').trim();
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
  else delete env.NODE_OPTIONS;
  env.RV_TEST_LOCK_PORT = String(port);
  // plan-2247: these cases are about the lock, not the machine's free memory — gate off.
  env.RV_TEST_MIN_FREE_GB = '0';
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function startNode(args: string[], env: NodeJS.ProcessEnv, opts: { detached?: boolean } = {}): Proc {
  const child = spawn(process.execPath, args, {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: opts.detached ?? false,
  });
  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
  });
  const proc: Proc = { child, pid: child.pid ?? -1, output: () => out, exited };
  live.push(proc);
  return proc;
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const readJson = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
};

/** Starts holder.mjs and waits for its ready file. */
async function startHolder(mode: 'lock' | 'raw', port: number, host = '127.0.0.1', tag = 'holder-fixture') {
  const dir = tmp();
  const proc = startNode([path.join(FIX, 'holder.mjs'), mode, String(port), dir, host, tag], cleanEnv(port));
  const ready = await waitFor('holder ready', () => readJson<{ pid: number; error?: string }>(path.join(dir, 'ready.json')));
  if (ready.error) throw new Error(`holder could not bind: ${ready.error}`);
  return {
    proc,
    dir,
    release: async () => {
      fs.writeFileSync(path.join(dir, 'release'), '');
      await proc.exited;
    },
  };
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv): Proc {
  return startNode([WRAPPER, ...args], env);
}

/**
 * The records of the HOLDING wrapper `w`'s own progress file (`rv-test-lock-progress-<pid>-<ms>.jsonl`
 * in the temp dir), read while it exists — the wrapper deletes it after its child exited, and
 * nothing is written once the child is gone, so the last read holds every record. `records()`
 * reads the file afresh while it still exists (the reporter appends synchronously, so a record
 * written before an observed output line is in it), else returns the last snapshot.
 */
function watchWrapperProgress(w: Proc): { records: () => ProgressRecord[] } {
  let seen: ProgressRecord[] = [];
  let done = false;
  void w.exited.then(() => { done = true; });
  const prefix = `rv-test-lock-progress-${w.pid}-`;
  let name: string | undefined;
  const read = () => {
    try {
      name ??= fs.readdirSync(os.tmpdir()).find((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
      if (name) {
        const records = wrapper.readProgress(path.join(os.tmpdir(), name), 0).records;
        if (records.length >= seen.length) seen = records;
      }
    } catch { /* gone between listing and reading */ }
    return seen;
  };
  const tick = () => {
    read();
    if (!done) setTimeout(tick, 50);
  };
  tick();
  return { records: () => (done ? seen : read()) };
}

/** The `Y` of `… / Y s since wrapper start` in the first line starting with `head`, else NaN. */
function sinceWrapper(output: string, head: string): number {
  const line = output.split(/\r?\n/).find((l) => l.startsWith(head));
  const m = line?.match(/\/ (\d+\.\d) s since wrapper start/);
  return m ? Number(m[1]) : NaN;
}

/** The COMPLETE output lines starting with `[test-fail]` (a trailing line without its newline yet is left out). */
const failLines = (output: string) => output.split(/\r?\n/).slice(0, -1).filter((l) => l.startsWith('[test-fail]'));

interface ChildReport {
  pid: number;
  argv: string[];
  env: { RV_TEST_LOCK_HELD: string | null; RV_TEST_LOCK_PARENT_PID: string | null; NODE_OPTIONS: string | null };
  watchdog: number | null;
  probeStart: Probe;
}

function statusCli(port: number) {
  const r = spawnSync(process.execPath, [STATUS, 'status'], { cwd: ROOT, env: cleanEnv(port), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ─── module: acquire / describeHolder / status ──────────────────────────────

describe('test-lock module (F1, F4–F6, F9)', { timeout: 60_000 }, () => {
  it('binds exactly 127.0.0.1, and a second same-address bind is refused', async () => {
    const port = await allocPort();
    const held = await lock.acquire({ port, info: lock.holderInfo(['addr-test']) });
    try {
      expect((held.server.address() as net.AddressInfo).address).toBe('127.0.0.1');
      expect(await bindError(port, '127.0.0.1')).toBe('EADDRINUSE');
      expect((await lock.describeHolder({ port }))?.argv).toEqual(['addr-test']);
    } finally {
      await held.release();
    }
    expect(await canBind(port, '127.0.0.1')).toBe(true);
  });

  it.runIf(isWin)('NEGATIVE CONTROL: a holder on 0.0.0.0 does NOT exclude a 127.0.0.1 acquirer (why the literal address is fixed)', async () => {
    const port = await allocPort();
    const wrong = await startHolder('raw', port, '0.0.0.0');
    // The same exclusivity check as above, against the broken holder: it must report "not exclusive".
    const got = await lock.acquire({ port, timeoutSeconds: 1, pollSeconds: 0.2, log: () => {} });
    expect((got.server.address() as net.AddressInfo).address).toBe('127.0.0.1');
    await got.release();
    await wrong.release();
  });

  it('a waiter refuses at the deadline naming the holder pid, startedAt and argv; status shows the holder', async () => {
    const port = await allocPort();
    const holder = await startHolder('lock', port, '127.0.0.1', 'refuse-me');
    const info = await lock.describeHolder({ port });
    expect(info?.pid).toBe(holder.proc.pid);

    const status = statusCli(port);
    expect(status.code).toBe(1);
    expect(status.out).toContain(`HELD by PID ${holder.proc.pid}`);
    expect(status.out).toContain('refuse-me');

    const logs: string[] = [];
    const error = await lock.acquire({ port, timeoutSeconds: 2, pollSeconds: 0.5, log: (m) => logs.push(m) })
      .then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain(`PID ${holder.proc.pid}`);
    expect(error!.message).toContain(info!.startedAt);
    expect(error!.message).toContain('refuse-me');
    expect(error!.message).toContain('node scripts/test-lock.mjs status');
    expect(logs.join('\n')).toMatch(new RegExp(`waiting for refuse-me port=${port} \\(PID ${holder.proc.pid}, since .*\\) — \\d+ s left`));
    await holder.release();
    expect(statusCli(port).code).toBe(0);
  });

  it('a waiter acquires once the holder releases on its barrier', async () => {
    const port = await allocPort();
    const holder = await startHolder('lock', port);
    const logs: string[] = [];
    const waiter = lock.acquire({ port, timeoutSeconds: 15, pollSeconds: 0.2, log: (m) => logs.push(m) });
    await waitFor('waiting line', () => logs.some((l) => l.includes('waiting for')));
    fs.writeFileSync(path.join(holder.dir, 'release'), '');
    const got = await waiter;
    expect((await lock.describeHolder({ port }))?.pid).toBe(process.pid);
    await got.release();
    await holder.proc.exited;
  });

  it('a second acquire in the SAME process rejects at once naming this process; the first keeps the lock; release frees it', async () => {
    const port = await allocPort();
    const first = await lock.acquire({ port, timeoutSeconds: 30, pollSeconds: 0.2, log: () => {} });
    const second = await within(
      lock.acquire({ port, timeoutSeconds: 30, pollSeconds: 0.2, log: () => {} }).then(() => 'acquired', (e: Error) => e.message),
      1_000,
    );
    expect(second).toBe(
      `[test-lock] the lock is held by THIS process (PID ${process.pid}) — a second acquire in the same process; ` +
        'this is a test-lock guard bug, not another test run',
    );
    expect((await lock.describeHolder({ port }))?.pid).toBe(process.pid);
    await first.release();
    expect((await lock.probeLock({ port })).state).toBe('free');
  });

  it('a hard-killed holder frees the lock: the next acquire succeeds within one poll', async () => {
    const port = await allocPort();
    const holder = await startHolder('lock', port);
    const logs: string[] = [];
    const pollSeconds = 1;
    const waiter = lock.acquire({ port, timeoutSeconds: 20, pollSeconds, log: (m) => logs.push(m) });
    await waitFor('waiting line', () => logs.some((l) => l.includes('waiting for')));
    const killedAt = Date.now();
    hardKill(holder.proc.pid);
    const got = await waiter;
    const elapsed = Date.now() - killedAt;
    expect(elapsed).toBeLessThan(pollSeconds * 1000 + 1000);
    await got.release();
  });

  it('NEGATIVE CONTROL: without the kill the same waiter does not acquire within the same window', async () => {
    const port = await allocPort();
    const holder = await startHolder('lock', port);
    const error = await lock.acquire({ port, timeoutSeconds: 2, pollSeconds: 1, log: () => {} }).then(() => null, (e: Error) => e);
    expect(error?.message).toContain('gave up');
    await holder.release();
  });

  it('handover race: the holder releases between EADDRINUSE and GET / → acquired, no "unknown" message', async () => {
    const port = await allocPort();
    const holder = await startHolder('lock', port);
    const logs: string[] = [];
    let calls = 0;
    const got = await lock.acquire({
      port, timeoutSeconds: 10, pollSeconds: 5, log: (m) => logs.push(m),
      onBusy: async () => {
        if (calls++ > 0) return;
        fs.writeFileSync(path.join(holder.dir, 'release'), '');
        await waitFor('holder released', () => fs.existsSync(path.join(holder.dir, 'released')));
        await holder.proc.exited;
      },
    });
    expect(calls).toBe(1); // acquired by the re-bind in the SAME round, not after a poll
    expect(logs.join('\n')).not.toContain('unknown');
    await got.release();
  });

  it('NEGATIVE CONTROL: if the port is taken again by an unresponsive process in that gap, the same check sees "unknown"', async () => {
    const port = await allocPort();
    const holder = await startHolder('lock', port);
    const logs: string[] = [];
    let calls = 0;
    let squatter: Awaited<ReturnType<typeof startHolder>> | null = null;
    const error = await lock.acquire({
      port, timeoutSeconds: 1.5, pollSeconds: 0.5, log: (m) => logs.push(m),
      onBusy: async () => {
        if (calls++ > 0) return;
        fs.writeFileSync(path.join(holder.dir, 'release'), '');
        await holder.proc.exited;
        squatter = await startHolder('raw', port);
      },
    }).then(() => null, (e: Error) => e);
    expect(error).not.toBeNull();
    expect(logs.join('\n')).toContain('unknown');
    await squatter!.release();
  });

  it('an unresponsive holder is reported as unknown/unresponsive; the waiter keeps waiting and refuses at the deadline', async () => {
    const port = await allocPort();
    const raw = await startHolder('raw', port);
    expect(statusCli(port).code).toBe(2);
    const logs: string[] = [];
    const started = Date.now();
    const error = await lock.acquire({ port, timeoutSeconds: 4, pollSeconds: 0.5, log: (m) => logs.push(m) })
      .then(() => null, (e: Error) => e);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3900); // kept waiting up to the deadline
    expect(error?.message).toContain('unknown/unresponsive');
    expect(error?.message).toContain('RV_TEST_LOCK_PORT');
    expect(logs.some((l) => l.includes('unknown/unresponsive'))).toBe(true);
    await raw.release();
  });

  async function contend(mode: 'contend' | 'contend-raw', hosts: string[]): Promise<string[]> {
    const port = await allocPort();
    const dir = tmp();
    const procs = hosts.map((host) => startNode([path.join(FIX, 'holder.mjs'), mode, String(port), dir, host], cleanEnv(port)));
    await waitFor('all armed', () => procs.every((p) => fs.existsSync(path.join(dir, `armed-${p.pid}`))));
    fs.writeFileSync(path.join(dir, 'go'), '');
    const results = await waitFor('all results', () => {
      const files = procs.map((p) => path.join(dir, `result-${p.pid}`));
      return files.every((f) => fs.existsSync(f)) ? files.map((f) => fs.readFileSync(f, 'utf8')) : null;
    });
    fs.writeFileSync(path.join(dir, 'release'), '');
    await Promise.all(procs.map((p) => p.exited));
    return results;
  }

  it('three concurrent acquirers → exactly one holds', async () => {
    const results = await contend('contend', ['127.0.0.1', '127.0.0.1', '127.0.0.1']);
    expect(results.filter((r) => r === 'WON')).toHaveLength(1);
    expect(results.filter((r) => r === 'LOST')).toHaveLength(2);
  });

  it.runIf(isWin)('NEGATIVE CONTROL: three contenders on different literal addresses all "win" — the exactly-one check flags it', async () => {
    const results = await contend('contend-raw', ['127.0.0.1', '0.0.0.0', '::']);
    expect(results.filter((r) => r === 'WON').length).toBeGreaterThan(1);
  });

  it('RV_TEST_LOCK=off disables; RV_TEST_LOCK_DIR is ignored by the configuration', () => {
    expect(lock.lockConfig({ RV_TEST_LOCK: 'off' }).disabled).toBe(true);
    expect(lock.lockConfig({ RV_TEST_LOCK: 'OFF' }).disabled).toBe(true);
    expect(lock.lockConfig({}).disabled).toBe(false);
    expect(lock.lockConfig({ RV_TEST_LOCK_DIR: 'C:/somewhere' })).toEqual(lock.lockConfig({}));
    expect(lock.lockConfig({}).port).toBe(47177);
    expect(lock.lockConfig({ RV_TEST_LOCK_PORT: '47300' }).port).toBe(47300);
    expect(lock.lockConfig({}).timeoutSeconds).toBe(1800);
    expect(lock.lockConfig({}).pollSeconds).toBe(2);
  });
});

// ─── wrapper ────────────────────────────────────────────────────────────────

describe('with-test-lock wrapper (F2, F2a, F9, F10)', { timeout: 60_000 }, () => {
  const CHILD = path.join(FIX, 'child-barrier.mjs');

  it('passes the child exit code through (0, 7, 0xC000013A on win32); signal/kill and a missing runner → 1', async () => {
    const port = await allocPort();
    const codes = isWin ? [0, 7, 3221225786] : [0, 7];
    for (const code of codes) {
      const dir = tmp();
      const w = runWrapper([CHILD, dir, String(code)], cleanEnv(port));
      expect((await w.exited).code, w.output()).toBe(code);
    }
    const killed = runWrapper([CHILD, tmp(), 'kill'], cleanEnv(port));
    expect((await killed.exited).code).toBe(1);
    const missing = runWrapper(['does-not-exist.mjs'], cleanEnv(port));
    expect((await missing.exited).code).toBe(1);
    expect(missing.output()).toContain('runner not found');

    expect(wrapper.exitCodeFor(null, 'SIGTERM')).toBe(1);
    expect(wrapper.exitCodeFor(null, null)).toBe(1);
    expect(wrapper.exitCodeFor(5, null)).toBe(5);
    expect(wrapper.exitCodeFor(3221225786, null)).toBe(3221225786);
    expect(wrapper.parseArgs(['--', 'vitest', 'run'])).toEqual({ runner: 'vitest', args: ['run'] });
  });

  it('passes arguments unchanged (no shell)', async () => {
    const port = await allocPort();
    const dir = tmp();
    const args = ['-t', 'a b|c', 'tests/foo.test.ts', '--reporter=dot', '', 'q"uote', 'percent%PATH%', 'caret^&amp|pipe', '$HOME'];
    const w = runWrapper([CHILD, dir, '0', ...args], cleanEnv(port));
    expect((await w.exited).code, w.output()).toBe(0);
    expect(readJson<ChildReport>(path.join(dir, 'child.json'))?.argv).toEqual(args);
  });

  async function lifetime(entry: string[], port: number) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'wait'), '');
    const w = startNode([...entry, CHILD, dir, '0'], cleanEnv(port));
    const report = await waitFor('child report', () => readJson<ChildReport>(path.join(dir, 'child.json')));
    fs.writeFileSync(path.join(dir, 'release'), '');
    const exit = await w.exited;
    const atExit = readJson<{ probeExit: Probe }>(path.join(dir, 'child-exit.json'));
    const after = await lock.probeLock({ port });
    const heldBy = (p: Probe | undefined) => (p?.state === 'held' ? p.holder?.pid : null);
    return {
      exit,
      bracketed: heldBy(report.probeStart) === w.pid && heldBy(atExit?.probeExit) === w.pid && after.state === 'free',
      report,
    };
  }

  it('holds the lock until the child has exited, and releases it afterwards', async () => {
    const port = await allocPort();
    const r = await lifetime([WRAPPER], port);
    expect(r.exit.code).toBe(0);
    expect(r.bracketed).toBe(true);
  });

  it('NEGATIVE CONTROL: a wrapper that releases before its child exits is flagged by the same lifetime check', async () => {
    const port = await allocPort();
    const r = await lifetime([path.join(FIX, 'early-release-wrapper.mjs')], port);
    expect(r.exit.code).toBe(0);
    expect(r.bracketed).toBe(false);
  });

  it('gives the child RV_TEST_LOCK_HELD / _PARENT_PID = wrapper pid and the watchdog via NODE_OPTIONS (forward slashes, existing options kept)', async () => {
    const port = await allocPort();
    const dir = tmp();
    const w = runWrapper([CHILD, dir, '0'], cleanEnv(port, { NODE_OPTIONS: '--max-old-space-size=4096' }));
    expect((await w.exited).code, w.output()).toBe(0);
    const report = readJson<ChildReport>(path.join(dir, 'child.json'))!;
    expect(report.env.RV_TEST_LOCK_HELD).toBe(String(w.pid));
    expect(report.env.RV_TEST_LOCK_PARENT_PID).toBe(String(w.pid));
    expect(report.env.NODE_OPTIONS).toContain('--max-old-space-size=4096');
    expect(report.env.NODE_OPTIONS).toContain(`--require "${WATCHDOG.replace(/\\/g, '/')}"`);
    expect(report.env.NODE_OPTIONS).not.toContain('\\');
    expect(report.watchdog).toBe(w.pid); // the watchdog really loaded in the child
  });

  it('normalises a backslash watchdog path and keeps exactly one --require', () => {
    expect(wrapper.nodeOptionsRequire('C:\\a dir\\scripts\\w.cjs')).toBe('--require "C:/a dir/scripts/w.cjs"');
    const once = wrapper.withWatchdog('--inspect', 'C:\\x\\w.cjs');
    expect(once).toBe('--inspect --require "C:/x/w.cjs"');
    expect(wrapper.withWatchdog(once, 'C:\\x\\w.cjs')).toBe(once);
    expect(wrapper.withWatchdog(undefined, 'E:\\w.cjs')).toBe('--require "E:/w.cjs"');
  });

  it.runIf(isWin)('NEGATIVE CONTROL: the un-normalised backslash path in NODE_OPTIONS breaks node startup', () => {
    const r = spawnSync(process.execPath, ['-e', '0'], {
      env: cleanEnv(1, { NODE_OPTIONS: `--require "${WATCHDOG}"` }), encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Cannot find module');
  });

  it('re-enters under a LIVE RV_TEST_LOCK_HELD pid: no bind, environment passed on unchanged', async () => {
    const port = await allocPort();
    const dir = tmp();
    const env = cleanEnv(port, {
      RV_TEST_LOCK_HELD: String(process.pid),
      RV_TEST_LOCK_PARENT_PID: String(process.pid),
      NODE_OPTIONS: '--max-old-space-size=4000',
    });
    const w = runWrapper([CHILD, dir, '0'], env);
    expect((await w.exited).code, w.output()).toBe(0);
    expect(w.output()).toContain('re-entering');
    const report = readJson<ChildReport>(path.join(dir, 'child.json'))!;
    expect(report.probeStart.state).toBe('free');
    expect(report.env).toEqual({
      RV_TEST_LOCK_HELD: String(process.pid),
      RV_TEST_LOCK_PARENT_PID: String(process.pid),
      NODE_OPTIONS: '--max-old-space-size=4000',
    });
  });

  it('ignores a DEAD RV_TEST_LOCK_HELD pid and acquires normally', async () => {
    const port = await allocPort();
    const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    const deadPid = Number(gone.stdout.trim());
    expect(lock.isProcessAlive(deadPid)).toBe(false);
    const dir = tmp();
    const w = runWrapper([CHILD, dir, '0'], cleanEnv(port, { RV_TEST_LOCK_HELD: String(deadPid) }));
    expect((await w.exited).code, w.output()).toBe(0);
    const report = readJson<ChildReport>(path.join(dir, 'child.json'))!;
    expect(report.probeStart.holder?.pid).toBe(w.pid);
    expect(report.env.RV_TEST_LOCK_HELD).toBe(String(w.pid));
  });

  it('RV_TEST_LOCK=off runs the child at once without the lock, even while the lock is held', async () => {
    const port = await allocPort();
    const holder = await startHolder('lock', port);
    const dir = tmp();
    const w = runWrapper([CHILD, dir, '0'], cleanEnv(port, { RV_TEST_LOCK: 'off', RV_TEST_LOCK_TIMEOUT_SECONDS: '1' }));
    expect((await w.exited).code, w.output()).toBe(0);
    const report = readJson<ChildReport>(path.join(dir, 'child.json'))!;
    expect(report.env.RV_TEST_LOCK_HELD).toBeNull();
    expect(report.probeStart.holder?.pid).toBe(holder.proc.pid);
    await holder.release();
  });

  it('RV_TEST_LOCK_DIR is ignored: the port lock is taken, nothing is written to that directory', async () => {
    const port = await allocPort();
    const lockDir = tmp();
    const dir = tmp();
    const w = runWrapper([CHILD, dir, '0'], cleanEnv(port, { RV_TEST_LOCK_DIR: lockDir }));
    expect((await w.exited).code, w.output()).toBe(0);
    expect(readJson<ChildReport>(path.join(dir, 'child.json'))!.probeStart.holder?.pid).toBe(w.pid);
    expect(fs.readdirSync(lockDir)).toEqual([]);
  });

  it('a second wrapper waits for the first and runs after it (mutual exclusion through the wrapper)', async () => {
    const port = await allocPort();
    const dirA = tmp();
    fs.writeFileSync(path.join(dirA, 'wait'), '');
    const a = runWrapper([CHILD, dirA, '0'], cleanEnv(port));
    await waitFor('A child', () => readJson<ChildReport>(path.join(dirA, 'child.json')));
    const dirB = tmp();
    const b = runWrapper([CHILD, dirB, '0'], cleanEnv(port, { RV_TEST_LOCK_POLL_SECONDS: '0.2' }));
    await waitFor('B waiting line', () => b.output().includes('waiting for'));
    expect(fs.existsSync(path.join(dirB, 'child.json'))).toBe(false);
    fs.writeFileSync(path.join(dirA, 'release'), '');
    const exitA = await a.exited;
    expect((await b.exited).code, b.output()).toBe(0);
    const reportB = readJson<ChildReport>(path.join(dirB, 'child.json'))!;
    expect(reportB.probeStart.holder?.pid).toBe(b.pid);
    expect(exitA.code).toBe(0);
  });

  it.runIf(isWin)('hard kill of the wrapper ends the whole tree within 5 s, incl. a NON-Node grandchild without watchdog (job object)', async () => {
    const port = await allocPort();
    const dir = tmp();
    const w = runWrapper([path.join(FIX, 'child-tree.mjs'), dir], cleanEnv(port));
    const tree = await waitFor('tree.json', () => readJson<{ child: number; nonNode: number; nodeAttached: number; nodeDetached: number }>(path.join(dir, 'tree.json')));
    strayPids.push(tree.child, tree.nonNode, tree.nodeAttached, tree.nodeDetached);
    // NEGATIVE CONTROL for the liveness detector: a ping that is NOT under the wrapper.
    const control = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
    strayPids.push(control.pid!);

    const attached = [tree.child, tree.nonNode, tree.nodeAttached];
    expect(attached.every((pid) => lock.isProcessAlive(pid))).toBe(true);
    const killedAt = Date.now();
    hardKill(w.pid); // taskkill /F without /T: only the wrapper itself
    await waitFor('attached tree gone', () => attached.every((pid) => !lock.isProcessAlive(pid)), 5000);
    expect(Date.now() - killedAt).toBeLessThanOrEqual(5000);
    expect(lock.isProcessAlive(control.pid)).toBe(true); // the detector does see a living process
    expect((await lock.probeLock({ port })).state).toBe('free');
    // Documented limit, not asserted: a `detached: true` grandchild leaves the job and may survive.
    console.log(`[test-lock test] detached grandchild alive after wrapper kill: ${lock.isProcessAlive(tree.nodeDetached)}`);
  });
});

// ─── wrapper: maximum run time ──────────────────────────────────────────────

describe('with-test-lock maximum run time (RV_TEST_MAX_RUNTIME_MINUTES)', { timeout: 60_000 }, () => {
  const CHILD = path.join(FIX, 'child-barrier.mjs');

  /** A wrapper whose child waits forever (wait file, never a release file). */
  async function hungRun(extra: Record<string, string>, port: number) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'wait'), '');
    const startedAt = Date.now();
    const w = runWrapper([CHILD, dir, '0'], cleanEnv(port, extra));
    const report = await waitFor('child report', () => readJson<ChildReport>(path.join(dir, 'child.json')));
    strayPids.push(report.pid);
    return { w, report, startedAt };
  }

  it('parses the env: default 90, 0 disables, fractions allowed, garbage → default', () => {
    expect(wrapper.maxRuntime({})).toEqual({ minutes: 90, ms: 5_400_000 });
    expect(wrapper.maxRuntime({ RV_TEST_MAX_RUNTIME_MINUTES: '0' })).toEqual({ minutes: 0, ms: 0 });
    expect(wrapper.maxRuntime({ RV_TEST_MAX_RUNTIME_MINUTES: '0.02' })).toEqual({ minutes: 0.02, ms: 1200 });
    expect(wrapper.maxRuntime({ RV_TEST_MAX_RUNTIME_MINUTES: 'x' }).minutes).toBe(90);
    expect(wrapper.maxRuntime({ RV_TEST_MAX_RUNTIME_MINUTES: '-1' }).minutes).toBe(90);
    expect(wrapper.MAX_RUNTIME_EXIT_CODE).toBe(124);
  });

  it('a run past the limit ends within 5 s: exit 124, the line is printed, the child is gone, the lock is free', async () => {
    const port = await allocPort();
    const { w, report, startedAt } = await hungRun({ RV_TEST_MAX_RUNTIME_MINUTES: '0.02' }, port);
    expect(report.probeStart.holder?.pid).toBe(w.pid);
    const exit = await w.exited;
    expect(exit.code, w.output()).toBe(124);
    expect(exit.at - startedAt).toBeLessThanOrEqual(5000);
    expect(w.output()).toMatch(/\[test-lock\] run exceeded RV_TEST_MAX_RUNTIME_MINUTES=0\.02 \(started \d{4}-\d\d-\d\dT[^)]*, argv .*child-barrier\.mjs.*\) — ending the test tree and releasing the lock/);
    expect(w.output()).toContain('released');
    expect(w.output().trim().split('\n').at(-1)).toMatch(/\[test-lock\] FAILED \(exit 12[45]\): /);
    await waitFor('child gone', () => !lock.isProcessAlive(report.pid), 5000);
    expect((await lock.probeLock({ port })).state).toBe('free');
    expect(await lock.describeHolder({ port })).toBeNull();
  });

  it('NEGATIVE CONTROL: with 0 (disabled) the same hung run is NOT ended within 3 s', async () => {
    const port = await allocPort();
    const { w, report } = await hungRun({ RV_TEST_MAX_RUNTIME_MINUTES: '0' }, port);
    expect(await within(w.exited, 3000)).toBe('pending');
    expect(lock.isProcessAlive(report.pid)).toBe(true);
    expect(w.output()).not.toContain('run exceeded');
  });

  it('a re-entering wrapper (live RV_TEST_LOCK_HELD) does not start the timer', async () => {
    const port = await allocPort();
    const { w, report } = await hungRun({ RV_TEST_MAX_RUNTIME_MINUTES: '0.02', RV_TEST_LOCK_HELD: String(process.pid) }, port);
    expect(w.output()).toContain('re-entering');
    expect(await within(w.exited, 3000)).toBe('pending');
    expect(lock.isProcessAlive(report.pid)).toBe(true);
    expect(w.output()).not.toContain('run exceeded');
  });
});

// ─── wrapper: startup limit ─────────────────────────────────────────────────

describe('with-test-lock startup limit (RV_TEST_STARTUP_TIMEOUT_SECONDS)', { timeout: 60_000 }, () => {
  const FAKE_VITEST = path.join(FIX, 'fake-vitest', 'vitest.mjs');
  const SEQUENCE = path.join(FIX, 'suite-sequence.mjs');
  const pidsIn = (dir: string) => {
    try { return fs.readFileSync(path.join(dir, 'pids.txt'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
  };
  /** A holding wrapper around the fake vitest with `steps`; `extra` env on top. */
  async function fakeRun(steps: string, extra: Record<string, string>) {
    const port = await allocPort();
    const dir = tmp();
    const startedAt = Date.now();
    const w = runWrapper([FAKE_VITEST, dir, steps], cleanEnv(port, extra));
    const [pid] = await waitFor('fake vitest pid', () => { const p = pidsIn(dir); return p.length ? p : null; });
    strayPids.push(pid);
    return { w, pid, dir, port, startedAt };
  }
  const LINE = /\[test-lock\] no test file started within RV_TEST_STARTUP_TIMEOUT_SECONDS=2 \(waited \d+\.\d s since [^,]+.*, argv .*\) — ending the test tree and releasing the lock; RV_TEST_STARTUP_TIMEOUT_SECONDS=0 disables this limit/;

  it('parses the env: default 300, 0 disables, fractions allowed, garbage → default; exit code 125', () => {
    expect(wrapper.startupTimeout({})).toEqual({ seconds: 300, ms: 300_000 });
    expect(wrapper.startupTimeout({ RV_TEST_STARTUP_TIMEOUT_SECONDS: '0' })).toEqual({ seconds: 0, ms: 0 });
    expect(wrapper.startupTimeout({ RV_TEST_STARTUP_TIMEOUT_SECONDS: '1.5' })).toEqual({ seconds: 1.5, ms: 1500 });
    expect(wrapper.startupTimeout({ RV_TEST_STARTUP_TIMEOUT_SECONDS: 'x' }).seconds).toBe(300);
    expect(wrapper.startupTimeout({ RV_TEST_STARTUP_TIMEOUT_SECONDS: '-3' }).seconds).toBe(300);
    expect(wrapper.STARTUP_TIMEOUT_EXIT_CODE).toBe(125);
    expect(wrapper.isVitestRunner('vitest')).toBe(true);
    expect(wrapper.isVitestRunner('x', path.join('a', 'node_modules', 'vitest', 'vitest.mjs'))).toBe(true);
    expect(wrapper.isVitestRunner('playwright', 'cli.js')).toBe(false);
    expect(wrapper.isVitestRunner('scripts/run-all-tests.mjs', 'run-all-tests.mjs')).toBe(false);
  });

  it('window bookkeeping: handover keeps the start time, reruns are ignored, first-test / run-end / a gone process close', () => {
    const watch = wrapper.createStartupWatch(1000);
    watch.onRecord({ ev: 'expect', pid: 10 }, 0); // re-entering wrapper 10
    watch.onRecord({ ev: 'run-start', pid: 11, ppid: 10 }, 600); // its vitest takes the window over
    expect([...watch.pending.keys()]).toEqual([11]);
    expect(watch.expired(999)).toBeNull();
    expect(watch.expired(1000)?.pid).toBe(11); // counted from the wrapper start, not the run start
    watch.onRecord({ ev: 'first-test', pid: 11 }, 1001);
    expect(watch.expired(5000)).toBeNull();
    watch.onRecord({ ev: 'run-start', pid: 11, ppid: 10 }, 6000); // watch rerun: never limited
    expect(watch.expired(99_000)).toBeNull();
    watch.onRecord({ ev: 'run-start', pid: 20, ppid: 99 }, 10_000); // no open parent → own window
    watch.onRecord({ ev: 'run-end', pid: 20 }, 10_500);
    watch.open(30, 20_000, 'x');
    watch.prune((pid) => pid !== 30);
    expect(watch.pending.size).toBe(0);
    expect(wrapper.createStartupWatch(0).expired(1e9)).toBeNull();
  });

  it('window bookkeeping (plan-617): module-start closes the window; NEGATIVE CONTROL: run-start alone expires', () => {
    const watch = wrapper.createStartupWatch(1000);
    watch.open(40, 0, 'the vitest start');
    watch.onRecord({ ev: 'run-start', pid: 41, ppid: 40 }, 200); // vitest takes the holder child's window over
    watch.onRecord({ ev: 'module-start', pid: 41 }, 500); // first test file started, no test event yet
    expect(watch.pending.size).toBe(0);
    expect(watch.expired(1e9)).toBeNull();
    watch.onRecord({ ev: 'run-start', pid: 41, ppid: 40 }, 2000); // a later run of the same process: never limited
    expect(watch.expired(1e9)).toBeNull();
    const control = wrapper.createStartupWatch(1000);
    control.onRecord({ ev: 'run-start', pid: 50, ppid: 99 }, 0);
    expect(control.expired(999)).toBeNull();
    expect(control.expired(1000)?.pid).toBe(50);
  });

  it('reads only complete progress lines and resumes at the returned offset', () => {
    const file = path.join(tmp(), 'p.jsonl');
    fs.writeFileSync(file, '{"ev":"run-start","pid":1}\n{"ev":"first-');
    const a = wrapper.readProgress(file, 0);
    expect(a.records).toEqual([{ ev: 'run-start', pid: 1 }]);
    fs.appendFileSync(file, 'test","pid":1}\n');
    const b = wrapper.readProgress(file, a.offset);
    expect(b.records).toEqual([{ ev: 'first-test', pid: 1 }]);
    expect(wrapper.readProgress(path.join(tmp(), 'missing'), 7)).toEqual({ records: [], offset: 7 });
  });

  it('run started but no test file (only run-start, the #172 hang) → exit 125 within the limit + 3 s, the line is printed, the tree is gone, the lock is free', async () => {
    const { w, pid, port, startedAt } = await fakeRun('start,idle', { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2' });
    const exit = await w.exited;
    expect(exit.code, w.output()).toBe(125);
    expect(exit.at - startedAt).toBeGreaterThanOrEqual(2000);
    expect(exit.at - startedAt).toBeLessThanOrEqual(5000);
    expect(w.output()).toMatch(LINE);
    expect(w.output()).toContain('released');
    expect(w.output().trim().split('\n').at(-1)).toMatch(/\[test-lock\] FAILED \(exit 12[45]\): /);
    await waitFor('fake vitest gone', () => !lock.isProcessAlive(pid), 5000);
    expect((await lock.probeLock({ port })).state).toBe('free');
  });

  it('a vitest runner that never reports a run start is ended too (exit 125)', async () => {
    const { w, pid } = await fakeRun('idle', { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2' });
    expect((await w.exited).code, w.output()).toBe(125);
    expect(w.output()).toMatch(LINE);
    await waitFor('fake vitest gone', () => !lock.isProcessAlive(pid), 5000);
  });

  it('a test file started inside the limit, then a long silence (a long first test) → NOT ended (plan-617)', async () => {
    const { w } = await fakeRun('start,sleep:300,module,sleep:3500', { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2' });
    expect((await w.exited).code, w.output()).toBe(0);
    expect(w.output()).not.toContain('no test file started');
  });

  it('NEGATIVE CONTROL: a first test inside the limit → the run continues past it and exits with its own code', async () => {
    const { w } = await fakeRun('start,sleep:500,first,sleep:3000', { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2' });
    expect((await w.exited).code, w.output()).toBe(0);
    expect(w.output()).not.toContain('no test file started');
  });

  it('NEGATIVE CONTROL: with 0 (disabled) the same stuck run is NOT ended within 3.5 s', async () => {
    const { w, pid } = await fakeRun('start,idle', { RV_TEST_STARTUP_TIMEOUT_SECONDS: '0' });
    expect(await within(w.exited, 3500)).toBe('pending');
    expect(lock.isProcessAlive(pid)).toBe(true);
    expect(w.output()).not.toContain('no test file started');
  });

  it('a non-vitest command without reporter records is never limited', async () => {
    const port = await allocPort();
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'wait'), '');
    const w = runWrapper([path.join(FIX, 'child-barrier.mjs'), dir, '0'], cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: '1' }));
    const report = await waitFor('child report', () => readJson<ChildReport>(path.join(dir, 'child.json')));
    strayPids.push(report.pid);
    expect(await within(w.exited, 3000)).toBe('pending');
    expect(lock.isProcessAlive(report.pid)).toBe(true);
    fs.writeFileSync(path.join(dir, 'release'), '');
    expect((await w.exited).code).toBe(0);
    expect(w.output()).not.toContain('no test file started');
  });

  it('watch-like: a second run start of the same process after its first test is not limited', async () => {
    const { w } = await fakeRun('start,first,end,start,sleep:3500', { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2' });
    expect((await w.exited).code, w.output()).toBe(0);
    expect(w.output()).not.toContain('no test file started');
  });

  it('test:all-like: two sequential re-entering vitest runs each get their own window', async () => {
    const port = await allocPort();
    const dir = tmp();
    // Each run reaches its first test 1 s after its start; together they outlast the 2.5 s limit.
    const w = runWrapper([SEQUENCE, dir, 'start,sleep:1000,first,sleep:2000', 'start,sleep:1000,first'],
      cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2.5' }));
    const exit = await w.exited;
    expect(exit.code, w.output()).toBe(0);
    expect(pidsIn(dir)).toHaveLength(2);
    expect(w.output()).toContain('re-entering');
    expect(w.output()).not.toContain('no test file started');
  });

  it('NEGATIVE CONTROL: test:all-like with a stuck SECOND run → exit 125, named after the inner wrapper start', async () => {
    const port = await allocPort();
    const dir = tmp();
    const w = runWrapper([SEQUENCE, dir, 'start,first,sleep:500', 'start,idle'],
      cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2' }));
    const exit = await w.exited;
    expect(exit.code, w.output()).toBe(125);
    expect(w.output()).toMatch(/no test file started within RV_TEST_STARTUP_TIMEOUT_SECONDS=2 \(waited \d+\.\d s since vitest wrapper start, PID \d+/);
    const pids = pidsIn(dir);
    expect(pids).toHaveLength(2);
    strayPids.push(...pids);
    await waitFor('stuck run gone', () => !lock.isProcessAlive(pids[1]), 5000);
    expect((await lock.probeLock({ port })).state).toBe('free');
  });

  it('test:all-like (plan-617): a second run with only a test-file start and no first test is NOT ended', async () => {
    const port = await allocPort();
    const dir = tmp();
    const w = runWrapper([SEQUENCE, dir, 'start,module,first,sleep:500', 'start,sleep:300,module,sleep:3000'],
      cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2' }));
    const exit = await w.exited;
    expect(exit.code, w.output()).toBe(0);
    expect(pidsIn(dir)).toHaveLength(2);
    expect(w.output()).not.toContain('no test file started');
  });

  it('NEGATIVE CONTROL: test:all-like with a SECOND run that reports no event at all → exit 125', async () => {
    const port = await allocPort();
    const dir = tmp();
    const w = runWrapper([SEQUENCE, dir, 'start,module,first,sleep:500', 'idle'],
      cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: '2' }));
    const exit = await w.exited;
    expect(exit.code, w.output()).toBe(125);
    expect(w.output()).toMatch(/no test file started within RV_TEST_STARTUP_TIMEOUT_SECONDS=2 \(waited \d+\.\d s since vitest wrapper start, PID \d+/);
    const pids = pidsIn(dir);
    expect(pids).toHaveLength(2);
    strayPids.push(...pids);
    await waitFor('silent run gone', () => !lock.isProcessAlive(pids[1]), 5000);
  });

  it('a re-entering wrapper does not watch on its own (no holder progress file)', async () => {
    const { w, pid } = await fakeRun('start,idle', { RV_TEST_STARTUP_TIMEOUT_SECONDS: '1', RV_TEST_LOCK_HELD: String(process.pid) });
    expect(w.output()).toContain('re-entering');
    expect(await within(w.exited, 2500)).toBe('pending');
    expect(lock.isProcessAlive(pid)).toBe(true);
  });
});

// ─── progress reporter + skip line ──────────────────────────────────────────

describe('test progress reporter (startup records, [test-skips] line)', { timeout: 60_000 }, () => {
  const CONFIG = path.join(FIX, 'vitest.progress.config.mjs');

  /** A fake TestModule: `skips` = notes ('' = no note) of its skipped tests. */
  const fakeModule = (moduleId: string, skips: string[]) => ({
    moduleId,
    children: {
      *allTests(state?: string) {
        if (state !== 'skipped') throw new Error('expects the skipped filter');
        for (const note of skips) yield { result: () => ({ state: 'skipped', note: note || undefined }) };
      },
    },
  });

  it('formats the skip line: "0 skipped" for 0, groups by count, top 5 + "N more"', () => {
    expect(progress.formatSkipLine([])).toBe('[test-skips] 0 skipped');
    expect(progress.formatSkipLine([{ key: 'a', count: 0 }])).toBe('[test-skips] 0 skipped');
    expect(progress.formatSkipLine([{ key: 'dev-asset missing', count: 103 }, { key: 'no-adapter', count: 8 }]))
      .toBe('[test-skips] 111 skipped: 103 dev-asset missing, 8 no-adapter');
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key, i) => ({ key, count: 10 - i }));
    expect(progress.formatSkipLine(many)).toBe('[test-skips] 49 skipped: 10 a, 9 b, 8 c, 7 d, 6 e, … (+2 more)');
  });

  it('formats the measurement line, with the wrapper part only when the spawn time is known', () => {
    const runStart = Date.parse('2026-10-16T10:34:57.250Z');
    expect(progress.formatFirstTestLine({ now: runStart + 12_400, runStart, config: 'vite.config.ts' }))
      .toBe('[test-progress] first test after 12.4 s (run start 2026-10-16T10:34:57Z, config vite.config.ts)');
    expect(progress.formatFirstTestLine({ now: runStart + 12_400, runStart, config: 'vite.config.ts', wrapperSpawn: runStart - 28_600 }))
      .toBe('[test-progress] first test after 12.4 s (run start 2026-10-16T10:34:57Z, config vite.config.ts) / 41.0 s since wrapper start');
    expect(progress.formatFirstTestLine({ now: runStart, runStart, wrapperSpawn: 0 })).not.toContain('wrapper');
    expect(progress.formatModuleStartLine({ now: runStart + 3_100, runStart, config: 'vite.config.ts', wrapperSpawn: runStart - 900 }))
      .toBe('[test-progress] first test file started after 3.1 s (run start 2026-10-16T10:34:57Z, config vite.config.ts) / 4.0 s since wrapper start');
    expect(progress.formatModuleStartLine({ now: runStart, runStart })).toBe('[test-progress] first test file started after 0.0 s (run start 2026-10-16T10:34:57Z, config default)');
  });

  it('module-start: once per process, a measurement line, and NOT the strict-deps boundary (plan-617 F5)', () => {
    const records: string[] = [];
    const lines: string[] = [];
    const state: ProgressState = { file: 'p.jsonl', runStart: false, firstTest: false, runEnd: false, deps: progress.createDepsState('fail') };
    let failed = 0;
    const reporter = new progress.TestLockProgressReporter(state, { write: (_f, ev) => records.push(ev), log: (l) => lines.push(l), failRun: () => { failed++; } });
    reporter.onTestRunStart();
    reporter.onTestModuleStart();
    reporter.onTestModuleStart();
    expect(records).toEqual(['run-start', 'file-start', 'module-start', 'file-start']);
    expect(lines.filter((l) => l.startsWith('[test-progress] first test file started after'))).toHaveLength(1);
    expect(state.firstTest).toBe(false);
    // a discovery after module-start but before the first test is legitimate (cold crawl of the first file) …
    expect(progress.noteDepDiscovered('crawl-dep', state)).toBe(false);
    expect(progress.noteDepReload(state)).toBe('');
    reporter.onTestCaseReady();
    expect(records).toEqual(['run-start', 'file-start', 'module-start', 'file-start', 'first-test']);
    // … NEGATIVE CONTROL: the same discovery after the first test is a hit
    expect(progress.noteDepDiscovered('late-dep', state)).toBe(true);
    reporter.onTestRunEnd([]);
    expect(lines).toContain('[test-deps] 1 mid-run re-optimization: late-dep');
    expect(failed).toBe(1);
  });

  it('groups skipped tests by note, else as "no reason given: <file>" relative to the root', () => {
    const root = path.join(os.tmpdir(), 'rv-root');
    const groups = progress.collectSkips([
      fakeModule(path.join(root, 'tests', 'a.test.ts'), ['no-adapter', '', '']),
      fakeModule(path.join(root, 'tests', 'b.test.ts'), ['no-adapter']),
      fakeModule(path.join(root, 'tests', 'c.test.ts'), []),
    ], root);
    expect(new Map(groups.map((g) => [g.key, g.count]))).toEqual(new Map([
      ['no-adapter', 2],
      ['no reason given: tests/a.test.ts', 2],
    ]));
  });

  it('groups tests skipped because a beforeAll of their file threw as "file failed in setup: <file>" (module or describe failed with errors)', () => {
    const root = path.join(os.tmpdir(), 'rv-root');
    const setupError = { message: 'dist/index.html not found' };
    /** vitest 4 shape: TestModule / TestSuite with state() + errors(), TestCase.parent up to the module. */
    const tree = (moduleId: string, opts: { moduleFailed?: boolean; suiteFailed?: boolean; notes: string[] }) => {
      const tests: Array<{ parent: unknown; result: () => { state: string; note?: string } }> = [];
      const module = {
        moduleId,
        state: () => (opts.moduleFailed || opts.suiteFailed ? 'failed' : 'passed'),
        errors: () => (opts.moduleFailed ? [setupError] : []),
        children: {
          *allTests(state?: string) {
            if (state !== 'skipped') throw new Error('expects the skipped filter');
            yield* tests;
          },
        },
      };
      const suite = {
        parent: module,
        state: () => (opts.suiteFailed ? 'failed' : 'skipped'),
        errors: () => (opts.suiteFailed ? [setupError] : []),
      };
      for (const note of opts.notes) tests.push({ parent: suite, result: () => ({ state: 'skipped', note: note || undefined }) });
      return module;
    };
    const groups = progress.collectSkips([
      tree(path.join(root, 'tests', 'bundle-splitting.test.ts'), { moduleFailed: true, notes: ['', '', ''] }), // file-level beforeAll threw
      tree(path.join(root, 'tests', 'd.test.ts'), { suiteFailed: true, notes: ['', 'kept note'] }), // a describe's beforeAll threw; a note still wins
      tree(path.join(root, 'tests', 'e.test.ts'), { notes: [''] }), // NEGATIVE CONTROL: nothing failed → no reason given
    ], root);
    expect(new Map(groups.map((g) => [g.key, g.count]))).toEqual(new Map([
      ['file failed in setup: tests/bundle-splitting.test.ts', 3],
      ['file failed in setup: tests/d.test.ts', 1],
      ['kept note', 1],
      ['no reason given: tests/e.test.ts', 1],
    ]));
  });

  it('writes each progress record at most once per process and prints the skip line on every run end, also at 0', () => {
    const file = path.join(tmp(), 'p.jsonl');
    const lines: string[] = [];
    let clock = Date.parse('2026-10-16T10:34:57.000Z');
    const reporter = new progress.TestLockProgressReporter(
      { file, runStart: false, firstTest: false, runEnd: false, deps: progress.createDepsState('warn') },
      { log: (line) => lines.push(line), now: () => clock },
    );
    reporter.onTestRunStart();
    clock += 3_100;
    reporter.onTestModuleStart();
    reporter.onTestModuleStart(); // a second file
    clock += 9_300;
    reporter.onTestCaseReady();
    reporter.onTestCaseReady();
    reporter.onTestRunEnd([fakeModule(path.join(process.cwd(), 'x.test.ts'), [])]);
    // the measurement lines once each, at the first test file and the first test; the skip line also for 0 skipped, then the deps summary
    expect(lines).toEqual([
      '[test-progress] first test file started after 3.1 s (run start 2026-10-16T10:34:57Z, config default)',
      '[test-progress] first test after 12.4 s (run start 2026-10-16T10:34:57Z, config default)',
      '[test-skips] 0 skipped',
      '[test-deps] 0 mid-run re-optimizations',
    ]);
    lines.length = 0;
    reporter.onTestRunStart(); // a watch rerun
    reporter.onTestModuleStart();
    reporter.onTestCaseReady();
    reporter.onTestRunEnd([fakeModule(path.join(process.cwd(), 'x.test.ts'), ['why'])]);
    expect(lines).toEqual(['[test-skips] 1 skipped: 1 why', '[test-deps] 0 mid-run re-optimizations']);
    expect(wrapper.readProgress(file, 0).records.filter((r) => !['file-start', 'file-end', 'test-end'].includes(r.ev)).map((r) => r.ev)).toEqual(['run-start', 'module-start', 'first-test', 'run-end']);
    // without a progress file nothing is written and nothing throws
    const silent = new progress.TestLockProgressReporter({ file: '', runStart: false, firstTest: false, runEnd: false }, { log: () => {} });
    expect(() => {
      silent.onTestRunStart(); silent.onTestModuleStart(); silent.onTestCaseReady();
      silent.onTestCaseResult(undefined); silent.onTestSuiteResult(null); silent.onTestModuleEnd({}); silent.onTestRunEnd([]);
    }).not.toThrow();
  });

  it('the plugin APPENDS one reporter (configured ones stay), once per config, and scrubs the progress variable', () => {
    const saved = process.env[progress.PROGRESS_ENV];
    try {
      process.env[progress.PROGRESS_ENV] = path.join(tmp(), 'x.jsonl');
      const config = { reporters: [['json', {}] as unknown] };
      const plugin = progress.testLockProgressPlugin();
      plugin.configureVitest({ vitest: { config } });
      plugin.configureVitest({ vitest: { config } }); // second project, same resolved config
      expect(config.reporters).toHaveLength(2);
      expect(config.reporters[0]).toEqual(['json', {}]);
      expect(config.reporters[1]).toBeInstanceOf(progress.TestLockProgressReporter);
      expect(process.env[progress.PROGRESS_ENV]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env[progress.PROGRESS_ENV];
      else process.env[progress.PROGRESS_ENV] = saved;
    }
  });

  it('a real vitest run: run-start / first-test / run-end once each, workers do not see the file, the line goes to stderr, --reporter=json stdout stays JSON', async () => {
    const dir = tmp();
    const file = path.join(dir, 'progress.jsonl');
    const marker = path.join(dir, 'marker.json');
    const r = spawnSync(process.execPath, [VITEST_CLI, 'run', '--config', CONFIG, '--reporter=json'], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnv(0, { RV_TEST_LOCK: 'off', [progress.PROGRESS_ENV]: file, RV_TL_MARKER: marker, [progress.STRICT_DEPS_ENV]: undefined }),
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const records = wrapper.readProgress(file, 0).records;
    expect(records.filter((r) => !['file-start', 'file-end', 'test-end'].includes(r.ev)).map((x) => x.ev)).toEqual(['run-start', 'module-start', 'first-test', 'run-end']);
    expect(new Set(records.map((x) => x.pid)).size).toBe(1);
    expect(r.stderr.match(/\[test-progress\] first test file started after \d+\.\d s \(run start [^)]*vitest\.progress\.config\.mjs\)/g)).toHaveLength(1);
    expect(failLines(r.stderr)).toEqual([]); // a green run prints no failure line
    expect(readJson<{ progressFile: string | null }>(marker)).toEqual({ progressFile: null });
    expect(r.stderr).toContain('[test-skips] 3 skipped: 2 no adapter, 1 no reason given: progress.fixture.test.mjs');
    expect(r.stdout).not.toContain('[test-skips]');
    // the default (fail) with no hit stays green and summarizes: no re-optimization is stated, not implied by silence
    expect(r.stderr).toContain('[test-deps] 0 mid-run re-optimizations');
    expect(r.stdout).not.toContain('[test-deps]');
    expect(r.stderr.match(/\[test-progress\] first test after \d+\.\d s \(run start \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, config [^)]*vitest\.progress\.config\.mjs\)/g)).toHaveLength(1);
    expect(r.stderr).not.toContain('since wrapper start'); // no wrapper → no wrapper part
    const report = JSON.parse(r.stdout) as { numTotalTests: number };
    expect(report.numTotalTests).toBe(4);
  }, 60_000);

  it('a real vitest run under the holding wrapper with a short startup limit finishes normally (the hooks really fire)', async () => {
    const port = await allocPort();
    const w = runWrapper(['vitest', 'run', '--config', CONFIG], cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: '30' }));
    const exit = await w.exited;
    expect(exit.code, w.output()).toBe(0);
    expect(w.output()).not.toContain('no test file started');
    expect(w.output()).toContain('[test-skips] 3 skipped');
    expect(w.output().match(/\[test-progress\] first test after \d+\.\d s \(run start [^)]*\) \/ \d+\.\d s since wrapper start/g)).toHaveLength(1);
    expect(w.output().match(/\[test-progress\] first test file started after \d+\.\d s \(run start [^)]*\) \/ \d+\.\d s since wrapper start/g)).toHaveLength(1);
  }, 60_000);
});

// ─── live failure lines ([test-fail], plan-617) ─────────────────────────────

describe('test progress reporter: failures at once ([test-fail], plan-617)', { timeout: 60_000 }, () => {
  const root = path.join(os.tmpdir(), 'rv-root');
  const file = path.join(root, 'tests', 'foo.test.ts');
  const assertion = {
    name: 'AssertionError',
    message: 'expected 1 to be 2 // Object.is equality',
    stack: 'AssertionError: expected 1 to be 2 // Object.is equality\n    at tests/foo.test.ts:12:5',
    stacks: [{ file, line: 12, column: 5, method: '' }],
  };
  /** vitest 4 shapes: TestCase (`result()`), TestSuite / TestModule (`errors()`). */
  const fakeCase = (id: string, fullName: string, state: string, errors?: unknown[], moduleId = file) =>
    ({ id, type: 'test', fullName, module: { moduleId }, result: () => ({ state, errors }) });
  const fakeSuite = (id: string, fullName: string, errors: unknown[], moduleId = file) =>
    ({ id, type: 'suite', name: fullName.split(' > ').pop(), fullName, module: { moduleId }, errors: () => errors });
  const fakeFile = (id: string, errors: unknown[], moduleId = file) => ({ id, type: 'module', moduleId, errors: () => errors });
  const capture = () => {
    const lines: string[] = [];
    const state: ProgressState = { file: '', runStart: false, firstTest: false, runEnd: false, deps: progress.createDepsState('warn') };
    const reporter = new progress.TestLockProgressReporter(state, { write: () => {}, log: (l) => lines.push(l), failRun: () => {} });
    (reporter as unknown as { root: string }).root = root; // what onInit takes from vitest.config.root
    return { lines, state, reporter };
  };

  it('formatFailLine: one line, file and stack relative to the root, message cut at 300 characters, stack fallbacks', () => {
    expect(progress.formatFailLine({ file, label: 'Foo > does x', error: assertion, root }))
      .toBe('[test-fail] tests/foo.test.ts :: Foo > does x — expected 1 to be 2 // Object.is equality @ tests/foo.test.ts:12:5');
    // multi-line message → one line
    const multi = progress.formatFailLine({ file, label: 'a', error: { message: 'first\n  second\r\n\tthird', stacks: [] }, root });
    expect(multi).toBe('[test-fail] tests/foo.test.ts :: a — first second third @ no stack');
    expect(multi).not.toMatch(/[\r\n]/);
    // a long message is cut: the message part has exactly FAIL_MESSAGE_MAX characters, ending in …
    const long = progress.failMessage({ message: 'x'.repeat(1000) });
    expect(progress.FAIL_MESSAGE_MAX).toBe(300);
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
    expect(progress.failMessage({ message: 'y'.repeat(300) })).toBe('y'.repeat(300)); // exactly at the limit: unchanged
    // no parsed stacks → the first `at …` line of error.stack; nothing at all → `no stack`
    expect(progress.failStackLine({ message: 'm', stack: 'Error: m\n    at fn (C:/a/b.ts:3:4)\n    at other (x:1:1)' }, root)).toBe('fn (C:/a/b.ts:3:4)');
    expect(progress.failStackLine({ message: 'm' }, root)).toBe('no stack');
    expect(progress.failStackLine(undefined, root)).toBe('no stack');
    // primitives and missing errors never throw
    expect(progress.formatFailLine({ file, label: 'p', error: 'boom', root })).toBe('[test-fail] tests/foo.test.ts :: p — boom @ no stack');
    expect(progress.formatFailLine({ file, label: 'u', error: undefined, root })).toBe('[test-fail] tests/foo.test.ts :: u — (no message) @ no stack');
    expect(progress.failMessage({ name: 'TypeError', message: '' })).toBe('TypeError');
  });

  it('prints a failed test, an own suite error and an own module error once each; passed / skipped / error-free entities print nothing', () => {
    const { lines, reporter } = capture();
    reporter.onTestRunStart();
    reporter.onTestCaseResult(fakeCase('t1', 'Foo > does x', 'failed', [assertion]));
    reporter.onTestCaseResult(fakeCase('t1', 'Foo > does x', 'failed', [assertion])); // the same entity again
    reporter.onTestCaseResult(fakeCase('t2', 'Foo > passes', 'passed', []));
    reporter.onTestCaseResult(fakeCase('t3', 'Foo > skipped', 'skipped'));
    reporter.onTestSuiteResult(fakeSuite('s1', 'Foo', [])); // the child's failure is not the suite's own error
    reporter.onTestSuiteResult(fakeSuite('s2', 'Bar', [{ message: 'AFTERALL', stacks: [{ file, line: 30, column: 3 }] }]));
    reporter.onTestSuiteResult(fakeSuite('s3', 'Baz', [assertion])); // an error object already printed → not again
    reporter.onTestModuleEnd(fakeFile('m1', [{ message: 'IMPORT', stack: 'Error: IMPORT\n    at tests/foo.test.ts:1:7' }]));
    reporter.onTestModuleEnd(fakeFile('m2', []));
    expect(lines).toEqual([
      '[test-fail] tests/foo.test.ts :: Foo > does x — expected 1 to be 2 // Object.is equality @ tests/foo.test.ts:12:5',
      '[test-fail] tests/foo.test.ts :: (suite Bar) — AFTERALL @ tests/foo.test.ts:30:3',
      '[test-fail] tests/foo.test.ts :: (module) — IMPORT @ tests/foo.test.ts:1:7',
    ]);
    // a throwing entity is swallowed (a convenience, never a failure)
    expect(() => reporter.onTestCaseResult({ result: () => { throw new Error('x'); } })).not.toThrow();
  });

  it('fail limit: 50 lines live, the notice AT the 51st, the remaining count at the regular run end', () => {
    const { lines, reporter } = capture();
    reporter.onTestRunStart();
    for (let i = 1; i <= 50; i++) reporter.onTestCaseResult(fakeCase(`t${i}`, `case ${i}`, 'failed', [{ message: `fail ${i}` }]));
    expect(lines).toHaveLength(50);
    expect(lines.every((l) => l.startsWith('[test-fail] tests/foo.test.ts :: case '))).toBe(true);
    reporter.onTestCaseResult(fakeCase('t51', 'case 51', 'failed', [{ message: 'fail 51' }]));
    expect(lines).toHaveLength(51); // printed at once, not at the end
    expect(lines[50]).toBe(progress.FAIL_LIMIT_LINE);
    expect(progress.FAIL_LIMIT_LINE).toBe('[test-fail] limit of 50 reached — further failures only in the vitest summary');
    reporter.onTestSuiteResult(fakeSuite('s52', 'S', [{ message: 'fail 52' }]));
    reporter.onTestModuleEnd(fakeFile('m53', [{ message: 'fail 53' }]));
    expect(lines).toHaveLength(51); // counted only
    reporter.onTestRunEnd([]);
    expect(lines[51]).toBe('[test-fail] 3 further failures not shown live (limit 50) — see the vitest summary');
    expect(lines[52]).toBe('[test-skips] 0 skipped');
    expect(progress.formatFailRemainderLine(0)).toBe('');
    expect(progress.formatFailRemainderLine(1)).toBe('[test-fail] 1 further failure not shown live (limit 50) — see the vitest summary');
  });

  it('watch-like: the counters are per RUN — a second run in the same process prints live again and ends with its own count', () => {
    const { lines, state, reporter } = capture();
    reporter.onTestRunStart();
    for (let i = 1; i <= 52; i++) reporter.onTestCaseResult(fakeCase(`t${i}`, `case ${i}`, 'failed', [{ message: `fail ${i}` }]));
    reporter.onTestRunEnd([]);
    expect(lines).toContain('[test-fail] 2 further failures not shown live (limit 50) — see the vitest summary');
    lines.length = 0;
    reporter.onTestRunStart(); // the rerun: once-guards hold (no second run-start), the fail counters do not
    expect(state.fails?.shown).toBe(0);
    reporter.onTestCaseResult(fakeCase('t1', 'case 1', 'failed', [{ message: 'fail again' }])); // the same entity as in run 1
    expect(lines).toEqual(['[test-fail] tests/foo.test.ts :: case 1 — fail again @ no stack']);
    reporter.onTestRunEnd([]);
    expect(lines.filter((l) => l.includes('further failure'))).toEqual([]);
  });

  it('real fixture run (node, no wrapper): [test-fail] lines before the run end, retries only by their final result, --reporter=json stdout still parses', () => {
    const r = spawnSync(process.execPath, [VITEST_CLI, 'run', '--config', FAILING_CONFIG, '--reporter=json', 'failing.fixture'], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnv(0, { RV_TEST_LOCK: 'off', [progress.STRICT_DEPS_ENV]: undefined }),
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    const report = JSON.parse(r.stdout) as { numTotalTests: number; numFailedTests: number; numPassedTests: number };
    expect(report).toMatchObject({ numTotalTests: 4, numFailedTests: 2, numPassedTests: 2 });
    expect(r.stdout).not.toContain('[test-fail]');
    const fails = failLines(r.stderr);
    expect(fails, r.stderr).toHaveLength(2);
    expect(fails[0]).toMatch(/^\[test-fail\] failing\.fixture\.test\.mjs :: fails with PROBE — PROBE value: expected 1 to be 2 \/\/ Object\.is equality @ failing\.fixture\.test\.mjs:\d+:\d+$/);
    expect(fails.filter((l) => l.includes(':: fails on every attempt — EXHAUSTED attempt'))).toHaveLength(1); // retries exhausted → one line
    expect(r.stderr).not.toContain('FLAKY'); // red first, green on retry → no line
    // live: every failure line comes before the run-end lines
    const lastFail = r.stderr.lastIndexOf('[test-fail]');
    expect(lastFail).toBeGreaterThanOrEqual(0);
    expect(lastFail).toBeLessThan(r.stderr.indexOf('[test-skips]'));
  }, 60_000);

  it('real fixture run (node): an import error → one "(module)" line; a beforeAll error → one "(suite …)" line; test + afterAll of one suite → both, once each', () => {
    const r = spawnSync(process.execPath, [VITEST_CLI, 'run', '--config', FAILING_CONFIG, '--reporter=json', 'import-error.fixture', 'before-all-error.fixture'], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnv(0, { RV_TEST_LOCK: 'off', [progress.STRICT_DEPS_ENV]: undefined }),
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    JSON.parse(r.stdout); // stdout stays JSON
    const fails = failLines(r.stderr);
    const count = (part: string) => fails.filter((l) => l.includes(part)).length;
    expect(count('[test-fail] import-error.fixture.test.mjs :: (module) — IMPORT PROBE: the module failed to load @ '), r.stderr).toBe(1);
    expect(count('[test-fail] before-all-error.fixture.test.mjs :: (suite setup fails) — BEFOREALL PROBE @ ')).toBe(1);
    expect(count('[test-fail] before-all-error.fixture.test.mjs :: test and afterAll fail > fails itself — TEST PROBE @ ')).toBe(1);
    expect(count('[test-fail] before-all-error.fixture.test.mjs :: (suite test and afterAll fail) — AFTERALL PROBE @ ')).toBe(1);
    expect(count('before-all-error.fixture.test.mjs :: (module)')).toBe(0); // the module has no error of its own
    expect(count('is skipped')).toBe(0); // tests skipped by the failing beforeAll are no failures
    expect(fails, r.stderr).toHaveLength(4); // nothing printed twice, nothing else
  }, 60_000);
});

// ─── startup signal + abort with real vitest under the wrapper (plan-617) ───

describe('with-test-lock + real vitest (plan-617): module-start closes the window, causes survive an abort', { timeout: 120_000 }, () => {
  const LIMIT = '5';

  async function slowStart(mode: 'sync' | 'before-all') {
    const port = await allocPort();
    const w = runWrapper(['vitest', 'run', '--config', FAILING_CONFIG, 'slow-start.fixture'],
      cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: LIMIT, RV_TL_SLOW_START: mode, RV_TL_SLOW_MS: '9000' }));
    const exit = await w.exited;
    return { w, exit };
  }

  for (const mode of ['sync', 'before-all'] as const) {
    it(`a first test event later than the startup limit (${mode === 'sync' ? 'synchronous 9 s first test' : '9 s beforeAll before a quick test'}) is NOT ended — module-start closed the window`, async () => {
      const { w, exit } = await slowStart(mode);
      expect(exit.code, w.output()).toBe(0);
      expect(w.output()).not.toContain('no test file started');
      const fileStarted = sinceWrapper(w.output(), '[test-progress] first test file started after');
      const firstTest = sinceWrapper(w.output(), '[test-progress] first test after');
      expect(fileStarted, w.output()).toBeLessThan(Number(LIMIT));
      // the precondition that makes this a regression: the OLD signal (first-test) arrived after the limit
      expect(firstTest, w.output()).toBeGreaterThan(Number(LIMIT));
    }, 120_000);
  }

  it('COUNTER-CHECK: a globalSetup that never resolves (no module event) → exit 125; the progress file has run-start but no module-start / first-test / run-end', async () => {
    const port = await allocPort();
    const marker = path.join(tmp(), 'setup.json');
    const w = runWrapper(['vitest', 'run', '--config', FAILING_CONFIG, 'failing.fixture'],
      cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: '4', RV_TL_NEVER_SETUP: '1', RV_TL_MARKER: marker }));
    const progressOf = watchWrapperProgress(w);
    const exit = await w.exited;
    expect(exit.code, w.output()).toBe(125);
    expect(w.output()).toMatch(/\[test-lock\] no test file started within RV_TEST_STARTUP_TIMEOUT_SECONDS=4 \(waited \d+\.\d s since /);
    expect(readJson<{ pid: number }>(marker), 'the globalSetup was entered').not.toBeNull();
    const evs = progressOf.records().map((r) => r.ev);
    expect(evs, w.output()).toContain('run-start'); // onTestRunStart fires before globalSetup
    expect(evs).not.toContain('module-start');
    expect(evs).not.toContain('first-test');
    expect(evs).not.toContain('run-end');
    expect(failLines(w.output())).toEqual([]);
    expect((await lock.probeLock({ port })).state).toBe('free');
  }, 60_000);

  it('NON-EMPTINESS: a run killed before its end keeps the [test-fail] cause that had already arrived', async () => {
    const port = await allocPort();
    // the failing file runs in parallel with a file that never ends (forks, fileParallelism, maxWorkers 2)
    const w = runWrapper(['vitest', 'run', '--config', FAILING_CONFIG, 'failing.fixture', 'hang.fixture'],
      cleanEnv(port, { RV_TEST_STARTUP_TIMEOUT_SECONDS: '60' }));
    const progressOf = watchWrapperProgress(w);
    const probe = await waitFor('the [test-fail] PROBE line', () => failLines(w.output()).find((l) => l.includes(':: fails with PROBE —')), 60_000);
    const before = progressOf.records().map((r) => r.ev);
    expect(before).toContain('module-start');
    expect(before).not.toContain('run-end'); // the run is still going: the line came live, not from the end
    expect(w.output()).not.toContain('[test-skips]');
    killTree(w.pid); // the hard abort (a console close / taskkill of the wrapper tree)
    const exit = await w.exited;
    expect(exit.code).not.toBe(0);
    expect(w.output()).not.toContain('[test-skips]'); // never reached its end
    expect(w.output()).toContain(probe);
    // message AND stack part, not only the presence of the line
    expect(probe).toMatch(/^\[test-fail\] failing\.fixture\.test\.mjs :: fails with PROBE — PROBE value: expected 1 to be 2 \/\/ Object\.is equality @ failing\.fixture\.test\.mjs:\d+:\d+$/);
  }, 90_000);
});

// ─── gpu config: the progress reporter is registered exactly once ───────────

describe('gpu config: testLockProgressPlugin next to GpuRunReporter (plan-617)', () => {
  it('vite.config.ts registers the plugin once, vitest.gpu.config.ts inherits it and adds only the GPU reporter; together they append one reporter each', async () => {
    const viteConfig = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    const gpuConfig = fs.readFileSync(path.join(ROOT, 'vitest.gpu.config.ts'), 'utf8');
    expect(viteConfig.match(/testLockProgressPlugin\s*\(\s*\)/g)).toHaveLength(1);
    expect(gpuConfig.match(/testLockProgressPlugin\s*\(/g)).toBeNull(); // not registered a second time
    expect(gpuConfig).toMatch(/plugins:\s*\[\.\.\.\(base\.plugins \?\? \[\]\), gpuRunReporterPlugin\(\)\]/);

    const gpu = (await import(pathToFileURL(path.join(SCRIPTS_DIR, 'test-gpu-run.mjs')).href)) as {
      gpuRunReporterPlugin(): { configureVitest(ctx: { vitest: { config: { reporters: unknown[] } } }): void };
      GpuRunReporter: new () => unknown;
    };
    const saved = { p: process.env[progress.PROGRESS_ENV], w: process.env[progress.WRAPPER_SPAWN_ENV] };
    try {
      const config = { reporters: ['default' as unknown] };
      const plugins = [progress.testLockProgressPlugin(), gpu.gpuRunReporterPlugin()]; // the gpu config's plugin list
      for (let pass = 0; pass < 2; pass++) for (const p of plugins) p.configureVitest({ vitest: { config } }); // a second project
      expect(config.reporters.filter((r) => r instanceof progress.TestLockProgressReporter)).toHaveLength(1);
      expect(config.reporters.filter((r) => r instanceof gpu.GpuRunReporter)).toHaveLength(1);
      expect(config.reporters[0]).toBe('default');
    } finally {
      if (saved.p === undefined) delete process.env[progress.PROGRESS_ENV]; else process.env[progress.PROGRESS_ENV] = saved.p;
      if (saved.w === undefined) delete process.env[progress.WRAPPER_SPAWN_ENV]; else process.env[progress.WRAPPER_SPAWN_ENV] = saved.w;
    }
  });
});

// ─── strict optimizeDeps ([test-deps]) ──────────────────────────────────────

describe('strict optimizeDeps: mid-run dependency re-optimization ([test-deps] line, RV_TEST_STRICT_DEPS)', { timeout: 60_000 }, () => {
  const CONFIG = path.join(FIX, 'vitest.deps.config.mjs');
  const RELOAD_LINE = '[test-deps] undeclared dependency discovered mid-run: fixture-dep-reloaded — add it to optimizeDeps.include in vite.config.ts (the reload made this run unusable)';

  const freshState = (mode: StrictDepsMode = 'warn'): ProgressState =>
    ({ file: '', runStart: false, firstTest: false, runEnd: false, deps: progress.createDepsState(mode) });

  /** A fake vite environment shaped like vite 6's: a discovering deps optimizer + a hot channel. */
  const fakeEnvironment = (options: Record<string, unknown> = {}) => {
    const sent: unknown[] = [];
    const registered: string[] = [];
    const metadata = {
      optimized: { three: {} } as Record<string, unknown>,
      chunks: {} as Record<string, unknown>,
      discovered: {} as Record<string, unknown>,
    };
    const env = {
      depsOptimizer: {
        options,
        metadata,
        registerMissingImport(id: string): unknown {
          registered.push(id);
          metadata.discovered[id] ??= { id };
          return metadata.discovered[id];
        },
      },
      hot: { send(payload: unknown): void { sent.push(payload); } },
    };
    return { env, sent, registered };
  };

  it('parses the mode: unset → the default (fail), fail / warn / off, case and blanks tolerated, garbage → the default', () => {
    expect(progress.STRICT_DEPS_ENV).toBe('RV_TEST_STRICT_DEPS');
    // fail since the discovery run of 2026-10-16 completed optimizeDeps.include
    expect(progress.DEFAULT_STRICT_DEPS_MODE).toBe('fail');
    expect(progress.strictDepsMode({})).toBe(progress.DEFAULT_STRICT_DEPS_MODE);
    expect(progress.strictDepsMode({ RV_TEST_STRICT_DEPS: '' })).toBe(progress.DEFAULT_STRICT_DEPS_MODE);
    expect(progress.strictDepsMode({ RV_TEST_STRICT_DEPS: 'fail' })).toBe('fail');
    expect(progress.strictDepsMode({ RV_TEST_STRICT_DEPS: 'warn' })).toBe('warn');
    expect(progress.strictDepsMode({ RV_TEST_STRICT_DEPS: 'off' })).toBe('off');
    expect(progress.strictDepsMode({ RV_TEST_STRICT_DEPS: ' FAIL ' })).toBe('fail');
    expect(progress.strictDepsMode({ RV_TEST_STRICT_DEPS: 'yes' })).toBe(progress.DEFAULT_STRICT_DEPS_MODE);
    expect(progress.strictDepsMode({ RV_TEST_STRICT_DEPS: '1' })).toBe(progress.DEFAULT_STRICT_DEPS_MODE);
  });

  it('formats the hit line and the summary (0 is stated, not left out)', () => {
    expect(progress.formatDepsHitLine(['three/addons/controls/PointerLockControls.js']))
      .toBe('[test-deps] undeclared dependency discovered mid-run: three/addons/controls/PointerLockControls.js — add it to optimizeDeps.include in vite.config.ts (the reload made this run unusable)');
    expect(progress.formatDepsHitLine(['a', 'b'])).toContain('mid-run: a, b — add them to optimizeDeps.include');
    expect(progress.formatDepsHitLine(['a'], { reloaded: false })).toContain('(re-optimized without a reload this time');
    expect(progress.formatDepsSummary([])).toBe('[test-deps] 0 mid-run re-optimizations');
    expect(progress.formatDepsSummary([{ dep: 'a', reloaded: true }])).toBe('[test-deps] 1 mid-run re-optimization: a (reloaded)');
    expect(progress.formatDepsSummary([{ dep: 'a', reloaded: true }, { dep: 'b', reloaded: false }]))
      .toBe('[test-deps] 2 mid-run re-optimizations: a (reloaded), b');
  });

  it('BEFORE the first test a discovery and its reload never count: no line, no failure — even in fail mode', () => {
    const state = freshState('fail');
    expect(progress.noteDepDiscovered('cold-dep', state)).toBe(false);
    expect(progress.noteDepReload(state)).toBe(''); // "optimized dependencies changed. reloading" before any test
    state.firstTest = true;
    expect(progress.depsRunEnd(state)).toEqual({ lines: ['[test-deps] 0 mid-run re-optimizations'], fail: false });
  });

  it('AFTER the first test a discovery + reload is a hit: the line at the reload, the summary at run end, red only in fail mode', () => {
    for (const mode of ['warn', 'fail'] as const) {
      const state = freshState(mode);
      state.firstTest = true;
      expect(progress.noteDepDiscovered('fixture-dep-reloaded', state)).toBe(true);
      expect(progress.noteDepReload(state)).toBe(RELOAD_LINE);
      expect(progress.depsRunEnd(state)).toEqual({ lines: ['[test-deps] 1 mid-run re-optimization: fixture-dep-reloaded (reloaded)'], fail: mode === 'fail' });
      // cleared at run end: a watch rerun reports its own
      expect(progress.depsRunEnd(state)).toEqual({ lines: ['[test-deps] 0 mid-run re-optimizations'], fail: false });
    }
  });

  it('a discovery before the first test whose reload lands AFTER it is a hit (the reload hits a running test)', () => {
    const state = freshState('fail');
    progress.noteDepDiscovered('late-dep', state);
    state.firstTest = true;
    expect(progress.noteDepReload(state)).toContain('mid-run: late-dep — add it');
    expect(progress.depsRunEnd(state).fail).toBe(true);
  });

  it('a discovery after the first test without a reload is named at run end; a reload with nothing pending is not ours', () => {
    const state = freshState('fail');
    state.firstTest = true;
    expect(progress.noteDepReload(state)).toBe(''); // nothing pending → some other full reload
    progress.noteDepDiscovered('quiet-dep', state);
    progress.noteDepDiscovered('quiet-dep', state); // counted once
    const end = progress.depsRunEnd(state);
    expect(end.lines).toEqual([
      progress.formatDepsHitLine(['quiet-dep'], { reloaded: false }),
      '[test-deps] 1 mid-run re-optimization: quiet-dep',
    ]);
    expect(end.fail).toBe(true);
  });

  it('mode off: nothing printed, nothing fails', () => {
    const state = freshState('off');
    state.firstTest = true;
    progress.noteDepDiscovered('x', state);
    expect(progress.noteDepReload(state)).toBe('');
    expect(progress.depsRunEnd(state)).toEqual({ lines: [], fail: false });
  });

  it('the reporter fails the run in fail mode only, after the skip line and the deps lines', () => {
    for (const mode of ['fail', 'warn', 'off'] as const) {
      const lines: string[] = [];
      let failed = 0;
      const state = freshState(mode);
      const reporter = new progress.TestLockProgressReporter(state, { write: () => {}, log: (l) => lines.push(l), failRun: () => { failed++; } });
      reporter.onTestRunStart();
      reporter.onTestCaseReady();
      progress.noteDepDiscovered('mid-dep', state);
      reporter.onTestRunEnd([]);
      expect(failed, mode).toBe(mode === 'fail' ? 1 : 0);
      const rest = lines.filter((l) => !l.startsWith('[test-progress]'));
      expect(rest[0], mode).toBe('[test-skips] 0 skipped');
      expect(rest.slice(1), mode).toEqual(mode === 'off'
        ? []
        : [progress.formatDepsHitLine(['mid-dep'], { reloaded: false }), '[test-deps] 1 mid-run re-optimization: mid-dep']);
    }
  });

  it('watchDepsOptimizer wraps registerMissingImport + hot.send once, calls straight through, counts only NEW ids, leaves noDiscovery optimizers alone', () => {
    const state = freshState('warn');
    const lines: string[] = [];
    const client = fakeEnvironment();
    const ssr = fakeEnvironment({ noDiscovery: true });
    const server = { environments: { client: client.env, ssr: ssr.env, none: {} } };
    const ssrRegister = ssr.env.depsOptimizer.registerMissingImport;
    expect(progress.watchDepsOptimizer(server, { state, log: (l) => lines.push(l) })).toBe(1);
    expect(progress.watchDepsOptimizer(server, { state, log: (l) => lines.push(l) })).toBe(0); // a second plugin copy
    expect(ssr.env.depsOptimizer.registerMissingImport).toBe(ssrRegister);

    client.env.depsOptimizer.registerMissingImport('three'); // already optimized → no discovery
    client.env.depsOptimizer.registerMissingImport('before-dep'); // before the first test
    client.env.hot.send({ type: 'full-reload', path: '*' });
    expect(lines).toEqual([]);
    state.firstTest = true;
    client.env.hot.send({ type: 'update', updates: [] }); // not a reload
    const info = client.env.depsOptimizer.registerMissingImport('fixture-dep-reloaded');
    client.env.depsOptimizer.registerMissingImport('fixture-dep-reloaded'); // discovered already → not new
    client.env.hot.send({ type: 'full-reload', path: '*' });
    expect(info).toEqual({ id: 'fixture-dep-reloaded' }); // the original's return value comes through
    expect(client.registered).toEqual(['three', 'before-dep', 'fixture-dep-reloaded', 'fixture-dep-reloaded']);
    expect(client.sent).toHaveLength(3); // every payload still reaches the channel
    expect(lines).toEqual([RELOAD_LINE]);
    expect(progress.depsRunEnd(state)).toEqual({ lines: ['[test-deps] 1 mid-run re-optimization: fixture-dep-reloaded (reloaded)'], fail: false });
  });

  it('the plugin watches the optimizer only under vitest (no dev-server effect)', () => {
    const saved = process.env.VITEST;
    try {
      const outside = fakeEnvironment();
      const original = outside.env.depsOptimizer.registerMissingImport;
      delete process.env.VITEST;
      progress.testLockProgressPlugin().configureServer({ environments: { client: outside.env } });
      expect(outside.env.depsOptimizer.registerMissingImport).toBe(original);
      process.env.VITEST = 'true';
      progress.testLockProgressPlugin().configureServer({ environments: { client: outside.env } });
      expect(outside.env.depsOptimizer.registerMissingImport).not.toBe(original);
    } finally {
      if (saved === undefined) delete process.env.VITEST;
      else process.env.VITEST = saved;
    }
  });

  it('a real vitest run with a mid-run discovery: RV_TEST_STRICT_DEPS=fail exits non-zero although every test passed; off stays green and silent', () => {
    const run = (mode: string) => spawnSync(process.execPath, [VITEST_CLI, 'run', '--config', CONFIG, '--reporter=json'], {
      cwd: ROOT, encoding: 'utf8', env: cleanEnv(0, { RV_TEST_LOCK: 'off', [progress.STRICT_DEPS_ENV]: mode }),
    });
    const fail = run('fail');
    const report = JSON.parse(fail.stdout) as { numTotalTests: number; numPassedTests: number; numFailedTests: number };
    expect(report, fail.stderr).toMatchObject({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0 });
    expect(fail.status, `${fail.stdout}${fail.stderr}`).not.toBe(0);
    expect(fail.stderr).toContain(RELOAD_LINE);
    expect(fail.stderr).toContain(progress.formatDepsHitLine(['fixture-dep-quiet'], { reloaded: false }));
    expect(fail.stderr).toContain('[test-deps] 2 mid-run re-optimizations: fixture-dep-reloaded (reloaded), fixture-dep-quiet');
    expect(fail.stderr).not.toContain('fixture-dep-before'); // before the first test: legitimate
    expect(fail.stderr).toContain('[test-skips] 0 skipped');

    const off = run('off');
    expect(off.status, `${off.stdout}${off.stderr}`).toBe(0);
    expect(off.stderr).not.toContain('[test-deps]');
    expect(off.stderr).toContain('[test-skips] 0 skipped');
  }, 60_000);
});

// ─── watchdog ───────────────────────────────────────────────────────────────

describe('test-lock watchdog (F10)', { timeout: 60_000 }, () => {
  const idle = ['-e', 'setTimeout(() => {}, 60000)'];

  it('ends a Node process within its interval once the owner is gone; a process without it keeps running', async () => {
    const owner = startNode(idle, cleanEnv(1));
    const watchedEnv = cleanEnv(1, {
      RV_TEST_LOCK_PARENT_PID: String(owner.pid),
      RV_TEST_LOCK_WATCHDOG_MS: '200',
      NODE_OPTIONS: wrapper.nodeOptionsRequire(WATCHDOG),
    });
    const watched = startNode(idle, watchedEnv);
    const control = startNode(idle, { ...watchedEnv, NODE_OPTIONS: '' }); // NEGATIVE CONTROL: same env, no watchdog
    await waitFor('both running', () => lock.isProcessAlive(watched.pid) && lock.isProcessAlive(control.pid));
    hardKill(owner.pid);
    await owner.exited;
    const killedAt = Date.now();
    const end = await watched.exited;
    expect(end.code).toBe(1);
    expect(end.at - killedAt).toBeLessThan(3000);
    expect(watched.output()).toContain(`wrapper PID ${owner.pid} is gone`);
    expect(lock.isProcessAlive(control.pid)).toBe(true);
  });

  it('checks at load: a process started after the owner died ends at once', async () => {
    const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    const deadPid = Number(gone.stdout.trim());
    const r = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      env: cleanEnv(1, {
        RV_TEST_LOCK_PARENT_PID: String(deadPid),
        RV_TEST_LOCK_WATCHDOG_MS: '60000', // the interval cannot be what ends it
        NODE_OPTIONS: wrapper.nodeOptionsRequire(WATCHDOG),
      }),
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`wrapper PID ${deadPid} is gone`);
  });
});

// ─── root guard ─────────────────────────────────────────────────────────────

describe('global-lock-guard (F3)', { timeout: 60_000 }, () => {
  const CONFIG = path.join(FIX, 'vitest.guard.config.mjs');

  it('under the wrapper the guard does not bind again', async () => {
    const port = await allocPort();
    const marker = path.join(tmp(), 'marker.json');
    const w = runWrapper(['vitest', 'run', '--config', CONFIG], cleanEnv(port, { RV_TL_MARKER: marker, RV_TEST_LOCK_TIMEOUT_SECONDS: '2' }));
    expect((await w.exited).code, w.output()).toBe(0);
    const seen = readJson<{ probe: Probe; held: string }>(marker)!;
    expect(seen.probe.holder?.pid).toBe(w.pid);
    expect(seen.held).toBe(String(w.pid));
    expect(w.output()).not.toContain('guard acquired');
  }, 60_000);

  it('NEGATIVE CONTROL: a guard that binds while the lock is held is detected (the run refuses)', async () => {
    const port = await allocPort();
    const holder = await startHolder('lock', port);
    const marker = path.join(tmp(), 'marker.json');
    const v = startNode([VITEST_CLI, 'run', '--config', CONFIG], cleanEnv(port, { RV_TL_MARKER: marker, RV_TEST_LOCK_TIMEOUT_SECONDS: '1', RV_TEST_LOCK_POLL_SECONDS: '0.2' }));
    expect((await v.exited).code).not.toBe(0);
    expect(v.output()).toContain('gave up');
    expect(fs.existsSync(marker)).toBe(false);
    await holder.release();
  }, 60_000);

  it('a direct vitest run: the guard binds once, for the vitest process, and releases at the end', async () => {
    const port = await allocPort();
    const marker = path.join(tmp(), 'marker.json');
    const v = startNode([VITEST_CLI, 'run', '--config', CONFIG], cleanEnv(port, { RV_TL_MARKER: marker }));
    expect((await v.exited).code, v.output()).toBe(0);
    const seen = readJson<{ probe: Probe; held: string }>(marker)!;
    expect(seen.probe.holder?.pid).toBe(v.pid);
    expect(seen.probe.holder?.argv[0]).toBe('vitest');
    expect(v.output().match(/guard acquired/g)).toHaveLength(1);
    expect((await lock.probeLock({ port })).state).toBe('free');
  }, 60_000);

  // 2026-10-27: a hung direct `npx vitest run` (PID 7388) held the lock for six hours — the guard
  // had no limit at all. It now enforces the wrapper's maximum run time itself.
  it('a hung direct vitest run past RV_TEST_MAX_RUNTIME_MINUTES ends itself: exit 124, the line, the lock free', async () => {
    const port = await allocPort();
    const v = startNode([VITEST_CLI, 'run', '--config', CONFIG], cleanEnv(port, { RV_TL_INCLUDE: 'hang.fixture.test.mjs', RV_TEST_MAX_RUNTIME_MINUTES: '0.05' }));
    await waitFor('guard acquired', () => v.output().includes('guard acquired'), 40_000);
    const acquiredAt = Date.now();
    expect((await lock.describeHolder({ port }))?.pid).toBe(v.pid);
    const exit = await v.exited;
    expect(exit.code, v.output()).toBe(124);
    expect(exit.at - acquiredAt).toBeLessThan(15_000);
    expect(v.output()).toMatch(/\[test-lock\] run exceeded RV_TEST_MAX_RUNTIME_MINUTES=0\.05 \(started \d{4}-\d\d-\d\dT[^)]*, argv vitest run --config [^)]*\) — ending this vitest process and releasing the lock/);
    expect(v.output()).toContain('[test-lock] FAILED (exit 124): run exceeded RV_TEST_MAX_RUNTIME_MINUTES=0.05');
    expect((await lock.probeLock({ port })).state).toBe('free');
  }, 60_000);

  it('NEGATIVE CONTROL: with 0 (disabled) the same hung direct run is NOT ended within 6 s and keeps the lock', async () => {
    const port = await allocPort();
    const v = startNode([VITEST_CLI, 'run', '--config', CONFIG], cleanEnv(port, { RV_TL_INCLUDE: 'hang.fixture.test.mjs', RV_TEST_MAX_RUNTIME_MINUTES: '0' }));
    await waitFor('guard acquired', () => v.output().includes('guard acquired'), 40_000);
    expect(await within(v.exited, 6000)).toBe('pending');
    expect((await lock.describeHolder({ port }))?.pid).toBe(v.pid);
    expect(v.output()).not.toContain('run exceeded');
  }, 60_000);
});

// ─── root guard: second call in the same process (browser mode) ─────────────

type GuardSetup = () => Promise<void | (() => Promise<void>)>;
const GUARD_ENV_KEYS = ['RV_TEST_LOCK', 'RV_TEST_LOCK_PORT', 'RV_TEST_LOCK_HELD', 'RV_TEST_LOCK_PARENT_PID', 'RV_TEST_LOCK_TIMEOUT_SECONDS', 'RV_TEST_LOCK_POLL_SECONDS'];

/** Settles within `ms`? → the value, else the marker 'pending' (the promise keeps running). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); });
  return Promise.race([promise, pending]).finally(() => clearTimeout(timer));
}

describe('global-lock-guard: same-process re-entry (F3, browser mode)', { timeout: 60_000 }, () => {
  const saved: Record<string, string | undefined> = {};

  /** Runs `body` with this process's lock env pointed at `port` and no holder named. */
  async function withGuardEnv(port: number, body: () => Promise<void>): Promise<void> {
    for (const key of GUARD_ENV_KEYS) saved[key] = process.env[key];
    for (const key of GUARD_ENV_KEYS) delete process.env[key];
    process.env.RV_TEST_LOCK_PORT = String(port);
    process.env.RV_TEST_LOCK_TIMEOUT_SECONDS = '30';
    process.env.RV_TEST_LOCK_POLL_SECONDS = '0.2';
    try {
      await body();
    } finally {
      for (const key of GUARD_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  const loadGuard = async (file: string) => (await import(pathToFileURL(file).href)).default as GuardSetup;

  it('a second call in the same process returns at once without a teardown; one holder; the first teardown frees the port', async () => {
    const port = await allocPort();
    const setup = await loadGuard(path.join(ROOT, 'tests', 'global-lock-guard.ts'));
    await withGuardEnv(port, async () => {
      const first = await setup();
      expect(typeof first).toBe('function');
      expect(process.env.RV_TEST_LOCK_HELD).toBe(String(process.pid));
      const second = await within(setup(), 2_000);
      expect(second).toBeUndefined();
      expect((await lock.describeHolder({ port }))?.pid).toBe(process.pid);
      // Async, not statusCli(): spawnSync would block the event loop that serves the lock.
      const status = startNode([STATUS, 'status'], cleanEnv(port));
      expect((await status.exited).code).toBe(1);
      expect(status.output().match(/HELD by PID (\d+)/g)).toEqual([`HELD by PID ${process.pid}`]);
      await (first as () => Promise<void>)();
      expect((await lock.probeLock({ port })).state).toBe('free');
      expect(await canBind(port, '127.0.0.1')).toBe(true);
    });
  });

  it('NEGATIVE CONTROL: the old decision (fall through to acquire) does not return undefined — it runs into its own lock', async () => {
    const port = await allocPort();
    const setup = await loadGuard(path.join(FIX, 'guard-old-reentry.mjs'));
    await withGuardEnv(port, async () => {
      const first = (await setup()) as () => Promise<void>;
      // acquire() now refuses its own holder at once (before, it waited out the deadline).
      const second = await within(setup().then(() => 'returned', (e: Error) => e.message), 2_000);
      expect(second).toContain(`the lock is held by THIS process (PID ${process.pid})`);
      expect((await lock.describeHolder({ port }))?.pid).toBe(process.pid);
      await first();
      expect((await lock.probeLock({ port })).state).toBe('free');
    });
  });

  const BROWSER_CONFIG = path.join(FIX, 'vitest.guard.browser.config.mjs');

  it('a direct browser-mode vitest run (guard called twice in one process) finishes: one acquire, exit 0, lock free', async () => {
    const port = await allocPort();
    const apiPort = await allocPort();
    const v = startNode([VITEST_CLI, 'run', '--config', BROWSER_CONFIG], cleanEnv(port, { RV_TL_API_PORT: String(apiPort), RV_TEST_LOCK_TIMEOUT_SECONDS: '5', RV_TEST_LOCK_POLL_SECONDS: '0.2' }));
    expect((await v.exited).code, v.output()).toBe(0);
    expect(v.output().match(/guard acquired/g)).toHaveLength(1);
    expect(v.output()).not.toMatch(/waiting|gave up/);
    expect((await lock.probeLock({ port })).state).toBe('free');
  }, 60_000);

  it('NEGATIVE CONTROL: the same browser run with the old guard decision fails on its own pid', async () => {
    const port = await allocPort();
    const apiPort = await allocPort();
    const v = startNode([VITEST_CLI, 'run', '--config', BROWSER_CONFIG], cleanEnv(port, {
      RV_TL_API_PORT: String(apiPort),
      RV_TL_GUARD: path.join(FIX, 'guard-old-reentry.mjs'),
      RV_TEST_LOCK_TIMEOUT_SECONDS: '2',
      RV_TEST_LOCK_POLL_SECONDS: '0.2',
    }));
    expect((await v.exited).code).not.toBe(0);
    expect(v.output()).toContain(`the lock is held by THIS process (PID ${v.pid})`);
    expect((await lock.probeLock({ port })).state).toBe('free');
  }, 60_000);
});

// ─── Playwright: the lock is taken before the webServer starts ──────────────

describe('Playwright through the wrapper (F2, plan § 9)', { timeout: 60_000 }, () => {
  const CONFIG = path.join(FIX, 'pw.fixture.config.mjs');

  async function twoRuns(secondLockOff: boolean) {
    const port = await allocPort();
    const dir = tmp();
    const release = path.join(dir, 'release');
    const wsMarker = path.join(dir, 'ws.log');
    fs.writeFileSync(wsMarker, '');
    const env = (run: string, wsPort: number, extra: Record<string, string> = {}) => cleanEnv(port, {
      RV_TL_RUN: run, RV_TL_WS_PORT: String(wsPort), RV_TL_WS_MARKER: wsMarker, RV_TL_RELEASE: release,
      RV_TEST_LOCK_POLL_SECONDS: '0.2', ...extra,
    });
    const starts = () => fs.readFileSync(wsMarker, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { at: number; run: string; held: string | null });

    const a = runWrapper(['playwright', 'test', '--config', CONFIG], env('A', await allocPort()));
    await waitFor('A running', () => fs.existsSync(`${release}.A.running`), 60_000);
    const b = runWrapper(['playwright', 'test', '--config', CONFIG],
      env('B', await allocPort(), secondLockOff ? { RV_TEST_LOCK: 'off' } : {}));
    if (secondLockOff) await waitFor('B running', () => fs.existsSync(`${release}.B.running`), 60_000);
    else await waitFor('B waiting line', () => b.output().includes('waiting for playwright test'), 60_000);
    const whileAHolds = starts().map((s) => s.run);
    fs.writeFileSync(release, '');
    const exitA = await a.exited;
    const exitB = await b.exited;
    return { a, b, exitA, exitB, whileAHolds, starts: starts() };
  }

  it('a second locked run waits BEFORE its webServer starts, and starts it only after the first has exited', async () => {
    const r = await twoRuns(false);
    expect(r.exitA.code, r.a.output()).toBe(0);
    expect(r.exitB.code, r.b.output()).toBe(0);
    expect(r.whileAHolds).toEqual(['A']);
    const b = r.starts.find((s) => s.run === 'B')!;
    expect(b.held).toBe(String(r.b.pid));
    expect(b.at).toBeGreaterThanOrEqual(r.exitA.at - 50);
  }, 120_000);

  it('NEGATIVE CONTROL: a lock-less second run starts its webServer while the first holds — the check flags it', async () => {
    const r = await twoRuns(true);
    expect(r.exitA.code, r.a.output()).toBe(0);
    expect(r.whileAHolds).toEqual(['A', 'B']);
  }, 120_000);
});


describe('with-test-lock stall limit', { timeout: 15_000 }, () => {
  it('parses defaults, fractions, disabled and invalid values', () => {
    expect(wrapper.STALL_EXIT_CODE).toBe(123);
    expect(wrapper.stallTimeout({})).toEqual({ minutes: 10, ms: 600_000 });
    expect(wrapper.stallTimeout({ RV_TEST_STALL_MINUTES: '0' })).toEqual({ minutes: 0, ms: 0 });
    expect(wrapper.stallTimeout({ RV_TEST_STALL_MINUTES: '0.03' })).toEqual({ minutes: 0.03, ms: 1800 });
    for (const value of ['', 'garbage', '-1', 'Infinity']) {
      expect(wrapper.stallTimeout({ RV_TEST_STALL_MINUTES: value }).minutes).toBe(10);
    }
  });

  it('arms only at start, refreshes on any record, and names unfinished/unstarted files', () => {
    const watch = wrapper.createStallWatch(1000);
    watch.onRecord({ ev: 'run-start', pid: 1, files: ['a', 'b', 'c', 'c'] }, 0);
    expect(watch.expired(5000)).toBeNull();
    watch.onRecord({ ev: 'module-start', pid: 1 }, 5000);
    watch.onRecord({ ev: 'file-start', pid: 1, file: 'a' }, 5100);
    watch.onRecord({ ev: 'file-start', pid: 1, file: 'b' }, 5200);
    watch.onRecord({ ev: 'file-end', pid: 1, file: 'a' }, 5300);
    watch.onRecord({ ev: 'test-end', pid: 1, file: 'b' }, 6000);
    expect(watch.expired(6999)).toBeNull();
    watch.onRecord({ ev: 'anything', pid: 2 }, 6500);
    expect(watch.expired(7499)).toBeNull();
    expect(watch.expired(7500)).toEqual({ idleMs: 1000, last: { ev: 'anything', t: 6500 }, started: ['b'], notStarted: ['c'] });
    const disabled = wrapper.createStallWatch(0);
    disabled.onRecord({ ev: 'file-start', pid: 1, file: 'a' }, 0);
    expect(disabled.expired(1e9)).toBeNull();
  });

  it('waits for every reporting process to end; watch reruns cannot re-arm it', () => {
    const watch = wrapper.createStallWatch(1000);
    for (const pid of [1, 2]) watch.onRecord({ ev: 'run-start', pid }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, file: 'a' }, 0);
    watch.onRecord({ ev: 'run-end', pid: 1 }, 100);
    expect(watch.expired(1100)).not.toBeNull();
    watch.onRecord({ ev: 'run-end', pid: 2 }, 1200);
    expect(watch.expired(1e9)).toBeNull();
    watch.onRecord({ ev: 'file-start', pid: 1, file: 'a' }, 1300);
    expect(watch.expired(1e9)).toBeNull();
    watch.onRecord({ ev: 'run-start', pid: 3 }, 1400);
    expect(watch.expired(1e9)).toBeNull();
    watch.onRecord({ ev: 'module-start', pid: 3 }, 1500);
    expect(watch.expired(2500)?.started).toEqual([]);
  });

  for (const disabled of [false, true]) {
    it(disabled ? 'NEGATIVE CONTROL: zero leaves the stalled child running' : 'kills with 123, names b, frees lock, and prints FAILED last', async () => {
      const port = await allocPort();
      const startedAt = Date.now();
      // F6: 123 is the FALLBACK for a switched-off per-file limit, so the per-file limit is off
      // here. With it on (the default) the stall watch is not armed at all — see the F6 cases.
      const w = runWrapper([path.join(FIX, 'fake-vitest', 'vitest.mjs'), tmp(), 'files:a|b,module,file-start:a,file-start:b,file-end:a,idle'],
        cleanEnv(port, { RV_TEST_FILE_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: disabled ? '0' : '0.03', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0' }));
      if (disabled) {
        expect(await within(w.exited, 3000)).toBe('pending');
        expect(w.output()).not.toContain('no test progress');
      } else {
        expect((await w.exited).code, w.output()).toBe(123);
        expect(Date.now() - startedAt).toBeLessThan(6000);
        expect(w.output()).toContain('files started but not finished: b; not started: 0');
        expect(w.output()).toContain('last event file-end a at ');
        expect(w.output().match(/ending the test tree/g)).toHaveLength(1);
        expect(w.output().trim().split('\n').at(-1)).toMatch(/^\[test-lock\] FAILED \(exit 123\): no test progress/);
        expect((await lock.probeLock({ port })).state).toBe('free');
      }
    });
  }

  it('reporter writes all file events and final results, and expected files only once', () => {
    const file = path.join(tmp(), 'progress.jsonl');
    const reporter = new progress.TestLockProgressReporter({ file, runStart: false, firstTest: false, runEnd: false }, { log: () => {} });
    // Without a real vitest context (no onInit()) the reporter falls back to process.cwd() as
    // its root; set it explicitly to ROOT so these moduleId fixtures relativize correctly
    // regardless of the process's actual cwd when this file runs inside a bigger suite.
    reporter.root = ROOT;
    const a = { moduleId: path.join(ROOT, 'tests', 'a.test.ts') };
    const b = { moduleId: path.join(ROOT, 'tests', 'b.test.ts') };
    reporter.onTestRunStart([a, b, a]);
    for (const module of [a, b]) {
      reporter.onTestModuleStart(module);
      for (const state of ['passed', 'failed', 'skipped']) reporter.onTestCaseResult({ module, result: () => ({ state }) });
      reporter.onTestModuleEnd(module);
    }
    reporter.onTestRunEnd([]);
    reporter.onTestRunStart([b]);
    reporter.onTestModuleStart(b);
    reporter.onTestModuleEnd(b);
    const records = wrapper.readProgress(file).records;
    expect(records.filter((r) => r.ev === 'run-start').map((r) => r.files)).toEqual([['tests/a.test.ts', 'tests/b.test.ts']]);
    for (const ev of ['file-start', 'file-end']) {
      expect(records.filter((r) => r.ev === ev).map((r) => r.file)).toEqual(['tests/a.test.ts', 'tests/b.test.ts', 'tests/b.test.ts']);
    }
    expect(records.filter((r) => r.ev === 'test-end').map((r) => r.file)).toEqual([
      'tests/a.test.ts', 'tests/a.test.ts', 'tests/a.test.ts', 'tests/b.test.ts', 'tests/b.test.ts', 'tests/b.test.ts',
    ]);
  });
});

// ─── wrapper: per-file limit (plan-900) ─────────────────────────────────────

/**
 * plan-900 — the per-file limit (exit 126). Every positive case asserts the NAME of the file in
 * the message, never only the exit code: an assertion on "exit != 0" alone passes three of the
 * wrong implementations in the plan's negative list (X4, and it is the plan-687 trap verbatim).
 * The overlapping cases run through the `fake-vitest` fixture, because at a concurrency of one a
 * global cap, a pid-global clock and a per-(pid, spec) map are indistinguishable (E9/E10); the
 * real vitest run stands next to them as ONE end-to-end case.
 */
describe('with-test-lock per-file limit (RV_TEST_FILE_TIMEOUT_SECONDS)', { timeout: 120_000 }, () => {
  const FAKE_VITEST = path.join(FIX, 'fake-vitest', 'vitest.mjs');
  const PERFILE_CONFIG = path.join(FIX, 'vitest.perfile.config.mjs');
  const pidsIn = (dir: string) => {
    try { return fs.readFileSync(path.join(dir, 'pids.txt'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
  };

  async function fakeRun(steps: string, extra: Record<string, string>) {
    const port = await allocPort();
    const dir = tmp();
    const startedAt = Date.now();
    const w = runWrapper([FAKE_VITEST, dir, steps], cleanEnv(port, extra));
    const [pid] = await waitFor('fake vitest pid', () => { const p = pidsIn(dir); return p.length ? p : null; });
    strayPids.push(pid);
    return { w, pid, dir, port, startedAt };
  }

  it('parses the env: default 600, 0 disables, fractions allowed, garbage → default; exit code 126', () => {
    expect(wrapper.DEFAULT_FILE_TIMEOUT_SECONDS).toBe(600);
    expect(wrapper.FILE_TIMEOUT_EXIT_CODE).toBe(126);
    expect(wrapper.fileTimeout({})).toEqual({ seconds: 600, ms: 600_000, roundedToZero: false });
    expect(wrapper.fileTimeout({ RV_TEST_FILE_TIMEOUT_SECONDS: '0' })).toEqual({ seconds: 0, ms: 0, roundedToZero: false });
    expect(wrapper.fileTimeout({ RV_TEST_FILE_TIMEOUT_SECONDS: '1.5' })).toEqual({ seconds: 1.5, ms: 1500, roundedToZero: false });
    for (const value of ['', 'garbage', '-1', 'Infinity']) {
      expect(wrapper.fileTimeout({ RV_TEST_FILE_TIMEOUT_SECONDS: value }).seconds).toBe(600);
    }
  });

  it('N4: a positive value that rounds to 0 ms is visible, not a silent switch-off', async () => {
    // Inherited rounding trap: `Math.round(seconds * 1000)` turns 0.0004 into 0 ms. In minutes
    // that needs a value ten thousand times smaller; in seconds it is a plausible typo.
    expect(wrapper.fileTimeout({ RV_TEST_FILE_TIMEOUT_SECONDS: '0.0004' })).toEqual({ seconds: 0.0004, ms: 0, roundedToZero: true });
    expect(wrapper.fileTimeout({ RV_TEST_FILE_TIMEOUT_SECONDS: '0.001' }).roundedToZero).toBe(false);
    const { w } = await fakeRun('start,file:a,sleep:300,fileend:a,end', {
      RV_TEST_FILE_TIMEOUT_SECONDS: '0.0004', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    await w.exited;
    expect(w.output()).toContain('RV_TEST_FILE_TIMEOUT_SECONDS=0.0004 rounds to 0 ms — the per-file limit is OFF');
    // NEGATIVE CONTROL: a sane value says nothing of the kind.
    const ok = await fakeRun('start,file:a,fileend:a,end', {
      RV_TEST_FILE_TIMEOUT_SECONDS: '5', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    await ok.w.exited;
    expect(ok.w.output()).not.toContain('rounds to 0 ms');
  });

  it('A8: the limit comes from limitFor(spec), so a per-file override is a data change', () => {
    expect(wrapper.FILE_TIMEOUT_OVERRIDES).toEqual([]); // the hook, not a table (E20)
    expect(wrapper.limitFor('tests/a.test.ts', { defaultMs: 600_000 })).toEqual({ ms: 600_000, source: null });
    const overrides = [{ glob: 'tests/_spike-*/', seconds: 900 }, { glob: 'tests/slow/*.test.ts', seconds: 0 }];
    expect(wrapper.limitFor('tests/_spike-756/spike-756-pick-structure.test.ts', { defaultMs: 600_000, overrides }))
      .toEqual({ ms: 900_000, source: 'tests/_spike-*/' });
    expect(wrapper.limitFor('tests/slow/one.test.ts', { defaultMs: 600_000, overrides })).toEqual({ ms: 0, source: 'tests/slow/*.test.ts' });
    expect(wrapper.limitFor('tests/other.test.ts', { defaultMs: 600_000, overrides })).toEqual({ ms: 600_000, source: null });
    expect(wrapper.specGlobToRegExp('tests/_spike-*/').test('tests/_spike-756/a.test.ts')).toBe(true);
    expect(wrapper.specGlobToRegExp('tests/*.test.ts').test('tests/sub/a.test.ts')).toBe(false); // `*` stays inside one segment
    expect(wrapper.specGlobToRegExp('tests/**/a.test.ts').test('tests/sub/deep/a.test.ts')).toBe(true);
  });

  it('F1: an override row with an unusable seconds value falls back to the DEFAULT instead of freeing its glob', () => {
    // The measured hole: `Math.round(Number('15 min') * 1000)` is NaN, a row without `seconds` is
    // NaN too, and `expired()` skips every entry with `!(limitMs > 0)` — so one typo in this table
    // took its whole glob out of the per-file limit permanently and without a word. Same class as
    // `roundedToZero`, on the other input path, and A8 exists so that someone fills this table.
    // The cast is the point, not a convenience: these two shapes are what the production type
    // FORBIDS, and the runtime check has to hold anyway — for a row that reaches the table around
    // the type system (a JSON import, an `any`, a hand-edit in a .mjs). The negative value below
    // needs no cast: it is type-correct and still unusable.
    const broken = [
      { glob: 'tests/_spike-*/', seconds: '15 min' },
      { glob: 'tests/b/*.test.ts' },
    ] as unknown as GlobLimit[];
    broken.push({ glob: 'tests/c/*.test.ts', seconds: -5 });
    for (const spec of ['tests/_spike-756/x.test.ts', 'tests/b/x.test.ts', 'tests/c/x.test.ts']) {
      const got = wrapper.limitFor(spec, { defaultMs: 600_000, overrides: broken });
      expect(got.ms, spec).toBe(600_000); // the default, NOT 0 and NOT NaN
      expect(got.source, spec).toBeNull();
      expect(got.invalid, spec).toBeTruthy();
      expect(Number.isNaN(got.ms), spec).toBe(false);
    }
    // and the clock really still fires for such a file (the point of the fallback)
    const watch = wrapper.createFileWatch(1000, { overrides: [{ glob: 'tests/*.test.ts', seconds: '15 min' }] as unknown as GlobLimit[] });
    watch.onRecord({ ev: 'run-start', pid: 1 }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'tests/a.test.ts' }, 0);
    expect(watch.expired(999)).toBeNull();
    expect(watch.expired(1000)).toMatchObject({ kind: 'file', spec: 'tests/a.test.ts', limitMs: 1000 });
    // the WARNING names the glob, the bad value and the fallback
    expect(wrapper.invalidOverrides(broken)).toHaveLength(3);
    const lines = wrapper.overrideWarnings(broken, 600);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('tests/_spike-*/');
    expect(lines[0]).toContain('"15 min"');
    expect(lines[0]).toContain('falls back to the default 600 s instead of running WITHOUT a per-file limit');
    // NEGATIVE CONTROL: usable rows — and the real table — warn about nothing.
    expect(wrapper.invalidOverrides([{ glob: 'tests/x/*.test.ts', seconds: 900 }, { glob: 'tests/y/*.test.ts', seconds: 0 }])).toEqual([]);
    expect(wrapper.overrideWarnings(wrapper.FILE_TIMEOUT_OVERRIDES, 600)).toEqual([]);
  });

  it('F5: `?` is a literal in a glob, and `/**/` spans zero segments as standard glob does', () => {
    // `?` unescaped became the regex quantifier: `tests/a?.test.ts` matched `tests/a.test.ts`, so a
    // single mistyped override covered a file nobody named.
    expect(wrapper.specGlobToRegExp('tests/a?.test.ts').test('tests/a.test.ts')).toBe(false);
    expect(wrapper.specGlobToRegExp('tests/a?.test.ts').test('tests/a?.test.ts')).toBe(true);
    expect(wrapper.limitFor('tests/a.test.ts', { defaultMs: 600_000, overrides: [{ glob: 'tests/a?.test.ts', seconds: 5 }] }))
      .toEqual({ ms: 600_000, source: null });
    // zero segments, the standard-glob behaviour that was missing
    expect(wrapper.specGlobToRegExp('tests/**/a.test.ts').test('tests/a.test.ts')).toBe(true);
    expect(wrapper.specGlobToRegExp('tests/**/a.test.ts').test('tests/sub/a.test.ts')).toBe(true);
    expect(wrapper.specGlobToRegExp('tests/**/a.test.ts').test('tests/sub/b.test.ts')).toBe(false);
    // unchanged: `*` stays inside one segment, a trailing `/` is a prefix
    expect(wrapper.specGlobToRegExp('tests/*.test.ts').test('tests/sub/a.test.ts')).toBe(false);
    expect(wrapper.specGlobToRegExp('tests/_spike-*/').test('tests/_spike-756/a/b.test.ts')).toBe(true);
  });

  it('F6: the stall limit (123) is in charge only while the per-file limit (126) is off', () => {
    // The rule in one place, so re-sorting the two `expired()` checks cannot change the semantics.
    // Why it had to become explicit: the stall watch refreshes on EVERY record, the file watch only
    // on FILE events, so `since ≤ lastEventAt ≤ lastAt` always holds — with equal defaults the
    // per-file/A3b trigger is due no later than the stall trigger and is checked first, which made
    // 123 unreachable at default configuration.
    for (const mode of [wrapper.CLOCK_MODE.UNATTENDED, wrapper.CLOCK_MODE.LEGACY]) {
      expect(wrapper.stallIsResponsible(600_000, mode)).toBe(false);
      expect(wrapper.stallIsResponsible(1, mode)).toBe(false);
      expect(wrapper.stallIsResponsible(0, mode)).toBe(true);
    }
    // plan-2046: in the interactive state a switched-off 126 is a DECISION, so 123 is never its
    // fallback there — see the dedicated describe block at the end of this file.
    expect(wrapper.stallIsResponsible(0, wrapper.CLOCK_MODE.OFF)).toBe(false);
    const fileWatch = wrapper.createFileWatch(600_000);
    const stallWatch = wrapper.createStallWatch(600_000);
    for (const w of [fileWatch, stallWatch]) {
      w.onRecord({ ev: 'run-start', pid: 1, files: ['a'] }, 0);
      w.onRecord({ ev: 'module-start', pid: 1 }, 0);
      w.onRecord({ ev: 'file-start', pid: 1, file: 'a' }, 10);
      w.onRecord({ ev: 'file-start', pid: 1, spec: 'a' }, 10);
    }
    // both due at the same instant — which is exactly why the order of checks must not decide
    expect(fileWatch.expired(600_010)).toBeTruthy();
    expect(stallWatch.expired(600_010)).toBeTruthy();
  });

  it('A8: an overridden limit really takes effect — a longer budget is not yet due where the default would be', () => {
    const watch = wrapper.createFileWatch(1000, { overrides: [{ glob: 'tests/_spike-*/', seconds: 5 }] });
    watch.onRecord({ ev: 'run-start', pid: 1 }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'tests/_spike-756/x.test.ts' }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'tests/plain.test.ts' }, 0);
    expect(watch.expired(1500)).toMatchObject({ kind: 'file', spec: 'tests/plain.test.ts', limitMs: 1000 });
    watch.onRecord({ ev: 'file-end', pid: 1, spec: 'tests/plain.test.ts' }, 1600);
    expect(watch.expired(4999)).toBeNull();
    expect(watch.expired(5000)).toMatchObject({ spec: 'tests/_spike-756/x.test.ts', limitMs: 5000, source: 'tests/_spike-*/' });
  });

  it('P1a/P1b/P1c: the hanging file is named at any position, and the healthy neighbours are not', () => {
    for (const [label, before, after] of [['first', [], ['c']], ['middle', ['a'], ['c']], ['last', ['a', 'c'], []]] as const) {
      const watch = wrapper.createFileWatch(1000);
      let t = 0;
      watch.onRecord({ ev: 'run-start', pid: 7, files: ['a', 'b', 'c'] }, t);
      for (const spec of before) {
        watch.onRecord({ ev: 'file-start', pid: 7, spec }, (t += 10));
        watch.onRecord({ ev: 'file-end', pid: 7, spec }, (t += 10));
      }
      watch.onRecord({ ev: 'file-start', pid: 7, spec: 'b' }, (t += 10));
      const hangStart = t;
      for (const spec of after) {
        watch.onRecord({ ev: 'file-start', pid: 7, spec }, (t += 10));
        watch.onRecord({ ev: 'file-end', pid: 7, spec }, (t += 10));
      }
      expect(watch.expired(hangStart + 999), label).toBeNull();
      expect(watch.expired(hangStart + 1000), label).toMatchObject({ kind: 'file', spec: 'b', pid: 7 });
    }
  });

  it('P1d: a permanently active neighbour does not shield the hanging file (the pid-global clock case)', () => {
    // X3: a pid-global inactivity timer is refreshed by every `a*` event — it either never fires
    // or accuses a healthy file. The in-flight map must name `b`.
    const watch = wrapper.createFileWatch(1000);
    watch.onRecord({ ev: 'run-start', pid: 3 }, 0);
    watch.onRecord({ ev: 'file-start', pid: 3, spec: 'a' }, 0);
    watch.onRecord({ ev: 'file-start', pid: 3, spec: 'b' }, 10);
    let t = 20;
    watch.onRecord({ ev: 'file-end', pid: 3, spec: 'a' }, t);
    for (let i = 0; i < 20; i++) {
      watch.onRecord({ ev: 'file-start', pid: 3, spec: `a${i}` }, (t += 100));
      watch.onRecord({ ev: 'file-end', pid: 3, spec: `a${i}` }, (t += 10));
    }
    const due = watch.expired(t);
    expect(due).toMatchObject({ kind: 'file', spec: 'b' });
    expect((due as FileDue).sole).toBe(false); // other file events happened since its start
  });

  it('D4: with both triggers due the NAMED message wins and says that a second stall is not excluded', () => {
    const watch = wrapper.createFileWatch(1000);
    watch.onRecord({ ev: 'run-start', pid: 1 }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'a' }, 100);
    expect(watch.expired(1100)).toMatchObject({ kind: 'file', spec: 'a', sole: true });
  });

  it('the F6 note is decided by event ORDER, not by the receipt time one poll tick shares', () => {
    // Two file-starts arriving in ONE read get the same `now`; the second one is still a later
    // event, so the first file is NOT alone. A time comparison would claim it is.
    const watch = wrapper.createFileWatch(1000);
    watch.onRecord({ ev: 'run-start', pid: 1 }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'a' }, 100);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'b' }, 100);
    expect(watch.expired(1100)).toMatchObject({ spec: 'a', sole: false });
  });

  it('D4b: with an EMPTY map the inactivity variant is reached and names the last KNOWN file', () => {
    const watch = wrapper.createFileWatch(1000);
    watch.onRecord({ ev: 'run-start', pid: 1 }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'a' }, 100);
    watch.onRecord({ ev: 'file-end', pid: 1, spec: 'a' }, 200);
    expect(watch.expired(1199)).toBeNull();
    expect(watch.expired(1200)).toEqual({ kind: 'idle', idleMs: 1000, last: { spec: 'a', pid: 1, at: 200 } });
  });

  it('D3: no file event at all still ends the run — with no file named', () => {
    const watch = wrapper.createFileWatch(1000);
    watch.onRecord({ ev: 'run-start', pid: 1 }, 0);
    expect(watch.expired(999)).toBeNull();
    expect(watch.expired(1000)).toEqual({ kind: 'idle', idleMs: 1000, last: null });
    // NEGATIVE CONTROL: without any record (a Playwright run) the clock is never armed, and with
    // the limit off it never fires either.
    expect(wrapper.createFileWatch(1000).expired(1e9)).toBeNull();
    const off = wrapper.createFileWatch(0);
    off.onRecord({ ev: 'file-start', pid: 1, spec: 'a' }, 0);
    expect(off.expired(1e9)).toBeNull();
  });

  it('X6/P3b: the map is keyed by (pid, spec) — one process ending a spec does not free another', () => {
    const watch = wrapper.createFileWatch(1000);
    for (const pid of [11, 12]) watch.onRecord({ ev: 'run-start', pid }, 0);
    watch.onRecord({ ev: 'file-start', pid: 11, spec: 'same.test.ts' }, 0);
    watch.onRecord({ ev: 'file-start', pid: 12, spec: 'same.test.ts' }, 50);
    watch.onRecord({ ev: 'file-end', pid: 11, spec: 'same.test.ts' }, 100);
    expect(watch.expired(1049)).toBeNull();
    expect(watch.expired(1050)).toMatchObject({ kind: 'file', spec: 'same.test.ts', pid: 12 });
    // An entry of a process that is gone cannot produce an inherited deadline.
    watch.prune((pid) => pid !== 12);
    expect([...watch.inFlight.values()]).toEqual([]);
    expect(watch.expired(1e6)).toMatchObject({ kind: 'idle' });
  });

  it('N6: a record with a turned-back `t` does not move the due time (the clock uses the wrapper receipt)', () => {
    const watch = wrapper.createFileWatch(1000);
    watch.onRecord({ ev: 'run-start', pid: 1, t: 10 ** 12 }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'a', t: 10 ** 12 }, 100);
    watch.onRecord({ ev: 'test-end', pid: 1, file: 'a', t: 1 }, 200); // an older stamp, later receipt
    expect(watch.expired(1099)).toBeNull();
    expect(watch.expired(1100)).toMatchObject({ kind: 'file', spec: 'a' });
  });

  it('run-end clears the process and disarms the clock, so watch-mode idling is exempt', () => {
    const watch = wrapper.createFileWatch(1000);
    watch.onRecord({ ev: 'run-start', pid: 1, files: ['a', 'b'] }, 0);
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'a' }, 0);
    expect(watch.status()).toEqual({ open: ['a'], started: 1, expected: 2 });
    watch.onRecord({ ev: 'run-end', pid: 1 }, 100);
    expect(watch.status().open).toEqual([]);
    expect(watch.expired(1e9)).toBeNull();
    watch.onRecord({ ev: 'file-start', pid: 1, spec: 'a' }, 1e6); // a watch rerun cannot re-arm it
    expect(watch.expired(1e9)).toBeNull();
  });

  it('P2: a spec-bearing file-start neither closes the startup window nor arms the stall limit', () => {
    // plan-900 must not touch plan-617: `onTestModuleQueued` fires BEFORE the import, so closing
    // the 125 window on it would hand every import hang to a limit twice as long.
    const startup = wrapper.createStartupWatch(1000);
    startup.open(5, 0, 'the vitest start');
    startup.onRecord({ ev: 'file-start', pid: 5, spec: 'a' }, 100);
    expect(startup.expired(1000)).toMatchObject({ pid: 5 });
    startup.onRecord({ ev: 'file-start', pid: 5, file: 'a' }, 1100); // the plan-617 record closes it
    expect(startup.expired(1e9)).toBeNull();
    const stall = wrapper.createStallWatch(1000);
    stall.onRecord({ ev: 'run-start', pid: 5 }, 0);
    stall.onRecord({ ev: 'file-start', pid: 5, spec: 'a' }, 0);
    expect(stall.expired(1e9)).toBeNull();
    stall.onRecord({ ev: 'file-start', pid: 5, file: 'a' }, 0);
    expect(stall.expired(1000)).not.toBeNull();
  });

  for (const disabled of [false, true]) {
    it(disabled
      ? 'NEGATIVE CONTROL: with 0 the same overlapping run is NOT ended'
      : 'kills with 126, names the hanging file (not the busy neighbour), frees the lock and prints FAILED last', async () => {
      const steps = 'start,file:a,file:b,fileend:a,file:a2,sleep:300,fileend:a2,file:a3,sleep:300,fileend:a3,idle';
      const { w, port } = await fakeRun(steps, {
        RV_TEST_FILE_TIMEOUT_SECONDS: disabled ? '0' : '1',
        RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
      });
      if (disabled) {
        expect(await within(w.exited, 3000)).toBe('pending');
        expect(w.output()).not.toContain('ran for RV_TEST_FILE_TIMEOUT_SECONDS');
        expect(w.output()).toContain('WARNING: per-file limit DISABLED (RV_TEST_FILE_TIMEOUT_SECONDS=0)');
      } else {
        expect((await w.exited).code, w.output()).toBe(126);
        expect(w.output()).toMatch(/\[test-lock\] b ran for RV_TEST_FILE_TIMEOUT_SECONDS=1 \(\d+\.\d s, budget 1 s, PID \d+\) — ending the test tree and releasing the lock; RV_TEST_FILE_TIMEOUT_SECONDS=0 disables this limit/);
        expect(w.output()).not.toMatch(/\[test-lock\] a\d? ran for/);
        expect(w.output().trim().split('\n').at(-1)).toMatch(/^\[test-lock\] FAILED \(exit 126\): b ran for /);
        expect((await lock.probeLock({ port })).state).toBe('free');
      }
    });
  }


  it('every DISABLED clock says so at the start of a GREEN run, and a running clock says nothing', async () => {
    // Evidence (2026-10-27): a wrapped run hung for 33 minutes, no limit fired, and because the
    // switch-off lived in an environment variable in a shell it took two sessions several hours
    // and one wrong defect report to find out. The line must therefore be in EVERY log.
    const quiet = await fakeRun('start,file:a,fileend:a,end', {
      RV_TEST_FILE_TIMEOUT_SECONDS: '5', RV_TEST_STARTUP_TIMEOUT_SECONDS: '5',
      RV_TEST_STALL_MINUTES: '5', RV_TEST_MAX_RUNTIME_MINUTES: '5',
    });
    expect((await quiet.w.exited).code, quiet.w.output()).toBe(0);
    expect(quiet.w.output()).not.toContain('WARNING'); // NEGATIVE CONTROL: no noise when all four run
    const loud = await fakeRun('start,file:a,fileend:a,end', {
      RV_TEST_FILE_TIMEOUT_SECONDS: '0', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0',
      RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    expect((await loud.w.exited).code, loud.w.output()).toBe(0); // a GREEN run, and it still warns
    const out = loud.w.output();
    expect(out).toContain('WARNING: startup window DISABLED (RV_TEST_STARTUP_TIMEOUT_SECONDS=0)');
    expect(out).toContain('WARNING: per-file limit DISABLED (RV_TEST_FILE_TIMEOUT_SECONDS=0)');
    expect(out).toContain('WARNING: stall limit DISABLED (RV_TEST_STALL_MINUTES=0)');
    expect(out).toContain('WARNING: maximum run time DISABLED (RV_TEST_MAX_RUNTIME_MINUTES=0)');
    // each one says what is no longer caught, not just that it is off
    expect(out).toContain('a run that never reports a module event will not be ended (exit 125)');
    expect(out).toContain('a single file that hangs will not be named or ended (exit 126)');
    // and an ACCIDENTAL switch-off is louder than a deliberate one
    const typo = await fakeRun('start,file:a,fileend:a,end', { RV_TEST_FILE_TIMEOUT_SECONDS: '0.0004' });
    await typo.w.exited;
    expect(typo.w.output()).toContain('OFF BY ACCIDENT');
  });

  it('F6 end to end: with 126 ON the stall clock stays silent even when it is the SHORTER one; with 126 OFF it fires', async () => {
    // The discriminator for the precedence decision. Stall 0.6 s against a per-file budget of 5 s:
    // before the rule became explicit the stall clock won this race and the run died with 123
    // after half a second, although the decision makes 123 a FALLBACK for a switched-off 126.
    // Now exactly one clock is armed, so the run outlives the stall window and the per-file limit
    // ends it — with the file's NAME, which is the whole point of preferring 126.
    const steps = 'start,module,file:a,file:b,fileend:a,idle';
    const { w } = await fakeRun(steps, {
      RV_TEST_FILE_TIMEOUT_SECONDS: '5', RV_TEST_STALL_MINUTES: '0.01',
      RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    expect((await w.exited).code, w.output()).toBe(126);
    expect(w.output()).toMatch(/\[test-lock\] b ran for RV_TEST_FILE_TIMEOUT_SECONDS=5/);
    expect(w.output()).not.toContain('no test progress'); // 123 must not appear while 126 is on
    // …and the very same silence IS ended by 123 once the per-file limit is off.
    const fallback = await fakeRun(steps, {
      RV_TEST_FILE_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0.01',
      RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    expect((await fallback.w.exited).code, fallback.w.output()).toBe(123);
    expect(fallback.w.output()).toContain('no test progress');
    // and the log says which clock is in charge: 126 off, 123 named as its fallback
    expect(fallback.w.output()).toContain('the stall limit (exit 123) is the fallback');
  });

  it('D3 end to end: a run without any file event ends with the unnamed message', async () => {
    const { w } = await fakeRun('start,idle', {
      RV_TEST_FILE_TIMEOUT_SECONDS: '1', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    expect((await w.exited).code, w.output()).toBe(126);
    expect(w.output()).toContain('no test file event for RV_TEST_FILE_TIMEOUT_SECONDS=1');
    expect(w.output()).toContain('last file event: none in this run');
    expect(w.output()).toContain('the stalled file is NOT named; see plan-900 F6');
  });

  it('N3: with the startup window OFF the per-file limit still works (the progress file is its own)', async () => {
    const { w } = await fakeRun('start,file:a,file:b,fileend:a,idle', {
      RV_TEST_FILE_TIMEOUT_SECONDS: '1', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    expect((await w.exited).code, w.output()).toBe(126);
    expect(w.output()).toMatch(/\[test-lock\] b ran for RV_TEST_FILE_TIMEOUT_SECONDS=1/);
  });

  it('a re-entering wrapper does not run the clock', async () => {
    const port = await allocPort();
    const dir = tmp();
    const w = runWrapper([FAKE_VITEST, dir, 'start,file:a,idle'], cleanEnv(port, {
      RV_TEST_LOCK_HELD: String(process.pid), RV_TEST_FILE_TIMEOUT_SECONDS: '1',
      RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    }));
    const [pid] = await waitFor('fake vitest pid', () => { const p = pidsIn(dir); return p.length ? p : null; });
    strayPids.push(pid);
    expect(w.output()).toContain('re-entering');
    expect(await within(w.exited, 3000)).toBe('pending');
    expect(w.output()).not.toContain('ran for RV_TEST_FILE_TIMEOUT_SECONDS');
  });

  it('A3d: a run that falls into the cap anyway names the open in-flight files and the file-start quota', async () => {
    // MARGIN (plan-900 F4): the cap must fire only AFTER the fixture's records have been written
    // and read, or the assertion below sees an empty in-flight map and reads like a defect. Needed
    // from the wrapper's spawn: node boot + four writes (~0.2 s measured) plus one 250 ms poll
    // tick, so roughly 0.5 s. 0.03 min = 1.8 s was a factor of ~3.6 over that and the case took
    // 3033 ms; 0.1 min = 6 s raises the factor to ~12 and costs about 4 s of run time. The upper
    // side is unconstrained — the fixture idles for 120 s — so there is nothing to trade away.
    const { w } = await fakeRun('files:a|b|c,file:a,file:b,fileend:a,idle', {
      RV_TEST_FILE_TIMEOUT_SECONDS: '600', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0.1',
    });
    expect((await w.exited).code, w.output()).toBe(124);
    expect(w.output()).toContain('in-flight files: b; files with a file-start: 2/3');
  });

  it('N5: a progress file that cannot be created switches the limits off LOUDLY and the 124 message says so', async () => {
    // Not fail-closed: a %TEMP% error must not make every test run red (E17). TMP points at a
    // FILE here, so `writeFileSync` inside it fails on every platform.
    const dir = tmp();
    const notADir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(notADir, '');
    const port = await allocPort();
    const w = runWrapper([FAKE_VITEST, dir, 'start,file:a,idle'], cleanEnv(port, {
      TMP: notADir, TEMP: notADir, TMPDIR: notADir,
      RV_TEST_FILE_TIMEOUT_SECONDS: '1', RV_TEST_STARTUP_TIMEOUT_SECONDS: '1', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0.05',
    }));
    const [pid] = await waitFor('fake vitest pid', () => { const p = pidsIn(dir); return p.length ? p : null; });
    strayPids.push(pid);
    expect((await w.exited).code, w.output()).toBe(124); // the run STARTS and ends at the cap
    expect(w.output()).toContain('the startup limit (125), the stall limit (123) and the per-file limit (126) are all inactive in this run');
    expect(w.output()).toContain('note: the per-file limit was not active in this run (no progress file:');
  });

  // ─── end to end with the real vitest ──────────────────────────────────────

  /** A holding wrapper around a real vitest run of `vitest.perfile.config.mjs`. */
  async function perfileRun(include: string, extra: Record<string, string>) {
    const port = await allocPort();
    const startedAt = Date.now();
    const w = runWrapper([VITEST_CLI, 'run', '--config', PERFILE_CONFIG], cleanEnv(port, { RV_TL_PERFILE_INCLUDE: include, ...extra }));
    return { w, port, startedAt, progress: watchWrapperProgress(w) };
  }

  it('V1/P1: a REAL file hanging in its module body is named — file-start carries its spec although onTestModuleStart never fires', async () => {
    const { w, progress: records } = await perfileRun('first-file.fixture.test.mjs|hang-second-file.fixture.test.mjs', {
      RV_TEST_FILE_TIMEOUT_SECONDS: '8', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    expect((await w.exited).code, w.output()).toBe(126);
    expect(w.output()).toMatch(/\[test-lock\] hang-second-file\.fixture\.test\.mjs ran for RV_TEST_FILE_TIMEOUT_SECONDS=8/);
    expect(w.output()).not.toMatch(/first-file.fixture.test.mjs ran for/);
    // The neighbour produced file events AFTER the hang started, so the F6 note must NOT appear —
    // and it must not appear just because one poll tick stamps all of them with one receipt time.
    expect(w.output()).not.toContain('no other file event since its start');
    // V1, the evidence this phase exists for: the hanging file HAS a `file-start` with its name,
    // and it never gets the plan-617 `file-start` (that hook does not fire for it) or a `file-end`.
    const all = records.records();
    const queued = all.filter((r) => r.ev === 'file-start' && r.spec === 'hang-second-file.fixture.test.mjs');
    expect(queued.length, JSON.stringify(all)).toBeGreaterThanOrEqual(1);
    expect(all.filter((r) => r.ev === 'file-start' && r.file === 'hang-second-file.fixture.test.mjs')).toEqual([]);
    expect(all.filter((r) => r.ev === 'file-end' && r.spec === 'hang-second-file.fixture.test.mjs')).toEqual([]);
    expect(all.some((r) => r.ev === 'file-end' && r.spec === 'first-file.fixture.test.mjs')).toBe(true);
  });

  it('D1/D2: two legitimately slow files, each under the limit and together over it, stay GREEN', async () => {
    // The discriminator against a global cap of the same height: that would kill this run.
    //
    // MARGIN (plan-900 F4, re-measured 2026-10-27). The constraint is two-sided: each file must
    // stay UNDER the per-file limit while the two together must exceed it. The first side is the
    // dangerous one, because the limit hard-kills the tree and the failure then reads as exit 126
    // — a real defect, not a flake. Measured before: sleep 2500 ms + ~150 ms file overhead = 2.65 s
    // against a 4.0 s limit, a factor of 1.5, while the margin rules this plan uses elsewhere are
    // 2.39 (E19) and ~9 (F16), and a measured same-file spread of ±11 % plus foreign load eats 1.5
    // quickly. Limit and sleep are therefore scaled together, keeping the ratio of the second
    // side intact: sleep 5500 ms + ~150 ms ≈ 5.65 s against a 10 s limit = factor 1.77 of head
    // room per file, and 2 × 5.65 s = 11.3 s > 10 s still exceeds it as a process total. This is
    // not the project's "never soften a wall-clock budget" being bent — the budget here is the
    // thing under test, and what is being created is the margin that was missing.
    const limitMs = 10_000;
    const { w, startedAt, progress: records } = await perfileRun('slow-file.fixture.test.mjs|slow-file-b.fixture.test.mjs', {
      RV_TL_SLOW_FILE_MS: '5500', RV_TL_PERFILE_WORKERS: '1',
      RV_TEST_FILE_TIMEOUT_SECONDS: '10', RV_TEST_STARTUP_TIMEOUT_SECONDS: '0', RV_TEST_STALL_MINUTES: '0', RV_TEST_MAX_RUNTIME_MINUTES: '0',
    });
    expect((await w.exited).code, w.output()).toBe(0);
    expect(Date.now() - startedAt, 'the whole run must outlast the per-file limit').toBeGreaterThan(limitMs);
    const all = records.records();
    const spans = new Map<string, { start: number; end: number }>();
    for (const r of all) {
      if (r.ev === 'file-start' && r.spec) spans.set(r.spec, { start: r.t ?? 0, end: 0 });
      if (r.ev === 'file-end' && r.spec && spans.has(r.spec)) spans.get(r.spec)!.end = r.t ?? 0;
    }
    expect([...spans.keys()].sort()).toEqual(['slow-file-b.fixture.test.mjs', 'slow-file.fixture.test.mjs']);
    for (const [spec, span] of spans) expect(span.end - span.start, spec).toBeLessThan(limitMs);
  });

  it('the reporter writes the per-file records: spec at queued, file AND spec at the end', () => {
    const file = path.join(tmp(), 'progress.jsonl');
    const reporter = new progress.TestLockProgressReporter({ file, runStart: false, firstTest: false, runEnd: false }, { log: () => {} });
    // See the comment on the equivalent fixture above — pin root explicitly, same reason.
    reporter.root = ROOT;
    const a = { moduleId: path.join(ROOT, 'tests', 'a.test.ts') };
    reporter.onTestModuleQueued(a);
    reporter.onTestModuleEnd(a);
    const records = wrapper.readProgress(file).records;
    expect(records.map((r) => [r.ev, r.spec, r.file])).toEqual([
      ['file-start', 'tests/a.test.ts', undefined],
      ['file-end', 'tests/a.test.ts', 'tests/a.test.ts'],
    ]);
  });

  it('writeProgress without a spec writes exactly the record it wrote before plan-900', () => {
    // E15: the fake-vitest fixture writes through THIS function, so it must not drift from
    // production — and a call without `spec` must not even gain the key.
    const file = path.join(tmp(), 'progress.jsonl');
    progress.writeProgress(file, 'run-start', { pid: 42, ppid: 7 });
    progress.writeProgress(file, 'file-start', { pid: 42, ppid: 7, spec: 'tests/a.test.ts' });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines[0].replace(/"t":\d+/, '"t":0')).toBe('{"ev":"run-start","pid":42,"ppid":7,"t":0}');
    expect(lines[1].replace(/"t":\d+/, '"t":0')).toBe('{"ev":"file-start","pid":42,"ppid":7,"spec":"tests/a.test.ts","t":0}');
  });
});

// ─── plan-2046: the abort clocks are armed only where nobody watches ─────────

/**
 * plan-2046 — the three abort clocks (startup 125, per-file 126, stall 123) are armed only by
 * `RV_TEST_UNATTENDED=1`. The load-bearing case is the NEGATIVE one: without the switch none of
 * them may fire, and in particular 123 must NOT arm itself as the fallback of a switched-off 126
 * (the old `stallIsResponsible` did exactly that, which would have let every interactive run die
 * of exit 123 after ten minutes of silence — worse than before and the inversion of the decision).
 * Every state case therefore runs the SAME fixture and asserts what does and does not happen.
 * No tight wall-clock assertions: the limits are set so small that the margin is the whole run.
 */
describe('with-test-lock clock states (plan-2046)', { timeout: 120_000 }, () => {
  const FAKE_VITEST = path.join(FIX, 'fake-vitest', 'vitest.mjs');
  /** All three clocks at values a test can wait for. The cap (124) and the lock stay at default. */
  const TINY = {
    RV_TEST_STARTUP_TIMEOUT_SECONDS: '0.4',
    RV_TEST_FILE_TIMEOUT_SECONDS: '0.4',
    RV_TEST_STALL_MINUTES: '0.02',
  };
  const OFF = { RV_TEST_UNATTENDED: undefined, RV_TEST_LEGACY_CLOCKS: undefined };
  const UNATTENDED = { RV_TEST_UNATTENDED: '1', RV_TEST_LEGACY_CLOCKS: undefined };
  const LEGACY = { RV_TEST_UNATTENDED: undefined, RV_TEST_LEGACY_CLOCKS: '1' };

  it('parses the switch: 1/true/on arm, unset/empty/0 do not, an unparsable value is OFF plus a warning', () => {
    for (const value of ['1', 'true', 'on', 'TRUE', ' On ']) {
      expect(wrapper.clockMode({ RV_TEST_UNATTENDED: value }), value).toEqual({ mode: 'unattended', warnings: [] });
    }
    for (const value of [undefined, '', '0', 'false', 'off']) {
      expect(wrapper.clockMode({ RV_TEST_UNATTENDED: value }), String(value)).toEqual({ mode: 'off', warnings: [] });
    }
    const typo = wrapper.clockMode({ RV_TEST_UNATTENDED: 'yes' });
    expect(typo.mode).toBe('off');
    expect(typo.warnings).toHaveLength(1);
    expect(typo.warnings[0]).toContain('RV_TEST_UNATTENDED');
    expect(typo.warnings[0]).toContain('treated as OFF');
    // legacy beats unattended, and it is parsed by the same rule
    expect(wrapper.clockMode({ RV_TEST_UNATTENDED: '1', RV_TEST_LEGACY_CLOCKS: '1' }).mode).toBe('legacy');
    expect(wrapper.clockMode({ RV_TEST_UNATTENDED: '1', RV_TEST_LEGACY_CLOCKS: '0' }).mode).toBe('unattended');
  });

  it('the state machine: which clock is armed in each of the three states', () => {
    const off = wrapper.clockState({});
    expect(off.mode).toBe('off');
    expect(off.armed).toEqual({ startupMs: 0, perFileMs: 0, stallMs: 0 });
    // The cap is NOT one of the three clocks — it stays armed in every state (and so does the lock).
    expect(off.runtime.ms).toBe(90 * 60_000);

    for (const env of [{ RV_TEST_UNATTENDED: '1' }, { RV_TEST_LEGACY_CLOCKS: '1' }]) {
      const on = wrapper.clockState(env);
      // Armed with today's values and today's semantics: 123 dormant while 126 is active (F6).
      expect(on.armed, JSON.stringify(env)).toEqual({ startupMs: 300_000, perFileMs: 600_000, stallMs: 0 });
      expect(wrapper.clockState({ ...env, RV_TEST_FILE_TIMEOUT_SECONDS: '0' }).armed)
        .toEqual({ startupMs: 300_000, perFileMs: 0, stallMs: 600_000 });
    }
    // A single-clock variable does NOT arm anything on its own: without the switch there is one
    // interactive state, not a second half-armed one nobody can keep in their head. An
    // interactive session that wants a clock takes RV_TEST_UNATTENDED=1.
    expect(wrapper.clockState({ ...TINY }).armed).toEqual({ startupMs: 0, perFileMs: 0, stallMs: 0 });
    expect(wrapper.clockState({ ...TINY, RV_TEST_UNATTENDED: '1' }).armed)
      .toEqual({ startupMs: 400, perFileMs: 400, stallMs: 0 });
  });

  it('the state line names the state, the armed clocks and what is left when nothing is armed', () => {
    expect(wrapper.clockSummary(wrapper.clockState({}))).toBe(
      'clocks: INTERACTIVE — no abort clock armed (125/126/123 off); maximum run time 90 min (124) and the test lock stay active; an unattended run sets RV_TEST_UNATTENDED=1');
    const on = wrapper.clockSummary(wrapper.clockState({ RV_TEST_UNATTENDED: '1' }));
    expect(on).toContain('UNATTENDED (RV_TEST_UNATTENDED)');
    expect(on).toContain('startup 300 s (125)');
    expect(on).toContain('per-file 600 s (126)');
    expect(wrapper.clockSummary(wrapper.clockState({ RV_TEST_LEGACY_CLOCKS: '1' }))).toContain('LEGACY (RV_TEST_LEGACY_CLOCKS)');
    expect(wrapper.clockSummary(wrapper.clockState({ RV_TEST_MAX_RUNTIME_MINUTES: '0' })))
      .toContain('maximum run time DISABLED (124) — only the test lock is left');
  });

  it('(a) WITHOUT the switch not one of the three clocks fires, however long the run is silent', async () => {
    const port = await allocPort();
    // Queued, started and then silent forever, with all three limits at a few hundred ms: today
    // this run would end with 126 (or, with 126 off, with 123) within a second.
    const w = runWrapper([FAKE_VITEST, tmp(), 'files:a,module,file:a,file-start:a,idle'], cleanEnv(port, { ...TINY, ...OFF }));
    expect(await within(w.exited, 6000), w.output()).toBe('pending');
    const out = w.output();
    expect(out).toContain('clocks: INTERACTIVE — no abort clock armed');
    expect(out).not.toContain('ending the test tree');
    for (const text of ['FAILED (exit 126)', 'FAILED (exit 125)', 'FAILED (exit 123)']) expect(out).not.toContain(text);
    // "not armed" is not "unprotected": the lock is held for exactly as long as the run lasts.
    expect((await lock.probeLock({ port })).state).toBe('held');
  });

  it('(b) WITH the switch 126 fires and names the file, exactly as before', async () => {
    const port = await allocPort();
    const w = runWrapper([FAKE_VITEST, tmp(), 'files:a,module,file:a,idle'], cleanEnv(port, { ...TINY, ...UNATTENDED }));
    expect((await w.exited).code, w.output()).toBe(126);
    expect(w.output()).toContain('clocks: UNATTENDED (RV_TEST_UNATTENDED)');
    expect(w.output()).toContain('a ran for RV_TEST_FILE_TIMEOUT_SECONDS=0.4');
    expect((await lock.probeLock({ port })).state).toBe('free');
  });

  it('(c) THE regression: without the switch a switched-off 126 does NOT arm 123 — with legacy it does', async () => {
    // `RV_TEST_FILE_TIMEOUT_SECONDS=0` is the exact condition under which the old
    // `stallIsResponsible()` armed the stall limit. The second half of the case proves the fixture
    // WOULD fire: same fixture, same values, only the state differs.
    const steps = 'files:a|b,module,file-start:a,file-start:b,file-end:a,idle';
    const env = { ...TINY, RV_TEST_FILE_TIMEOUT_SECONDS: '0' };

    const port = await allocPort();
    const interactive = runWrapper([FAKE_VITEST, tmp(), steps], cleanEnv(port, { ...env, ...OFF }));
    expect(await within(interactive.exited, 6000), interactive.output()).toBe('pending');
    expect(interactive.output()).not.toContain('no test progress');
    expect(interactive.output()).not.toContain('FAILED (exit 123)');
    // Not even a warning about the switched-off 126: in this state that is the intended setting.
    expect(interactive.output()).not.toContain('per-file limit DISABLED');
    killTree(interactive.pid);
    await interactive.exited;

    const legacyPort = await allocPort();
    const legacy = runWrapper([FAKE_VITEST, tmp(), steps], cleanEnv(legacyPort, { ...env, ...LEGACY }));
    expect((await legacy.exited).code, legacy.output()).toBe(123);
    expect(legacy.output()).toContain('clocks: LEGACY (RV_TEST_LEGACY_CLOCKS)');
    expect(legacy.output()).toContain('files started but not finished: b');
  });

  it('(d) legacy beats the switch and restores the armed behaviour', async () => {
    const port = await allocPort();
    // Switch explicitly OFF, legacy ON: the clocks are armed anyway — that is what a rollback means.
    const w = runWrapper([FAKE_VITEST, tmp(), 'files:a,module,file:a,idle'],
      cleanEnv(port, { ...TINY, RV_TEST_UNATTENDED: '0', RV_TEST_LEGACY_CLOCKS: '1' }));
    expect((await w.exited).code, w.output()).toBe(126);
    expect(w.output()).toContain('a ran for RV_TEST_FILE_TIMEOUT_SECONDS=0.4');
  });

  it('(e) the test lock holds in all three states — it is a resource lock, not a clock', async () => {
    for (const state of [OFF, UNATTENDED, LEGACY]) {
      const port = await allocPort();
      const holder = await startHolder('lock', port);
      // A second run must not get in, whatever the clock state is.
      const w = runWrapper([FAKE_VITEST, tmp(), 'files:a,module,file:a,fileend:a,end'],
        cleanEnv(port, { ...TINY, ...state, RV_TEST_LOCK_TIMEOUT_SECONDS: '1' }));
      expect((await w.exited).code, w.output()).toBe(1);
      expect(w.output()).not.toContain('acquired ');
      killTree(holder.proc.pid);
    }
  });
});
