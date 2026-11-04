// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 5c — the re-parent PREFIX alias of `NodeRegistry`
 * (`registerPrefixAlias`), against a real registry: a path INTO a subtree a
 * pre-bake hook re-parented resolves exactly under the moved node's new place,
 * as stage `alias` — chained through a moved node inside a moved subtree,
 * never ahead of an exact registration, never over a node registered later at
 * the authored path, never into another placement, and never for an editor move.
 */

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

function n(name: string, parent?: Object3D): Object3D {
  const o = new Object3D();
  o.name = name;
  parent?.add(o);
  return o;
}

function registerAll(registry: NodeRegistry, root: Object3D): void {
  root.traverse((o) => { if (o.parent) registry.registerNode(NodeRegistry.computeNodePath(o), o); });
}

/**
 * `Station/Plant/Grip/{Sensor/Beam, Jaw}` with `Grip` moved under
 * `Station/Kinematics/Y2`, the way the `Kinematic` hook moves a group member:
 * returns the moved node, its authored path and the registry.
 */
function stationWithMovedGrip(world = new Object3D(), rootName = 'Station') {
  const root = n(rootName, world);
  const plant = n('Plant', root);
  const kin = n('Kinematics', root);
  const y2 = n('Y2', kin);
  const grip = n('Grip', plant);
  const sensor = n('Sensor', grip);
  const beam = n('Beam', sensor);
  const jaw = n('Jaw', grip);
  const previousPath = NodeRegistry.computeNodePath(grip);
  y2.attach(grip);
  const registry = new NodeRegistry();
  registerAll(registry, world);
  // What `initSubtree` step 2b does with a `subtree: true` alias.
  expect(registry.registerAlias(previousPath, grip)).toBe(true);
  expect(registry.registerPrefixAlias(previousPath, grip)).toBe(true);
  registry.registerScopeNames(root, []);
  return { world, root, plant, y2, grip, sensor, beam, jaw, previousPath, registry };
}

const transformRef = (path: string) => ({ path, componentType: 'UnityEngine.Transform' });

