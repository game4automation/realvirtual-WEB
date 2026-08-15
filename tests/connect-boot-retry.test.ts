// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-421 §9.1 — the boot auto-probe RETRIES, permanently and cheaply (F1).
 *
 * Before plan-421 `ConnectPlugin.init()` probed the gateway exactly once. Start
 * CONNECT one second after the page and the viewer stayed disconnected until
 * the user clicked Connect — the reported "reload loses the connection".
 *
 * These run against the REAL connect-store (only `fetch` is mocked), because
 * the finding that made the one-shot unfixable-by-guard was a state one: a
 * failed `connectToServer()` leaves `error`, not `disconnected`
 * (connect-store.ts:959), so a mock-level reject would not have shown it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectPlugin } from '../src/plugins/connect-plugin';
import {
  _resetConnectStore,
  connectToServer,
  disconnectFromServer,
  getConnectSnapshot,
  setServerUrl,
  subscribeConnectStore,
} from '../src/core/hmi/connect-store';

/** Total of the opening ladder 1+2+5+10+30 s, after which only the 60 s period is left. */
const OPENING_CHAIN_MS = 48_000;

let gatewayUp = false;
let healthCalls = 0;

function installFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/health')) {
      healthCalls++;
      if (!gatewayUp) return Promise.reject(new Error('Connection refused'));
      return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify([]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  });
}

/**
 * Every plugin the test body creates. Disposed in `afterEach` even when an
 * assertion aborted the body first — a plugin that survives its test keeps its
 * own retry ladder running and poisons every later probe count.
 */
const plugins: ConnectPlugin[] = [];

function bootedPlugin(): ConnectPlugin {
  const plugin = new ConnectPlugin();
  plugins.push(plugin);
  plugin.init();
  return plugin;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetConnectStore();
  localStorage.removeItem('rv-connect-autoconnect-optout');
  localStorage.removeItem('rv-connect-user-connected');
  localStorage.removeItem('rv-connect-url');
  gatewayUp = false;
  healthCalls = 0;
  installFetchMock();
});

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetConnectStore();
  localStorage.removeItem('rv-connect-autoconnect-optout');
  localStorage.removeItem('rv-connect-url');
});

/**
 * Advance the clock and drain what the probe chain queues behind it.
 * `connectToServer` awaits fetch → `resp.json()` → the interface fetches, which
 * is more microtask rounds than a single timer advance flushes.
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

/** Let the current attempt's promise chain settle without moving the clock. */
async function settle(): Promise<void> {
  await advance(0);
}

describe('CONNECT boot auto-reconnect (plan-421 §9.1)', () => {
  it('walks the real store through disconnected → connecting → error → connecting → connected', async () => {
    const states: string[] = [];
    const unsub = subscribeConnectStore(() => {
      const s = getConnectSnapshot().state;
      if (states[states.length - 1] !== s) states.push(s);
    });
    bootedPlugin();
    await settle();
    expect(getConnectSnapshot().state).toBe('error');

    // The retry is what has to survive `error` — not `disconnected`.
    gatewayUp = true;
    await advance(1_000);
    expect(getConnectSnapshot().state).toBe('connected');
    expect(states).toEqual(['connecting', 'error', 'connecting', 'connected']);

    // Success ends the loop: no traffic for the next two minutes.
    const after = healthCalls;
    await advance(120_000);
    expect(healthCalls).toBe(after);

    unsub();
  });

  it('keeps probing once per 60 s when CONNECT starts long after the page', async () => {
    bootedPlugin();
    await advance(OPENING_CHAIN_MS);
    // 1 immediate + 5 ladder steps, all refused, and still armed.
    expect(healthCalls).toBe(6);
    expect(getConnectSnapshot().state).toBe('error');

    // CONNECT comes up only now — the finite chain this plan replaced would
    // have given up here (SOL-R1-4).
    gatewayUp = true;
    await advance(60_000);
    expect(getConnectSnapshot().state).toBe('connected');

  });

  it('keeps the idle probe rate at one per 60 s', async () => {
    bootedPlugin();
    await advance(OPENING_CHAIN_MS);
    const afterChain = healthCalls;
    await advance(300_000); // five minutes of silence
    expect(healthCalls - afterChain).toBe(5);
  });

  it('probes immediately when the tab becomes visible again', async () => {
    bootedPlugin();
    await settle();
    const before = healthCalls;

    gatewayUp = true;
    // Past the wake spacing, so the wake probe is due right away.
    await advance(1_500);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    expect(healthCalls).toBeGreaterThan(before);
    expect(getConnectSnapshot().state).toBe('connected');
  });

  it('probes immediately when the network comes back', async () => {
    bootedPlugin();
    await advance(30_000);
    const before = healthCalls;

    gatewayUp = true;
    window.dispatchEvent(new Event('online'));
    await settle();

    expect(healthCalls).toBe(before + 1);
    expect(getConnectSnapshot().state).toBe('connected');
  });

  it('writes nothing and schedules nothing after dispose during an in-flight probe', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/health')) {
        healthCalls++;
        await blocked;
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    const plugin = bootedPlugin();
    await settle();
    expect(healthCalls).toBe(1);
    expect(getConnectSnapshot().state).toBe('connecting');

    plugin.dispose();
    release();
    await settle();
    // The in-flight connect finishes inside the store (it is the store's own
    // promise), but the disposed plugin must never schedule anything again.
    const after = healthCalls;
    await advance(300_000);
    expect(healthCalls).toBe(after);
  });

  it('keeps at most one probe in flight across a re-init', async () => {
    const plugin = bootedPlugin();
    plugin.init(); // re-init supersedes the first generation
    await settle();
    expect(healthCalls).toBe(1);

    await advance(1_000);
    expect(healthCalls).toBe(2); // one ladder step, not two parallel ladders
  });

  it('yields to a manual Connect that lands while a retry timer is pending', async () => {
    bootedPlugin();
    await settle();
    expect(getConnectSnapshot().state).toBe('error');
    const afterFirst = healthCalls;

    // User clicks Connect before the 1 s retry is due.
    gatewayUp = true;
    await connectToServer({ explicit: true });
    expect(getConnectSnapshot().state).toBe('connected');
    expect(healthCalls).toBe(afterFirst + 1); // exactly the manual one

    // The cancelled generation must not fire its old timer afterwards.
    await advance(300_000);
    expect(healthCalls).toBe(afterFirst + 1);
  });

  it('cancels the pending generation when the gateway URL changes', async () => {
    bootedPlugin();
    await settle();
    const afterFirst = healthCalls;

    setServerUrl('http://elsewhere.invalid:5100');
    await settle();
    // The URL change restarts the ladder against the NEW target — one probe,
    // not one per generation.
    expect(healthCalls).toBe(afterFirst + 1);

    await advance(1_000);
    expect(healthCalls).toBe(afterFirst + 2);
  });

  it('stops for good once the user disconnects mid-chain', async () => {
    bootedPlugin();
    await advance(3_000);
    expect(healthCalls).toBeGreaterThan(1);

    disconnectFromServer();
    const afterDisconnect = healthCalls;
    gatewayUp = true;
    await advance(300_000);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await settle();

    expect(healthCalls).toBe(afterDisconnect);
    expect(getConnectSnapshot().state).toBe('disconnected');
  });
});
