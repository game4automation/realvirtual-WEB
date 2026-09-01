// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { defineConfig, devices } from 'playwright/test';

// Override with RV_E2E_PORT when 5177 is taken — e.g. a vitest browser runner
// from a parallel worktree session on the same machine grabs 5177, and
// `reuseExistingServer` would then "reuse" a server that serves
// vitest-instrumented modules (boot dies on `__vitest_browser_runner__`).
const E2E_PORT = Number(process.env.RV_E2E_PORT ?? 5177);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /embed-smoke\.spec\.ts/,
    },
    {
      name: 'embed-chromium',
      testMatch: /embed-smoke\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:4178',
      },
    },
  ],
  webServer: [
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
