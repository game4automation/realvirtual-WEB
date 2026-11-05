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
import { ActionMenuRow } from '../src/core/hmi/action-group';
import { SlotMenuRow } from '../src/core/hmi/slot-menu-row';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
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
import { LiveLinkPill, pillLabel, pillTitle } from '../src/plugins/usd-live-link/LiveLinkPill';
import {
  LIVE_LINK_NOT_REACHABLE_RETRYING,
  LIVE_LINK_TOKEN_MISSING,
  LiveLinkStore,
} from '../src/plugins/usd-live-link/live-link-store';
import { USD_MENU_ANCHOR, describeLiveLink } from '../src/plugins/usd-live-link/UsdToolMenu';
import { clampRemountMs } from '../src/plugins/usd-live-link/remount-debounce';
import { ERROR, SUCCESS, WARN } from '../src/core/hmi/shared-sx';
import { USD_LIVE_LINK_SEEN_LIVE_KEY } from '../src/core/hmi/rv-storage-keys';
import type { RVViewer } from '../src/core/rv-viewer';

function setup(token = '') {
  const store = new LiveLinkStore({ port: 8765, token, rateHz: 30 });
  const start = vi.fn();
  const createClient = vi.fn(() => ({ start, stop: vi.fn(), isReady: false }) as never);
  const plugin = new UsdLiveLinkPlugin({ store, sessionModule, createClient });
  const uiRegistry = new UIPluginRegistry();
  const viewer = {
    uiRegistry,
    getPlugin: (id: string) => (id === 'usd-live-link' ? plugin : undefined),
  } as unknown as RVViewer;
  return { store, plugin, viewer, start, createClient, uiRegistry };
}

async function openMenu() {
  fireEvent.click(screen.getByTestId('usd-tool-button'));
  return screen.findByTestId('usd-menu');
}

function clickPill() {
  const pill = screen.getByTestId('usd-live-link-pill');
  act(() => { fireEvent.click(pill.querySelector('button') ?? pill); });
}

function renderInTheme(node: React.ReactNode, viewer: RVViewer) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>{node}</RVViewerProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  try { localStorage.removeItem(USD_LIVE_LINK_SEEN_LIVE_KEY); } catch { /* none */ }
  importProviderRegistry.unregister('usd');
  resetActiveDocumentViewForTests();
});

