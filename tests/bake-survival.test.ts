// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.1 — the survival set of `computeSurvival` (D4).
 *
 * On a synthetic tree: a component node, a referenced bare node, a `Snap-*`
 * empty, the ancestor chain of a deep survivor and a keep mesh survive;
 * unclaimed leaves and groups are removal tops; every reason is the right one.
 * `computeSurvival` is read-only.
 */
import { describe, it, expect } from 'vitest';
import type { Object3D } from 'three';
// Pull in every component registration (Drive, Lamp, EnergyChain, …).
import '../src/core/engine/rv-scene-loader';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { computeSurvival } from '../src/core/engine/rv-bake-survival';
import { group, uberMesh, withComponent } from './fixtures/bake-fixture';
import { expectNoClaimedNodeRemoved, pathFromRoot, refTo, registryFor, survivalFateOf } from './helpers/bake-survival';

const uber = new RVUberMaterial(false);

/**
 *   Asset
 *   ├─ Frame                     bare group            → removal top
 *   │   └─ plate                 bare mesh             → removed with Frame
 *   ├─ DriveA {Drive}            component
 *   │   ├─ Housing               bare group            → removal top
 *   │   │   └─ shell             bare mesh
 *   │   └─ arm                   bare mesh             → removal top
 *   ├─ Deep / Mid                bare groups           → ancestors
 *   │        └─ Eye {Sensor}     component
 *   ├─ Beacon {Lamp}             component (keep)
 *   │   └─ glass                 bare mesh, role keep  → keep-mesh
 *   ├─ Snap-ZN-conv              empty                 → snap
 *   ├─ Anchor                    bare group            → referenced (EnergyChain.Anchor)
 *   ├─ Track {EnergyChain}       component
 *   ├─ hiddenPart                bare mesh, invisible  → keep-mesh (the bake keeps hidden meshes)
 *   └─ looseLeaf                 bare mesh             → removal top
 */
function buildTree() {
  const root = group('Asset');
  const frame = group('Frame'); const plate = uberMesh(uber, 'plate'); frame.add(plate);
  const driveA = withComponent(group('DriveA'), 'Drive');
  const housing = group('Housing'); const shell = uberMesh(uber, 'shell'); housing.add(shell);
  const arm = uberMesh(uber, 'arm', [2, 0, 0]);
  driveA.add(housing, arm);
  const deep = group('Deep'); const mid = group('Mid');
  const eye = withComponent(group('Eye'), 'Sensor');
  deep.add(mid); mid.add(eye);
  const beacon = withComponent(group('Beacon'), 'Lamp');
  const glass = uberMesh(uber, 'glass', [4, 0, 0]); beacon.add(glass);
  const snap = group('Snap-ZN-conv');
  const anchor = group('Anchor');
  const track = withComponent(group('Track'), 'EnergyChain', { Anchor: refTo('Asset/Anchor') });
  const hiddenPart = uberMesh(uber, 'hiddenPart', [6, 0, 0]); hiddenPart.visible = false;
  const looseLeaf = uberMesh(uber, 'looseLeaf', [8, 0, 0]);
  root.add(frame, driveA, deep, beacon, snap, anchor, track, hiddenPart, looseLeaf);
  return { root, frame, plate, driveA, housing, shell, arm, deep, mid, eye, beacon, glass, snap, anchor, track, hiddenPart, looseLeaf };
}

