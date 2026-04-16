// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PluginSettingsTabs, PluginSettingsTabContent } from '../src/core/hmi/PluginSettingsTabs';
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

describe('PluginSettingsTabs + PluginSettingsTabContent (EDIT 3)', () => {
  afterEach(() => cleanup());

  it('renders plugin-registered Tab label', () => {
    const viewer = mockViewerWithRegistry();
    // MUI Tab requires a Tabs ancestor; emulate with a tablist role wrapper for unit test.
    render(<div role="tablist"><PluginSettingsTabs viewer={viewer} offset={100} /></div>);
    expect(screen.getByText('Test Tab')).toBeTruthy();
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
