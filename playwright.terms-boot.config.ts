// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { defineConfig, devices } from 'playwright/test';

// plan-2209 §9.4(c): real-boot test of the terms gate against a BUILT demo bundle.
// Own config on purpose: no dev-server webServer (the spec starts its own static
// server on a free port), and the spec file is `*.e2e.ts`, which the default
// `npm run e2e` (testMatch `*.spec.ts`) never picks up — it needs a demo build.
//
//   1. a demo build (RV_DEMO_NOTICE=1, see doc-deploy.md) in ../dist-demo next to this repo
//   2. npm run e2e:terms-boot          (RV_TERMS_BOOT_DIST=<folder> points it at another build)
export default defineConfig({
  testDir: './e2e/terms-gate-boot',
  testMatch: /\.e2e\.ts$/,
  timeout: 180_000,
  retries: 0,
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: process.env.RV_E2E_SOFTWARE_GL ? [] : ['--enable-gpu'] },
  },
});
