// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.2 — reference tags (D7).
 *
 * Strongest wins (`keep > chunk > merge`), an untagged reference defaults to
 * `merge`, array / path-string / name-in-subtree targets are found, a
 * `chunk`-tagged target opens a chunk context in `bake()`, and `pick` is
 * independent of references. Plus the factored ref iterator.
 */
import { describe, it, expect } from 'vitest';
import '../src/core/engine/rv-scene-loader';
import {
  bakeTargetOf, forEachComponentRef, pickModeOf, resolveComponentRefs,
} from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import {
  computeSurvival, referenceBakeTargetOf, strongestBakeRole, REFERENCE_BAKE_TARGETS,
} from '../src/core/engine/rv-bake-survival';
import { bakeTree, chunkByKey, chunkKeys, group, uberMesh, withComponent } from './fixtures/bake-fixture';
import { refTo, registryFor } from './helpers/bake-survival';

const uber = new RVUberMaterial(false);

describe('reference tags — vocabulary (plan-754 §9.2)', () => {
  it('strongest wins: keep > chunk > merge > unclaimed', () => {
    expect(strongestBakeRole(undefined, undefined)).toBeUndefined();
    expect(strongestBakeRole(undefined, 'merge')).toBe('merge');
    expect(strongestBakeRole('merge', 'chunk')).toBe('chunk');
    expect(strongestBakeRole('chunk', 'merge')).toBe('chunk');
    expect(strongestBakeRole('keep', 'chunk')).toBe('keep');
  });

  it('bakeTargetOf: merge unless the descriptor says chunk', () => {
    expect(bakeTargetOf(undefined)).toBe('merge');
    expect(bakeTargetOf({ type: 'componentRef' })).toBe('merge');
    expect(bakeTargetOf({ type: 'componentRef', bakeTarget: 'chunk' })).toBe('chunk');
  });

  it('the table declares the chunk-tagged and path-string fields; everything else is merge', () => {
    expect(referenceBakeTargetOf('KinematicJoint', 'BodyA')).toBe('chunk');
    expect(referenceBakeTargetOf('KinematicJoint', 'BodyB')).toBe('chunk');
    expect(referenceBakeTargetOf('WebVisibility', 'AdditionalTargets')).toBe('chunk');
    expect(referenceBakeTargetOf('Chain', 'ChainElement')).toBe('chunk');
    expect(referenceBakeTargetOf('RibbonWinder', 'RollMesh')).toBe('chunk');
    expect(referenceBakeTargetOf('EnergyChain', 'Anchor')).toBe('merge');
    expect(referenceBakeTargetOf('KinematicTarget', 'TargetLink')).toBe('merge');
    expect(referenceBakeTargetOf('Drive_Cylinder', 'Out')).toBe('merge');
    expect(referenceBakeTargetOf('NoSuchComponent', 'NoSuchField')).toBe('merge');
    // No reference may ever claim `keep`.
    for (const e of REFERENCE_BAKE_TARGETS) expect(['merge', 'chunk']).toContain(e.bakeTarget);
  });
});

