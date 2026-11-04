// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Parent watchdog of the machine-wide test lock (plan-606 F10).
 *
 * `scripts/with-test-lock.mjs` injects this file into EVERY Node descendant of a
 * locked test run via `NODE_OPTIONS=--require "<path with forward slashes>"` (a
 * backslash inside the quotes acts as an escape there). It ends the process with
 * exit code 1 as soon as the wrapper named by `RV_TEST_LOCK_PARENT_PID` is gone, so a
 * hard-killed wrapper does not leave a test run going on without the lock.
 *
 * On Windows this is defence in depth: libuv puts every non-detached child into a
 * kill-on-close job object, so the tree dies with the wrapper anyway. On POSIX it
 * is the primary path for the Node processes.
 *
 * The owner is checked once synchronously at load — a process started after the
 * wrapper died (e.g. the next `spawnSync` step of `run-all-tests.mjs`, whose event
 * loop is blocked meanwhile) dies at once — and then on an unref'd interval
 * (`RV_TEST_LOCK_WATCHDOG_MS`, default 2000).
 */
'use strict';

const MARK = Symbol.for('rv.testLockWatchdog');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

function install() {
  const owner = Number(process.env.RV_TEST_LOCK_PARENT_PID);
  if (!Number.isInteger(owner) || owner <= 0 || owner === process.pid) return;
  if (globalThis[MARK]) return;
  globalThis[MARK] = owner;

  const check = () => {
    if (alive(owner)) return;
    try {
      process.stderr.write(
        `[test-lock] wrapper PID ${owner} is gone — ending PID ${process.pid} (${process.argv.slice(1, 3).join(' ')})\n`,
      );
    } catch {
      /* stderr may already be closed */
    }
    process.exit(1);
  };

  check();
  const intervalMs = Number(process.env.RV_TEST_LOCK_WATCHDOG_MS) || 2000;
  setInterval(check, intervalMs).unref();
}

install();
