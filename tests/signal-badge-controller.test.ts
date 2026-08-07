// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-badge-controller — plan-226 Phase 3 wiring.
 *
 * Verifies the 3D status-badge controller: badges appear only for placed
 * elements with bindable slots, only while signalLinkMode is on; clicking an
 * element opens the bind popover; toggling the mode / disposing cleans up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import {
  SignalBadgeController,
  type BadgeViewerLike,
  type BadgePlannerLike,
} from '../src/plugins/signal-bind/SignalBadgeController';
import { signalBindStore } from '../src/plugins/signal-bind/signal-bind-store';
import {
  _resetSignalLinkModeStoreForTests,
  getSignalLinkModeSnapshot,
  setSignalLinkModeExplicit,
} from '../src/plugins/signal-bind/signal-link-mode-store';
import {
  armSignalDrag,
  updateSignalDrag,
  cancelSignalDrag,
  consumeSignalDragClick,
  type SignalDragPayload,
} from '../src/core/hmi/signal-drag-store';
import type { GizmoHandle, GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';

/** A placed Conveyor exposes a bindable Flow.Run slot. */
function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = { LayoutObject: { Label: scope }, Conveyor: {} };
  registry.registerNode(scope, root);
  store.register(scopeSignalName(scope, 'Flow.Run'), `${scope}/Flow.Run`, false, 'PLCInputBool');
  return root;
}

/** A plain placed node with no rv components → no bindable slots. */
function makePlain(name: string): Object3D {
  const root = new Object3D();
  root.name = name;
  root.userData.realvirtual = { LayoutObject: { Label: name } };
  return root;
}

interface Harness {
  controller: SignalBadgeController;
  created: GizmoHandle[];
  disposed: Set<string>;
  emitClick: (node: Object3D) => void;
  setMode: (on: boolean) => void;
  nodes: Map<string, Object3D>;
  renderDirty: ReturnType<typeof vi.fn>;
  manager: SignalBindingManager;
  removePlaced: (id: string) => void;
}

const activeControllers: SignalBadgeController[] = [];

function makeHarness(placed: { id: string; node: Object3D }[]): Harness {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const mgr = new SignalBindingManager(store, registry);
  for (const p of placed) {
    registry.registerNode(p.id, p.node);
    const rv = p.node.userData.realvirtual as Record<string, unknown> | undefined;
    if (rv?.Conveyor || rv?.ConveyorBehavior) {
      store.register(scopeSignalName(p.node.name, 'Flow.Run'), `${p.id}/Flow.Run`, false, 'PLCOutputBool');
    }
  }

  const nodes = new Map(placed.map(p => [p.id, p.node] as const));
  const created: GizmoHandle[] = [];
  const disposed = new Set<string>();
  let idc = 0;

  const gizmoManager = {
    create: (_node: Object3D): GizmoHandle => {
      const id = `g${idc++}`;
      const h: GizmoHandle = {
        id,
        root: new Object3D(),
        update: () => {},
        setVisible: () => {},
        dispose: () => disposed.add(id),
      };
      created.push(h);
      return h;
    },
  } as unknown as GizmoOverlayManager;

  const listeners = new Set<() => void>();
  const planner: BadgePlannerLike = {
    store: {
      subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
      getSnapshot: () => ({ placed: placed.map(p => ({ id: p.id })) }),
    },
    getPlacedRootById: (id) => nodes.get(id) ?? null,
    findPlacedAncestor: (node) => {
      for (const [id, n] of nodes) if (n === node) return { id, root: n };
      return null;
    },
  };
  let clickCb: ((e: { node: Object3D }) => void) | null = null;
  const renderDirty = vi.fn();
  const viewer: BadgeViewerLike = {
    gizmoManager,
    registry,
    signalBindingManager: mgr,
    behaviors: { getActiveBinds: () => [] } as unknown as BadgeViewerLike['behaviors'],
    getPlugin: ((id: string) => id === 'layout-planner' ? planner : undefined) as BadgeViewerLike['getPlugin'],
    markRenderDirty: renderDirty,
    on: (_evt, cb) => { clickCb = cb as (e: { node: Object3D }) => void; return () => { clickCb = null; }; },
  };

  const controller = new SignalBadgeController(viewer, planner);
  activeControllers.push(controller);
  return {
    controller,
    created,
    disposed,
    emitClick: (node) => clickCb?.({ node }),
    setMode: (on) => setSignalLinkModeExplicit(on),
    nodes,
    renderDirty,
    manager: mgr,
    removePlaced: (id) => {
      const index = placed.findIndex(candidate => candidate.id === id);
      if (index >= 0) {
        placed[index].node.userData.realvirtual = {};
        placed.splice(index, 1);
      }
      for (const listener of listeners) listener();
    },
  };
}

