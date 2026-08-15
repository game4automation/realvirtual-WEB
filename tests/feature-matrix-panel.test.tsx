// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { fireEvent, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  PluginSettingsTabContent,
  usePluginSettingsTabs,
} from '../src/core/hmi/PluginSettingsTabs';
import {
  FeatureMatrixPanel,
  FeatureMatrixPlugin,
} from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/feature-matrix-plugin';
import { createFeatureMatrixViewerHarness } from './helpers/feature-matrix-viewer';

const STORAGE_KEY = 'rv-feature-matrix-view-v2';

beforeEach(() => localStorage.removeItem(STORAGE_KEY));
afterEach(() => {
  cleanup();
  localStorage.removeItem(STORAGE_KEY);
});

function SettingsTabHarness({ viewer }: { viewer: RVViewer }) {
  const tabs = usePluginSettingsTabs(viewer);
  return (
    <>
      <nav aria-label="Plugin settings tabs">
        {tabs.map((tab) => <span key={tab.pluginId}>{tab.label}</span>)}
      </nav>
      <PluginSettingsTabContent viewer={viewer} value={100} offset={100} />
    </>
  );
}

describe('FeatureMatrixPlugin settings panel', () => {
  it('registers the Features tab, filters rows, labels states and reacts to late modes', async () => {
    const harness = createFeatureMatrixViewerHarness([
      { id: 'hmi', label: 'HMI', order: 10 },
      { id: 'planner', label: 'Planner', order: 20 },
    ], 'hmi');
    harness.addPlugin(new FeatureMatrixPlugin(), 'internal');
    harness.addPlugin({ id: 'core-visible', core: true }, 'core');
    harness.addPlugin({ id: 'project-hidden', modes: ['planner'] }, 'project');

    const rendered = render(<SettingsTabHarness viewer={harness.viewer} />);

    expect(screen.getByRole('navigation', { name: 'Plugin settings tabs' }).textContent).toContain('Features');
    expect(screen.getByRole('table', { name: 'Plugins by workspace mode' })).toBeTruthy();
    expect(screen.getAllByLabelText('core, always').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('not in this mode').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Origin' }));
    fireEvent.click(await screen.findByRole('option', { name: 'project' }));
    await waitFor(() => {
      expect(screen.getByText('project-hidden')).toBeTruthy();
      expect(screen.queryByText('core-visible')).toBeNull();
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show active plugins only' }));
    await waitFor(() => expect(screen.getByText('No plugins match the current filters.')).toBeTruthy());

    harness.registerMode({ id: 'commissioning', label: 'Commissioning', order: 30 });
    expect(await screen.findByRole('columnheader', { name: 'Commissioning' })).toBeTruthy();

    expect(harness.eventListenerCount('mode-changed')).toBe(1);
    expect(harness.eventListenerCount('plugins-changed')).toBe(1);
    expect(harness.modeListenerCount()).toBe(1);
    rendered.unmount();
    expect(harness.eventListenerCount('mode-changed')).toBe(0);
    expect(harness.eventListenerCount('plugins-changed')).toBe(0);
    expect(harness.modeListenerCount()).toBe(0);
  });

  it('renders the empty-state copy and no hard-coded mode columns', () => {
    const harness = createFeatureMatrixViewerHarness([], null);
    render(<FeatureMatrixPanel viewer={harness.viewer} />);

    expect(screen.getByText('No plugins are registered.')).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'HMI' })).toBeNull();
  });

  it('groups after filtering, preserves collapse state and supports keyboard group controls', async () => {
    const harness = createFeatureMatrixViewerHarness([
      { id: 'hmi', label: 'HMI' },
      { id: 'planner', label: 'Planner' },
    ], 'hmi');
    harness.addPlugin({ id: 'project-active' }, 'project');
    harness.addPlugin({ id: 'project-inactive', modes: ['planner'] }, 'project');
    harness.addPlugin({ id: 'internal-active' }, 'internal');
    render(<FeatureMatrixPanel viewer={harness.viewer} />);

    expect(screen.getByRole('button', { name: 'PROJECT Gruppe (2)' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'INTERNAL Gruppe (1)' })).toBeTruthy();

    const projectGroup = screen.getByRole('button', { name: 'PROJECT Gruppe (2)' });
    projectGroup.focus();
    await userEvent.keyboard('{Enter}');
    expect(projectGroup.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('project-active')).toBeNull();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Origin' }));
    fireEvent.click(await screen.findByRole('option', { name: 'internal' }));
    expect(await screen.findByRole('button', { name: 'INTERNAL Gruppe (1)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /PROJECT Gruppe/ })).toBeNull();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Origin' }));
    fireEvent.click(await screen.findByRole('option', { name: 'project' }));
    expect((await screen.findByRole('button', { name: 'PROJECT Gruppe (2)' })).getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show active plugins only' }));
    expect(await screen.findByRole('button', { name: 'PROJECT Gruppe (1)' })).toBeTruthy();
    expect(screen.queryByText('project-inactive')).toBeNull();

    const filteredGroup = screen.getByRole('button', { name: 'PROJECT Gruppe (1)' });
    filteredGroup.focus();
    await userEvent.keyboard(' ');
    expect(filteredGroup.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('project-active')).toBeTruthy();
  });

  it('persists origin, active-only and collapsed groups, and tolerates corrupt storage', async () => {
    const harness = createFeatureMatrixViewerHarness();
    harness.addPlugin({ id: 'project-plugin' }, 'project');
    harness.addPlugin({ id: 'internal-plugin' }, 'internal');
    const rendered = render(<FeatureMatrixPanel viewer={harness.viewer} />);

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Origin' }));
    fireEvent.click(await screen.findByRole('option', { name: 'project' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show active plugins only' }));
    fireEvent.click(screen.getByRole('button', { name: 'PROJECT Gruppe (1)' }));

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
        origin: 'project',
        activeOnly: true,
        collapsed: ['project'],
      });
    });
    rendered.unmount();

    const remounted = render(<FeatureMatrixPanel viewer={harness.viewer} />);
    expect(screen.getByRole('combobox', { name: 'Origin' }).textContent).toContain('project');
    expect((screen.getByRole('checkbox', { name: 'Show active plugins only' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'PROJECT Gruppe (1)' }).getAttribute('aria-expanded')).toBe('false');
    remounted.unmount();

    localStorage.setItem(STORAGE_KEY, '{not-json');
    render(<FeatureMatrixPanel viewer={harness.viewer} />);
    expect(screen.getByRole('combobox', { name: 'Origin' }).textContent).toContain('Alle Origins');
    expect((screen.getByRole('checkbox', { name: 'Show active plugins only' }) as HTMLInputElement).checked).toBe(false);
  });

  it('uses honest labels, one table label, conditional tier, focusable tooltips and reset state', async () => {
    const harness = createFeatureMatrixViewerHarness();
    harness.addPlugin({ id: 'feature-matrix', core: true }, 'internal');
    harness.addPlugin({ id: 'project-tool' }, 'project');
    const rendered = render(
      <FeatureMatrixPanel viewer={harness.viewer} tierMap={{ 'project-tool': 'commercial' }} />,
    );

    // plan-435: the legend now has to be honest about the retroactive teardown —
    // the slots are unregistered, not merely inert, and the choice is persisted.
    expect(screen.getByText(/Ein\/Aus = active \(lifecycle \+ UI-Slots\)/)).toBeTruthy();
    expect(screen.getByText(/UI-Slots abgemeldet, Wirkung zurückgebaut/)).toBeTruthy();
    expect(document.querySelectorAll('table[aria-label]')).toHaveLength(1);
    expect(screen.getByRole('columnheader', { name: 'Tier Info' })).toBeTruthy();
    expect(screen.getByLabelText('Ein/Aus User-Intention').getAttribute('tabindex')).toBe('0');
    expect(screen.getAllByLabelText('core, always')[0].getAttribute('tabindex')).toBe('0');
    expect(screen.getByLabelText('Protected').getAttribute('tabindex')).toBe('0');

    const toggle = within(screen.getByText('project-tool').closest('tr')!).getByRole('switch', {
      name: 'project-tool ausschalten',
    });
    expect(toggle.getAttribute('aria-label')).toContain('project-tool');
    const reset = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(reset.disabled).toBe(false));
    fireEvent.click(reset);
    await waitFor(() => expect(reset.disabled).toBe(true));
    expect((within(screen.getByText('project-tool').closest('tr')!).getByRole('switch', {
      name: 'project-tool ausschalten',
    }) as HTMLInputElement).checked).toBe(true);

    rendered.rerender(<FeatureMatrixPanel viewer={harness.viewer} />);
    expect(screen.queryByRole('columnheader', { name: 'Tier Info' })).toBeNull();
  });
});
