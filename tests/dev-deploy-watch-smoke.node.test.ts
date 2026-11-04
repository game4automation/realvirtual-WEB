// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-503 §9.3 — the /dev deploy watcher and the post-deploy demo smoke.
 *
 * Same fixture pattern as tests/dev-deploy-watch.node.test.ts: LOCAL bare origins + clones in the
 * temp folder, real git, real ticks. The deploy child is injected (`deps.startDeploy`) and plays
 * the part of bunny-deploy.mjs: it writes smoke-result.json into the RV_SMOKE_OUT_DIR it was handed
 * and exits 0, 3 or 1. The runtime install (`deps.runtimeRunner`), the notification
 * (`deps.notify`) and the retry's runner (`deps.runSmoke`) are recorded, never executed —
 * no npm, no Playwright, no toast, no CDN.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import * as watchModule from '../scripts/dev-deploy-watch.mjs';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import { acquirePublishLock } from '../scripts/rv-publish-lock.mjs';
import * as deployModule from '../scripts/bunny-deploy.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const W = watchModule as any;
const D = deployModule as any;
type Lock = { release(): Promise<void> };
const acquire = acquirePublishLock as (name: string, options?: Record<string, unknown>) => Promise<Lock>;

const isWindows = process.platform === 'win32';
const WATCH_SCRIPT = resolve(__dirname, '../scripts/dev-deploy-watch.mjs');
const unique = (label: string) => `rv-test-503-${label}-${process.pid}-${randomBytes(4).toString('hex')}`;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'rv503 test', GIT_AUTHOR_EMAIL: 'rv503@test.invalid',
  GIT_COMMITTER_NAME: 'rv503 test', GIT_COMMITTER_EMAIL: 'rv503@test.invalid',
  GIT_TERMINAL_PROMPT: '0',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString().trim();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

//! A retry runner stand-in: spawns a grandchild that records its PID and then hangs.
const HANGING_RUNNER = `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.env.RV503_GRANDCHILD, String(process.pid)); setTimeout(() => {}, 120000)"], { stdio: 'ignore', env: process.env });
setTimeout(() => {}, 120000);
`;

interface Fixture {
  base: string;
  root: string;
  config: Record<string, any>;
  seeds: { web: string; private: string };
  outDir: string;
  commit(repo: 'web' | 'private', file: string, content: string): string;
  state(): any;
  log(): string;
}

function makeFixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'rv503-watch-')));
  const bare = { web: join(base, 'origin-web.git'), private: join(base, 'origin-private.git') };
  const seeds = { web: join(base, 'seed-web'), private: join(base, 'seed-private') };
  for (const repo of ['web', 'private'] as const) {
    git(base, 'init', '--bare', '--quiet', '-b', 'main', bare[repo]);
    mkdirSync(seeds[repo]);
    git(seeds[repo], 'init', '--quiet', '-b', 'main');
    git(seeds[repo], 'config', 'core.autocrlf', 'false');
    writeFileSync(join(seeds[repo], 'README.md'), `${repo}\n`);
    if (repo === 'web') {
      writeFileSync(join(seeds.web, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
      mkdirSync(join(seeds.web, 'scripts'));
      writeFileSync(join(seeds.web, 'scripts', 'rv-demo-smoke.mjs'), HANGING_RUNNER);
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
  writeFileSync(credentials, 'BUNNY_STORAGE_KEY=k503\nBUNNY_STORAGE_ZONE=z503\n');
  const outDir = join(root, 'last-smoke');
  const raw = {
    version: 1, root, clones, credentialsFiles: [credentials], nodePath: process.execPath, workspaceRoot: base,
    watcherLockName: unique('watcher'), taskName: unique('task'), deployArgs: ['--demo', '--path', 'dev'],
    fetchTimeoutMs: 120000, prepublishTimeoutSeconds: 900, branch: 'main',
    // Load guards off: these cases are about the smoke, not about machine load.
    lowPriority: false, minFreeMemoryMb: 0, deferWhileTestLockHeld: false, maxCpuPercent: 0,
    browsersPath: join(root, 'playwright-browsers'), smokeOutDir: outDir,
  };
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(raw, null, 2));
  writeFileSync(join(root, 'enabled'), '');
  return {
    base, root, seeds, outDir, config: W.loadWatcherConfig(configPath),
    commit(repo, file, content) {
      writeFileSync(join(seeds[repo], file), content);
      git(seeds[repo], 'add', '-A');
      git(seeds[repo], 'commit', '--quiet', '-m', `change ${file}`);
      git(seeds[repo], 'push', '--quiet', 'origin', 'main');
      return git(seeds[repo], 'rev-parse', 'HEAD');
    },
    state() { const p = join(root, 'state.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; },
    log() { const p = join(root, 'watch.log'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; },
  };
}

//! The injected deploy child: writes the smoke result the real bunny-deploy would, exits `code`.
function deployChild(code: number, smoke: Record<string, unknown> | null, envs: Array<Record<string, string>> = []) {
  return (_config: unknown, env: Record<string, string>) => {
    envs.push(env);
    if (smoke) {
      mkdirSync(env.RV_SMOKE_OUT_DIR, { recursive: true });
      const reportPath = join(env.RV_SMOKE_OUT_DIR, 'smoke-result.json');
      writeFileSync(reportPath, JSON.stringify({ failures: [], flaky: [], durationMs: 181_600, ...smoke, reportPath }));
    }
    return { pid: 0, exit: Promise.resolve({ code }) };
  };
}
const RED = {
  status: 'failed', reason: 'tests',
  failures: [{ spec: 'planner-journey.spec.ts', title: 'planner-journey.spec.ts › drag moves the placement and reload follows the measured contract', message: 'drag did not move', attachments: [] }],
};
const present = { cli: true, browser: true };

describe.skipIf(!isWindows)('dev-deploy-watch — demo smoke (plan-503 §9.3)', () => {
  let fx: Fixture;
  let notes: Array<[string, string]>;
  let runs: Array<[string, string[], Record<string, any>]>;
  const notify = (title: string, body: string) => { notes.push([title, body]); return { ok: true }; };
  const runtimeRunner = (file: string, args: string[], options: Record<string, any>) => { runs.push([file, args, options]); return { status: 0, stdout: '', stderr: '' }; };
  const tickDeps = (extra: Record<string, unknown> = {}) => ({ notify, runtimeRunner, runtimePresent: () => present, ...extra });

  beforeEach(() => { fx = makeFixture(); notes = []; runs = []; }, 120_000);
  afterEach(() => { rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  it('exit 3 records lastSmoke=failed, lastDeployed=pair and schedules NO retry', async () => {
    const result = await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(3, RED) }));
    expect(result).toMatchObject({ outcome: 'deployed', smoke: 'failed' });
    const state = fx.state();
    expect(state.lastDeployed).toEqual(result.pair);
    expect(state.attempt).toBeNull();
    expect(state.lastFailed).toBeNull();
    expect(state.lastResult).toMatchObject({ ok: true, exitCode: 3 });
    expect(state.lastSmoke).toMatchObject({ status: 'failed', reason: 'tests', pair: result.pair, reportPath: join(fx.outDir, 'smoke-result.json') });
    expect(state.lastSmoke.failures).toEqual(['planner-journey.spec.ts › drag moves the placement and reload follows the measured contract']);
    // The next tick is idle (the pair IS deployed) — no backoff, no redeploy.
    const next = await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }) }));
    expect(next).toMatchObject({ outcome: 'idle', reason: 'up-to-date' });
    expect(fx.log()).toMatch(/DEPLOY OK .* \(exit 3: live, smoke red\)/);
    expect(fx.log()).toMatch(/SMOKE FAILED web=\w+ private=\w+ duration=181\.6s failures=1 reason=tests \(see .*smoke-result\.json\)/);
  }, 120_000);

  it('exit 0 with an ok smoke-result.json in RV_SMOKE_OUT_DIR records lastSmoke=ok', async () => {
    const envs: Array<Record<string, string>> = [];
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }, envs) }));
    expect(envs[0].RV_SMOKE_OUT_DIR).toBe(fx.outDir);
    expect(fx.state().lastSmoke).toMatchObject({ status: 'ok' });
    expect(fx.log()).toMatch(/SMOKE OK web=/);
    expect(notes).toEqual([]);
  }, 120_000);

  it('exit 3 without a readable smoke-result.json records reason=report-unreadable; exit 0 without one is SKIPPED, never OK', async () => {
    // A stale result of an earlier run must not be read: the tick deletes it before the child starts.
    mkdirSync(fx.outDir, { recursive: true });
    writeFileSync(join(fx.outDir, 'smoke-result.json'), JSON.stringify({ status: 'ok' }));
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(3, null) }));
    expect(fx.state().lastSmoke).toMatchObject({ status: 'failed', reason: 'report-unreadable' });
    fx.commit('web', 'next.txt', 'next');
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, null) }));
    expect(fx.state().lastSmoke).toMatchObject({ status: 'skipped', reason: 'no-smoke-result' });
  }, 120_000);

  it('expected.json exists after a run that failed at runtime-missing or unreachable (written by the deploy before the runner)', async () => {
    const saved = { ...process.env };
    const work = mkdtempSync(join(tmpdir(), 'rv503-expected-'));
    try {
      for (const key of ['RV_SIGN_PRIVATE_KEY', 'RV_SEO', 'RV_PUBLIC_MODEL_PREFIX', 'RV_KEEP_STAGING']) delete process.env[key];
      process.env.RV_SMOKE_OUT_DIR = join(work, 'last-smoke');
      process.env.RV_SMOKE_PAIR = JSON.stringify({ web: 'c'.repeat(40), private: 'd'.repeat(40) });
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(work, 'no-browsers'); // → the REAL runner ends runtime-missing
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string }) => {
        const r = (status: number) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => '[]', json: async () => [] });
        if (String(url).startsWith('https://api.bunny.net/')) return r(200);
        return r(init.method === 'GET' ? 404 : 201);
      }));
      const stage = () => {
        const workspaceRoot = mkdtempSync(join(work, 'rv-customer-workspace-'));
        const distDir = join(workspaceRoot, 'dist');
        mkdirSync(join(distDir, 'demo-realvirtual'), { recursive: true });
        writeFileSync(join(distDir, 'index.html'), '<html><head></head><body></body></html>');
        writeFileSync(join(distDir, 'demo-realvirtual', 'project.json'), JSON.stringify({ demos: { hmi: 'h', planner: 'p' }, documents: [{ id: 'h', path: 'H.glb' }, { id: 'p', path: 'P.glb' }] }));
        writeFileSync(join(distDir, 'demo-realvirtual', 'H.glb'), Buffer.alloc(7));
        writeFileSync(join(distDir, 'demo-realvirtual', 'P.glb'), Buffer.alloc(9));
        return { workspaceRoot, distDir };
      };
      const cfg = { storageZone: 'z', region: 'storage.bunnycdn.com', storageKey: 'K', accountKey: 'A', pullZoneId: '42', remotePath: '', googleAnalyticsId: '', newsApiUrl: '' };
      const lockStub = async () => ({ name: 'l', release: async () => {} });
      const error = await D.deployPublic(cfg, { path: 'dev', demo: true }, { stageAndBuild: stage, sleep: async () => {}, acquireLock: lockStub, probe: async () => ({ ok: true, findings: [], checks: [] }) }).catch((e: unknown) => e);
      expect(D.exitCodeFor(error)).toBe(3);
      const result = JSON.parse(readFileSync(join(work, 'last-smoke', 'smoke-result.json'), 'utf8'));
      expect(result).toMatchObject({ status: 'failed', reason: 'runtime-missing' });
      const expected = JSON.parse(readFileSync(join(work, 'last-smoke', 'expected.json'), 'utf8'));
      expect(expected).toMatchObject({ pair: { web: 'c'.repeat(40) }, baseUrl: 'https://web.realvirtual.io/dev/', demos: { hmi: 'h', planner: 'p' } });
      expect(expected.fingerprint.glbs).toEqual({ 'H.glb': { size: 7 }, 'P.glb': { size: 9 } });
    } finally {
      process.env = saved;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('--retry-smoke after such a run compares against the CURRENT expected.json, not a stale one', async () => {
    mkdirSync(fx.outDir, { recursive: true });
    const expectedFile = join(fx.outDir, 'expected.json');
    const stand = (web: string) => JSON.stringify({ pair: { web, private: 'p'.repeat(40) }, baseUrl: 'https://web.realvirtual.io/dev/', demos: {}, fingerprint: { indexHtml: web } });
    writeFileSync(expectedFile, stand('1'.repeat(40)));
    // A deploy (holding the watcher lock) writes a newer stand while the retry waits for the lock.
    const tick = await acquire(fx.config.watcherLockName);
    const seen: string[] = [];
    const retry = W.retrySmoke(fx.config, {
      notify, runtimeRunner, runtimePresent: () => present, out: () => {}, lockTimeoutMs: 30_000,
      runSmoke: async (_config: unknown, file: string) => {
        seen.push(readFileSync(file, 'utf8'));
        writeFileSync(join(fx.outDir, 'smoke-result.json'), JSON.stringify({ status: 'ok', failures: [], durationMs: 1 }));
        return { code: 0, timedOut: false };
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([]); // still waiting for the lock — never silently ending
    writeFileSync(expectedFile, stand('2'.repeat(40)));
    await tick.release();
    const { smoke } = await retry;
    expect(JSON.parse(seen[0]).pair.web).toBe('2'.repeat(40));
    expect(smoke).toMatchObject({ status: 'ok', pair: { web: '2'.repeat(40) } });
  }, 60_000);

  it('logs SMOKE FAILED line and calls notify once on OK→FAILED transition only', async () => {
    const first = await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }) }));
    expect(first.smoke).toBe('ok');
    fx.commit('web', 'a.txt', 'a');
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(3, RED) }));
    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toBe('realvirtual WEB /dev/ — SMOKE FAILED');
    expect(notes[0][1]).toContain('planner-journey.spec.ts › drag moves');
    expect(notes[0][1]).toContain(join(fx.outDir, 'smoke-result.json'));
    expect(notes[0][1]).toContain('--retry-smoke');
    // A lasting red does not toast again.
    fx.commit('web', 'b.txt', 'b');
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(3, RED) }));
    expect(notes).toHaveLength(1);
    expect(fx.log().match(/SMOKE FAILED/g)).toHaveLength(2);
    expect(W.isSmokeTransitionToFailed(null, { status: 'failed' })).toBe(true);
    expect(W.isSmokeTransitionToFailed({ status: 'skipped' }, { status: 'failed' })).toBe(true);
    expect(W.isSmokeTransitionToFailed({ status: 'failed' }, { status: 'failed' })).toBe(false);
    expect(W.isSmokeTransitionToFailed({ status: 'failed' }, { status: 'ok' })).toBe(false);
  }, 180_000);

  it('--status renders the last smoke line', async () => {
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(3, RED) }));
    const text = execFileSync(process.execPath, [WATCH_SCRIPT, '--status', '--config', join(fx.root, 'config.json')], { windowsHide: true }).toString();
    expect(text).toMatch(/last smoke {2}: FAILED \d{4}-\d\d-\d\dT[\d:.]+Z web=\w+ private=\w+ — planner-journey\.spec\.ts › drag moves .* \(see .*smoke-result\.json; --retry-smoke\)/);
    expect(text).toMatch(/runtime {5}: installed /);
    const json = JSON.parse(execFileSync(process.execPath, [WATCH_SCRIPT, '--status', '--json', '--config', join(fx.root, 'config.json')], { windowsHide: true }).toString());
    expect(json.lastSmoke.status).toBe('failed');
    expect(W.formatStatus({ root: 'r', enabled: true, status: 'idle', stateFile: 'ok', lastDeployed: null, lastSmoke: null })).toMatch(/last smoke {2}: -/);
  }, 120_000);

  it('git clean in resetClone excludes node_modules', async () => {
    expect(W.CLEAN_ARGS).toEqual(['clean', '-ffdxq', '-e', 'node_modules']);
    mkdirSync(join(fx.config.clones.web, 'node_modules', 'playwright'), { recursive: true });
    writeFileSync(join(fx.config.clones.web, 'node_modules', 'playwright', 'cli.js'), '// kept');
    writeFileSync(join(fx.config.clones.web, 'stray.txt'), 'removed');
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }) }));
    expect(existsSync(join(fx.config.clones.web, 'node_modules', 'playwright', 'cli.js'))).toBe(true);
    expect(existsSync(join(fx.config.clones.web, 'stray.txt'))).toBe(false);
  }, 120_000);

  it('runs npm ci + playwright install when lock hash differs OR cli.js/browser dir is missing', () => {
    const lockHash = createHash('sha256').update(readFileSync(join(fx.config.clones.web, 'package-lock.json'))).digest('hex');
    const current = { runtime: { lockHash, installedAt: 'x', browsersPath: fx.config.browsersPath } };
    expect(W.runtimeNeedsInstall(current, present, lockHash)).toBeNull();
    expect(W.runtimeNeedsInstall(current, { cli: false, browser: true }, lockHash)).toBe('playwright-cli-missing');
    expect(W.runtimeNeedsInstall(current, { cli: true, browser: false }, lockHash)).toBe('browser-missing');
    expect(W.runtimeNeedsInstall(current, present, 'other')).toBe('lockfile-changed');
    expect(W.runtimeNeedsInstall({ runtime: null }, present, lockHash)).toBe('lockfile-changed');

    const rt = W.ensureRuntime(fx.config, { runtime: null }, { runner: runtimeRunner, present: () => ({ cli: false, browser: false }) });
    expect(rt).toMatchObject({ action: 'installed', reason: 'playwright-cli-missing', runtime: { lockHash, browsersPath: fx.config.browsersPath } });
    expect(runs).toHaveLength(2);
    expect(runs[0][1].slice(-2)).toEqual(['ci', '--ignore-scripts']);
    expect(runs[0][2].cwd).toBe(fx.config.clones.web);
    expect(runs[1][1]).toEqual([join(fx.config.clones.web, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium', '--only-shell']);
    expect(runs[1][2].env.PLAYWRIGHT_BROWSERS_PATH).toBe(fx.config.browsersPath);

    // A failing step is reported (RUNTIME FAILED), never thrown.
    const failing = W.ensureRuntime(fx.config, { runtime: null }, { runner: () => ({ status: 1, stdout: '', stderr: 'E403' }), present: () => present });
    expect(failing).toMatchObject({ action: 'failed', reason: 'lockfile-changed' });
    expect(failing.error).toContain('E403');
    // A config from before plan-503 (no browsersPath) is unmanaged: nothing is installed.
    expect(W.ensureRuntime({ ...fx.config, browsersPath: undefined }, {}, { runner: () => { throw new Error('must not run'); } }).action).toBe('unmanaged');
  });

  it('skips runtime install when hash unchanged and runtime present (two SHAs, same lockfile)', async () => {
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }), runtimePresent: () => ({ cli: false, browser: false }) }));
    expect(runs).toHaveLength(2);
    expect(fx.log()).toMatch(/RUNTIME INSTALL playwright-cli-missing ok/);
    expect(fx.state().runtime.lockHash).toMatch(/^[0-9a-f]{64}$/);
    fx.commit('web', 'README.md', 'a new web SHA, same package-lock.json\n');
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }) }));
    expect(runs).toHaveLength(2);
    // …and a changed lockfile installs again.
    fx.commit('web', 'package-lock.json', '{"lockfileVersion":3,"packages":{"":{"name":"x"}}}\n');
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }) }));
    expect(runs).toHaveLength(4);
    expect(fx.log()).toMatch(/RUNTIME INSTALL lockfile-changed ok/);
  }, 180_000);

  it('--retry-smoke takes the watcher lock, runs only the smoke with expected.json and updates lastSmoke', async () => {
    await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }) }));
    const before = fx.state();
    mkdirSync(fx.outDir, { recursive: true });
    writeFileSync(join(fx.outDir, 'expected.json'), JSON.stringify({ pair: before.lastDeployed, baseUrl: 'https://web.realvirtual.io/dev/', demos: {}, fingerprint: { indexHtml: 'x' } }));
    const acquired: string[] = [];
    const calls: string[] = [];
    const { smoke } = await W.retrySmoke(fx.config, {
      notify, runtimeRunner, runtimePresent: () => present, out: () => {},
      acquire: async (name: string, options: Record<string, unknown>) => { acquired.push(`${name} timeout=${options.timeoutMs}`); return { release: async () => { acquired.push('released'); } }; },
      runSmoke: async (_config: unknown, file: string) => {
        calls.push(file);
        writeFileSync(join(fx.outDir, 'smoke-result.json'), JSON.stringify(RED));
        return { code: 3, timedOut: false };
      },
    });
    expect(acquired).toEqual([`${fx.config.watcherLockName} timeout=${30 * 60_000}`, 'released']);
    expect(calls).toEqual([join(fx.outDir, 'expected.json')]);
    expect(smoke).toMatchObject({ status: 'failed', pair: before.lastDeployed });
    const after = fx.state();
    expect(after.lastSmoke.status).toBe('failed');
    expect(after.lastDeployed).toEqual(before.lastDeployed); // nothing was deployed
    expect(after.lastResult).toEqual(before.lastResult);
    expect(notes).toHaveLength(1); // OK → FAILED
    expect(fx.log()).toMatch(/SMOKE RETRY FAILED/);
    // A runner that dies without a result is red, never skipped.
    const dead = await W.retrySmoke(fx.config, { notify, runtimeRunner, runtimePresent: () => present, out: () => {}, runSmoke: async () => ({ code: 2, timedOut: false }) });
    expect(dead.smoke).toMatchObject({ status: 'failed', reason: 'report-unreadable' });
    // Without expected.json there is nothing to retry.
    rmSync(join(fx.outDir, 'expected.json'));
    await expect(W.retrySmoke(fx.config, { out: () => {} })).rejects.toThrow(/nothing to retry/);
  }, 120_000);

  it('Test_NoSmokeInDeployArgs_SkipsRuntimeAndSmokeBookkeeping', async () => {
    const off = { ...fx.config, deployArgs: ['--demo', '--path', 'dev', '--no-smoke'] };
    expect(W.smokeDisabled(off)).toBe(true);
    expect(W.smokeDisabled(fx.config)).toBe(false);
    expect(W.smokeDisabled({})).toBe(false);
    let ensured = 0;
    // A stale result must neither be read nor matter: the child writes none (bunny-deploy skips the smoke).
    mkdirSync(fx.outDir, { recursive: true });
    writeFileSync(join(fx.outDir, 'smoke-result.json'), JSON.stringify(RED));
    const result = await W.runTick(off, tickDeps({
      startDeploy: deployChild(0, null),
      runtimePresent: () => ({ cli: false, browser: false }),
      ensureRuntime: () => { ensured += 1; return { runtime: null, action: 'installed' }; },
    }));
    expect(result).toMatchObject({ outcome: 'deployed', smoke: null });
    expect(ensured).toBe(0);
    expect(runs).toEqual([]);
    const state = fx.state();
    expect(state.lastDeployed).toEqual(result.pair);
    expect(state.lastSmoke).toBeNull();
    expect(fx.log()).toMatch(/runtime: skipped \(smoke disabled\)/);
    expect(fx.log()).not.toMatch(/RUNTIME|SMOKE (OK|FAILED|SKIPPED)/);
    expect(notes).toEqual([]);
    // --retry-smoke says so and runs nothing, even with an expected.json on disk.
    writeFileSync(join(fx.outDir, 'expected.json'), JSON.stringify({ pair: result.pair, baseUrl: 'x', demos: {}, fingerprint: {} }));
    const lines: string[] = [];
    const retry = await W.retrySmoke(off, { out: (line: string) => lines.push(line), runSmoke: async () => { throw new Error('must not run'); } });
    expect(retry).toMatchObject({ smoke: null, disabled: true });
    expect(lines.join(' ')).toMatch(/smoke is disabled/);
  }, 120_000);

  it('kills the whole smoke process tree on timeout (taskkill /T on win32)', async () => {
    const grandchildPidFile = join(fx.base, 'grandchild.pid');
    process.env.RV503_GRANDCHILD = grandchildPidFile;
    try {
      const exit = await W.runSmokeChild({ ...fx.config, retrySmokeTimeoutMs: 4_000 }, join(fx.outDir, 'expected.json'));
      expect(exit.timedOut).toBe(true);
      const grandchild = Number(readFileSync(grandchildPidFile, 'utf8'));
      expect(grandchild).toBeGreaterThan(0);
      const deadline = Date.now() + 10_000;
      while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(alive(grandchild)).toBe(false);
      expect(alive(exit.pid)).toBe(false);
    } finally {
      delete process.env.RV503_GRANDCHILD;
    }
  }, 60_000);

  it('deployEnv passes PLAYWRIGHT_BROWSERS_PATH and RV_SMOKE_OUT_DIR to the child', async () => {
    const env = W.deployEnv(fx.config, { values: { BUNNY_STORAGE_KEY: 'k' } }, {}, { web: 'a', private: 'b' });
    expect(env).toMatchObject({
      PLAYWRIGHT_BROWSERS_PATH: fx.config.browsersPath,
      RV_SMOKE_OUT_DIR: fx.outDir,
      RV_SMOKE_PAIR: JSON.stringify({ web: 'a', private: 'b' }),
      BUNNY_STORAGE_KEY: 'k',
    });
    // Defaults under <root> for a config without the plan-503 fields.
    const legacy = W.deployEnv({ ...fx.config, browsersPath: undefined, smokeOutDir: undefined }, { values: {} }, {});
    expect(legacy.PLAYWRIGHT_BROWSERS_PATH).toBe(join(fx.root, 'playwright-browsers'));
    expect(legacy.RV_SMOKE_OUT_DIR).toBe(join(fx.root, 'last-smoke'));
    // The real tick hands exactly these to the child.
    const envs: Array<Record<string, string>> = [];
    const result = await W.runTick(fx.config, tickDeps({ startDeploy: deployChild(0, { status: 'ok' }, envs) }));
    expect(envs[0]).toMatchObject({ PLAYWRIGHT_BROWSERS_PATH: fx.config.browsersPath, RV_SMOKE_OUT_DIR: fx.outDir, RV_SMOKE_PAIR: JSON.stringify(result.pair) });
  }, 120_000);
});

