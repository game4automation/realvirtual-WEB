// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 3 (test 9.4, pure part) — the reference audit against a REAL
 * `NodeRegistry`, without a viewer: what is a finding (`unresolved` / `rescued`)
 * and what is not (empty optional refs, the Unity root-prefixed spelling,
 * loader-published aliases, typed misses on existing nodes, late-resolution
 * fields, `AssetOverrides`).
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  auditKinematicGroupsInPlacedContent,
  auditReferences,
  describeReferenceLocation,
  fieldHoldsReference,
  forEachStoredReference,
  type StoredReference,
} from '../src/core/engine/rv-reference-audit';

const ref = (path: string, componentType = ''): Record<string, unknown> => ({ type: 'ComponentReference', path, componentType });

interface Spec {
  name: string;
  extras?: Record<string, unknown>;
  /** Registered component types on this node (`Drive`, …). */
  components?: string[];
  children?: Spec[];
}

/**
 * Build `world → <model root> → …` and register every node under its canonical
 * path, the model root as reference scope (`assetRootNames` = authored names).
 */
function build(model: Spec, opts?: { assetRootNames?: string[]; placements?: { parent: string; spec: Spec }[] }) {
  const world = new Object3D();
  world.name = '';
  const registry = new NodeRegistry();
  const make = (s: Spec, parent: Object3D): Object3D => {
    const n = new Object3D();
    n.name = s.name;
    if (s.extras) n.userData.realvirtual = s.extras;
    parent.add(n);
    for (const c of s.children ?? []) make(c, n);
    return n;
  };
  const root = make(model, world);
  const registerAll = (sub: Object3D): void => {
    sub.traverse((n) => {
      const path = NodeRegistry.computeNodePath(n);
      registry.registerNode(path, n);
    });
  };
  registerAll(root);
  registry.registerScopeNames(root, opts?.assetRootNames ?? []);
  for (const p of opts?.placements ?? []) {
    const parent = registry.getNode(p.parent)!;
    const pr = make(p.spec, parent);
    registerAll(pr);
    registry.registerScopeNames(pr, []);
  }
  // Components (second pass, so paths are final).
  const visit = (s: Spec, path: string): void => {
    for (const t of s.components ?? []) registry.register(t, path, { type: t });
    for (const c of s.children ?? []) visit(c, `${path}/${c.name}`);
  };
  visit(model, model.name);
  for (const p of opts?.placements ?? []) visit(p.spec, `${p.parent}/${p.spec.name}`);
  return { registry, root, world };
}

describe('auditReferences — findings', () => {
  it('a reference to a path no node has is unresolved', () => {
    const { registry } = build({
      name: 'Cell',
      children: [
        { name: 'Belt', extras: { TransportSurface: { DriveReference: ref('Cell/Gone', 'realvirtual.Drive') } } },
      ],
    });
    const r = auditReferences(registry);
    expect(r.findings).toEqual([{
      kind: 'unresolved',
      referrerPath: 'Cell/Belt',
      componentType: 'TransportSurface',
      field: 'DriveReference',
      writtenPath: 'Cell/Gone',
      targetComponentType: 'realvirtual.Drive',
    }]);
    expect(r.counts).toMatchObject({ referrers: 1, references: 1, unresolved: 1, rescued: 0 });
  });

  it('a reference found only by its suffix is rescued, with the path it landed on', () => {
    const { registry } = build({
      name: 'Cell',
      children: [
        { name: 'Signals', children: [{ name: 'FG01', children: [{ name: 'X' }] }] },
        // `FG01/X` is a tail of `Cell/Signals/FG01/X` (but neither scope-relative nor absolute).
        { name: 'Lift', extras: { Drive_Cylinder: { In: ref('FG01/X', 'realvirtual.PLCOutputBool') } } },
      ],
    });
    const r = auditReferences(registry);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: 'rescued',
      referrerPath: 'Cell/Lift',
      componentType: 'Drive_Cylinder',
      field: 'In',
      writtenPath: 'FG01/X',
      resolvedPath: 'Cell/Signals/FG01/X',
      stage: 'suffix',
    });
  });

  it('a typed reference found by suffix through its component is rescued', () => {
    const { registry } = build({
      name: 'Cell',
      children: [
        { name: 'Axes', children: [{ name: 'Axis1', components: ['Drive'] }] },
        { name: 'Belt', extras: { TransportSurface: { DriveReference: ref('Axis1', 'realvirtual.Drive') } } },
      ],
    });
    const [f] = auditReferences(registry).findings;
    expect(f).toMatchObject({ kind: 'rescued', resolvedPath: 'Cell/Axes/Axis1', stage: 'suffix' });
  });

  it('a signal found only by its NAME inside the scope is rescued (name-in-scope)', () => {
    const { registry } = build({
      name: 'Cell',
      children: [
        { name: 'Signals', children: [{ name: 'Start' }] },
        { name: 'Lamp', extras: { Lamp: { Signal: ref('OldTable/Start', 'realvirtual.PLCOutputBool') } } },
      ],
    });
    // `OldTable/Start` is no suffix of `Cell/Signals/Start` — only the leaf name matches.
    const [f] = auditReferences(registry).findings;
    expect(f).toMatchObject({ kind: 'rescued', resolvedPath: 'Cell/Signals/Start', stage: 'name-in-scope' });
  });

  it('path-string fields are audited as plain nodes, array elements carry their index', () => {
    const { registry } = build({
      name: 'Cell',
      children: [
        { name: 'Wall' },
        {
          name: 'Zone',
          extras: { WebPhysicsZone: { StaticColliders: ['Cell/Wall', 'Cell/Missing'] } },
        },
        { name: 'Arm', extras: { Kinematic: { Parent: 'Cell/NoSuchParent' } } },
      ],
    });
    const r = auditReferences(registry);
    expect(r.findings.map((f) => [f.kind, f.referrerPath, describeReferenceLocation(f), f.writtenPath])).toEqual([
      ['unresolved', 'Cell/Zone', 'WebPhysicsZone.StaticColliders[1]', 'Cell/Missing'],
      ['unresolved', 'Cell/Arm', 'Kinematic.Parent', 'Cell/NoSuchParent'],
    ]);
  });

  it('a reference inside a placed asset resolves in the PLACEMENT scope; one that only lands outside is rescued', () => {
    const asset = (name: string): Spec => ({
      name,
      children: [
        { name: 'Mount', children: [{ name: 'Kine' }] },
        { name: 'User', extras: { Kinematic: { Parent: 'Mount/Kine' } } },
        { name: 'User2', extras: { Lamp: { Anchor: ref('Elsewhere/Kine2', 'UnityEngine.Transform') } } },
      ],
    });
    const { registry } = build(
      { name: 'Layout', children: [{ name: 'Host', children: [{ name: 'Elsewhere', children: [{ name: 'Kine2' }] }] }] },
      { placements: [{ parent: 'Layout', spec: asset('Machine_1') }] },
    );
    const r = auditReferences(registry);
    // `Mount/Kine` binds inside Machine_1 exactly; `Elsewhere/Kine2` exists only in the main model.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: 'rescued', referrerPath: 'Layout/Machine_1/User2', resolvedPath: 'Layout/Host/Elsewhere/Kine2', stage: 'suffix',
    });
  });
});

