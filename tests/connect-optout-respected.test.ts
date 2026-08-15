// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-421 §9.4 — "Disconnect survives reload" must survive the new PERMANENT
 * retry loop too.
 *
 * The loop from §9.1 is the one change that could quietly undo that promise: it
 * re-probes forever, so the opt-out has to be re-checked before EVERY attempt
 * and before every wake trigger — not once at boot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectPlugin } from '../src/plugins/connect-plugin';
import {
  _resetConnectStore,
  connectToServer,
  disconnectFromServer,
  getConnectSnapshot,
  hasAutoConnectOptOut,
} from '../src/core/hmi/connect-store';

const OPTOUT_KEY = 'rv-connect-autoconnect-optout';
const plugins: ConnectPlugin[] = [];
let healthCalls = 0;

function bootedPlugin(): ConnectPlugin {
  const plugin = new ConnectPlugin();
  plugins.push(plugin);
  plugin.init();
  return plugin;
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetConnectStore();
  localStorage.removeItem(OPTOUT_KEY);
  healthCalls = 0;
  // A gateway that is definitely THERE — so an unwanted probe would connect and
  // be unmissable, rather than failing for unrelated reasons.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/health')) {
      healthCalls++;
      return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify([]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  });
});

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetConnectStore();
  localStorage.removeItem(OPTOUT_KEY);
});

describe('auto-connect opt-out (plan-421 §9.4)', () => {
  it('never reconnects after an explicit Disconnect, over the whole retry chain', async () => {
    localStorage.setItem(OPTOUT_KEY, '1');
    bootedPlugin();
    await advance(0);
    await advance(600_000); // ten minutes: opening ladder plus eight 60 s periods

    expect(healthCalls).toBe(0);
    expect(getConnectSnapshot().state).toBe('disconnected');
  });

  it('ignores the wake triggers while opted out', async () => {
    localStorage.setItem(OPTOUT_KEY, '1');
    bootedPlugin();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await advance(5_000);

    expect(healthCalls).toBe(0);
  });

  it('stops the loop the moment the user disconnects, and stays stopped over a reload', async () => {
    bootedPlugin();
    await advance(0);
    expect(getConnectSnapshot().state).toBe('connected');

    disconnectFromServer();
    expect(hasAutoConnectOptOut()).toBe(true);
    const afterDisconnect = healthCalls;
    await advance(600_000);
    expect(healthCalls).toBe(afterDisconnect);

    // Reload: a fresh plugin, the same browser storage.
    bootedPlugin();
    await advance(600_000);
    expect(healthCalls).toBe(afterDisconnect);
    expect(getConnectSnapshot().state).toBe('disconnected');
  });

  it('lets a manual Connect clear the opt-out (unchanged store semantics)', async () => {
    localStorage.setItem(OPTOUT_KEY, '1');
    bootedPlugin();
    await advance(5_000);
    expect(healthCalls).toBe(0);

    await connectToServer({ explicit: true });
    expect(hasAutoConnectOptOut()).toBe(false);
    expect(getConnectSnapshot().state).toBe('connected');
  });
});
