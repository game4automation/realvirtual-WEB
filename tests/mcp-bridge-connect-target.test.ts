// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { installFakeWebSocket, type FakeWebSocketInstall } from './helpers/fake-websocket';

const store = vi.hoisted(() => ({
  snapshot: { serverUrl: 'http://localhost:51001', state: 'connected' },
  listeners: new Set<() => void>(),
}));

vi.mock('../src/core/hmi/connect-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/connect-store')>(),
  getConnectSnapshot: () => store.snapshot,
  subscribeConnectStore: (listener: () => void) => {
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  },
}));

type Internals = {
  _pageContext: () => {
    protocol: string; host: string; origin: string;
    isDevServer: boolean; markerCookie: boolean; isLoopbackPage: boolean;
  };
  onDestroy: () => void;
};

let ws: FakeWebSocketInstall;
const plugins: McpBridgePlugin[] = [];

function update(serverUrl: string, state = 'connected'): void {
  store.snapshot = { serverUrl, state };
  for (const listener of store.listeners) listener();
}

async function start(options: { ai?: boolean; dev?: boolean; embedded?: boolean; port?: string; urlPort?: string } = {}) {
  window.history.replaceState(null, '', options.urlPort ? `/?mcpPort=${options.urlPort}` : '/');
  localStorage.setItem('rv-ai-bridge', JSON.stringify({ enabled: options.ai ?? true, port: options.port ?? '5100' }));
  const plugin = new McpBridgePlugin();
  vi.spyOn(plugin as unknown as Internals, '_pageContext').mockReturnValue({
    protocol: options.dev ? 'http:' : 'https:',
    host: options.dev ? 'localhost:5173' : 'viewer.example.com',
    origin: options.dev ? 'http://localhost:5173' : 'https://viewer.example.com',
    isDevServer: options.dev ?? false, markerCookie: options.embedded ?? false, isLoopbackPage: options.dev ?? false,
  });
  plugins.push(plugin);
  plugin.init({ emit: vi.fn(), on: vi.fn(() => () => {}) } as never);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  return plugin;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  store.snapshot = { serverUrl: 'http://localhost:51001', state: 'connected' };
  store.listeners.clear();
  ws = installFakeWebSocket();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
});

afterEach(() => {
  for (const plugin of plugins.splice(0)) (plugin as unknown as Internals).onDestroy();
  ws.restore();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('MCP bridge follows the CONNECT store', () => {
  it('uses the default until CONNECT connects, then retains that target across connection failures', async () => {
    store.snapshot = { serverUrl: 'http://localhost:5173', state: 'connecting' };
    const plugin = await start({ dev: true });
    expect(ws.last.url).toBe('ws://localhost:5100/webviewer');
    expect(plugin.getSnapshot().target).toBe('ws://localhost:5100/webviewer');
    const first = ws.last;
    first.open();
    const reconnect = vi.spyOn(plugin, 'reconnect');

    update('http://localhost:51001');

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(ws.instances).toHaveLength(2);
    expect(ws.last.url).toBe('ws://localhost:51001/webviewer');
    expect(plugin.getSnapshot().target).toBe('ws://localhost:51001/webviewer');

    update('http://localhost:51001', 'connecting');
    update('http://localhost:5173', 'connecting');
    update('http://localhost:5173', 'error');
    update('http://localhost:5173', 'disconnected');

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(ws.instances).toHaveLength(2);
    expect(ws.last.close).not.toHaveBeenCalled();
    expect(plugin.getSnapshot().target).toBe('ws://localhost:51001/webviewer');
  });

  it('reconnects an active bridge to the new address without changing AI control', async () => {
    const plugin = await start();
    expect(ws.last.url).toBe('ws://localhost:51001/webviewer');
    const first = ws.last;
    first.open();
    const reconnect = vi.spyOn(plugin, 'reconnect');

    update('https://plant:8443/prefix');

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(ws.instances).toHaveLength(2);
    expect(ws.last.url).toBe('wss://plant:8443/webviewer');
    expect(plugin.aiEnabled).toBe(true);
  });

  it('ignores unconnected addresses and connected addresses with the same derived target', async () => {
    const plugin = await start();
    const reconnect = vi.spyOn(plugin, 'reconnect');
    update('http://localhost:51001', 'connecting');
    update('http://localhost:5173', 'connecting');
    update('http://localhost:5173', 'error');
    update('http://localhost:5173', 'disconnected');
    expect(plugin.getSnapshot().target).toBe('ws://localhost:51001/webviewer');
    update('http://localhost:51001/other/path?ignored=1');
    expect(reconnect).not.toHaveBeenCalled();
    expect(ws.instances).toHaveLength(1);
    expect(plugin.getSnapshot().target).toBe('ws://localhost:51001/webviewer');
  });

  it.each([{ port: '18714' }, { urlPort: '5100' }, { embedded: true }])
    ('does not reconnect when the target is pinned or embedded: %j', async (options) => {
      const plugin = await start(options);
      const reconnect = vi.spyOn(plugin, 'reconnect');
      update('https://plant:8443');
      expect(reconnect).not.toHaveBeenCalled();
      expect(ws.instances).toHaveLength(1);
    });

  it('does not open a channel while AI is off and nobody holds it', async () => {
    const plugin = await start({ ai: false });
    const reconnect = vi.spyOn(plugin, 'reconnect');
    update('https://plant:8443');
    expect(reconnect).not.toHaveBeenCalled();
    expect(ws.instances).toHaveLength(0);
    plugin.acquireChannel('test');
    expect(ws.last.url).toBe('wss://plant:8443/webviewer');
    expect(plugin.aiEnabled).toBe(false);
  });

  it('uses the localhost fallback for an empty configured address', async () => {
    store.snapshot.serverUrl = '  ';
    await start();
    expect(ws.last.url).toBe('ws://localhost:5100/webviewer');
  });

  it('releases the subscription on deactivation and restores it on activation', async () => {
    const plugin = await start();
    expect(store.listeners.size).toBe(1);
    plugin.onDeactivate();
    expect(store.listeners.size).toBe(0);
    update('https://plant:8443');
    expect(ws.instances).toHaveLength(1);
    plugin.onActivate();
    expect(store.listeners.size).toBe(1);
    expect(ws.last.url).toBe('wss://plant:8443/webviewer');
  });

  it('retains the last connected address when reactivated while the store is connecting', async () => {
    const plugin = await start();
    plugin.onDeactivate();
    update('http://localhost:5173', 'connecting');
    plugin.onActivate();
    expect(store.listeners.size).toBe(1);
    expect(ws.instances).toHaveLength(2);
    expect(ws.last.url).toBe('ws://localhost:51001/webviewer');
    expect(plugin.getSnapshot().target).toBe('ws://localhost:51001/webviewer');
  });

  it('re-init keeps one subscription and destroy releases it', async () => {
    const plugin = await start();
    plugin.init({ emit: vi.fn(), on: vi.fn(() => () => {}) } as never);
    expect(store.listeners.size).toBe(1);
    (plugin as unknown as Internals).onDestroy();
    expect(store.listeners.size).toBe(0);
    update('https://plant:8443');
    expect(ws.instances).toHaveLength(1);
  });
});