describe('rv-notify (plan-503 §2.6)', () => {
  it('builds a NotifyIcon balloon, quotes safely and never throws', async () => {
    // @ts-expect-error — plain ESM script without type declarations
    const N = await import('../scripts/rv-notify.mjs') as any;
    const script: string = N.balloonScript("it's red", 'x'.repeat(400));
    expect(script).toContain('System.Windows.Forms.NotifyIcon');
    expect(script).toContain('ShowBalloonTip');
    expect(script).toContain("'it''s red'");
    expect(script).toMatch(/BalloonTipText = 'x{254}…'/);
    const calls: unknown[][] = [];
    expect(N.notifyWindows('t', 'b', { platform: 'win32', spawn: (...args: unknown[]) => { calls.push(args); return { status: 0 }; } })).toEqual({ ok: true });
    expect(calls[0][0]).toBe('powershell.exe');
    expect((calls[0][2] as Record<string, unknown>).windowsHide).toBe(true);
    expect(N.notifyWindows('t', 'b', { platform: 'win32', spawn: () => { throw new Error('boom'); } })).toMatchObject({ ok: false, error: 'boom' });
    expect(N.notifyWindows('t', 'b', { platform: 'win32', spawn: () => ({ status: 1, stderr: 'denied' }) })).toMatchObject({ ok: false });
    expect(N.notifyWindows('t', 'b', { platform: 'linux' })).toMatchObject({ ok: false, skipped: true });
  });
});

