// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-503 §9.2 — the post-deploy demo smoke inside `deployPublic()`.
 *
 * The real entry runs against a stubbed storage zone (fetch), a stubbed staging
 * (`deps.stageAndBuild`), a stubbed publish lock (`deps.acquireLock`) and a
 * stubbed runner (`deps.runSmoke`). Nothing is built, uploaded, purged or
 * browsed for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as deployModule from '../scripts/bunny-deploy.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
// scripts/bunny-deploy.d.mts declares only the upload helpers; the plan-503 exports are typed here.
const D = deployModule as unknown as {
  deployPublic(cfg: Record<string, unknown>, opts: Record<string, unknown>, deps?: Record<string, unknown>): Promise<void>;
  SmokeFailedError: new (result: Record<string, unknown>, url: string) => Error & { exitCode: number; result: any };
  exitCodeFor(error: unknown): number;
  smokeBaseUrl(prefix: string | null, env?: Record<string, string | undefined>): string;
  smokeOutDir(env?: Record<string, string | undefined>, now?: () => number): string;
};

const SCRIPT = resolve(__dirname, '../scripts/bunny-deploy.mjs');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const DEMOS = { hmi: 'doc_hmi', planner: 'doc_planner' };

type FetchReply = { ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>; json(): Promise<unknown> };
const reply = (status: number, body: unknown = []): FetchReply => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
});

