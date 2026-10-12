// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-tab-failure.test.tsx — plan-541 § 9.4: the AI Bridge panel names the
 * real target and, instead of an endless "Reconnecting (N)…", the concrete
 * cause plus what to do about it (texts of plan § 3.1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { McpTab } from '../src/core/hmi/settings/McpTab';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { McpBridgeFailure, McpBridgeSnapshot } from '../src/plugins/mcp-bridge-plugin';
import { aiBridgeTitle } from '../src/core/hmi/ActivityBar';

// Neighbours of the bridge section that talk to CONNECT on their own — not under test here.
vi.mock('../src/core/hmi/settings/RagStatusSection', () => ({ RagStatusSection: () => null }));
vi.mock('../src/core/hmi/ConnectPanel', () => ({ ConnectDownloadLinks: () => null }));

const TARGET = 'ws://localhost:5100/webviewer';

function snapshot(over: Partial<McpBridgeSnapshot>): McpBridgeSnapshot {
  return {
    connected: false, port: '5100', toolCount: 0, toolNames: [], enabled: true,
    reconnectAttempt: 3, reconnectDelay: 4000, serverStatus: null,
    target: TARGET, failure: 'none',
    ...over,
  };
}

function renderTab(snap: McpBridgeSnapshot) {
  const plugin = {
    getSnapshot: () => snap, serverLog: [],
    reconnect: vi.fn(), setEnabled: vi.fn(), setPort: vi.fn(),
    shutdownServer: vi.fn(), pauseServer: vi.fn(), resumeServer: vi.fn(),
  };
  const viewer = {
    getPlugin: (id: string) => (id === 'mcp-bridge' ? plugin : null),
    on: () => () => undefined,
  };
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer as never}><McpTab /></RVViewerProvider>
    </ThemeProvider>,
  );
}

afterEach(() => { cleanup(); });

/** plan-541 § 3.1, verbatim. */
const TABLE: Array<[Exclude<McpBridgeFailure, 'none'>, string, string]> = [
  ['pairing-pending', 'Waiting for approval', 'Confirm in the CONNECT tray icon.'],
  ['pairing-denied', 'Denied by CONNECT', 'Remove the origin under Tray ▸ MCP server ▸ AI Bridge origins.'],
  ['pairing-cooldown', 'Approval timed out', 'Try again in a few minutes.'],
  ['pairing-unavailable', 'Pairing not available', 'This CONNECT has no tray. Add the origin to AllowedOrigins.'],
  ['origin-not-pairable', 'Origin not allowed', 'Use https or open the viewer via http://localhost:5100.'],
  ['bridge-disabled', 'MCP server off', 'Tray ▸ MCP server ▸ Enabled, then restart CONNECT.'],
  ['connect-outdated', 'CONNECT too old', 'Update CONNECT, or add this origin to AllowedOrigins.'],
  ['unreachable', 'CONNECT not reachable',
    'Is CONNECT running? Allow local network access in the browser. Safari: open http://localhost:5100.'],
  ['browser-blocked', 'Blocked by the browser',
    'This browser does not allow the connection. Use Chrome/Edge or open http://localhost:5100.'],
  ['starting', 'CONNECT is starting', 'Connects automatically.'],
  ['refused', 'Connection refused',
    "Check API key, licence and the browser's local-network permission. Safari: open http://localhost:5100."],
  ['pairing-busy', 'CONNECT is busy', 'Too many approval requests — try again later.'],
];

describe('McpTab — target and failure cause (plan-541)', () => {
  it('shows the real target', () => {
    renderTab(snapshot({}));
    expect(screen.getByText('Target')).toBeInTheDocument();
    expect(screen.getByText(TARGET)).toBeInTheDocument();
  });

  it.each(TABLE)('%s → status "%s" and its hint', (failure, status, hint) => {
    renderTab(snapshot({ failure }));
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(screen.queryByText(/^Reconnecting/)).not.toBeInTheDocument();
  });

  it('pending names the page origin the tray prompt asks about', () => {
    renderTab(snapshot({ failure: 'pairing-pending' }));
    const hint = screen.getByTestId('mcp-failure-hint');
    expect(hint.textContent).toContain(`Allow ${window.location.origin}`);
  });

  it('unreachable adds the AllowedOrigins/CORS and CSP notes and a local link', () => {
    renderTab(snapshot({ failure: 'unreachable' }));
    expect(screen.getByText("If CONNECT restricts AllowedOrigins, add this page's origin.")).toBeInTheDocument();
    expect(screen.getByText('A Content Security Policy (connect-src) on this site may block localhost.'))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'http://localhost:5100' })).toHaveAttribute('href', 'http://localhost:5100');
  });

  it('no cause block while connected', () => {
    renderTab(snapshot({ connected: true, failure: 'none', reconnectAttempt: 0 }));
    expect(screen.queryByTestId('mcp-failure-hint')).not.toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('no cause block while the bridge is off', () => {
    renderTab(snapshot({ enabled: false, failure: 'unreachable' }));
    expect(screen.queryByTestId('mcp-failure-hint')).not.toBeInTheDocument();
  });

  it('without a known cause the reconnect counter stays', () => {
    renderTab(snapshot({ failure: 'none' }));
    expect(screen.getByText('Reconnecting (3)...')).toBeInTheDocument();
  });

  it('setup step 3 explains the hosted case', () => {
    renderTab(snapshot({}));
    expect(screen.getByText(/On a hosted page \(web\.realvirtual\.io\) the bridge connects to localhost/))
      .toBeInTheDocument();
  });
});

describe('ActivityBar tooltip (plan-541)', () => {
  it('names an open approval prompt', () => {
    expect(aiBridgeTitle({ connected: false, enabled: true, toolCount: 0, failure: 'pairing-pending' }, null))
      .toBe('AI Bridge — waiting for approval in the CONNECT tray');
  });

  it('stays "connecting…" for any other cause', () => {
    expect(aiBridgeTitle({ connected: false, enabled: true, toolCount: 0, failure: 'unreachable' }, null))
      .toBe('AI Bridge — connecting…');
  });
});
