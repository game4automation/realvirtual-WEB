// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-bridge.test.ts — Tests for McpBridgePlugin message dispatch.
 *
 * Validates:
 * - _handleMessage dispatches call to correct @McpTool method
 * - Unknown tool name returns error result
 * - Malformed JSON doesn't crash
 * - Missing fields (type, id) don't crash
 * - Missing viewer/signals/transport gracefully handled
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { buildToolDispatcher } from '../src/core/engine/rv-mcp-tools';

// ── Minimal mock viewer ──

function createMockViewer() {
  const drives = [
    {
      name: 'TestDrive1',
      node: { name: 'TestDrive1' },
      currentPosition: 42.5,
      targetPosition: 100,
      targetSpeed: 200,
      isRunning: false,
      jogForward: false,
      jogBackward: false,
      Direction: 0,
      UpperLimit: 180,
      LowerLimit: -180,
      Acceleration: 100,
      stop: vi.fn(),
    },
  ];

  const sensorList = [
    {
      name: 'TestSensor1',
      node: { name: 'TestSensor1' },
      occupied: true,
      mode: 'Collision',
      SensorOccupied: 'SensorOccupiedSignal',
      SensorNotOccupied: null,
    },
  ];

  const signalMap = new Map<string, boolean | number>([
    ['StartSignal', true],
    ['SpeedSignal', 3.14],
  ]);

  const signalStore = {
    size: signalMap.size,
    getAll: () => signalMap,
    get: (name: string) => signalMap.get(name),
    set: vi.fn((name: string, value: boolean | number) => {
      signalMap.set(name, value);
    }),
    getBool: (name: string) => {
      const v = signalMap.get(name);
      return typeof v === 'boolean' ? v : false;
    },
    getFloat: (name: string) => {
      const v = signalMap.get(name);
      return typeof v === 'number' ? v : 0;
    },
    subscribe: vi.fn(() => () => {}),
  };

  const transportManager = {
    sensors: sensorList,
    mus: [],
    sources: [],
    sinks: [],
    totalSpawned: 5,
    totalConsumed: 3,
  };

  const logicEngine = {
    roots: [],
    stats: { totalSteps: 0, activeSteps: 0 },
  };

  return {
    drives,
    signalStore,
    transportManager,
    logicEngine,
    currentFps: 60,
    connectionState: 'Connected',
    currentModelUrl: '/models/test.glb',
    lastLoadInfo: { glbSize: '1.2 MB', loadTime: '0.5s' },
    scene: {},
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  };
}

type MockViewer = ReturnType<typeof createMockViewer>;

// ── Helper: wire up plugin with mock viewer ──

function setupPlugin() {
  const plugin = new McpBridgePlugin();
  const viewer = createMockViewer();

  // Inject viewer by simulating model loaded (skip WebSocket connection)
  // We need to set the viewer ref and call onStart without triggering WS connect.
  // Access private viewer field via prototype chain.
  (plugin as unknown as { viewer: MockViewer }).viewer = viewer as unknown as MockViewer;

  // Build dispatcher manually (normally done in _sendDiscover)
  (plugin as unknown as { _dispatcher: ReturnType<typeof buildToolDispatcher> })._dispatcher = buildToolDispatcher(plugin);

  return { plugin, viewer };
}

// ── Helper: call _handleMessage and capture WebSocket sends ──

function createMessageHandler(plugin: McpBridgePlugin) {
  const sent: string[] = [];
  const fakeWs = {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => { sent.push(data); },
    close: vi.fn(),
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  (plugin as unknown as { _ws: typeof fakeWs })._ws = fakeWs;

  // Access private _handleMessage method
  const handleMessage = (plugin as unknown as { _handleMessage: (raw: string) => Promise<void> })._handleMessage.bind(plugin);

  return { handleMessage, sent };
}

// ── Tests ──

describe('McpBridgePlugin - Message Dispatch', () => {
  it('dispatches call to correct @McpTool method (web_status)', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 1,
      tool: 'web_status',
      arguments: {},
    }));

    expect(sent.length).toBe(1);
    const result = JSON.parse(sent[0]);
    expect(result.type).toBe('result');
    expect(result.id).toBe(1);
    expect(result.error).toBeUndefined();

    const payload = JSON.parse(result.result);
    expect(payload.connected).toBe(true);
    expect(payload.fps).toBe(60);
    expect(payload.driveCount).toBe(1);
    expect(payload.signalCount).toBe(2);
  });

  it('dispatches web_drive_list and returns drive data', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 2,
      tool: 'web_drive_list',
      arguments: {},
    }));

    const result = JSON.parse(sent[0]);
    expect(result.id).toBe(2);
    expect(result.error).toBeUndefined();

    const drives = JSON.parse(result.result);
    expect(drives).toHaveLength(1);
    expect(drives[0].name).toBe('TestDrive1');
    expect(drives[0].currentPosition).toBeCloseTo(42.5, 2);
  });

  it('dispatches web_signal_list and returns signals', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 3,
      tool: 'web_signal_list',
      arguments: {},
    }));

    const result = JSON.parse(sent[0]);
    const signals = JSON.parse(result.result);
    expect(signals).toHaveLength(2);
    const start = signals.find((s: { name: string }) => s.name === 'StartSignal');
    expect(start.value).toBe(true);
    expect(start.type).toBe('boolean');
  });

  it('dispatches web_signal_set_bool and writes signal', async () => {
    const { plugin, viewer } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 4,
      tool: 'web_signal_set_bool',
      arguments: { name: 'StartSignal', value: false },
    }));

    const result = JSON.parse(sent[0]);
    expect(result.error).toBeUndefined();
    const payload = JSON.parse(result.result);
    expect(payload.name).toBe('StartSignal');
    expect(payload.value).toBe(false);
    expect(payload.previous).toBe(true);
    expect(viewer.signalStore.set).toHaveBeenCalledWith('StartSignal', false);
  });

  it('dispatches web_sensor_list and returns sensor data', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 5,
      tool: 'web_sensor_list',
      arguments: {},
    }));

    const result = JSON.parse(sent[0]);
    const sensors = JSON.parse(result.result);
    expect(sensors).toHaveLength(1);
    expect(sensors[0].name).toBe('TestSensor1');
    expect(sensors[0].occupied).toBe(true);
  });

  it('dispatches web_drive_jog and sets jog flags', async () => {
    const { plugin, viewer } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 6,
      tool: 'web_drive_jog',
      arguments: { name: 'TestDrive1', forward: true },
    }));

    const result = JSON.parse(sent[0]);
    expect(result.error).toBeUndefined();
    const payload = JSON.parse(result.result);
    expect(payload.jogForward).toBe(true);
    expect(payload.jogBackward).toBe(false);
    expect(viewer.drives[0].jogForward).toBe(true);
  });

  it('dispatches web_drive_stop and calls drive.stop()', async () => {
    const { plugin, viewer } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 7,
      tool: 'web_drive_stop',
      arguments: { name: 'TestDrive1' },
    }));

    const result = JSON.parse(sent[0]);
    expect(result.error).toBeUndefined();
    expect(viewer.drives[0].stop).toHaveBeenCalled();
    expect(viewer.drives[0].jogForward).toBe(false);
    expect(viewer.drives[0].jogBackward).toBe(false);
  });
});

