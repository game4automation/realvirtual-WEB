// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Test-lock startup-limit fixture — a `test:all` stand-in. Runs the given fake vitest
 * step lists ONE AFTER THE OTHER, each through a re-entering `with-test-lock.mjs` (the
 * environment is passed on unchanged, exactly like `scripts/run-all-tests.mjs`), and
 * exits non-zero if any did.
 *
 *   node suite-sequence.mjs <dir> <steps> [<steps>…]
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.resolve(here, '../../../scripts/with-test-lock.mjs');
const fake = path.join(here, 'fake-vitest', 'vitest.mjs');
const [dir, ...suites] = process.argv.slice(2);

let failed = 0;
for (const steps of suites) {
  const run = spawnSync(process.execPath, [wrapper, fake, dir, steps], { stdio: 'inherit', env: process.env });
  if (run.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
