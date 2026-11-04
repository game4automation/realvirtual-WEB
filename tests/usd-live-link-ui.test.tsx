// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-637 — USD tool button and status pill: registered in `activity-bar`
 * with its own rule (visible in the editor and planner, hidden in kiosk);
 * without providers only Export / Import are disabled while Sync works; the
 * pill shows only while sync is on, with the rate when live.
 *
 * Phase 7 (impeccable critique): a failing first attempt says why and links
 * the README; OFF always ends in `off` (also from error / needs-token); a
 * missing token keeps the switch on (amber) and connects once the token is
 * committed; keyboard / ARIA; the extension steps as a disclosure; status dot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { evaluateVisibilityRule } from '../src/core/hmi/ui-context-store';
import { modeContext } from '../src/core/rv-mode-manager';
import { importProviderRegistry, type CadImportProvider } from '../src/core/import/rv-import-provider';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';
import { UsdLiveLinkPlugin } from '../src/plugins/usd-live-link/usd-live-link-plugin';
import * as sessionModule from '../src/plugins/usd-live-link/usd-live-link-session';
import { USD_MENU_ID, UsdToolButton, usdStatusDotColor } from '../src/plugins/usd-live-link/UsdToolButton';
import { LiveLinkPill, pillTitle } from '../src/plugins/usd-live-link/LiveLinkPill';
import {
  LIVE_LINK_NOT_REACHABLE_RETRYING,
  LIVE_LINK_TOKEN_MISSING,
  LiveLinkStore,
} from '../src/plugins/usd-live-link/live-link-store';
import { USD_MENU_ANCHOR, describeLiveLink } from '../src/plugins/usd-live-link/UsdToolMenu';
import { ERROR, SUCCESS, WARN } from '../src/core/hmi/shared-sx';
import { USD_LIVE_LINK_SEEN_LIVE_KEY } from '../src/core/hmi/rv-storage-keys';
import type { RVViewer } from '../src/core/rv-viewer';

function setup(token = '') {
  const store = new LiveLinkStore({ port: 8765, token, rateHz: 30 });
  const start = vi.fn();
  const createClient = vi.fn(() => ({ start, stop: vi.fn(), isReady: false }) as never);
  const plugin = new UsdLiveLinkPlugin({ store, sessionModule, createClient });
  const viewer = { getPlugin: (id: string) => (id === 'usd-live-link' ? plugin : undefined) } as unknown as RVViewer;
  return { store, plugin, viewer, start, createClient };
}

async function openMenu() {
  fireEvent.click(screen.getByTestId('usd-tool-button'));
  return screen.findByTestId('usd-menu');
}

function clickPill() {
  const pill = screen.getByTestId('usd-live-link-pill');
  act(() => { fireEvent.click(pill.querySelector('button') ?? pill); });
}

function renderInTheme(node: React.ReactNode) {
  return render(<ThemeProvider theme={rvDarkTheme}>{node}</ThemeProvider>);
}

afterEach(() => {
  cleanup();
  try { localStorage.removeItem(USD_LIVE_LINK_SEEN_LIVE_KEY); } catch { /* none */ }
  importProviderRegistry.unregister('usd');
  resetActiveDocumentViewForTests();
});

