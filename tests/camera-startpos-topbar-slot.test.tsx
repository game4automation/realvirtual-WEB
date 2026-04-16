// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, afterEach } from 'vitest';
import { render, renderHook, screen, cleanup } from '@testing-library/react';
import { usePluginSettingsTabs, PluginSettingsTabContent } from '../src/core/hmi/PluginSettingsTabs';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';

function FakeTabComponent() { return <div>Plugin Tab Content Rendered</div>; }

function mockViewerWithRegistry(): any {
  const registry = new UIPluginRegistry();
  registry.register({
    id: 'test-plugin',
    slots: [{ slot: 'settings-tab', component: FakeTabComponent, label: 'Test Tab', order: 100 }],
  });
  return { uiRegistry: registry };
}

describe('usePluginSettingsTabs + PluginSettingsTabContent (EDIT 3)', () => {
  afterEach(() => cleanup());

  it('hook returns registered settings-tab entries', () => {
    const viewer = mockViewerWithRegistry();
    const { result } = renderHook(() => usePluginSettingsTabs(viewer));
    expect(result.current.length).toBe(1);
    expect(result.current[0].label).toBe('Test Tab');
    expect(result.current[0].pluginId).toBe('test-plugin');
  });

  it('hook returns empty list when no tabs registered', () => {
    const registry = new UIPluginRegistry();
    const viewer: any = { uiRegistry: registry };
    const { result } = renderHook(() => usePluginSettingsTabs(viewer));
    expect(result.current.length).toBe(0);
  });

  it('PluginSettingsTabContent renders active plugin Tab component at correct offset', () => {
    const viewer = mockViewerWithRegistry();
    render(<PluginSettingsTabContent viewer={viewer} value={100} offset={100} />);
    expect(screen.getByText(/Plugin Tab Content Rendered/)).toBeTruthy();
  });

  it('PluginSettingsTabContent renders null when value out of range', () => {
    const viewer = mockViewerWithRegistry();
    const { container } = render(<PluginSettingsTabContent viewer={viewer} value={99} offset={100} />);
    expect(container.textContent).toBe('');
  });

  it('PluginSettingsTabContent renders null when value > registry size', () => {
    const viewer = mockViewerWithRegistry();
    const { container } = render(<PluginSettingsTabContent viewer={viewer} value={105} offset={100} />);
    expect(container.textContent).toBe('');
  });
});
