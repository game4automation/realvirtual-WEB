// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2010 §9.6 — signal linking in DES (Thomas, 2026-10-27).
 *
 * The two signal toolbar buttons (link mode, bindings overview) are not offered
 * in DES; they stay in commissioning / editor / planner. A link mode that is ON
 * RESTS in DES — no badges, normal object tooltips — and applies again when the
 * mode changes; the stored switch is never touched. Drag-linking from the
 * inspector keeps working in DES. The tests check the EFFECT (badges, tooltips),
 * not only the store state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { cleanup, render } from '@testing-library/react';
import '../src/core/engine/rv-drive';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { computeToolSections } from '../src/core/hmi/button-panel-sections';
import { modeContext, type ModeId } from '../src/core/rv-mode-manager';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import {
  SIGNAL_LINK_MODES, SIGNAL_LINK_TOOLBAR_CONTEXTS, SIGNAL_LINK_TOOLBAR_MODES,
} from '../src/plugins/signal-bind/signal-link-gate';
import {
  SignalBadgeController, type BadgePlannerLike, type BadgeViewerLike,
} from '../src/plugins/signal-bind/SignalBadgeController';
import { signalBindStore } from '../src/plugins/signal-bind/signal-bind-store';
import {
  SIGNAL_LINK_MODE_STORAGE_KEY,
  _resetSignalLinkModeStoreForTests,
  getSignalLinkModeSnapshot,
  setSignalLinkModeExplicit,
  setSignalLinkModeSuspended,
  subscribeSignalLinkMode,
} from '../src/plugins/signal-bind/signal-link-mode-store';
import { armSignalDrag, cancelSignalDrag, consumeSignalDragClick, updateSignalDrag, type SignalDragPayload } from '../src/core/hmi/signal-drag-store';
import { tooltipStore } from '../src/core/hmi/tooltip/tooltip-store';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import type { GizmoHandle, GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';

// The tooltip controller reads these hooks; the hover feed is fixed.
const HOVER_NODE = new Object3D();
HOVER_NODE.name = 'Conveyor';
HOVER_NODE.userData.realvirtual = { Drive: { Speed: 100 } };
vi.mock('../src/hooks/use-hover', () => ({
  useHoveredObject: () => ({ node: HOVER_NODE, nodePath: 'Cell/Conveyor', pointer: { x: 10, y: 20 } }),
}));
vi.mock('../src/hooks/use-drives', () => ({ useFocusedDrive: () => ({ drive: null, node: null }) }));
vi.mock('../src/hooks/use-selection', () => ({ useSelection: () => ({ selectedPaths: [] }) }));
const { GenericTooltipController } = await import('../src/core/hmi/tooltip/GenericTooltipController');

// ─── Toolbar visibility ───────────────────────────────────────────────────

/** Contexts a mode has: its mode id, plus the legacy `planner` one while authoring is live. */
function contextsFor(mode: ModeId): ReadonlySet<string> {
  const ctx = new Set<string>([modeContext(mode)]);
  if (mode === 'planner' || mode === 'des') ctx.add('planner');
  return ctx;
}

function signalEntriesIn(mode: ModeId): string[] {
  const reg = new UIPluginRegistry();
  reg.register(new SignalBindPlugin());
  return computeToolSections(reg.getSlotComponents('button-group'), contextsFor(mode), mode)
    .flatMap((s) => s.entries.map((e) => (e.entry.component as { name: string }).name));
}

describe('signal toolbar buttons per mode', () => {
  it('the toolbar mode list is the link-mode list minus des', () => {
    expect([...SIGNAL_LINK_TOOLBAR_MODES]).toEqual(SIGNAL_LINK_MODES.filter((m) => m !== 'des'));
    expect(SIGNAL_LINK_TOOLBAR_CONTEXTS).toEqual(SIGNAL_LINK_TOOLBAR_MODES.map((m) => modeContext(m)));
    // the inspector / drag / context-menu gate keeps des
    expect(SIGNAL_LINK_MODES).toContain('des');
  });

  it('both entries show in commissioning, editor and planner', () => {
    for (const mode of ['commissioning', 'editor', 'planner'] as ModeId[]) {
      expect(signalEntriesIn(mode), mode).toEqual(['SignalLinkModeButton', 'BindingsOverviewButton']);
    }
  });

  it('neither entry shows in des, hmi or viewer', () => {
    for (const mode of ['des', 'hmi', 'viewer'] as ModeId[]) {
      expect(signalEntriesIn(mode), mode).toEqual([]);
    }
  });

  it('both entries sit in the model group', () => {
    const slots = new SignalBindPlugin().slots.filter((s) => s.slot === 'button-group');
    expect(slots.length).toBe(2);
    for (const s of slots) expect(s.group).toBe('model');
  });
});

// ─── Resting link mode ────────────────────────────────────────────────────

const PAYLOAD: SignalDragPayload = {
  name: 'MC07_Start',
  direction: 'output',
  plcType: 'PLCOutputBool',
  origin: 'connect',
  interfaceId: 'iface-1',
};

describe('link mode rests in DES', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetSignalLinkModeStoreForTests();
  });
  afterEach(() => {
    cancelSignalDrag();
    consumeSignalDragClick();
    _resetSignalLinkModeStoreForTests();
  });

  it('suspending keeps the stored switch, ends activity, and resuming restores it', () => {
    setSignalLinkModeExplicit(true);
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: true });
    expect(localStorage.getItem(SIGNAL_LINK_MODE_STORAGE_KEY)).toBe('true');

    setSignalLinkModeSuspended(true);
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: false });
    expect(localStorage.getItem(SIGNAL_LINK_MODE_STORAGE_KEY)).toBe('true');

    setSignalLinkModeSuspended(false);
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: true });
  });

  it('toggling while suspended changes the stored switch but not the activity', () => {
    setSignalLinkModeSuspended(true);
    setSignalLinkModeExplicit(true);
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: false });
    setSignalLinkModeSuspended(false);
    expect(getSignalLinkModeSnapshot().active).toBe(true);
  });

  it('subscribers are notified on a suspend / resume', () => {
    setSignalLinkModeExplicit(true);
    const listener = vi.fn();
    const off = subscribeSignalLinkMode(listener);
    setSignalLinkModeSuspended(true);
    setSignalLinkModeSuspended(true); // no change → no second notification
    setSignalLinkModeSuspended(false);
    off();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a running signal drag stays active while suspended (inspector drag-linking works in DES)', () => {
    setSignalLinkModeExplicit(true);
    setSignalLinkModeSuspended(true);
    expect(getSignalLinkModeSnapshot().active).toBe(false);

    armSignalDrag(PAYLOAD, 100, 100);
    updateSignalDrag(140, 100); // past the threshold → dragging
    expect(getSignalLinkModeSnapshot().active).toBe(true);

    cancelSignalDrag();
    consumeSignalDragClick();
    expect(getSignalLinkModeSnapshot().active).toBe(false);
  });
});

