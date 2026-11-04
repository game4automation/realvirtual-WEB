// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * demo-welcome-gate.node.test.ts — plan-646 F14: the build flag `__RV_DEMO_WELCOME__`.
 *
 *  - `demoWelcomeForTarget`: true only for `--demo` AND the normalised target path `demo`;
 *    `/dev`, `/demo-beta`, `--root`, a plain public deploy → false.
 *  - `deployPublic` → `stageAndBuild` → `runBuild` hand the flag through as an explicit boolean;
 *    `runBuild` sets `RV_DEMO_WELCOME` to '1' or '0' for EVERY build and never inherits it.
 *  - shared build cache: a demo → dev → demo sequence hitting the same node_modules profile
 *    still builds each target with its own flag (the cache holds node_modules only and the
 *    production build always reruns).
 *  - entitlement: only DEMO_PROFILE generates the adapter; customers never get it, the other
 *    restricted features stay out of the demo, and the public catalog does not name it.
 *  - dead-code shape: the define defaults to false and the adapter imports the window only
 *    behind the flag, dynamically.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as deployModule from '../scripts/bunny-deploy.mjs';
import {
  generateCustomerPrivatePlugins,
  loadTierManifest,
  runBuild,
} from '../scripts/_workspace-lib.mjs';
import type { DeliveryProfile } from '../scripts/_workspace-lib.mjs';
import { buildEnvForMode } from '../scripts/_bunny-lib.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const D = deployModule as unknown as {
  DEMO_PROFILE: { tier: string; restrictedFeatures: readonly string[] };
  demoWelcomeForTarget(options: { demo?: boolean; remotePrefix?: string | null; root?: boolean }): boolean;
  normalizeRemotePrefix(prefix: string | null | undefined): string;
  stageAndBuild(options: Record<string, unknown>, deps?: Record<string, unknown>): any;
  deployPublic(cfg: Record<string, unknown>, opts: Record<string, unknown>, deps?: Record<string, unknown>): Promise<void>;
};

const ROOT = resolve(__dirname, '..');
const PRIVATE_ROOT = resolve(ROOT, '../realvirtual-WebViewer-Private~');

describe('demoWelcomeForTarget (plan-646 F14)', () => {
  it.each([
    ['demo', true], ['/demo/', true], ['demo/', true], ['/demo', true], ['\\demo\\', true], ['DEMO', true],
    ['dev', false], ['/dev/', false], ['demo-beta', false], ['demo/sub', false], ['', false], [null, false],
  ])('--demo --path %j -> %s', (remotePrefix, expected) => {
    expect(D.demoWelcomeForTarget({ demo: true, remotePrefix })).toBe(expected);
  });

  it('is false without --demo and with --root', () => {
    expect(D.demoWelcomeForTarget({ demo: false, remotePrefix: 'demo' })).toBe(false);
    expect(D.demoWelcomeForTarget({ demo: true, remotePrefix: 'demo', root: true })).toBe(false);
    expect(D.demoWelcomeForTarget({})).toBe(false);
  });

  it('normalises like the fast-build prefix check', () => {
    expect(D.normalizeRemotePrefix('\\Demo//')).toBe('demo');
    expect(D.normalizeRemotePrefix(undefined)).toBe('');
  });
});

describe('deployPublic hands the flag to stageAndBuild', () => {
  const saved = process.env.RV_DEMO_WELCOME;
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.RV_DEMO_WELCOME; else process.env.RV_DEMO_WELCOME = saved;
  });

  async function stagedOptions(opts: Record<string, unknown>): Promise<Record<string, unknown>> {
    let seen: Record<string, unknown> = {};
    const stop = new Error('stop after staging');
    const error = await D.deployPublic({ remotePath: '' }, opts, {
      stageAndBuild: (options: Record<string, unknown>) => { seen = options; throw stop; },
      reportPhase: () => {},
    }).catch((e) => e);
    expect(error).toBe(stop);
    return seen;
  }

  it('--demo --path demo -> true, --demo --path dev -> false, plain public -> false', async () => {
    // An inherited value must not decide anything.
    process.env.RV_DEMO_WELCOME = '1';
    expect((await stagedOptions({ demo: true, path: 'demo' })).demoWelcome).toBe(true);
    expect((await stagedOptions({ demo: true, path: '/demo/' })).demoWelcome).toBe(true);
    expect((await stagedOptions({ demo: true, path: 'dev' })).demoWelcome).toBe(false);
    expect((await stagedOptions({ demo: true, path: 'demo-beta' })).demoWelcome).toBe(false);
    expect((await stagedOptions({ demo: false, path: 'demo' })).demoWelcome).toBe(false);
    // Path switch back and forth inside one process.
    expect((await stagedOptions({ demo: true, path: 'demo' })).demoWelcome).toBe(true);
    expect((await stagedOptions({ demo: true, path: 'dev' })).demoWelcome).toBe(false);
  });
});

