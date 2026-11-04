// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// Dedicated browser harness: the soak loader needs WebGL and materialised placements.
import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import mainConfig from './vite.config';
import { mainSuiteEntries } from './scripts/test-gpu-run.mjs';

export default defineConfig(async (env) => {
  const base = typeof mainConfig === 'function' ? await mainConfig(env) : await mainConfig;
  const test = base.test ?? {};
  const entries = await mainSuiteEntries({ root: __dirname, include: test.include ?? [], exclude: test.exclude ?? [] });
  return {
    ...base,
    cacheDir: 'node_modules/.vite-perf-des',
    plugins: [...(base.plugins ?? []), {
      name: 'perf-des-scene',
      enforce: 'pre' as const,
      configureServer(server) {
        server.middlewares.use('/__perf-des/PalletYard.glb', (_req, res, next) => {
          if (!process.env.RV_PERF_DES_OUT || !process.env.RV_PERF_DES_GLB) return next();
          try {
            res.setHeader('Content-Type', 'model/gltf-binary');
            res.end(readFileSync(process.env.RV_PERF_DES_GLB));
          } catch (error) { next(error); }
        });
      },
    }],
    define: { ...base.define, __RV_PERF_DES__: JSON.stringify({
      enabled: Boolean(process.env.RV_PERF_DES_OUT),
      scenario: process.env.RV_PERF_DES_SCENARIO ?? 'yard',
      simSec: Number(process.env.RV_PERF_DES_SIM_SEC ?? 28800),
      // plan-2212 Phase 4b: '' (plain) | 'dense' | 'realistic' ('1' = 'dense', the Phase-4 value).
      script: ({ '1': 'dense', dense: 'dense', realistic: 'realistic' } as Record<string, string>)[process.env.RV_PERF_DES_SCRIPT ?? ''] ?? '',
      timing: process.env.RV_PERF_DES_TIMING === '1',
    }) },
    optimizeDeps: { ...base.optimizeDeps, entries },
    test: {
      ...test,
      include: ['tests/des/perf-des-run.perf.test.ts'],
      fileParallelism: false, maxWorkers: 1,
      browser: {
        ...test.browser, enabled: true, headless: true,
        provider: playwright({ launchOptions: { args: ['--enable-precise-memory-info'] } }),
        instances: [{ browser: 'chromium' }],
        commands: {
          ...test.browser?.commands,
          writePerfDesResult(_ctx: unknown, json: string) {
            if (!process.env.RV_PERF_DES_OUT) throw new Error('Missing RV_PERF_DES_OUT');
            JSON.parse(json);
            writeFileSync(process.env.RV_PERF_DES_OUT, json + '\n');
          },
        },
      },
    },
  };
});
