// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-672 Phase 0 — a browser-mode vitest run for the spike files in THIS folder only.
 *
 * Why a config of its own: the main suite's `test.include` is `tests/**` (vite.config.ts),
 * so a file under `spikes/` is never collected — and that is deliberate. A spike must not
 * join the suite's runtime, its baseline or its flake budget. Built exactly like
 * `vitest.gpu.config.ts`: spread the resolved main config (private resolver, aliases,
 * `define`, `optimizeDeps`, `browser.commands`, the lock guard) and override ONLY
 *
 *  - `test.include`  → `spikes/672/**\/*.spike.test.ts`
 *  - `test.name`     → `spike-672`
 *  - serial execution (`fileParallelism: false`, `maxWorkers: 1`) — the files MEASURE,
 *    and a second Chromium on the same GPU would make every number noise;
 *  - `cacheDir` → its own, so this run never invalidates the main suite's deps cache;
 *  - the **GPU launch options of the GPU group** (`channel: 'chromium'`,
 *    `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`). This one is not cosmetic:
 *    Playwright's default headless binary gives WebGL2 on SwiftShader, i.e. a SOFTWARE
 *    rasteriser, and a 4 ms / 6 ms budget measured there would be a software number sold
 *    as a GPU verdict. The spike prints the unmasked renderer string with every table so
 *    the reader can see which device produced the figures.
 *
 * Invocation (under the machine-wide test lock, like every other run here):
 *
 *   node scripts/with-test-lock.mjs npx vitest run --config spikes/672/vitest.spike.config.ts
 *
 * Nothing in the product references this file; deleting the folder removes it.
 */

import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import mainConfig from '../../vite.config';
import { GPU_BROWSER_CHANNEL, GPU_LAUNCH_ARGS } from '../../scripts/test-gpu-run.mjs';

export default defineConfig(async (env): Promise<ViteUserConfig> => {
  const base = typeof mainConfig === 'function' ? await mainConfig(env) : await mainConfig;
  const baseTest = base.test ?? {};
  return {
    ...base,
    cacheDir: 'node_modules/.vite-spike-672',
    test: {
      ...baseTest,
      name: 'spike-672',
      include: ['spikes/672/**/*.spike.test.ts'],
      fileParallelism: false,
      maxWorkers: 1,
      // The measurements load a 21 MB (Station) and optionally a 193 MB (Mauser) GLB and
      // bake them — a 5 s default would time out before the first number.
      testTimeout: 900_000,
      hookTimeout: 900_000,
      browser: {
        ...baseTest.browser,
        enabled: true,
        provider: playwright({
          launchOptions: { channel: GPU_BROWSER_CHANNEL, args: [...GPU_LAUNCH_ARGS] },
        }),
        instances: [{ browser: 'chromium' }],
        headless: true,
      },
    },
  };
});