describe('SignalBadgeController', () => {
  beforeEach(() => {
    clearLiveControl();
    signalBindStore.clear();
    localStorage.clear();
    _resetSignalLinkModeStoreForTests();
  });
  afterEach(() => {
    for (const controller of activeControllers.splice(0)) controller.dispose();
  });

  it('creates a badge only for elements with bindable slots, only when mode is on', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([
      { id: 'conv', node: conv },
      { id: 'plain', node: makePlain('Box') },
    ]);

    // Mode off initially → no badges.
    expect(h.created.length).toBe(0);

    h.setMode(true);
    // Conveyor (bindable) gets a badge; the plain box does not.
    expect(h.created.length).toBe(1);
  });

  it('removes all badges when the mode is turned off', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    h.setMode(true);
    expect(h.created.length).toBe(1);

    h.setMode(false);
    expect(h.disposed.size).toBe(1);
  });

  it('clicking a bindable element opens the bind popover', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    h.setMode(true);

    expect(signalBindStore.getSnapshot()).toBeNull();
    h.emitClick(conv);
    const target = signalBindStore.getSnapshot();
    expect(target?.placedId).toBe('conv');
  });

  it('does not open the popover while mode is off', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    // Mode never enabled → click handler is not even wired.
    h.emitClick(conv);
    expect(signalBindStore.getSnapshot()).toBeNull();
  });

  it('dispose tears down all badges', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    h.setMode(true);
    h.controller.dispose();
    expect(h.disposed.size).toBe(1);
  });

  it('marks render dirty on create and clear', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    h.setMode(true);
    expect(h.renderDirty).toHaveBeenCalledTimes(1);
    h.setMode(false);
    expect(h.renderDirty).toHaveBeenCalledTimes(2);
  });

  it('marks render dirty on state update and exposes a distinct pending label', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    h.setMode(true);
    h.manager.bind('conv', conv, {
      slot: 'Flow.Run',
      signal: 'Missing.CONNECT.Signal',
      direction: 'plcOutput',
      enabled: true,
    });
    expect(h.created[0].root.userData.rvSignalBadgeState).toBe('pending');
    expect(h.created[0].root.userData.rvSignalBadgeLabel).toContain('Pending');
    expect(h.renderDirty).toHaveBeenCalledTimes(2);
  });

  it('marks render dirty when a target is removed while mode stays active', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    h.setMode(true);
    h.removePlaced('conv');
    expect(h.disposed.size).toBe(1);
    expect(h.renderDirty).toHaveBeenCalledTimes(2);
  });
});

// ── plan-341 F17: no unfiltered plugs while a signal is dragged ──────────────
//
// Two marker layers used to run at once: the payload-FILTERED overlay
// (`enumerateCompatibleTargets`) and these persistent badges, built from
// `enumerateAllBindableTargets()`, which takes no payload and therefore cannot
// filter. The precise information drowned in the noise. The badges now step
// aside for the duration of the drag.
//
// The trap this pins: with the link mode explicitly ON, `active` stays `true`
// across drag start AND end, so a controller listening to the link mode alone
// is never notified and would keep every plug lit.

describe('SignalBadgeController — drag suppression (F17 acceptance matrix)', () => {
  beforeEach(() => {
    clearLiveControl();
    signalBindStore.clear();
    localStorage.clear();
    _resetSignalLinkModeStoreForTests();
    cancelSignalDrag();
    consumeSignalDragClick();
  });
  afterEach(() => {
    cancelSignalDrag();
    consumeSignalDragClick();
    for (const controller of activeControllers.splice(0)) controller.dispose();
  });

  const PAYLOAD: SignalDragPayload = {
    name: 'MC07_Start',
    direction: 'output',
    plcType: 'PLCOutputBool',
    origin: 'connect',
    interfaceId: 'iface-1',
  };

  /** Live badges = created minus disposed. */
  function liveBadges(h: { created: GizmoHandle[]; disposed: Set<string> }): number {
    return h.created.filter((handle) => !h.disposed.has(handle.id)).length;
  }

  function startDrag(): void {
    armSignalDrag(PAYLOAD, 100, 100);
    updateSignalDrag(140, 100);
  }

  it('explicit OFF: inactive → none, dragging → none, ended → none', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    expect(liveBadges(h)).toBe(0);
    startDrag();
    expect(liveBadges(h)).toBe(0);
    cancelSignalDrag();
    expect(liveBadges(h)).toBe(0);
  });

  it('explicit ON: inactive → all, dragging → none, ended → all again', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    h.setMode(true);
    expect(liveBadges(h)).toBe(1);

    startDrag();
    // The payload-filtered overlay is the ONLY marker layer now.
    expect(liveBadges(h)).toBe(0);

    cancelSignalDrag();
    expect(liveBadges(h)).toBe(1);
  });

  it('reacts to the drag phase, not to the link mode snapshot', () => {
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }]);
    h.setMode(true);
    const before = getSignalLinkModeSnapshot();
    startDrag();
    // `active` did not change — a link-mode-only listener would learn nothing.
    expect(getSignalLinkModeSnapshot()).toEqual(before);
    expect(liveBadges(h)).toBe(0);
  });

  it('drops no plugs on targets the dragged signal cannot reach', () => {
    // A Bool payload against an element with only a Float slot: the compatible
    // enumeration returns nothing, and no persistent badge fills the gap.
    const conv = makeConveyor(new SignalStore(), new NodeRegistry(), 'C1');
    const h = makeHarness([{ id: 'conv', node: conv }, { id: 'plain', node: makePlain('Box') }]);
    h.setMode(true);
    expect(liveBadges(h)).toBe(1);
    startDrag();
    expect(liveBadges(h)).toBe(0);
  });
});
