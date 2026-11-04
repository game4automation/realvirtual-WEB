// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-settings.test.ts — Tests for McpBridgePlugin state extension.
 *
 * Validates:
 * - _emitChanged fires with correct snapshot shape on WS open/close
 * - setEnabled/reconnect public API behavior
 * - Public getters return correct values
 * - McpBridgeSnapshot shape correctness
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  McpBridgePlugin,
  DEFAULT_BRIDGE_PORT,
  NODE_FALLBACK_PORT,
  type McpBridgeSnapshot,
} from '../src/plugins/mcp-bridge-plugin';
import { buildToolDispatcher } from '../src/core/engine/rv-mcp-tools';

// ── Minimal mock viewer ──

function createMockViewer() {
  return {
    drives: [],
    signalStore: {
      size: 0,
      getAll: () => new Map(),
      get: () => undefined,
      set: vi.fn(),
      getBool: () => false,
      getFloat: () => 0,
      subscribe: vi.fn(() => () => {}),
    },
    transportManager: {
      sensors: [],
      mus: [],
      sources: [],
      sinks: [],
      totalSpawned: 0,
      totalConsumed: 0,
    },
    logicEngine: { roots: [], stats: { totalSteps: 0, activeSteps: 0 } },
    currentFps: 60,
    connectionState: 'Connected',
    currentModelUrl: '/models/test.glb',
    lastLoadInfo: null,
    scene: {},
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  };
}

type MockViewer = ReturnType<typeof createMockViewer>;

// ── Helper: wire plugin with mock viewer (no WS) ──

function setupPlugin() {
  const plugin = new McpBridgePlugin();
  const viewer = createMockViewer();
  (plugin as unknown as { viewer: MockViewer }).viewer = viewer as unknown as MockViewer;
  return { plugin, viewer };
}

// ── Helper: access private fields ──

type PluginInternals = {
  _ws: { readyState: number; send: Function; close: Function; onclose: null | Function; onerror: null | Function; onmessage: null | Function; onopen: null | Function } | null;
  _dispatcher: Map<string, unknown> | null;
  _destroyed: boolean;
  _aiEnabled: boolean;
  _sameOriginIsConnect: boolean | null;
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _reconnectDelay: number;
  _currentPort: string;
  _reconnectAttempt: number;
  _connect: () => void;
  _disconnect: () => void;
  _sendDiscover: () => void;
  _emitChanged: () => void;
  _scheduleReconnect: () => void;
  _handleMessage: (raw: string) => Promise<void>;
};

function internals(plugin: McpBridgePlugin): PluginInternals {
  return plugin as unknown as PluginInternals;
}

// ── Helper: create fake WS with open readyState ──

function createFakeWs() {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
    close: vi.fn(),
    onclose: null as Function | null,
    onerror: null as Function | null,
    onmessage: null as Function | null,
    onopen: null as Function | null,
  };
}

/** A bridge status frame — plan-541: only this makes the bridge "connected". */
const STATUS_FRAME = JSON.stringify({
  type: 'status',
  status: {
    pid: 1, port: 5100, uptimeMs: 1000, clientName: null, clientVersion: null,
    clientConnected: false, lastRequestAgoMs: null,
  },
});

// ── Tests ──

