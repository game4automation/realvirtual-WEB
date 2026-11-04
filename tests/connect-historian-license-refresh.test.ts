// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2044 F2: an unlicensed CONNECT answers `/history/status` with 403 LICENSE_REQUIRED; the
 * store keeps that as `enabled: true` + `disabledReason`, and the CONNECT panel shows "Historian
 * not recording - LICENSE_REQUIRED". The 10 s poll that would replace it lives in the toolbar
 * button, which is NOT mounted in a recording, in focused workspace modes (planner, editor ...)
 * or in the viewer mode — measured live in planner mode: still LICENSE_REQUIRED 35 s after the
 * license became active. The plugin itself now owns one subscription for its lifetime and
 * re-reads the status once per local `unlicensed -> licensed` edge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistorianTrendPlugin } from '../src/plugins/historian-trend-plugin';
import { __resetHistorianStore, historianStore } from '../src/core/hmi/historian-store';
import { connectToServer, _resetConnectStore } from '../src/core/hmi/connect-store';
import {
  _setLicenseSnapshotForTests,
  clearLicenseStatus,
  type LicenseStatus,
} from '../src/core/hmi/license-store';

function license(gatewayAllowed: boolean): LicenseStatus {
  return {
    state: gatewayAllowed ? 'LicensedCommunity' : 'Unlicensed',
    gatewayAllowed,
    maxSignals: gatewayAllowed ? 20 : 0,
    admittedSignals: 0,
    effectiveNow: '2026-10-30T22:00:00Z',
    overLimitSignals: [],
  };
}

function setLicense(gatewayAllowed: boolean): void {
  _setLicenseSnapshotForTests({ supported: true, status: license(gatewayAllowed) });
}

/** What the CONNECT panel reads to show its red "Historian not recording" line (ConnectPanel.tsx). */
function historianLineShown(): boolean {
  const status = historianStore.getSnapshot().status;
  return status?.enabled === true && !status.connected;
}

/** The gateway: licensed or not, as CONNECT's LicenseEnforcementMiddleware answers. */
let gatewayLicensed = false;
let historyStatusCalls = 0;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

let plugins: HistorianTrendPlugin[];

function makePlugin(): HistorianTrendPlugin {
  const plugin = new HistorianTrendPlugin();
  plugins.push(plugin);
  plugin.init();
  return plugin;
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  plugins = [];
  gatewayLicensed = false;
  historyStatusCalls = 0;
  _resetConnectStore();
  __resetHistorianStore();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/history/status') {
      historyStatusCalls++;
      return gatewayLicensed
        ? json({
          enabled: false, connected: false, bucket: null, lastWriteUtc: null,
          droppedPoints: 0, authError: false, disabledReason: 'Historian is disabled.',
        })
        : json({ error: 'LICENSE_REQUIRED', code: 'LICENSE_REQUIRED' }, 403);
    }
    if (url.pathname === '/health') return json({ status: 'ok' });
    if (url.pathname === '/config/interfaces') return json([]);
    return json({});
  }));
  await connectToServer();
  setLicense(false);
  // The one refresh that ran while the gateway was still unlicensed.
  await historianStore.refreshStatus();
  expect(historianStore.getSnapshot().status?.disabledReason).toBe('LICENSE_REQUIRED');
  expect(historianLineShown()).toBe(true);
  historyStatusCalls = 0;
});

afterEach(() => {
  for (const plugin of plugins) plugin.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearLicenseStatus();
  _resetConnectStore();
  __resetHistorianStore();
});

describe('historian status on the unlicensed -> licensed edge (plan-2044 F2)', () => {
  it('re-reads /history/status once and the LICENSE_REQUIRED line disappears', async () => {
    makePlugin();
    gatewayLicensed = true;

    setLicense(true);
    await flush();

    expect(historyStatusCalls).toBe(1);
    expect(historianStore.getSnapshot().status?.disabledReason).not.toBe('LICENSE_REQUIRED');
    expect(historianLineShown()).toBe(false);
  });

  it('exactly one refresh per edge — repeated licensed snapshots fetch nothing more', async () => {
    makePlugin();
    gatewayLicensed = true;
    const refresh = vi.spyOn(historianStore, 'refreshStatus');

    setLicense(true);
    setLicense(true);
    _setLicenseSnapshotForTests({ supported: true, status: license(true), loading: true });
    await flush();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a CONNECT switch (status cleared) is no edge; the next real edge on the new gateway is', async () => {
    makePlugin();
    const refresh = vi.spyOn(historianStore, 'refreshStatus');

    clearLicenseStatus();
    setLicense(true); // a licensed gateway seen fresh: the button's connect effect covers it
    expect(refresh).not.toHaveBeenCalled();

    setLicense(false);
    setLicense(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a user-deactivated plugin ignores the edge; re-activation subscribes again', () => {
    const plugin = makePlugin();
    const refresh = vi.spyOn(historianStore, 'refreshStatus');

    plugin.onDeactivate();
    setLicense(true);
    expect(refresh).not.toHaveBeenCalled();

    setLicense(false);
    plugin.onActivate();
    setLicense(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a disposed plugin is unsubscribed', () => {
    const plugin = makePlugin();
    const refresh = vi.spyOn(historianStore, 'refreshStatus');

    plugin.dispose();
    setLicense(true);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('re-init keeps exactly one subscription', () => {
    const plugin = makePlugin();
    plugin.init();
    plugin.onActivate();
    const refresh = vi.spyOn(historianStore, 'refreshStatus');

    setLicense(true);

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
