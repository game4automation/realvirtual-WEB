// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-bridge-viewer-status.test.ts — plan-564 Phase 2: the viewer side of the
 * multi-tab bridge, driven through REAL browser event sequences (fake socket).
 *
 * - `viewer_status` goes out on transport open (after discover) and on every
 *   `visibilitychange`, with the page visibility;
 * - a launcher claim (`?mcpClaim=`) travels once; the claim SESSION CONNECT
 *   answers with is kept in sessionStorage and carried by every later status —
 *   also after a reload of the tab;
 * - the plugin never self-reports a claim;
 * - the status frame's `role` is surfaced (active / standby) and shown in the
 *   panel; a gateway without standby sends no role and the row stays hidden;
 * - an old CONNECT's 1008 kick still stops the reconnect loop; a full bridge
 *   (4431) is a named failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  McpBridgePlugin,
  MCP_CLAIM_SESSION_KEY,
  buildViewerStatusFrame,
  readClaimSession,
} from '../src/plugins/mcp-bridge-plugin';
import { bridgeRoleLabel } from '../src/core/hmi/settings/McpTab';
import { installFakeWebSocket, type FakeWebSocketInstall, type FakeWebSocket } from './helpers/fake-websocket';

interface PageContext {
  protocol: string; host: string; origin: string;
  isDevServer: boolean; markerCookie: boolean; isLoopbackPage: boolean;
}

const LOOPBACK: PageContext = {
  protocol: 'http:', host: 'localhost:5100', origin: 'http://localhost:5100',
  isDevServer: false, markerCookie: true, isLoopbackPage: true,
};

const STATUS = {
  pid: 7, port: 5100, uptimeMs: 1, clientName: null, clientVersion: null,
  clientConnected: false, lastRequestAgoMs: null,
};

type Internals = {
  _pageContext: () => PageContext;
  _isPageVisible: () => boolean;
  onDestroy: () => void;
};

let ws: FakeWebSocketInstall;
let visible = true;

/** Stand the REAL plugin up through init(), as the viewer does. */
function start(search = ''): McpBridgePlugin {
  window.history.replaceState(null, '', `/${search}`);
  localStorage.setItem('rv-ai-bridge', JSON.stringify({ enabled: true, port: '5100' }));
  const plugin = new McpBridgePlugin();
  const p = plugin as unknown as Internals;
  vi.spyOn(p, '_pageContext').mockReturnValue(LOOPBACK);
  vi.spyOn(p, '_isPageVisible').mockImplementation(() => visible);
  plugin.init({ emit: vi.fn(), on: vi.fn(() => () => {}) } as never);
  return plugin;
}

function statusFrames(socket: FakeWebSocket): Record<string, unknown>[] {
  return socket.sent.filter((f) => (f as { type?: string }).type === 'viewer_status') as Record<string, unknown>[];
}

function flipVisibility(next: boolean): void {
  visible = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

const plugins: McpBridgePlugin[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  visible = true;
  ws = installFakeWebSocket();
});

