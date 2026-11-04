// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The GPU group — a separate, serial vitest browser run of the WebGPU test files WITH the
 * real GPU (2026-10-17). Invocation: `npm run test:gpu` (under the machine-wide test lock).
 * NOT part of `npm test` / `npm run test:all`.
 *
 * Built from vite.config.ts unchanged — plugins (testLockProgressPlugin incl. strict deps,
 * the private resolver, …), resolve.alias / @rv-private, define, optimizeDeps.include, server,
 * test.exclude, test.globalSetup (the lock guard) and browser.commands are inherited by
 * spreading the resolved main config — and overrides ONLY:
 *  - `test.include`        → tests/gpu-tests.json (private entries only with the sibling);
 *  - `test.browser.provider` → `playwright({ launchOptions: { channel: GPU_BROWSER_CHANNEL, args: GPU_LAUNCH_ARGS } })`.
 *    Provider level, because vitest 4.0.18 does not forward `browser.instances[].launchOptions`:
 *    the instance inherits the PROVIDER from `browser` (cloneConfig) and the provider launches
 *    Chromium with its own factory options. Headless stays `true`; the channel 'chromium' launches
 *    the FULL Chromium (new headless) instead of chrome-headless-shell, which lacks dxil.dll /
 *    dxcompiler.dll so Dawn D3D12 cannot create a WebGPU device (measured 2026-10-17);
 *  - `fileParallelism: false` + `maxWorkers: 1` — ONE GPU, no concurrent Chromium instances;
 *  - `cacheDir` → node_modules/.vite-gpu — its own deps-optimizer cache, so this run never
 *    invalidates (or re-optimises) the main suite's `node_modules/.vite`;
 *  - `optimizeDeps.entries` → the MAIN suite's test files (mainSuiteEntries over the resolved
 *    `test.include` / `test.exclude`). Vitest browser mode scans the project's include
 *    (`vitest:browser:tests` plugin, @vitest/browser dist/index.js); with only the five GPU
 *    files the optimizer discovered 37 deps mid-run and reloaded a file (first GPU run,
 *    2026-10-17). `optimizeDeps.include` stays the main suite's;
 *  - `test.name: 'gpu'`, `test.setupFiles` (tests/helpers/gpu-run-setup.ts: marks the run,
 *    prints `[gpu-backend]`, a missing adapter is an ERROR) and the GpuRunReporter
 *    (`[gpu-run]` + `[gpu-quarantine]` inside / outside the baseline).
 * The constants live in scripts/test-gpu-run.mjs; tests/test-gpu-run.node.test.ts guards them
 * and that vite.config.ts / vitest.node.config.ts carry none of the GPU flags.
 * Never staged into a delivery (scripts/_workspace-lib.mjs CORE_FILES does not list it).
 */

import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import mainConfig from './vite.config';
import {
  GPU_BROWSER_CHANNEL,
  GPU_CACHE_DIR,
  GPU_LAUNCH_ARGS,
  GPU_SETUP_FILE,
  gpuRunReporterPlugin,
  gpuTestFiles,
  mainSuiteEntries,
} from './scripts/test-gpu-run.mjs';

export default defineConfig(async (env) => {
  const base = typeof mainConfig === 'function' ? await mainConfig(env) : await mainConfig;
  const baseTest = base.test ?? {};
  // Scan parity with the main suite: the optimizer's entries are the MAIN suite's test files
  // (vitest adds only THIS run's include), so nothing is discovered mid-run that the main suite
  // finds at scan time. Taken from the resolved main config, not duplicated.
  const mainEntries = await mainSuiteEntries({ root: __dirname, include: baseTest.include ?? [], exclude: baseTest.exclude ?? [] });
  return {
    ...base,
    cacheDir: GPU_CACHE_DIR,
    optimizeDeps: { ...base.optimizeDeps, entries: mainEntries },
    plugins: [...(base.plugins ?? []), gpuRunReporterPlugin()],
    test: {
      ...baseTest,
      name: 'gpu',
      include: gpuTestFiles({ root: __dirname }),
      fileParallelism: false,
      maxWorkers: 1,
      setupFiles: [GPU_SETUP_FILE],
      browser: {
        ...baseTest.browser,
        enabled: true,
        provider: playwright({ launchOptions: { channel: GPU_BROWSER_CHANNEL, args: [...GPU_LAUNCH_ARGS] } }),
        instances: [{ browser: 'chromium' }],
        headless: true,
      },
    },
  };
});
