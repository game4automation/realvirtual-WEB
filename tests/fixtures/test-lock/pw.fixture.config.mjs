// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-606 fixture — Playwright config with a dummy webServer that logs its start, to
// prove a second locked run waits BEFORE its webServer starts. No browser is launched.
import { defineConfig } from 'playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.RV_TL_WS_PORT);

export default defineConfig({
  testDir: here,
  testMatch: 'hold.fixture.pw.mjs',
  workers: 1,
  reporter: 'line',
  timeout: 60_000,
  webServer: {
    command: `node "${path.join(here, 'web-server.mjs').replace(/\\/g, '/')}"`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
