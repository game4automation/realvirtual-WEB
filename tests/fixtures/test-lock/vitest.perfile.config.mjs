// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-900 fixture config — a minimal node vitest run with the REAL progress reporter, used for
// the end-to-end cases of the per-file limit (exit 126).
//
// Two settings are NOT a matter of taste:
//   - `fileParallelism: true` with at least two workers. At a concurrency of one, a global cap, a
//     pid-global clock and a per-(pid, spec) in-flight map produce the SAME result, so a
//     single-worker fixture could not tell a right implementation from a wrong one (plan-900
//     E9/E10) — it would be the plan-687 trap verbatim.
//   - `sequence.shuffle: false`, so "the hanging file is the second one" stays true.
// `RV_TL_PERFILE_INCLUDE` selects the files (a `|`-separated list), so one config serves the
// position cases and the slow-file discriminator. `RV_TL_PERFILE_WORKERS` (default 2) exists for
// ONE case only: D1 needs the two slow files to run ONE AFTER THE OTHER, so that the process
// total is above the per-file limit while each file stays below it. It must stay at 2 for every
// case that asserts WHICH file is named.
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockProgressPlugin } from '../../../scripts/test-progress-reporter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const include = String(process.env.RV_TL_PERFILE_INCLUDE || 'first-file.fixture.test.mjs|hang-second-file.fixture.test.mjs')
  .split('|').filter(Boolean);
const workers = Number(process.env.RV_TL_PERFILE_WORKERS) || 2;

export default defineConfig({
  root: here,
  plugins: [testLockProgressPlugin()],
  test: {
    include,
    environment: 'node',
    pool: 'forks',
    fileParallelism: workers > 1,
    minWorkers: workers,
    maxWorkers: workers,
    sequence: { shuffle: false, concurrent: false },
    watch: false,
  },
});