// ─── plan-587 F4 — the deploy deadline is ARMED (Phase 4) ─────────────────

describe.skipIf(!isWindows)('dev-deploy-watch — the phase-aware deploy deadline is armed (plan-587 F4)', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); }, 120_000);
  afterEach(() => { rmSync(fx.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  it('Test_DeployPhaseFile_WatcherAndChildAgreeOnOnePath', () => {
    // The child runs from a CLONE and has no workspace root of its own, so it must NOT compute
    // the path. The watcher owns `<root>` and names it through the environment. If these two
    // ever drift apart, the child reports into one file and the deadline reads another — and the
    // deadline would then kill a publishing deploy. That is the whole failure this asserts away.
    const path = W.deployPhaseFileOf(fx.config);
    expect(path).toBe(join(fx.root, 'deploy-phase.json'));
    const env = W.deployEnv(fx.config, { values: {} }, {});
    expect(env.RV_DEPLOY_PHASE_FILE).toBe(path);
    expect(D.deployPhaseFilePath(env)).toBe(path);
    // An explicit config value still wins (an operator moving the file).
    const moved = join(fx.root, 'elsewhere.json');
    expect(W.deployPhaseFileOf({ ...fx.config, deployPhaseFile: moved })).toBe(moved);
  });

  it('Test_DeployTimeout_IsGenerousComparedToTheChildsOwnLimit', () => {
    // Not a build budget — the child enforces that itself before the publish lock, and knows
    // better. This is the backstop for a child that HANGS and never reaches its own check, so it
    // must sit far above the child's limit or it would start killing healthy slow deploys.
    expect(W.DEPLOY_TIMEOUT_MS).toBeGreaterThan(W.PREPUBLISH_TIMEOUT_SECONDS * 1000 * 2);
    expect(W.DEPLOY_TIMEOUT_MS).toBe(45 * 60_000);
  });

  it('Test_StartDeployChild_RemovesTheStalePhaseRecord', async () => {
    // A leftover `published` from the previous tick would hand a child that hangs before
    // reporting anything the previous run's "do not kill" verdict — the one case in which the
    // deadline is supposed to bite.
    const path = W.deployPhaseFileOf(fx.config);
    D.reportDeployPhase('published', { path });
    expect(existsSync(path)).toBe(true);
    // The script path does not exist in this fixture's clone: the child exits straight away,
    // which is all this test needs — nothing is deployed.
    const child = W.startDeployChild(fx.config, { ...process.env });
    expect(existsSync(path)).toBe(false);
    await child.exit;
  }, 60_000);

  it('Test_ReportedPhase_DecidesTheKill_AcrossBothScripts', async () => {
    // The cross-script contract in one place: what bunny-deploy WRITES is what rv-proc READS.
    // `build` is killable, everything after it is not, and an unreadable record is the
    // conservative no-kill case.
    const { decideTimeoutKill } = await import('../scripts/lib/rv-proc.mjs') as any;
    const path = W.deployPhaseFileOf(fx.config);
    for (const phase of D.DEPLOY_PHASES) {
      D.reportDeployPhase(phase, { path });
      const verdict = decideTimeoutKill(path);
      expect(verdict.phase).toBe(phase);
      expect(verdict.kill, `phase ${phase}`).toBe(phase === 'build');
    }
    rmSync(path, { force: true });
    expect(decideTimeoutKill(path).kill).toBe(false);
  });
});
