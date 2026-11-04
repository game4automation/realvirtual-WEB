// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-config-gateway.ts - a fetch-level fake of the CONNECT config endpoints (plan-2024 P1).
 *
 * Serves `/config/interfaces`, `/config/mirrors` and `/config/mappings` from mutable state, counts
 * every call per path and can fail a path with a status a given number of times. Everything else
 * (health, status, catalog ...) answers an empty object, which is enough for `connectToServer()`.
 */

import { vi } from 'vitest';

export interface FakeConfigGateway {
  interfaces: unknown[];
  mirrors: unknown[];
  mappings: unknown[];
  /** Calls per path ('/config/interfaces' ...). */
  readonly calls: Record<string, number>;
  /** Fail the next `times` requests to `path` with `status`. */
  fail(path: string, status: number, times: number): void;
  /** Hold every request to `path` until the returned function is called. */
  hold(path: string): () => void;
  /**
   * Hold only the NEXT request to `path`. The returned release answers it - with `body` when given
   * (an answer captured earlier, i.e. older than the current state), else with the current state.
   * `abortable`: the held request rejects with an AbortError as soon as its signal aborts.
   */
  holdNext(path: string, opts?: { abortable?: boolean }): (body?: unknown) => void;
  /** Signals of every request so far, in order (null when none was passed). */
  readonly signals: (AbortSignal | null)[];
}

export function installConfigGateway(): FakeConfigGateway {
  const failures = new Map<string, { status: number; times: number }>();
  const holds = new Map<string, Promise<void>>();
  const nextHolds = new Map<string, { wait: Promise<{ body?: unknown; has: boolean }>; abortable: boolean }>();
  const gateway: FakeConfigGateway = {
    interfaces: [{ id: 'i1', type: 'S7', enabled: true, signals: [] }],
    mirrors: [],
    mappings: [],
    calls: {},
    fail: (path, status, times) => { failures.set(path, { status, times }); },
    hold: (path) => {
      let release!: () => void;
      holds.set(path, new Promise<void>((resolve) => { release = resolve; }));
      return () => { holds.delete(path); release(); };
    },
    holdNext: (path, opts) => {
      let release!: (v: { body?: unknown; has: boolean }) => void;
      const wait = new Promise<{ body?: unknown; has: boolean }>((resolve) => { release = resolve; });
      nextHolds.set(path, { wait, abortable: opts?.abortable === true });
      return (...args: unknown[]) => { release({ body: args[0], has: args.length > 0 }); };
    },
    signals: [],
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const path = new URL(url).pathname;
    gateway.calls[path] = (gateway.calls[path] ?? 0) + 1;
    const signal = init?.signal ?? null;
    gateway.signals.push(signal);
    const next = nextHolds.get(path);
    if (next) {
      nextHolds.delete(path);
      const aborted = new Promise<never>((_, reject) => {
        if (!next.abortable || !signal) return;
        const fail = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
      });
      const answer = await Promise.race([next.wait, aborted]);
      if (answer.has) return json(answer.body);
    }
    const pending = holds.get(path);
    if (pending) await pending;
    const failure = failures.get(path);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return json({ error: 'boom' }, failure.status);
    }
    if (path === '/health') return json({ status: 'ok' });
    if (path === '/config/interfaces') return json(gateway.interfaces);
    if (path === '/config/mirrors') return json(gateway.mirrors);
    if (path === '/config/mappings') return json(gateway.mappings);
    return json({});
  });
  return gateway;
}
