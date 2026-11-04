// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-gpu-run.node.test.ts — the GPU group (`npm run test:gpu`, vitest.gpu.config.ts, 2026-10-17).
 *
 *  - vitest.gpu.config.ts carries the GPU launch args and the full-Chromium channel at PROVIDER
 *    level (chrome-headless-shell lacks dxil.dll → no WebGPU device), runs serially, has its
 *    own cacheDir, stays headless, includes only tests/gpu-tests.json and builds on vite.config.ts;
 *  - the main configs (vite.config.ts, vitest.node.config.ts) carry NONE of the GPU flags and
 *    do not reference the GPU group — no leakage into the measured main suite;
 *  - package.json: `test:gpu` runs under the test lock and is NOT part of `test:all`;
 *  - tests/gpu-tests.json: sorted, unique, every file exists (private ones with the sibling),
 *    uses skipEachWithoutAdapter, and every file of the WebGPU quarantine is listed;
 *  - the GPU group is never staged into a delivery (scripts/_workspace-lib.mjs);
 *  - the summary separates failures inside the quarantine baseline from those outside it,
 *    and a run without an adapter is recognised (classifyGpuRun / formatGpuRunSummary).
 *
 * Reads files as text — it never loads vitest.gpu.config.ts (that would load vite.config.ts
 * with all its plugins).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GPU_BROWSER_CHANNEL,
  GPU_CACHE_DIR,
  GPU_LAUNCH_ARGS,
  GPU_SETUP_FILE,
  NO_ADAPTER_MARK,
  NOW_PASSES_MARK,
  PRIVATE_PREFIX,
  classifyGpuRun,
  formatGpuRunSummary,
  gpuTestFiles,
  readGpuTests,
  mainSuiteEntries,
  readQuarantineIds,
} from '../scripts/test-gpu-run.mjs';
import { GPU_RUN_WITHOUT_ADAPTER, NO_WEBGPU_ADAPTER } from './helpers/webgpu-adapter-skip';

const ROOT = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
/** Code without comments — a flag named in a doc comment is not a flag that is set. */
const code = (rel: string): string => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HAS_PRIVATE = existsSync(resolve(ROOT, PRIVATE_PREFIX, 'src'));
const GPU_FLAGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

describe('vitest.gpu.config.ts', () => {
  const config = code('vitest.gpu.config.ts');

  it('the launch args are exactly the measured GPU flags (plan-602)', () => {
    expect([...GPU_LAUNCH_ARGS]).toEqual(GPU_FLAGS);
  });

  it('hands the GPU flags to the PROVIDER (instances[].launchOptions is not forwarded in vitest 4.0.18)', () => {
    expect(config).toMatch(/provider:\s*playwright\(\{\s*launchOptions:\s*\{\s*channel:\s*GPU_BROWSER_CHANNEL,\s*args:\s*\[\.\.\.GPU_LAUNCH_ARGS\]\s*\}\s*\}\)/);
    expect(config).toMatch(/instances:\s*\[\{\s*browser:\s*'chromium'\s*\}\]/);
    expect(config).not.toMatch(/instances:[^\]]*launchOptions/);
  });

  it('launches the FULL Chromium (channel chromium), not chrome-headless-shell (no dxil.dll → requestDevice fails, measured 2026-10-17)', () => {
    expect(GPU_BROWSER_CHANNEL).toBe('chromium');
    expect(config).toMatch(/import \{[^}]*GPU_BROWSER_CHANNEL[^}]*\} from '\.\/scripts\/test-gpu-run\.mjs'/);
    // canary: playwright-core still maps channel 'chromium' to the full build and no channel + headless to the shell.
    const chromiumJs = readFileSync(resolve(ROOT, 'node_modules/playwright-core/lib/server/chromium/chromium.js'), 'utf8');
    expect(chromiumJs).toMatch(/if \(options\.channel\)\s*return options\.channel;\s*return options\.headless \? "chromium-headless-shell" : "chromium";/);
    // canary: @vitest/browser-playwright spreads the provider launchOptions (channel included) into launch().
    const providerJs = readFileSync(resolve(ROOT, 'node_modules/@vitest/browser-playwright/dist/index.js'), 'utf8');
    expect(providerJs).toMatch(/const launchOptions = \{\s*\.\.\.this\.options\.launchOptions,\s*headless: options\.headless\s*\};/);
  });

  it('the setup file checks requestDevice, not only the adapter', () => {
    const setup = code(GPU_SETUP_FILE);
    expect(setup).toMatch(/await adapter\.requestDevice\(\)\)\.destroy\(\)/);
    expect(setup).toContain('GPU group: WebGPU adapter present but requestDevice failed: ');
    expect(setup).toMatch(/device=\$\{device\}/);
  });

  it('runs serially, headless, with its own cache, setup file and file list', () => {
    expect(config).toMatch(/fileParallelism:\s*false/);
    expect(config).toMatch(/maxWorkers:\s*1\b/);
    expect(config).toMatch(/headless:\s*true/);
    expect(config).toMatch(/cacheDir:\s*GPU_CACHE_DIR/);
    expect(GPU_CACHE_DIR).toBe('node_modules/.vite-gpu');
    expect(config).toMatch(/setupFiles:\s*\[GPU_SETUP_FILE\]/);
    expect(existsSync(resolve(ROOT, GPU_SETUP_FILE))).toBe(true);
    expect(config).toMatch(/include:\s*gpuTestFiles\(/);
    expect(config).toMatch(/gpuRunReporterPlugin\(\)/);
  });

  it('builds on vite.config.ts (plugins, aliases, define, optimizeDeps, exclude, globalSetup inherited)', () => {
    expect(config).toMatch(/import mainConfig from '\.\/vite\.config'/);
    expect(config).toMatch(/\.\.\.base,/);
    expect(config).toMatch(/\.\.\.baseTest,/);
    expect(config).toMatch(/\.\.\.baseTest\.browser,/);
    // optimizeDeps: only `entries` is set (scan parity, below); `include` stays the main suite's.
    expect(config).toMatch(/optimizeDeps:\s*\{\s*\.\.\.base\.optimizeDeps,\s*entries:\s*mainEntries\s*\}/);
  });

  it('scans the MAIN suite test files (vitest browser mode scans only the include of the run — first GPU run: 37 mid-run re-optimizations)', () => {
    expect(config).toMatch(/mainSuiteEntries\(\{\s*root:\s*__dirname,\s*include:\s*baseTest\.include \?\? \[\],\s*exclude:\s*baseTest\.exclude \?\? \[\]\s*\}\)/);
  });
});

