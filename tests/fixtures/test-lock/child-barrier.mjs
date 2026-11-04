// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-606 test fixture — a wrapper child that reports what it sees.
 *
 *   node child-barrier.mjs <dir> [exitCode|kill] [args…]
 *
 * Writes <dir>/child.json: { pid, argv, env (RV_TEST_LOCK_* + NODE_OPTIONS),
 * watchdog (owner pid the watchdog registered, or null), probeStart }. With
 * <dir>/wait present it then waits for <dir>/release, probes the lock port once more
 * right before exiting (`probeExit` in <dir>/child-exit.json) and exits with
 * [exitCode] — or kills itself with SIGKILL for `kill`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { lockConfig, probeLock } from '../../../scripts/test-lock.mjs';

const [dir, exitArg = '0', ...rest] = process.argv.slice(2);
const file = (name) => path.join(dir, name);
const port = lockConfig().port;

async function main() {
  const probeStart = await probeLock({ port });
  fs.writeFileSync(file('child.json'), JSON.stringify({
    pid: process.pid,
    argv: rest,
    env: {
      RV_TEST_LOCK_HELD: process.env.RV_TEST_LOCK_HELD ?? null,
      RV_TEST_LOCK_PARENT_PID: process.env.RV_TEST_LOCK_PARENT_PID ?? null,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    },
    watchdog: globalThis[Symbol.for('rv.testLockWatchdog')] ?? null,
    probeStart,
  }));
  if (fs.existsSync(file('wait'))) {
    while (!fs.existsSync(file('release'))) await new Promise((r) => setTimeout(r, 25));
    const probeExit = await probeLock({ port });
    fs.writeFileSync(file('child-exit.json'), JSON.stringify({ probeExit }));
  }
  if (exitArg === 'kill') process.kill(process.pid, 'SIGKILL');
  return Number(exitArg);
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`child-barrier.mjs: ${error?.stack ?? error}\n`);
  process.exit(99);
});
