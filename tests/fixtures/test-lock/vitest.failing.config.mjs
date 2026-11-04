// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-617 fixture — node vitest config with the REAL progress plugin for the `[test-fail]` and
// `module-start` runs. The test picks the files with a CLI filter (`failing.fixture`,
// `hang.fixture`, …). `pool: 'forks'`, `fileParallelism: true`, `maxWorkers: 2`: the failing
// file runs IN PARALLEL with the hanging one, so the abort test sees its failure line while the
// run is still going (vitest's BaseSequencer alone gives no order guarantee).
// `RV_TL_NEVER_SETUP=1` adds a globalSetup that never resolves (never-setup.mjs): the run
// reports `run-start` (onTestRunStart fires before globalSetup) and nothing after it.
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockProgressPlugin } from '../../../scripts/test-progress-reporter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [testLockProgressPlugin()],
  test: {
    include: [
      'failing.fixture.test.mjs',
      'hang.fixture.test.mjs',
      'import-error.fixture.test.mjs',
      'before-all-error.fixture.test.mjs',
      'slow-start.fixture.test.mjs',
    ],
    environment: 'node',
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 2,
    watch: false,
    globalSetup: process.env.RV_TL_NEVER_SETUP === '1' ? [path.join(here, 'never-setup.mjs')] : [],
  },
});
