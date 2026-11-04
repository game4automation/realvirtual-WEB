// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Test-lock startup-limit fixture — minimal node vitest config with the REAL progress
// plugin (scripts/test-progress-reporter.mjs), so a run shows which hooks fire.
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockProgressPlugin } from '../../../scripts/test-progress-reporter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [testLockProgressPlugin()],
  test: {
    include: ['progress.fixture.test.mjs'],
    environment: 'node',
    pool: 'forks',
    watch: false,
  },
});
