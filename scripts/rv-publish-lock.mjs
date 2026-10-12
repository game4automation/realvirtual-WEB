// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-publish-lock.mjs — a named-pipe mutex (plan-488 §2.4).
 *
 * The lock IS a listening Windows named pipe: exactly one process can own
 * `\\.\pipe\<name>` at a time, and the operating system releases it when that
 * process ends — however it ends (normal exit, crash, `taskkill /F`). There is no
 * lock file, no content, no format and no orphan detection.
 *
 * Contract shared between copies of this file (the installed watcher copy and the
 * copy inside a deploy clone): ONLY the pipe name. Two versions of this file can
 * never be incompatible as long as the naming scheme stays the same — the scheme is
 * documented in doc-deploy.md § "Automatic /dev deploys".
 *
 * Self-contained on purpose: `node:` imports only, so the watcher can run it from
 * `<root>\bin\` next to its own copy.
 */

import net from 'node:net';

//! Longest accepted lock name. Measured: 240 characters work, 260 fail with EACCES.
export const MAX_LOCK_NAME_LENGTH = 200;

//! Error code of the error thrown when the lock stays busy until the timeout.
export const LOCK_BUSY_CODE = 'RV_LOCK_BUSY';

//! Normalizes a lock name: backslashes become '/', control characters '_', surrounding
//! whitespace is trimmed. Throws for an empty name or one longer than MAX_LOCK_NAME_LENGTH.
export function normalizeLockName(name) {
  // eslint-disable-next-line no-control-regex
  const normalized = String(name ?? '').replace(/\\/g, '/').replace(/[\x00-\x1f\x7f]/g, '_').trim();
  if (!normalized) throw new Error('Lock name must not be empty.');
  if (normalized.length > MAX_LOCK_NAME_LENGTH) {
    throw new Error(`Lock name is ${normalized.length} characters long; the limit is ${MAX_LOCK_NAME_LENGTH}: ${normalized.slice(0, 60)}…`);
  }
  return normalized;
}

//! Full pipe path for a lock name.
export function pipePathFor(name) {
  return `\\\\.\\pipe\\${normalizeLockName(name)}`;
}

//! One listen attempt on a raw pipe path. Resolves with the listening server, rejects with the
//! listen error unchanged (EADDRINUSE = someone owns it; anything else is a real failure).
export function tryListenPipe(pipePath) {
  return new Promise((resolveListen, rejectListen) => {
    const server = net.createServer((socket) => socket.destroy());
    const onError = (error) => {
      server.removeListener('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      // A late error on an owned pipe must never crash the owner.
      server.on('error', () => {});
      resolveListen(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipePath);
  });
}

const defaultSleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

//! Acquires the named-pipe mutex `name`.
//!
//! - `timeoutMs` 0 = exactly one attempt; otherwise polls every `pollMs` until the deadline.
//! - `onWait(name)` is called once, when the lock is first found busy.
//! - Only EADDRINUSE means busy. Every other error (EACCES for an over-long name, rights) throws
//!   immediately.
//! - Busy until the deadline → throws an Error with `code === LOCK_BUSY_CODE`.
//! - Windows only: elsewhere it throws instead of silently not locking.
//!
//! Returns `{ name, release() }`. `release()` is idempotent and returns a promise that resolves
//! once the pipe is closed. The server stays referenced while held (no `unref()`), so the lock
//! never depends on unrelated handles keeping the process alive.
export async function acquirePublishLock(name, {
  timeoutMs = 0, pollMs = 2000, onWait = null,
  // Test seams — production callers never pass these.
  platform = process.platform, sleep = defaultSleep, now = Date.now, listen = tryListenPipe,
} = {}) {
  const normalized = normalizeLockName(name);
  if (platform !== 'win32') {
    throw new Error(`The publish lock "${normalized}" is a Windows named pipe and is not available on ${platform}.`);
  }
  const pipePath = `\\\\.\\pipe\\${normalized}`;
  const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
  let waited = false;
  for (;;) {
    try {
      const server = await listen(pipePath);
      let released = null;
      return {
        name: normalized,
        release() {
          if (!released) released = new Promise((resolveClose) => server.close(() => resolveClose()));
          return released;
        },
      };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      const busy = new Error(`Lock "${normalized}" is held by another process${timeoutMs > 0 ? ` (waited ${Math.round(timeoutMs / 1000)} s)` : ''}.`);
      busy.code = LOCK_BUSY_CODE;
      throw busy;
    }
    if (!waited) {
      waited = true;
      if (onWait) onWait(normalized);
    }
    await sleep(Math.min(Math.max(1, pollMs), remaining));
  }
}