describe('McpBridgePlugin - Error Handling', () => {
  it('returns error for unknown tool name', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 10,
      tool: 'web_nonexistent_tool',
      arguments: {},
    }));

    const result = JSON.parse(sent[0]);
    expect(result.type).toBe('result');
    expect(result.id).toBe(10);
    expect(result.error).toContain('Unknown tool');
    expect(result.error).toContain('web_nonexistent_tool');
  });

  it('returns error when drive not found (web_drive_jog)', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 11,
      tool: 'web_drive_jog',
      arguments: { name: 'NonexistentDrive', forward: true },
    }));

    const result = JSON.parse(sent[0]);
    expect(result.error).toBeUndefined();
    const payload = JSON.parse(result.result);
    expect(payload.error).toContain('not found');
  });

  it('returns error when signal not found (web_signal_set_bool)', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 12,
      tool: 'web_signal_set_bool',
      arguments: { name: 'NonexistentSignal', value: true },
    }));

    const result = JSON.parse(sent[0]);
    const payload = JSON.parse(result.result);
    expect(payload.error).toContain('not found');
  });

  it('does not crash on malformed JSON', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    // Should not throw
    await expect(handleMessage('not valid json {{')).resolves.toBeUndefined();
    // No result sent (no id to respond to)
    expect(sent).toHaveLength(0);
  });

  it('does not crash on missing type field', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await expect(handleMessage(JSON.stringify({ id: 20 }))).resolves.toBeUndefined();
    // Message without type='call' is ignored
    expect(sent).toHaveLength(0);
  });

  it('does not crash on missing id field', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await expect(handleMessage(JSON.stringify({
      type: 'call',
      tool: 'web_status',
      arguments: {},
    }))).resolves.toBeUndefined();

    // Should still produce a result (id will be undefined)
    expect(sent).toHaveLength(1);
    const result = JSON.parse(sent[0]);
    expect(result.type).toBe('result');
  });

  it('does not crash on missing arguments field', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await expect(handleMessage(JSON.stringify({
      type: 'call',
      id: 25,
      tool: 'web_status',
    }))).resolves.toBeUndefined();

    expect(sent).toHaveLength(1);
    const result = JSON.parse(sent[0]);
    expect(result.type).toBe('result');
    expect(result.id).toBe(25);
  });

  it('returns error when dispatcher is null', async () => {
    const plugin = new McpBridgePlugin();
    // Do NOT set up dispatcher — leave it null
    const sent: string[] = [];
    const fakeWs = {
      readyState: 1,
      send: (data: string) => { sent.push(data); },
      close: vi.fn(),
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    (plugin as unknown as { _ws: typeof fakeWs })._ws = fakeWs;

    const handleMessage = (plugin as unknown as { _handleMessage: (raw: string) => Promise<void> })._handleMessage.bind(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 30,
      tool: 'web_status',
      arguments: {},
    }));

    const result = JSON.parse(sent[0]);
    expect(result.error).toContain('Dispatcher not ready');
  });
});

describe('McpBridgePlugin - Transport and Logic tools', () => {
  it('web_transport_status returns transport data', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 40,
      tool: 'web_transport_status',
      arguments: {},
    }));

    const result = JSON.parse(sent[0]);
    const payload = JSON.parse(result.result);
    expect(payload.totalSpawned).toBe(5);
    expect(payload.totalConsumed).toBe(3);
    expect(payload.activeMUs).toBe(0);
  });

  it('web_logic_flow returns logic data (empty roots)', async () => {
    const { plugin } = setupPlugin();
    const { handleMessage, sent } = createMessageHandler(plugin);

    await handleMessage(JSON.stringify({
      type: 'call',
      id: 41,
      tool: 'web_logic_flow',
      arguments: {},
    }));

    const result = JSON.parse(sent[0]);
    const payload = JSON.parse(result.result);
    expect(payload.roots).toEqual([]);
    expect(payload.stats).toBeDefined();
  });
});