describe('reference tags — target finding', () => {
  it('an untagged reference claims its bare target as merge', () => {
    const root = group('Asset');
    const target = group('Bare');
    const user = withComponent(group('User'), 'Sensor', { SomeTransform: refTo('Asset/Bare') });
    root.add(target, user);
    const model = computeSurvival(root, registryFor(root));
    expect(model.incoming.get(target)).toBe('merge');
    expect(model.reasonOf(target)).toBe('referenced');
    expect(model.roleOf(target)).toBe('merge');
  });

  it('chunk beats merge on the same target, whatever the order', () => {
    const root = group('Asset');
    const link = group('Link');
    const a = withComponent(group('A'), 'KinematicTarget', { TargetLink: refTo('Asset/Link') });
    const joint = withComponent(group('J'), 'KinematicJoint', { BodyB: refTo('Asset/Link') });
    const b = withComponent(group('B'), 'EnergyChain', { Follower: refTo('Asset/Link') });
    root.add(link, a, joint, b);
    const model = computeSurvival(root, registryFor(root));
    expect(model.incoming.get(link)).toBe('chunk');
    expect(model.roleOf(link)).toBe('chunk');
  });

  it('own keep beats an incoming chunk; own merge is raised to chunk', () => {
    const root = group('Asset');
    const lamp = withComponent(group('Lamp1'), 'Lamp');
    const eye = withComponent(group('Eye'), 'Sensor');
    const vis = withComponent(group('Vis'), 'WebVisibility', {
      AdditionalTargets: [refTo('Asset/Lamp1'), refTo('Asset/Eye')],
    });
    root.add(lamp, eye, vis);
    const model = computeSurvival(root, registryFor(root));
    expect(model.roleOf(lamp)).toBe('keep');
    expect(model.roleOf(eye)).toBe('chunk');
  });

  it('arrays: every AdditionalTargets[] element is a chunk-tagged target', () => {
    const root = group('Asset');
    const t1 = group('T1'); const t2 = group('T2');
    const vis = withComponent(group('Vis'), 'WebVisibility', {
      AdditionalTargets: [refTo('Asset/T1'), refTo('Asset/T2'), refTo('Asset/Missing')],
    });
    root.add(t1, t2, vis);
    const model = computeSurvival(root, registryFor(root));
    expect(model.incoming.get(t1)).toBe('chunk');
    expect(model.incoming.get(t2)).toBe('chunk');
    expect(model.counts.unresolvedReferences).toBe(1);
  });

  it('path strings: Kinematic.Parent (string and { path } form) and GroupNamePrefix', () => {
    const root = group('Asset');
    const parentA = group('ParentA'); const parentB = group('ParentB'); const prefix = group('Cell1');
    const k1 = withComponent(group('K1'), 'Kinematic', { KinematicParentEnable: true, Parent: 'Asset/ParentA' });
    const k2 = withComponent(group('K2'), 'Kinematic', { Parent: { path: 'Asset/ParentB' }, GroupNamePrefix: 'Asset/Cell1' });
    const g = withComponent(group('G'), 'Group', { GroupName: 'x', GroupNamePrefix: '' });
    root.add(parentA, parentB, prefix, k1, k2, g);
    const model = computeSurvival(root, registryFor(root));
    expect(model.reasonOf(parentA)).toBe('referenced');
    expect(model.reasonOf(parentB)).toBe('referenced');
    expect(model.reasonOf(prefix)).toBe('referenced');
    expect(model.incoming.get(parentA)).toBe('merge');
    // An empty path string is no reference at all.
    expect(model.counts.unresolvedReferences).toBe(0);
  });

  it('physics zone: every StaticColliders[] path claims its empty collider node as merge', () => {
    const root = group('Festo');
    // wall0 carries authored collider extras: its OWN claim (`component`, the
    // mesh-less collider rule of 2026-09-24) ranks before the reference, but the
    // reference still tags it. wall1 is a bare node — the reference alone keeps it.
    const wall0 = withComponent(group('HopperWall0_0'), 'BoxCollider', { center: { x: 0, y: 0, z: 0 }, size: { x: 0.03, y: 0.03, z: 0.003 } });
    const wall1 = group('HopperWall0_1');
    const zone = withComponent(group('LogoPhysicsZone'), 'WebPhysicsZone', {
      ZoneEnabled: true, WholeScene: false,
      StaticColliders: ['Festo/HopperWall0_0', { path: 'Festo/HopperWall0_1' }, 'Festo/Missing'],
    });
    root.add(wall0, wall1, zone);
    const model = computeSurvival(root, registryFor(root));
    expect(model.reasonOf(wall0)).toBe('component');
    expect(model.reasonOf(wall1)).toBe('referenced');
    expect(model.incoming.get(wall0)).toBe('merge');
    expect(model.incoming.get(wall1)).toBe('merge');
    expect(model.counts.unresolvedReferences).toBe(1);
    expect(model.unresolvedReferences[0]).toMatchObject(
      { component: 'WebPhysicsZone', field: 'StaticColliders', kind: 'pathString', path: 'Festo/Missing' },
    );
  });

  it('connections: every edge endpoint of the Connections block is a merge target', () => {
    const root = group('Asset');
    const s = group('StationA'); const t = group('StationB');
    const holder = withComponent(group('Doc'), 'Connections', {
      connections: [{ id: 'c1', source: 'Asset/StationA', target: 'Asset/StationB', type: 'StopOnExit' }],
    });
    root.add(s, t, holder);
    const model = computeSurvival(root, registryFor(root));
    expect(model.incoming.get(s)).toBe('merge');
    expect(model.incoming.get(t)).toBe('merge');
  });

  // Mauser 2026-09-21: 14 of 28 maintenance-step targets were bare CAD solids,
  // so the destructive bake removed them and the step card said "not found".
  it('instruction steps: every targetObjects[] entry (and the legacy single field) is a chunk target', () => {
    const root = group('Asset');
    const gearbox = group('Gearbox'); const wheel = group('Wheel'); const legacy = group('Legacy');
    const msg = withComponent(group('Maintenance M1'), 'CustomRuntimeInstruction', {
      steps: [
        { instruction: 'Check oil', targetObjects: ['Asset/Gearbox'], url: '' },
        { instruction: 'Grease', targetObjects: ['Asset/Wheel', { path: 'Asset/Gearbox' }], targetObject: 'Asset/Legacy' },
        { instruction: 'No target', targetObjects: [], url: '' },
      ],
    });
    root.add(gearbox, wheel, legacy, msg);
    const model = computeSurvival(root, registryFor(root));
    for (const t of [gearbox, wheel, legacy]) {
      expect(model.reasonOf(t)).toBe('referenced');
      expect(model.roleOf(t)).toBe('chunk');
    }
    expect(model.counts.unresolvedReferences).toBe(0);
  });

  it('an unresolved reference names its component, field, owner and path', () => {
    const root = group('Asset');
    const vis = withComponent(group('Vis'), 'WebVisibility', { AdditionalTargets: [refTo('Asset/Missing')] });
    const k = withComponent(group('K'), 'Kinematic', { Parent: 'Asset/Gone' });
    root.add(vis, k);
    const model = computeSurvival(root, registryFor(root));
    expect(model.counts.unresolvedByField).toEqual({ 'WebVisibility.AdditionalTargets': 1, 'Kinematic.Parent': 1 });
    expect(model.unresolvedReferences).toEqual([
      { component: 'WebVisibility', field: 'AdditionalTargets', kind: 'ref', owner: 'Vis', path: 'Asset/Missing' },
      { component: 'Kinematic', field: 'Parent', kind: 'pathString', owner: 'K', path: 'Asset/Gone' },
    ]);
  });

  it('name in subtree: Source.ThisObjectAsMU finds the template by name; a self-reference claims nothing', () => {
    const root = group('Asset');
    const tmpl = group('Box'); tmpl.add(uberMesh(uber, 'boxMesh'));
    const src = withComponent(group('Src'), 'Source', { ThisObjectAsMU: 'Some/Path/Box' });
    const self = withComponent(group('SelfSrc'), 'Source', { ThisObjectAsMU: '' });
    root.add(tmpl, src, self);
    const model = computeSurvival(root, registryFor(root));
    expect(model.incoming.get(tmpl)).toBe('chunk');
    expect(model.incoming.has(self)).toBe(false);
    expect(model.reasonOf(self)).toBe('component');
  });
});

