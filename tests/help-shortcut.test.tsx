// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-370 §9.5 — the F1 route (F2, F6, F9, R7).
 *
 * The harness mirrors App.tsx: the shortcut hook is mounted on the shell, the
 * activity bar is gated by the `activity-bar` visibility rule. Two source-level
 * assertions pin that mirror to the real App, so this file cannot drift into
 * testing a fiction while App.tsx drops the wiring.
 */

import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import appSource from '../src/core/hmi/App.tsx?raw';
import { ActivityBar } from '../src/core/hmi/ActivityBar';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { setAppConfig } from '../src/core/rv-app-config';
import { activateContext, deactivateContext, useUIVisible } from '../src/core/hmi/ui-context-store';
import { useHelpShortcut } from '../src/core/hmi/help-context';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => ({}),
}));

vi.mock('../src/core/hmi/ButtonPanel', () => ({
  ButtonPanel: () => <div />,
  LogoBadge: () => <button type="button" title="About" aria-label="About">realvirtual</button>,
}));

/** Same rule App.tsx declares for the bar — asserted against the source below. */
const ACTIVITY_BAR_RULE = { hiddenIn: ['fpv', 'xr'] };

function AppUnderTest() {
  useHelpShortcut();
  const showActivityBar = useUIVisible('activity-bar', ACTIVITY_BAR_RULE);
  return (
    <>
      {showActivityBar && <ActivityBar />}
      <input aria-label="probe" />
    </>
  );
}

function createViewer() {
  const editorSnapshot = { panelOpen: false, settingsOpen: false };
  const editorPlugin = {
    subscribe: () => () => undefined,
    getSnapshot: () => editorSnapshot,
    togglePanel: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
  return {
    leftPanelManager: new LeftPanelManager(),
    uiRegistry: new UIPluginRegistry(),
    modes: { activeMode: null, subscribe: () => () => undefined, getSnapshot: () => 0 },
    applyVisualSettings: vi.fn(),
    clearModel: vi.fn(),
    renderBackend: 'three',
    hasRenderBackend: () => false,
    onRenderBackendChange: () => () => undefined,
    setRenderBackend: vi.fn(),
    getPlugin: (id: string) => (id === 'rv-extras-editor' ? editorPlugin : null),
    on: () => () => undefined,
  };
}

function renderApp(node: ReactNode = <AppUnderTest />) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={createViewer() as never}>{node}</RVViewerProvider>
    </ThemeProvider>,
  );
}

function pressF1(target: EventTarget = document): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'F1', cancelable: true, bubbles: true });
  target.dispatchEvent(ev);
  return ev;
}

let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setAppConfig({});
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  deactivateContext('kiosk');
  deactivateContext('fpv');
  setAppConfig({});
  vi.restoreAllMocks();
});

describe('F1 shortcut', () => {
  it('opens help and prevents the browser default', () => {
    renderApp();
    const ev = pressF1();
    expect(openSpy).toHaveBeenCalledWith(
      'https://realvirtual.io/doc/web/', '_blank', 'noopener,noreferrer',
    );
    expect(ev.defaultPrevented).toBe(true);
  });

  it('still works when the activity bar is hidden (FPV)', () => {
    activateContext('fpv'); // hides 'activity-bar', NOT 'help'
    renderApp();
    expect(screen.queryByRole('button', { name: /help/i })).toBeNull();
    pressF1();
    expect(openSpy).toHaveBeenCalled();
  });

  // R7 — the binding kiosk decision covers the key, not just the button.
  it('stays silent in kiosk context', () => {
    activateContext('kiosk');
    renderApp();
    expect(screen.queryByRole('button', { name: /help/i })).toBeNull();
    const ev = pressF1();
    expect(openSpy).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false); // no interference where we do not act
  });

  it('does not fire while typing in an input', () => {
    renderApp();
    const input = screen.getByRole('textbox');
    input.focus();
    const ev = pressF1(input);
    expect(openSpy).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('ignores F1 with a modifier held', () => {
    renderApp();
    for (const mod of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'] as const) {
      const ev = new KeyboardEvent('keydown', { key: 'F1', cancelable: true, bubbles: true, [mod]: true });
      document.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('unbinds on unmount', () => {
    const { unmount } = renderApp();
    unmount();
    pressF1();
    expect(openSpy).not.toHaveBeenCalled();
  });

  // F6 on the keyboard path.
  it('honours a configured base URL', () => {
    setAppConfig({ docs: { baseUrl: 'https://kunde.example/hilfe/' } });
    renderApp();
    pressF1();
    expect(openSpy).toHaveBeenCalledWith(
      'https://kunde.example/hilfe/', '_blank', 'noopener,noreferrer',
    );
  });
});

describe('App wiring (source-level)', () => {
  it('mounts the shortcut outside both shells', () => {
    expect(appSource).toContain('<HelpShortcut />');
    expect(appSource).toContain('useHelpShortcut()');
    const appStart = appSource.indexOf('export function App()');
    const minimalStart = appSource.indexOf('function ConnectEmbedMinimalShell()');
    expect(appSource.slice(appStart, minimalStart)).toContain('<HelpShortcut />');
  });

  it('gates the activity bar with the rule this harness mirrors', () => {
    expect(appSource).toContain("useUIVisible('activity-bar', { hiddenIn: ['fpv', 'xr'] })");
  });

  it('lets the CONNECT embed shell offer help', () => {
    expect(appSource).toContain(
      "const CONNECT_EMBED_ACTIVITY_BAR_ALLOWLIST = ['about', 'models', 'plugin:connect', 'help'] as const;",
    );
  });
});
