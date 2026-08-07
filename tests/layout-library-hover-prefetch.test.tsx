// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-371 T9 — hover-intent prefetch on a library card (F8).
 *
 * The delay IS the feature. Prefetching on the first `mouseenter` would fire
 * for every card the pointer merely crosses on its way somewhere else, turning
 * a scan across the grid into a burst of multi-megabyte GLB downloads; waiting
 * for the pointer to settle aligns the prefetch with intent.
 *
 * `ThumbnailCard` is rendered directly rather than through `LayoutLibraryPanel`:
 * the panel needs a left-panel manager, a cloud store and a full catalog before
 * it will paint a single card, none of which this behaviour depends on.
 *
 * Real timers, not fake ones — the component under test is MUI-based and the
 * intent window is 80 ms, so a couple of short real waits are cheaper and less
 * brittle than faking the clock underneath a transition-heavy tree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';

import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { ThumbnailCard, PREFETCH_INTENT_MS } from '../src/plugins/layout-planner/LayoutLibraryPanel';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type { LibraryCatalogEntry } from '../src/plugins/layout-planner/rv-layout-store';
import type { RVViewer } from '../src/core/rv-viewer';

const GLB_URL = 'blob:rv-test/belt';

const GLB_ENTRY: LibraryCatalogEntry = {
  id: 'cat:belt',
  name: 'Belt',
  category: 'conveyor',
  glbUrl: GLB_URL,
  footprintMm: [1200, 400],
};

const VIRTUAL_ENTRY: LibraryCatalogEntry = {
  id: 'cat:virtual',
  name: 'VirtualBox',
  category: 'des',
  glbUrl: '',
  virtual: true,
  desType: 'UnregisteredTestType',
  gizmoSize: [500, 500, 500],
};

/** Comfortably past the intent window, without being slow. */
const PAST_INTENT_MS = PREFETCH_INTENT_MS + 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function mockViewer(): RVViewer {
  return {
    on: () => () => {},
    highlightByPath: () => {},
    clearHighlight: () => {},
  } as unknown as RVViewer;
}

function mockPlugin() {
  const prefetch = vi.fn();
  const plugin = {
    modelCache: { prefetch },
    store: { setPlacementMode: vi.fn() },
    setDragEntry: vi.fn(),
    saveThumbnail: vi.fn(async () => null),
    placeComponent: vi.fn(async () => null),
  } as unknown as LayoutPlannerPlugin;
  return { plugin, prefetch };
}

function wrap(ui: ReactNode, viewer: RVViewer) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>{ui}</RVViewerProvider>
    </ThemeProvider>
  );
}

function renderCard(entry: LibraryCatalogEntry) {
  const viewer = mockViewer();
  const { plugin, prefetch } = mockPlugin();
  render(wrap(
    <ThumbnailCard entry={entry} isPlacing={false} isPending={false} plugin={plugin} />,
    viewer,
  ));
  // The entry name is rendered as the card's caption — the most stable handle
  // onto the draggable Box (the card has no role of its own).
  const card = screen.getByText(entry.name).closest('div[draggable], div');
  if (!card) throw new Error('card element not found');
  return { card, prefetch };
}

describe('plan-371 T9 — library hover-intent prefetch', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('does not prefetch for a pointer that only passes over the card', async () => {
    const { card, prefetch } = renderCard(GLB_ENTRY);

    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card);
    await sleep(PAST_INTENT_MS);

    expect(prefetch).not.toHaveBeenCalled();
  });

  it('prefetches once the pointer has rested for the intent delay', async () => {
    const { card, prefetch } = renderCard(GLB_ENTRY);

    fireEvent.mouseEnter(card);
    // Nothing yet — the whole point is that the request is deferred.
    expect(prefetch).not.toHaveBeenCalled();

    await sleep(PAST_INTENT_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith(GLB_URL);
  });

  it('prefetches immediately on pointerdown (the touch stand-in for hover)', () => {
    const { card, prefetch } = renderCard(GLB_ENTRY);

    fireEvent.pointerDown(card);

    // No wait: a touch user gets no hover phase at all, so the tap itself has
    // to start the warm-up if it is to win any of the decode race.
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith(GLB_URL);
  });

  it('does not double-fire when a rested hover is followed by pointerdown', async () => {
    const { card, prefetch } = renderCard(GLB_ENTRY);

    fireEvent.mouseEnter(card);
    await sleep(PAST_INTENT_MS);
    fireEvent.pointerDown(card);

    // The second call is harmless (prefetch is idempotent per url) but it
    // should not happen: the timer already fired and cleared itself.
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it('never prefetches a virtual entry — it has no GLB to warm', async () => {
    const { card, prefetch } = renderCard(VIRTUAL_ENTRY);

    fireEvent.mouseEnter(card);
    fireEvent.pointerDown(card);
    await sleep(PAST_INTENT_MS);

    expect(prefetch).not.toHaveBeenCalled();
  });

  it('drops a scheduled prefetch when the card unmounts mid-intent', async () => {
    const { card, prefetch } = renderCard(GLB_ENTRY);

    fireEvent.mouseEnter(card);
    cleanup();
    await sleep(PAST_INTENT_MS);

    expect(prefetch).not.toHaveBeenCalled();
  });
});
