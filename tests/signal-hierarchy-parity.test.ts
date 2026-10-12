// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Signal-hierarchy parity (Plan 197 F4 / §13).
 *
 * A signal declared via `self.signal()` (or `rv.signal()`) must be
 * indistinguishable from an rv_extras signal node: a synthetic Object3D under a
 * `Signals` container child of the bind root, carrying
 * `userData.realvirtual[sigType] = { Name, Status:{ Value } }`, registered in the
 * NodeRegistry (so the hierarchy badge resolves a path) and the SignalStore (by
 * the node path, with `path !== name`).
 *
 * Covers all five §13.3 aspects in one file (DRY shared setup):
 *   1. parity                — node + userData + registry + store.
 *   2. path-migration        — `path !== name`; get(name), getByPath(nodePath),
 *                              getByPath(shortName) after buildIndex().
 *   3. multi-instance        — two placements → unique scoped paths, no collision.
 *   4. registry-absent       — registry: null → no crash, store-only seed.
 *   5. dispose-cleanup       — disposeObject removes the synthetic registry paths.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { BehaviorManager, defineBehavior } from '../src/core/behaviors';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { BindContextHost } from '../src/core/behavior-runtime';

// ── Shared setup ─────────────────────────────────────────────────────────────

/** Host wired to the REAL SignalStore + NodeRegistry (full write surface). */
function makeHost(withRegistry: boolean): {
  host: BindContextHost;
  events: EventEmitter<Record<string, unknown>>;
  store: SignalStore;
  registry: NodeRegistry;
} {
  const events = new EventEmitter<Record<string, unknown>>();
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const host: BindContextHost = {
    signalStore: store,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: withRegistry ? registry : null,
    getPlugin: () => undefined, // no rv-extras-editor in tests → refresh is a no-op
  };
  return { host, events, store, registry };
}

/** A placed LayoutObject root (its name becomes the signal instance scope). */
function placedObject(name: string): Object3D {
  const o = new Object3D();
  o.name = name;
  o.userData._layoutId = `lid-${name}`;
  o.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'cat', Locked: false } };
  return o;
}

/** The materialised signal node `<root>/Signals/<name>` (undefined if absent). */
function signalNode(root: Object3D, name: string): Object3D | undefined {
  return root.children.find((c) => c.name === 'Signals')?.children.find((c) => c.name === name);
}

/** A behavior that declares two signals (one bool, one int). */
function signalBehavior() {
  return defineBehavior({
    models: ['*Conv*'],
    bind: (rv) => {
      rv.signal('My.Run', { type: 'PLCOutputBool', initialValue: true });
      rv.signal('My.Count', { type: 'PLCOutputInt', initialValue: 0 });
    },
  });
}

let manager: BehaviorManager;
beforeEach(() => { manager = new BehaviorManager(); });

// ── 1. Parity ────────────────────────────────────────────────────────────────

describe('signal-hierarchy parity — synthetic node, userData, registry, store', () => {
  it('materialises a Signals container + signal node indistinguishable from rv_extras', () => {
    manager.register('sig', signalBehavior());
    const { host, store, registry } = makeHost(true);
    const root = placedObject('Conv'); // scope = 'Conv'
    manager.attach(host, () => null, () => '/models/Scene.glb');
    manager.dispatchPlaced(root);

    // Synthetic, render-free Signals container under the bind root.
    const container = root.children.find((c) => c.name === 'Signals');
    expect(container).toBeDefined();
    expect((container!.userData as Record<string, unknown>)._rvSignals).toBe(true);

    // The signal node carries the rv_extras-shaped userData.
    const node = container!.children.find((c) => c.name === 'My.Run');
    expect(node).toBeDefined();
    const rv = (node!.userData.realvirtual as Record<string, unknown>);
    // plan-589: a GENERATED signal persists its ASSET-LOCAL name plus the
    // `Generated` flag; the scope ('Conv') is re-applied on load by
    // `resolveSignalName`, so it is never baked into the saved name.
    expect(rv.PLCOutputBool).toMatchObject({ Name: 'My.Run', Generated: true, Status: { Value: true } });

    // Registered in the NodeRegistry (hierarchy badge resolves a path).
    // The NODE path stays `/`-separated (technical address); only the symbol dots.
    expect(registry.getPathForNode(node!)).toBe('Conv/Signals/My.Run');
    // Live value resolves from the SignalStore by the node path.
    expect(store.getByPath('Conv/Signals/My.Run')).toBe(true);
  });

  it('does not double-append nodes on a re-bind (idempotent per container)', () => {
    manager.register('sig', signalBehavior());
    const { host } = makeHost(true);
    const root = placedObject('Conv');
    manager.attach(host, () => null, () => '/models/Scene.glb');

    manager.dispatchPlaced(root);
    manager.disposeObject(root); // does NOT remove the container Object3D from the graph
    manager.dispatchPlaced(root); // re-bind onto the same root

    const containers = root.children.filter((c) => c.name === 'Signals');
    expect(containers).toHaveLength(1);
    const runNodes = containers[0].children.filter((c) => c.name === 'My.Run');
    expect(runNodes).toHaveLength(1);
  });
});

