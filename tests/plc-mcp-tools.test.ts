// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-mcp-tools.test.ts — the four `web_plc_*` MCP tools on McpBridgePlugin.
 *
 * The tools talk to the PLC exclusively through the PUBLIC surface
 * `getPlcControl()` (src/core/plc-control.ts) — no private imports. Validates:
 *  - without a registered PlcControl every tool answers "PLC not available
 *    in this build" (public / customer builds),
 *  - with a (mock) PlcControl: status reports state/scanTimeMs/lastError/watch,
 *    deploy forwards the code and returns diagnostics with error/warning
 *    counts, run/stop delegate and report the resulting state.
 *
 * Pattern: tests/rv-mcp-bridge.test.ts (dispatch via _handleMessage against a
 * fake WebSocket).
 */
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import {
  registerPlcControl,
  type PlcControl,
  type PlcDiagnostic,
  type PlcRunState,
} from '../src/core/plc-control';

// ── Mock PlcControl ──

interface MockPlc extends PlcControl {
  deploy: Mock<PlcControl['deploy']>;
  run: Mock<PlcControl['run']>;
  stop: Mock<PlcControl['stop']>;
  step: Mock<PlcControl['step']>;
  reset: Mock<PlcControl['reset']>;
}

function createMockPlc(overrides: Partial<{
  state: PlcRunState;
  scanTimeMs: number;
  lastError: string | null;
  watch: Map<string, boolean | number>;
  diagnostics: PlcDiagnostic[];
}> = {}): MockPlc {
  const diagnostics = overrides.diagnostics ?? [];
  const plc: MockPlc = {
    state: overrides.state ?? 'stopped',
    scanTimeMs: overrides.scanTimeMs ?? 0.25,
    lastError: overrides.lastError ?? null,
    deploy: vi.fn(async (_code: string) => diagnostics),
    run: vi.fn(async () => { (plc as { state: PlcRunState }).state = 'running'; }),
    stop: vi.fn(() => { (plc as { state: PlcRunState }).state = 'stopped'; }),
    step: vi.fn(),
    reset: vi.fn(async () => {}),
    watch: () => overrides.watch ?? new Map(),
  };
  return plc;
}

// ── Plugin + fake-WS dispatch (rv-mcp-bridge.test.ts pattern) ──

function setupPlugin() {
  const plugin = new McpBridgePlugin();
  // Decorator metadata lives per-prototype, so the tools are spread over five
  // decorated instances (the plugin plus the four delegate-object tool classes
  // it owns). Dispatching over the plugin alone would silently lose every
  // delegated tool. Mirrors mcp-bridge-plugin.ts::_sendDiscover.
  const delegates = plugin as unknown as {
    _viewTools: object; _observeTools: object; _editorTools: object; _helpTool: object;
  };
  (plugin as unknown as { _dispatcher: ReturnType<typeof buildMultiDispatcher> })._dispatcher =
    buildMultiDispatcher([
      plugin,
      delegates._viewTools,
      delegates._observeTools,
      delegates._editorTools,
      delegates._helpTool,
    ]);

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

  const handleMessage = (plugin as unknown as {
    _handleMessage: (raw: string) => Promise<void>;
  })._handleMessage.bind(plugin);

  /** Dispatch one tool call and return the parsed tool payload. */
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    sent.length = 0;
    await handleMessage(JSON.stringify({ type: 'call', id: 1, tool, arguments: args }));
    expect(sent).toHaveLength(1);
    const result = JSON.parse(sent[0]);
    expect(result.type).toBe('result');
    expect(result.error).toBeUndefined();
    return JSON.parse(result.result);
  };

  return { plugin, call };
}

afterEach(() => {
  registerPlcControl(null); // never leak a mock into other suites
});

// ── Tests ──

describe('web_plc_* tools — PLC not available (no registered control)', () => {
  it.each(['web_plc_status', 'web_plc_run', 'web_plc_stop'])(
    '%s answers with a clear not-available error',
    async (tool) => {
      registerPlcControl(null);
      const { call } = setupPlugin();
      const payload = await call(tool);
      expect(payload.error).toBe('PLC not available in this build');
    },
  );

  it('web_plc_deploy answers not-available without calling anything', async () => {
    registerPlcControl(null);
    const { call } = setupPlugin();
    const payload = await call('web_plc_deploy', { code: 'PROGRAM P END_PROGRAM' });
    expect(payload.error).toBe('PLC not available in this build');
  });
});

describe('web_plc_* tools — with a registered PlcControl', () => {
  it('web_plc_status reports state, scan time, lastError and watch values', async () => {
    const plc = createMockPlc({
      state: 'running',
      scanTimeMs: 0.4219,
      lastError: null,
      watch: new Map<string, boolean | number>([
        ['SensorInFeed', true],
        ['tDelay.ET', 1200],
      ]),
    });
    registerPlcControl(plc);
    const { call } = setupPlugin();

    const payload = await call('web_plc_status');
    expect(payload.state).toBe('running');
    expect(payload.scanTimeMs).toBeCloseTo(0.422, 3);
    expect(payload.lastError).toBeNull();
    expect(payload.watch).toEqual({ SensorInFeed: true, 'tDelay.ET': 1200 });
  });

  it('web_plc_status surfaces the error state with lastError', async () => {
    registerPlcControl(createMockPlc({ state: 'error', lastError: 'RangeError: interrupted' }));
    const { call } = setupPlugin();

    const payload = await call('web_plc_status');
    expect(payload.state).toBe('error');
    expect(payload.lastError).toBe('RangeError: interrupted');
  });

  it('web_plc_deploy forwards the code and returns diagnostics + counts', async () => {
    const diagnostics: PlcDiagnostic[] = [
      { severity: 'error', message: 'unexpected token', line: 2, column: 5 },
      { severity: 'warning', message: "VAR_EXTERNAL 'X': signal not found", line: 1, column: 1 },
    ];
    const plc = createMockPlc({ state: 'error', diagnostics });
    registerPlcControl(plc);
    const { call } = setupPlugin();

    const code = 'PROGRAM P x := ; END_PROGRAM';
    const payload = await call('web_plc_deploy', { code });

    expect(plc.deploy).toHaveBeenCalledWith(code);
    expect(payload.errorCount).toBe(1);
    expect(payload.warningCount).toBe(1);
    expect(payload.diagnostics).toEqual(diagnostics);
    expect(payload.state).toBe('error');
  });

  it('web_plc_run delegates to run() and reports the resulting state', async () => {
    const plc = createMockPlc({ state: 'stopped' });
    registerPlcControl(plc);
    const { call } = setupPlugin();

    const payload = await call('web_plc_run');
    expect(plc.run).toHaveBeenCalledTimes(1);
    expect(payload.state).toBe('running');
    expect(payload.lastError).toBeNull();
  });

  it('web_plc_stop delegates to stop() and reports the resulting state', async () => {
    const plc = createMockPlc({ state: 'running' });
    registerPlcControl(plc);
    const { call } = setupPlugin();

    const payload = await call('web_plc_stop');
    expect(plc.stop).toHaveBeenCalledTimes(1);
    expect(payload.state).toBe('stopped');
  });
});