describe('usd-live-link UI', () => {
  it('plan-2251: shows three groups, visible file descriptions and the live sync setup text', async () => {
    const { viewer, uiRegistry } = setup('tok');
    function RecordRow() {
      return <SlotMenuRow label="Record USD animation…" secondary="Capture simulation motion as a USD file" />;
    }
    uiRegistry.register({ id: 'usd-record-test', slots: [{ slot: 'usd-menu', component: RecordRow }] });
    importProviderRegistry.register({ id: 'usd', label: 'USD' } as unknown as CadImportProvider);
    setActiveDocumentView({
      sourceMode: 'hmi',
      actions: { exports: [{
        id: 'usd', label: 'Export USD…', modes: () => [], run: vi.fn(),
        apply: { label: 'Apply USD extras…', preview: vi.fn(), commit: vi.fn() },
      }] },
    } as unknown as ActiveDocumentView);
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    for (const text of [
      'USD files', 'Animation', 'Isaac Sim live sync',
      'Export USD scene…', 'Geometry and realvirtual data as a USD file',
      'Import USD scene…', 'Open a USD file as a new document',
      'Apply realvirtual data from USD…', "Replaces this document's realvirtual data",
      'Record USD animation…',
      'Streams the scene and live motion one-way to Isaac Sim. Creates no file.',
      'Set up Isaac Sim (extension)',
    ]) expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByTestId('usd-menu-export').compareDocumentPosition(screen.getByText('Animation')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Animation').compareDocumentPosition(screen.getByTestId('usd-menu-sync-header')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('plan-2251: the activity bar tooltip includes recording as visible text', async () => {
    const { viewer } = setup();
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    fireEvent.mouseOver(screen.getByTestId('usd-tool-button'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('USD — export, import, record animation, sync to Isaac Sim');
    expect(screen.getByRole('tooltip')).toBeVisible();
  });

  it.each([false, true])('plan-2251: menu Apply explains, chooses a file and previews before committing (data loss: %s)', async (loss) => {
    const { viewer } = setup();
    const preview = vi.fn(async () => ({
      previewToken: 'menu-preview', targetRevision: 'rev-1', matched: 2,
      unmatchedPrims: [], ambiguous: [], extrasLost: loss ? ['Part'] : [], warnings: [], blocked: null,
    }));
    const commit = vi.fn(async () => ({ ok: false, code: 'stale-preview' }));
    setActiveDocumentView({
      sourceMode: 'hmi', actions: { exports: [{
        id: 'usd', label: 'Export USD…', modes: () => [], run: vi.fn(),
        apply: { label: 'Apply USD extras…', preview, commit },
      }] },
    } as unknown as ActiveDocumentView);
    const fileClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
      await openMenu();
      fireEvent.click(screen.getByText('Apply realvirtual data from USD…'));
      const choose = await screen.findByRole('button', { name: 'Choose USD file…' });
      expect(screen.getByText("Choose a USD file to replace this document's realvirtual data. Geometry stays unchanged. You will review matched nodes and any data that would be removed before applying.")).toBeVisible();
      expect(preview).not.toHaveBeenCalled();
      expect(fileClick).not.toHaveBeenCalled();
      expect(screen.getByTestId('usd-tool-button').getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(choose);
      expect(fileClick).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByTestId('document-card-apply-file'), {
        target: { files: [new File([new Uint8Array([1, 2])], 'data.usda')] },
      });
      const apply = await screen.findByRole('button', { name: loss ? 'Apply and remove missing data' : 'Apply data' });
      expect(apply).toBeVisible();
      expect(screen.getByText('Review the realvirtual data matched to this document. Applying replaces its realvirtual data; geometry stays unchanged.')).toBeVisible();
      expect(preview).toHaveBeenCalledWith({ name: 'data.usda', bytes: new Uint8Array([1, 2]) });
      expect(commit).not.toHaveBeenCalled();
      fireEvent.click(apply);
      await waitFor(() => expect(commit).toHaveBeenCalledWith('menu-preview', loss ? { confirmExtrasLost: true } : {}));
    } finally {
      fileClick.mockRestore();
    }
  });

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
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
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

  it('without USD slot entries shows no contributed row or separator', async () => {
    const { viewer } = setup();
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    expect(screen.queryByRole('menu', { name: 'USD actions' })).toBeNull();
    expect(screen.queryByTestId('usd-menu-slot-divider')).toBeNull();
    expect(screen.queryByTestId('usd-test-action')).toBeNull();
  });

  it('renders a registered USD slot row and closes the menu when its icon is clicked', async () => {
    const { viewer, uiRegistry } = setup();
    const onClick = vi.fn();
    function TestRow() {
      return (
        <ActionMenuRow
          label="Test USD action"
          kind="action"
          icon={<span data-testid="usd-test-action-icon">USD</span>}
          onClick={onClick}
          testId="usd-test-action"
        />
      );
    }
    uiRegistry.register({ id: 'usd-test', slots: [{ slot: 'usd-menu', component: TestRow }] });
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    expect(screen.getByTestId('usd-menu-slot-divider')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Test USD action' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('usd-test-action-icon'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('usd-tool-button').getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByTestId('usd-menu')).toBeNull());
  });

  it('reacts to slot registration and removal; a disabled row keeps the menu open', async () => {
    const { viewer, uiRegistry } = setup();
    const onClick = vi.fn();
    function TestRow() {
      return (
        <ActionMenuRow
          label="Test USD action"
          kind="action"
          disabled
          description="Test action is unavailable."
          onClick={onClick}
          testId="usd-test-action"
        />
      );
    }
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    act(() => {
      uiRegistry.register({ id: 'usd-test', slots: [{ slot: 'usd-menu', component: TestRow }] });
    });
    const row = screen.getByTestId('usd-test-action');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('aria-description')).toBe('Test action is unavailable.');
    fireEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByTestId('usd-tool-button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('usd-menu-slot-divider')).toBeTruthy();
    act(() => { uiRegistry.unregister('usd-test'); });
    expect(screen.queryByTestId('usd-test-action')).toBeNull();
    expect(screen.queryByTestId('usd-menu-slot-divider')).toBeNull();
    expect(screen.queryByRole('menu', { name: 'USD actions' })).toBeNull();
  });

  it('shows the slot label and second line as visible text; clicking the text closes the menu', async () => {
    const { viewer, uiRegistry } = setup();
    const onClick = vi.fn();
    function TestRow() {
      return (
        <SlotMenuRow
          label="Test USD action"
          icon={<span>USD</span>}
          secondary="A visible action description."
          onClick={onClick}
          testId="usd-visible-action"
        />
      );
    }
    uiRegistry.register({ id: 'usd-visible-test', slots: [{ slot: 'usd-menu', component: TestRow }] });
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    const row = screen.getByTestId('usd-visible-action');
    expect(row.textContent).toContain('Test USD action');
    expect(row.textContent).toContain('A visible action description.');
    await waitFor(() => {
      expect(screen.getByText('Test USD action')).toBeVisible();
      expect(screen.getByText('A visible action description.')).toBeVisible();
    });
    fireEvent.click(screen.getByText('Test USD action'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('usd-tool-button').getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByTestId('usd-menu')).toBeNull());
  });

  it('shows a disabled slot reason as visible text and keeps the menu open when it is clicked', async () => {
    const { viewer, uiRegistry } = setup();
    const onClick = vi.fn();
    const onMouseEnter = vi.fn();
    function TestRow() {
      return (
        <SlotMenuRow
          label="Test USD action"
          icon={<span>USD</span>}
          secondary="Test action is unavailable."
          disabled
          onClick={onClick}
          attrs={{ onMouseEnter }}
          testId="usd-visible-action"
        />
      );
    }
    uiRegistry.register({ id: 'usd-visible-test', slots: [{ slot: 'usd-menu', component: TestRow }] });
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    const row = screen.getByTestId('usd-visible-action');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(getComputedStyle(row).pointerEvents).not.toBe('none');
    expect(row.textContent).toContain('Test USD action');
    expect(row.textContent).toContain('Test action is unavailable.');
    await waitFor(() => {
      expect(screen.getByText('Test USD action')).toBeVisible();
      expect(screen.getByText('Test action is unavailable.')).toBeVisible();
    });
    fireEvent.mouseEnter(row);
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Test action is unavailable.'));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByTestId('usd-tool-button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('usd-menu')).toBeVisible();
  });

  it('enables Export / Import when the providers exist', async () => {
    const { viewer } = setup();
    importProviderRegistry.register({ id: 'usd', label: 'USD' } as unknown as CadImportProvider);
    setActiveDocumentView({
      sourceMode: 'hmi',
      actions: { exports: [{ id: 'usd', label: 'Export USD…', modes: () => [], run: vi.fn() }] },
    } as unknown as ActiveDocumentView);
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    fireEvent.click(screen.getByTestId('usd-tool-button'));
    expect((await screen.findByTestId('usd-menu-export')).getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.getByTestId('usd-menu-import').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('missing token: the switch stays on (amber), the settings open with the token field focused, a commit connects', async () => {
    const { viewer, plugin, store, start } = setup('');
    renderInTheme(<><UsdToolButton viewer={viewer} /><LiveLinkPill viewer={viewer} /></>, viewer);
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
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
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
    renderInTheme(<><UsdToolButton viewer={viewer} /><LiveLinkPill viewer={viewer} /></>, viewer);
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
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
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

  it('without file providers the sync row is the first focused element', async () => {
    const { viewer } = setup('tok');
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('usd-menu-sync-row')));
  });

  it('popover is anchored at the bottom (grows upward, no jump)', () => {
    expect(USD_MENU_ANCHOR.anchorOrigin.vertical).toBe('bottom');
    expect(USD_MENU_ANCHOR.transformOrigin.vertical).toBe('bottom');
  });

  it('extension steps: open before the first live on this device, collapsed afterwards, open again for an outdated extension', async () => {
    const { viewer, store } = setup('tok');
    const r1 = renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    expect(screen.getByTestId('usd-menu-extension-disclosure').getAttribute('data-open')).toBe('true');
    r1.unmount();
    act(() => { store.set({ status: 'live', sentHz: 30 }); }); // remembers the first live
    expect(localStorage.getItem(USD_LIVE_LINK_SEEN_LIVE_KEY)).toBe('1');
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    expect(screen.getByTestId('usd-menu-extension-disclosure').getAttribute('data-open')).toBe('false');
    expect(screen.queryByTestId('usd-menu-extension-download')).toBeNull();
    act(() => { store.set({ extensionNotice: 'Isaac Sim extension outdated (v0.1.0) — download v0.2.0' }); });
    expect(screen.getByTestId('usd-menu-extension-disclosure').getAttribute('data-open')).toBe('true');
  });

  it('status dot on the button: none while off, amber waiting, green live, red error', () => {
    const { viewer, store } = setup('tok');
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
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
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    fireEvent.click(screen.getByTestId('usd-tool-button'));
    const link = await screen.findByTestId('usd-menu-extension-download');
    expect(link.querySelector('[data-testid="ExtensionIcon"]')).toBeTruthy(); // not a second download icon
    // vitest runs vite.config.ts, whose plugin defines __RV_LIVESYNC_EXT__ from extension.toml.
    expect(link.textContent).toContain('Download extension (v0.2.1)');
    screen.getByTestId('usd-menu-paper').style.width = '300px';
    const disclosure = screen.getByTestId('usd-menu-extension-disclosure');
    const title = screen.getByText('Set up Isaac Sim (extension)');
    const version = screen.getByText('v0.2.1');
    expect(title).toBeVisible();
    expect(version).toBeVisible();
    expect(getComputedStyle(title).textOverflow).not.toBe('ellipsis');
    expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
    expect(title.clientWidth).toBeGreaterThan(0);
    expect(version.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.getBoundingClientRect().bottom);
    expect(disclosure.getBoundingClientRect().width).toBeLessThanOrEqual(320);
    expect(link.getAttribute('href')).toMatch(/downloads\/realvirtual-livesync-0\.2\.1\.zip$/);
    const steps = screen.getByTestId('usd-menu-extension').querySelectorAll('li');
    expect(steps).toHaveLength(3);
    expect(steps[1].textContent).toContain('run_isaac_sim_nvidia_only.bat');
    expect(screen.queryByTestId('usd-menu-extension-notice')).toBeNull();
  });

  it('menu + pill: an outdated extension shows the hint with the download link', async () => {
    const { viewer, store } = setup('tok');
    act(() => { store.set({ status: 'live', sentHz: 30, extensionNotice: 'Isaac Sim extension outdated (v0.1.0) — download v0.2.0' }); });
    renderInTheme(<><UsdToolButton viewer={viewer} /><LiveLinkPill viewer={viewer} /></>, viewer);
    fireEvent.click(screen.getByTestId('usd-tool-button'));
    const notice = await screen.findByTestId('usd-menu-extension-notice');
    expect(notice.textContent).toBe('Isaac Sim extension outdated (v0.1.0) — download v0.2.0');
    expect(notice.querySelector('a')?.getAttribute('href')).toMatch(/realvirtual-livesync-0\.2\.1\.zip$/);
    expect(screen.getByTestId('usd-live-link-pill')).toBeTruthy();
    expect(pillTitle(store.state)).toBe(
      'USD live link to Isaac Sim. Isaac Sim extension outdated (v0.1.0) — download v0.2.0. Click to stop syncing.',
    );
  });

  it('plan-2239: remounting is amber with the reason; live shows the prim detail; the debounce field clamps', async () => {
    const { viewer, store, plugin } = setup('tok');
    const remounting = { status: 'remounting' as const, message: 'Structure changed (re-parent: Arm) — remounting…' };
    expect(describeLiveLink({ ...store.state, ...remounting }, true)).toEqual({ text: remounting.message, color: WARN });
    expect(usdStatusDotColor({ ...store.state, ...remounting })).toBe(WARN);
    expect(pillLabel({ ...store.state, ...remounting })).toBe('Isaac Sim · remounting');
    act(() => { store.set({ status: 'live', session: 7, sentHz: 30, prims: { total: 1284, withAddress: 1102 } }); });
    renderInTheme(<UsdToolButton viewer={viewer} />, viewer);
    await openMenu();
    expect(screen.getByTestId('usd-menu-mount-detail').textContent).toBe('Session 7 · 1,284 prims (1,102 with address)');
    fireEvent.click(screen.getByTestId('usd-menu-settings-toggle'));
    expect(await screen.findByTestId('usd-menu-remount')).toBeTruthy();
    expect(clampRemountMs(10)).toBe(250);
    expect(clampRemountMs(99_999)).toBe(5000);
    expect(clampRemountMs(undefined)).toBe(750);
    expect(plugin.store.settings.remountDebounceMs).toBeUndefined(); // default until the user sets one
  });

  it('pill: hidden while off, shows the rate when live', () => {
    const { viewer, store } = setup('tok');
    const { container } = renderInTheme(<LiveLinkPill viewer={viewer} />, viewer);
    expect(container.querySelector('[data-testid="usd-live-link-pill"]')).toBeNull();
    act(() => { store.set({ status: 'live', sentHz: 30 }); });
    expect(screen.getByTestId('usd-live-link-pill').textContent).toContain('30 Hz');
    act(() => { store.set({ status: 'off' }); });
    expect(container.querySelector('[data-testid="usd-live-link-pill"]')).toBeNull();
  });
});
