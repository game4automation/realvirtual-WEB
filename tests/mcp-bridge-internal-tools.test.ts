// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-bridge-internal-tools.test.ts — plan-621 §2.4.2 / §9.6: INTERNAL bridge
 * tools, driven through the REAL plugin on a fake socket.
 *
 * - an internal tool answers a `call` frame by name (string as is, objects as JSON,
 *   a throw as the call's `error`);
 * - it is never announced: absent from `discover`, from `mcpToolNames` and the tool count;
 * - unregistering (also via the returned function) makes the same call `Unknown tool`;
 * - `web_*` names are refused — that namespace is the MCP catalog;
 * - a replaced registration is not removed by the stale unregister function;
 * - `sendControl(action, fields)` is the generic browser → server `control` frame.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { installFakeWebSocket, type FakeWebSocketInstall, type FakeWebSocket } from './helpers/fake-websocket';

interface PageContext {
  protocol: string; host: string; origin: string;
  isDevServer: boolean; markerCookie: boolean; isLoopbackPage: boolean;
}

const LOOPBACK: PageContext = {
  protocol: 'http:', host: 'localhost:5100', origin: 'http://localhost:5100',
  isDevServer: false, markerCookie: true, isLoopbackPage: true,
};

type Internals = {
  _pageContext: () => PageContext;
  _isPageVisible: () => boolean;
  onDestroy: () => void;
};

interface ResultFrame { type: 'result'; id: number; result?: string; error?: string }
interface DiscoverFrame { type: 'discover'; tools: { name: string }[] }

let ws: FakeWebSocketInstall;
const plugins: McpBridgePlugin[] = [];

/** Stand the REAL plugin up through init(), as the viewer does, and open its socket. */
function start(beforeOpen?: (plugin: McpBridgePlugin) => void, ai = true): { plugin: McpBridgePlugin; socket: FakeWebSocket } {
  window.history.replaceState(null, '', '/');
  localStorage.setItem('rv-ai-bridge', JSON.stringify({ enabled: ai, port: '5100' }));
  const plugin = new McpBridgePlugin();
  const p = plugin as unknown as Internals;
  vi.spyOn(p, '_pageContext').mockReturnValue(LOOPBACK);
  vi.spyOn(p, '_isPageVisible').mockReturnValue(true);
  plugin.init({ emit: vi.fn(), on: vi.fn(() => () => {}) } as never);
  plugins.push(plugin);
  beforeOpen?.(plugin);
  ws.last.open();
  return { plugin, socket: ws.last };
}

function results(socket: FakeWebSocket): ResultFrame[] {
  return socket.sent.filter((f) => (f as { type?: string }).type === 'result') as ResultFrame[];
}

async function call(socket: FakeWebSocket, id: number, tool: string, args: Record<string, unknown> = {}): Promise<ResultFrame> {
  socket.message({ type: 'call', id, tool, arguments: args });
  await vi.waitFor(() => expect(results(socket).some((r) => r.id === id)).toBe(true));
  return results(socket).find((r) => r.id === id)!;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  ws = installFakeWebSocket();
});

afterEach(() => {
  for (const plugin of plugins.splice(0)) (plugin as unknown as Internals).onDestroy();
  ws.restore();
  vi.restoreAllMocks();
});

