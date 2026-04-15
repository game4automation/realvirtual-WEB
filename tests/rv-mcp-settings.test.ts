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
import { McpBridgePlugin, type McpBridgeSnapshot } from '../src/plugins/mcp-bridge-plugin';
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
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _reconnectDelay: number;
  _currentPort: string;
  _reconnectAttempt: number;
  _connect: () => void;
  _disconnect: () => void;
  _sendDiscover: () => void;
  _emitChanged: () => void;
  _scheduleReconnect: () => void;
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

// ── Tests ──

describe('McpBridgePlugin - State Extension', () => {
  it('_emitChanged fires with correct snapshot shape on WS open', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // Simulate a WS open event
    const fakeWs = createFakeWs();
    p._ws = fakeWs;
    p._dispatcher = buildToolDispatcher(plugin);
    p._destroyed = false;

    // Call _emitChanged (as would happen in onopen)
    p._emitChanged();

    expect(viewer.emit).toHaveBeenCalledOnce();
    const [event, snapshot] = viewer.emit.mock.calls[0];
    expect(event).toBe('mcp-bridge-changed');

    const s = snapshot as McpBridgeSnapshot;
    expect(s.connected).toBe(true);
    expect(s.port).toBe('18712');
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

  it('setEnabled(false) disconnects, clears timer, emits with enabled=false', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // Start in enabled state with a reconnect timer
    p._destroyed = false;
    p._reconnectTimer = setTimeout(() => {}, 10000);
    const fakeWs = createFakeWs();
    p._ws = fakeWs;

    plugin.setEnabled(false);

    expect(p._destroyed).toBe(true);
    expect(p._reconnectTimer).toBeNull();
    expect(fakeWs.close).toHaveBeenCalled();

    const snapshot = viewer.emit.mock.calls[viewer.emit.mock.calls.length - 1][1] as McpBridgeSnapshot;
    expect(snapshot.enabled).toBe(false);
  });

  it('setEnabled(true) starts connect, emits with enabled=true', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // Start in disabled state
    p._destroyed = true;

    // Spy on _connect to prevent actual WS creation
    const connectSpy = vi.spyOn(p as unknown as { _connect: () => void }, '_connect').mockImplementation(() => {});

    plugin.setEnabled(true);

    expect(p._destroyed).toBe(false);
    expect(connectSpy).toHaveBeenCalled();

    const snapshot = viewer.emit.mock.calls[viewer.emit.mock.calls.length - 1][1] as McpBridgeSnapshot;
    expect(snapshot.enabled).toBe(true);

    connectSpy.mockRestore();
  });

  it('setEnabled idempotency: calling setEnabled(false) twice does not double-fire disconnect', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    // Start enabled
    p._destroyed = false;
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
    p._currentPort = '12345';

    const connectSpy = vi.spyOn(p as unknown as { _connect: () => void }, '_connect').mockImplementation(() => {});

    plugin.reconnect();

    expect(p._currentPort).toBe('12345');
    expect(connectSpy).toHaveBeenCalled();

    connectSpy.mockRestore();
  });

  it('getters return correct values in various states', () => {
    const { plugin } = setupPlugin();
    const p = internals(plugin);

    // Initial state: no WS, no dispatcher, not destroyed
    p._ws = null;
    p._dispatcher = null;
    p._destroyed = false;
    p._currentPort = '18712';

    expect(plugin.mcpConnected).toBe(false);
    expect(plugin.mcpPort).toBe('18712');
    expect(plugin.mcpToolCount).toBe(0);
    expect(plugin.mcpEnabled).toBe(true);

    // Simulate WS open with dispatcher
    const fakeWs = createFakeWs();
    p._ws = fakeWs;
    p._dispatcher = buildToolDispatcher(plugin);

    expect(plugin.mcpConnected).toBe(true);
    expect(plugin.mcpToolCount).toBeGreaterThan(0);

    // Simulate destroyed
    p._destroyed = true;
    expect(plugin.mcpEnabled).toBe(false);
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

  it('snapshot contains all 7 McpBridgeSnapshot fields with correct types', () => {
    const { plugin, viewer } = setupPlugin();
    const p = internals(plugin);

    p._ws = createFakeWs();
    p._destroyed = false;
    p._currentPort = '19999';
    p._reconnectAttempt = 3;
    p._reconnectDelay = 4000;
    p._dispatcher = buildToolDispatcher(plugin);

    p._emitChanged();

    expect(viewer.emit).toHaveBeenCalledOnce();
    const snapshot = viewer.emit.mock.calls[0][1] as McpBridgeSnapshot;

    // Verify all 7 fields exist and have correct types
    expect(typeof snapshot.connected).toBe('boolean');
    expect(typeof snapshot.port).toBe('string');
    expect(typeof snapshot.toolCount).toBe('number');
    expect(Array.isArray(snapshot.toolNames)).toBe(true);
    expect(typeof snapshot.enabled).toBe('boolean');
    expect(typeof snapshot.reconnectAttempt).toBe('number');
    expect(typeof snapshot.reconnectDelay).toBe('number');

    // Verify specific values
    expect(snapshot.connected).toBe(true);
    expect(snapshot.port).toBe('19999');
    expect(snapshot.toolCount).toBeGreaterThan(0);
    expect(snapshot.toolNames.length).toBeGreaterThan(0);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.reconnectAttempt).toBe(3);
    expect(snapshot.reconnectDelay).toBe(4000);

    // Verify exactly 7 keys (no extra, no missing)
    expect(Object.keys(snapshot)).toHaveLength(7);
    expect(Object.keys(snapshot).sort()).toEqual(
      ['connected', 'enabled', 'port', 'reconnectAttempt', 'reconnectDelay', 'toolCount', 'toolNames'],
    );
  });
});