describe('reference tags — the bake consumes them', () => {
  it('a chunk-tagged bare target opens a chunk context like a mover; a merge-tagged one does not', async () => {
    const build = () => {
      const root = group('Asset');
      const rod = group('Rod'); rod.add(uberMesh(uber, 'rodMesh'));
      const anchor = group('Anchor'); anchor.add(uberMesh(uber, 'anchorMesh', [3, 0, 0]));
      const joint = withComponent(group('J'), 'KinematicJoint', { BodyB: refTo('Asset/Rod') });
      const chain = withComponent(group('C'), 'EnergyChain', { Anchor: refTo('Asset/Anchor') });
      root.add(rod, anchor, joint, chain, uberMesh(uber, 'frame', [6, 0, 0]));
      return { root, rod, anchor };
    };
    // Without tags: one static chunk (today's behaviour, unchanged).
    const plain = build();
    expect(chunkKeys(await bakeTree(plain.root, { uber }))).toEqual(['static']);

    const tagged = build();
    const model = computeSurvival(tagged.root, registryFor(tagged.root));
    const asset = await bakeTree(tagged.root, { uber, incomingRoles: model.incoming });
    expect(chunkKeys(asset)).toEqual(['mover:Rod', 'static']);
    expect(chunkByKey(asset, 'mover:Rod').owner).toBe(tagged.rod);
    // The boundary is a logic node (a placement instance needs it as an owner);
    // the merge-tagged anchor changes nothing in the bake.
    expect(asset.logicNodes.map((l) => l.path)).toContain('Rod');
    expect(asset.logicNodes.map((l) => l.path)).not.toContain('Anchor');
    // Same triangles, just cut differently.
    expect(asset.triangles).toBe(36);
  });

  it('an incoming chunk tag never overrides keep', async () => {
    const root = group('Asset');
    const lamp = withComponent(group('Lamp1'), 'Lamp'); lamp.add(uberMesh(uber, 'glass'));
    const vis = withComponent(group('Vis'), 'WebVisibility', { AdditionalTargets: [refTo('Asset/Lamp1')] });
    root.add(lamp, vis);
    const model = computeSurvival(root, registryFor(root));
    const asset = await bakeTree(root, { uber, incomingRoles: model.incoming });
    expect(asset.chunks.length).toBe(0);
    expect(asset.keep.map((k) => k.mesh.name)).toEqual(['glass']);
  });

  it('pick is independent of references', async () => {
    const root = group('Asset');
    const rod = group('Rod'); rod.add(uberMesh(uber, 'rodMesh'));
    const joint = withComponent(group('J'), 'KinematicJoint', { BodyB: refTo('Asset/Rod') });
    root.add(rod, joint);
    const model = computeSurvival(root, registryFor(root));
    expect(pickModeOf(rod)).toBe('none');
    const asset = await bakeTree(root, { uber, incomingRoles: model.incoming });
    // The new chunk's segments name the ROD as their node and have NO pick owner —
    // no pick node was invented for a `chunk`-tagged reference target (plan-756:
    // the window table became the segment table).
    const pick = chunkByKey(asset, 'mover:Rod').pick;
    const ordinal = asset.nodeTable.ordinalOf.get(rod);
    expect(ordinal).toBeGreaterThanOrEqual(0);
    expect([...pick.segNode]).toEqual(new Array(pick.segmentCount).fill(ordinal));
    expect([...pick.segOwner]).toEqual(new Array(pick.segmentCount).fill(-1));
    expect(pickModeOf(rod)).toBe('none');
  });
});