describe('internal bridge tools (plan-621)', () => {
  it('answer a call by name: objects as JSON, strings as is, with the call arguments', async () => {
    const { plugin, socket } = start();
    const seen: Record<string, unknown>[] = [];
    plugin.registerInternalTool('rv_test_apply', (args) => { seen.push(args); return { applied: 3 }; });
    plugin.registerInternalTool('rv_test_text', async () => 'plain');

    expect(await call(socket, 1, 'rv_test_apply', { payload: { rev: 3 } })).toEqual({ type: 'result', id: 1, result: '{"applied":3}' });
    expect(seen).toEqual([{ payload: { rev: 3 } }]);
    expect(await call(socket, 2, 'rv_test_text')).toEqual({ type: 'result', id: 2, result: 'plain' });
  });

  it('a throwing handler becomes the call error', async () => {
    const { plugin, socket } = start();
    plugin.registerInternalTool('rv_test_fail', () => { throw new Error('boom'); });
    const frame = await call(socket, 7, 'rv_test_fail');
    expect(frame.result).toBeUndefined();
    expect(frame.error).toContain('boom');
  });

  it('is never announced: not in discover, not in the tool names', () => {
    // Registered BEFORE the socket opens, so the discover sent on open had the chance to list it.
    const { plugin, socket } = start((p) => { p.registerInternalTool('rv_test_hidden', () => ({})); });

    const discover = socket.sent.find((f) => (f as { type?: string }).type === 'discover') as DiscoverFrame;
    expect(discover.tools.length).toBeGreaterThan(0);
    expect(discover.tools.map((t) => t.name)).not.toContain('rv_test_hidden');
    expect(plugin.mcpToolNames).not.toContain('rv_test_hidden');
    expect(plugin.internalToolNames).toEqual(['rv_test_hidden']);
  });

  it('unregistering makes the call an unknown tool again', async () => {
    const { plugin, socket } = start();
    const off = plugin.registerInternalTool('rv_test_gone', () => 'here');
    expect((await call(socket, 1, 'rv_test_gone')).result).toBe('here');

    off();
    expect(plugin.internalToolNames).toEqual([]);
    expect((await call(socket, 2, 'rv_test_gone')).error).toBe('Unknown tool: rv_test_gone');

    plugin.registerInternalTool('rv_test_gone', () => 'again');
    plugin.unregisterInternalTool('rv_test_gone');
    expect((await call(socket, 3, 'rv_test_gone')).error).toBe('Unknown tool: rv_test_gone');
  });

  it('a stale unregister function does not remove a newer registration', async () => {
    const { plugin, socket } = start();
    const offOld = plugin.registerInternalTool('rv_test_swap', () => 'old');
    plugin.registerInternalTool('rv_test_swap', () => 'new');
    offOld();
    expect((await call(socket, 1, 'rv_test_swap')).result).toBe('new');
  });

  it('sendControl sends a generic control frame with top-level fields; type/action cannot be overridden', () => {
    const { plugin, socket } = start();
    expect(plugin.sendControl('solidcraft.connect', { port: 7879, docGen: 3, design: 'Arm', type: 'x', action: 'y' })).toBe(true);
    expect(plugin.sendControl('solidcraft.disconnect')).toBe(true);
    const controls = socket.sent.filter((f) => (f as { type?: string }).type === 'control');
    expect(controls).toEqual([
      { port: 7879, docGen: 3, design: 'Arm', type: 'control', action: 'solidcraft.connect' },
      { type: 'control', action: 'solidcraft.disconnect' },
    ]);
    expect(plugin.sendControl('')).toBe(false);
  });

  it('sendControl sends nothing while the socket is not open', () => {
    window.history.replaceState(null, '', '/');
    const plugin = new McpBridgePlugin(); // never initialised: no socket at all
    expect(plugin.sendControl('solidcraft.resync')).toBe(false);
  });

  it('refuses web_* names (the MCP catalog namespace)', () => {
    const { plugin } = start();
    expect(() => plugin.registerInternalTool('web_status', () => '')).toThrow(/invalid/);
    expect(() => plugin.registerInternalTool('', () => '')).toThrow(/invalid/);
  });

  it('plan-668: with AI control off an internal tool still answers, a web_* call is refused', async () => {
    const { plugin, socket } = start(undefined, false);
    plugin.registerInternalTool('rv_test_apply', () => ({ applied: 1 }));
    expect(await call(socket, 1, 'rv_test_apply')).toEqual({ type: 'result', id: 1, result: '{"applied":1}' });
    expect((await call(socket, 2, 'web_status')).error).toMatch(/^AI_DISABLED:/);
  });
});
