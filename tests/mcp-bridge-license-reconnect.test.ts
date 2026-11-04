// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2044 F1: an unlicensed CONNECT refuses the `/webviewer` handshake, and by the time the
 * operator has registered, the bridge's backoff has grown to 30 s — the AI channel kept saying
 * "Connection refused" until the next slot or a click on "Retry Now" (measured live: 12-30 s).
 * The local `unlicensed -> licensed` edge in the license store now takes the Retry Now path at
 * once: backoff and diagnosis reset, one immediate connect. Exactly one per edge, never while the
 * plugin is deactivated or destroyed, never when no channel is wanted, never for a page that
 * loads against an already licensed gateway.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import {
  _setLicenseSnapshotForTests,
  getLicenseSnapshot,
  type LicenseStatus,
} from '../src/core/hmi/license-store';
import { installFakeWebSocket, type FakeWebSocketInstall } from './helpers/fake-websocket';

interface PageContext {
  protocol: string; host: string; origin: string;
  isDevServer: boolean; markerCookie: boolean; isLoopbackPage: boolean;
}

/** A page CONNECT serves (marker cookie): the channel is wanted with AI control off. */
const CONNECT_PAGE: PageContext = {
  protocol: 'http:', host: 'localhost:5100', origin: 'http://localhost:5100',
  isDevServer: false, markerCookie: true, isLoopbackPage: true,
};
/** The CDN demo: no CONNECT, so with AI off and no holder no channel is wanted. */
const HOSTED: PageContext = {
  protocol: 'https:', host: 'web.realvirtual.io', origin: 'https://web.realvirtual.io',
  isDevServer: false, markerCookie: false, isLoopbackPage: false,
};
const STATUS_FRAME = {
  type: 'status', role: 'active', claimed: false,
  capabilities: {}, status: { pid: 1, port: 5100, uptimeMs: 1, clientConnected: false },
};

type Internals = {
  _reconnectDelay: number;
  _reconnectAttempt: number;
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _pageContext: () => PageContext;
  _isPageVisible: () => boolean;
  onDestroy: () => void;
};

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

/** The license store as `fetchLicenseStatus` leaves it after a poll. */
function setLicense(gatewayAllowed: boolean | null): void {
  _setLicenseSnapshotForTests(gatewayAllowed === null
    ? {}
    : { supported: true, status: license(gatewayAllowed) });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

let ws: FakeWebSocketInstall;
let plugins: McpBridgePlugin[];

function makePlugin(page: PageContext = CONNECT_PAGE): { plugin: McpBridgePlugin; p: Internals } {
  const plugin = new McpBridgePlugin();
  const p = plugin as unknown as Internals;
  vi.spyOn(p, '_pageContext').mockReturnValue(page);
  vi.spyOn(p, '_isPageVisible').mockReturnValue(true);
  plugins.push(plugin);
  return { plugin, p };
}

function init(plugin: McpBridgePlugin): void {
  plugin.init({ emit: vi.fn(), on: vi.fn(() => () => {}) } as never);
}

/** Refuse handshakes until the backoff has reached its 30 s ceiling — the tutorial state. */
async function refuseUntilBackoffSaturated(p: Internals): Promise<void> {
  for (let i = 0; i < 8; i++) {
    ws.last.refuse();
    await flush();
    vi.advanceTimersByTime(31_000);
  }
  ws.last.refuse();
  await flush();
  expect(p._reconnectDelay).toBe(30_000);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  plugins = [];
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  // The failure diagnosis asks /health after a bare 1006: CONNECT is up, the bridge is mapped.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, statusText: '200',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ status: 'ok', bridgeEnabled: true }),
    text: async () => '{"status":"ok","bridgeEnabled":true}',
  }) as unknown as Response));
  ws = installFakeWebSocket();
  setLicense(false);
});

afterEach(() => {
  for (const plugin of plugins) (plugin as unknown as Internals).onDestroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  ws.restore();
  vi.restoreAllMocks();
  setLicense(null);
});

