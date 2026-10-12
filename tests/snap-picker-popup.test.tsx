// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Picker popup smoke test — renders the popup with a stubbed viewer +
 * snap-hover state and asserts visibility, ESC close, and outside-click close.
 *
 * Full E2E (hover near snap -> marker -> click -> picker -> place) is
 * out of scope for unit tests since it requires a fully wired RVViewer
 * with renderer + layout-planner. Asset placement is exercised separately
 * via snap-placement-validation + scene-mutations tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { Object3D } from 'three';
import { SnapPointPickerPopup } from '../src/plugins/snap-point/SnapPointPickerPopup';
import {
  snapHoverStore,
} from '../src/plugins/snap-point/snap-hover-store';
import type { SnapPoint } from '../src/core/engine/rv-snap-point-registry';
import { useMobileLayout } from '../src/hooks/use-mobile-layout';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { findCompatibleLibraryAssets } from '../src/plugins/snap-point/library-snap-index';

// The popup picks its layout from useMobileLayout(): desktop anchors next to the
// snap point (left/top from the screen anchor); mobile docks it centre-bottom
// (left:50%, transform). The headless test viewport is narrow, so without this
// mock useMobileLayout() returns true and the anchored-position assertion would
// be viewport-dependent. Mock it so each test pins the layout it exercises.
vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hooks/use-mobile-layout')>()),
  useMobileLayout: vi.fn(() => false),
}));
const mockUseMobileLayout = vi.mocked(useMobileLayout);

// The compatible-asset lookup loads GLBs; the dispatch tests only need a list.
vi.mock('../src/plugins/snap-point/library-snap-index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/plugins/snap-point/library-snap-index')>()),
  findCompatibleLibraryAssets: vi.fn(async () => []),
}));
const mockFindCompatible = vi.mocked(findCompatibleLibraryAssets);

function makeSnap(id: string): SnapPoint {
  const n = new Object3D();
  n.name = 'Snap-ZN-convroll';
  return {
    id,
    object3D: n,
    dir: { axis: 'Z', sign: 'N', code: 'ZN' },
    typeId: 'convroll',
    ownerRoot: n,
    scenePath: 'Snap-ZN-convroll',
    occupied: false,
  };
}

function makeViewerStub() {
  // Empty viewer — picker reads catalogs via useSyncExternalStore which
  // tolerates null subscribe/getSnapshot.
  return {
    getPlugin: () => undefined,
  };
}

