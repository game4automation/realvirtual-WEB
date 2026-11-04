// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-606 fixture — minimal BROWSER vitest config whose ROOT globalSetup is the real
// tests/global-lock-guard.ts. Browser mode clones the root config into the chromium
// instance project, so vitest calls the guard twice in one process (the self-block
// case). RV_TL_GUARD swaps in another guard (the negative control); RV_TL_API_PORT keeps
// the browser server off 5177.
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    include: ['guard.browser.fixture.test.mjs'],
    watch: false,
    globalSetup: [process.env.RV_TL_GUARD ?? path.resolve(here, '../../global-lock-guard.ts')],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      api: { port: Number(process.env.RV_TL_API_PORT), strictPort: true },
    },
  },
});
