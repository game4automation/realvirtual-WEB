// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-path-aliases.test.ts — plan-381 §9.8–9.13.
 *
 * Node-path aliasing for nodes that Three.js renamed during its file-global
 * name dedup, and the diagnostics around path resolution:
 *
 *   9.8  alias registration covers the DESCENDANTS of a renamed node
 *   9.9  a placed/asset subtree gets those aliases too (node AND signal)
 *   9.10 an ambiguous suffix match refuses to guess
 *   9.11 aliases are torn down with their subtree
 *   9.12 a signal alias does not hijack the canonical name→path mapping
 *   9.13 an unresolved signal reference warns instead of failing silently
 *
 * See `doc-node-paths.md` for the semantics these tests pin down.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { registerNodeAliases, processExtras } from '../src/core/engine/rv-scene-loader';
import { RV_ORIG_NAME_KEY, collectRenamedNodes } from '../src/core/engine/rv-glb-parse';

// ─── Helpers ──────────────────────────────────────────────────────

/** Add a named child under `parent`. */
function child(parent: Object3D, name: string): Object3D {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  return node;
}

/** Register every node of a subtree under its canonical path. */
function registerAll(registry: NodeRegistry, root: Object3D): void {
  root.traverse((node) => {
    const path = NodeRegistry.computeNodePath(node);
    if (path) registry.registerNode(path, node);
  });
}

/**
 * The Mauser constellation: two `Pusher` siblings in different branches, so
 * Three.js dedups the second one to `Pusher_1` and every path THROUGH it that
 * the exporter wrote is broken.
 *
 *   Line
 *    ├─ Kinematics_MC06 ─ Pusher   ─ vertical
 *    └─ Kinematics_MC07 ─ Pusher_1 ─ vertical   (was: Pusher)
 */