describe('mainSuiteEntries', () => {
  it('canary: vitest browser mode still derives the optimizer entries from the project include (not the CLI filter)', () => {
    const browserDist = readFileSync(resolve(ROOT, 'node_modules/@vitest/browser/dist/index.js'), 'utf8');
    // plugin `vitest:browser:tests` → config(): entries = project.globTestFiles() (no filters) + setupFiles + vitest dist.
    expect(browserDist).toMatch(/const \{ testFiles: browserTestFiles \} = await project\.globTestFiles\(\);/);
    expect(browserDist).toMatch(/const entries = \[\s*\.\.\.browserTestFiles,\s*\.\.\.setupFiles,/);
  });

  it('globs like vitest: concrete absolute slashed paths, include minus exclude, GPU files among them', async () => {
    const entries = await mainSuiteEntries({
      root: ROOT,
      include: ['tests/**/*.test.{ts,tsx}'],
      exclude: ['tests/**/*.node.test.ts', 'tests/fixtures/quarantine/**'],
    });
    expect(entries.length).toBeGreaterThan(100);
    expect([...entries].sort()).toEqual(entries);
    for (const file of entries) {
      expect(file).not.toMatch(/\\|[*{}]/);
      expect(resolve(file).replace(/\\/g, '/')).toBe(file);
    }
    expect(entries.some((f) => f.endsWith('.node.test.ts'))).toBe(false);
    expect(entries.some((f) => f.includes('/tests/fixtures/quarantine/'))).toBe(false);
    for (const file of gpuTestFiles({ root: ROOT, hasPrivate: false })) {
      expect(entries).toContain(resolve(ROOT, file).replace(/\\/g, '/'));
    }
  });
});

describe('the main configs stay GPU-free', () => {
  for (const file of ['vite.config.ts', 'vitest.node.config.ts']) {
    it(`${file} carries no GPU flag and does not reference the GPU group`, () => {
      const text = code(file);
      for (const flag of GPU_FLAGS) expect(text).not.toContain(flag);
      expect(text).not.toContain('launchOptions');
      expect(text).not.toContain('vitest.gpu.config');
      expect(text).not.toContain('gpu-tests.json');
      expect(text).not.toContain('test-gpu-run');
      expect(text).not.toContain('gpu-run-setup');
    });
  }

  it('the main skip note points at the GPU run, the GPU-run failure names the cause', () => {
    expect(NO_WEBGPU_ADAPTER).toBe('no WebGPU adapter (main suite runs without GPU — covered by npm run test:gpu)');
    expect(GPU_RUN_WITHOUT_ADAPTER.startsWith(NO_ADAPTER_MARK)).toBe(true);
  });
});

describe('package.json', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

  it('test:gpu runs the GPU config under the machine-wide test lock', () => {
    expect(scripts['test:gpu']).toBe('node scripts/with-test-lock.mjs vitest run --config vitest.gpu.config.ts');
  });

  it('test, test:node and test:all do not run the GPU group', () => {
    for (const name of ['test', 'test:node', 'test:all']) expect(scripts[name]).not.toMatch(/gpu/);
    const runAll = code('scripts/run-all-tests.mjs');
    expect(runAll).not.toMatch(/test:gpu|vitest\.gpu\.config/);
  });
});