describe('SnapPointPickerPopup', () => {
  beforeEach(() => {
    snapHoverStore.reset();
    cleanup();
    mockUseMobileLayout.mockReturnValue(false); // default: desktop layout
  });

  it('renders nothing when picker is closed', () => {
    const { container } = render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    expect(container.querySelector('[data-testid="snap-picker-popup"]')).toBeNull();
  });

  it('renders the popup when picker is open', () => {
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 100, y: 100 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    expect(screen.getByTestId('snap-picker-popup')).toBeTruthy();
  });

  it('displays the typeId in the title', () => {
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 100, y: 100 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    expect(screen.getByText('convroll', { exact: false })).toBeTruthy();
  });

  it('shows empty-state when no compatible library entries exist', async () => {
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 100, y: 100 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    // Wait for the async loader to settle (Promise.resolve microtask)
    await new Promise((r) => setTimeout(r, 50));
    const popup = screen.getByTestId('snap-picker-popup');
    expect(popup.textContent ?? '').toMatch(/no compatible/i);
  });

  it('positions the popup near the screen anchor (desktop)', () => {
    mockUseMobileLayout.mockReturnValue(false);
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 200, y: 150 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    const popup = screen.getByTestId('snap-picker-popup') as HTMLElement;
    // Desktop anchors the popup at screenPos + 12 px (hard-coded in the popup).
    const cs = window.getComputedStyle(popup);
    expect(cs.left).toBe('212px');
    expect(cs.top).toBe('162px');
    expect(cs.transform).toBe('none'); // anchored, not centre-translated
  });

  it('docks the popup centre-bottom on mobile (not anchored)', () => {
    mockUseMobileLayout.mockReturnValue(true);
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 200, y: 150 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    const popup = screen.getByTestId('snap-picker-popup') as HTMLElement;
    const cs = window.getComputedStyle(popup);
    // Mobile centres horizontally (translateX(-50%)) and ignores the anchor —
    // it must NOT sit at the desktop-anchored 212px / 162px.
    expect(cs.transform).not.toBe('none');
    expect(cs.top).not.toBe('162px');
  });

  // ── plan-499 follow-up: the picker entry is a view of `layout.snapAttach` ──

  const ENTRY = { id: 'conv-1', name: 'Conveyor 1', category: 'Conveyor', glbUrl: 'x.glb' };

  /** A viewer with a planner whose placement `p1` owns the target snap. */
  function makeWiredViewer(sp: SnapPoint, placedId: string | null) {
    const snapshot = { catalogs: new Map([['cat', { entries: [ENTRY] }]]) };
    const planner = {
      store: { subscribe: () => () => {}, getSnapshot: () => snapshot },
      findPlacedIdByRoot: vi.fn(() => placedId),
      placeAtSnap: vi.fn(async () => 'direct-id'),
    };
    const registry = { getByOwnerRoot: () => [sp] };
    const viewer = {
      getPlugin: (id: string) => (id === 'layout-planner' ? planner : id === 'snap-point' ? { getRegistry: () => registry } : undefined),
    };
    return { viewer, planner };
  }

  function openWithEntry(): SnapPoint {
    const sp = makeSnap('a');
    mockFindCompatible.mockResolvedValue([{ entry: ENTRY as never, ownSnapName: 'Snap-ZP-convroll' }]);
    snapHoverStore.openPicker(sp, { x: 100, y: 100 });
    return sp;
  }

  it('clicking an entry dispatches exactly one layout.snapAttach and closes on success', async () => {
    const sp = openWithEntry();
    const { viewer, planner } = makeWiredViewer(sp, 'p1');
    const exec = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: { id: 'new' } });
    try {
      render(<SnapPointPickerPopup viewer={viewer as never} />);
      fireEvent.click(await screen.findByTestId('library-item'));
      await waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
      expect(exec).toHaveBeenCalledWith(
        'layout.snapAttach',
        { targetId: 'p1', catalogId: 'conv-1', targetSnapName: 'Snap-ZN-convroll' },
        expect.objectContaining({ origin: 'ui', buttonKey: 'layout.snapAttach', viewer }),
      );
      expect(planner.placeAtSnap).not.toHaveBeenCalled();
      await waitFor(() => expect(snapHoverStore.getState().pickerOpen).toBe(false));
    } finally {
      exec.mockRestore();
    }
  });

  it('a refused attach shows the command reason and keeps the picker open', async () => {
    const sp = openWithEntry();
    const { viewer } = makeWiredViewer(sp, 'p1');
    const exec = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({
      ok: false, kind: 'disabled', reason: 'Snap "Snap-ZN-convroll" not free or not found',
    });
    try {
      render(<SnapPointPickerPopup viewer={viewer as never} />);
      fireEvent.click(await screen.findByTestId('library-item'));
      expect(await screen.findByText('Snap "Snap-ZN-convroll" not free or not found')).toBeTruthy();
      expect(exec).toHaveBeenCalledTimes(1);
      expect(snapHoverStore.getState().pickerOpen).toBe(true);
    } finally {
      exec.mockRestore();
    }
  });

  it('a snap outside any planner placement keeps the direct snap placement', async () => {
    const sp = openWithEntry();
    const { viewer, planner } = makeWiredViewer(sp, null);
    const exec = vi.spyOn(commandRegistry, 'execute');
    try {
      render(<SnapPointPickerPopup viewer={viewer as never} />);
      fireEvent.click(await screen.findByTestId('library-item'));
      await waitFor(() => expect(planner.placeAtSnap).toHaveBeenCalledTimes(1));
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
  });
});