describe('NodeRegistry prefix alias (plan-610 Phase 5c)', () => {
  it('a child path under the moved node resolves as alias, exactly', () => {
    const { registry, grip, sensor, beam, jaw, root } = stationWithMovedGrip();
    expect(registry.getNode('Station/Plant/Grip')).toBe(grip);
    expect(registry.getNode('Station/Plant/Grip/Sensor')).toBe(sensor);
    expect(registry.getNode('Station/Plant/Grip/Sensor/Beam')).toBe(beam);
    expect(registry.getNode('Station/Plant/Grip/Jaw')).toBe(jaw);
    // Scoped, asset-relative as the GLB writes it: regular stage, not a rescue.
    const hit = registry.resolveWithStage(transformRef('Plant/Grip/Sensor'), 'UnityEngine.Transform', root);
    expect(hit?.node).toBe(sensor);
    expect(hit?.stage).toBe('alias');
    // resolve() and the signal resolver see it too.
    expect(registry.resolve({ type: 'ComponentReference', ...transformRef('Plant/Grip/Sensor/Beam') }, root).node).toBe(beam);
    expect(registry.resolveSignalReference('Plant/Grip/Jaw', root)).toEqual({
      path: 'Station/Kinematics/Y2/Grip/Jaw', resolved: true, byName: false,
    });
  });

  it('no suffix or name guessing below the prefix: a missing child stays unresolved', () => {
    const { registry, root } = stationWithMovedGrip();
    expect(registry.getNode('Station/Plant/Grip/Nope')).toBeNull();
    // `Sensor/Beam` exists, `Beam` alone is not a child of Grip.
    expect(registry.getNode('Station/Plant/Grip/Beam')).toBeNull();
    // The scoped name fallback may still find a `Beam`, but only as a rescue.
    const hit = registry.resolveWithStage(transformRef('Plant/Grip/Beam'), 'UnityEngine.Transform', root);
    expect(hit?.stage).toBe('name-in-scope');
  });

  it('a typed lookup by the authored child path finds the component as alias', () => {
    const { registry, sensor } = stationWithMovedGrip();
    const sensorPath = registry.getPathForNode(sensor)!;
    const instance = { kind: 'sensor' };
    registry.register('Sensor', sensorPath, instance);
    expect(registry.getByPath('Sensor', 'Station/Plant/Grip/Sensor')).toBe(instance);
    const hit = registry.resolveWithStage(transformRef('Station/Plant/Grip/Sensor'), 'realvirtual.Sensor', null);
    expect(hit?.node).toBe(sensor);
    expect(hit?.stage).toBe('alias');
  });

  it('chains: a moved node inside a moved subtree (outer moved first)', () => {
    const world = new Object3D();
    const root = n('Station', world);
    const a = n('A', root);
    const x = n('X', a);
    const inner = n('Inner', x);
    const leaf = n('Leaf', inner);
    const k1 = n('K1', root);
    const k2 = n('K2', root);
    const prevA = NodeRegistry.computeNodePath(a); // Station/A
    k1.attach(a);
    const prevInner = NodeRegistry.computeNodePath(inner); // Station/K1/A/X/Inner (post-move path)
    k2.attach(inner);
    const registry = new NodeRegistry();
    registerAll(registry, world);
    for (const [p, node] of [[prevA, a], [prevInner, inner]] as const) {
      registry.registerAlias(p, node);
      registry.registerPrefixAlias(p, node);
    }
    expect(registry.getNode('Station/A/X')).toBe(x);
    expect(registry.getNode('Station/A/X/Inner')).toBe(inner);
    expect(registry.getNode('Station/A/X/Inner/Leaf')).toBe(leaf);
    expect(registry.getNode('Station/K1/A/X/Inner/Leaf')).toBe(leaf);
  });

  it('chains: a moved node inside a moved subtree (inner moved first)', () => {
    const world = new Object3D();
    const root = n('Station', world);
    const a = n('A', root);
    const x = n('X', a);
    const inner = n('Inner', x);
    const leaf = n('Leaf', inner);
    const k1 = n('K1', root);
    const k2 = n('K2', root);
    const prevInner = NodeRegistry.computeNodePath(inner); // Station/A/X/Inner
    k2.attach(inner);
    const prevA = NodeRegistry.computeNodePath(a);
    k1.attach(a);
    const registry = new NodeRegistry();
    registerAll(registry, world);
    for (const [p, node] of [[prevInner, inner], [prevA, a]] as const) {
      registry.registerAlias(p, node);
      registry.registerPrefixAlias(p, node);
    }
    expect(registry.getNode('Station/A/X')).toBe(x);
    expect(registry.getNode('Station/A/X/Inner/Leaf')).toBe(leaf);
  });

  it('an exact registration always wins over the prefix alias', () => {
    const { registry, root, previousPath } = stationWithMovedGrip();
    // A real node that happens to sit at `<authored>/Sensor` — registered as itself.
    const plant = root.getObjectByName('Plant')!;
    const lookalike = n('Grip', plant);
    const lookSensor = n('Sensor', lookalike);
    registry.registerNode(`${previousPath}/Sensor`, lookSensor);
    expect(registry.getNode(`${previousPath}/Sensor`)).toBe(lookSensor);
  });

  it('never shadows a node registered later at the authored path', () => {
    const { registry, plant, previousPath, jaw } = stationWithMovedGrip();
    expect(registry.getNode(`${previousPath}/Jaw`)).toBe(jaw);
    // A new node takes the authored path (e.g. created by an edit after the load).
    const fresh = n('Grip', plant);
    registry.registerNode(previousPath, fresh);
    expect(registry.getNode(previousPath)).toBe(fresh);
    // Its missing children are a miss — never the moved node's children.
    expect(registry.getNode(`${previousPath}/Jaw`)).toBeNull();
  });

  it('is refused where a different node owns the path canonically; re-registering is idempotent', () => {
    const { registry, grip, previousPath } = stationWithMovedGrip();
    const other = new Object3D();
    expect(registry.registerPrefixAlias('Station/Kinematics', other)).toBe(false);
    expect(registry.registerPrefixAlias(previousPath, grip)).toBe(true); // idempotent
    expect(registry.prefixAliasCount()).toBe(1);
    expect(registry.ambiguousPrefixAliasPaths()).toEqual([]);
  });

  /**
   * Two moved siblings with the same name share ONE authored path. Whichever is
   * registered first must not decide the result: the path is ambiguous, names
   * neither node (exact alias and prefix alias), and says so with a warning.
   */
  describe('identical authored paths (two moved nodes)', () => {
    function twoMovedGrips(order: 'ab' | 'ba') {
      const world = new Object3D();
      const root = n('Station', world);
      const plant = n('Plant', root);
      const kin = n('Kinematics', root);
      const y2 = n('Y2', kin);
      const y3 = n('Y3', kin);
      const a = n('Grip', plant);
      const aSensor = n('Sensor', a);
      const b = n('Grip', plant);
      const bSensor = n('Sensor', b);
      const previousPath = NodeRegistry.computeNodePath(a);
      expect(NodeRegistry.computeNodePath(b)).toBe(previousPath);
      y2.attach(a);
      y3.attach(b);
      const registry = new NodeRegistry();
      registerAll(registry, world);
      // `initSubtree` step 2b per alias entry: exact alias, then prefix alias.
      for (const node of order === 'ab' ? [a, b] : [b, a]) {
        registry.registerAlias(previousPath, node);
        registry.registerPrefixAlias(previousPath, node);
      }
      registry.registerScopeNames(root, []);
      return { registry, root, a, b, aSensor, bSensor, previousPath };
    }
    const outcome = (s: ReturnType<typeof twoMovedGrips>) => {
      const name = (o: Object3D | null) => (o === s.a ? 'a' : o === s.b ? 'b' : o === s.aSensor ? 'aSensor' : o === s.bSensor ? 'bSensor' : o === null ? null : 'other');
      const exactHit = s.registry.resolveWithStage(transformRef('Plant/Grip/Sensor'), 'UnityEngine.Transform', s.root);
      return {
        alias: name(s.registry.getNode(s.previousPath)),
        child: name(s.registry.getNode(`${s.previousPath}/Sensor`)),
        refStage: exactHit?.stage === 'exact' || exactHit?.stage === 'alias' ? exactHit.stage : 'not-exact',
        ambiguous: s.registry.ambiguousPrefixAliasPaths(),
        prefixCount: s.registry.prefixAliasCount(),
      };
    };

    it('the result does not depend on the registration order', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const ab = outcome(twoMovedGrips('ab'));
        const ba = outcome(twoMovedGrips('ba'));
        expect(ab).toEqual(ba);
      } finally {
        warn.mockRestore();
      }
    });

    it('an ambiguous path names neither node and is reported, never silent', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const s = twoMovedGrips('ab');
        const o = outcome(s);
        expect(o.alias).toBeNull();
        expect(o.child).toBeNull();
        expect(o.refStage).toBe('not-exact');
        expect(o.ambiguous).toEqual(['Station/Plant/Grip']);
        expect(o.prefixCount).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('"Station/Plant/Grip"');
        expect(String(warn.mock.calls[0][0])).toContain('Station/Kinematics/Y2/Grip');
        expect(String(warn.mock.calls[0][0])).toContain('Station/Kinematics/Y3/Grip');
        // Unambiguous neighbours keep working.
        expect(s.registry.getNode('Station/Kinematics/Y2/Grip/Sensor')).toBe(s.aSensor);
      } finally {
        warn.mockRestore();
      }
    });

    it('the ambiguity goes with its claimants on unregisterSubtree and clear', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const s = twoMovedGrips('ab');
        s.registry.unregisterSubtree(s.a.parent!);
        expect(s.registry.ambiguousPrefixAliasPaths()).toEqual(['Station/Plant/Grip']);
        s.registry.unregisterSubtree(s.b.parent!);
        expect(s.registry.ambiguousPrefixAliasPaths()).toEqual([]);
        const t = twoMovedGrips('ba');
        t.registry.clear();
        expect(t.registry.ambiguousPrefixAliasPaths()).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('stays inside its placement: the same authored path in two placements', () => {
    const world = new Object3D();
    const layout = n('Layout', world);
    const one = stationWithMovedGrip(new Object3D(), 'Machine_1');
    const two = stationWithMovedGrip(new Object3D(), 'Machine_2');
    layout.add(one.root, two.root);
    const registry = new NodeRegistry();
    registerAll(registry, world);
    for (const s of [one, two]) {
      const prev = `Layout/${s.previousPath}`;
      registry.registerAlias(prev, s.grip);
      registry.registerPrefixAlias(prev, s.grip);
      registry.registerScopeNames(s.root, ['Machine']);
    }
    expect(registry.getNode('Layout/Machine_1/Plant/Grip/Sensor')).toBe(one.sensor);
    expect(registry.getNode('Layout/Machine_2/Plant/Grip/Sensor')).toBe(two.sensor);
    // Asset-relative and root-prefixed spellings, each in its own scope.
    expect(registry.resolveWithStage(transformRef('Plant/Grip/Sensor'), 'UnityEngine.Transform', one.root)?.node).toBe(one.sensor);
    expect(registry.resolveWithStage(transformRef('Machine/Plant/Grip/Sensor'), 'UnityEngine.Transform', two.root)?.node).toBe(two.sensor);
    // Without the instance root in front the prefix names nothing (no cross-placement guess).
    expect(registry.getNode('Plant/Grip/Sensor/Beam')).toBeNull();
  });

  it('goes with its node on unregisterSubtree and clear', () => {
    const { registry, root, previousPath, y2 } = stationWithMovedGrip();
    registry.unregisterSubtree(y2);
    expect(registry.prefixAliasCount()).toBe(0);
    expect(registry.getNode(`${previousPath}/Sensor`)).toBeNull();
    const again = stationWithMovedGrip();
    again.registry.clear();
    expect(again.registry.prefixAliasCount()).toBe(0);
    expect(root).toBeDefined();
  });

  it('an editor move (path re-key) registers no prefix alias: the old path is gone', () => {
    const world = new Object3D();
    const root = n('Station', world);
    const plant = n('Plant', root);
    const target = n('Target', root);
    const grip = n('Grip', plant);
    n('Sensor', grip);
    const registry = new NodeRegistry();
    registerAll(registry, world);
    // What `rv-asset-executors.ts` `_move` does: re-parent, then re-key the subtree paths.
    target.attach(grip);
    registry.recomputePathsForSubtrees([grip]);
    expect(registry.prefixAliasCount()).toBe(0);
    expect(registry.getNode('Station/Plant/Grip')).toBeNull();
    expect(registry.getNode('Station/Plant/Grip/Sensor')).toBeNull();
    expect(registry.getNode('Station/Target/Grip/Sensor')).not.toBeNull();
  });

  it('a load-time prefix alias follows a later editor move of the moved node', () => {
    const { registry, root, grip, sensor, previousPath } = stationWithMovedGrip();
    const elsewhere = n('Elsewhere', root);
    registry.registerNode('Station/Elsewhere', elsewhere);
    elsewhere.attach(grip);
    registry.recomputePathsForSubtrees([grip]);
    // Same contract as the exact alias of the moved node: it names the node, wherever it is.
    expect(registry.getNode(previousPath)).toBe(grip);
    expect(registry.getNode(`${previousPath}/Sensor`)).toBe(sensor);
  });
});