function buildDedupedScene(): {
  scene: Scene;
  line: Object3D;
  renamedPusher: Object3D;
  vertical: Object3D;
} {
  const scene = new Scene();
  const line = child(scene, 'Line');

  const mc06 = child(line, 'Kinematics_MC06');
  const pusher06 = child(mc06, 'Pusher');
  child(pusher06, 'vertical');

  const mc07 = child(line, 'Kinematics_MC07');
  const renamedPusher = child(mc07, 'Pusher_1');
  const vertical = child(renamedPusher, 'vertical');

  return { scene, line, renamedPusher, vertical };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 9.8 — descendants of a renamed node ──────────────────────────

describe('9.8 alias registration covers descendants of a renamed node', () => {
  it('resolves a reference to a CHILD of a deduped node', () => {
    const { line, renamedPusher, vertical } = buildDedupedScene();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    registerAll(registry, line);

    // Sanity: the authored path is dead before aliasing — this is the defect.
    expect(registry.getNode('Line/Kinematics_MC07/Pusher/vertical')).toBeNull();

    registerNodeAliases(new Map([[renamedPusher, 'Pusher']]), registry, signalStore);

    // The renamed node itself (already worked before plan-381) …
    expect(registry.getNode('Line/Kinematics_MC07/Pusher')).toBe(renamedPusher);
    // … and its descendant (the actual fix).
    expect(registry.getNode('Line/Kinematics_MC07/Pusher/vertical')).toBe(vertical);
  });

  it('resolves a COMPONENT on a descendant through the alias path', () => {
    const { line, renamedPusher, vertical } = buildDedupedScene();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    registerAll(registry, line);

    const drive = { id: 'vertical-drive' };
    registry.register('Drive', NodeRegistry.computeNodePath(vertical), drive);

    registerNodeAliases(new Map([[renamedPusher, 'Pusher']]), registry, signalStore);

    expect(registry.getByPath('Drive', 'Line/Kinematics_MC07/Pusher/vertical')).toBe(drive);
  });

  it('leaves the untouched twin branch alone', () => {
    const { line, renamedPusher } = buildDedupedScene();
    const registry = new NodeRegistry();
    registerAll(registry, line);
    registerNodeAliases(new Map([[renamedPusher, 'Pusher']]), registry, new SignalStore());

    // MC06 was never renamed; its canonical path must still be its own node.
    const mc06Vertical = registry.getNode('Line/Kinematics_MC06/Pusher/vertical');
    expect(mc06Vertical).not.toBeNull();
    expect(NodeRegistry.computeNodePath(mc06Vertical!))
      .toBe('Line/Kinematics_MC06/Pusher/vertical');
  });

  it('visits every node at most once for NESTED renames', () => {
    // Grip is renamed INSIDE the renamed Pusher subtree. The traversal must
    // start at the topmost renamed node only, and the alias must spell BOTH
    // original names.
    const scene = new Scene();
    const line = child(scene, 'Line');
    const mc07 = child(line, 'Kinematics_MC07');
    const pusher = child(mc07, 'Pusher_1');
    const grip = child(pusher, 'Grip_2');
    const tip = child(grip, 'tip');

    const registry = new NodeRegistry();
    registerAll(registry, line);

    const visits = new Map<Object3D, number>();
    const realRegisterAlias = registry.registerAlias.bind(registry);
    vi.spyOn(registry, 'registerAlias').mockImplementation((aliasPath, node) => {
      visits.set(node, (visits.get(node) ?? 0) + 1);
      realRegisterAlias(aliasPath, node);
    });

    registerNodeAliases(
      new Map([[pusher, 'Pusher'], [grip, 'Grip']]),
      registry,
      new SignalStore(),
    );

    for (const count of visits.values()) expect(count).toBe(1);
    expect(registry.getNode('Line/Kinematics_MC07/Pusher/Grip/tip')).toBe(tip);
  });
});

// ─── 9.9 — placed / asset path ────────────────────────────────────

describe('9.9 placed asset gets subtree aliases too', () => {
  /**
   * A placed subtree is a CLONE of a cached parse result, so the parser's
   * Object3D-keyed rename map cannot travel with it. The pre-dedup name rides
   * along in `userData._rvOrigName` instead; `processExtras` rebuilds the map
   * from those stamps.
   */
  function buildPlacedAsset(): { scene: Scene; asset: Group; signalNode: Object3D } {
    const scene = new Scene();
    const asset = new Group();
    asset.name = 'Asset';
    scene.add(asset);

    const pusher = child(asset, 'Pusher_1');
    pusher.userData[RV_ORIG_NAME_KEY] = 'Pusher';

    const signals = child(pusher, 'Signals');
    const signalNode = child(signals, 'Fwd');
    signalNode.userData.realvirtual = {
      PLCOutputBool: { Name: 'Fwd', Status: { Value: false } },
    };

    return { scene, asset, signalNode };
  }

  it('collects the rename stamps a clone carries', () => {
    const { asset } = buildPlacedAsset();
    const clone = asset.clone(true);
    const renamed = collectRenamedNodes(clone);
    expect([...renamed.values()]).toEqual(['Pusher']);
  });

  it('aliases node AND signal paths through processExtras', () => {
    const { scene, asset, signalNode } = buildPlacedAsset();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();

    processExtras(asset, registry, signalStore, new RVTransportManager(), scene);

    // Node alias for a DESCENDANT of the renamed node.
    expect(registry.getNode('Asset/Pusher/Signals/Fwd')).toBe(signalNode);
    // Signal alias — the authored (pre-dedup) path resolves to the signal.
    expect(signalStore.nameForPath('Asset/Pusher/Signals/Fwd')).toBe('Fwd');
    // …while an unrelated path still does not.
    expect(signalStore.nameForPath('Asset/Nowhere/Signals/Fwd')).toBeUndefined();
  });

  it('keeps the CANONICAL path as the signal name mapping (F11)', () => {
    const { scene, asset } = buildPlacedAsset();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();

    processExtras(asset, registry, signalStore, new RVTransportManager(), scene);

    expect(signalStore.getPath('Fwd')).toBe('Asset/Pusher_1/Signals/Fwd');
    expect(signalStore.getType('Fwd')).toBe('PLCOutputBool');
  });
});

// ─── 9.10 — ambiguous suffix match ────────────────────────────────

describe('9.10 ambiguous suffix match refuses to guess', () => {
  /** Two same-named leaves in different cells, registered in a given order. */
  function buildTwoCells(order: 'A-first' | 'B-first'): {
    registry: NodeRegistry;
    a: Object3D;
    b: Object3D;
  } {
    const scene = new Scene();
    const cellA = child(scene, 'CellA');
    const cellB = child(scene, 'CellB');
    const a = child(child(cellA, 'PartA'), 'Signal');
    const b = child(child(cellB, 'PartA'), 'Signal');

    const registry = new NodeRegistry();
    const first = order === 'A-first' ? a : b;
    const second = order === 'A-first' ? b : a;
    registry.registerNode(NodeRegistry.computeNodePath(first), first);
    registry.registerNode(NodeRegistry.computeNodePath(second), second);
    return { registry, a, b };
  }

  for (const order of ['A-first', 'B-first'] as const) {
    it(`getNode returns null and warns (registration order: ${order})`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { registry } = buildTwoCells(order);

      expect(registry.getNode('PartA/Signal')).toBeNull();

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain('[NodeRegistry] Ambiguous suffix match for "PartA/Signal"');
      expect(message).toContain('2 candidates');
      expect(message).toContain('CellA/PartA/Signal');
      expect(message).toContain('CellB/PartA/Signal');
      expect(message).toContain('refusing to guess');
    });

    it(`getByPath returns null and warns (registration order: ${order})`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { registry } = buildTwoCells(order);
      registry.register('Drive', 'CellA/PartA/Signal', { id: 'a' });
      registry.register('Drive', 'CellB/PartA/Signal', { id: 'b' });

      expect(registry.getByPath('Drive', 'PartA/Signal')).toBeNull();
      expect(String(warn.mock.calls[0][0])).toContain('Ambiguous suffix match');
    });
  }

  it('still resolves an UNAMBIGUOUS suffix without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    const cell = child(scene, 'CellA');
    const leaf = child(child(cell, 'PartA'), 'Signal');
    const registry = new NodeRegistry();
    registerAll(registry, cell);

    expect(registry.getNode('PartA/Signal')).toBe(leaf);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not consider an ALIAS of the same node a competing candidate', () => {
    // The F5 subtree aliasing registers extra paths for the SAME object.
    // Ambiguity is judged over distinct nodes, so this must still resolve.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { line, renamedPusher, vertical } = buildDedupedScene();
    const registry = new NodeRegistry();
    registerAll(registry, line);
    registerNodeAliases(new Map([[renamedPusher, 'Pusher']]), registry, new SignalStore());

    // "Pusher_1/vertical" matches exactly one NODE (via its canonical path).
    expect(registry.getNode('Pusher_1/vertical')).toBe(vertical);
    expect(warn).not.toHaveBeenCalled();
  });

  it('only competing components of the REQUESTED type count as ambiguous', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new NodeRegistry();
    const scene = new Scene();
    const cellA = child(scene, 'CellA');
    const cellB = child(scene, 'CellB');
    registerAll(registry, cellA);
    registerAll(registry, cellB);
    const a = child(child(cellA, 'PartA'), 'Signal');
    const b = child(child(cellB, 'PartA'), 'Signal');
    registry.registerNode(NodeRegistry.computeNodePath(a), a);
    registry.registerNode(NodeRegistry.computeNodePath(b), b);

    const onlyOne = { id: 'a' };
    registry.register('Drive', 'CellA/PartA/Signal', onlyOne);
    registry.register('Sensor', 'CellB/PartA/Signal', { id: 'b' });

    expect(registry.getByPath('Drive', 'PartA/Signal')).toBe(onlyOne);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ─── 9.11 — alias lifecycle ───────────────────────────────────────

describe('9.11 aliases are removed with the subtree', () => {
  it('neither the canonical nor the alias path resolves after unregisterSubtree', () => {
    const { line, renamedPusher, vertical } = buildDedupedScene();
    const registry = new NodeRegistry();
    registerAll(registry, line);
    registerNodeAliases(new Map([[renamedPusher, 'Pusher']]), registry, new SignalStore());

    const aliasPath = 'Line/Kinematics_MC07/Pusher/vertical';
    const canonicalPath = 'Line/Kinematics_MC07/Pusher_1/vertical';
    expect(registry.getNode(aliasPath)).toBe(vertical);

    registry.unregisterSubtree(renamedPusher);

    expect(registry.getNode(canonicalPath)).toBeNull();
    expect(registry.getNode(aliasPath)).toBeNull();
  });

  it('does not leave the alias behind in the suffix index', () => {
    const scene = new Scene();
    const root = child(scene, 'Root');
    const node = child(root, 'Renamed_1');
    const registry = new NodeRegistry();
    registerAll(registry, root);
    registry.registerAlias('Root/Renamed', node);

    registry.unregisterSubtree(node);

    // A bare-leaf query goes through the suffix map; a leftover entry would
    // still hand out the detached node.
    expect(registry.getNode('Renamed')).toBeNull();
    expect(registry.getNode('Renamed_1')).toBeNull();
  });

  it('clear() drops alias tracking as well', () => {
    const scene = new Scene();
    const root = child(scene, 'Root');
    const node = child(root, 'Renamed_1');
    const registry = new NodeRegistry();
    registerAll(registry, root);
    registry.registerAlias('Root/Renamed', node);

    registry.clear();
    expect(registry.getNode('Root/Renamed')).toBeNull();

    // Re-registering the same object must not resurrect the old alias.
    registry.registerNode('Root/Renamed_1', node);
    registry.unregisterSubtree(node);
    expect(registry.getNode('Root/Renamed')).toBeNull();
  });
});

// ─── 9.12 — signal alias must stay additive ───────────────────────

describe('9.12 signal alias does not hijack the canonical name mapping', () => {
  it('registerPathAlias leaves nameToPath pointing at the canonical path', () => {
    const store = new SignalStore();
    store.register('Fwd', 'Cell/Axis_1/Signals/Fwd', false, 'PLCOutputBool');

    expect(store.registerPathAlias('Fwd', 'Cell/Axis/Signals/Fwd')).toBe(true);

    expect(store.getPath('Fwd')).toBe('Cell/Axis_1/Signals/Fwd');
    expect(store.nameForPath('Cell/Axis/Signals/Fwd')).toBe('Fwd');
    expect(store.getType('Fwd')).toBe('PLCOutputBool');
  });

  it('refuses to alias an unknown signal', () => {
    const store = new SignalStore();
    expect(store.registerPathAlias('NoSuchSignal', 'Some/Path')).toBe(false);
    expect(store.nameForPath('Some/Path')).toBeUndefined();
  });

  it('never overwrites a path already claimed by another signal', () => {
    const store = new SignalStore();
    store.register('A', 'Cell/A', false, 'PLCOutputBool');
    store.register('B', 'Cell/B', false, 'PLCOutputBool');

    expect(store.registerPathAlias('A', 'Cell/B')).toBe(false);
    expect(store.nameForPath('Cell/B')).toBe('B');
  });

  it('invalidates a negative resolve-cache entry for the alias path', () => {
    const store = new SignalStore();
    store.register('Fwd', 'Cell/Axis_1/Signals/Fwd', false, 'PLCOutputBool');

    // Probe first so the miss is cached, THEN alias.
    expect(store.nameForPath('Cell/Axis/Signals/Fwd')).toBeUndefined();
    store.registerPathAlias('Fwd', 'Cell/Axis/Signals/Fwd');
    expect(store.nameForPath('Cell/Axis/Signals/Fwd')).toBe('Fwd');
  });

  it('holds through the full registerNodeAliases path', () => {
    const scene = new Scene();
    const root = child(scene, 'Root');
    const axis = child(root, 'Axis_1');
    const signal = child(axis, 'Fwd');

    const registry = new NodeRegistry();
    const store = new SignalStore();
    registerAll(registry, root);
    store.register('Fwd', 'Root/Axis_1/Fwd', false, 'PLCOutputBool');

    registerNodeAliases(new Map([[axis, 'Axis']]), registry, store);

    expect(store.getPath('Fwd')).toBe('Root/Axis_1/Fwd');
    expect(store.nameForPath('Root/Axis/Fwd')).toBe('Fwd');
    expect(registry.getNode('Root/Axis/Fwd')).toBe(signal);
  });
});

// ─── 9.13 — loud signal fallback ──────────────────────────────────

describe('9.13 unresolved signal reference warns instead of silently falling back', () => {
  const signalRef: ComponentRef = {
    type: 'ComponentReference',
    path: 'Kinematics_MC07/Pusher/vertical',
    componentType: 'realvirtual.PLCOutputBool',
  };

  it('warns and still returns the raw path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new NodeRegistry();

    const result = registry.resolve(signalRef);

    // The raw path is still handed back — it MAY resolve in the SignalStore.
    expect(result.signalAddress).toBe('Kinematics_MC07/Pusher/vertical');

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('[NodeRegistry] Signal node not found');
    expect(message).toContain('Kinematics_MC07/Pusher/vertical');
    // Deliberately non-committal (plan-381 §3.2 / SOL finding 10).
    expect(message).toContain('may not be driven');
  });

  it('stays silent when the signal node resolves', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    const mc07 = child(scene, 'Kinematics_MC07');
    const node = child(child(mc07, 'Pusher'), 'vertical');
    const registry = new NodeRegistry();
    registerAll(registry, mc07);

    const result = registry.resolve(signalRef);

    expect(result.signalAddress).toBe(NodeRegistry.computeNodePath(node));
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when the node resolves through a subtree ALIAS', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { line, renamedPusher } = buildDedupedScene();
    const registry = new NodeRegistry();
    registerAll(registry, line);
    registerNodeAliases(new Map([[renamedPusher, 'Pusher']]), registry, new SignalStore());

    const result = registry.resolve({
      ...signalRef,
      path: 'Line/Kinematics_MC07/Pusher/vertical',
    });

    // Resolves to the CANONICAL path, not the authored alias.
    expect(result.signalAddress).toBe('Line/Kinematics_MC07/Pusher_1/vertical');
    expect(warn).not.toHaveBeenCalled();
  });
});
