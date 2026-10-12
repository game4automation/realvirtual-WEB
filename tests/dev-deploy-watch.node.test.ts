// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-488 §9 groups B and C (+ Phase 3) — the /dev deploy watcher.
 *
 * B: the pure decision function.
 * C: the operating contract against LOCAL git fixtures (bare origins + clones in the temp folder)
 *    and REAL processes. The deploy child is a stub `scripts/bunny-deploy.mjs` committed into the
 *    fixture web repo — nothing is ever deployed, no CDN is contacted, no real remote is fetched.
 * Install: `--install` / `--uninstall` / `--purge` against a fake canonical checkout in the temp
 *    folder with an INJECTED schtasks runner that only records its calls. No scheduled task is
 *    ever created by these tests.
 *
 * Every lock/pipe name carries this run's PID and a random suffix; every spawned process is killed
 * in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, realpathSync,
  chmodSync, copyFileSync, symlinkSync, renameSync, utimesSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import * as watchModule from '../scripts/dev-deploy-watch.mjs';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import { acquirePublishLock } from '../scripts/rv-publish-lock.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pair = { web: string; private: string };
type State = {
  lastDeployed: Pair | null;
  lastFailed: any;
  attempt: { pair: Pair; attempts: number; status: string; nextRetryAt: number | null } | null;
  inFlight: any;
  lastResult: any;
};
type Decision = { action: 'none' | 'deploy' | 'give-up'; reason: string; state: State };
const W = watchModule as unknown as {
  WATCHER_LOCK_NAME: string;
  INSTALLED_FILES: readonly string[];
  CLONE_DIRS: { web: string; private: string };
  MAX_ATTEMPTS: number;
  BACKOFF_MS: number[];
  freshState(): State;
  decideTick(state: State | null, pair: Pair, now: number): Decision;
  recordResult(state: State, pair: Pair, result: Record<string, unknown>): State;
  applyRetry(state: State): { changed: boolean; state: State };
  summarizeStatus(state: State): string;
  readState(path: string, options?: Record<string, unknown>): { kind: string; state?: State; corruptPath?: string };
  assertResetTarget(target: string, config: Record<string, any>): string;
  runTick(config: Record<string, any>, deps?: Record<string, unknown>): Promise<{ outcome: string; pair?: Pair }>;
  loadWatcherConfig(path: string): Record<string, any>;
  buildTaskXml(config: Record<string, any>, options: Record<string, unknown>): string;
  taskAction(config: Record<string, any>, options?: Record<string, unknown>): { command: string; arguments: string; workingDirectory: string };
  install(options: Record<string, unknown>, deps: Record<string, unknown>): { dryRun: boolean; config: Record<string, any>; xml: string };
  resolveCurrentAccount(runner: (file: string, args: string[]) => Record<string, unknown>, options?: Record<string, unknown>): { name: string; sid: string };
  verifyRegisteredTask(taskName: string, account: { name: string; sid: string }, schtasks: (file: string, args: string[]) => Record<string, unknown>): { userId: string };
  whoamiPath(options?: Record<string, unknown>): string;
  uninstall(config: Record<string, any>, options: Record<string, unknown>, deps: Record<string, unknown>): { removed: boolean };
  purge(config: Record<string, any>, configPath: string, options: Record<string, unknown>, deps: Record<string, unknown>): Promise<{ purged: boolean }>;
  healStaleGitLocks(clonePath: string, options?: Record<string, unknown>): {
    removed: Array<{ path: string; ageMs: number }>; tooYoung: Array<{ path: string; ageMs: number }>;
    failed: Array<{ path: string }>; refused: string | null;
  };
  collectStatus(config: Record<string, any>): Record<string, any>;
  formatStatus(status: Record<string, any>): string;
  STALE_LOCK_MINUTES: number;
};
type Lock = { release(): Promise<void> };
const acquire = acquirePublishLock as (name: string, options?: Record<string, unknown>) => Promise<Lock>;

const SCRIPTS_DIR = resolve(__dirname, '../scripts');
const WATCH_SCRIPT = join(SCRIPTS_DIR, 'dev-deploy-watch.mjs');
const LOCK_SCRIPT = join(SCRIPTS_DIR, 'rv-publish-lock.mjs');
const NOTIFY_SCRIPT = join(SCRIPTS_DIR, 'rv-notify.mjs');
const PROC_SCRIPT = join(SCRIPTS_DIR, 'lib', 'rv-proc.mjs');
const DOTENV_SCRIPT = join(SCRIPTS_DIR, 'lib', 'rv-dotenv.mjs');
const isWindows = process.platform === 'win32';
const unique = (label: string) => `rv-test-488-${label}-${process.pid}-${randomBytes(4).toString('hex')}`;
const MINUTE = 60_000;

// ─── B — decision logic ───────────────────────────────────────────────────

describe('dev-deploy-watch — decision logic (plan-488 §9 B)', () => {
  const P1: Pair = { web: 'a'.repeat(40), private: 'b'.repeat(40) };
  const t0 = 1_000_000_000_000;

  it('an unchanged pair deploys nothing', () => {
    const state = { ...W.freshState(), lastDeployed: P1 };
    expect(W.decideTick(state, P1, t0)).toMatchObject({ action: 'none', reason: 'up-to-date' });
  });

  it('a new web SHA deploys; a new private SHA alone deploys too', () => {
    const state = { ...W.freshState(), lastDeployed: P1 };
    expect(W.decideTick(state, { ...P1, web: 'c'.repeat(40) }, t0).action).toBe('deploy');
    expect(W.decideTick(state, { ...P1, private: 'd'.repeat(40) }, t0).action).toBe('deploy');
    expect(W.decideTick(null, P1, t0)).toMatchObject({ action: 'deploy', reason: 'new-pair' });
  });

  it('the reservation carries attempts + 1, nextRetryAt and inFlight before anything runs', () => {
    const decision = W.decideTick(W.freshState(), P1, t0);
    expect(decision.state.attempt).toMatchObject({ pair: P1, attempts: 1, status: 'in-flight', nextRetryAt: t0 + 3 * MINUTE });
    expect(decision.state.inFlight).toMatchObject({ pair: P1, startedAt: t0 });
  });

  it('a failure backs off: no attempt before the wait is over, one after it (3 / 15 min)', () => {
    let state = W.decideTick(W.freshState(), P1, t0).state;
    state = W.recordResult(state, P1, { ok: false, finishedAt: t0 + MINUTE, exitCode: 1 });
    expect(state.attempt).toMatchObject({ attempts: 1, status: 'backoff', nextRetryAt: t0 + MINUTE + 3 * MINUTE });
    expect(W.decideTick(state, P1, t0 + 3 * MINUTE)).toMatchObject({ action: 'none', reason: 'backoff' });
    const second = W.decideTick(state, P1, t0 + 4 * MINUTE);
    expect(second).toMatchObject({ action: 'deploy', reason: 'retry' });
    expect(second.state.attempt!.attempts).toBe(2);

    state = W.recordResult(second.state, P1, { ok: false, finishedAt: t0 + 5 * MINUTE, exitCode: 1 });
    expect(state.attempt!.nextRetryAt).toBe(t0 + 5 * MINUTE + 15 * MINUTE);
    expect(W.decideTick(state, P1, t0 + 19 * MINUTE).action).toBe('none');
    expect(W.decideTick(state, P1, t0 + 21 * MINUTE).action).toBe('deploy');
    expect(W.BACKOFF_MS).toEqual([3 * MINUTE, 15 * MINUTE, 60 * MINUTE]);
  });

  it('after 3 attempts the pair is failed and nothing more happens; --retry resets it', () => {
    let state: State = W.freshState();
    let now = t0;
    for (let i = 1; i <= W.MAX_ATTEMPTS; i++) {
      const decision = W.decideTick(state, P1, now);
      expect(decision.action).toBe('deploy');
      state = W.recordResult(decision.state, P1, { ok: false, finishedAt: now + MINUTE, exitCode: 1 });
      now += 2 * 60 * MINUTE;
    }
    expect(state.attempt).toMatchObject({ attempts: 3, status: 'failed', nextRetryAt: null });
    expect(W.summarizeStatus(state)).toBe('failed');
    expect(W.decideTick(state, P1, now + 24 * 60 * MINUTE)).toMatchObject({ action: 'none', reason: 'failed' });

    const retried = W.applyRetry(state);
    expect(retried.changed).toBe(true);
    const decision = W.decideTick(retried.state, P1, now);
    expect(decision).toMatchObject({ action: 'deploy' });
    expect(decision.state.attempt!.attempts).toBe(1);
    expect(W.applyRetry(W.freshState()).changed).toBe(false);
  });

  it('a watcher that died during the last attempt gives up instead of deploying a fourth time', () => {
    let state: State = W.freshState();
    let now = t0;
    for (let i = 1; i < W.MAX_ATTEMPTS; i++) {
      state = W.recordResult(W.decideTick(state, P1, now).state, P1, { ok: false, finishedAt: now, exitCode: 1 });
      now += 2 * 60 * MINUTE;
    }
    const third = W.decideTick(state, P1, now); // reserved, then the watcher was killed
    expect(third.state.attempt!.attempts).toBe(3);
    const after = W.decideTick(third.state, P1, now + 2 * 60 * MINUTE);
    expect(after.action).toBe('give-up');
    expect(after.state.attempt!.status).toBe('failed');
  });

  it('a new pair after failed resets the counter and deploys', () => {
    let state: State = W.freshState();
    for (let i = 0; i < W.MAX_ATTEMPTS; i++) state = W.recordResult(W.decideTick(state, P1, t0 + i * 99 * MINUTE).state, P1, { ok: false, finishedAt: t0 + i * 99 * MINUTE, exitCode: 1 });
    expect(W.summarizeStatus(state)).toBe('failed');
    const P2 = { ...P1, web: 'e'.repeat(40) };
    const decision = W.decideTick(state, P2, t0 + 400 * MINUTE);
    expect(decision).toMatchObject({ action: 'deploy', reason: 'new-pair' });
    expect(decision.state.attempt!.attempts).toBe(1);
    const ok = W.recordResult(decision.state, P2, { ok: true, finishedAt: t0 + 401 * MINUTE, exitCode: 0 });
    expect(ok.lastDeployed).toEqual(P2);
    expect(ok.attempt).toBeNull();
    expect(W.summarizeStatus(ok)).toBe('deployed');
  });
});

