// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-bridge-ai-solidcraft.test.tsx — plan-2220 E8: "AI may control SolidCraft" is a property of the AI
 * settings (Settings ▸ AI, default off), persisted with AI control and sent to CONNECT in `viewer_status`
 * — the plan-668 path. CONNECT adds the SolidCraft server of the connected Live Link instance to the AI
 * panel's CLI only while the owner tab says `aiSolidCraft: true`; an absent field means off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { McpBridgePlugin, buildViewerStatusFrame, type McpBridgeSnapshot } from '../src/plugins/mcp-bridge-plugin';
import { McpTab } from '../src/core/hmi/settings/McpTab';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { getBridgeTabKey } from '../src/plugins/mcp-bridge/rv-mcp-tab-key';
import { installFakeWebSocket, type FakeWebSocketInstall, type FakeWebSocket } from './helpers/fake-websocket';

vi.mock('../src/core/hmi/settings/RagStatusSection', () => ({ RagStatusSection: () => null }));
vi.mock('../src/core/hmi/ConnectPanel', () => ({ ConnectDownloadLinks: () => null }));

const LOOPBACK = {
  protocol: 'http:', host: 'localhost:5100', origin: 'http://localhost:5100',
  isDevServer: false, markerCookie: true, isLoopbackPage: true,
};

type Internals = { _pageContext: () => unknown; _isPageVisible: () => boolean; onDestroy: () => void };

let ws: FakeWebSocketInstall;
const plugins: McpBridgePlugin[] = [];

function start(stored: Record<string, unknown>): McpBridgePlugin {
  localStorage.setItem('rv-ai-bridge', JSON.stringify(stored));
  const plugin = new McpBridgePlugin();
  const p = plugin as unknown as Internals;
  vi.spyOn(p, '_pageContext').mockReturnValue(LOOPBACK);
  vi.spyOn(p, '_isPageVisible').mockReturnValue(true);
  plugin.init({ emit: vi.fn(), on: vi.fn(() => () => {}) } as never);
  plugins.push(plugin);
  return plugin;
}

function statusFrames(socket: FakeWebSocket): Record<string, unknown>[] {
  return socket.sent.filter((f) => (f as { type?: string }).type === 'viewer_status') as Record<string, unknown>[];
}

beforeEach(() => {
  localStorage.clear();
  ws = installFakeWebSocket();
});

afterEach(() => {
  for (const plugin of plugins.splice(0)) (plugin as unknown as Internals).onDestroy();
  ws.restore();
  vi.restoreAllMocks();
  cleanup();
});

describe('AI may control SolidCraft — plugin (plan-2220 E8)', () => {
  it('defaults to off: the status frame carries no aiSolidCraft field', () => {
    const plugin = start({ enabled: true, port: '5100' });
    ws.last.open();
    expect(plugin.aiSolidCraft).toBe(false);
    expect(plugin.getSnapshot().aiSolidCraft).toBe(false);
    expect(statusFrames(ws.last)[0]).not.toHaveProperty('aiSolidCraft');
  });

  it('switching it on sends a new viewer_status with aiSolidCraft: true and persists it', () => {
    const plugin = start({ enabled: true, port: '5100' });
    ws.last.open();
    plugin.setAiSolidCraft(true);
    expect(statusFrames(ws.last).at(-1)).toMatchObject({ aiSolidCraft: true, ai: true });
    expect(JSON.parse(localStorage.getItem('rv-ai-bridge')!)).toMatchObject({ aiSolidCraft: true, enabled: true });

    plugin.setAiSolidCraft(false);
    expect(statusFrames(ws.last).at(-1)).not.toHaveProperty('aiSolidCraft'); // absent = off for CONNECT
    expect(JSON.parse(localStorage.getItem('rv-ai-bridge')!)).toMatchObject({ aiSolidCraft: false });
  });

  it('a stored opt-in survives a reload and travels with the first status frame', () => {
    start({ enabled: true, port: '5100', aiSolidCraft: true });
    ws.last.open();
    expect(statusFrames(ws.last)[0]).toMatchObject({ aiSolidCraft: true });
  });

  it('only an explicit true in storage opts in', () => {
    const plugin = start({ enabled: true, port: '5100', aiSolidCraft: 'yes' });
    expect(plugin.aiSolidCraft).toBe(false);
  });

  it('keeps the tab key CONNECT sends in status frames and drops it with the socket (plan-2220)', () => {
    start({ enabled: true, port: '5100' });
    ws.last.open();
    expect(getBridgeTabKey()).toBeNull();
    ws.last.message({ type: 'status', status: {}, role: 'active', tabKey: 'k-owner' });
    expect(getBridgeTabKey()).toBe('k-owner');
    ws.last.message({ type: 'status', status: {}, role: 'standby' }); // a frame without a key clears it
    expect(getBridgeTabKey()).toBeNull();
    ws.last.message({ type: 'status', status: {}, role: 'active', tabKey: 'k-again' });
    ws.last.serverClose(1001, 'bye');
    expect(getBridgeTabKey()).toBeNull();
  });

  it('buildViewerStatusFrame leaves the field out unless given', () => {
    expect(buildViewerStatusFrame(true, 1, null, null, true)).not.toHaveProperty('aiSolidCraft');
    expect(buildViewerStatusFrame(true, 1, null, null, true, true)).toMatchObject({ aiSolidCraft: true });
  });
});

describe('AI may control SolidCraft — Settings ▸ AI switch', () => {
  function renderTab(snap: Partial<McpBridgeSnapshot>) {
    const full: McpBridgeSnapshot = {
      connected: true, port: '5100', toolCount: 0, toolNames: [], enabled: true, aiEnabled: true,
      reconnectAttempt: 0, reconnectDelay: 1000, serverStatus: null, target: 'ws://localhost:5100/webviewer',
      failure: 'none', ...snap,
    };
    const plugin = {
      getSnapshot: () => full, serverLog: [],
      reconnect: vi.fn(), setEnabled: vi.fn(), setAiSolidCraft: vi.fn(), setPort: vi.fn(),
      shutdownServer: vi.fn(), pauseServer: vi.fn(), resumeServer: vi.fn(),
    };
    const viewer = { getPlugin: (id: string) => (id === 'mcp-bridge' ? plugin : null), on: () => () => undefined };
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer as never}><McpTab /></RVViewerProvider>
      </ThemeProvider>,
    );
    return plugin;
  }

  it('shows the switch off by default and switches it through the plugin', () => {
    const plugin = renderTab({});
    const input = screen.getByTestId('ai-solidcraft-switch').querySelector('input')!;
    expect(input.checked).toBe(false);
    fireEvent.click(input);
    expect(plugin.setAiSolidCraft).toHaveBeenCalledWith(true);
    expect(plugin.setEnabled).not.toHaveBeenCalled();
  });

  it('is disabled while AI control is off (E15)', () => {
    const plugin = renderTab({ enabled: false, aiEnabled: false, aiSolidCraft: true });
    const input = screen.getByTestId('ai-solidcraft-switch').querySelector('input')!;
    expect(input.disabled).toBe(true); // a synthetic click would bypass `disabled`; the attribute is the contract
    expect(input.checked).toBe(true);  // the stored opt-in stays visible, it just does not count (CONNECT, E15)
    expect(plugin.setAiSolidCraft).not.toHaveBeenCalled();
  });

  it('reflects a stored opt-in', () => {
    renderTab({ aiSolidCraft: true });
    expect(screen.getByTestId('ai-solidcraft-switch').querySelector('input')!.checked).toBe(true);
  });
});