describe('AI channel on the unlicensed -> licensed edge (plan-2044 F1)', () => {
  it('connects at once with a reset backoff instead of waiting for the next 30 s slot', async () => {
    const { plugin, p } = makePlugin();
    init(plugin);
    await refuseUntilBackoffSaturated(p);
    expect(plugin.getSnapshot().failure).toBe('refused');
    const sockets = ws.instances.length;

    setLicense(true);

    // No timer advanced: the connect happened synchronously on the edge.
    expect(ws.instances.length).toBe(sockets + 1);
    expect(p._reconnectDelay).toBe(1000);
    expect(p._reconnectAttempt).toBe(0);
    expect(plugin.getSnapshot().failure).toBe('none');

    ws.last.open();
    ws.last.message(STATUS_FRAME);
    await flush();
    expect(plugin.getSnapshot().connected).toBe(true);
  });

  it('fires exactly once per edge — a repeated licensed snapshot connects nothing more', async () => {
    const { plugin, p } = makePlugin();
    init(plugin);
    await refuseUntilBackoffSaturated(p);
    const reconnect = vi.spyOn(plugin, 'reconnect');

    setLicense(true);
    _setLicenseSnapshotForTests({ ...getLicenseSnapshot(), loading: true });
    _setLicenseSnapshotForTests({ supported: true, status: license(true) });

    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('a second edge after the license was lost again reconnects again', async () => {
    const { plugin } = makePlugin();
    init(plugin);
    ws.last.refuse();
    await flush();
    const reconnect = vi.spyOn(plugin, 'reconnect');

    setLicense(true);
    ws.last.refuse(); // still refused — say the license dropped again
    await flush();
    setLicense(false);
    setLicense(true);

    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the gateway was already licensed at page load (no unlicensed state seen)', () => {
    setLicense(null);
    const { plugin } = makePlugin();
    init(plugin);
    const reconnect = vi.spyOn(plugin, 'reconnect');

    setLicense(true);

    expect(reconnect).not.toHaveBeenCalled();
  });

  it('leaves a channel that is already up alone', async () => {
    const { plugin } = makePlugin();
    init(plugin);
    ws.last.open();
    ws.last.message(STATUS_FRAME);
    await flush();
    expect(plugin.getSnapshot().connected).toBe(true);
    const sockets = ws.instances.length;

    setLicense(true);

    expect(ws.instances.length).toBe(sockets);
    expect(plugin.getSnapshot().connected).toBe(true);
  });

  it('never opens a channel nobody wants (hosted page, AI off, no holder)', () => {
    const { plugin } = makePlugin(HOSTED);
    init(plugin);
    const sockets = ws.instances.length;
    const reconnect = vi.spyOn(plugin, 'reconnect');

    setLicense(true);

    expect(reconnect).not.toHaveBeenCalled();
    expect(ws.instances.length).toBe(sockets);
  });
});

describe('lifecycle of the license subscription (plan-2044 F1)', () => {
  it('a deactivated plugin ignores the edge and stays closed', async () => {
    const { plugin } = makePlugin();
    init(plugin);
    ws.last.refuse();
    await flush();
    plugin.onDeactivate();
    const sockets = ws.instances.length;
    const reconnect = vi.spyOn(plugin, 'reconnect');

    setLicense(true);
    vi.advanceTimersByTime(60_000);

    expect(reconnect).not.toHaveBeenCalled();
    expect(ws.instances.length).toBe(sockets);
    expect(plugin.getSnapshot().connected).toBe(false);
  });

  it('a destroyed plugin is unsubscribed: the edge reaches nothing', async () => {
    const { plugin, p } = makePlugin();
    init(plugin);
    ws.last.refuse();
    await flush();
    p.onDestroy();
    const sockets = ws.instances.length;
    const reconnect = vi.spyOn(plugin, 'reconnect');

    setLicense(true);
    vi.advanceTimersByTime(60_000);

    expect(reconnect).not.toHaveBeenCalled();
    expect(ws.instances.length).toBe(sockets);
  });

  it('re-init keeps exactly one subscription: one edge, one reconnect', async () => {
    const { plugin } = makePlugin();
    init(plugin);
    init(plugin);
    init(plugin);
    ws.last.refuse();
    await flush();
    const reconnect = vi.spyOn(plugin, 'reconnect');

    setLicense(true);

    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