// ─── Fixtures for C ───────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'rv488 test', GIT_AUTHOR_EMAIL: 'rv488@test.invalid',
  GIT_COMMITTER_NAME: 'rv488 test', GIT_COMMITTER_EMAIL: 'rv488@test.invalid',
  GIT_TERMINAL_PROMPT: '0',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString().trim();

//! The deploy stand-in committed into the fixture web repo as scripts/bunny-deploy.mjs. It records
//! what the watcher handed it and then behaves as the control file says.
const STUB_DEPLOY = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
const control = JSON.parse(readFileSync(process.env.RV488_STUB_CONTROL, 'utf8'));
const head = (dir) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
appendFileSync(control.record, JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(),
  web: head(process.cwd()), private: head(control.privateClone),
  hasStorageKey: !!process.env.BUNNY_STORAGE_KEY, workspaceRoot: process.env.RV_WORKSPACE_ROOT,
  prepublish: process.env.RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS,
}) + '\\n');
// exit 1 = a failed deploy. Exit 3 means "deployed, demo smoke red" since plan-503
// (tests/dev-deploy-watch-smoke.node.test.ts).
if (control.mode === 'fail') process.exit(1);
if (control.mode === 'hold') {
  const server = net.createServer();
  server.listen(control.pipePath, () => writeFileSync(control.ready, String(process.pid)));
  setTimeout(() => {}, 120000);
} else if (control.mode === 'grandchild') {
  writeFileSync(control.ready, String(process.pid));
  execFileSync('"' + process.execPath + '" "' + control.grandchildScript + '"', { shell: true, stdio: 'ignore', env: process.env });
}
`;

const GRANDCHILD = `
require('fs').writeFileSync(process.env.RV488_GRANDCHILD_PID, String(process.pid));
setTimeout(() => {}, 60000);
`;

type Fixture = {
  base: string;
  root: string;
  configPath: string;
  config: Record<string, any>;
  bare: Pair;
  seeds: Pair;
  commit(repo: 'web' | 'private', file: string, content: string): string;
  control(mode: string, extra?: Record<string, unknown>): Record<string, any>;
  records(): Array<Record<string, any>>;
  state(): State | null;
  log(): string;
};

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'rv488-watch-')));
  const bare = { web: join(base, 'origin-web.git'), private: join(base, 'origin-private.git') };
  const seeds = { web: join(base, 'seed-web'), private: join(base, 'seed-private') };
  for (const repo of ['web', 'private'] as const) {
    git(base, 'init', '--bare', '--quiet', '-b', 'main', bare[repo]);
    mkdirSync(seeds[repo]);
    git(seeds[repo], 'init', '--quiet', '-b', 'main');
    git(seeds[repo], 'config', 'core.autocrlf', 'false');
    writeFileSync(join(seeds[repo], 'README.md'), `${repo}\n`);
    if (repo === 'web') {
      mkdirSync(join(seeds.web, 'scripts'));
      writeFileSync(join(seeds.web, 'scripts', 'bunny-deploy.mjs'), STUB_DEPLOY);
    }
    git(seeds[repo], 'add', '-A');
    git(seeds[repo], 'commit', '--quiet', '-m', 'seed');
    git(seeds[repo], 'remote', 'add', 'origin', bare[repo]);
    git(seeds[repo], 'push', '--quiet', 'origin', 'main');
  }
  const root = join(base, 'root');
  mkdirSync(join(root, 'clones'), { recursive: true });
  const clones = { web: join(root, 'clones', W.CLONE_DIRS.web), private: join(root, 'clones', W.CLONE_DIRS.private) };
  git(base, 'clone', '--quiet', bare.web, clones.web);
  git(base, 'clone', '--quiet', bare.private, clones.private);
  const credentials = join(base, 'credentials.env');
  writeFileSync(credentials, 'BUNNY_STORAGE_KEY=secret-key-value-488\nBUNNY_STORAGE_ZONE=secret-zone-value-488\n');
  writeFileSync(join(base, 'grandchild.cjs'), GRANDCHILD);
  const config = {
    version: 1,
    root,
    clones,
    credentialsFiles: [credentials],
    nodePath: process.execPath,
    workspaceRoot: base,
    watcherLockName: unique('watcher'),
    taskName: unique('task'),
    deployArgs: ['--demo', '--path', 'dev'],
    fetchTimeoutMs: 120000,
    prepublishTimeoutSeconds: 900,
    branch: 'main',
  };
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(join(root, 'enabled'), '');
  const recordPath = join(base, 'records.jsonl');
  return {
    base, root, configPath, config: W.loadWatcherConfig(configPath), bare, seeds,
    commit(repo, file, content) {
      writeFileSync(join(seeds[repo], file), content);
      git(seeds[repo], 'add', '-A');
      git(seeds[repo], 'commit', '--quiet', '-m', `change ${file}`);
      git(seeds[repo], 'push', '--quiet', 'origin', 'main');
      return git(seeds[repo], 'rev-parse', 'HEAD');
    },
    control(mode, extra = {}) {
      const control = {
        mode, record: recordPath, privateClone: clones.private, ready: join(base, `ready-${randomBytes(3).toString('hex')}`),
        grandchildScript: join(base, 'grandchild.cjs'), ...extra,
      };
      const path = join(base, 'control.json');
      writeFileSync(path, JSON.stringify(control));
      process.env.RV488_STUB_CONTROL = path;
      return control;
    },
    records() {
      return existsSync(recordPath) ? readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    state() {
      const path = join(root, 'state.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    },
    log() {
      const path = join(root, 'watch.log');
      return existsSync(path) ? readFileSync(path, 'utf8') : '';
    },
  };
}

const trackedPids: number[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hardKill = (pid: number) => { try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* gone */ } };
async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 20000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const readPid = (path: string) => (existsSync(path) ? Number(readFileSync(path, 'utf8')) || null : null);
const originMain = (clone: string) => git(clone, 'rev-parse', 'refs/remotes/origin/main');

function spawnWatcher(fx: Fixture, script = WATCH_SCRIPT): ChildProcess {
  const child = spawn(process.execPath, [script, '--config', fx.configPath], {
    env: { ...process.env }, stdio: 'ignore', windowsHide: true,
  });
  if (child.pid) trackedPids.push(child.pid);
  return child;
}

// ─── C — operating contract ───────────────────────────────────────────────

// Every case clones real git fixtures and spawns child processes: 3–10 s each on an idle
// machine, so the 5 s default fails them under any parallel load.
describe.skipIf(!isWindows)('dev-deploy-watch — operating contract (plan-488 §9 C)', { timeout: 60_000 }, () => {
  let fx: Fixture;
  const savedControl = process.env.RV488_STUB_CONTROL;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => {
    for (const pid of trackedPids.splice(0)) if (alive(pid)) hardKill(pid);
    if (savedControl === undefined) delete process.env.RV488_STUB_CONTROL; else process.env.RV488_STUB_CONTROL = savedControl;
    try { chmodSync(join(fx.root, 'state.json'), 0o666); } catch { /* not there */ }
    rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('a first tick deploys the captured pair from the clone; the next tick is idle; a private-only push deploys again', async () => {
    fx.control('ok');
    const first = await W.runTick(fx.config);
    expect(first.outcome).toBe('deployed');
    const [record] = fx.records();
    expect(record.argv).toEqual(['--demo', '--path', 'dev']);
    expect(resolve(record.cwd).toLowerCase()).toBe(resolve(fx.config.clones.web).toLowerCase());
    expect({ web: record.web, private: record.private }).toEqual(first.pair);
    expect(record.hasStorageKey).toBe(true);
    expect(record.workspaceRoot).toBe(fx.base);
    expect(record.prepublish).toBe('900');
    expect(fx.state()!.lastDeployed).toEqual(first.pair);

    expect((await W.runTick(fx.config)).outcome).toBe('idle');
    expect(fx.records()).toHaveLength(1);

    const privateSha = fx.commit('private', 'b.txt', 'private only');
    const third = await W.runTick(fx.config);
    expect(third.outcome).toBe('deployed');
    expect(fx.records().at(-1)!.private).toBe(privateSha);

    // Credential values never reach the log — only their presence.
    const log = fx.log();
    expect(log).toMatch(/BUNNY_STORAGE_KEY=present/);
    expect(log).not.toContain('secret-key-value-488');
    expect(log).not.toContain('secret-zone-value-488');
    expect(log).toMatch(/DEPLOY OK web=\w+ private=\w+ duration=/);
  });

  it('only one of the two fetches fails → no reset, no deploy, state unchanged', async () => {
    fx.control('ok');
    await W.runTick(fx.config);
    const stateBefore = readFileSync(join(fx.root, 'state.json'), 'utf8');
    const webHeadBefore = git(fx.config.clones.web, 'rev-parse', 'HEAD');
    fx.commit('web', 'a.txt', 'moved');
    git(fx.config.clones.private, 'remote', 'set-url', 'origin', join(fx.base, 'no-such-origin.git'));

    expect((await W.runTick(fx.config)).outcome).toBe('fetch-failed');
    expect(git(fx.config.clones.web, 'rev-parse', 'HEAD')).toBe(webHeadBefore);
    expect(fx.records()).toHaveLength(1);
    // plan-547: the only change is the fetch-failure streak counter.
    expect(fx.state()).toEqual({ ...JSON.parse(stateBefore), fetchFailures: 1 });
    expect(fx.log()).toMatch(/FETCH FAILED private:/);
  });

  it('clones end up exactly on the CAPTURED pair even when origin moved on meanwhile', async () => {
    fx.control('ok');
    const captured = git(fx.seeds.web, 'rev-parse', 'HEAD');
    let later = '';
    const result = await W.runTick(fx.config, { afterCapture: async () => { later = fx.commit('web', 'late.txt', 'pushed after the capture'); } });
    expect(result.outcome).toBe('deployed');
    expect(later).not.toBe(captured);
    expect(result.pair!.web).toBe(captured);
    expect(fx.records()[0].web).toBe(captured);
    expect(git(fx.config.clones.web, 'rev-parse', 'HEAD')).toBe(captured);
  });

  it('refuses git reset --hard outside the config.json clone paths — also through a junction', () => {
    const outside = join(fx.base, 'seed-web');
    expect(() => W.assertResetTarget(outside, fx.config)).toThrow(/not one of the clone paths/);

    const junction = join(fx.base, 'junction-to-seed');
    symlinkSync(outside, junction, 'junction');
    expect(() => W.assertResetTarget(junction, fx.config)).toThrow(/not one of the clone paths/);

    // A configured clone path that is itself a junction to somewhere else is refused as well.
    const redirected = { ...fx.config, clones: { ...fx.config.clones, web: junction } };
    expect(() => W.assertResetTarget(junction, redirected)).toThrow(/resolves to/);

    expect(W.assertResetTarget(fx.config.clones.web, fx.config)).toBe(resolve(fx.config.clones.web));
  });

  it('a busy watcher pipe ends the tick before any fetch', async () => {
    fx.control('ok');
    const before = originMain(fx.config.clones.web);
    fx.commit('web', 'a.txt', 'moved');
    const held = await acquire(fx.config.watcherLockName, { timeoutMs: 0 });
    try {
      expect((await W.runTick(fx.config)).outcome).toBe('watcher-busy');
    } finally {
      await held.release();
    }
    expect(originMain(fx.config.clones.web)).toBe(before);
    expect(fx.records()).toHaveLength(0);
  });

  it('the attempt is reserved before the child starts; the child dies with a hard-killed watcher and the next tick counts that attempt', async () => {
    const pipeName = unique('stub-publish');
    const control = fx.control('hold', { pipePath: `\\\\.\\pipe\\${pipeName}` });
    const watcher = spawnWatcher(fx);
    const childPid = await waitFor(() => readPid(control.ready), 30000, 'deploy child holding its pipe');
    trackedPids.push(childPid);

    // Reserved before the start: attempt 1 is on disk while the child runs.
    expect(fx.state()!.attempt).toMatchObject({ attempts: 1, status: 'in-flight' });
    expect(fx.state()!.inFlight).toBeTruthy();
    await expect(acquire(pipeName, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'RV_LOCK_BUSY' });

    hardKill(watcher.pid!);
    await waitFor(() => watcher.exitCode !== null || watcher.signalCode !== null, 10000, 'watcher exit');
    await waitFor(() => !alive(childPid), 10000, 'deploy child to die with the watcher');
    const pipe = await acquire(pipeName, { timeoutMs: 0 });
    await pipe.release();

    fx.control('fail');
    const next = await W.runTick(fx.config, { now: () => Date.now() + 4 * MINUTE });
    expect(next.outcome).toBe('deploy-failed');
    expect(fx.state()!.attempt).toMatchObject({ attempts: 2, status: 'backoff' });
  }, 60000);

  it('real call path: a grandchild started through execFileSync with shell: true — survival recorded, no pipe, no clone writes', async () => {
    const grandchildPidFile = join(fx.base, 'grandchild.pid');
    process.env.RV488_GRANDCHILD_PID = grandchildPidFile;
    const control = fx.control('grandchild');
    try {
      const watcher = spawnWatcher(fx);
      const childPid = await waitFor(() => readPid(control.ready), 30000, 'deploy child');
      trackedPids.push(childPid);
      const grandchildPid = await waitFor(() => readPid(grandchildPidFile), 30000, 'grandchild');
      trackedPids.push(grandchildPid);

      hardKill(watcher.pid!);
      await waitFor(() => !alive(childPid), 10000, 'deploy child to die with the watcher');
      await new Promise((r) => setTimeout(r, 500));
      const survived = alive(grandchildPid);
      // Recorded, not asserted either way (plan-488 R13): the plan only requires the consequences below.
      console.info(`[plan-488 R13] grandchild via execFileSync+shell ${survived ? 'SURVIVED' : 'died with'} the killed watcher`);

      // It holds no publish pipe of this target and wrote nothing into the clones.
      const lock = await acquire(`rv-publish-${unique('zone')}:dev`, { timeoutMs: 0 });
      await lock.release();
      expect(git(fx.config.clones.web, 'status', '--porcelain')).toBe('');
      expect(git(fx.config.clones.private, 'status', '--porcelain')).toBe('');
    } finally {
      delete process.env.RV488_GRANDCHILD_PID;
    }
  }, 60000);

  it('state.json not writable → no deploy child is started', async () => {
    fx.control('ok');
    writeFileSync(join(fx.root, 'state.json'), JSON.stringify(W.freshState()));
    chmodSync(join(fx.root, 'state.json'), 0o444);
    const result = await W.runTick(fx.config);
    expect(result.outcome).toBe('state-unwritable');
    expect(fx.records()).toHaveLength(0);
    expect(fx.log()).toMatch(/STATE NOT WRITABLE/);
  });

  it('state.json missing → fresh state, attempts = 1, deploy', async () => {
    fx.control('fail');
    expect(fx.state()).toBeNull();
    expect((await W.runTick(fx.config)).outcome).toBe('deploy-failed');
    expect(fx.records()).toHaveLength(1);
    expect(fx.state()!.attempt).toMatchObject({ attempts: 1, status: 'backoff' });
  });

  it('state.json with invalid JSON → moved to state.corrupt-*, fresh state, deploy', async () => {
    fx.control('fail');
    writeFileSync(join(fx.root, 'state.json'), '{ not json');
    expect((await W.runTick(fx.config)).outcome).toBe('deploy-failed');
    const corrupt = readdirSync(fx.root).filter((name) => name.startsWith('state.corrupt-'));
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(fx.root, corrupt[0]), 'utf8')).toBe('{ not json');
    expect(fx.state()!.attempt).toMatchObject({ attempts: 1 });
    expect(fx.log()).toMatch(/STATE CORRUPT/);
  });

  it('a repeated read error over several ticks → no deploy and no counter reset', async () => {
    fx.control('fail');
    await W.runTick(fx.config); // attempt 1 booked
    fx.commit('web', 'x.txt', 'irrelevant');
    const before = readFileSync(join(fx.root, 'state.json'), 'utf8');
    const stateFs = {
      readFileSync: () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); },
      writeFileSync, renameSync,
      unlinkSync: (p: string) => rmSync(p, { force: true }),
    };
    for (let i = 0; i < 3; i++) {
      expect((await W.runTick(fx.config, { stateFs, now: () => Date.now() + (i + 1) * 90 * MINUTE })).outcome).toBe('state-unreadable');
    }
    expect(fx.records()).toHaveLength(1);
    expect(readFileSync(join(fx.root, 'state.json'), 'utf8')).toBe(before);
    expect(fx.log().match(/STATE UNREADABLE/g)).toHaveLength(3);
  });

  it('a failing deploy child counts as a failed attempt; three of them give up (GIVING UP) — the pre-publish limit rides along as env', async () => {
    fx.control('fail');
    let now = Date.now();
    for (let i = 0; i < 3; i++) {
      expect((await W.runTick(fx.config, { now: () => now })).outcome).toBe('deploy-failed');
      now += 2 * 60 * MINUTE;
    }
    expect(fx.state()!.attempt).toMatchObject({ attempts: 3, status: 'failed' });
    expect(fx.log()).toMatch(/GIVING UP/);
    expect((await W.runTick(fx.config, { now: () => now })).outcome).toBe('idle');
    expect(fx.records()).toHaveLength(3);
    expect(fx.records().every((r) => r.prepublish === '900')).toBe(true);
  });

  it('switch off → no fetch, no deploy', async () => {
    fx.control('ok');
    rmSync(join(fx.root, 'enabled'));
    const before = originMain(fx.config.clones.web);
    fx.commit('web', 'a.txt', 'moved');
    expect((await W.runTick(fx.config)).outcome).toBe('disabled');
    expect(originMain(fx.config.clones.web)).toBe(before);
    expect(fx.records()).toHaveLength(0);
  });

  it('missing required credentials → abort without deploy, no values in the log', async () => {
    fx.control('ok');
    writeFileSync(fx.config.credentialsFiles[0], 'BUNNY_STORAGE_ZONE=secret-zone-value-488\n');
    const result = await W.runTick(fx.config);
    expect(result.outcome).toBe('credentials-missing');
    expect(fx.records()).toHaveLength(0);
    expect(fx.state()).toBeNull();
    expect(fx.log()).toMatch(/credentials missing: BUNNY_STORAGE_KEY/);
    expect(fx.log()).not.toContain('secret-zone-value-488');
  });

  it('the installed copy is self-contained: it runs from a folder with no repository around it', () => {
    const bin = join(fx.base, 'installed', 'bin');
    mkdirSync(join(bin, 'lib'), { recursive: true });
    copyFileSync(WATCH_SCRIPT, join(bin, 'dev-deploy-watch.mjs'));
    copyFileSync(LOCK_SCRIPT, join(bin, 'rv-publish-lock.mjs'));
    copyFileSync(NOTIFY_SCRIPT, join(bin, 'rv-notify.mjs'));
    copyFileSync(PROC_SCRIPT, join(bin, 'lib', 'rv-proc.mjs'));
    copyFileSync(DOTENV_SCRIPT, join(bin, 'lib', 'rv-dotenv.mjs'));
    const output = execFileSync(process.execPath, [join(bin, 'dev-deploy-watch.mjs'), '--status', '--config', fx.configPath], { windowsHide: true }).toString();
    expect(output).toMatch(/switch\s+: enabled/);

    // plan-503 / plan-587: the watcher may import exactly these four local files, and every one
    // of them is copied by --install (INSTALLED_FILES). The helpers themselves import nothing
    // but `node:` — rv-dotenv.mjs imports nothing at all, which is checked separately below
    // because "at least one import" is the regex-still-works guard for the other four.
    const allowed = ['./rv-publish-lock.mjs', './rv-notify.mjs', './lib/rv-proc.mjs', './lib/rv-dotenv.mjs'];
    const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    for (const file of [WATCH_SCRIPT, LOCK_SCRIPT, NOTIFY_SCRIPT, PROC_SCRIPT]) {
      const imports = importsOf(file);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((spec) => !spec.startsWith('node:') && !allowed.includes(spec))).toEqual([]);
    }
    // rv-dotenv.mjs is pure string handling: zero imports, so self-containment is trivially true.
    expect(importsOf(DOTENV_SCRIPT)).toEqual([]);
    expect(W.INSTALLED_FILES).toEqual(['dev-deploy-watch.mjs', 'rv-publish-lock.mjs', 'rv-notify.mjs', 'lib/rv-proc.mjs', 'lib/rv-dotenv.mjs']);
  });

  it('--retry resets the counter of a failed pair through the CLI', async () => {
    fx.control('fail');
    let now = Date.now();
    for (let i = 0; i < 3; i++) { await W.runTick(fx.config, { now: () => now }); now += 2 * 60 * MINUTE; }
    execFileSync(process.execPath, [WATCH_SCRIPT, '--retry', '--config', fx.configPath], { windowsHide: true });
    expect(fx.state()!.attempt).toMatchObject({ attempts: 0, status: 'pending' });
    const status = JSON.parse(execFileSync(process.execPath, [WATCH_SCRIPT, '--status', '--json', '--config', fx.configPath], { windowsHide: true }).toString());
    expect(status.status).toBe('pending');
    fx.control('ok');
    expect((await W.runTick(fx.config)).outcome).toBe('deployed');
  });
});

// ─── plan-547 — stale git locks, blocked/fetch notifications ─────────────

const HOUR_AGO = () => new Date(Date.now() - 60 * MINUTE);
//! Writes an empty lock file; `stale` sets its mtime back one hour.
function plantLock(path: string, stale = true) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, '');
  if (stale) utimesSync(path, HOUR_AGO(), HOUR_AGO());
}

describe('dev-deploy-watch — healStaleGitLocks (plan-547 §9)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv547-heal-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('removes stale locks of every glob, keeps a fresh one, logs a stale gc.pid and never walks loose objects', () => {
    const g = join(dir, 'clone-x', '.git');
    plantLock(join(g, 'index.lock'));
    plantLock(join(g, 'refs', 'heads', 'main.lock'));
    plantLock(join(g, 'refs', 'remotes', 'origin', 'main.lock'));
    plantLock(join(g, 'objects', 'info', 'commit-graph.lock'));
    plantLock(join(g, 'objects', 'info', 'commit-graphs', 'commit-graph-chain.lock'));
    plantLock(join(g, 'objects', 'pack', 'pack-1.lock'));
    plantLock(join(g, 'objects', 'ab', 'loose.lock'));           // loose-object dir: not walked
    plantLock(join(g, 'HEAD.lock'), false);                       // fresh: kept
    plantLock(join(g, 'gc.pid'));                                  // stale gc.pid: logged only
    const lines: string[] = [];
    const result = W.healStaleGitLocks(join(dir, 'clone-x'), { log: (l: string) => lines.push(l) });

    expect(result.removed.map((r) => r.path).sort()).toEqual([
      'clone-x/.git/index.lock', 'clone-x/.git/objects/info/commit-graph.lock',
      'clone-x/.git/objects/info/commit-graphs/commit-graph-chain.lock', 'clone-x/.git/objects/pack/pack-1.lock',
      'clone-x/.git/refs/heads/main.lock', 'clone-x/.git/refs/remotes/origin/main.lock',
    ]);
    expect(result.tooYoung.map((r) => r.path)).toEqual(['clone-x/.git/HEAD.lock']);
    expect(existsSync(join(g, 'index.lock'))).toBe(false);
    expect(existsSync(join(g, 'HEAD.lock'))).toBe(true);
    expect(existsSync(join(g, 'objects', 'ab', 'loose.lock'))).toBe(true);
    expect(existsSync(join(g, 'gc.pid'))).toBe(true);
    expect(lines).toContain('STALE LOCK REMOVED clone-x/.git/index.lock age=60m');
    expect(lines).toContain('STALE LOCK REMOVED clone-x/.git/refs/heads/main.lock age=60m');
    expect(lines.some((l) => /^STALE GC PID clone-x\/\.git\/gc\.pid age=60m/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('HEAD.lock'))).toBe(false);
  });

  it('honours the threshold, and force removes young locks tagged (after kill)', () => {
    const g = join(dir, 'c', '.git');
    plantLock(join(g, 'index.lock'));
    expect(W.healStaleGitLocks(join(dir, 'c'), { maxAgeMs: 2 * 60 * MINUTE }).tooYoung).toHaveLength(1);
    expect(existsSync(join(g, 'index.lock'))).toBe(true);
    plantLock(join(g, 'shallow.lock'), false);
    const lines: string[] = [];
    const forced = W.healStaleGitLocks(join(dir, 'c'), { force: true, log: (l: string) => lines.push(l) });
    expect(forced.removed).toHaveLength(2);
    expect(lines).toContain('STALE LOCK REMOVED c/.git/shallow.lock age=0m (after kill)');
  });

  it('a folder without .git is a no-op', () => {
    plantLock(join(dir, 'plain', 'index.lock'));
    expect(W.healStaleGitLocks(join(dir, 'plain'))).toEqual({ removed: [], tooYoung: [], failed: [], refused: null });
    expect(W.healStaleGitLocks(join(dir, 'missing'))).toEqual({ removed: [], tooYoung: [], failed: [], refused: null });
    expect(existsSync(join(dir, 'plain', 'index.lock'))).toBe(true);
    expect(W.STALE_LOCK_MINUTES).toBe(10);
  });

  it('--status shows fetch fails only when > 0', () => {
    const base = { root: 'r', enabled: true, status: 'idle', stateFile: 'ok', lastDeployed: null, attempt: null, lastResult: null, lastSmoke: null, runtime: null };
    expect(W.formatStatus({ ...base, fetchFailures: 0 })).not.toMatch(/fetch fails/);
    expect(W.formatStatus({ ...base, fetchFailures: 4 })).toMatch(/ {2}fetch fails : 4/);
  });
});

describe.skipIf(!isWindows)('dev-deploy-watch — self-heal and notifications (plan-547 §9)', { timeout: 60_000 }, () => {
  let fx: Fixture;
  let notes: Array<{ title: string; body: string }>;
  const savedControl = process.env.RV488_STUB_CONTROL;
  const notify = (title: string, body: string) => { notes.push({ title, body }); return { ok: true }; };
  const webLock = (...parts: string[]) => join(fx.config.clones.web, '.git', ...parts);
  const statePath = () => join(fx.root, 'state.json');
  beforeEach(() => { fx = makeFixture(); notes = []; });
  afterEach(() => {
    for (const pid of trackedPids.splice(0)) if (alive(pid)) hardKill(pid);
    if (savedControl === undefined) delete process.env.RV488_STUB_CONTROL; else process.env.RV488_STUB_CONTROL = savedControl;
    try { chmodSync(statePath(), 0o666); } catch { /* not there */ }
    rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('stale locks in a clone are removed before the fetch and the tick deploys', async () => {
    fx.control('ok');
    fx.commit('web', 'a.txt', 'moved');
    plantLock(webLock('index.lock'));                               // would break git reset
    plantLock(webLock('refs', 'remotes', 'origin', 'main.lock'));  // would break git fetch
    plantLock(join(fx.config.clones.private, '.git', 'index.lock'));
    const result = await W.runTick(fx.config, { notify });
    expect(result.outcome).toBe('deployed');
    expect(existsSync(webLock('index.lock'))).toBe(false);
    expect(existsSync(webLock('refs', 'remotes', 'origin', 'main.lock'))).toBe(false);
    const log = fx.log();
    expect(log).toMatch(/STALE LOCK REMOVED realvirtual-WebViewer~\/\.git\/index\.lock age=60m/);
    expect(log).toMatch(/STALE LOCK REMOVED realvirtual-WebViewer~\/\.git\/refs\/remotes\/origin\/main\.lock age=60m/);
    expect(log).toMatch(/STALE LOCK REMOVED realvirtual-WebViewer-Private~\/\.git\/index\.lock age=60m/);
    expect(log.indexOf('STALE LOCK REMOVED')).toBeLessThan(log.indexOf('DEPLOY START'));
    expect(notes).toEqual([]);
  });

  it('a young lock ends the tick as git-locked before any attempt is reserved', async () => {
    fx.control('ok');
    plantLock(webLock('index.lock'), false);
    const result = await W.runTick(fx.config, { notify });
    expect(result.outcome).toBe('git-locked');
    expect(existsSync(webLock('index.lock'))).toBe(true);
    expect(fx.state()).toBeNull();
    expect(fx.records()).toHaveLength(0);
    expect(fx.log()).toMatch(/SKIP git-locked realvirtual-WebViewer~\/\.git\/index\.lock age=\d+s/);
  });

  it('a busy watcher lock removes nothing', async () => {
    plantLock(webLock('index.lock'));
    const held = await acquire(fx.config.watcherLockName, { timeoutMs: 0 });
    try {
      expect((await W.runTick(fx.config, { notify })).outcome).toBe('watcher-busy');
    } finally {
      await held.release();
    }
    expect(existsSync(webLock('index.lock'))).toBe(true);
    expect(fx.log()).not.toMatch(/STALE LOCK/);
  });

  it('the sweep refuses a path outside the configured clones and a junction (assertResetTarget)', () => {
    const outside = fx.seeds.web;
    plantLock(join(outside, '.git', 'index.lock'));
    const lines: string[] = [];
    const refused = W.healStaleGitLocks(outside, { config: fx.config, log: (l: string) => lines.push(l) });
    expect(refused.refused).toMatch(/not one of the clone paths/);
    expect(existsSync(join(outside, '.git', 'index.lock'))).toBe(true);
    expect(lines[0]).toMatch(/^LOCK SWEEP REFUSED Refusing the lock sweep/);

    const junction = join(fx.base, 'junction-to-seed');
    symlinkSync(outside, junction, 'junction');
    const redirected = { ...fx.config, clones: { ...fx.config.clones, web: junction } };
    expect(W.healStaleGitLocks(junction, { config: redirected }).refused).toMatch(/resolves to/);
    expect(existsSync(join(outside, '.git', 'index.lock'))).toBe(true);
  });

  it('a git killed on timeout has the locks of THAT clone removed (after kill)', async () => {
    fx.control('ok');
    // The fetch goes through an ssh "transport" that plants a lock and hangs until it is killed.
    const lock = webLock('index.lock').replace(/\\/g, '/');
    git(fx.config.clones.web, 'remote', 'set-url', 'origin', 'ssh://rv547.invalid/hang.git');
    git(fx.config.clones.web, 'config', 'core.sshCommand', `sh -c ': > "${lock}"; sleep 30' rv547`);
    const result = await W.runTick({ ...fx.config, fetchTimeoutMs: 3000 }, { notify });
    expect(result.outcome).toBe('fetch-failed');
    expect(fx.log()).toMatch(/FETCH FAILED web: git fetch timed out/);
    expect(fx.log()).toMatch(/STALE LOCK REMOVED realvirtual-WebViewer~\/\.git\/index\.lock age=0m \(after kill\)/);
    expect(existsSync(webLock('index.lock'))).toBe(false);
  }, 60000);

  it('GIVING UP after the third failed deploy notifies DEPLOY BLOCKED exactly once', async () => {
    fx.control('fail');
    let now = Date.now();
    for (let i = 0; i < 3; i++) {
      expect((await W.runTick(fx.config, { now: () => now, notify })).outcome).toBe('deploy-failed');
      if (i < 2) expect(notes).toEqual([]);
      now += 2 * 60 * MINUTE;
    }
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('realvirtual WEB /dev/ — DEPLOY BLOCKED');
    expect(notes[0].body).toMatch(/^web=\w+ private=\w+\nexit=1/);
    expect(notes[0].body).toMatch(/--retry/);
    expect((await W.runTick(fx.config, { now: () => now, notify })).outcome).toBe('idle');
    expect(notes).toHaveLength(1);
  });

  it('GIVING UP of a watcher that died in the last attempt notifies once — and not when the give-up was not stored', async () => {
    fx.control('ok');
    const pair = { web: git(fx.seeds.web, 'rev-parse', 'HEAD'), private: git(fx.seeds.private, 'rev-parse', 'HEAD') };
    const dead = { ...W.freshState(), attempt: { pair, attempts: 3, status: 'in-flight', startedAt: 1, nextRetryAt: 2 }, inFlight: { pair, startedAt: 1 } };
    writeFileSync(statePath(), JSON.stringify(dead));
    chmodSync(statePath(), 0o444);
    expect((await W.runTick(fx.config, { notify })).outcome).toBe('gave-up');
    expect(notes).toEqual([]);
    expect(fx.log()).toMatch(/STATE NOT WRITABLE give-up/);

    chmodSync(statePath(), 0o666);
    expect((await W.runTick(fx.config, { notify })).outcome).toBe('gave-up');
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('realvirtual WEB /dev/ — DEPLOY BLOCKED');
    expect(notes[0].body).toMatch(/never finished/);
    expect((await W.runTick(fx.config, { notify })).outcome).toBe('idle');
    expect(notes).toHaveLength(1);
    expect(fx.records()).toHaveLength(0);
  });

  it('a failing notify is logged as NOTIFY FAILED', async () => {
    fx.control('fail');
    let now = Date.now();
    for (let i = 0; i < 3; i++) {
      await W.runTick(fx.config, { now: () => now, notify: () => ({ ok: false, error: 'toast-broken' }) });
      now += 2 * 60 * MINUTE;
    }
    expect(fx.log()).toMatch(/NOTIFY FAILED toast-broken/);
  });

  // plan-587 §9.2 Test_DeployStep_NotifyThrow_DoesNotFailDeploy. Two of the four notification
  // sites used to be copies of sendNotification WITHOUT its try/catch, and one of them sits
  // inside the try of the deploy step: a throwing notify booked a deploy that had gone live as
  // a failure, used up an attempt and started a backoff.
  it('Test_DeployStep_NotifyThrow_DoesNotFailDeploy', async () => {
    fx.control('ok');
    fx.commit('web', 'notify-throw.txt', 'moved');
    const result = await W.runTick(fx.config, {
      notify: () => { throw new Error('toast exploded'); },
      // The runtime-failed notification is the one inside the deploy try.
      ensureRuntime: () => ({ runtime: null, action: 'failed', reason: 'browser-missing', error: 'no chromium' }),
    });
    expect(result.outcome).toBe('deployed');
    const state = fx.state()!;
    expect(state.lastDeployed).toEqual(result.pair);
    expect(state.attempt).toBeNull();
    expect(fx.log()).toMatch(/DEPLOY OK/);
    expect(fx.log()).toMatch(/NOTIFY FAILED toast exploded/);
  });

  it('three FETCH FAILED ticks notify once; a successful fetch resets the count; the next failure counts from 1', async () => {
    fx.control('ok');
    const goodUrl = git(fx.config.clones.private, 'remote', 'get-url', 'origin');
    git(fx.config.clones.private, 'remote', 'set-url', 'origin', join(fx.base, 'no-such-origin.git'));
    for (let i = 1; i <= 4; i++) {
      expect((await W.runTick(fx.config, { notify })).outcome).toBe('fetch-failed');
      expect(fx.state()!).toMatchObject({ fetchFailures: i });
      expect(notes).toHaveLength(i >= 3 ? 1 : 0);
    }
    expect(notes[0].title).toBe('realvirtual WEB /dev/ — FETCH FAILING');
    expect(notes[0].body).toMatch(/private: git fetch exit/);

    // --status (text + --json) carries the streak.
    expect(W.collectStatus(fx.config).fetchFailures).toBe(4);
    const text = execFileSync(process.execPath, [WATCH_SCRIPT, '--status', '--config', fx.configPath], { windowsHide: true }).toString();
    expect(text).toMatch(/fetch fails : 4/);
    const json = JSON.parse(execFileSync(process.execPath, [WATCH_SCRIPT, '--status', '--json', '--config', fx.configPath], { windowsHide: true }).toString());
    expect(json.fetchFailures).toBe(4);

    // A successful fetch resets it; the deploy reservation and the booking keep 0.
    git(fx.config.clones.private, 'remote', 'set-url', 'origin', goodUrl);
    expect((await W.runTick(fx.config, { notify })).outcome).toBe('deployed');
    expect(fx.state()!).toMatchObject({ fetchFailures: 0 });
    expect(fx.log()).toMatch(/FETCH RECOVERED after 4 failed ticks/);
    expect(W.formatStatus(W.collectStatus(fx.config))).not.toMatch(/fetch fails/);

    git(fx.config.clones.private, 'remote', 'set-url', 'origin', join(fx.base, 'no-such-origin.git'));
    expect((await W.runTick(fx.config, { notify })).outcome).toBe('fetch-failed');
    expect(fx.state()!).toMatchObject({ fetchFailures: 1 });
    expect(notes).toHaveLength(1);
  });

  it('an idle tick writes the reset of the streak', async () => {
    fx.control('ok');
    expect((await W.runTick(fx.config, { notify })).outcome).toBe('deployed');
    writeFileSync(statePath(), JSON.stringify({ ...fx.state(), fetchFailures: 2 }));
    expect((await W.runTick(fx.config, { notify })).outcome).toBe('idle');
    expect(fx.state()!).toMatchObject({ fetchFailures: 0 });
  });

  it('an unreadable or corrupt state in the fetch-fail branch counts nothing and notifies nothing', async () => {
    fx.control('ok');
    git(fx.config.clones.private, 'remote', 'set-url', 'origin', join(fx.base, 'no-such-origin.git'));
    const stateFs = {
      readFileSync: () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); },
      writeFileSync, renameSync, unlinkSync: (p: string) => rmSync(p, { force: true }),
    };
    for (let i = 0; i < 3; i++) expect((await W.runTick(fx.config, { notify, stateFs })).outcome).toBe('fetch-failed');
    expect(fx.state()).toBeNull();

    writeFileSync(statePath(), '{ not json');
    for (let i = 0; i < 3; i++) expect((await W.runTick(fx.config, { notify })).outcome).toBe('fetch-failed');
    expect(readFileSync(statePath(), 'utf8')).toBe('{ not json');   // left for the normal path, not renamed here
    expect(readdirSync(fx.root).filter((n) => n.startsWith('state.corrupt-'))).toEqual([]);
    expect(notes).toEqual([]);
  });
});

// ─── Phase 3 — install / uninstall / purge with an injected task runner ──────

describe.skipIf(!isWindows)('dev-deploy-watch — install, uninstall, purge (plan-488 Phase 3)', { timeout: 60_000 }, () => {
  let fx: Fixture;
  let canonicalWeb: string;
  let calls: string[][];
  let lines: string[];
  let queryStatus: number;
  let registeredPrincipal: string | null;
  let whoamiCalls: string[][];
  let whoamiResult: { status: number; stdout: string; stderr: string };
  const TEST_SID = 'S-1-12-1-1111111111-2222222222-333333333-4444444444';
  const schtasks = (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === '/Query' && args.includes('/XML')) {
      if (registeredPrincipal === null) return { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
      return { status: 0, stdout: `<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.2"><Principals><Principal id="Author"><UserId>${registeredPrincipal}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals></Task>`, stderr: '' };
    }
    if (args[0] === '/Query') return { status: queryStatus, stdout: '', stderr: '' };
    return { status: 0, stdout: 'SUCCESS', stderr: '' };
  };
  const whoami = (file: string, args: string[]) => { whoamiCalls.push([file, ...args]); return whoamiResult; };
  const deps = () => ({ schtasks, whoami, out: (line: string) => lines.push(line) });
  const verifyQuery = (taskName: string) => ['schtasks', '/Query', '/TN', taskName, '/XML'];

  beforeEach(() => {
    fx = makeFixture();
    calls = [];
    lines = [];
    queryStatus = 0;
    registeredPrincipal = TEST_SID;
    whoamiCalls = [];
    whoamiResult = { status: 0, stdout: `"testdomain\\tester","${TEST_SID}"`, stderr: '' };
    const ws = join(fx.base, 'ws');
    mkdirSync(join(ws, '.plastic'), { recursive: true });
    const assets = join(ws, 'game4automation', 'realvirtual', 'Assets');
    mkdirSync(assets, { recursive: true });
    canonicalWeb = join(assets, W.CLONE_DIRS.web);
    git(fx.base, 'clone', '--quiet', fx.bare.web, canonicalWeb);
    git(fx.base, 'clone', '--quiet', fx.bare.private, join(assets, W.CLONE_DIRS.private));
    git(canonicalWeb, 'config', 'core.autocrlf', 'input');
    copyFileSync(WATCH_SCRIPT, join(canonicalWeb, 'scripts', 'dev-deploy-watch.mjs'));
    copyFileSync(LOCK_SCRIPT, join(canonicalWeb, 'scripts', 'rv-publish-lock.mjs'));
    copyFileSync(NOTIFY_SCRIPT, join(canonicalWeb, 'scripts', 'rv-notify.mjs'));
    mkdirSync(join(canonicalWeb, 'scripts', 'lib'), { recursive: true });
    copyFileSync(PROC_SCRIPT, join(canonicalWeb, 'scripts', 'lib', 'rv-proc.mjs'));
    copyFileSync(DOTENV_SCRIPT, join(canonicalWeb, 'scripts', 'lib', 'rv-dotenv.mjs'));
    writeFileSync(join(canonicalWeb, '.env.production'), 'BUNNY_STORAGE_KEY=fixture\n');
  });
  afterEach(() => {
    rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const installRoot = () => join(fx.base, 'rv-dev-deploy');
  const options = (extra: Record<string, unknown> = {}) => ({ scriptDir: join(canonicalWeb, 'scripts'), env: {}, taskName: 'rv-test-488-task', ...extra });

  it('--dry-run prints the plan and changes nothing — no files, no clone, no task', () => {
    const result = W.install(options({ dryRun: true }), deps());
    expect(result.dryRun).toBe(true);
    expect(existsSync(installRoot())).toBe(false);
    expect(calls).toEqual([]);
    const text = lines.join('\n');
    expect(text).toMatch(/\[dry-run\] would git clone -c core\.autocrlf=input --branch main/);
    expect(text).toMatch(/\[dry-run\] would write .*config\.json/);
    expect(text).toMatch(/schtasks \/Create \/TN rv-test-488-task/);
    expect(text).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  it('installs: absolute config, clones with origin and autocrlf, bin copies, switch, task XML — and is idempotent', () => {
    const { config } = W.install(options(), deps());
    const root = installRoot();
    expect(config.root.toLowerCase()).toBe(realpathSync.native(root).toLowerCase());
    const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    for (const path of [written.root, written.clones.web, written.clones.private, written.nodePath, written.workspaceRoot, ...written.credentialsFiles]) {
      expect(resolve(path)).toBe(path);
    }
    expect(written.workspaceRoot).toBe(join(fx.base, 'ws'));
    expect(written.credentialsFiles).toEqual([join(canonicalWeb, '.env.production')]);
    expect(git(written.clones.web, 'remote', 'get-url', 'origin')).toBe(fx.bare.web);
    expect(git(written.clones.web, 'config', '--local', 'core.autocrlf')).toBe('input');
    expect(readFileSync(join(root, 'bin', 'dev-deploy-watch.mjs'), 'utf8')).toBe(readFileSync(WATCH_SCRIPT, 'utf8'));
    expect(existsSync(join(root, 'bin', 'rv-publish-lock.mjs'))).toBe(true);
    // plan-587: an INSTALLED_FILES entry with a subfolder lands in that subfolder, byte for byte.
    expect(readFileSync(join(root, 'bin', 'lib', 'rv-proc.mjs'), 'utf8')).toBe(readFileSync(PROC_SCRIPT, 'utf8'));
    expect(readFileSync(join(root, 'bin', 'lib', 'rv-dotenv.mjs'), 'utf8')).toBe(readFileSync(DOTENV_SCRIPT, 'utf8'));
    expect(existsSync(join(root, 'enabled'))).toBe(true);

    const xmlBytes = readFileSync(join(root, 'task.xml'));
    expect([xmlBytes[0], xmlBytes[1]]).toEqual([0xff, 0xfe]);
    const xml = xmlBytes.subarray(2).toString('utf16le');
    for (const needle of ['<LogonType>InteractiveToken</LogonType>', '<Interval>PT3M</Interval>', '<LogonTrigger>',
      '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '<WakeToRun>false</WakeToRun>', '<StartWhenAvailable>true</StartWhenAvailable>',
      'conhost.exe</Command>', `<WorkingDirectory>${config.root}</WorkingDirectory>`]) {
      expect(xml).toContain(needle);
    }
    expect(xml.split(`<UserId>${TEST_SID}</UserId>`)).toHaveLength(3);
    expect(xml).not.toMatch(/<UserId>[^<]*\+[^<]*<\/UserId>/);
    expect(calls).toEqual([['schtasks', '/Create', '/TN', 'rv-test-488-task', '/XML', join(config.root, 'task.xml'), '/F'], verifyQuery('rv-test-488-task')]);

    // The watcher as installed can read its own config.
    const status = execFileSync(process.execPath, [join(root, 'bin', 'dev-deploy-watch.mjs'), '--status', '--config', join(root, 'config.json')], { windowsHide: true }).toString();
    expect(status).toMatch(/switch\s+: enabled/);

    // Idempotent: a paused switch stays paused, an existing clone is kept, the task is re-registered.
    rmSync(join(root, 'enabled'));
    writeFileSync(join(written.clones.web, '.git', 'rv488-marker'), 'kept');
    calls = [];
    W.install(options(), deps());
    expect(existsSync(join(root, 'enabled'))).toBe(false);
    expect(existsSync(join(written.clones.web, '.git', 'rv488-marker'))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 2)).toEqual(['schtasks', '/Create']);
    expect(calls[1]).toEqual(verifyQuery('rv-test-488-task'));
  });

  it('task.xml carries the SID from whoami.exe at Principal and LogonTrigger, never a +-joined name', () => {
    whoamiResult = { status: 0, stdout: `"azuread\\thomasstrigl","${TEST_SID}"\r\n`, stderr: '' };
    const { xml } = W.install(options({ dryRun: true, systemRoot: 'C:\\Windows' }), deps());
    expect(whoamiCalls).toEqual([['C:\\Windows\\System32\\whoami.exe', '/user', '/fo', 'csv', '/nh']]);
    const principal = /<Principal\b[^>]*>([\s\S]*?)<\/Principal>/.exec(xml)![1];
    const logon = /<LogonTrigger>([\s\S]*?)<\/LogonTrigger>/.exec(xml)![1];
    expect(principal).toContain(`<UserId>${TEST_SID}</UserId>`);
    expect(logon).toContain(`<UserId>${TEST_SID}</UserId>`);
    expect(xml.match(/<UserId>[^<]*<\/UserId>/g)).toEqual([`<UserId>${TEST_SID}</UserId>`, `<UserId>${TEST_SID}</UserId>`]);
    expect(xml).not.toMatch(/\w\+\w/);
    expect(lines.join('\n')).toContain(`task        : rv-test-488-task as azuread\\thomasstrigl (${TEST_SID})`);
  });

  it('resolveCurrentAccount rejects a failing whoami and output without a SID (e.g. MSYS AzureAD+user)', () => {
    expect(W.resolveCurrentAccount(() => ({ status: 0, stdout: `"d\\u","${TEST_SID.toLowerCase()}"`, stderr: '' }))).toEqual({ name: 'd\\u', sid: TEST_SID });
    expect(() => W.resolveCurrentAccount(() => ({ status: 0, stdout: 'AzureAD+ThomasStrigl', stderr: '' }))).toThrow(/no SID/);
    expect(() => W.resolveCurrentAccount(() => ({ status: 1, stdout: '', stderr: 'boom' }))).toThrow(/Cannot determine the current account/);
    expect(() => W.resolveCurrentAccount(() => { throw new Error('ENOENT'); })).toThrow(/ENOENT/);
    expect(W.whoamiPath({ systemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\whoami.exe');
  });

  it('aborts --install before any git query, file operation or task call when the SID cannot be determined', () => {
    const gitCalls: string[][] = [];
    const gitRunner = (file: string, args: string[]) => { gitCalls.push([file, ...args]); return { status: 0, stdout: 'x', stderr: '' }; };
    for (const failing of [{ status: 1, stdout: '', stderr: 'denied' }, { status: 0, stdout: '"testdomain\\tester",""', stderr: '' }]) {
      whoamiResult = failing;
      for (const dryRun of [false, true]) {
        expect(() => W.install(options({ dryRun }), { ...deps(), git: gitRunner })).toThrow(/Cannot determine the current account/);
      }
    }
    expect(gitCalls).toEqual([]);
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
    expect(existsSync(installRoot())).toBe(false);
  });

  it('after a real registration a missing task or a different principal is an error', () => {
    registeredPrincipal = null;
    expect(() => W.install(options(), deps())).toThrow(/was not found after registration/);
    expect(calls.map((c) => c[1])).toEqual(['/Create', '/Query']);

    calls = [];
    registeredPrincipal = 'AzureAD+ThomasStrigl';
    expect(() => W.install(options(), deps())).toThrow(/is registered for "AzureAD\+ThomasStrigl", expected testdomain\\tester/);
    expect(calls.map((c) => c[1])).toEqual(['/Create', '/Query']);

    const account = { name: 'testdomain\\tester', sid: TEST_SID };
    registeredPrincipal = 'S-1-5-18';
    expect(() => W.verifyRegisteredTask('t', account, schtasks)).toThrow(/registered for "S-1-5-18"/);
    registeredPrincipal = TEST_SID.toLowerCase();
    expect(W.verifyRegisteredTask('t', account, schtasks).userId).toBe(TEST_SID.toLowerCase());
    registeredPrincipal = 'TESTDOMAIN\\tester';
    expect(W.verifyRegisteredTask('t', account, schtasks).userId).toBe('TESTDOMAIN\\tester');
  });

  it('the task action is a headless conhost around the absolute node path and the installed copy', () => {
    const action = W.taskAction({ root: 'D:\\rv-dev-deploy', nodePath: 'C:\\Program Files\\nodejs\\node.exe' }, { systemRoot: 'C:\\Windows' });
    expect(action.command).toBe('C:\\Windows\\System32\\conhost.exe');
    expect(action.arguments).toBe('--headless "C:\\Program Files\\nodejs\\node.exe" "D:\\rv-dev-deploy\\bin\\dev-deploy-watch.mjs" --config "D:\\rv-dev-deploy\\config.json"');
    expect(action.workingDirectory).toBe('D:\\rv-dev-deploy');
  });

  it('refuses to install from a checkout without a .plastic ancestor (worktree or clone)', () => {
    expect(() => W.install({ scriptDir: join(fx.config.clones.web, 'scripts'), env: {}, dryRun: true }, deps())).toThrow(/canonical checkout/);
    expect(calls).toEqual([]);
  });

  it('refuses an existing clone whose origin points elsewhere', () => {
    mkdirSync(join(installRoot(), 'clones'), { recursive: true });
    git(fx.base, 'clone', '--quiet', fx.bare.private, join(installRoot(), 'clones', W.CLONE_DIRS.web));
    expect(() => W.install(options(), deps())).toThrow(/has origin/);
    expect(calls).toEqual([]);
  });

  it('--uninstall removes only the task; an unregistered task is a no-op', () => {
    const { config } = W.install(options(), deps());
    calls = [];
    expect(W.uninstall(config, {}, deps()).removed).toBe(true);
    expect(calls).toEqual([['schtasks', '/Query', '/TN', 'rv-test-488-task'], ['schtasks', '/Delete', '/TN', 'rv-test-488-task', '/F']]);
    expect(existsSync(config.clones.web)).toBe(true);

    calls = [];
    queryStatus = 1;
    expect(W.uninstall(config, {}, deps()).removed).toBe(false);
    expect(calls).toEqual([['schtasks', '/Query', '/TN', 'rv-test-488-task']]);
  });

  it('--purge refuses while a tick runs, keeps everything on --dry-run, and deletes the root otherwise', async () => {
    const { config } = W.install(options(), deps());
    const configPath = join(config.root, 'config.json');
    const cfg = { ...config, watcherLockName: unique('purge-watcher') };

    const held = await acquire(cfg.watcherLockName, { timeoutMs: 0 });
    try {
      await expect(W.purge(cfg, configPath, {}, deps())).rejects.toThrow(/tick is running/);
    } finally {
      await held.release();
    }
    expect(existsSync(config.root)).toBe(true);

    calls = [];
    await W.purge(cfg, configPath, { dryRun: true }, deps());
    expect(existsSync(config.root)).toBe(true);
    expect(calls.map((c) => c[1])).toEqual(['/Query']);

    calls = [];
    expect((await W.purge(cfg, configPath, {}, deps())).purged).toBe(true);
    expect(existsSync(config.root)).toBe(false);
    expect(calls.map((c) => c[1])).toEqual(['/Query', '/Delete']);
  });
});
