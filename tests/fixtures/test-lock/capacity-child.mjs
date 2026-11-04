// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2200 test fixture - a wrapper child that reports its capacity environment.
 *
 *   node capacity-child.mjs <dir> [hold]
 *
 * Writes <dir>/child-<pid>.json { klass, workers, lockHeld }. With `hold` it then waits for <dir>/release.
 */

import fs from 'node:fs';
import path from 'node:path';

const [dir, mode] = process.argv.slice(2);
fs.writeFileSync(path.join(dir, `child-${process.pid}.json`), JSON.stringify({
  klass: process.env.RV_TEST_LOCK_CLASS ?? null,
  workers: process.env.VITEST_MAX_WORKERS ?? null,
  lockHeld: process.env.RV_TEST_LOCK_HELD ?? null,
}));
if (mode === 'hold') while (!fs.existsSync(path.join(dir, 'release'))) await new Promise((r) => setTimeout(r, 25));
