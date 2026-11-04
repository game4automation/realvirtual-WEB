// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Machine-wide WebViewer test lock (plan-606).
 *
 * The lock IS a listening socket: whoever has bound the literal address
 * `127.0.0.1:<port>` (default 47177, `RV_TEST_LOCK_PORT`) holds it. The OS makes
 * the bind exclusive and releases it when the holding process dies, however it
 * dies — there is no lock file. A holder that HANGS without dying keeps the port,
 * though (2026-10-27: a bare `npx vitest run` held it for six hours); `break` below
 * is the sanctioned way to free it (`scripts/test-lock-break.mjs`).
 *
 * Always the literal `127.0.0.1`: on Windows a `0.0.0.0` / `::` bind and a
 * `127.0.0.1` bind on the same port COEXIST (measured, plan-606 § Spike Q1), so
 * only same-address binds exclude each other. No `reusePort`, no `SO_REUSEADDR`.
 *
 * While held, `GET /` answers `{ rvTestLock: 1, pid, startedAt, cwd, argv }`, so a
 * waiter can say whom it is waiting for.
 *
 * Class-aware callers use H0 (the base port) for heavy runs and base+3 through
 * base+22 for twenty light runs. Exclusive runs hold H0 and all twenty marks.
 * Legacy acquire() still binds only H0.
 *
 * Normally held by `scripts/with-test-lock.mjs` (the wrapper every test npm script
 * runs through) for the whole life of the test runner; `tests/global-lock-guard.ts`
 * takes it as a fallback for a direct `npx vitest run`.
 *
 * Environment:
 *   RV_TEST_LOCK=off                  disables the lock entirely
 *   RV_TEST_LOCK_PORT                 lock port (default 47177)
 *   RV_TEST_LOCK_TIMEOUT_SECONDS      how long a waiter waits before refusing (default 1800)
 *   RV_TEST_LOCK_EXCLUSIVE_TIMEOUT_SECONDS  exclusive wait limit (default 3600)
 *   RV_TEST_LOCK_POLL_SECONDS         retry interval of a waiter (default 2)
 *   RV_TEST_LOCK_DIR                  IGNORED since plan-606 (the old file lock's directory)
 *
 * CLI:
 *   node scripts/test-lock.mjs status    who holds the lock (exit 0 free, 1 held, 2 unknown holder)
 *   node scripts/test-lock.mjs break [--port N] [--dry-run] [--min-age-minutes 30] [--idle-seconds 60]
 *                                        ends a HUNG test holder — only an idle test process older
 *                                        than the minimum age, with its test ancestors (Windows;
 *                                        exit 0 free/freed, 1 kill did not free, 2 refused)
 */

import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LOCK_HOST = '127.0.0.1';
export const DEFAULT_PORT = 47177;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_POLL_SECONDS = 2;
const WAIT_PRINT_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 1000;
const STATUS_HINT = 'node scripts/test-lock.mjs status';

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePort(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

/** Lock settings from the environment (`RV_TEST_LOCK_DIR` is deliberately not read). */
export function lockConfig(env = process.env) {
  return {
    disabled: String(env.RV_TEST_LOCK ?? '').trim().toLowerCase() === 'off',
    port: parsePort(env.RV_TEST_LOCK_PORT),
    timeoutSeconds: parsePositiveNumber(env.RV_TEST_LOCK_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
    pollSeconds: parsePositiveNumber(env.RV_TEST_LOCK_POLL_SECONDS, DEFAULT_POLL_SECONDS),
  };
}

/** True when `pid` names a live process (`EPERM` = alive, owned by someone else). */
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Holder info a lock answers on `GET /`. */
export function holderInfo(argv, extra = {}) {
  return {
    rvTestLock: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    argv: [...argv],
    ...extra,
  };
}

export function formatHolder(holder) {
  return `${(holder.argv ?? []).join(' ')} (PID ${holder.pid}, since ${holder.startedAt}, cwd ${holder.cwd})`;
}

export class TestLockTimeoutError extends Error {
  constructor(message, holder, port) {
    super(message);
    this.name = 'TestLockTimeoutError';
    this.holder = holder;
    this.port = port;
  }
}

function tryBind(port, info) {
  return new Promise((resolve) => {
    const body = JSON.stringify(info);
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'close');
      res.end(body);
    });
    server.keepAliveTimeout = 1;
    server.once('error', (error) => resolve({ ok: false, code: error?.code ?? String(error) }));
    server.listen({ port, host: LOCK_HOST }, () => {
      server.unref();
      resolve({ ok: true, server });
    });
  });
}

