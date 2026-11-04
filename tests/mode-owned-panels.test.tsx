// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression (plan-640 follow-up, Festo hosted link 2026-10-20): the hosted root
 * booted straight into HMI while this ORIGIN's `rv-left-panel-active` still held
 * `{ right: layout-planner / 340 }` from an earlier planner session. The boot
 * `leftPanelManager.restore()` reopened that slot, no mode switch out of the
 * planner ever ran its `onModeDeactivate`, nothing rendered the panel — and
 * `ViewportFrame` inset `#rv-viewport` by 340 px on the right (grey strip).
 *
 * These tests drive the REAL LeftPanelManager, the REAL ModeManager (with a
 * minimal host whose planner stand-in opens the library on entry, like the
 * LayoutPlannerPlugin) and the REAL ViewportFrame, and read the inline inset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { ViewportFrame } from '../src/core/hmi/ViewportFrame';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { ModeManager, type ModeHost, type ModeId } from '../src/core/rv-mode-manager';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import { attachModeOwnedPanelReconciler, orphanedModeOwnedPanels } from '../src/core/hmi/mode-owned-panels';
import { getHmiVisible, toggleHmiVisible } from '../src/core/hmi/hmi-visibility-store';
import { LAYOUT_PANEL_WIDTH } from '../src/core/hmi/layout-constants';

// The browser-test iframe can be narrower than the mobile breakpoint; mobile is
// full-bleed by design and would make every assertion trivially 0.
vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

const LS_PANELS = 'rv-left-panel-active';
const LS_MODE = 'rv-active-mode';
const WAIT = { timeout: 3000 };

interface Rig {
  lpm: LeftPanelManager;
  modes: ModeManager;
  /** When true, the planner stand-in "forgets" to close its panel on leave. */
  leakyDeactivate: boolean;
  dispose: () => void;
}

function makeRig(): Rig {
  const lpm = new LeftPanelManager();
  const listeners = new Map<string, Set<() => void>>();
  const rig = { lpm, leakyDeactivate: false } as Rig;

  const planner: RVViewerPlugin & {
    onModeActivate: () => void; onModeDeactivate: () => void;
  } = {
    id: 'layout-planner',
    modes: ['planner'],
    onModeActivate: () => lpm.open('layout-planner', LAYOUT_PANEL_WIDTH, 'right'),
    onModeDeactivate: () => { if (!rig.leakyDeactivate) lpm.close('layout-planner'); },
  } as never;

  const host: ModeHost = {
    viewer: null as never,
    pluginsForMode: (from: ModeId | null, to: ModeId) => ({
      enable: [], disable: [],
      activateHooks: to === 'planner' ? [planner] : [],
      deactivateHooks: from === 'planner' ? [planner] : [],
    }),
    enablePlugin: () => {},
    disablePlugin: () => {},
    callPlugin: (p, method) => { (p as unknown as Record<string, () => void>)[method]?.(); },
    setContext: () => {},
    emit: (event) => { for (const cb of listeners.get(event) ?? []) cb(); },
  };
  const modes = new ModeManager(host);
  modes.register({ id: 'hmi', label: 'HMI' }).register({ id: 'planner', label: 'Planner' });

  const off = attachModeOwnedPanelReconciler({
    leftPanelManager: lpm,
    modes,
    on: (event, cb) => {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(cb);
      return () => { set!.delete(cb); };
    },
  });
  rig.modes = modes;
  rig.dispose = off;
  return rig;
}

function mountFrame(lpm: LeftPanelManager): HTMLElement {
  const el = document.createElement('div');
  el.id = 'rv-viewport';
  document.body.appendChild(el);
  const viewer = { leftPanelManager: lpm, getPlugin: () => undefined };
  render(<RVViewerProvider value={viewer as never}><ViewportFrame /></RVViewerProvider>);
  return el;
}