describe('deployPublic — post-deploy demo smoke (plan-503 §9.2)', () => {
  let work: string;
  let outDir: string;
  let events: string[];
  const saved: Record<string, string | undefined> = {};
  const envKeys = ['RV_KEEP_STAGING', 'RV_SIGN_PRIVATE_KEY', 'RV_SEO', 'RV_PUBLIC_MODEL_PREFIX', 'RV_SEO_CANONICAL_PATH',
    'RV_SMOKE_OUT_DIR', 'RV_SMOKE_PAIR', 'RV_PUBLIC_BASE_URL', 'RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS'];
  const cfg = { storageZone: 'z503', region: 'storage.bunnycdn.com', storageKey: 'K', accountKey: 'A', pullZoneId: '42', remotePath: '', googleAnalyticsId: '', newsApiUrl: '' };

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv503-gate-'));
    outDir = join(work, 'last-smoke');
    events = [];
    for (const key of envKeys) { saved[key] = process.env[key]; delete process.env[key]; }
    process.env.RV_SMOKE_OUT_DIR = outDir;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string }) => {
      if (String(url).startsWith('https://api.bunny.net/')) { events.push('PURGE'); return reply(200); }
      if (init.method === 'GET') return reply(404);
      return reply(init.method === 'PUT' ? 201 : 200);
    }));
  });
  afterEach(() => {
    for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  //! A staging stand-in with a real demo manifest and two demo GLBs; records the dist it handed out.
  const staged: { distDir?: string; workspaceRoot?: string } = {};
  function staging() {
    return () => {
      const workspaceRoot = mkdtempSync(join(work, 'rv-customer-workspace-'));
      const distDir = join(workspaceRoot, 'realvirtual-web', 'dist');
      mkdirSync(join(distDir, 'demo-realvirtual'), { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html><head></head><body>app</body></html>');
      writeFileSync(join(distDir, 'demo-realvirtual', 'project.json'), JSON.stringify({
        demos: DEMOS,
        documents: [{ id: 'doc_hmi', path: 'DemoHmi.glb' }, { id: 'doc_planner', path: 'DemoPlanner.glb' }],
      }));
      writeFileSync(join(distDir, 'demo-realvirtual', 'DemoHmi.glb'), Buffer.alloc(123));
      writeFileSync(join(distDir, 'demo-realvirtual', 'DemoPlanner.glb'), Buffer.alloc(45));
      Object.assign(staged, { distDir, workspaceRoot });
      return { workspaceRoot, distDir };
    };
  }
  const lock = () => async () => { events.push('LOCKED'); return { name: 'l', release: async () => { events.push('RELEASED'); } }; };
  const smoke = (result: Record<string, unknown>, seen: Array<Record<string, any>> = []) => async (opts: Record<string, any>) => {
    events.push('SMOKE');
    // The staging dist still exists while the smoke runs (the fingerprint is read from it).
    seen.push({ ...opts, stagingAlive: existsSync(staged.distDir!), indexHtml: readFileSync(join(staged.distDir!, 'index.html')) });
    const reportPath = join(opts.outDir, 'smoke-result.json');
    writeFileSync(reportPath, JSON.stringify({ ...result, reportPath }));
    return { failures: [], flaky: [], durationMs: 1000, ...result, reportPath };
  };
  // The plan-508 post-deploy probe runs right before the smoke; stubbed so it never asks the real host.
  const probe = async () => { events.push('PROBE'); return { ok: true, findings: [], checks: [] }; };
  const deps = (runSmoke: unknown) => ({ stageAndBuild: staging(), sleep: async () => {}, acquireLock: lock(), probe, runSmoke });
  const leftovers = () => readdirSync(work).filter((name) => name.startsWith('rv-customer-workspace-'));

  it('throws SmokeFailedError with exitCode 3 after purge when smoke fails', async () => {
    const failing = smoke({ status: 'failed', reason: 'tests', failures: [{ spec: 'planner-journey.spec.ts', title: 'planner-journey.spec.ts › drag', message: 'x', attachments: [] }] });
    const run = D.deployPublic(cfg, { path: 'dev', demo: true }, deps(failing));
    await expect(run).rejects.toBeInstanceOf(D.SmokeFailedError);
    const error = await D.deployPublic(cfg, { path: 'dev', demo: true }, deps(failing)).catch((e) => e);
    expect(error.exitCode).toBe(3);
    expect(error.message).toMatch(/the build IS live at https:\/\/web\.realvirtual\.io\/dev\//);
    expect(error.message).toMatch(/smoke-result\.json/);
    expect(error.message).toMatch(/previous tag/);
    expect(D.exitCodeFor(error)).toBe(3);
    // Upload and purge happened BEFORE the smoke: the deploy is live.
    expect(events.indexOf('PURGE')).toBeLessThan(events.indexOf('SMOKE'));
  });

  it('does not run the smoke with --no-smoke, --dry-run or --private', async () => {
    const seen: Array<Record<string, any>> = [];
    await D.deployPublic(cfg, { path: 'dev', demo: true, noSmoke: true }, deps(smoke({ status: 'ok' }, seen)));
    await D.deployPublic(cfg, { path: 'dev', demo: true, dryRun: true }, deps(smoke({ status: 'ok' }, seen)));
    expect(seen).toEqual([]);
    expect(events).not.toContain('SMOKE');
    // --private goes through deployPrivate/publishPrivateBuild, which never reach the smoke.
    const source = readFileSync(SCRIPT, 'utf8');
    const privatePart = source.slice(source.indexOf('async function deployPrivate('), source.indexOf('async function main('));
    expect(privatePart.length).toBeGreaterThan(1000);
    expect(privatePart).not.toMatch(/runPostDeploySmoke|runSmoke|runDemoSmoke/);
  });

  it('runs the smoke before releasing the publish lock and releases it even when smoke throws', async () => {
    await D.deployPublic(cfg, { path: 'dev', demo: true }, deps(smoke({ status: 'ok' })));
    expect(events).toEqual(['LOCKED', 'PURGE', 'PROBE', 'SMOKE', 'RELEASED']);

    events = [];
    const throwing = async () => { events.push('SMOKE'); throw new Error('runner bug'); };
    const error = await D.deployPublic(cfg, { path: 'dev', demo: true }, deps(throwing)).catch((e) => e);
    // A runner that throws is a failed smoke (exit 3), never a failed deploy (exit 1).
    expect(error).toBeInstanceOf(D.SmokeFailedError);
    expect(error.result).toMatchObject({ status: 'failed', reason: 'crashed' });
    expect(events).toEqual(['LOCKED', 'PURGE', 'PROBE', 'SMOKE', 'RELEASED']);
    expect(JSON.parse(readFileSync(join(outDir, 'smoke-result.json'), 'utf8')).reason).toBe('crashed');
  });

  it('a failed plan-508 probe stops the deploy before the smoke (exit 1, lock released)', async () => {
    const badProbe = async () => { events.push('PROBE'); return { ok: false, findings: ['missing asset answered 200'], checks: [] }; };
    const error = await D.deployPublic(cfg, { path: 'dev', demo: true }, { ...deps(smoke({ status: 'ok' })), probe: badProbe }).catch((e) => e);
    expect(error).not.toBeInstanceOf(D.SmokeFailedError);
    expect(D.exitCodeFor(error)).toBe(1);
    expect(events).toEqual(['LOCKED', 'PURGE', 'PROBE', 'RELEASED']);
  });

  it('builds the smoke URL from host + remotePrefix for dev/, for --root and with RV_SEO=0', async () => {
    expect(D.smokeBaseUrl('dev', {})).toBe('https://web.realvirtual.io/dev/');
    expect(D.smokeBaseUrl('/dev/', {})).toBe('https://web.realvirtual.io/dev/');
    expect(D.smokeBaseUrl('', {})).toBe('https://web.realvirtual.io/');
    expect(D.smokeBaseUrl(null, {})).toBe('https://web.realvirtual.io/');
    expect(D.smokeBaseUrl('dev', { RV_PUBLIC_BASE_URL: 'https://fork.example/' })).toBe('https://fork.example/dev/');

    const seen: Array<Record<string, any>> = [];
    await D.deployPublic(cfg, { path: null, root: true }, deps(smoke({ status: 'ok' }, seen)));
    process.env.RV_SEO = '0';
    await D.deployPublic(cfg, { path: 'dev', demo: true }, deps(smoke({ status: 'ok' }, seen)));
    delete process.env.RV_SEO;
    await D.deployPublic(cfg, { path: 'demo', demo: true, base: '/demo/' }, deps(smoke({ status: 'ok' }, seen)));
    expect(seen.map((s) => s.baseUrl)).toEqual(['https://web.realvirtual.io/', 'https://web.realvirtual.io/dev/', 'https://web.realvirtual.io/demo/']);
  });

  it('passes an outDir outside the staging root; smoke-result.json survives releaseStaging()', async () => {
    process.env.RV_SMOKE_PAIR = JSON.stringify({ web: 'a'.repeat(40), private: 'b'.repeat(40) });
    const seen: Array<Record<string, any>> = [];
    await D.deployPublic(cfg, { path: 'dev', demo: true }, deps(smoke({ status: 'ok' }, seen)));
    const [call] = seen;
    expect(call.stagingAlive).toBe(true);
    expect(resolve(call.outDir)).toBe(resolve(outDir));
    const rel = relative(staged.workspaceRoot!, call.outDir);
    expect(rel.startsWith('..') || isAbsolute(rel)).toBe(true);
    // The staging is gone, the smoke output is not.
    expect(leftovers()).toEqual([]);
    expect(existsSync(join(outDir, 'smoke-result.json'))).toBe(true);
    // expected.json was written by the DEPLOY before the runner — from the staging bytes after SEO injection.
    expect(call.expectedFile).toBe(join(outDir, 'expected.json'));
    const expected = JSON.parse(readFileSync(join(outDir, 'expected.json'), 'utf8'));
    expect(expected).toMatchObject({
      pair: { web: 'a'.repeat(40), private: 'b'.repeat(40) },
      baseUrl: 'https://web.realvirtual.io/dev/',
      demos: DEMOS,
      fingerprint: { glbs: { 'DemoHmi.glb': { size: 123 }, 'DemoPlanner.glb': { size: 45 } } },
    });
    expect(String(call.indexHtml)).toMatch(/noindex/); // dev/ is noindexed before upload
    expect(expected.fingerprint.indexHtml).toBe(sha(call.indexHtml));
    // Without RV_SMOKE_OUT_DIR a release deploy writes to <repo>/.smoke/<time>/.
    const fallback = D.smokeOutDir({}, () => Date.UTC(2026, 8, 26, 12, 0, 0));
    expect(fallback).toBe(join(resolve(__dirname, '..'), '.smoke', '2026-09-26T12-00-00-000Z'));
  });

  it('maps SmokeFailedError to exit 3 and every other error to exit 1 in main()', () => {
    expect(D.exitCodeFor(new D.SmokeFailedError({ status: 'failed', reportPath: 'r' }, 'u'))).toBe(3);
    expect(D.exitCodeFor(new Error('upload failed'))).toBe(1);
    expect(D.exitCodeFor('string')).toBe(1);
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/main\(\)\.catch\(\(e\) => \{[\s\S]*?process\.exit\(exitCodeFor\(e\)\);/);
    // A real CLI error (refused before anything runs) still exits 1.
    const cli = spawnSync(process.execPath, [SCRIPT, '--no-build'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, BUNNY_STORAGE_KEY: '' } });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/--no-build is disabled/);
  });
});