describe('tests/gpu-tests.json', () => {
  const entries = readGpuTests(ROOT);
  const files = entries.map((e) => e.file);

  it('is sorted, unique, and every entry gives a reason', () => {
    expect(files.length).toBeGreaterThan(0);
    expect([...files].sort()).toEqual(files);
    expect(new Set(files).size).toBe(files.length);
    for (const e of entries) expect(e.why?.trim()).toBeTruthy();
  });

  it('every listed file exists (private ones only with the sibling) and guards with skipEachWithoutAdapter', () => {
    for (const file of files) {
      if (file.startsWith('../') && !HAS_PRIVATE) continue;
      expect(file.startsWith('../') ? file.startsWith(PRIVATE_PREFIX) : file.startsWith('tests/')).toBe(true);
      const abs = resolve(ROOT, file);
      expect(existsSync(abs), file).toBe(true);
      expect(readFileSync(abs, 'utf8'), file).toMatch(/skipEachWithoutAdapter\(/);
    }
  });

  it('lists every file of the WebGPU quarantine (otherwise a quarantined test never runs with a GPU)', () => {
    const quarantineFiles = new Set(readQuarantineIds(ROOT).map((id) => id.split(' :: ')[0]));
    for (const file of quarantineFiles) expect(files, file).toContain(file);
  });

  it('gpuTestFiles drops private entries without the sibling', () => {
    expect(gpuTestFiles({ root: ROOT, hasPrivate: true })).toEqual(files);
    expect(gpuTestFiles({ root: ROOT, hasPrivate: false })).toEqual(files.filter((f) => !f.startsWith('../')));
  });
});

describe('staging', () => {
  it('the GPU group is not staged into deliveries (tests/ is not staged either)', () => {
    const lib = read('scripts/_workspace-lib.mjs');
    expect(lib).not.toContain('vitest.gpu.config.ts');
    expect(lib).not.toContain('test-gpu-run');
  });
});

describe('classifyGpuRun / formatGpuRunSummary', () => {
  const Q = ['tests/a.test.ts :: s > known', 'tests/a.test.ts :: s > fixed', 'tests/a.test.ts :: s > other', 'tests/b.test.ts :: s > absent'];

  it('separates the quarantine baseline from the rest', () => {
    const c = classifyGpuRun({
      quarantineIds: Q,
      tests: [
        { id: Q[0], state: 'passed', errors: [] },
        { id: Q[1], state: 'failed', errors: [`${NOW_PASSES_MARK} — remove ${Q[1]}`] },
        { id: Q[2], state: 'failed', errors: ['Test timed out in 5000ms.\nstack'] },
        { id: 'tests/a.test.ts :: s > plain', state: 'passed', errors: [] },
        { id: 'tests/a.test.ts :: s > broken', state: 'failed', errors: ['expected 1 to be 2'] },
      ],
    });
    expect(c.noAdapter).toBe(false);
    expect(c.baseline.reproduced).toEqual([Q[0]]);
    expect(c.baseline.nowPasses).toEqual([Q[1]]);
    expect(c.baseline.otherCause).toEqual([{ id: Q[2], message: 'Test timed out in 5000ms.' }]);
    expect(c.baseline.notRun).toEqual([Q[3]]);
    expect(c.outside.passed).toBe(1);
    expect(c.outside.failed).toEqual([{ id: 'tests/a.test.ts :: s > broken', message: 'expected 1 to be 2' }]);

    const lines = formatGpuRunSummary(c);
    expect(lines[0]).toBe('[gpu-run] WebGPU adapter present');
    expect(lines[1]).toBe('[gpu-quarantine] inside the baseline (4): 1 known failure reproduced, 1 now pass (remove from the list), 1 failed for another cause, 0 skipped, 1 not run');
    expect(lines[2]).toBe('[gpu-quarantine] outside the baseline: 1 passed, 1 failed, 0 skipped');
    expect(lines).toContain(`[gpu-quarantine]   now passes: ${Q[1]}`);
    expect(lines).toContain('[gpu-quarantine]   outside, failed: tests/a.test.ts :: s > broken — expected 1 to be 2');
  });

  it('a missing adapter — in a test or in the setup file — is recognised', () => {
    const inTest = classifyGpuRun({ tests: [{ id: 'tests/x.test.ts :: s > t', state: 'failed', errors: [GPU_RUN_WITHOUT_ADAPTER] }] });
    expect(inTest.noAdapter).toBe(true);
    const inSetup = classifyGpuRun({ fileErrors: [{ file: 'tests/x.test.ts', message: `${GPU_RUN_WITHOUT_ADAPTER} (requestAdapter() returned null)` }] });
    expect(inSetup.noAdapter).toBe(true);
    expect(formatGpuRunSummary(inSetup)[0]).toMatch(/^\[gpu-run\] FAILED: GPU group without a WebGPU adapter/);
  });
});
