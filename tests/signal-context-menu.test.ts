// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-418 9.6 — "Link signal…" on hierarchy-tree signal rows.
 *
 * The two contract points this suite defends, both from the plan's
 * Entscheidungs-Log:
 *  - the EXACT clicked node decides; `findSignalBindTarget`'s ancestor climb
 *    must never silently turn a right-click on a mesh into a bind on the drive
 *    around it;
 *  - a fail-closed slot produces NO item (the menu has no disabled state), and
 *    the reason stays visible in the inspector row instead.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { ContextMenuStore, type ContextMenuTarget } from '../src/core/hmi/context-menu-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { registerSignal } from '../src/core/engine/rv-signal-construction';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import {
  resolvePLCBindMenuTarget,
  SIGNAL_BIND_MENU_PLUGIN_ID,
  signalBindContextMenuItems,
} from '../src/plugins/signal-bind/plc-signal-context-menu';
import { signalBindStore, closeSignalBindPopover } from '../src/plugins/signal-bind/signal-bind-store';
import type { RVViewer } from '../src/core/rv-viewer';

const ITEM_ID = 'signal-bind.link-signal';

interface Fixture {
  scene: Scene;
  root: Object3D;
  registry: NodeRegistry;
  store: SignalStore;
  manager: SignalBindingManager;
  viewer: RVViewer;
  menu: ContextMenuStore;
}

function fixture(planner?: unknown): Fixture {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'DemoCell';
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('DemoCell', root);
  const manager = new SignalBindingManager(store, registry);
  const menu = new ContextMenuStore();
  const viewer = {
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined),
    contextMenu: menu,
  } as unknown as RVViewer;
  return { scene, root, registry, store, manager, viewer, menu };
}

function addSignal(
  f: Fixture,
  parent: Object3D,
  parentPath: string,
  name: string,
  opts: { signalName?: string; register?: boolean } = {},
) {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  const path = `${parentPath}/${name}`;
  const sigData = { Name: opts.signalName ?? name, Status: { Value: false } };
  node.userData.realvirtual = { PLCOutputBool: sigData };
  f.registry.registerNode(path, node);
  if (opts.register !== false) registerSignal(node, 'PLCOutputBool', sigData, path, f.store, f.registry);
  return { node, path };
}

function menuTarget(f: Fixture, node: Object3D, path: string): ContextMenuTarget {
  return {
    path,
    node,
    types: f.registry.getComponentTypes(path),
    extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
  };
}

function openIds(f: Fixture, target: ContextMenuTarget): string[] {
  f.menu.open({ x: 10, y: 10 }, target);
  const snap = f.menu.getSnapshot();
  const ids = snap.open ? snap.items.map((i) => i.id) : [];
  f.menu.close();
  return ids;
}

beforeEach(resetSlotAuthority);
afterEach(() => { closeSignalBindPopover(); resetSlotAuthority(); });

describe('resolvePLCBindMenuTarget', () => {
  it('resolves a free, registered signal node to itself', () => {
    const f = fixture();
    const sig = addSignal(f, f.root, 'DemoCell', 'Start');
    f.store.buildIndex();

    const resolved = resolvePLCBindMenuTarget(f.viewer, menuTarget(f, sig.node, sig.path));

    expect(resolved).not.toBeNull();
    expect(resolved!.target).toMatchObject({ kind: 'node', nodePath: sig.path });
    expect(resolved!.label).toBe('Link signal…');
  });

  it('returns null for a node that is not a signal at all', () => {
    const f = fixture();
    const plain = new Object3D();
    plain.name = 'Housing';
    f.root.add(plain);
    f.registry.registerNode('DemoCell/Housing', plain);
    f.store.buildIndex();

    expect(resolvePLCBindMenuTarget(f.viewer, menuTarget(f, plain, 'DemoCell/Housing'))).toBeNull();
  });

  it('returns null for an unregistered signal (fail-closed, no ancestor fallback)', () => {
    const f = fixture();
    // A bindable neighbour exists, so an ancestor climb would find SOMETHING —
    // it still must not.
    addSignal(f, f.root, 'DemoCell', 'Start');
    const ghost = addSignal(f, f.root, 'DemoCell', 'Ghost', { register: false });
    f.store.buildIndex();

    expect(resolvePLCBindMenuTarget(f.viewer, menuTarget(f, ghost.node, ghost.path))).toBeNull();
  });

  it('returns null for both partners of a signal-name collision', () => {
    const f = fixture();
    const a = addSignal(f, f.root, 'DemoCell', 'StartA', { signalName: 'Start' });
    const b = addSignal(f, f.root, 'DemoCell', 'StartB', { signalName: 'Start' });
    f.store.buildIndex();

    expect(resolvePLCBindMenuTarget(f.viewer, menuTarget(f, a.node, a.path))).toBeNull();
    expect(resolvePLCBindMenuTarget(f.viewer, menuTarget(f, b.node, b.path))).toBeNull();
  });

  it('names the placement when the signal binds through one', () => {
    const f0 = fixture();
    const planner = {
      findPlacedAncestor: (node: Object3D) => {
        for (let cur: Object3D | null = node; cur; cur = cur.parent) {
          if (cur === f0.root) return { id: 'placed-cell', root: f0.root };
        }
        return null;
      },
    };
    const f = { ...f0, viewer: { ...f0.viewer, getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined) } as unknown as RVViewer };
    const sig = addSignal(f, f.root, 'DemoCell', 'Start');
    f.store.buildIndex();

    const resolved = resolvePLCBindMenuTarget(f.viewer, menuTarget(f, sig.node, sig.path));

    expect(resolved!.target.kind).toBe('placed');
    expect(resolved!.label).toBe('Link signal… (on DemoCell)');
  });
});

