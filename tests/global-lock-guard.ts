// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Root `globalSetup` of BOTH vitest configs (`vite.config.ts`, `vitest.node.config.ts`)
 * — plan-606 F3. Root only: never in a project, never via `extends: true`.
 *
 * - Under the test lock wrapper (`scripts/with-test-lock.mjs`, every test npm script):
 *   `RV_TEST_LOCK_HELD` names the live wrapper — the guard does NOT bind again, it only
 *   makes sure the parent watchdog runs in this process.
 * - A direct `npx vitest run` (no wrapper): the guard acquires the machine-wide lock
 *   itself and releases it in teardown. Weaker than the wrapper — the lock ends with
 *   global teardown, before vitest has closed its last resources — but it keeps a
 *   direct run from overlapping a locked one. It sets `RV_TEST_LOCK_HELD` to this
 *   process so wrappers started from inside the run re-enter instead of waiting on it.
 *   It also enforces the wrapper's maximum run time (`RV_TEST_MAX_RUNTIME_MINUTES`, same
 *   default 90, `0` disables): a direct run still going after that ends this vitest process
 *   with exit 124 and so frees the port — 2026-10-27 a hung direct run (PID 7388) held the
 *   lock for six hours. The startup and stall limits stay wrapper-only.
 * - `RV_TEST_LOCK=off` → nothing.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

interface LockHandle {
  port: number;
  release(): Promise<void>;
}

interface LockModule {
  lockConfig(): { disabled: boolean; port: number };
  isProcessAlive(pid: unknown): boolean;
  holderInfo(argv: string[]): Record<string, unknown>;
  acquire(options: { info: Record<string, unknown>; port: number }): Promise<LockHandle>;
}

interface WrapperModule {
  maxRuntime(): { minutes: number; ms: number };
  MAX_RUNTIME_EXIT_CODE: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(here, '../scripts');

export default async function setup(): Promise<void | (() => Promise<void>)> {
  const lock = (await import(pathToFileURL(resolve(SCRIPTS, 'test-lock.mjs')).href)) as LockModule;
  const config = lock.lockConfig();
  if (config.disabled) return;

  const heldBy = Number(process.env.RV_TEST_LOCK_HELD);
  // Held by THIS process: an earlier call already acquired the lock and owns the teardown.
  // Browser mode calls the guard twice in one process — `cloneConfig` copies the root
  // globalSetup into the `browser.instances` project and `initializeGlobalSetup` runs the
  // spec's project plus the root (vitest 4.0.18, dist/chunks/cli-api.*.js).
  if (heldBy === process.pid) return;
  if (lock.isProcessAlive(heldBy)) {
    // Under the wrapper: NODE_OPTIONS already loaded the watchdog; requiring it again
    // is a no-op then, and covers a NODE_OPTIONS that something in between dropped.
    if (process.env.RV_TEST_LOCK_PARENT_PID) {
      createRequire(import.meta.url)(resolve(SCRIPTS, 'test-lock-watchdog.cjs'));
    }
    return;
  }

  const handle = await lock.acquire({
    info: lock.holderInfo(['vitest', ...process.argv.slice(2)]),
    port: config.port,
  });
  process.stderr.write(`[test-lock] guard acquired 127.0.0.1:${handle.port} for this vitest process (PID ${process.pid})\n`);
  const previous = process.env.RV_TEST_LOCK_HELD;
  process.env.RV_TEST_LOCK_HELD = String(process.pid);

  // Maximum run time, as in the wrapper: only the holder enforces it, and ending this process
  // ends the run (on Windows the job object takes the workers and the browser with it).
  const wrapper = (await import(pathToFileURL(resolve(SCRIPTS, 'with-test-lock.mjs')).href)) as WrapperModule;
  const limit = wrapper.maxRuntime();
  let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
  if (limit.ms > 0) {
    const startedAt = new Date().toISOString();
    runtimeTimer = setTimeout(() => {
      const code = wrapper.MAX_RUNTIME_EXIT_CODE;
      const cause = `run exceeded RV_TEST_MAX_RUNTIME_MINUTES=${limit.minutes}`;
      process.stderr.write(`[test-lock] ${cause} (started ${startedAt}, argv vitest ${process.argv.slice(2).join(' ')}) — ending this vitest process and releasing the lock\n`);
      const exit = () => {
        process.stderr.write(`[test-lock] FAILED (exit ${code}): ${cause}\n`);
        process.exit(code);
      };
      void Promise.race([handle.release(), new Promise((r) => setTimeout(r, 2000))]).then(exit, exit);
    }, limit.ms);
    runtimeTimer.unref();
  }

  return async () => {
    if (runtimeTimer) clearTimeout(runtimeTimer);
    if (previous === undefined) delete process.env.RV_TEST_LOCK_HELD;
    else process.env.RV_TEST_LOCK_HELD = previous;
    await handle.release();
  };
}
