// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-503 §9.4 — the contract between playwright.config.ts, the `prod-demo`
 * specs and the smoke runner:
 *
 * - `prod-demo` exists ONLY with RV_SMOKE_BASE_URL, and then no webServer starts;
 * - `chromium` never picks up e2e/prod-demo/ (but keeps e2e/prod-demo-calibration/);
 * - the runner's expected test identities (F14) are the ones the specs declare;
 * - `_live-target.ts` throws instead of skipping (A5);
 * - the 404 allowlist of the boot smoke (F2): optional sidecars green, required assets red.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain ESM script without type declarations
import * as runner from '../scripts/rv-demo-smoke.mjs';
import { disallowedNotFound, isAllowedNotFound } from '../e2e/_viewer-ready';

/* eslint-disable @typescript-eslint/no-explicit-any */
// The config is plain data behind `defineConfig`; importing the real playwright/test takes
// 10–90 s on a loaded machine, so the config contract is read through a transparent stand-in.
// (The `--list` test below runs the REAL Playwright CLI against the same config.)
vi.mock('playwright/test', () => ({
  defineConfig: (config: unknown) => config,
  devices: { 'Desktop Chrome': { browserName: 'chromium', viewport: { width: 1280, height: 720 } } },
}));

const R = runner as { JOURNEY_TITLES: readonly string[]; bootTitle(key: string): string; expectedTitles(demos: Record<string, string>): string[] };
const ROOT = resolve(__dirname, '..');
const PROD_DEMO_DIR = join(ROOT, 'e2e', 'prod-demo');
const SMOKE_ENV = ['RV_SMOKE_BASE_URL', 'RV_SMOKE_EXPECTED_DEMOS'] as const;

async function loadConfig(env: Record<string, string | undefined>): Promise<any> {
  for (const key of SMOKE_ENV) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  vi.resetModules();
  return (await import('../playwright.config')).default;
}