describe('usd-live-link UI', () => {
  it('registers the button in the activity bar (main menu) with a rule that keeps it in editor and planner', () => {
    const { plugin } = setup();
    expect(plugin.slots.find((s) => s.slot === 'button-group')).toBeUndefined();
    const entry = plugin.slots.find((s) => s.slot === 'activity-bar');
    expect(entry?.component).toBe(UsdToolButton);
    expect(entry?.placement).toBe('bottom');
    const rule = entry!.visibilityRule!;
    expect(rule).toBeDefined();
    for (const mode of ['editor', 'planner', 'hmi', 'des', 'viewer', 'commissioning']) {
      expect(evaluateVisibilityRule(rule, new Set([modeContext(mode)]))).toBe(true);
    }
    expect(evaluateVisibilityRule(rule, new Set(['kiosk']))).toBe(false);
    expect(plugin.slots.find((s) => s.slot === 'toolbar-status')?.component).toBe(LiveLinkPill);
  });

  it('without providers only Export / Import are disabled; Sync is usable', async () => {
    const { viewer, plugin } = setup('tok');
    renderInTheme(<UsdToolButton viewer={viewer} />);
    expect(screen.queryByTestId('usd-menu')).toBeNull(); // not loaded before the first click
    fireEvent.click(screen.getByTestId('usd-tool-button'));
    // The menu is a lazy chunk (entry budget): it appears after its import.
    expect((await screen.findByTestId('usd-menu-export')).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('usd-menu-import').getAttribute('aria-disabled')).toBe('true');
    const sync = screen.getByTestId('usd-menu-sync') as HTMLInputElement;
    expect(sync.disabled).toBe(false);
    act(() => { fireEvent.click(sync); });
    expect(plugin.syncEnabled).toBe(true);
    expect(screen.getByTestId('usd-menu-status').textContent).toContain('Connecting');
  });

  it('enables Export / Import when the providers exist', async () => {
    const { viewer } = setup();
    importProviderRegistry.register({ id: 'usd', label: 'USD' } as unknown as CadImportProvider);
    setActiveDocumentView({
      sourceMode: 'hmi',
      actions: { exports: [{ id: 'usd', label: 'Export USD…', modes: () => [], run: vi.fn() }] },
    } as unknown as ActiveDocumentView);
    renderInTheme(<UsdToolButton viewer={viewer} />);
    fireEvent.click(screen.getByTestId('usd-tool-button'));
    expect((await screen.findByTestId('usd-menu-export')).getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.getByTestId('usd-menu-import').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('missing token: the switch stays on (amber), the settings open with the token field focused, a commit connects', async () => {
    const { viewer, plugin, store, start } = setup('');
    renderInTheme(<><UsdToolButton viewer={viewer} /><LiveLinkPill viewer={viewer} /></>);
    await openMenu();
    const sync = screen.getByTestId('usd-menu-sync') as HTMLInputElement;
    act(() => { fireEvent.click(sync); });
    expect(store.state.status).toBe('needs-token');
    expect(plugin.syncEnabled).toBe(true);
    expect(sync.checked).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByTestId('usd-menu-status').textContent).toContain('access token');
    expect(describeLiveLink(store.state, true).color).toBe(WARN); // amber, not red
    expect(screen.getByTestId('usd-menu-troubleshooting')).toBeTruthy();
    expect(screen.getByTestId('usd-menu-settings-toggle').getAttribute('aria-expanded')).toBe('true');
    const token = screen.getByTestId('usd-menu-token') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(token));
    expect(screen.getByTestId('usd-live-link-pill').textContent).toContain('token needed');
    // An empty commit changes nothing.
    act(() => { fireEvent.blur(token); });
    expect(store.state.status).toBe('needs-token');
    // Enter commits (a user gesture): the link connects, the token message is gone.
    fireEvent.change(token, { target: { value: ' tok ' } });
    act(() => { fireEvent.keyDown(token, { key: 'Enter' }); });
    expect(store.settings.token).toBe('tok');
    expect(start).toHaveBeenCalledTimes(1);
    expect(store.state.status).toBe('connecting');
    expect(screen.getByTestId('usd-menu-status').textContent).not.toContain(LIVE_LINK_TOKEN_MISSING);
    // The settings do not fold away on their own.
    expect(screen.getByTestId('usd-menu-settings-toggle').getAttribute('aria-expanded')).toBe('true');
    // The blur that follows does not start a second connection.
    act(() => { fireEvent.blur(token); });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('retrying: from the 2nd attempt the status says why and links the README; the first attempt says Connecting…', async () => {
    const { viewer, store } = setup('tok');
    act(() => { store.set({ status: 'connecting', attempt: 1, message: 'Connecting to ws://127.0.0.1:8765' }); });
    renderInTheme(<UsdToolButton viewer={viewer} />);
    await openMenu();
    const status = screen.getByTestId('usd-menu-status');
    expect(status.textContent).toContain('Connecting…');
    expect(screen.queryByTestId('usd-menu-troubleshooting')).toBeNull();
    act(() => { store.set({ attempt: 2, message: LIVE_LINK_NOT_REACHABLE_RETRYING }); });
    expect(status.textContent).toContain('Isaac Sim not reachable — retrying… Start it with run_isaac_sim_nvidia_only.bat');
    expect(describeLiveLink(store.state, true).color).toBe(WARN);
    expect(screen.getByTestId('usd-menu-troubleshooting').getAttribute('href')).toMatch(/omniverse-kit\/README\.md$/);
  });

  it('switching off from error or needs-token always ends in off; the pill stops in every state', async () => {
    const { viewer, store, plugin } = setup('');
    renderInTheme(<><UsdToolButton viewer={viewer} /><LiveLinkPill viewer={viewer} /></>);
    // needs-token -> switch off
    act(() => { plugin.setSyncEnabled(true); });
    expect(store.state.status).toBe('needs-token');
    await openMenu();
    act(() => { fireEvent.click(screen.getByTestId('usd-menu-sync')); });
    expect(store.state.status).toBe('off');
    expect(store.state.message).toBeUndefined();
    expect(plugin.syncEnabled).toBe(false);
    expect(screen.queryByTestId('usd-live-link-pill')).toBeNull();
    // error without a session (e.g. a failed chunk load) -> pill click
    act(() => { store.set({ status: 'error', message: 'Isaac Sim refused the access token.' }); });
    clickPill();
    expect(store.state.status).toBe('off');
    expect(store.state.message).toBeUndefined();
    expect(screen.queryByTestId('usd-live-link-pill')).toBeNull();
    // needs-token -> pill click
    act(() => { plugin.setSyncEnabled(true); });
    clickPill();
    expect(store.state.status).toBe('off');
    expect(plugin.syncEnabled).toBe(false);
  });

  it('keyboard + ARIA: Export / Import in a menu list, first item focused, button and switch roles, live status', async () => {
    const { viewer } = setup('tok');
    importProviderRegistry.register({ id: 'usd', label: 'USD' } as unknown as CadImportProvider);
    setActiveDocumentView({
      sourceMode: 'hmi',
      actions: { exports: [{ id: 'usd', label: 'Export USD…', modes: () => [], run: vi.fn() }] },
    } as unknown as ActiveDocumentView);
    renderInTheme(<UsdToolButton viewer={viewer} />);
    const button = screen.getByTestId('usd-tool-button');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await openMenu();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(USD_MENU_ID);
    expect(document.getElementById(USD_MENU_ID)?.getAttribute('role')).toBe('dialog');
    const exportItem = screen.getByTestId('usd-menu-export');
    const importItem = screen.getByTestId('usd-menu-import');
    expect(exportItem.getAttribute('role')).toBe('menuitem');
    expect(exportItem.closest('[role="menu"]')).toBe(importItem.closest('[role="menu"]'));
    await waitFor(() => expect(document.activeElement).toBe(exportItem));
    fireEvent.keyDown(exportItem, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(importItem);
    expect(screen.getByTestId('usd-menu-sync').getAttribute('role')).toBe('switch');
    const status = screen.getByTestId('usd-menu-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('without file providers the switch is the first focused element', async () => {
    const { viewer } = setup('tok');
    renderInTheme(<UsdToolButton viewer={viewer} />);
    await openMenu();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('usd-menu-sync')));
  });

  it('popover is anchored at the bottom (grows upward, no jump)', () => {
    expect(USD_MENU_ANCHOR.anchorOrigin.vertical).toBe('bottom');
    expect(USD_MENU_ANCHOR.transformOrigin.vertical).toBe('bottom');
  });

  it('extension steps: open before the first live on this device, collapsed afterwards, open again for an outdated extension', async () => {
    const { viewer, store } = setup('tok');
    const r1 = renderInTheme(<UsdToolButton viewer={viewer} />);
    await openMenu();
    expect(screen.getByTestId('usd-menu-extension-disclosure').getAttribute('data-open')).toBe('true');
    r1.unmount();
    act(() => { store.set({ status: 'live', sentHz: 30 }); }); // remembers the first live
    expect(localStorage.getItem(USD_LIVE_LINK_SEEN_LIVE_KEY)).toBe('1');
    renderInTheme(<UsdToolButton viewer={viewer} />);
    await openMenu();
    expect(screen.getByTestId('usd-menu-extension-disclosure').getAttribute('data-open')).toBe('false');
    expect(screen.queryByTestId('usd-menu-extension-download')).toBeNull();
    act(() => { store.set({ extensionNotice: 'Isaac Sim extension outdated (v0.1.0) — download v0.2.0' }); });
    expect(screen.getByTestId('usd-menu-extension-disclosure').getAttribute('data-open')).toBe('true');
  });

  it('status dot on the button: none while off, amber waiting, green live, red error', () => {
    const { viewer, store } = setup('tok');
    renderInTheme(<UsdToolButton viewer={viewer} />);
    expect(screen.queryByTestId('usd-status-dot')).toBeNull();
    act(() => { store.set({ status: 'connecting' }); });
    expect(screen.getByTestId('usd-status-dot').getAttribute('data-color')).toBe(WARN);
    expect(usdStatusDotColor({ ...store.state, status: 'needs-token' })).toBe(WARN);
    act(() => { store.set({ status: 'live' }); });
    expect(screen.getByTestId('usd-status-dot').getAttribute('data-color')).toBe(SUCCESS);
    act(() => { store.set({ status: 'error' }); });
    expect(screen.getByTestId('usd-status-dot').getAttribute('data-color')).toBe(ERROR);
    // The icon is primary only while the menu is open, not because the link is live.
    expect(screen.getByTestId('usd-tool-button').className).not.toMatch(/colorPrimary/);
  });

  it('pill tooltip: one full stop between parts, also after a message that ends in one', () => {
    const { store } = setup('tok');
    act(() => { store.set({ status: 'error', message: 'Isaac Sim refused the access token.' }); });
    expect(pillTitle(store.state)).toBe('USD live link to Isaac Sim — Isaac Sim refused the access token. Click to stop syncing.');
    act(() => { store.set({ extensionNotice: 'Isaac Sim extension outdated (v0.1.0) — download v0.2.0.' }); });
    expect(pillTitle(store.state)).not.toMatch(/\.\./);
  });

  it('menu: extension download with version and the three install steps', async () => {
    const { viewer } = setup('tok');
    renderInTheme(<UsdToolButton viewer={viewer} />);
    fireEvent.click(screen.getByTestId('usd-tool-button'));
    const link = await screen.findByTestId('usd-menu-extension-download');
    expect(link.querySelector('[data-testid="ExtensionIcon"]')).toBeTruthy(); // not a second download icon
    // vitest runs vite.config.ts, whose plugin defines __RV_LIVESYNC_EXT__ from extension.toml.
    expect(link.textContent).toContain('Download extension (v0.2.1)');
    expect(link.getAttribute('href')).toMatch(/downloads\/realvirtual-livesync-0\.2\.1\.zip$/);
    const steps = screen.getByTestId('usd-menu-extension').querySelectorAll('li');
    expect(steps).toHaveLength(3);
    expect(steps[1].textContent).toContain('run_isaac_sim_nvidia_only.bat');
    expect(screen.queryByTestId('usd-menu-extension-notice')).toBeNull();
  });

  it('menu + pill: an outdated extension shows the hint with the download link', async () => {
    const { viewer, store } = setup('tok');
    act(() => { store.set({ status: 'live', sentHz: 30, extensionNotice: 'Isaac Sim extension outdated (v0.1.0) — download v0.2.0' }); });
    renderInTheme(<><UsdToolButton viewer={viewer} /><LiveLinkPill viewer={viewer} /></>);
    fireEvent.click(screen.getByTestId('usd-tool-button'));
    const notice = await screen.findByTestId('usd-menu-extension-notice');
    expect(notice.textContent).toBe('Isaac Sim extension outdated (v0.1.0) — download v0.2.0');
    expect(notice.querySelector('a')?.getAttribute('href')).toMatch(/realvirtual-livesync-0\.2\.1\.zip$/);
    expect(screen.getByTestId('usd-live-link-pill')).toBeTruthy();
    expect(pillTitle(store.state)).toBe(
      'USD live link to Isaac Sim. Isaac Sim extension outdated (v0.1.0) — download v0.2.0. Click to stop syncing.',
    );
  });

  it('pill: hidden while off, shows the rate when live', () => {
    const { viewer, store } = setup('tok');
    const { container } = renderInTheme(<LiveLinkPill viewer={viewer} />);
    expect(container.querySelector('[data-testid="usd-live-link-pill"]')).toBeNull();
    act(() => { store.set({ status: 'live', sentHz: 30 }); });
    expect(screen.getByTestId('usd-live-link-pill').textContent).toContain('30 Hz');
    act(() => { store.set({ status: 'off' }); });
    expect(container.querySelector('[data-testid="usd-live-link-pill"]')).toBeNull();
  });
});