describe('McpBridgePlugin - State Extension', () => {
  it('_emitChanged fires with correct snapshot shape once the bridge is ready', async () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // Simulate a WS open event followed by the server's first status frame
    // (plan-541: a transport open alone is not "connected").
    const fakeWs = createFakeWs();
    p._ws = fakeWs;
    p._dispatcher = buildToolDispatcher(plugin);
    p._destroyed = false;
    p._aiEnabled = true;
    await p._handleMessage(STATUS_FRAME);
    viewer.emit.mockClear();

    // Call _emitChanged (as would happen on any later transition)
    p._emitChanged();

    expect(viewer.emit).toHaveBeenCalledOnce();
    const [event, snapshot] = viewer.emit.mock.calls[0];
    expect(event).toBe('mcp-bridge-changed');

    const s = snapshot as McpBridgeSnapshot;
    expect(s.connected).toBe(true);
    expect(s.port).toBe(DEFAULT_BRIDGE_PORT);
    expect(s.toolCount).toBeGreaterThan(0);
    expect(s.enabled).toBe(true);
    expect(typeof s.reconnectAttempt).toBe('number');
    expect(typeof s.reconnectDelay).toBe('number');
  });

  it('_emitChanged fires with connected=false on WS close', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // WS is null (closed)
    p._ws = null;
    p._destroyed = false;

    p._emitChanged();

    expect(viewer.emit).toHaveBeenCalledOnce();
    const snapshot = viewer.emit.mock.calls[0][1] as McpBridgeSnapshot;
    expect(snapshot.connected).toBe(false);
  });

  // plan-668: "switch off = no socket" now holds only for a page CONNECT does not serve.
  it('setEnabled(false) on a page without CONNECT disconnects, clears timer, emits with enabled=false', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // Start in enabled state with a reconnect timer, on a page CONNECT does not serve
    p._destroyed = false;
    p._aiEnabled = true;
    p._sameOriginIsConnect = false;
    p._reconnectTimer = setTimeout(() => {}, 10000);
    const fakeWs = createFakeWs();
    p._ws = fakeWs;

    plugin.setEnabled(false);

    expect(p._aiEnabled).toBe(false);
    // plan-668: the AI switch is no longer the lifetime flag.
    expect(p._destroyed).toBe(false);
    expect(p._reconnectTimer).toBeNull();
    expect(fakeWs.close).toHaveBeenCalled();

    const snapshot = viewer.emit.mock.calls[viewer.emit.mock.calls.length - 1][1] as McpBridgeSnapshot;
    expect(snapshot.enabled).toBe(false);
  });

  it('setEnabled(false) on a CONNECT-served page keeps the socket and re-announces an empty catalog (plan-668)', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);
    p._destroyed = false;
    p._aiEnabled = true;
    p._sameOriginIsConnect = true;
    const fakeWs = createFakeWs();
    p._ws = fakeWs;

    plugin.setEnabled(false);

    expect(fakeWs.close).not.toHaveBeenCalled();
    expect(p._ws).toBe(fakeWs);
    const frames = fakeWs.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(frames.find((f) => f.type === 'discover')).toMatchObject({ tools: [], ai: false });
    expect(frames.find((f) => f.type === 'viewer_status')).toMatchObject({ ai: false });
    const snapshot = viewer.emit.mock.calls[viewer.emit.mock.calls.length - 1][1] as McpBridgeSnapshot;
    expect(snapshot).toMatchObject({ enabled: false, aiEnabled: false, channelReason: 'connect-origin' });
  });

  it('setEnabled(true) on a page without CONNECT starts connect, emits with enabled=true', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // Start in disabled state, no channel (a page CONNECT does not serve)
    p._aiEnabled = false;
    p._sameOriginIsConnect = false;

    // Spy on _connect to prevent actual WS creation
    const connectSpy = vi.spyOn(p as unknown as { _connect: () => void }, '_connect').mockImplementation(() => {});

    plugin.setEnabled(true);

    expect(p._aiEnabled).toBe(true);
    expect(connectSpy).toHaveBeenCalled();

    const snapshot = viewer.emit.mock.calls[viewer.emit.mock.calls.length - 1][1] as McpBridgeSnapshot;
    expect(snapshot.enabled).toBe(true);

    connectSpy.mockRestore();
  });

  it('setEnabled idempotency: calling setEnabled(false) twice does not double-fire disconnect', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // Start enabled, on a page CONNECT does not serve
    p._destroyed = false;
    p._aiEnabled = true;
    p._sameOriginIsConnect = false;
    const fakeWs = createFakeWs();
    p._ws = fakeWs;

    plugin.setEnabled(false);
    const emitCountAfterFirst = viewer.emit.mock.calls.length;

    plugin.setEnabled(false);
    // Second call should emit once more (the _emitChanged at the end of setEnabled)
    // but NOT call _disconnect again since already disabled
    expect(viewer.emit.mock.calls.length).toBe(emitCountAfterFirst + 1);
    // close was called only once (from the first setEnabled(false))
    expect(fakeWs.close).toHaveBeenCalledTimes(1);
  });

  it('reconnect(port) updates _currentPort and calls _connect', () => {
    const { plugin } = setupPlugin();
    const p = internals(plugin);
    p._destroyed = false;
    p._aiEnabled = true;

    const connectSpy = vi.spyOn(p as unknown as { _connect: () => void }, '_connect').mockImplementation(() => {});

    plugin.reconnect('19000');

    expect(p._currentPort).toBe('19000');
    expect(connectSpy).toHaveBeenCalled();
    expect(p._reconnectAttempt).toBe(0);
    expect(p._reconnectDelay).toBe(1000);

    connectSpy.mockRestore();
  });

  it('reconnect() without port keeps _currentPort unchanged', () => {
    const { plugin } = setupPlugin();
    const p = internals(plugin);
    p._destroyed = false;
    p._aiEnabled = true;
    p._currentPort = '12345';

    const connectSpy = vi.spyOn(p as unknown as { _connect: () => void }, '_connect').mockImplementation(() => {});

    plugin.reconnect();

    expect(p._currentPort).toBe('12345');
    expect(connectSpy).toHaveBeenCalled();

    connectSpy.mockRestore();
  });

  it('getters return correct values in various states', async () => {
    const { plugin } = setupPlugin();
    const p = internals(plugin);

    // Initial state: no WS, no dispatcher, not destroyed
    p._ws = null;
    p._dispatcher = null;
    p._destroyed = false;
    p._aiEnabled = true;
    p._currentPort = '18712';

    expect(plugin.mcpConnected).toBe(false);
    expect(plugin.mcpPort).toBe('18712');
    expect(plugin.mcpToolCount).toBe(0);
    expect(plugin.mcpEnabled).toBe(true);

    // Simulate WS open with dispatcher — transport open alone is NOT connected
    // (plan-541), the first status frame is.
    const fakeWs = createFakeWs();
    p._ws = fakeWs;
    p._dispatcher = buildToolDispatcher(plugin);
    expect(plugin.mcpConnected).toBe(false);

    await p._handleMessage(STATUS_FRAME);
    expect(plugin.mcpConnected).toBe(true);
    expect(plugin.mcpToolCount).toBeGreaterThan(0);

    // plan-668: mcpEnabled is AI control, not the lifetime flag
    p._destroyed = true;
    expect(plugin.mcpEnabled).toBe(true);
    p._aiEnabled = false;
    expect(plugin.mcpEnabled).toBe(false);
    expect(plugin.aiEnabled).toBe(false);
  });

  it('toolCount reflects dispatcher.size after discover', () => {
    const { plugin } = setupPlugin();
    const p = internals(plugin);

    // Before discover: no dispatcher
    expect(plugin.mcpToolCount).toBe(0);

    // After discover: dispatcher has tools
    p._dispatcher = buildToolDispatcher(plugin);
    const expectedSize = p._dispatcher.size;
    expect(expectedSize).toBeGreaterThan(0);
    expect(plugin.mcpToolCount).toBe(expectedSize);
  });

  it('snapshot contains all 15 McpBridgeSnapshot fields with correct types', async () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    p._ws = createFakeWs();
    p._destroyed = false;
    p._aiEnabled = true;
    p._sameOriginIsConnect = false;
    p._currentPort = '19999';
    p._dispatcher = buildToolDispatcher(plugin);
    await p._handleMessage(STATUS_FRAME); // ready → resets the backoff
    p._reconnectAttempt = 3;
    p._reconnectDelay = 4000;
    viewer.emit.mockClear();

    p._emitChanged();

    expect(viewer.emit).toHaveBeenCalledOnce();
    const snapshot = viewer.emit.mock.calls[0][1] as McpBridgeSnapshot;

    // Verify all 15 fields exist and have correct types
    expect(typeof snapshot.connected).toBe('boolean');
    expect(typeof snapshot.port).toBe('string');
    expect(typeof snapshot.toolCount).toBe('number');
    expect(Array.isArray(snapshot.toolNames)).toBe(true);
    expect(typeof snapshot.enabled).toBe('boolean');
    expect(typeof snapshot.aiSolidCraft).toBe('boolean');
    expect(typeof snapshot.reconnectAttempt).toBe('number');
    expect(typeof snapshot.reconnectDelay).toBe('number');
    // serverStatus is the bridge's full-chain health frame — the one just received.
    expect(snapshot.serverStatus?.pid).toBe(1);
    // plan-541: the resolved target (never with ?apikey) and the failure cause.
    expect(typeof snapshot.target).toBe('string');
    expect(snapshot.target).toContain('/webviewer');
    expect(snapshot.target).not.toContain('apikey');
    expect(snapshot.failure).toBe('none');

    // Verify specific values
    expect(snapshot.connected).toBe(true);
    expect(snapshot.port).toBe('19999');
    expect(snapshot.toolCount).toBeGreaterThan(0);
    expect(snapshot.toolNames.length).toBeGreaterThan(0);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.aiSolidCraft).toBe(false);
    expect(snapshot.reconnectAttempt).toBe(3);
    expect(snapshot.reconnectDelay).toBe(4000);

    // plan-564: ownership of this tab (no role in the frame = a gateway without standby).
    expect(snapshot.role).toBeNull();
    expect(snapshot.claimed).toBe(false);
    // plan-668: AI control and the channel reason ride separately.
    expect(snapshot.aiEnabled).toBe(true);
    expect(snapshot.channelReason).toBe('ai');

    // Verify exactly 15 keys (no extra, no missing)
    expect(Object.keys(snapshot)).toHaveLength(15);
    expect(Object.keys(snapshot).sort()).toEqual(
      ['aiEnabled', 'aiSolidCraft', 'channelReason', 'claimed', 'connected', 'enabled', 'failure', 'port', 'reconnectAttempt', 'reconnectDelay', 'role', 'serverStatus', 'target', 'toolCount', 'toolNames'],
    );
  });
});

