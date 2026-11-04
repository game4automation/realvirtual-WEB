// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2010 §9.4 — `PlannerSnapFlyout`, the ONE toolbar menu button that
 * replaced the four planner snap icons (Grid snap, Drop to surface, Magnetic
 * snap, Chain mode).
 *
 * Covered: the four checkbox rows mirror the store, a click toggles the store
 * and keeps the menu open, the trigger is active exactly when a switch is on
 * (and its tooltip/label names the active ones), the two settings rows close
 * the menu and open the grid / magnetic popovers at the trigger (commit goes to
 * the store), and the keyboard path ends with the focus back on the trigger
 * (gate finding SOL R1 #4). The slot declarations of the planner carry the
 * authoring rule and a group.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import { PlannerSnapFlyout } from '../src/plugins/layout-planner/PlannerToolbarButtons';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import { AUTHORING_TOOL_RULE } from '../src/plugins/layout-planner/authoring-modes';
import { TOOL_GROUP } from '../src/core/hmi/button-panel-sections';
import { setupPlanner, type PlannerHarness } from './_layout-planner-async-harness';

// Desktop layout (the vitest browser viewport is phone-sized).
vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

let h: PlannerHarness;

function mount() {
  const viewer = {
    getPlugin: (id: string) => (id === 'layout-planner' ? h.plugin : undefined),
  } as unknown as RVViewer;
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>
        <div style={{ position: 'fixed', left: 40, top: 80 }}>
          <PlannerSnapFlyout />
        </div>
      </RVViewerProvider>
    </ThemeProvider>,
  );
}

const trigger = () => screen.getByTestId('planner-snap-flyout');
const row = (id: string) => screen.getByTestId(id);
const paper = () => document.querySelector<HTMLElement>('[data-rv-flyout-paper]');

async function openMenu() {
  fireEvent.click(trigger());
  await waitFor(() => expect(paper()).not.toBeNull());
}

beforeEach(() => {
  h = setupPlanner();
  // A known base state — the store persists to localStorage.
  h.store.setGridEnabled(false);
  h.store.setDropToSurface(false);
  h.store.setBboxSnap(false);
  h.store.setChainMode(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PlannerSnapFlyout — rows and state', () => {
  it('four checkbox rows mirror the store', async () => {
    h.store.setGridEnabled(true);
    h.store.setBboxSnap(true);
    mount();
    await openMenu();

    expect(row('snap-row-grid').getAttribute('role')).toBe('menuitemcheckbox');
    expect(row('snap-row-grid').getAttribute('aria-checked')).toBe('true');
    expect(row('snap-row-drop').getAttribute('aria-checked')).toBe('false');
    expect(row('snap-row-magnetic').getAttribute('aria-checked')).toBe('true');
    expect(row('snap-row-chain').getAttribute('aria-checked')).toBe('false');
    // The settings rows are plain actions.
    expect(row('snap-row-grid-settings').getAttribute('role')).toBe('menuitem');
    expect(row('snap-row-magnetic-settings').getAttribute('role')).toBe('menuitem');
    // The values show as the second line.
    expect(row('snap-row-grid').textContent).toContain(`${h.store.gridSizeMm} mm`);
    expect(row('snap-row-magnetic').textContent).toContain(`${h.store.bboxSnapToleranceMm} mm`);
  });

  it('a click on Chain mode calls setChainMode, flips aria-checked and keeps the menu open', async () => {
    h.store.setChainMode(true);
    const spy = vi.spyOn(h.store, 'setChainMode');
    mount();
    await openMenu();
    expect(row('snap-row-chain').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(row('snap-row-chain'));

    expect(spy).toHaveBeenCalledWith(false);
    await waitFor(() => expect(row('snap-row-chain').getAttribute('aria-checked')).toBe('false'));
    expect(paper()).not.toBeNull();
  });

  it('Grid snap, Drop to surface and Magnetic snap rows toggle their store switch', async () => {
    mount();
    await openMenu();

    fireEvent.click(row('snap-row-grid'));
    await waitFor(() => expect(h.store.gridEnabled).toBe(true));
    fireEvent.click(row('snap-row-drop'));
    await waitFor(() => expect(h.store.dropToSurface).toBe(true));
    fireEvent.click(row('snap-row-magnetic'));
    await waitFor(() => expect(h.store.bboxSnapEnabled).toBe(true));
    expect(paper()).not.toBeNull();
  });

  it('the trigger is active exactly when a switch is on; the label names the active ones', async () => {
    mount();
    expect(trigger().getAttribute('aria-label')).toBe('Snap — all off');
    const idle = getComputedStyle(trigger()).color;

    act(() => { h.store.setChainMode(true); });
    await waitFor(() => expect(trigger().getAttribute('aria-label')).toBe('Snap — chain on'));
    const active = getComputedStyle(trigger()).color;
    expect(active).not.toBe(idle);

    act(() => { h.store.setGridEnabled(true); h.store.setBboxSnap(true); });
    await waitFor(() => expect(trigger().getAttribute('aria-label')).toBe('Snap — grid, magnetic, chain on'));

    act(() => { h.store.setGridEnabled(false); h.store.setBboxSnap(false); h.store.setChainMode(false); });
    await waitFor(() => expect(trigger().getAttribute('aria-label')).toBe('Snap — all off'));
    expect(getComputedStyle(trigger()).color).toBe(idle);
  });

  it('renders nothing without a planner plugin', () => {
    const viewer = { getPlugin: () => undefined } as unknown as RVViewer;
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer}><PlannerSnapFlyout /></RVViewerProvider>
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('planner-snap-flyout')).toBeNull();
  });
});