describe('context-menu item', () => {
  it('appears only on the signal row, not on a plain sibling', () => {
    const f = fixture();
    const sig = addSignal(f, f.root, 'DemoCell', 'Start');
    const plain = new Object3D();
    plain.name = 'Housing';
    f.root.add(plain);
    f.registry.registerNode('DemoCell/Housing', plain);
    f.store.buildIndex();
    f.menu.register({ pluginId: SIGNAL_BIND_MENU_PLUGIN_ID, items: signalBindContextMenuItems(f.viewer) });

    expect(openIds(f, menuTarget(f, sig.node, sig.path))).toEqual([ITEM_ID]);
    expect(openIds(f, menuTarget(f, plain, 'DemoCell/Housing'))).toEqual([]);
  });

  it('shows NO item for an unavailable slot (menu has no disabled state)', () => {
    const f = fixture();
    const a = addSignal(f, f.root, 'DemoCell', 'StartA', { signalName: 'Start' });
    addSignal(f, f.root, 'DemoCell', 'StartB', { signalName: 'Start' });
    f.store.buildIndex();
    f.menu.register({ pluginId: SIGNAL_BIND_MENU_PLUGIN_ID, items: signalBindContextMenuItems(f.viewer) });

    expect(openIds(f, menuTarget(f, a.node, a.path))).toEqual([]);
  });

  it('opens the bind popover for the exact node', () => {
    const f = fixture();
    const sig = addSignal(f, f.root, 'DemoCell', 'Start');
    f.store.buildIndex();
    f.menu.register({ pluginId: SIGNAL_BIND_MENU_PLUGIN_ID, items: signalBindContextMenuItems(f.viewer) });

    const target = menuTarget(f, sig.node, sig.path);
    f.menu.open({ x: 5, y: 5 }, target);
    const item = f.menu.getSnapshot().items.find((i) => i.id === ITEM_ID);
    item!.action!(target);

    expect(signalBindStore.getSnapshot()).toMatchObject({ kind: 'node', nodePath: sig.path });
  });
});

describe('plugin lifecycle', () => {
  it('registers in init() and unregisters in dispose(), with no double entry on re-init', () => {
    const f = fixture();
    const sig = addSignal(f, f.root, 'DemoCell', 'Start');
    f.store.buildIndex();
    const plugin = new SignalBindPlugin();

    plugin.init(f.viewer);
    expect(openIds(f, menuTarget(f, sig.node, sig.path))).toEqual([ITEM_ID]);

    plugin.dispose();
    expect(openIds(f, menuTarget(f, sig.node, sig.path))).toEqual([]);

    // Re-init on the same store: exactly ONE item again (register() replaces
    // per pluginId, and dispose() removed the stale closure).
    plugin.init(f.viewer);
    expect(openIds(f, menuTarget(f, sig.node, sig.path))).toEqual([ITEM_ID]);
    plugin.dispose();
  });
});
