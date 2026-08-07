// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-366 Phase 6 — the AI Bridge entry is always offered, and the scope
 * consent is asked ONCE, in front of the AI panel's mount.
 *
 * The gate has to hold on three routes: the activity-bar button, the directly
 * reachable Settings ▸ AI tab, and mobile (where that tab is the only entry).
 * These tests drive all three plus the two ways the entry can be denied — an
 * unreachable CONNECT and a deploy whose feature matrix removed the entry.
 */

import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ActivityBar } from '../src/core/hmi/ActivityBar';
import { AiBridgeGate } from '../src/core/hmi/AiBridgeGate';
import { SettingsPanel } from '../src/core/hmi/SettingsPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { AI_BRIDGE_CONSENT_KEY } from '../src/core/hmi/rv-storage-keys';
import {
  AI_BRIDGE_CONSENT_VERSION,
  hasAiBridgeConsent,
  revokeAiBridgeConsent,
} from '../src/core/hmi/ai-consent-store';
import {
  clearRequestedSettingsTab,
  getRequestedSettingsTab,
} from '../src/core/hmi/settings-tab-store';

const layout = vi.hoisted(() => ({ mobile: false }));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => layout.mobile,
}));

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => ({}),
}));

vi.mock('../src/core/hmi/ButtonPanel', () => ({
  ButtonPanel: () => <div />,
  LogoBadge: () => <button type="button" title="About" aria-label="About">realvirtual</button>,
}));

// Only the MOUNTED settings tab pulls its lazy chunk; tab 0 is the default one
// and the AI tab is what these tests switch to, so exactly these two are stubbed.
vi.mock('../src/core/hmi/settings/ModelTab', () => ({
  BackupTab: () => <div data-testid="backup-tab" />,
}));
vi.mock('../src/core/hmi/settings/McpTab', () => ({
  McpTab: () => <div data-testid="mcp-tab" />,
}));

/** CONNECT answers `/health` (reachable) or nothing answers at all. */
function stubGateway(reachable: boolean) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (reachable && url.includes('/health')) {
      return new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Everything else (including the download manifest) is offline — the
    // download links degrade to their static URLs, which is the shipped fallback.
    throw new TypeError('Failed to fetch');
  });
}

function createViewer() {
  const editorSnapshot = { panelOpen: false, settingsOpen: false };
  const editorPlugin = {
    subscribe: () => () => undefined,
    getSnapshot: () => editorSnapshot,
    togglePanel: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
  const mcpBridgePlugin = { getSnapshot: undefined };
  return {
    leftPanelManager: new LeftPanelManager(),
    uiRegistry: new UIPluginRegistry(),
    applyVisualSettings: vi.fn(),
    clearModel: vi.fn(),
    renderBackend: 'three',
    hasRenderBackend: () => false,
    onRenderBackendChange: () => () => undefined,
    setRenderBackend: vi.fn(),
    getPlugin: (id: string) => {
      if (id === 'rv-extras-editor') return editorPlugin;
      if (id === 'mcp-bridge') return mcpBridgePlugin;
      return null;
    },
    on: () => () => undefined,
    editorPlugin,
  };
}

function renderWithViewer(node: ReactNode, viewer: ReturnType<typeof createViewer>) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer as never}>{node}</RVViewerProvider>
    </ThemeProvider>,
  );
}

const aiButton = () => screen.getByRole('button', { name: 'AI Bridge' });

beforeEach(() => {
  layout.mobile = false;
  revokeAiBridgeConsent();
  clearRequestedSettingsTab();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  revokeAiBridgeConsent();
  clearRequestedSettingsTab();
});