/**
 * Asks the lock port who holds it. Resolves the holder info, or `null` when
 * nothing answers with a valid test-lock reply (free port, foreign program,
 * unresponsive holder, holder that just released).
 */
export function describeHolder({ port = lockConfig().port, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get({ host: LOCK_HOST, port, path: '/', agent: false, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) req.destroy();
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          done(parsed && parsed.rvTestLock === 1 && Number.isInteger(parsed.pid) ? parsed : null);
        } catch {
          done(null);
        }
      });
      res.on('error', () => done(null));
    });
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
  });
}

function canConnect(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: LOCK_HOST, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Read-only look at the lock (never binds): `free`, `held` (+ holder) or
 * `unknown` (something listens on the port but gives no test-lock answer).
 */
export async function probeLock({ port = lockConfig().port } = {}) {
  const holder = await describeHolder({ port });
  if (holder) return { state: 'held', port, holder };
  return { state: (await canConnect(port)) ? 'unknown' : 'free', port };
}

/** Light runs share twenty independent slots; the two ports after H0 stay reserved. */
export function lightPorts(base = lockConfig().port) {
  return Array.from({ length: 20 }, (_, index) => base + 3 + index);
}

/** Read-only status of H0 and every occupied light slot. */
export async function probeAll({ port = lockConfig().port } = {}) {
  const [heavy, ...light] = await Promise.all([port, ...lightPorts(port)].map((slot) => probeLock({ port: slot })));
  return { heavy, light: light.filter((result) => result.state !== 'free') };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquires the lock, waiting while it is held.
 *
 * Every `pollSeconds` it tries to bind. After each `EADDRINUSE` it asks `GET /`;
 * without a valid answer it binds once more first (the holder may have released
 * between the bind and the request) and only then classifies the holder as
 * unknown/unresponsive — and keeps waiting. At the deadline it throws a
 * `TestLockTimeoutError` naming the last known holder.
 *
 * Resolves `{ port, info, server, release() }`. The server is `unref`'d: the lock
 * lives exactly as long as the process unless released earlier.
 *
 * `onBusy` is a test seam, awaited after every `EADDRINUSE` before the holder is asked.
 */
export async function acquire({
  info = holderInfo(process.argv.slice(1)),
  port,
  timeoutSeconds,
  pollSeconds,
  log = (message) => process.stderr.write(`${message}\n`),
  onBusy,
} = {}) {
  const config = lockConfig();
  const lockPort = port ?? config.port;
  const timeoutMs = (timeoutSeconds ?? config.timeoutSeconds) * 1000;
  const pollMs = (pollSeconds ?? config.pollSeconds) * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastHolder = null;
  let lastState = null;
  let lastPrint = 0;

  const bound = (server) => {
    let released = false;
    return {
      port: lockPort,
      info,
      server,
      release: () => new Promise((resolve) => {
        if (released) return resolve();
        released = true;
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    };
  };

  for (;;) {
    const first = await tryBind(lockPort, info);
    if (first.ok) return bound(first.server);
    if (first.code !== 'EADDRINUSE') {
      throw new Error(`[test-lock] cannot bind ${LOCK_HOST}:${lockPort}: ${first.code}`);
    }
    if (onBusy) await onBusy();

    let holder = await describeHolder({ port: lockPort });
    if (!holder) {
      const again = await tryBind(lockPort, info);
      if (again.ok) return bound(again.server);
      if (again.code !== 'EADDRINUSE') {
        throw new Error(`[test-lock] cannot bind ${LOCK_HOST}:${lockPort}: ${again.code}`);
      }
      holder = await describeHolder({ port: lockPort });
    }
    // Our own holder: waiting could only ever end at the deadline — fail at once instead.
    if (holder && holder.pid === process.pid) {
      throw new Error(
        `[test-lock] the lock is held by THIS process (PID ${process.pid}) — a second acquire in the same process; ` +
          'this is a test-lock guard bug, not another test run',
      );
    }
    const state = holder ? 'held' : 'unknown';
    if (holder) lastHolder = holder;

    const leftMs = deadline - Date.now();
    const now = Date.now();
    if (state !== lastState || now - lastPrint >= WAIT_PRINT_INTERVAL_MS) {
      lastState = state;
      lastPrint = now;
      const left = Math.max(0, Math.ceil(leftMs / 1000));
      log(holder
        ? `[test-lock] class heavy waiting for ${(holder.argv ?? []).join(' ')} (PID ${holder.pid}, since ${holder.startedAt}) — ${left} s left`
        : `[test-lock] class heavy port ${lockPort} held by an unknown/unresponsive process — ${left} s left`);
    }

    if (leftMs <= 0) {
      const who = holder
        ? `held by ${formatHolder(holder)}`
        : `held by an unknown/unresponsive process${lastHolder ? ` (last known holder: ${formatHolder(lastHolder)})` : ''} — if another program uses port ${lockPort}, set RV_TEST_LOCK_PORT`;
      throw new TestLockTimeoutError(
        `[test-lock] gave up after ${Math.round(timeoutMs / 1000)} s: ${LOCK_HOST}:${lockPort} is ${who}. ` +
          `Check with: ${STATUS_HINT}`,
        holder ?? lastHolder,
        lockPort,
      );
    }

    await sleep(Math.max(1, Math.min(pollMs, leftMs)));
  }
}

/**
 * Heavy holds H0, light holds one mark, exclusive holds H0 then all marks.
 * Exclusive keeps acquired marks while waiting, stopping new light runs there.
 * All partial acquisitions are released when waiting or binding fails.
 */
export async function acquireClass({
  klass = 'heavy',
  info = holderInfo(process.argv.slice(1)),
  port,
  timeoutSeconds,
  pollSeconds,
  log = (message) => process.stderr.write(`${message}\n`),
  onBusy,
} = {}) {
  if (!['heavy', 'light', 'exclusive'].includes(klass)) throw new Error(`[test-lock] invalid class: ${klass}`);
  const config = lockConfig();
  const base = port ?? config.port;
  const classInfo = { ...holderInfo(process.argv.slice(1)), ...info, class: klass };
  if (klass === 'heavy') {
    const handle = await acquire({
      info: classInfo, port: base, timeoutSeconds, pollSeconds, log, onBusy,
    });
    return { ...handle, klass, ports: [base] };
  }

  const timeoutMs = (timeoutSeconds ?? (klass === 'exclusive'
    ? parsePositiveNumber(process.env.RV_TEST_LOCK_EXCLUSIVE_TIMEOUT_SECONDS, 3600)
    : config.timeoutSeconds)) * 1000;
  const deadline = Date.now() + timeoutMs;
  const pollMs = (pollSeconds ?? config.pollSeconds) * 1000;
  const marks = lightPorts(base);
  const targets = klass === 'exclusive' ? [base, ...marks] : marks;
  const held = [];
  let lastHolder = null;
  let lastState = null;
  let lastPrint = 0;
  let releasePromise;
  const release = () => {
    releasePromise ??= Promise.all(held.map(({ server }) => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }))).then(() => undefined);
    return releasePromise;
  };
  const bound = (target, server, slotInfo) => {
    held.push({ port: target, server, info: slotInfo });
    return {
      port: held[0].port, info: held[0].info, server: held[0].server,
      release, klass, ports: held.map((entry) => entry.port),
    };
  };

  try {
    for (;;) {
      let busyPort = base;
      let tookH0 = false;
      let holder = null;
      // Exclusive takes H0 first (two exclusive runs cannot split the marks between them), then
      // every mark that is free, on each pass, and keeps them while it waits for the busy ones —
      // that is what stops new light runs. Light scans all marks before waiting.
      const bindOrder = klass === 'exclusive'
        ? (held.length === 0 ? [base] : targets.filter((target) => !held.some((entry) => entry.port === target)))
        : targets;
      // A holder of H0 that does not carry a class is an older checkout (or a direct vitest run): it
      // may be a measurement, and it cannot see the marks, so light runs wait for it instead of
      // overlapping it. Class-carrying holders (heavy) share the machine with light runs by design.
      const legacy = klass === 'light' ? await describeHolder({ port: base }) : null;
      const legacyHolder = legacy && legacy.class === undefined ? legacy : null;
      if (legacyHolder) { busyPort = base; holder = legacyHolder; lastHolder = legacyHolder; }
      for (const target of (legacyHolder ? [] : bindOrder)) {
        const slotInfo = target === base ? classInfo : { ...classInfo, slot: marks.indexOf(target) };
        let attempt = await tryBind(target, slotInfo);
        if (!attempt.ok) {
          if (attempt.code !== 'EADDRINUSE') {
            throw new Error(`[test-lock] cannot bind ${LOCK_HOST}:${target}: ${attempt.code}`);
          }
          if (onBusy) await onBusy();
          holder = await describeHolder({ port: target });
          if (!holder) {
            attempt = await tryBind(target, slotInfo);
            if (!attempt.ok && attempt.code !== 'EADDRINUSE') {
              throw new Error(`[test-lock] cannot bind ${LOCK_HOST}:${target}: ${attempt.code}`);
            }
            if (!attempt.ok) holder = await describeHolder({ port: target });
          }
        }
        if (attempt.ok) {
          const handle = bound(target, attempt.server, slotInfo);
          if (klass === 'light' || held.length === targets.length) return handle;
          if (target === base) { tookH0 = true; break; } // H0 first, then start over with the marks
          continue;
        }
        busyPort = target;
        if (holder) lastHolder = holder;
      }
      // Exclusive got H0 on this pass: take the marks straight away instead of sleeping.
      if (tookH0) continue;

      const leftMs = deadline - Date.now();
      const now = Date.now();
      const state = `${busyPort}:${holder ? 'held' : 'unknown'}`;
      if (state !== lastState || now - lastPrint >= WAIT_PRINT_INTERVAL_MS) {
        lastState = state;
        lastPrint = now;
        const left = Math.max(0, Math.ceil(leftMs / 1000));
        log(holder
          ? `[test-lock] class ${klass} waiting for ${formatHolder(holder)} — ${left} s left`
          : `[test-lock] class ${klass} port ${busyPort} held by an unknown/unresponsive process — ${left} s left`);
      }
      if (leftMs <= 0) {
        const who = holder ? `held by ${formatHolder(holder)}`
          : `held by an unknown/unresponsive process${lastHolder ? ` (last known holder: ${formatHolder(lastHolder)})` : ''}`;
        throw new TestLockTimeoutError(
          `[test-lock] class ${klass} gave up after ${Math.round(timeoutMs / 1000)} s: ${LOCK_HOST}:${busyPort} is ${who}. ` +
            `Check with: ${STATUS_HINT}`,
          holder ?? lastHolder, busyPort,
        );
      }
      await sleep(Math.max(1, Math.min(pollMs, leftMs)));
    }
  } catch (error) {
    await release();
    throw error;
  }
}

async function statusCli() {
  const { port, disabled } = lockConfig();
  const { heavy: result, light } = await probeAll({ port });
  let exitCode = 0;
  if (result.state === 'held') {
    const h = result.holder;
    process.stdout.write(
      `[test-lock] ${LOCK_HOST}:${port} HELD by PID ${h.pid}\n` +
        `  since: ${h.startedAt}\n  cwd:   ${h.cwd}\n  argv:  ${(h.argv ?? []).join(' ')}\n`,
    );
    exitCode = 1;
  } else if (result.state === 'unknown') {
    process.stdout.write(
      `[test-lock] ${LOCK_HOST}:${port} is in use by an unknown/unresponsive process (no test-lock answer).\n`,
    );
    exitCode = 2;
  } else {
    process.stdout.write(`[test-lock] ${LOCK_HOST}:${port} is free${disabled ? ' (RV_TEST_LOCK=off in this shell)' : ''}\n`);
  }
  for (const mark of light) {
    if (mark.state === 'held') {
      const h = mark.holder;
      process.stdout.write(
        `[test-lock] ${LOCK_HOST}:${mark.port} HELD by PID ${h.pid} (class ${h.class ?? 'light'})\n` +
          `  since: ${h.startedAt}\n  cwd:   ${h.cwd}\n  argv:  ${(h.argv ?? []).join(' ')}\n`,
      );
      exitCode = Math.max(exitCode, 1);
    } else {
      process.stdout.write(`[test-lock] ${LOCK_HOST}:${mark.port} is in use by an unknown/unresponsive process (no test-lock answer).\n`);
      exitCode = 2;
    }
  }
  return exitCode;
}

/** True when `metaUrl` is the entry script of this process (drive-letter case ignored on win32). */
export function isEntryScript(metaUrl) {
  if (!process.argv[1]) return false;
  const a = pathToFileURL(resolve(process.argv[1])).href;
  return process.platform === 'win32' ? a.toLowerCase() === metaUrl.toLowerCase() : a === metaUrl;
}

async function breakCli(args) {
  const { breakCli: run } = await import('./test-lock-break.mjs');
  return run(args, { defaultPort: lockConfig().port, describeHolder });
}

if (isEntryScript(import.meta.url)) {
  const action = process.argv[2];
  if (action !== 'status' && action !== 'break') {
    process.stderr.write(
      'Usage: node scripts/test-lock.mjs status\n' +
        '       node scripts/test-lock.mjs break [--port N] [--dry-run] [--min-age-minutes 30] [--idle-seconds 60]\n' +
        '  (acquire/release are gone since plan-606 — the lock is held by scripts/with-test-lock.mjs)\n',
    );
    process.exit(2);
  }
  (action === 'break' ? breakCli(process.argv.slice(3)) : statusCli()).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[test-lock] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(3);
    },
  );
}