// ─── The plugin follows the viewer's mode ─────────────────────────────────

interface FakeViewerHandle {
  viewer: RVViewer;
  emit: (event: string, data: unknown) => void;
  setActive: (mode: ModeId) => void;
}

function makeViewer(initial: ModeId | null): FakeViewerHandle {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const modes = { activeMode: initial as ModeId | null };
  const viewer = {
    modes,
    contextMenu: new ContextMenuStore(),
    getPlugin: () => undefined,
    on: (event: string, cb: (d: unknown) => void) => {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => set!.delete(cb);
    },
  } as unknown as RVViewer;
  return {
    viewer,
    emit: (event, data) => { for (const cb of listeners.get(event) ?? []) cb(data); },
    setActive: (mode) => { modes.activeMode = mode; },
  };
}

describe('SignalBindPlugin follows the active mode', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetSignalLinkModeStoreForTests();
    signalBindStore.clear();
  });
  afterEach(() => { _resetSignalLinkModeStoreForTests(); });

  it('mode-changed to des rests the link mode, back to planner applies it again', () => {
    const h = makeViewer('planner');
    const plugin = new SignalBindPlugin();
    plugin.init(h.viewer);
    setSignalLinkModeExplicit(true);
    expect(getSignalLinkModeSnapshot().active).toBe(true);

    h.setActive('des');
    h.emit('mode-changed', { from: 'planner', to: 'des' });
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: false });
    expect(localStorage.getItem(SIGNAL_LINK_MODE_STORAGE_KEY)).toBe('true');

    h.setActive('planner');
    h.emit('mode-changed', { from: 'des', to: 'planner' });
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: true });
    plugin.dispose();
  });

  it('starting directly in des (mode set before init) rests from the first moment', () => {
    setSignalLinkModeExplicit(true);
    const h = makeViewer('des');
    const plugin = new SignalBindPlugin();
    plugin.init(h.viewer);
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: false });
    plugin.dispose();
  });

  it('dispose lifts the rest and stops following the mode', () => {
    setSignalLinkModeExplicit(true);
    const h = makeViewer('des');
    const plugin = new SignalBindPlugin();
    plugin.init(h.viewer);
    expect(getSignalLinkModeSnapshot().active).toBe(false);

    plugin.dispose();
    expect(getSignalLinkModeSnapshot().active).toBe(true);
    h.emit('mode-changed', { from: 'planner', to: 'des' });
    expect(getSignalLinkModeSnapshot().active).toBe(true);
  });
});