describe('playwright.config.ts — prod-demo contract (plan-503 §9.4)', () => {
  const saved = Object.fromEntries(SMOKE_ENV.map((key) => [key, process.env[key]]));
  afterEach(() => {
    for (const key of SMOKE_ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    vi.resetModules();
  });

  it('has no prod-demo project and both webServers without RV_SMOKE_BASE_URL', async () => {
    const config = await loadConfig({});
    expect(config.projects.map((p: any) => p.name)).toEqual(['chromium', 'chrome', 'embed-chromium']);
    // plan-766: the GPU-measuring editor-arena specs run in the installed Google
    // Chrome, and only there (each spec in exactly one project).
    const chrome = config.projects.find((p: any) => p.name === 'chrome');
    expect(chrome.use.channel).toBe('chrome');
    expect(chrome.testMatch.test('e2e/editor-arena-perf.spec.ts')).toBe(true);
    const chromium = config.projects.find((p: any) => p.name === 'chromium');
    expect((chromium.testIgnore as RegExp[]).some((re) => re.test('e2e/editor-arena-perf.spec.ts'))).toBe(true);
    expect(config.webServer).toHaveLength(2);
    expect(config.workers).toBeUndefined();
  });

  it('has prod-demo with baseURL and an empty webServer list with RV_SMOKE_BASE_URL', async () => {
    const config = await loadConfig({ RV_SMOKE_BASE_URL: 'https://web.realvirtual.io/dev/' });
    const prod = config.projects.find((p: any) => p.name === 'prod-demo');
    expect(prod).toBeDefined();
    expect(prod.use.baseURL).toBe('https://web.realvirtual.io/dev/');
    expect(prod.retries).toBe(1);
    expect(prod.timeout).toBe(120_000);
    expect(prod.use.trace).toBe('on-first-retry');
    expect(prod.use.screenshot).toBe('only-on-failure');
    expect(prod.testMatch.test('prod-demo/demo-smoke.spec.ts')).toBe(true);
    expect(prod.testMatch.test('prod-demo-calibration/motion-threshold.spec.ts')).toBe(false);
    expect(config.webServer).toEqual([]);
    expect(config.workers).toBe(1);
  });

  it('chromium project ignores e2e/prod-demo/ but keeps the local calibration spec', async () => {
    const config = await loadConfig({});
    const chromium = config.projects.find((p: any) => p.name === 'chromium');
    const ignored = (path: string) => (chromium.testIgnore as RegExp[]).some((re) => re.test(path));
    expect(ignored('e2e/prod-demo/demo-smoke.spec.ts')).toBe(true);
    expect(ignored('e2e/prod-demo/planner-journey.spec.ts')).toBe(true);
    expect(ignored('e2e/prod-demo-calibration/motion-threshold.spec.ts')).toBe(false);
    expect(ignored('e2e/smoke.spec.ts')).toBe(false);
  });

  it('playwright test --list without RV_SMOKE_BASE_URL lists no prod-demo test and the same count as before', () => {
    const env = { ...process.env };
    for (const key of SMOKE_ENV) delete env[key];
    const list = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'playwright', 'cli.js'), 'test', '--list'], {
      cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    });
    expect(list.status, list.stderr).toBe(0);
    const lines = list.stdout.split(/\r?\n/);
    expect(lines.filter((l) => /prod-demo[\\/]/.test(l))).toEqual([]);
    // "The same count as before": every e2e/*.spec.ts file plus exactly the calibration spec —
    // the live specs add nothing to a local run.
    const localSpecs = readdirSync(join(ROOT, 'e2e')).filter((f) => f.endsWith('.spec.ts')).length;
    const total = /Total: (\d+) tests? in (\d+) files?/.exec(list.stdout);
    expect(total, list.stdout.slice(-500)).not.toBeNull();
    expect(Number(total![2])).toBe(localSpecs + 1);
    expect(lines.filter((l) => /prod-demo-calibration[\\/]motion-threshold\.spec\.ts/.test(l))).toHaveLength(1);
  }, 180_000);

  it('EXPECTED_TITLES in rv-demo-smoke.mjs equal the test identities (F14) found in e2e/prod-demo/*.spec.ts', () => {
    const specs = readdirSync(PROD_DEMO_DIR).filter((f) => f.endsWith('.spec.ts')).sort();
    expect(specs).toEqual(['demo-smoke.spec.ts', 'editor-test-run-journey.spec.ts', 'hmi-journey.spec.ts', 'planner-journey.spec.ts']);
    const declared: string[] = [];
    for (const file of specs) {
      const source = readFileSync(join(PROD_DEMO_DIR, file), 'utf8');
      expect(source, `${file} must not use describe (it would change the identity)`).not.toMatch(/test\.describe\(/);
      for (const m of source.matchAll(/^\s*test\((['`])(.+?)\1,/gm)) declared.push(`${file} › ${m[2]}`);
    }
    // demo-smoke.spec.ts declares ONE templated test per demos key.
    expect(declared).toContain('demo-smoke.spec.ts › boots ${key} demo without errors');
    expect(R.bootTitle('${key}')).toBe('demo-smoke.spec.ts › boots ${key} demo without errors');
    const journeys = declared.filter((t) => !t.startsWith('demo-smoke.spec.ts'));
    expect(journeys.sort()).toEqual([...R.JOURNEY_TITLES].sort());
    expect(R.expectedTitles({ hmi: 'a', planner: 'b' })).toEqual([
      'demo-smoke.spec.ts › boots hmi demo without errors',
      'demo-smoke.spec.ts › boots planner demo without errors',
      ...R.JOURNEY_TITLES,
    ]);
  });

  it('_live-target.ts throws (does not skip) without RV_SMOKE_BASE_URL / RV_SMOKE_EXPECTED_DEMOS', async () => {
    for (const key of SMOKE_ENV) delete process.env[key];
    vi.resetModules();
    await expect(import('../e2e/prod-demo/_live-target')).rejects.toThrow(/RV_SMOKE_BASE_URL is not set/);
    process.env.RV_SMOKE_BASE_URL = 'https://x.invalid/dev/';
    vi.resetModules();
    await expect(import('../e2e/prod-demo/_live-target')).rejects.toThrow(/RV_SMOKE_EXPECTED_DEMOS is not set/);
    process.env.RV_SMOKE_EXPECTED_DEMOS = JSON.stringify({ hmi: 'h' });
    vi.resetModules();
    await expect(import('../e2e/prod-demo/_live-target')).rejects.toThrow(/lacks "planner"/);
    const source = readFileSync(join(PROD_DEMO_DIR, '_live-target.ts'), 'utf8');
    expect(source).not.toMatch(/test\.skip|skipIf/);
    for (const file of readdirSync(PROD_DEMO_DIR).filter((f) => f.endsWith('.spec.ts'))) {
      expect(readFileSync(join(PROD_DEMO_DIR, file), 'utf8'), file).not.toMatch(/test\.skip|test\.fail\(|skipIf/);
    }
  });
});

describe('boot smoke 404 allowlist (plan-503 F2)', () => {
  const BASE = 'https://web.realvirtual.io/dev/';

  it('allows the root project.json/models.json probes and optional *.kin.json sidecars', () => {
    expect(isAllowedNotFound(`${BASE}project.json`, BASE)).toBe(true);
    expect(isAllowedNotFound(`${BASE}models.json?x=1`, BASE)).toBe(true);
    expect(isAllowedNotFound(`${BASE}library/PalletHandling/Pallet.kin.json`, BASE)).toBe(true);
    expect(isAllowedNotFound(`${BASE}demo-realvirtual/DemoPlanner.kin.json?v=3`, BASE)).toBe(true);
    expect(disallowedNotFound([`${BASE}project.json`, `${BASE}library/A/B.kin.json`], BASE)).toEqual([]);
  });

  it('flags a missing required asset — GLB, manifest, chunk — and a project.json that is not at the root', () => {
    const missing = [
      `${BASE}demo-realvirtual/DemoPlanner.glb`,
      `${BASE}demo-realvirtual/project.json`,
      `${BASE}assets/index-abc123.js`,
      `${BASE}library/PalletHandling/Pallet.glb`,
    ];
    expect(disallowedNotFound([...missing, `${BASE}models.json`], BASE)).toEqual(missing);
    // The root of ANOTHER deploy is not this deploy's root.
    expect(isAllowedNotFound('https://web.realvirtual.io/project.json', BASE)).toBe(false);
    expect(isAllowedNotFound('https://web.realvirtual.io/project.json', 'https://web.realvirtual.io/')).toBe(true);
  });

  it('allows the MCP bridge same-origin /health probe (plan-668), nothing else named health', () => {
    expect(isAllowedNotFound('https://web.realvirtual.io/health', BASE)).toBe(true);
    expect(isAllowedNotFound('http://localhost:5100/health', BASE)).toBe(false);
    expect(isAllowedNotFound(`${BASE}health`, BASE)).toBe(false);
    expect(isAllowedNotFound('https://web.realvirtual.io/health/x', BASE)).toBe(false);
  });
});
