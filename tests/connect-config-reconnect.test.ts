// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2024 P1 F2: a push sent while the bridge channel was down is gone. After the channel
 * reconnects the tab reloads interfaces and both bridge caches once - without any further push.
 * Also: a `config` frame on the real plugin reaches the store, an unknown frame type is ignored.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import {
  connectToServer,
  getConnectBridges,
  getConnectSnapshot,
  getConnectConfigAppliedRevision,
  reloadConnectBridges,
  _setConfigRetryDelaysForTest,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import { installFakeWebSocket, type FakeWebSocketInstall } from './helpers/fake-websocket';
import { installConfigGateway, type FakeConfigGateway } from './helpers/connect-config-gateway';

const LOOPBACK = {
  protocol: 'http:', host: 'localhost:5100', origin: 'http://localhost:5100',
  isDevServer: false, markerCookie: true, isLoopbackPage: true,
};
const STATUS = {
  type: 'status', role: 'active', claimed: false,
  capabilities: {}, status: { pid: 1, port: 5100, uptimeMs: 1, clientConnected: false },
};

type Internals = { _pageContext: () => unknown; _isPageVisible: () => boolean; onDestroy: () => void };

let ws: FakeWebSocketInstall;
let gw: FakeConfigGateway;
let plugin: McpBridgePlugin;

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  _resetConnectStore();
  vi.restoreAllMocks();
  _setConfigRetryDelaysForTest([5, 5, 5]);
  ws = installFakeWebSocket();
  gw = installConfigGateway();
  await connectToServer();
  await reloadConnectBridges();

  localStorage.setItem('rv-ai-bridge', JSON.stringify({ enabled: true, port: '5100' }));
  plugin = new McpBridgePlugin();
  const p = plugin as unknown as Internals;
  vi.spyOn(p, '_pageContext').mockReturnValue(LOOPBACK);
  vi.spyOn(p, '_isPageVisible').mockReturnValue(true);
  plugin.init({ emit: vi.fn(), on: vi.fn(() => () => {}) } as never);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  (plugin as unknown as Internals).onDestroy();
  ws.restore();
  _setConfigRetryDelaysForTest(null);
  _resetConnectStore();
});

describe('config frames on the real bridge plugin', () => {
  it('a config frame reloads; an unknown frame type changes nothing', async () => {
    ws.last.open();
    ws.last.message(STATUS);
    const calls = gw.calls['/config/interfaces'];

    ws.last.message({ type: 'something-new', payload: 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(gw.calls['/config/interfaces']).toBe(calls);

    gw.mappings = [{ enabled: true, sourceSignal: 'X', destSignal: 'Y' }];
    ws.last.message({ type: 'config', instance: 'g', revision: 1 });
    await vi.waitFor(() => expect(getConnectConfigAppliedRevision()).toBe(1));
    expect(getConnectBridges().mappings).toHaveLength(1);
  });
});

describe('channel reconnect', () => {
  it('reloads interfaces and both bridge caches once, with no push', async () => {
    ws.last.open();
    ws.last.message(STATUS);
    await vi.advanceTimersByTimeAsync(20);
    const ifaceCalls = gw.calls['/config/interfaces'];
    const mirrorCalls = gw.calls['/config/mirrors'];
    const mappingCalls = gw.calls['/config/mappings'];

    // channel down, configuration changes meanwhile - the push is lost
    ws.last.serverClose(1006);
    gw.interfaces = [{ id: 'fresh', type: 'S7', enabled: true, signals: [] }];
    gw.mappings = [{ enabled: true, sourceSignal: 'N', destSignal: 'M' }];
    gw.mirrors = [{ id: 'm9', enabled: true }];

    await vi.advanceTimersByTimeAsync(60_000); // reconnect backoff
    const reconnected = ws.last;
    reconnected.open();
    reconnected.message(STATUS);

    await vi.waitFor(() => expect(getConnectSnapshot().interfaces.map((i) => i.id)).toEqual(['fresh']));
    expect(getConnectBridges().mappings).toHaveLength(1);
    expect(getConnectBridges().mirrors).toHaveLength(1);
    expect(gw.calls['/config/interfaces']).toBe(ifaceCalls + 1);
    expect(gw.calls['/config/mirrors']).toBe(mirrorCalls + 1);
    expect(gw.calls['/config/mappings']).toBe(mappingCalls + 1);
  });
});