afterEach(() => {
  for (const plugin of plugins.splice(0)) (plugin as unknown as Internals).onDestroy();
  ws.restore();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('viewer_status (plan-564)', () => {
  it('is sent on transport open, right after discover, with the page visibility', () => {
    plugins.push(start());
    ws.last.open();

    const types = ws.last.sentTypes();
    expect(types.indexOf('viewer_status')).toBeGreaterThan(types.indexOf('discover'));
    expect(statusFrames(ws.last)).toEqual([{ type: 'viewer_status', visible: true, seq: 1 }]);
  });

  it('follows visibilitychange, numbered, and never before the socket is open', () => {
    plugins.push(start());
    flipVisibility(false); // CONNECTING — nothing may be sent
    expect(ws.last.sent).toHaveLength(0);

    ws.last.open();
    flipVisibility(true);
    flipVisibility(false);

    expect(statusFrames(ws.last).map((f) => [f.visible, f.seq])).toEqual([
      [false, 1], [true, 2], [false, 3],
    ]);
  });

  it('forwards ?mcpClaim once, then carries the claim session CONNECT handed back', () => {
    plugins.push(start('?mcpClaim=tok-123&consent=decline'));
    ws.last.open();
    expect(statusFrames(ws.last)[0]).toMatchObject({ claimToken: 'tok-123' });
    expect(statusFrames(ws.last)[0]).not.toHaveProperty('claimSession');

    ws.last.message({ type: 'claim', claimId: 'c0abc', secret: 's3cret' });
    expect(readClaimSession()).toEqual({ id: 'c0abc', secret: 's3cret' });

    flipVisibility(false);
    const after = statusFrames(ws.last)[1];
    expect(after).not.toHaveProperty('claimToken');
    expect(after).toMatchObject({ visible: false, claimSession: { id: 'c0abc', secret: 's3cret' } });
  });

  it('a reloaded tab presents its stored session — no token, still claimed (F13)', () => {
    sessionStorage.setItem(MCP_CLAIM_SESSION_KEY, JSON.stringify({ id: 'c0abc', secret: 's3cret' }));
    plugins.push(start()); // the reload: same tab storage, URL without the consumed token
    ws.last.open();

    expect(statusFrames(ws.last)[0]).toEqual({
      type: 'viewer_status', visible: true, seq: 1, claimSession: { id: 'c0abc', secret: 's3cret' },
    });
  });

  it('never self-reports a claim', () => {
    const frame = buildViewerStatusFrame(true, 4, null, null);
    expect(frame).toEqual({ type: 'viewer_status', visible: true, seq: 4 });
    expect(Object.keys(frame)).not.toContain('claimed');
    // A token, when present, wins over a stored session — it starts the NEW claim.
    expect(buildViewerStatusFrame(false, 5, 'tok', { id: 'old', secret: 'x' }))
      .toEqual({ type: 'viewer_status', visible: false, seq: 5, claimToken: 'tok' });
  });

  it('a malformed claim frame is ignored and storage failures never throw', () => {
    plugins.push(start('?mcpClaim=tok-9'));
    ws.last.open();
    ws.last.message({ type: 'claim', claimId: 42 });
    expect(readClaimSession()).toBeNull();
    sessionStorage.setItem(MCP_CLAIM_SESSION_KEY, '{not json');
    expect(readClaimSession()).toBeNull();
  });

  it('stops listening for visibility after destroy', () => {
    const plugin = start();
    ws.last.open();
    (plugin as unknown as Internals).onDestroy();
    const before = ws.last.sent.length;
    flipVisibility(false);
    expect(ws.last.sent).toHaveLength(before);
  });
});

describe('role from the status frame (F9)', () => {
  it('active / standby are surfaced, separately from transport readiness', () => {
    const plugin = start();
    plugins.push(plugin);
    ws.last.open();

    ws.last.message({ type: 'status', status: STATUS, role: 'standby', claimed: false });
    expect(plugin.getSnapshot()).toMatchObject({ connected: true, role: 'standby', claimed: false });
    expect(bridgeRoleLabel(plugin.getSnapshot().role, plugin.getSnapshot().claimed)?.label)
      .toBe('Standby — another tab is in control');

    ws.last.message({ type: 'status', status: STATUS, role: 'active', claimed: true });
    expect(plugin.getSnapshot()).toMatchObject({ connected: true, role: 'active', claimed: true });
    expect(bridgeRoleLabel('active', true)?.label).toBe('Active (agent tab)');
    expect(bridgeRoleLabel('active')?.label).toBe('Active');
  });

  it('a gateway without standby sends no role: the row stays hidden', () => {
    const plugin = start();
    plugins.push(plugin);
    ws.last.open();
    ws.last.message({ type: 'status', status: STATUS });

    expect(plugin.getSnapshot().connected).toBe(true);
    expect(plugin.getSnapshot().role).toBeNull();
    expect(bridgeRoleLabel(plugin.getSnapshot().role)).toBeNull();
  });

  it('the role is dropped with the link', () => {
    const plugin = start();
    plugins.push(plugin);
    ws.last.open();
    ws.last.message({ type: 'status', status: STATUS, role: 'active' });
    ws.last.serverClose(1006);
    expect(plugin.getSnapshot().role).toBeNull();
  });
});

describe('close codes around standby', () => {
  it('4431 bridge-full is a named failure', () => {
    const plugin = start();
    plugins.push(plugin);
    ws.last.open();
    ws.last.serverClose(4431, 'bridge-full');
    expect(plugin.getSnapshot().failure).toBe('bridge-full');
  });

  it('an old CONNECT that still kicks with 1008 stops the reconnect loop (unchanged)', () => {
    const plugin = start();
    plugins.push(plugin);
    ws.last.open();
    ws.last.message({ type: 'status', status: STATUS });
    ws.last.serverClose(1008, 'Another WebViewer tab took ownership.');
    expect(plugin.mcpEnabled).toBe(false);
  });
});
