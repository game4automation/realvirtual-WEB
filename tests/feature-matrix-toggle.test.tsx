// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FeatureMatrixPanel } from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/feature-matrix-plugin';
import { createFeatureMatrixViewerHarness } from './helpers/feature-matrix-viewer';

const STORAGE_KEY = 'rv-feature-matrix-view-v2';

beforeEach(() => localStorage.removeItem(STORAGE_KEY));
afterEach(() => {
  cleanup();
  localStorage.removeItem(STORAGE_KEY);
});

function rowFor(id: string): HTMLElement {
  const row = screen.getByText(id).closest('tr');
  if (!row) throw new Error(`Missing row for ${id}`);
  return row;
}

describe('feature matrix user toggles', () => {
  it('delegates to the viewer and follows plugins-changed instead of local switch state', async () => {
    const harness = createFeatureMatrixViewerHarness();
    harness.addPlugin({ id: 'project-tool' }, 'project');
    render(<FeatureMatrixPanel viewer={harness.viewer} />);

    const switchInput = within(rowFor('project-tool')).getByRole('switch', { name: 'project-tool ausschalten' });
    expect((switchInput as HTMLInputElement).checked).toBe(true);
    fireEvent.click(switchInput);

    expect(harness.userToggleCalls).toEqual([{ id: 'project-tool', enabled: false }]);
    await waitFor(() => {
      expect((within(rowFor('project-tool')).getByRole('switch', {
        name: 'project-tool einschalten',
      }) as HTMLInputElement).checked).toBe(false);
      expect(within(rowFor('project-tool')).getByText('ausgeschaltet')).toBeTruthy();
    });

    harness.setPluginUserEnabled('project-tool', true);
    await waitFor(() => {
      const input = within(rowFor('project-tool')).getByRole('switch', {
        name: 'project-tool ausschalten',
      }) as HTMLInputElement;
      expect(input.checked).toBe(true);
    });
  });

  it('guards feature-matrix and asset-editor with disabled switches and lock indicators', () => {
    const harness = createFeatureMatrixViewerHarness();
    harness.addPlugin({ id: 'feature-matrix', core: true }, 'internal');
    harness.addPlugin({ id: 'asset-editor' }, 'internal');
    render(<FeatureMatrixPanel viewer={harness.viewer} />);

    for (const id of ['feature-matrix', 'asset-editor']) {
      const row = within(rowFor(id));
      expect((row.getByRole('switch', { name: `${id} ausschalten` }) as HTMLInputElement).disabled).toBe(true);
      expect(row.getByLabelText('Protected').getAttribute('tabindex')).toBe('0');
      fireEvent.click(row.getByRole('switch', { name: `${id} ausschalten` }));
    }
    expect(harness.userToggleCalls).toEqual([]);
  });

  it('stays consistent after twenty rapid toggles', async () => {
    const harness = createFeatureMatrixViewerHarness();
    harness.addPlugin({ id: 'rapid' }, 'project');
    render(<FeatureMatrixPanel viewer={harness.viewer} />);

    for (let index = 0; index < 20; index++) {
      const action = index % 2 === 0 ? 'ausschalten' : 'einschalten';
      fireEvent.click(within(rowFor('rapid')).getByRole('switch', { name: `rapid ${action}` }));
    }

    await waitFor(() => {
      const input = within(rowFor('rapid')).getByRole('switch', {
        name: 'rapid ausschalten',
      }) as HTMLInputElement;
      expect(input.checked).toBe(true);
    });
    expect(harness.userToggleCalls).toHaveLength(20);
    expect(harness.viewer.isPluginUserDisabled('rapid')).toBe(false);
  });

  it('shows user intent separately from the effective out-of-mode state', () => {
    const harness = createFeatureMatrixViewerHarness([
      { id: 'hmi', label: 'HMI' },
      { id: 'planner', label: 'Planner' },
    ], 'hmi');
    harness.addPlugin({ id: 'planner-only', modes: ['planner'] }, 'project');
    render(<FeatureMatrixPanel viewer={harness.viewer} />);

    const row = rowFor('planner-only');
    expect((within(row).getByRole('switch', {
      name: 'planner-only ausschalten',
    }) as HTMLInputElement).checked).toBe(true);
    expect(within(row).getByText('nicht in diesem Modus')).toBeTruthy();
    expect(getComputedStyle(row).opacity).toBe('0.62');
  });
});