describe('stageAndBuild passes an explicit boolean to the build step', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv646-gate-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  function run(options: Record<string, unknown>): Record<string, unknown> {
    let seen: Record<string, unknown> = {};
    D.stageAndBuild({ base: null, dryRun: false, ...options }, {
      stage: () => ({ workspaceRoot: work, manifest: {} }),
      assertTierLeak: () => {},
      build: (_root: string, buildOptions: Record<string, unknown>) => { seen = buildOptions; return { distDir: join(work, 'dist') }; },
      assertProvenance: () => {},
      resolveOwner: () => null,
    });
    return seen;
  }

  it('true only for mode demo with demoWelcome true', () => {
    expect(run({ mode: 'demo', demoWelcome: true }).demoWelcome).toBe(true);
    expect(run({ mode: 'demo', demoWelcome: false }).demoWelcome).toBe(false);
    expect(run({ mode: 'demo' }).demoWelcome).toBe(false);
    expect(run({ mode: 'public', demoWelcome: true }).demoWelcome).toBe(false);
    expect(run({ mode: 'demo', demoWelcome: 'yes' }).demoWelcome).toBe(false);
  });
});

describe('runBuild sets RV_DEMO_WELCOME explicitly for every build', () => {
  let work: string;
  const savedEnv: Record<string, string | undefined> = {};
  const keys = ['RV_DEMO_WELCOME', 'RV_DEMO_NOTICE', 'RV_BUILD_CACHE'];
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv646-build-'));
    for (const key of keys) savedEnv[key] = process.env[key];
    // The operator's shell says "on" — no build may pick that up.
    process.env.RV_DEMO_WELCOME = '1';
    process.env.RV_DEMO_NOTICE = '1';
    process.env.RV_BUILD_CACHE = join(work, 'cache');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const key of keys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  //! A minimal workspace: runBuild treats a root without realvirtual-web/ as the core itself.
  function workspace(name: string): string {
    const root = join(work, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    return root;
  }

  function build(root: string, options: Record<string, unknown>) {
    const calls: Array<{ args: string[]; flag: string | undefined; notice: string | undefined }> = [];
    const result = runBuild(root, {
      sourceRoot: work,
      runtimeIdentity: 'node-test',
      cacheRestore: (_from: string, to: string) => { mkdirSync(to, { recursive: true }); return 'copy'; },
      privateDepsRunner: () => {},
      npmRunner: (args: string[], { env }: { env: Record<string, string> }) => {
        calls.push({ args, flag: env.RV_DEMO_WELCOME, notice: env.RV_DEMO_NOTICE });
        if (args[0] === 'ci') mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
        if (args[0] === 'run') mkdirSync(join(root, 'dist'), { recursive: true });
      },
      ...options,
    }) as unknown as { cacheStatus: string; profileKey: string | null };
    return { calls, result };
  }

  it('overrides an inherited RV_DEMO_WELCOME=1 for every mode without the flag', () => {
    for (const mode of ['demo', 'public', 'private']) {
      const { calls } = build(workspace(`ws-${mode}`), { mode });
      expect(calls.every((call) => call.flag === '0'), mode).toBe(true);
    }
    const { calls } = build(workspace('ws-private-true'), { mode: 'private', demoWelcome: true });
    expect(calls.every((call) => call.flag === '0')).toBe(true);
  });

  it('demo -> dev -> demo on one cache profile builds each target with its own flag', () => {
    const first = build(workspace('ws-1'), { mode: 'demo', demoWelcome: true, fast: true });
    const second = build(workspace('ws-2'), { mode: 'demo', demoWelcome: false, fast: true });
    const third = build(workspace('ws-3'), { mode: 'demo', demoWelcome: true, fast: true });
    // Same lockfiles + runtime -> the same node_modules profile, and the later two are hits.
    expect(first.result.profileKey).toBeTruthy();
    expect(second.result.profileKey).toBe(first.result.profileKey);
    expect(third.result.profileKey).toBe(first.result.profileKey);
    expect(second.result.cacheStatus).toBe('hit');
    expect(third.result.cacheStatus).toBe('hit');
    // The production build reruns every time, with the flag of THIS target.
    const buildFlag = (calls: Array<{ args: string[]; flag: string | undefined; notice?: string | undefined }>) =>
      calls.filter((call) => call.args[0] === 'run').map((call) => call.flag);
    expect(buildFlag(first.calls)).toEqual(['1']);
    expect(buildFlag(second.calls)).toEqual(['0']);
    expect(buildFlag(third.calls)).toEqual(['1']);
    // The cached profile is node_modules only — nothing the flag could have shaped.
    const profileRoot = join(work, 'cache', 'rv-build-cache', String(first.result.profileKey));
    expect(existsSync(join(profileRoot, 'node_modules'))).toBe(true);
    expect(existsSync(join(profileRoot, 'dist'))).toBe(false);
  });

  it('the public-demo notice (RV_DEMO_NOTICE) follows the target: only /demo, never /dev or /demo-beta', () => {
    const noticeOf = (calls: Array<{ args: string[]; notice: string | undefined }>) =>
      calls.filter((call) => call.args[0] === 'run').map((call) => call.notice);
    // demoWelcome === true is exactly demoWelcomeForTarget(--demo, path demo).
    expect(noticeOf(build(workspace('n-demo'), { mode: 'demo', demoWelcome: true }).calls)).toEqual(['1']);
    // /dev and /demo-beta are demo-profile targets with demoWelcome false: no notice (and, with the
    // private tree compiled in, no AGPL watermark either - the HTML transform removes both).
    expect(noticeOf(build(workspace('n-dev'), { mode: 'demo', demoWelcome: false }).calls)).toEqual(['0']);
    expect(noticeOf(build(workspace('n-beta'), { mode: 'demo' }).calls)).toEqual(['0']);
    // An inherited RV_DEMO_NOTICE=1 never decides anything, in any other mode either.
    for (const mode of ['public', 'private']) {
      expect(noticeOf(build(workspace(`n-${mode}`), { mode, demoWelcome: true }).calls), mode).toEqual(['0']);
    }
    // The chain: target path -> demoWelcomeForTarget -> notice.
    for (const [remotePrefix, expected] of [['demo', '1'], ['dev', '0'], ['demo-beta', '0']] as const) {
      const welcome = D.demoWelcomeForTarget({ demo: true, remotePrefix });
      expect(noticeOf(build(workspace(`chain-${remotePrefix}`), { mode: 'demo', demoWelcome: welcome }).calls), remotePrefix).toEqual([expected]);
    }
  });

  it('buildEnvForMode: notice only for the public demo target', () => {
    const env = buildEnvForMode as any;
    expect(env('demo', { demoWelcome: true }).RV_DEMO_NOTICE).toBe('1');
    expect(env('demo').RV_DEMO_NOTICE).toBe('0');
    expect(env('demo', { demoWelcome: false }).RV_DEMO_NOTICE).toBe('0');
    expect(env('public', { demoWelcome: true }).RV_DEMO_NOTICE).toBe('0');
    expect(env('private', { demoWelcome: true }).RV_DEMO_NOTICE).toBe('0');
  });

  it('buildEnvForMode follows the same rule', () => {
    expect(buildEnvForMode('public' as any).RV_DEMO_WELCOME).toBe('0');
    expect((buildEnvForMode as any)('demo').RV_DEMO_WELCOME).toBe('0');
    expect((buildEnvForMode as any)('demo', { demoWelcome: true }).RV_DEMO_WELCOME).toBe('1');
    expect((buildEnvForMode as any)('private', { demoWelcome: true }).RV_DEMO_WELCOME).toBe('0');
  });
});

describe('entitlement and dead-code shape', () => {
  const manifest = loadTierManifest(PRIVATE_ROOT);

  it('only the demo profile generates the adapter; other restricted features stay out', () => {
    expect(D.DEMO_PROFILE.restrictedFeatures).toEqual(['demo-welcome']);
    const demo = generateCustomerPrivatePlugins(manifest, { ...D.DEMO_PROFILE, restrictedFeatures: [...D.DEMO_PROFILE.restrictedFeatures] } as unknown as DeliveryProfile);
    expect(demo).toContain("'./features/demo-welcome.register'");
    expect(demo).not.toContain('agents.register');
    expect(demo).not.toContain('omniverse.register');
    expect(demo).not.toContain('aml-import.register');
    const customer = generateCustomerPrivatePlugins(manifest, { tier: 'commercial', restrictedFeatures: [] });
    expect(customer).not.toContain('demo-welcome');
  });

  it('the public catalog does not name the feature', () => {
    expect(readFileSync(join(ROOT, 'features.catalog.json'), 'utf8')).not.toContain('demo-welcome');
  });

  it('the define defaults to false and is set only from RV_DEMO_WELCOME=1', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain("__RV_DEMO_WELCOME__: JSON.stringify(process.env.RV_DEMO_WELCOME === '1')");
  });

  it('the adapter imports the window only behind the flag, dynamically', () => {
    const adapter = readFileSync(join(PRIVATE_ROOT, 'src/features/demo-welcome.register.ts'), 'utf8');
    const code = adapter.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/^\s*import\s+(?!type\b).*plugins\/demo-welcome/m);
    expect(code).toMatch(/if\s*\(\s*!__RV_DEMO_WELCOME__\s*\)\s*return;[\s\S]*await import\(\s*'\.\.\/plugins\/demo-welcome\/demo-welcome-plugin'\s*\)/);
  });
});