describe('auditReferences — no false positives', () => {
  it('an empty optional reference is no finding', () => {
    const { registry } = build({
      name: 'Cell',
      children: [{ name: 'Belt', extras: { TransportSurface: { DriveReference: ref('', 'realvirtual.Drive'), Other: { type: 'ComponentReference' } } } }],
    });
    const r = auditReferences(registry);
    expect(r.findings).toEqual([]);
    expect(r.counts.references).toBe(0);
  });

  it('the Unity root-prefixed spelling (scope root name) is no finding — also root-stripped / relative', () => {
    const { registry } = build(
      {
        name: 'Machine',
        children: [
          { name: 'Mount', children: [{ name: 'Kine', components: ['Drive'] }] },
          {
            name: 'User',
            extras: {
              TransportSurface: { DriveReference: ref('Machine/Mount/Kine', 'realvirtual.Drive') },
              Lamp: { Anchor: ref('Mount/Kine', 'UnityEngine.Transform') },
              Sensor: { Self: ref('UnityMachine/Mount/Kine', 'UnityEngine.Transform') },
            },
          },
        ],
      },
      { assetRootNames: ['UnityMachine'] },
    );
    expect(auditReferences(registry).findings).toEqual([]);
  });

  it('a hit through a loader-published alias is the path as written — no finding', () => {
    const { registry, root } = build({
      name: 'Cell',
      children: [
        { name: 'Pusher_1', children: [{ name: 'Rod' }] },
        { name: 'User', extras: { Lamp: { Anchor: ref('Cell/Pusher/Rod', 'UnityEngine.Transform') } } },
      ],
    });
    const rod = root.getObjectByName('Rod')!;
    registry.registerAlias('Cell/Pusher/Rod', rod);
    expect(auditReferences(registry).findings).toEqual([]);
  });

  it('a typed miss on an existing node is no finding (component type not built / built later)', () => {
    const { registry } = build({
      name: 'Cell',
      children: [
        { name: 'Tool' },
        { name: 'User', extras: { Thing: { Target: ref('Cell/Tool', 'realvirtual.MachiningTool'), Axis: ref('Cell/Tool', 'realvirtual.Drive') } } },
      ],
    });
    expect(auditReferences(registry).findings).toEqual([]);
  });

  it('a complete miss in a late-resolution field is skipped and counted', () => {
    const { registry } = build({
      name: 'Cell',
      children: [{ name: 'Vol', extras: { MachiningVolume: { Tools: [ref('Cell/LaterTool', 'realvirtual.MachiningTool')] } } }],
    });
    const r = auditReferences(registry);
    expect(r.findings).toEqual([]);
    expect(r.counts.lateSkipped).toBe(1);
  });

  it('AssetOverrides content (relative to the referenced asset) is never walked', () => {
    const { registry } = build({
      name: 'Cell',
      children: [{
        name: 'Ref',
        extras: { AssetOverrides: { byPath: { 'Mount/Kine': { Drive: { Ref: ref('Somewhere/Inside/Asset', 'realvirtual.Drive') } } } } },
      }],
    });
    const r = auditReferences(registry);
    expect(r.findings).toEqual([]);
    expect(r.counts.references).toBe(0);
  });

  it('an alias registry entry is not walked as a second referrer', () => {
    const { registry, root } = build({
      name: 'Cell',
      children: [{ name: 'User', extras: { Lamp: { Anchor: ref('Cell/Gone', 'UnityEngine.Transform') } } }],
    });
    registry.registerAlias('Cell/UserOld', root.getObjectByName('User')!);
    const r = auditReferences(registry);
    expect(r.counts.referrers).toBe(1);
    expect(r.findings).toHaveLength(1);
  });
});

