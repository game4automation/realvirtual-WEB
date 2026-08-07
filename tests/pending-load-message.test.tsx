// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-371 — the pending-load status line.
 *
 * The plan listed the tile's button interaction as deliberately uncovered
 * (T8 drives the registry, not the UI). It is cheap to cover here, and the two
 * things the plan DOES mandate about this component — the ARIA live regions and
 * the absence of a progress bar — are only observable through a render.
 *
 * Driven through a real `LayoutStore` so the component is exercised over the
 * same `useSyncExternalStore` path it uses in the app.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';

import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { PendingLoadMessage } from '../src/plugins/layout-planner/PendingLoadMessage';
import { LayoutStore } from '../src/plugins/layout-planner/rv-layout-store';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type { RVViewer } from '../src/core/rv-viewer';

function setup() {
  const store = new LayoutStore();
  const retryPendingPlacement = vi.fn();
  const removePlacementById = vi.fn();
  const plugin = { store, retryPendingPlacement, removePlacementById } as unknown as LayoutPlannerPlugin;
  const viewer = { getPlugin: () => plugin } as unknown as RVViewer;

  const wrap = (ui: ReactNode) => (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>{ui}</RVViewerProvider>
    </ThemeProvider>
  );

  return { store, plugin, viewer, wrap, retryPendingPlacement, removePlacementById };
}

describe('plan-371 — PendingLoadMessage', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('keeps both live regions mounted while nothing is pending', () => {
    const { wrap, viewer } = setup();
    render(wrap(<PendingLoadMessage viewer={viewer} />));

    // Mounted-but-empty on purpose: a live region inserted into the DOM already
    // holding its text is announced inconsistently, one that exists first and is
    // filled afterwards is announced reliably.
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/Assets werden geladen/)).toBeNull();
  });

  it('announces a loading placement politely, with no progress bar', () => {
    const { store, wrap, viewer } = setup();
    render(wrap(<PendingLoadMessage viewer={viewer} />));

    act(() => {
      store.setPendingPlacements([{ id: 'p1', name: 'Roboter-Zelle A', status: 'loading' }]);
    });

    const polite = screen.getByRole('status');
    expect(polite.getAttribute('aria-live')).toBe('polite');
    expect(polite.textContent).toContain('Lade Roboter-Zelle A');
    // Explicit product decision: GLTF load progress is not trustworthy enough
    // to render as a determinate bar (three.js #15584 / #14256).
    expect(polite.querySelector('[role="progressbar"][aria-valuenow]')).toBeNull();
  });

  it('announces a failure assertively and offers retry + remove', () => {
    const { store, wrap, viewer, retryPendingPlacement, removePlacementById } = setup();
    render(wrap(<PendingLoadMessage viewer={viewer} />));

    act(() => {
      store.setPendingPlacements([
        { id: 'p1', name: 'Foerderer-3', status: 'error', error: '404' },
      ]);
    });

    const assertive = screen.getByRole('alert');
    expect(assertive.getAttribute('aria-live')).toBe('assertive');
    expect(assertive.textContent).toContain('Foerderer-3');

    fireEvent.click(screen.getByRole('button', { name: /wiederholen/i }));
    expect(retryPendingPlacement).toHaveBeenCalledWith('p1');

    fireEvent.click(screen.getByRole('button', { name: /entfernen/i }));
    expect(removePlacementById).toHaveBeenCalledWith('p1');
  });

  it('lists one row per pending placement so a partial failure is actionable', () => {
    const { store, wrap, viewer } = setup();
    render(wrap(<PendingLoadMessage viewer={viewer} />));

    act(() => {
      store.setPendingPlacements([
        { id: 'p1', name: 'Belt A', status: 'loading' },
        { id: 'p2', name: 'Belt B', status: 'error', error: 'boom' },
        { id: 'p3', name: 'Belt C', status: 'loading' },
      ]);
    });

    expect(screen.getByRole('status').textContent).toContain('Belt A');
    expect(screen.getByRole('status').textContent).toContain('Belt C');
    // Only the broken one gets buttons — the other two need no decision.
    expect(screen.getByRole('alert').textContent).toContain('Belt B');
    expect(screen.getAllByRole('button', { name: /wiederholen/i })).toHaveLength(1);
  });

  it('never serializes its state: setPendingPlacements is a no-op when unchanged', () => {
    const { store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);

    const rows = [{ id: 'p1', name: 'Belt A', status: 'loading' as const }];
    store.setPendingPlacements(rows);
    expect(listener).toHaveBeenCalledTimes(1);

    // Same content, fresh array — must NOT notify, or every generation bump in
    // the registry would rerender the whole planner UI.
    store.setPendingPlacements([{ id: 'p1', name: 'Belt A', status: 'loading' }]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setPendingPlacements([{ id: 'p1', name: 'Belt A', status: 'error' }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
