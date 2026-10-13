// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { defineConfig, devices } from 'playwright/test';

// Override with RV_E2E_PORT when 5177 is taken — e.g. a vitest browser runner
// from a parallel worktree session on the same machine grabs 5177, and
// `reuseExistingServer` would then "reuse" a server that serves
// vitest-instrumented modules (boot dies on `__vitest_browser_runner__`).
const E2E_PORT = Number(process.env.RV_E2E_PORT ?? 5177);

// plan-503: the live demo smoke. The `prod-demo` project exists ONLY when a live
// target is named (the runner scripts/rv-demo-smoke.mjs sets it), so a local
// `npm run e2e` / run-all-tests never picks up the live specs, and no webServer
// is started for a CDN target. `chromium` additionally ignores e2e/prod-demo/;
// e2e/prod-demo-calibration/ is a LOCAL spec against the dev server and stays in
// `chromium`. Contract pinned by tests/playwright-config-prod-demo.node.test.ts.
const SMOKE_BASE_URL = process.env.RV_SMOKE_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    headless: true,
    viewport: { width: 1280, height: 720 },
    // Headless Chromium without this flag renders WebGL through SwiftShader, i.e. it
    // rasterizes every frame on the CPU. Measured 2026-10-13 on a GTX 1060: a
    // fragment-heavy fullscreen fill ran at 913 fps on SwiftShader vs 15447 fps on the
    // GPU (~17x). `--enable-gpu` alone is enough; adding `--use-angle=d3d11` (Windows
    // only) changes nothing. Trade-off: SwiftShader renders bit-identically on every
    // machine, the GPU does not -- set RV_E2E_SOFTWARE_GL=1 to switch back, e.g. for a
    // GPU-less CI box or when e2e/hmi-highlight-parity.spec.ts drifts past its diff
    // ratio on a different driver.
    launchOptions: {
      args: process.env.RV_E2E_SOFTWARE_GL ? [] : ['--enable-gpu'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [/embed-smoke\.spec\.ts/, /prod-demo\//],
    },
    {
      name: 'embed-chromium',
      testMatch: /embed-smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:4178',
      },
    },
    ...(SMOKE_BASE_URL ? [{
      name: 'prod-demo',
      testMatch: /prod-demo\/.*\.spec\.ts/,
      retries: 1,
      // 120 s per test: a hanging journey must not eat the runner's 10-min budget
      // twice (spike 2026-09-26: 180 s + retry was killed at 482 s without a report).
      timeout: 120_000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: SMOKE_BASE_URL,
        viewport: { width: 1280, height: 720 },
        trace: 'on-first-retry' as const,
        screenshot: 'only-on-failure' as const,
      },
    }] : []),
  ],
  ...(SMOKE_BASE_URL ? { workers: 1 } : {}),
  webServer: SMOKE_BASE_URL ? [] : [
    {
      command: `npm run dev -- --port ${E2E_PORT}`,
      port: E2E_PORT,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run preview:embed',
      port: 4178,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