describe('AI Bridge entry — activity bar', () => {
  it('shows the button without any CONNECT and answers the click with the download info', async () => {
    stubGateway(false);
    const viewer = createViewer();
    renderWithViewer(<ActivityBar />, viewer);

    // The old `mcp.connected` gate hid this button from everyone who had not
    // set CONNECT up yet — exactly the people the entry exists for.
    expect(aiButton()).toBeInTheDocument();

    fireEvent.click(aiButton());

    const info = await screen.findByTestId('ai-connect-download-info');
    expect(info).toHaveTextContent(/realvirtual CONNECT as their MCP server/);
    expect(screen.getByRole('link', { name: /Download realvirtual CONNECT/ })).toBeInTheDocument();
    // No consent may be recorded by merely bumping into the dead end.
    expect(hasAiBridgeConsent()).toBe(false);
    expect(getRequestedSettingsTab()).toBeNull();
  });

  it('opens the AI settings tab when a CONNECT answers', async () => {
    stubGateway(true);
    const viewer = createViewer();
    renderWithViewer(<ActivityBar />, viewer);

    fireEvent.click(aiButton());

    await waitFor(() => expect(getRequestedSettingsTab()).toBe(5));
    expect(viewer.editorPlugin.setSettingsOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId('ai-connect-download-info')).not.toBeInTheDocument();
  });

  it('stays removed when the feature matrix does not allow the entry', () => {
    stubGateway(true);
    renderWithViewer(<ActivityBar entryAllowlist={['settings']} />, createViewer());

    expect(screen.queryByRole('button', { name: 'AI Bridge' })).not.toBeInTheDocument();
  });

  it('keeps the AI button out of the mobile bar — mobile enters through Settings', () => {
    layout.mobile = true;
    stubGateway(true);
    renderWithViewer(<ActivityBar />, createViewer());

    expect(screen.queryByRole('button', { name: 'AI Bridge' })).not.toBeInTheDocument();
  });
});

describe('AI Bridge consent gate', () => {
  function renderGate() {
    return renderWithViewer(
      <AiBridgeGate><div data-testid="mcp-tab" /></AiBridgeGate>,
      createViewer(),
    );
  }

  it('asks before the AI panel mounts and never mounts it unanswered', () => {
    renderGate();

    expect(screen.getByTestId('ai-consent-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-tab')).not.toBeInTheDocument();
  });

  it('names the real reach — full control, local without config, remote only with a key', () => {
    renderGate();
    const dialog = screen.getByTestId('ai-consent-dialog');

    for (const scope of ['Scene', 'Signals', 'Simulation']) {
      expect(dialog).toHaveTextContent(scope);
    }
    expect(dialog).toHaveTextContent(/On this machine it works without any\s+configuration/);
    expect(dialog).toHaveTextContent(/From another machine it answers only with a valid API key/);
    // The two claims the C# core made false must not reappear.
    expect(dialog.textContent).not.toMatch(/only localhost|localhost only|loopback[- ]only/i);
  });

  it('never asks again once acknowledged', () => {
    const { unmount } = renderGate();

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.getByTestId('mcp-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-consent-dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(AI_BRIDGE_CONSENT_KEY)).toBe(AI_BRIDGE_CONSENT_VERSION);

    unmount();
    renderGate();
    expect(screen.getByTestId('mcp-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-consent-dialog')).not.toBeInTheDocument();
  });

  it('asks again when the acknowledged scope version is older than the current one', () => {
    localStorage.setItem(AI_BRIDGE_CONSENT_KEY, '1900-01');
    renderGate();

    expect(screen.getByTestId('ai-consent-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-tab')).not.toBeInTheDocument();
  });

  it('lets the user step away without agreeing, and offers the way back', async () => {
    renderGate();

    // A modal that can only be left by agreeing would be coercion, not consent.
    // (The dialog fades out, so the removal is awaited rather than asserted.)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => {
      expect(screen.queryByTestId('ai-consent-dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('mcp-tab')).not.toBeInTheDocument();
    expect(hasAiBridgeConsent()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Review access…' }));
    expect(screen.getByTestId('ai-consent-dialog')).toBeInTheDocument();
  });

  it('lands in the McpTab from "Configure…" and asks the panel for the AI tab', () => {
    renderGate();

    fireEvent.click(screen.getByRole('button', { name: 'Configure…' }));

    expect(screen.getByTestId('mcp-tab')).toBeInTheDocument();
    expect(getRequestedSettingsTab()).toBe(5);
    expect(hasAiBridgeConsent()).toBe(true);
  });

  it('survives a storage that throws and holds the answer for the session', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    renderGate();
    expect(screen.getByTestId('ai-consent-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.getByTestId('mcp-tab')).toBeInTheDocument();
    expect(hasAiBridgeConsent()).toBe(true);
  });
});

describe('AI Bridge entry — Settings tab (the only mobile route)', () => {
  it('offers the AI tab on mobile and still gates the panel behind the consent', async () => {
    layout.mobile = true;
    stubGateway(true);
    const viewer = createViewer();
    renderWithViewer(<SettingsPanel onClose={vi.fn()} />, viewer);

    const tab = await screen.findByRole('tab', { name: 'AI' });
    fireEvent.click(tab);

    // Direct route into the tab — the gate must hold here, not in a button.
    expect(await screen.findByTestId('ai-consent-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-tab')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(await screen.findByTestId('mcp-tab')).toBeInTheDocument();
  });
});