describe('mode-owned right panel vs. the viewport inset', () => {
  let rig: Rig | undefined;

  beforeEach(() => {
    if (!getHmiVisible()) toggleHmiVisible();
    localStorage.removeItem(LS_MODE);
    // What an earlier planner session on the same origin leaves behind.
    localStorage.setItem(LS_PANELS, JSON.stringify({ right: { id: 'layout-planner', width: LAYOUT_PANEL_WIDTH } }));
  });

  afterEach(() => {
    cleanup();
    rig?.dispose();
    rig = undefined;
    document.getElementById('rv-viewport')?.remove();
    localStorage.removeItem(LS_PANELS);
    localStorage.removeItem(LS_MODE);
  });

  it('boot into HMI, then restore (main.ts order): right slot empty, right inset 0', async () => {
    rig = makeRig();
    rig.modes.setMode('hmi');
    rig.lpm.restore();
    const el = mountFrame(rig.lpm);
    expect(rig.lpm.getActive('right')).toBeNull();
    await waitFor(() => expect(el.style.right).toBe('0px'), WAIT);
  }, 10000);

  it('restore BEFORE a mode exists, then boot into HMI: closed on mode-changed, inset 0', async () => {
    rig = makeRig();
    rig.lpm.restore(); // e.g. the planner plugin's own early restore during load
    const el = mountFrame(rig.lpm);
    // No mode chosen yet → ownership unknown → left alone.
    expect(rig.lpm.getActive('right')).toBe('layout-planner');
    await waitFor(() => expect(el.style.right).toBe(`${LAYOUT_PANEL_WIDTH}px`), WAIT);
    rig.modes.setMode('hmi');
    expect(rig.lpm.getActive('right')).toBeNull();
    await waitFor(() => expect(el.style.right).toBe('0px'), WAIT);
  }, 10000);

  it('planner mode keeps the library open (inset > 0); a leaky switch to HMI still reclaims it', async () => {
    rig = makeRig();
    rig.modes.setMode('planner'); // the stand-in opens the panel BEFORE activeMode flips
    const el = mountFrame(rig.lpm);
    expect(rig.lpm.getActive('right')).toBe('layout-planner');
    await waitFor(() => expect(el.style.right).toBe(`${LAYOUT_PANEL_WIDTH}px`), WAIT);

    rig.leakyDeactivate = true;
    rig.modes.setMode('hmi');
    expect(rig.lpm.getActive('right')).toBeNull();
    await waitFor(() => expect(el.style.right).toBe('0px'), WAIT);
  }, 10000);

  it('a mode-owned panel opened later in HMI (late restore / tool) is closed at once', async () => {
    rig = makeRig();
    rig.modes.setMode('hmi');
    const el = mountFrame(rig.lpm);
    rig.lpm.open('kinematics', 360, 'right');
    expect(rig.lpm.getActive('right')).toBeNull();
    await waitFor(() => expect(el.style.right).toBe('0px'), WAIT);
    // A panel that is NOT mode-owned is untouched.
    rig.lpm.open('connect', 280, 'right');
    expect(rig.lpm.getActive('right')).toBe('connect');
    await waitFor(() => expect(el.style.right).toBe('280px'), WAIT);
  }, 10000);

  it('orphanedModeOwnedPanels: unknown mode answers nothing; owners keep theirs', () => {
    const snap = (right: string | null) => ({
      left: { activePanel: null, activePanelWidth: 0 },
      right: { activePanel: right, activePanelWidth: right ? 340 : 0 },
    });
    expect(orphanedModeOwnedPanels(snap('layout-planner'), null)).toEqual([]);
    expect(orphanedModeOwnedPanels(snap('layout-planner'), 'planner')).toEqual([]);
    expect(orphanedModeOwnedPanels(snap('layout-planner'), 'des')).toEqual([]);
    expect(orphanedModeOwnedPanels(snap('layout-planner'), 'hmi')).toEqual(['layout-planner']);
    expect(orphanedModeOwnedPanels(snap('materials'), 'editor')).toEqual([]);
    expect(orphanedModeOwnedPanels(snap('materials'), 'viewer')).toEqual(['materials']);
    expect(orphanedModeOwnedPanels(snap('connect'), 'hmi')).toEqual([]);
  });
});