describe('forEachComponentRef — the one ref-field iterator', () => {
  it('visits scalar refs (index null) and ref elements of arrays, nothing else', () => {
    const record = {
      A: refTo('p/a'), N: 5, S: 'text', L: [refTo('p/l0'), 'raw', refTo('p/l2')], O: { nested: refTo('p/n') }, Z: null,
    };
    const seen: Array<[string, string, number | null]> = [];
    forEachComponentRef(record, (key, ref, index) => seen.push([key, ref.path, index]));
    expect(seen).toEqual([['A', 'p/a', null], ['L', 'p/l0', 0], ['L', 'p/l2', 2]]);
  });

  it('resolveComponentRefs keeps its contract on top of it', () => {
    const root = group('Asset');
    const bare = group('Bare');
    root.add(bare);
    const registry = registryFor(root);
    const instance: Record<string, unknown> = {
      Node: refTo('Asset/Bare'),
      Gone: refTo('Asset/Nope'),
      List: [refTo('Asset/Bare'), 'keepMe', refTo('Asset/Nope', 'realvirtual.MachiningTool')],
      Plain: [1, 2, 3],
      Num: 7,
    };
    const plain = instance.Plain;
    resolveComponentRefs(instance, registry);
    expect(instance.Node).toBe(bare);
    expect(instance.Gone).toBeNull();
    expect(instance.List).toEqual([bare, 'keepMe', 'Asset/Nope']);
    expect(instance.Plain).toBe(plain);
    expect(instance.Num).toBe(7);
  });
});
