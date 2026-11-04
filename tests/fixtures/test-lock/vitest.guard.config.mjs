// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-606 fixture — minimal node vitest config whose ROOT globalSetup is the real
// tests/global-lock-guard.ts, so a run of it shows what the guard does. `RV_TL_INCLUDE` swaps
// the test file (`hang.fixture.test.mjs` for the guard's maximum run time).
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    include: [process.env.RV_TL_INCLUDE || 'guard.fixture.test.mjs'],
    environment: 'node',
    pool: 'forks',
    watch: false,
    globalSetup: [path.resolve(here, '../../global-lock-guard.ts')],
  },
});