describe('McpBridgePlugin - Persistence (reload)', () => {
  beforeEach(() => { localStorage.clear(); });

  it('saves the port to localStorage when changed (without connecting)', () => {
    const { plugin } = setupPlugin();
    plugin.setPort('17777');
    const raw = JSON.parse(localStorage.getItem('rv-ai-bridge') ?? '{}');
    expect(raw.port).toBe('17777');
  });

  it('restores enabled=false + port from localStorage on init', () => {
    localStorage.setItem('rv-ai-bridge', JSON.stringify({ enabled: false, port: '16666' }));
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { init: (v: unknown) => void }).init(viewer);
    expect(plugin.mcpPort).toBe('16666');
    expect(plugin.mcpEnabled).toBe(false);
  });

  it('getSnapshot reflects the restored state (UI seeding on mount)', () => {
    localStorage.setItem('rv-ai-bridge', JSON.stringify({ enabled: false, port: '15555' }));
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { init: (v: unknown) => void }).init(viewer);
    const snap = plugin.getSnapshot();
    expect(snap.port).toBe('15555');
    expect(snap.enabled).toBe(false);
  });
});

// plan-327 AP5: CONNECT becomes the default transport WITHOUT taking the Node bridge away.
describe('McpBridgePlugin - CONNECT is the default, Node stays reachable', () => {
  beforeEach(() => { localStorage.clear(); });

  it('a fresh profile targets CONNECT and does not pin the port', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { init: (v: unknown) => void }).init(viewer);

    expect(plugin.mcpPort).toBe(DEFAULT_BRIDGE_PORT);
    // Not pinned → same-origin derivation still applies where the HMI is served by CONNECT.
    expect((plugin as unknown as { _explicitPort: boolean })._explicitPort).toBe(false);
  });

  it('a profile that still holds a Node port keeps it (the fallback is not taken away)', () => {
    localStorage.setItem('rv-ai-bridge',
      JSON.stringify({ enabled: false, port: NODE_FALLBACK_PORT }));
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { init: (v: unknown) => void }).init(viewer);

    expect(plugin.mcpPort).toBe(NODE_FALLBACK_PORT);
    expect((plugin as unknown as { _explicitPort: boolean })._explicitPort).toBe(true);
  });

  it('switching to a Node port pins it, switching back to CONNECT un-pins it', () => {
    const { plugin } = setupPlugin();
    const p = plugin as unknown as { _explicitPort: boolean };

    plugin.setPort(NODE_FALLBACK_PORT);
    expect(p._explicitPort).toBe(true);

    plugin.setPort(DEFAULT_BRIDGE_PORT);
    expect(p._explicitPort).toBe(false);
    expect(plugin.mcpPort).toBe(DEFAULT_BRIDGE_PORT);
  });
});