// ─── Effect: badges ───────────────────────────────────────────────────────

function makeBadgeHarness() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const mgr = new SignalBindingManager(store, registry);
  const conv = new Object3D();
  conv.name = 'C1';
  conv.userData.realvirtual = { LayoutObject: { Label: 'C1' }, Conveyor: {} };
  registry.registerNode('conv', conv);
  store.register(scopeSignalName('C1', 'Flow.Run'), 'conv/Flow.Run', false, 'PLCOutputBool');

  const created: GizmoHandle[] = [];
  const disposed = new Set<string>();
  const gizmoManager = {
    create: (): GizmoHandle => {
      const h: GizmoHandle = {
        id: `g${created.length}`, root: new Object3D(), update: () => {}, setVisible: () => {},
        dispose: () => disposed.add(`g${created.length}`),
      };
      created.push(h);
      return h;
    },
  } as unknown as GizmoOverlayManager;
  const planner: BadgePlannerLike = {
    store: { subscribe: () => () => {}, getSnapshot: () => ({ placed: [{ id: 'conv' }] }) },
    getPlacedRootById: (id) => (id === 'conv' ? conv : null),
    findPlacedAncestor: (n) => (n === conv ? { id: 'conv', root: conv } : null),
  };
  const viewer: BadgeViewerLike = {
    gizmoManager, registry, signalBindingManager: mgr,
    behaviors: { getActiveBinds: () => [] } as unknown as BadgeViewerLike['behaviors'],
    getPlugin: ((id: string) => (id === 'layout-planner' ? planner : undefined)) as BadgeViewerLike['getPlugin'],
    markRenderDirty: () => {},
    on: () => () => {},
  };
  const controller = new SignalBadgeController(viewer, planner);
  return { controller, created, disposed };
}

describe('badges follow the resting link mode', () => {
  beforeEach(() => {
    clearLiveControl();
    signalBindStore.clear();
    localStorage.clear();
    _resetSignalLinkModeStoreForTests();
  });
  afterEach(() => { _resetSignalLinkModeStoreForTests(); });

  it('badge in planner, none in des, back in planner', () => {
    const h = makeBadgeHarness();
    setSignalLinkModeExplicit(true);
    expect(h.created.length).toBeGreaterThanOrEqual(1);
    const live = h.created.length - h.disposed.size;
    expect(live).toBe(1);

    setSignalLinkModeSuspended(true); // mode → des
    expect(h.created.length - h.disposed.size).toBe(0);

    setSignalLinkModeSuspended(false); // mode → planner
    expect(h.created.length - h.disposed.size).toBe(1);
    h.controller.dispose();
  });
});

// ─── Effect: object tooltips ──────────────────────────────────────────────

const viewerForTooltips = {
  registry: { getNode: () => HOVER_NODE, getPathForNode: () => 'Cell/Conveyor' },
  selectionManager: { lastHitPoint: null },
} as unknown as RVViewer;

const shownHoverIds = () => tooltipStore.getSnapshot().visible
  .flatMap((bubble) => bubble.contentEntries.map((entry) => entry.id))
  .filter((id) => id.startsWith('tooltip-hover:'));

describe('object tooltips come back in DES although link mode is stored on', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetSignalLinkModeStoreForTests();
    tooltipRegistry.registerDataResolver('drive', () => ({ type: 'drive', driveName: 'Conveyor' }));
  });
  afterEach(() => {
    cleanup();
    setSignalLinkModeExplicit(false);
    setSignalLinkModeSuspended(false);
    for (const id of shownHoverIds()) tooltipStore.hide(id);
  });

  const ui = (
    <RVViewerProvider value={viewerForTooltips}><GenericTooltipController /></RVViewerProvider>
  );

  it('stands down in planner with link mode on, shows the card in des', () => {
    setSignalLinkModeExplicit(true);
    const view = render(ui);
    expect(shownHoverIds()).toEqual([]);

    setSignalLinkModeSuspended(true); // mode → des
    view.rerender(ui);
    expect(shownHoverIds().length).toBeGreaterThan(0);

    setSignalLinkModeSuspended(false); // mode → planner
    view.rerender(ui);
    expect(shownHoverIds()).toEqual([]);
  });
});