describe('computeSurvival — survival set (plan-754 §9.1)', () => {
  it('gives every node the right reason', () => {
    const t = buildTree();
    const model = computeSurvival(t.root, registryFor(t.root));
    const fate = (n: Object3D) => survivalFateOf(model, n);
    expect(fate(t.root)).toBe('root');
    expect(fate(t.driveA)).toBe('component');
    expect(fate(t.eye)).toBe('component');
    expect(fate(t.beacon)).toBe('component');
    expect(fate(t.track)).toBe('component');
    expect(fate(t.anchor)).toBe('referenced');
    expect(fate(t.snap)).toBe('snap');
    expect(fate(t.deep)).toBe('ancestor');
    expect(fate(t.mid)).toBe('ancestor');
    expect(fate(t.glass)).toBe('keep-mesh');
    expect(fate(t.hiddenPart)).toBe('keep-mesh');
    for (const n of [t.frame, t.plate, t.housing, t.shell, t.arm, t.looseLeaf]) {
      expect(fate(n), n.name).toBe('removed');
      expect(model.survives(n), n.name).toBe(false);
    }
  });

  it('removal tops are the highest removed nodes only', () => {
    const t = buildTree();
    const model = computeSurvival(t.root, registryFor(t.root));
    const tops = model.removalTops.map((n) => pathFromRoot(n, t.root)).sort();
    expect(tops).toEqual(['Asset/DriveA/Housing', 'Asset/DriveA/arm', 'Asset/Frame', 'Asset/looseLeaf']);
    // plate / shell go with their top — they are not tops of their own.
    expect(model.removalTops).not.toContain(t.plate);
    expect(model.removalTops).not.toContain(t.shell);
  });

  it('counts add up', () => {
    const t = buildTree();
    const model = computeSurvival(t.root, registryFor(t.root));
    let nodes = 0;
    t.root.traverse(() => { nodes++; });
    const c = model.counts;
    expect(c.nodes).toBe(nodes);
    expect(c.survivors + c.removed).toBe(nodes);
    expect(c.removed).toBe(6);
    // plate, shell, arm, looseLeaf are drawables in the removal set.
    expect(c.removedMeshes).toBe(4);
    expect(c.mergedSurvivorMeshes).toBe(0);
    expect(c.unresolvedReferences).toBe(0);
    expect(c.unresolvedClaims).toBe(0);
    expect(c.instancedTriangles).toBe(0);
    expect(c.tagOnlyChunkBoundaries).toBe(0);
    // Each staged box has its own geometry and no keep mesh shares it.
    expect(c.releasableGeometries).toBe(4);
  });

  it('a component ON a mesh survives as a merged survivor mesh ("keep the node, delete the mesh")', () => {
    const root = group('Asset');
    const info = withComponent(uberMesh(uber, 'Info'), 'RuntimeMetadata', { Content: 'x' });
    root.add(info);
    const model = computeSurvival(root, registryFor(root));
    expect(model.reasonOf(info)).toBe('component');
    expect(model.counts.mergedSurvivorMeshes).toBe(1);
    expect(model.counts.removed).toBe(0);
  });

  it('Unity export markers alone make no survivor; an authored rv.BakeRole does', () => {
    const root = group('Asset');
    const marked = uberMesh(uber, 'marked');
    marked.userData.realvirtual = { renderer: { enabled: true }, colliders: [{ type: 'BoxCollider' }] };
    const authored = uberMesh(uber, 'authored', [2, 0, 0]);
    authored.userData.realvirtual = { BakeRole: 'merge' };
    root.add(marked, authored);
    const model = computeSurvival(root, registryFor(root));
    expect(model.survives(marked)).toBe(false);
    expect(model.reasonOf(authored)).toBe('component');
    expect(model.roleOf(authored)).toBe('merge');
  });

  it('a config block of an unknown component type survives (conservative)', () => {
    const root = group('Asset');
    const odd = withComponent(group('Odd'), 'SomeCustomerComponent', { Value: 1 });
    root.add(odd);
    const model = computeSurvival(root, registryFor(root));
    expect(model.reasonOf(odd)).toBe('component');
  });

  // plan-755 D7 / F5: `Group` declares `claimsNode: false`. It HAS a schema, so
  // before plan-755 every group-only node survived as 'component' (12706 on the
  // Mauser). Now it is an annotation like `renderer` and needs another reason.
  describe('a Group alone claims no node (plan-755 D7)', () => {
    it('a pure Group node is removed — with or without export markers beside it', () => {
      const root = group('Asset');
      const solid = withComponent(group('Solid'), 'Group', { GroupName: 'MC01' });
      solid.add(uberMesh(uber, 'body'));
      const marked = withComponent(uberMesh(uber, 'marked', [2, 0, 0]), 'Group', { GroupName: 'MC01' });
      marked.userData.realvirtual.renderer = { enabled: true };
      root.add(solid, marked);
      const model = computeSurvival(root, registryFor(root));
      expect(survivalFateOf(model, solid)).toBe('removed');
      expect(survivalFateOf(model, marked)).toBe('removed');
      expect(model.roleOf(solid)).toBeUndefined();
      expect(model.removalTops).toEqual([solid, marked]);
      expectNoClaimedNodeRemoved(model, root);
    });

    it('a node with only `Group_1` behaves like `Group` (the _N dedup key resolves to its base type)', () => {
      const root = group('Asset');
      const second = withComponent(group('Second'), 'Group_1', { GroupName: 'B' });
      const both = withComponent(withComponent(group('Both'), 'Group', { GroupName: 'A' }), 'Group_2', { GroupName: 'C' });
      root.add(second, both);
      const model = computeSurvival(root, registryFor(root));
      expect(survivalFateOf(model, second)).toBe('removed');
      expect(survivalFateOf(model, both)).toBe('removed');
    });

    it('an unknown `_N` key stays conservative: `SomeCustomerComponent_1` survives', () => {
      const root = group('Asset');
      const odd = withComponent(group('Odd'), 'SomeCustomerComponent_1', { Value: 1 });
      root.add(odd);
      expect(computeSurvival(root, registryFor(root)).reasonOf(odd)).toBe('component');
    });

    it('survives as a reference target (Group.GroupNamePrefix), with reason "referenced"', () => {
      const root = group('Asset');
      const cell = withComponent(group('Cell1'), 'Group', { GroupName: 'Cell' });
      const member = withComponent(group('Member'), 'Group', { GroupName: 'Door', GroupNamePrefix: 'Asset/Cell1' });
      root.add(cell, member);
      const model = computeSurvival(root, registryFor(root));
      expect(model.reasonOf(cell)).toBe('referenced');
      expect(model.incoming.get(cell)).toBe('merge');
      // The REFERRING group node is itself a pure annotation.
      expect(survivalFateOf(model, member)).toBe('removed');
    });

    it('survives as a plugin claim, with reason "plugin-claim"', () => {
      const root = group('Asset');
      const solid = withComponent(group('Solid'), 'Group', { GroupName: 'MC01' });
      root.add(solid);
      const model = computeSurvival(root, registryFor(root), [{ path: 'Asset/Solid', role: 'merge' }]);
      expect(model.reasonOf(solid)).toBe('plugin-claim');
    });

    it('survives as the ancestor of a survivor, with reason "ancestor"', () => {
      const root = group('Asset');
      const station = withComponent(group('Station'), 'Group', { GroupName: 'MC01' });
      const axis = withComponent(group('Axis'), 'Drive');
      station.add(axis);
      root.add(station);
      const model = computeSurvival(root, registryFor(root));
      expect(model.reasonOf(station)).toBe('ancestor');
      expect(model.reasonOf(axis)).toBe('component');
    });

    it('Group + a real component survives as "component" and keeps the component\'s role', () => {
      const root = group('Asset');
      const axis = withComponent(withComponent(group('Axis'), 'Group', { GroupName: 'MC01' }), 'Drive');
      root.add(axis);
      const model = computeSurvival(root, registryFor(root));
      expect(model.reasonOf(axis)).toBe('component');
      expect(model.roleOf(axis)).toBe('chunk');
    });
  });

  it('a model without any component: everything but the root is removed, nothing throws', () => {
    const root = group('Asset');
    const g = group('cad'); g.add(uberMesh(uber, 'a'), uberMesh(uber, 'b', [2, 0, 0]));
    root.add(g);
    const model = computeSurvival(root, registryFor(root));
    expect(model.counts.survivors).toBe(1);
    expect(model.removalTops).toEqual([g]);
  });

  it('is read-only: tree, visibility, layers and userData are untouched', () => {
    const t = buildTree();
    const snapshot: Array<[Object3D, Object3D | null, number, boolean, number, string]> = [];
    t.root.traverse((n) => snapshot.push([n, n.parent, n.children.length, n.visible, n.layers.mask, JSON.stringify(n.userData)]));
    computeSurvival(t.root, registryFor(t.root), [{ path: 'Asset/Frame/plate', role: 'chunk' }]);
    let i = 0;
    t.root.traverse((n) => {
      const [node, parent, kids, visible, mask, ud] = snapshot[i++];
      expect(n).toBe(node);
      expect(n.parent).toBe(parent);
      expect(n.children.length).toBe(kids);
      expect(n.visible).toBe(visible);
      expect(n.layers.mask).toBe(mask);
      expect(JSON.stringify(n.userData)).toBe(ud);
    });
    expect(i).toBe(snapshot.length);
  });
});
