// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-bridge-ai-gate.test.ts — plan-668: the `/webviewer` channel is separate
 * from the AI switch, and the AI switch gates every AI call in the tab.
 *
 * §9.1 channel lifetime (REAL plugin through init(), fake socket):
 * - a CONNECT-served page opens the channel with AI off and keeps it;
 * - a hosted page with AI off never opens one (one same-origin probe, no localhost);
 * - a dev page opens it once its own origin answers with CONNECT's signature;
 * - acquireChannel / releaseChannel open and close it on a page without CONNECT;
 * - toggling AI never reconnects the socket;
 * - close 1008 and onDestroy still stop the channel for good.
 *
 * §9.2 gate (security):
 * - AI off: `discover.tools` is empty, `viewer_status.ai === false`;
 * - AI off: web_status, web_ping, a removed tool name and an unknown
 *   name are all refused with `AI_DISABLED:` — the tool body never runs;
 * - AI off: a registered INTERNAL tool still answers;
 * - on → full discover (count = mcpToolCount), off → empty again; a call that
 *   started before switching off ends normally, the next one is refused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpBridgePlugin, AI_DISABLED_PREFIX } from '../src/plugins/mcp-bridge-plugin';
import { installFakeWebSocket, type FakeWebSocketInstall, type FakeWebSocket } from './helpers/fake-websocket';

interface PageContext {
  protocol: string; host: string; origin: string;
  isDevServer: boolean; markerCookie: boolean; isLoopbackPage: boolean;
}

/** CONNECT served this page itself (marker cookie). */
const CONNECT_SERVED: PageContext = {
  protocol: 'http:', host: 'localhost:5100', origin: 'http://localhost:5100',
  isDevServer: false, markerCookie: true, isLoopbackPage: true,
};
/** The demo on the CDN: not CONNECT, not loopback, a production build. */
const HOSTED: PageContext = {
  protocol: 'https:', host: 'web.realvirtual.io', origin: 'https://web.realvirtual.io',
  isDevServer: false, markerCookie: false, isLoopbackPage: false,
};
/** A dev page (CONNECT's dev proxy sets no marker cookie). */
const DEV: PageContext = {
  protocol: 'http:', host: 'localhost:5200', origin: 'http://localhost:5200',
  isDevServer: true, markerCookie: false, isLoopbackPage: true,
};

const STATUS = {
  type: 'status',
  status: {
    pid: 7, port: 5100, uptimeMs: 1, clientName: null, clientVersion: null,
    clientConnected: false, lastRequestAgoMs: null,
  },
};

type Internals = {
  _pageContext: () => PageContext;
  _isPageVisible: () => boolean;
  _dispatcher: Map<string, unknown> | null;
  onDestroy: () => void;
  onDeactivate: () => void;
  onActivate: () => void;
};

interface ResultFrame { type: 'result'; id: number; result?: string; error?: string }
interface DiscoverFrame { type: 'discover'; tools: { name: string }[]; instructions: string; ai?: boolean }

let ws: FakeWebSocketInstall;
const plugins: McpBridgePlugin[] = [];

function fakeResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

function stubFetch(respond: (url: string) => Response): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return respond(url); }));
  return urls;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Stand the REAL plugin up through init(), as the viewer does. */
function start(page: PageContext, ai: boolean): McpBridgePlugin {
  window.history.replaceState(null, '', '/');
  localStorage.setItem('rv-ai-bridge', JSON.stringify({ enabled: ai, port: '5100' }));
  const plugin = new McpBridgePlugin();
  const p = plugin as unknown as Internals;
  vi.spyOn(p, '_pageContext').mockReturnValue(page);
  vi.spyOn(p, '_isPageVisible').mockReturnValue(true);
  plugin.init({ emit: vi.fn(), on: vi.fn(() => () => {}) } as never);
  plugins.push(plugin);
  return plugin;
}

function ofType<T>(socket: FakeWebSocket, type: string): T[] {
  return socket.sent.filter((f) => (f as { type?: string }).type === type) as T[];
}