describe('PlannerSnapFlyout — settings popovers', () => {
  it('"Grid snap settings…" closes the flyout and opens the grid popover; a commit sets the grid size', async () => {
    const setGridSize = vi.spyOn(h.plugin, 'setGridSize');
    mount();
    await openMenu();

    fireEvent.click(row('snap-row-grid-settings'));

    await waitFor(() => expect(screen.getByTestId('snap-grid-settings')).toBeTruthy());
    await waitFor(() => expect(paper()).toBeNull());
    const popover = screen.getByTestId('snap-grid-settings');
    expect(within(popover).getByText('Snap to grid')).toBeTruthy();
    const translation = within(popover).getByLabelText('Translation') as HTMLInputElement;
    expect(translation.value).toBe(String(h.store.gridSizeMm));

    fireEvent.change(translation, { target: { value: '250' } });
    fireEvent.blur(translation);
    await waitFor(() => expect(setGridSize).toHaveBeenCalledWith(250));
    expect(within(popover).getByLabelText('Rotation')).toBeTruthy();
  });

  it('"Magnetic snap settings…" closes the flyout, opens the magnetic popover; switches and fields reach the store', async () => {
    mount();
    await openMenu();

    fireEvent.click(row('snap-row-magnetic-settings'));

    const popover = await screen.findByTestId('snap-magnetic-settings');
    await waitFor(() => expect(paper()).toBeNull());
    for (const label of ['Mid', 'Side', 'Neighbor distances']) {
      expect(within(popover).getByText(label)).toBeTruthy();
    }
    expect(screen.queryByTestId('snap-grid-settings')).toBeNull();

    // The three switches (Mid, Side, Neighbor distances) write their store value.
    const [mid, side, distances] = within(popover).getAllByRole('switch') as HTMLInputElement[];
    const before = { mid: h.store.bboxSnapMid, side: h.store.bboxSnapSide, distances: h.store.showNeighborDistances };
    fireEvent.click(mid);
    fireEvent.click(side);
    fireEvent.click(distances);
    await waitFor(() => expect(h.store.bboxSnapMid).toBe(!before.mid));
    expect(h.store.bboxSnapSide).toBe(!before.side);
    expect(h.store.showNeighborDistances).toBe(!before.distances);

    // Both numeric fields commit to the store (typing implies "I want magnetic snap on").
    const tolerance = within(popover).getByLabelText('Snap distance') as HTMLInputElement;
    fireEvent.change(tolerance, { target: { value: '40' } });
    fireEvent.blur(tolerance);
    await waitFor(() => expect(h.store.bboxSnapToleranceMm).toBe(40));
    expect(h.store.bboxSnapEnabled).toBe(true);
    const maxMeasure = within(popover).getByLabelText('Max measure distance') as HTMLInputElement;
    fireEvent.change(maxMeasure, { target: { value: '2500' } });
    fireEvent.blur(maxMeasure);
    await waitFor(() => expect(h.store.neighborDistanceMaxMm).toBe(2500));
  });

  it('keyboard path: Enter → ArrowDown to "Grid snap settings…" → Enter → popover; Escape returns the focus to the trigger', async () => {
    mount();
    trigger().focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(paper()).not.toBeNull());

    // The first row has the focus; walk down to the settings row.
    const order = ['snap-row-grid', 'snap-row-drop', 'snap-row-magnetic', 'snap-row-chain', 'snap-row-grid-settings'];
    for (let i = 1; i < order.length; i++) {
      await userEvent.keyboard('{ArrowDown}');
      await waitFor(() => expect(document.activeElement).toBe(row(order[i])));
    }
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('snap-grid-settings')).toBeTruthy());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('snap-grid-settings')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });
});

describe('planner slot declarations (plan-2010)', () => {
  it('every button-group entry carries the authoring rule and a group; one Snap entry replaced the four', () => {
    const plugin = new LayoutPlannerPlugin();
    const tools = plugin.slots.filter((s) => s.slot === 'button-group');
    expect(tools.length).toBe(8);
    // plan-779: Align is the one Planner-only tool — its rule is NOT the
    // authoring rule (that one also shows in DES), see the Align slot comment.
    const PLANNER_ONLY = new Set(['PlannerAlignButton']);
    for (const t of tools) {
      const name = (t.component as { name: string }).name;
      expect(t.visibilityRule).toEqual(PLANNER_ONLY.has(name)
        ? { shownOnlyIn: ['planner', 'mode:planner'] }
        : AUTHORING_TOOL_RULE);
      expect(typeof t.group).toBe('string');
    }
    const names = tools.map((t) => (t.component as { name: string }).name);
    expect(names).toContain('PlannerSnapFlyout');
    for (const gone of ['PlannerGridButton', 'PlannerDropToSurfaceButton', 'PlannerSnapButton', 'PlannerChainModeButton']) {
      expect(names).not.toContain(gone);
    }
    const group = (n: string) => tools.find((t) => (t.component as { name: string }).name === n)?.group;
    expect(group('PlannerUndoButton')).toBe(TOOL_GROUP.editing);
    expect(group('PlannerRedoButton')).toBe(TOOL_GROUP.editing);
    expect(group('PlannerDeleteButton')).toBe(TOOL_GROUP.editing);
    expect(group('PlannerSnapFlyout')).toBe(TOOL_GROUP.model);
    expect(group('PlannerLibraryButton')).toBe(TOOL_GROUP.model);
    expect(group('PlannerAlignButton')).toBe(TOOL_GROUP.model);
    expect(group('PlannerVanishMUsButton')).toBe(TOOL_GROUP.analysis);
    expect(group('PlannerDocModeButton')).toBe(TOOL_GROUP.view);
  });
});
