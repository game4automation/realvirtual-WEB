// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FeatureMatrixPanel } from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/feature-matrix-plugin';
import { createFeatureMatrixViewerHarness } from './helpers/feature-matrix-viewer';

const STORAGE_KEY = 'rv-feature-matrix-view-v2';

beforeEach(() => localStorage.removeItem(STORAGE_KEY));
afterEach(async () => {
  cleanup();
  localStorage.removeItem(STORAGE_KEY);
  await page.viewport(1280, 720);
});

function assertVisibleWithin(element: Element, container: Element): void {
  const elementBox = element.getBoundingClientRect();
  const containerBox = container.getBoundingClientRect();
  expect(elementBox.left).toBeGreaterThanOrEqual(containerBox.left - 1);
  expect(elementBox.right).toBeLessThanOrEqual(containerBox.right + 1);
}

describe('feature matrix responsive sticky table', () => {
  it('keeps the promised columns visible at 540 and 360 px and scrolls to the last column', async () => {
    const harness = createFeatureMatrixViewerHarness([
      { id: 'hmi', label: 'HMI' },
      { id: 'des', label: 'DES' },
      { id: 'planner', label: 'Planner' },
      { id: 'editor', label: 'Editor' },
    ], 'hmi');
    harness.addPlugin({ id: 'responsive-plugin' }, 'project');

    await page.viewport(540, 720);
    const rendered = render(
      <FeatureMatrixPanel viewer={harness.viewer} tierMap={{ 'responsive-plugin': 'commercial' }} />,
    );
    const table = screen.getByRole('table', { name: 'Plugins by workspace mode' });
    const scroller = table.parentElement;
    if (!scroller) throw new Error('Missing table scroller');
    for (const name of ['Plugin', 'Ein/Aus User-Intention', 'HMI', 'DES']) {
      assertVisibleWithin(screen.getByRole('columnheader', { name }), scroller);
    }

    await page.viewport(360, 720);
    assertVisibleWithin(screen.getByRole('columnheader', { name: 'Plugin' }), scroller);
    assertVisibleWithin(screen.getByRole('columnheader', { name: 'Ein/Aus User-Intention' }), scroller);

    const stickyPlugin = screen.getByRole('columnheader', { name: 'Plugin' });
    const stickySwitch = screen.getByRole('columnheader', { name: 'Ein/Aus User-Intention' });
    const pluginLeft = stickyPlugin.getBoundingClientRect().left;
    const switchLeft = stickySwitch.getBoundingClientRect().left;
    scroller.scrollLeft = scroller.scrollWidth;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(stickyPlugin.getBoundingClientRect().left).toBeCloseTo(pluginLeft, 0);
    expect(stickySwitch.getBoundingClientRect().left).toBeCloseTo(switchLeft, 0);
    assertVisibleWithin(screen.getByRole('columnheader', { name: 'Tier Info' }), scroller);

    rendered.rerender(<FeatureMatrixPanel viewer={harness.viewer} />);
    expect(screen.queryByRole('columnheader', { name: 'Tier Info' })).toBeNull();
    assertVisibleWithin(screen.getByRole('columnheader', { name: 'Plugin' }), scroller);
    assertVisibleWithin(screen.getByRole('columnheader', { name: 'Ein/Aus User-Intention' }), scroller);
  });
});
