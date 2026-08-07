// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

describe('feature matrix active state', () => {
  it('tracks mode, enabled state, late registration and removal without model state', async () => {
    const harness = createFeatureMatrixViewerHarness([
      { id: 'hmi', label: 'HMI', order: 10 },
      { id: 'planner', label: 'Planner', order: 20 },
    ], 'hmi');
    harness.addPlugin({ id: 'shared' }, 'core');
    harness.addPlugin({ id: 'planner-only', modes: ['planner'] }, 'project');

    render(createElement(FeatureMatrixPanel, { viewer: harness.viewer }));

    expect(within(rowFor('shared')).getByLabelText('eligible & enabled')).toBeTruthy();
    expect(within(rowFor('planner-only')).getByLabelText('not eligible in active mode')).toBeTruthy();

    harness.setMode('planner');
    await waitFor(() => {
      expect(within(rowFor('planner-only')).getByLabelText('eligible & enabled')).toBeTruthy();
    });

    harness.disablePlugin('shared');
    await waitFor(() => {
      expect(within(rowFor('shared')).getByLabelText('disabled')).toBeTruthy();
    });
    harness.enablePlugin('shared');
    await waitFor(() => {
      expect(within(rowFor('shared')).getByLabelText('eligible & enabled')).toBeTruthy();
    });

    harness.addPlugin({ id: 'late-plugin', modes: ['planner'] }, 'internal');
    expect(await screen.findByText('late-plugin')).toBeTruthy();
    harness.removePlugin('late-plugin');
    await waitFor(() => expect(screen.queryByText('late-plugin')).toBeNull());
  });
});
