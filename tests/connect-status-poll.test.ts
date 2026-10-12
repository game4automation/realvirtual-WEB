// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-562 §9.5 — the ONE `/status` poll.
 *
 * Before plan-562 the ConnectPanel owned the poll and gated it on "panel open".
 * The write-gate overlay and the no-data notice live OVER the 3D view, where the
 * panel is closed, so the poll moved into `ConnectStatusPoll` (connect-plugin):
 * one owner, running whenever the gateway is connected, with a deadline per
 * request and a gateway generation that discards late answers.
 *
 * Pinned here: it polls without any panel; exactly one request per tick; an
 * answer that arrives after the gateway URL changed writes nothing; a hanging
 * request is aborted after 5 s and does NOT swallow the next tick; and a
 * Disconnect or a dispose stops it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectStatusPoll,
  CONNECT_STATUS_POLL_MS,
  CONNECT_STATUS_TIMEOUT_MS,
} from '../src/plugins/connect-plugin';
import {
  connectToServer,
  disconnectFromServer,
  fetchStatus,
  getConnectSnapshot,
  setServerUrl,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';

const SERVER = 'http://status-poll.test:5100';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

interface Gateway {
  /** Number of `/status` requests the poll issued. */
  statusCalls: number;
  /** Number of `/status` requests that ended in an abort. */
  aborted: number;
  /** Set to make `/status` hang until it is aborted. */
  hang: boolean;
  /** Set to hold answers back; `release()` resolves the pending ones. */
  defer: boolean;
  release: () => void;
  /** Interfaces the next released answer reports. */
  statusInterfaces: Array<Record<string, unknown>>;
}

function installGateway(): Gateway {
  const pending: Array<() => void> = [];
  const gw: Gateway = {
    statusCalls: 0,
    aborted: 0,
    hang: false,
    defer: false,
    statusInterfaces: [],
    release: () => { for (const r of pending.splice(0)) r(); },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.endsWith('/health')) return json({ status: 'ok', version: '6.3.47', build: 1 });
    if (url.endsWith('/config/interfaces')) return json([]);
    if (url.endsWith('/interface-types')) return json({ types: [] });
    // The exact path, not a suffix: `/license/status` rides along on the same
    // poll and must not be mistaken for a second status request.
    if (new URL(url).pathname === '/status') {
      gw.statusCalls++;
      if (gw.hang) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            gw.aborted++;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      if (gw.defer) {
        await new Promise<void>((resolve) => pending.push(resolve));
      }
      return json({ interfaces: gw.statusInterfaces });
    }
    return new Response('', { status: 404 });
  }));
  return gw;
}

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetConnectStore();
  localStorage.clear();
});

describe('ConnectStatusPoll — the single /status owner (plan-562 F5)', () => {
  it('polls while connected with no panel anywhere, exactly one request per tick', async () => {
    const gw = installGateway();
    setServerUrl(SERVER);
    await connectToServer();
    const base = gw.statusCalls;

    vi.useFakeTimers();
    const poll = new ConnectStatusPoll();
    poll.start();
    // The first tick is immediate: the counters matter most right after connect.
    expect(gw.statusCalls).toBe(base + 1);

    await vi.advanceTimersByTimeAsync(CONNECT_STATUS_POLL_MS);
    expect(gw.statusCalls).toBe(base + 2);
    await vi.advanceTimersByTimeAsync(CONNECT_STATUS_POLL_MS);
    expect(gw.statusCalls).toBe(base + 3);

    poll.dispose();
  });

  it('discards an answer that arrives after the gateway URL changed', async () => {
    const gw = installGateway();
    setServerUrl(SERVER);
    await connectToServer();

    gw.defer = true;
    gw.statusInterfaces = [{ id: 'stale-iface', status: 'Connected' }];
    // The guard belongs to the store, so it is exercised on a bare request —
    // a running poll would issue a SECOND, legitimate request against the new
    // URL and the assertion could no longer tell the two answers apart.
    const inFlight = fetchStatus();
    expect(gw.statusCalls).toBeGreaterThan(0);

    // The target moves while the answer is still in flight.
    setServerUrl('http://other-gateway.test:5100');
    gw.release();
    await inFlight;

    // The late answer described a gateway nobody is looking at anymore.
    expect(getConnectSnapshot().interfaceStatus['stale-iface']).toBeUndefined();
  });

  it('aborts a hanging request after the deadline without swallowing the next tick', async () => {
    const gw = installGateway();
    setServerUrl(SERVER);
    await connectToServer();

    vi.useFakeTimers();
    gw.hang = true;
    const poll = new ConnectStatusPoll();
    poll.start();
    const first = gw.statusCalls;

    // Two further ticks fire while the first request still hangs.
    await vi.advanceTimersByTimeAsync(CONNECT_STATUS_POLL_MS * 2);
    expect(gw.statusCalls).toBe(first + 2);
    expect(gw.aborted).toBe(0);

    // At the deadline the first request is cut off.
    await vi.advanceTimersByTimeAsync(CONNECT_STATUS_TIMEOUT_MS - CONNECT_STATUS_POLL_MS * 2);
    expect(gw.aborted).toBeGreaterThanOrEqual(1);

    poll.dispose();
  });

  it('stops on Disconnect and on dispose', async () => {
    const gw = installGateway();
    setServerUrl(SERVER);
    await connectToServer();

    vi.useFakeTimers();
    const poll = new ConnectStatusPoll();
    poll.start();
    await vi.advanceTimersByTimeAsync(CONNECT_STATUS_POLL_MS);
    expect(gw.statusCalls).toBeGreaterThan(0);

    disconnectFromServer();
    const afterDisconnect = gw.statusCalls;
    await vi.advanceTimersByTimeAsync(CONNECT_STATUS_POLL_MS * 3);
    expect(gw.statusCalls).toBe(afterDisconnect);

    // And a dispose while connected stops it just as completely.
    vi.useRealTimers();
    await connectToServer();
    vi.useFakeTimers();
    poll.dispose();
    const afterDispose = gw.statusCalls;
    await vi.advanceTimersByTimeAsync(CONNECT_STATUS_POLL_MS * 3);
    expect(gw.statusCalls).toBe(afterDispose);
  });
});
