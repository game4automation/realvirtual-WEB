// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-578 §9.5 — the cluster's overflow pill (`ViewOverflowGroup`).
 *
 * VR/AR and First-Person moved behind one upward dropdown. The two mobile gates
 * are props that land in the ENTRY LIST, so an overflow whose content is gone
 * renders nothing at all rather than an empty pill (F14). The trigger shows the
 * engaged state while the menu is closed (F13), and re-opening always shows the
 * current state — the rows are built from the live values, never cached.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import { ViewOverflowGroup } from '../src/core/hmi/TopBar';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { ActionMenuRow } from '../src/core/hmi/action-group';

interface Fake {
  viewer: RVViewer;
  emit(ev: string, data?: unknown): void;
  toggles: number;
}

function makeFake(): Fake {
  const listeners = new Map<string, Set<(d?: unknown) => void>>();
  const state = { toggles: 0 };
  const emit = (ev: string, data?: unknown) => { listeners.get(ev)?.forEach((cb) => cb(data)); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = {
    on(ev: string, cb: (d?: unknown) => void) {
      let set = listeners.get(ev);
      if (!set) { set = new Set(); listeners.set(ev, set); }
      set.add(cb);
      return () => { listeners.get(ev)?.delete(cb); };
    },
    off(ev: string, cb: (d?: unknown) => void) { listeners.get(ev)?.delete(cb); },
    emit,
    // The overflow reads the `view-overflow` slot — a real registry, empty unless a test adds a row.
    uiRegistry: new UIPluginRegistry(),
    getPlugin: (id: string) => (id === 'fpv'
      ? { id: 'fpv', toggle: () => { state.toggles++; } }
      : null),
  };
  return {
    viewer: v as RVViewer,
    emit,
    get toggles() { return state.toggles; },
  };
}

const trigger = () => screen.getByTestId('view-overflow-trigger');
const openMenu = async () => {
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeNull());
};

function mount(
  f: Fake,
  props: Partial<React.ComponentProps<typeof ViewOverflowGroup>> = {},
) {
  const onToggleVr = props.onToggleVr ?? (() => {});
  return render(
    <RVViewerProvider value={f.viewer}>
      <ViewOverflowGroup
        showVr={props.showVr ?? true}
        showFpv={props.showFpv ?? true}
        vrOpen={props.vrOpen ?? false}
        onToggleVr={onToggleVr}
      />
    </RVViewerProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ViewOverflowGroup', () => {
  it('VR and FPV live behind the overflow trigger', async () => {
    mount(makeFake());
    // Collapsed: neither entry is on screen.
    expect(screen.queryByTestId('overflow-vr')).toBeNull();
    expect(screen.queryByTestId('overflow-fpv')).toBeNull();
    await openMenu();
    expect(screen.getByTestId('overflow-vr')).toBeInTheDocument();
    expect(screen.getByTestId('overflow-fpv')).toBeInTheDocument();
    // Two INDEPENDENT toggles — checkboxes, not one exclusive radio set.
    expect(within(screen.getByRole('menu')).getAllByRole('menuitemcheckbox')).toHaveLength(2);
    expect(within(screen.getByRole('menu')).queryAllByRole('menuitemradio')).toHaveLength(0);
  });

  it('the overflow segment is absent when both mobile gates remove its items', () => {
    const { container } = mount(makeFake(), { showVr: false, showFpv: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a single-entry overflow when only one gate removes its item', async () => {
    mount(makeFake(), { showVr: false, showFpv: true });
    await openMenu();
    expect(screen.queryByTestId('overflow-vr')).toBeNull();
    expect(screen.getByTestId('overflow-fpv')).toBeInTheDocument();
  });

  it('the FPV active state reaches the trigger icon while the menu is closed', () => {
    const f = makeFake();
    mount(f);
    expect(within(trigger()).getByTestId('MoreHorizIcon')).toBeInTheDocument();
    act(() => { f.emit('fpv-enter'); });
    expect(within(trigger()).getByTestId('DirectionsWalkIcon')).toBeInTheDocument();
    act(() => { f.emit('fpv-exit'); });
    expect(within(trigger()).getByTestId('MoreHorizIcon')).toBeInTheDocument();
  });

  it('the VR item opens the modal and the menu closes first', async () => {
    let vrOpen = false;
    const f = makeFake();
    mount(f, { onToggleVr: () => { vrOpen = true; } });
    await openMenu();
    fireEvent.click(screen.getByTestId('overflow-vr'));
    // The opener fired AND the menu is gone — `VRModal` itself is untouched,
    // only the state it hangs on moved behind this row.
    expect(vrOpen).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the trigger shows VR being engaged while the menu is closed', () => {
    mount(makeFake(), { vrOpen: true });
    expect(within(trigger()).getByTestId('ViewInArIcon')).toBeInTheDocument();
  });

  it('reopening the menu shows the current active states, not stale ones', async () => {
    const f = makeFake();
    mount(f);
    await openMenu();
    expect(screen.getByTestId('overflow-fpv')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByTestId('overflow-fpv'));
    expect(f.toggles).toBe(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // The plugin reports back after the menu closed …
    act(() => { f.emit('fpv-enter'); });
    await openMenu();
    // … and the reopened row reflects it.
    expect(screen.getByTestId('overflow-fpv')).toHaveAttribute('aria-checked', 'true');
  });

  it('a plugin row from the view-overflow slot joins the menu and closes it like a built-in row', async () => {
    const f = makeFake();
    const clicked = vi.fn();
    function PluginRow() {
      return <ActionMenuRow label="Record video" kind="action" onClick={clicked} testId="plugin-row" />;
    }
    act(() => {
      (f.viewer as unknown as { uiRegistry: UIPluginRegistry }).uiRegistry.register({
        id: 'test-plugin',
        slots: [{ slot: 'view-overflow', component: PluginRow, label: 'Record video' }],
      });
    });
    // Both built-in gates closed: the plugin row alone keeps the overflow alive.
    mount(f, { showVr: false, showFpv: false });
    await openMenu();
    const row = screen.getByTestId('plugin-row');
    expect(row).toHaveAttribute('role', 'menuitem');
    expect(row).not.toHaveAttribute('aria-checked');
    fireEvent.click(row);
    expect(clicked).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});
