// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Settings tabs render in ONE merged order (fixed tabs + plugin slots by `order`). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { SettingsPanel } from '../src/core/hmi/SettingsPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { SETTINGS_LAST_TAB_KEY } from '../src/core/hmi/rv-storage-keys';
import { requestSettingsTab, clearRequestedSettingsTab } from '../src/core/hmi/settings-tab-store';
import { modeManagerDouble } from './fixtures/mode-manager-double';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));
vi.mock('../src/core/hmi/settings/VisualTab', () => ({ VisualTab: () => <div data-testid="visual-tab" /> }));
vi.mock('../src/core/hmi/settings/ModelTab', () => ({ BackupTab: () => <div data-testid="backup-tab" /> }));
vi.mock('../src/core/hmi/settings/McpTab', () => ({ McpTab: () => <div /> }));

const Stub = () => <div />;

afterEach(() => { cleanup(); localStorage.clear(); clearRequestedSettingsTab(); });

function mount(plugins: [string, string, number][]) {
  const uiRegistry = new UIPluginRegistry();
  for (const [id, label, order] of plugins) {
    uiRegistry.register({ id, slots: [{ slot: 'settings-tab', label, component: Stub, order }] });
  }
  const viewer = {
    leftPanelManager: new LeftPanelManager(), uiRegistry, modes: modeManagerDouble(),
    getPlugin: () => null, on: () => () => undefined,
  };
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer as never}><SettingsPanel onClose={vi.fn()} /></RVViewerProvider>
    </ThemeProvider>,
  );
}
const selected = () => screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent;


describe('SettingsPanel tab order', () => {
  it('interleaves plugin tabs by order and opens on the first visible tab', async () => {
    const uiRegistry = new UIPluginRegistry();
    for (const [id, label, order] of [
      ['features', 'Features', 800], ['stereo', 'Stereo 3D', 410],
      ['spacemouse', 'SpaceMouse', 400], ['startview', 'Start View', 110],
    ] as const) {
      uiRegistry.register({ id, slots: [{ slot: 'settings-tab', label, component: Stub, order }] });
    }
    const viewer = {
      leftPanelManager: new LeftPanelManager(), uiRegistry, modes: modeManagerDouble(),
      getPlugin: (id: string) => (id === 'mcp-bridge' || id === 'multiuser' ? {} : null),
      on: () => () => undefined,
    };
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer as never}><SettingsPanel onClose={vi.fn()} /></RVViewerProvider>
      </ThemeProvider>,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(t => t.textContent)).toEqual([
      'Visual', 'Start View', 'Mouse & Touch', 'Simulation', 'Interfaces', 'Multiuser', 'AI',
      'Groups', 'Backup', 'SpaceMouse', 'Stereo 3D', 'Features', 'Dev Tools', 'Help & diagnostics',
    ]);
    // Default = first visible tab (Visual), no longer Backup.
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('visual-tab')).toBeInTheDocument();
  });

  it('reopens on the last selected tab (stable id), falls back when it is gone, request wins', async () => {
    const plugins: [string, string, number][] = [['spacemouse', 'SpaceMouse', 400]];
    const first = mount(plugins);
    expect(selected()).toBe('Visual');
    fireEvent.click(screen.getByRole('tab', { name: 'SpaceMouse' }));
    expect(localStorage.getItem(SETTINGS_LAST_TAB_KEY)).toBe('plugin:spacemouse');
    first.unmount();

    mount(plugins); // "reload": fresh state, same storage
    expect(selected()).toBe('SpaceMouse');
    cleanup();

    mount([]); // plugin gone -> first visible tab
    expect(selected()).toBe('Visual');
    cleanup();

    localStorage.setItem(SETTINGS_LAST_TAB_KEY, 'plugin:spacemouse');
    mount(plugins);
    act(() => { requestSettingsTab(8); }); // Groups
    expect(selected()).toBe('Groups');
  });
});