async function call(socket: FakeWebSocket, id: number, tool: string, args: Record<string, unknown> = {}): Promise<ResultFrame> {
  socket.message({ type: 'call', id, tool, arguments: args });
  // An AI-on call loads the command/choreography modules lazily on first use — give it time.
  await vi.waitFor(() => expect(ofType<ResultFrame>(socket, 'result').some((r) => r.id === id)).toBe(true), { timeout: 15_000 });
  return ofType<ResultFrame>(socket, 'result').find((r) => r.id === id)!;
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── §9.1 channel lifetime ──

describe('McpBridgePlugin channel vs AI switch (plan-668 §9.1)', () => {
  it('opens the channel on a CONNECT-served page with AI off', async () => {
    const plugin = start(CONNECT_SERVED, false);
    expect(ws.last.url).toMatch(/\/webviewer$/);
    ws.last.open();
    ws.last.message(STATUS);
    expect(plugin.getSnapshot()).toMatchObject({
      connected: true, aiEnabled: false, enabled: false, channelReason: 'connect-origin', toolCount: 0,
    });
    expect(plugin.channelConnected).toBe(true);
  });

  it('does not open a channel on a hosted page with AI off (one same-origin probe only)', async () => {
    const urls = stubFetch(() => fakeResponse(404, 'x', 'text/plain'));
    const plugin = start(HOSTED, false);
    await flush();
    expect(ws.instances).toHaveLength(0);
    expect(urls).toEqual(['https://web.realvirtual.io/health']);
    expect(plugin.getSnapshot().channelReason).toBe('none');
  });

  it('a dev page opens the channel with AI off once its own origin answers as CONNECT', async () => {
    stubFetch(() => fakeResponse(200, { status: 'ok', version: '1.0.0' }));
    const plugin = start(DEV, false);
    await flush();
    expect(ws.instances).toHaveLength(1);
    expect(ws.last.url).toBe('ws://localhost:5200/webviewer');
    expect(plugin.getSnapshot().channelReason).toBe('connect-origin');
  });

  it('a bare dev page (no CONNECT behind it) stays without a channel while AI is off', async () => {
    stubFetch(() => fakeResponse(404, 'x', 'text/plain'));
    start(DEV, false);
    await flush();
    expect(ws.instances).toHaveLength(0);
  });

  it('acquireChannel opens it on a page without CONNECT, releaseChannel closes it', async () => {
    stubFetch(() => fakeResponse(404, 'x', 'text/plain'));
    const plugin = start(HOSTED, false);
    await flush();
    expect(ws.instances).toHaveLength(0);

    plugin.acquireChannel('solidcraft');
    await flush();
    expect(ws.instances).toHaveLength(1);
    expect(ws.last.url).toBe('ws://localhost:5100/webviewer');
    expect(plugin.getSnapshot()).toMatchObject({ channelReason: 'acquired', aiEnabled: false });
    // A second acquire of the same holder is a no-op.
    plugin.acquireChannel('solidcraft');
    await flush();
    expect(ws.instances).toHaveLength(1);

    const socket = ws.last;
    socket.open();
    plugin.releaseChannel('solidcraft');
    expect(socket.close).toHaveBeenCalled();
    expect(plugin.getSnapshot()).toMatchObject({ connected: false, channelReason: 'none' });
    // Releasing again is idempotent and opens nothing.
    plugin.releaseChannel('solidcraft');
    await flush();
    expect(ws.instances).toHaveLength(1);
  });

  it('a holder keeps the channel when AI is switched off on a page without CONNECT', async () => {
    stubFetch(() => fakeResponse(404, 'x', 'text/plain'));
    const plugin = start(HOSTED, true);
    await flush();
    const socket = ws.last;
    socket.open();
    plugin.acquireChannel('solidcraft');
    plugin.setEnabled(false);
    expect(socket.close).not.toHaveBeenCalled();
    plugin.releaseChannel('solidcraft');
    expect(socket.close).toHaveBeenCalled();
  });

  it('setEnabled toggles AI without reconnecting the socket', () => {
    const plugin = start(CONNECT_SERVED, false);
    const socket = ws.last;
    socket.open();
    socket.message(STATUS);

    plugin.setEnabled(true);
    plugin.setEnabled(false);
    plugin.setEnabled(true);

    expect(ws.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    const discovers = ofType<DiscoverFrame>(socket, 'discover');
    expect(discovers.map((d) => d.ai)).toEqual([false, true, false, true]);
    expect(plugin.getSnapshot()).toMatchObject({ connected: true, aiEnabled: true });
  });

  it('close 1008 stops the channel for good; onDestroy closes it', () => {
    vi.useFakeTimers();
    const plugin = start(CONNECT_SERVED, false);
    ws.last.open();
    ws.last.serverClose(1008, 'Another WebViewer tab took ownership.');
    vi.advanceTimersByTime(60_000);
    expect(ws.instances).toHaveLength(1);
    // Neither switching AI nor holding the channel reopens a stopped channel.
    plugin.setEnabled(true);
    plugin.acquireChannel('solidcraft');
    vi.advanceTimersByTime(60_000);
    expect(ws.instances).toHaveLength(1);

    const second = start(CONNECT_SERVED, false);
    const socket = ws.last;
    socket.open();
    (second as unknown as Internals).onDestroy();
    expect(socket.close).toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(ws.instances).toHaveLength(2);
  });

  it('deactivate closes the channel, activate reopens it — with AI off on a CONNECT page', () => {
    const plugin = start(CONNECT_SERVED, false);
    const first = ws.last;
    first.open();
    const p = plugin as unknown as Internals;
    p.onDeactivate();
    expect(first.close).toHaveBeenCalled();
    p.onActivate();
    expect(ws.instances).toHaveLength(2);
    expect(plugin.aiEnabled).toBe(false);
  });

  it('does not persist AI on through reconnect()', () => {
    const plugin = start(CONNECT_SERVED, false);
    plugin.reconnect();
    expect(JSON.parse(localStorage.getItem('rv-ai-bridge') ?? '{}').enabled).toBe(false);
    expect(plugin.aiEnabled).toBe(false);
  });
});

// ── §9.2 gate ──

describe('McpBridgePlugin AI gate (plan-668 §9.2, security)', () => {
  it('AI off: discover announces no tools, no instructions; viewer_status carries ai:false', () => {
    const plugin = start(CONNECT_SERVED, false);
    ws.last.open();
    const discover = ofType<DiscoverFrame>(ws.last, 'discover');
    expect(discover).toHaveLength(1);
    expect(discover[0]).toMatchObject({ tools: [], instructions: '', ai: false });
    expect(ofType<{ ai?: boolean }>(ws.last, 'viewer_status')[0].ai).toBe(false);
    expect(plugin.mcpToolCount).toBe(0);
    expect(plugin.mcpToolNames).toEqual([]);
  });

  it.each([
    ['web_status'],
    ['web_ping'],
    ['web_editor_to_ground'], // a removed tool name, also refused with AI off
    ['web_unknown_tool'],
  ])('AI off: %s is refused with AI_DISABLED and the tool body never runs', async (tool) => {
    const plugin = start(CONNECT_SERVED, false);
    const statusSpy = vi.spyOn(plugin, 'webStatus');
    ws.last.open();
    const frame = await call(ws.last, 1, tool);
    expect(frame.result).toBeUndefined();
    expect(frame.error?.startsWith(AI_DISABLED_PREFIX)).toBe(true);
    expect(statusSpy).not.toHaveBeenCalled();
    expect((plugin as unknown as Internals)._dispatcher).toBeNull();
  });

  it('AI off: a registered internal tool still answers', async () => {
    const plugin = start(CONNECT_SERVED, false);
    const seen: unknown[] = [];
    plugin.registerInternalTool('rv_solidcraft_apply', (args) => { seen.push(args); return { applied: 1 }; });
    ws.last.open();
    const frame = await call(ws.last, 3, 'rv_solidcraft_apply', { rev: 2 });
    expect(frame).toEqual({ type: 'result', id: 3, result: '{"applied":1}' });
    expect(seen).toEqual([{ rev: 2 }]);
  });

  it('switching on announces the full catalog, switching off empties it again', async () => {
    const plugin = start(CONNECT_SERVED, false);
    const statusSpy = vi.spyOn(plugin, 'webStatus').mockResolvedValue('{"ok":true}' as never);
    const socket = ws.last;
    socket.open();

    plugin.setEnabled(true);
    const on = ofType<DiscoverFrame>(socket, 'discover').at(-1)!;
    expect(on.ai).toBe(true);
    expect(on.tools.length).toBeGreaterThan(0);
    expect(on.tools.length).toBeLessThanOrEqual(plugin.mcpToolCount);
    expect(on.instructions.length).toBeGreaterThan(0);
    expect(ofType<{ ai?: boolean }>(socket, 'viewer_status').at(-1)!.ai).toBe(true);
    expect((await call(socket, 10, 'web_status')).error).toBeUndefined();
    expect(statusSpy).toHaveBeenCalledTimes(1);

    plugin.setEnabled(false);
    expect(ofType<DiscoverFrame>(socket, 'discover').at(-1)).toMatchObject({ tools: [], ai: false });
    expect(ofType<{ ai?: boolean }>(socket, 'viewer_status').at(-1)!.ai).toBe(false);
    expect(plugin.mcpToolCount).toBe(0);
    expect((await call(socket, 11, 'web_status')).error?.startsWith(AI_DISABLED_PREFIX)).toBe(true);
    expect(statusSpy).toHaveBeenCalledTimes(1);
  });

  it('a call that started before switching off ends normally; the next one is refused', async () => {
    const plugin = start(CONNECT_SERVED, true);
    let release!: (v: string) => void;
    vi.spyOn(plugin, 'webStatus').mockImplementation(
      () => new Promise<string>((r) => { release = r; }) as never,
    );
    const socket = ws.last;
    socket.open();

    socket.message({ type: 'call', id: 20, tool: 'web_status', arguments: {} });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    plugin.setEnabled(false);
    release('{"ok":true}');
    await vi.waitFor(() => expect(ofType<ResultFrame>(socket, 'result').some((r) => r.id === 20)).toBe(true));
    const done = ofType<ResultFrame>(socket, 'result').find((r) => r.id === 20)!;
    expect(done.error).toBeUndefined();
    expect(done.result).toContain('"ok":true');

    expect((await call(socket, 21, 'web_status')).error?.startsWith(AI_DISABLED_PREFIX)).toBe(true);
  });
});