// ── 2. Path migration (path !== name) ────────────────────────────────────────

describe('signal-path migration — path !== name', () => {
  it('registers the store under the node path, resolvable by name and by path', () => {
    manager.register('sig', signalBehavior());
    const { host, store } = makeHost(true);
    const root = placedObject('Conv');
    manager.attach(host, () => null, () => '/models/Scene.glb');
    manager.dispatchPlaced(root);

    // By scoped name (the canonical store key — dot-separated symbol).
    expect(store.get('Conv.My.Run')).toBe(true);
    // By the synthetic node path (path !== name).
    expect(store.getByPath('Conv/Signals/My.Run')).toBe(true);
    // By short name — resolved via the suffix index (buildIndex ran after materialise).
    expect(store.getByPath('My.Run')).toBe(true);
  });
});

// ── 3. Multi-instance ─────────────────────────────────────────────────────────

describe('signal multi-instance — unique scoped paths, no collision', () => {
  it('two placements of the same behavior get distinct signal node paths', () => {
    manager.register('sig', signalBehavior());
    const { host, store, registry } = makeHost(true);
    const a = placedObject('Conv');
    const b = placedObject('Conv_2');
    manager.attach(host, () => null, () => '/models/Scene.glb');
    manager.dispatchPlaced(a);
    manager.dispatchPlaced(b);

    const nodeA = signalNode(a, 'My.Run')!;
    const nodeB = signalNode(b, 'My.Run')!;

    expect(registry.getPathForNode(nodeA)).toBe('Conv/Signals/My.Run');
    expect(registry.getPathForNode(nodeB)).toBe('Conv_2/Signals/My.Run');
    expect(registry.getPathForNode(nodeA)).not.toBe(registry.getPathForNode(nodeB));

    // Independent store values per instance (no name collision).
    store.set('Conv.My.Run', false);
    expect(store.getByPath('Conv/Signals/My.Run')).toBe(false);
    expect(store.getByPath('Conv_2/Signals/My.Run')).toBe(true);
  });
});

// ── 4. Registry absent (graceful) ─────────────────────────────────────────────

describe('signal registry-absent graceful — registry: null', () => {
  it('does not crash and still seeds the store (no hierarchy node)', () => {
    manager.register('sig', signalBehavior());
    const { host, store } = makeHost(false); // registry: null
    const root = placedObject('Conv');
    manager.attach(host, () => null, () => '/models/Scene.glb');

    expect(() => manager.dispatchPlaced(root)).not.toThrow();

    // No synthetic container materialised…
    expect(root.children.find((c) => c.name === 'Signals')).toBeUndefined();
    // …but the store seed (path === name) still happened. With no registry to
    // materialise a node, path === the dot-scoped symbol name.
    expect(store.get('Conv.My.Run')).toBe(true);
    expect(store.getByPath('Conv.My.Run')).toBe(true);
  });
});

// ── 5. Dispose cleanup ─────────────────────────────────────────────────────────

describe('signal dispose-cleanup — no orphaned registry paths', () => {
  it('disposeObject unregisters the synthetic signal nodes from the NodeRegistry', () => {
    manager.register('sig', signalBehavior());
    const { host, registry } = makeHost(true);
    const root = placedObject('Conv');
    manager.attach(host, () => null, () => '/models/Scene.glb');
    manager.dispatchPlaced(root);

    const node = signalNode(root, 'My.Run')!;
    expect(registry.getPathForNode(node)).toBe('Conv/Signals/My.Run');
    expect(registry.getNode('Conv/Signals/My.Run')).toBe(node);

    manager.disposeObject(root);

    // The registry entries are gone (no leak); the Object3D leaves with root.
    expect(registry.getPathForNode(node)).toBeNull();
    expect(registry.getNode('Conv/Signals/My.Run')).toBeNull();
  });

  it('disposeAll unregisters synthetic signal nodes too (model reload/clear)', () => {
    manager.register('sig', signalBehavior());
    const { host, registry } = makeHost(true);
    const root = placedObject('Conv');
    manager.attach(host, () => null, () => '/models/Scene.glb');
    manager.dispatchPlaced(root);

    const node = signalNode(root, 'My.Run')!;
    expect(registry.getPathForNode(node)).not.toBeNull();

    manager.disposeAll();
    expect(registry.getPathForNode(node)).toBeNull();
  });
});