describe('forEachStoredReference — locations', () => {
  it('names deep references and dotted path fields by field, index and sub-path', () => {
    const seen: StoredReference[] = [];
    forEachStoredReference({
      CustomRuntimeInstruction: {
        steps: [
          { targetObjects: ['A', 'B'], targetObject: 'C' },
          { targetObjects: [], nested: { anchor: ref('D', 'UnityEngine.Transform') } },
        ],
      },
      Connections: { connections: [{ source: 'S1', target: { path: 'T1' } }] },
      Kinematic_1: { Parent: 'P' },
    }, (r) => seen.push(r));
    expect(seen.map((r) => [describeReferenceLocation(r), r.writtenPath, r.source])).toEqual([
      ['CustomRuntimeInstruction.steps[1].nested.anchor', 'D', 'reference'],
      ['CustomRuntimeInstruction.steps[0].targetObjects[0]', 'A', 'pathField'],
      ['CustomRuntimeInstruction.steps[0].targetObjects[1]', 'B', 'pathField'],
      ['CustomRuntimeInstruction.steps[0].targetObject', 'C', 'pathField'],
      ['Connections.connections[0].source', 'S1', 'pathField'],
      ['Connections.connections[0].target.path', 'T1', 'pathField'],
      ['Kinematic_1.Parent', 'P', 'pathField'],
    ]);
  });

  it('fieldHoldsReference answers per field', () => {
    const extras = { Drive_Cylinder: { In: ref('X'), Speed: 3 }, Kinematic: { Parent: 'P' } };
    expect(fieldHoldsReference(extras, 'Drive_Cylinder', 'In')).toBe(true);
    expect(fieldHoldsReference(extras, 'Drive_Cylinder', 'Speed')).toBe(false);
    expect(fieldHoldsReference(extras, 'Kinematic', 'Parent')).toBe(true);
    expect(fieldHoldsReference(extras, 'Nope', 'In')).toBe(false);
  });
});

describe('auditKinematicGroupsInPlacedContent — group-name collisions (plan-774 review round 2, R1)', () => {
  /** Own `Axis` Kinematic integrating `Frame`; a placed `Cell_1` whose `Bar` node is in a group `Frame`. */
  function scene(bar: { extras: Record<string, unknown>; base?: Record<string, unknown> }) {
    const { registry } = build({
      name: 'Machine',
      children: [
        { name: 'Axis', extras: { Kinematic: { IntegrateGroupEnable: true, GroupName: 'Frame' } } },
        { name: 'Cell_1', extras: { AssetReference: { assetId: 'cat:cell', path: 'cell.glb' } }, children: [
          { name: 'Bar', extras: bar.extras },
        ] },
      ],
    });
    const barNode = registry.getNode('Machine/Cell_1/Bar')!;
    if (bar.base) barNode.userData._rvOverrideBase = bar.base;
    const groups = new Map([['Frame', { nodes: [barNode] }]]);
    return auditKinematicGroupsInPlacedContent(registry, groups);
  }

  it('a group the placed asset declares itself under the same name → no finding', () => {
    expect(scene({ extras: { Group: { GroupName: 'Frame' } } })).toEqual([]);
  });

  it('a synthetic partition member (no Group component) → no finding', () => {
    expect(scene({ extras: {} })).toEqual([]);
  });

  it('a document override assigning the placed node to the own group → finding', () => {
    const out = scene({
      extras: { Drive: { TargetSpeed: 1 }, Group: { GroupName: 'Frame' } },
      base: { Group: { GroupName: { has: false } } },
    });
    expect(out).toEqual([{ kinematicPath: 'Machine/Axis', groupName: 'Frame', memberCount: 1, placementPaths: ['Machine/Cell_1'] }]);
  });

  it('an override renaming the asset\'s group TO the own name → finding; an override of an unrelated Group field → none', () => {
    expect(scene({ extras: { Group: { GroupName: 'Frame' } }, base: { Group: { GroupName: { has: true, value: 'Rail' } } } })).toHaveLength(1);
    expect(scene({ extras: { Group: { GroupName: 'Frame', Note: 'x' } }, base: { Group: { Note: { has: false } } } })).toEqual([]);
  });
});
