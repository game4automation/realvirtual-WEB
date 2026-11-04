// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0 — characterisation of THE reference walker
 * (`rv-node-path-rewrite.mjs`, `planReferenceRewrite`) at HEAD.
 *
 * Phase 1 replaces the walk with ONE `visitReferences` (with a setter) and puts
 * the audit / usage-index / maintenance-parser twins on it. Before that, this
 * pins exactly which positions of an extras bag count as a stored node
 * reference TODAY — and that the Phase-0 baseline's mirror
 * (`enumerateReferences`, scripts/rv-reference-baseline.mjs) sees the same set,
 * so the baseline snapshot means what the viewer means.
 */
import { describe, it, expect } from 'vitest';
import { planReferenceRewrite, PATH_FIELDS, NAME_FIELDS } from '../src/core/engine/rv-node-path-rewrite.mjs';
import { enumerateReferences } from '../scripts/rv-reference-baseline.mjs';

const CR = (path: string, componentType = 'realvirtual.Drive') => ({ type: 'ComponentReference', path, componentType });

/** One bag with every shape the walker knows — and some it must NOT count. */
const EXTRAS: Record<string, unknown> = {
  Drive_Cylinder: {
    Scalar: CR('A/Axis'),
    Empty: CR(''),                                     // empty: not a reference
    List: [CR('A/One'), CR('A/Two'), null, 'plain'],
    Records: [{ inner: { deep: CR('A/Deep') } }],
    NotARef: { path: 'A/LooksLikeAPath' },             // no `type` → not a reference
  },
  CustomRuntimeInstruction: {
    steps: [
      { instruction: 'x', targetObjects: ['A/T1', { path: 'A/T2' }, ''], targetObject: 'A/Legacy' },
      { instruction: 'y', targetObjects: [CR('A/T3', 'UnityEngine.Transform')] }, // a CR inside a path field: counted ONCE
    ],
    signal: CR('Signals/Go', 'realvirtual.PLCOutputBool'),
  },
  Kinematic_1: { Parent: 'A/Mount', GroupNamePrefix: 'A/Prefix' }, // `_N` dedup key falls back to Kinematic; prefix is not a path
  WebPhysicsZone: { StaticColliders: ['A/Wall1', 'A/Wall2'] },
  Connections: { connections: [{ source: 'A/Out', target: 'B/In' }] },
  Source: { ThisObjectAsMU: 'MuTemplate' },           // NAME_FIELDS
  PLCOutputBool: { Name: 'Go', Status: { Value: false } }, // signal name: not a reference
  AssetReference: { assetId: 'cat:x', overrides: { byPath: { 'A/Axis': { Drive: { TargetSpeed: 1 } } }, byNodeId: {} } },
};

const EXPECTED_PATHS = [
  // ComponentReference anywhere in any component (generic walk)
  'A/Axis', 'A/One', 'A/Two', 'A/Deep', 'A/T3', 'Signals/Go',
  // PATH_FIELDS
  'A/T1', 'A/T2', 'A/Legacy', 'A/Mount', 'A/Wall1', 'A/Wall2', 'A/Out', 'B/In',
].sort();

describe('plan-769 Phase 0 — reference walker at HEAD', () => {
  it('the declared tables are what the plan inventories (F1)', () => {
    expect(PATH_FIELDS.map((e) => `${e.component}.${e.field}`)).toEqual([
      'CustomRuntimeInstruction.steps.targetObjects',
      'CustomRuntimeInstruction.steps.targetObject',
      'Kinematic.Parent',
      'WebPhysicsZone.StaticColliders',
      'Connections.connections.source',
      'Connections.connections.target',
      // plan-769 (closing the Phase-3 open point): the LogicStep_Enable target is a path field too.
      'LogicStep_Enable.Target',
      // A robot's TCP: Unity writes a GameObject field as a bare path string, so it was
      // never a declared reference and the bake removed the node (measured on DemoRobotIK.glb).
      'RobotIK.TCP',
      // plan-2016 S1: the node a Source parents its MUs to (Unity GameObject field → path string).
      'Source.Destination',
      // plan-2016 S4: the node a Grip aligns picked MUs to (Unity GameObject field → path string).
      'Grip.PickAlignWithObject',
    ]);
    expect(NAME_FIELDS.map((e) => `${e.component}.${e.field}`)).toEqual(['Source.ThisObjectAsMU']);
  });

  it('planReferenceRewrite resolves exactly these written paths (and the name field via resolveName)', () => {
    const seen: string[] = [];
    const names: string[] = [];
    const plan = planReferenceRewrite({
      referrers: [{ nodePath: 'Cell/Holder', extras: EXTRAS }],
      moves: new Map(),
      resolveOld: ({ path }) => { seen.push(path); return null; },
      resolveName: ({ name }) => { names.push(name); return null; },
    });
    expect(seen.sort()).toEqual(EXPECTED_PATHS);
    expect(plan.counts.referencesSeen).toBe(EXPECTED_PATHS.length);
    expect(names).toEqual(['MuTemplate']);
    // Not reference positions at HEAD: override KEYS, a group-name prefix, a signal name,
    // a `{ path }` record outside a declared field.
    for (const p of ['A/LooksLikeAPath', 'A/Prefix', 'Go']) expect(seen).not.toContain(p);
  });

  it('the baseline mirror enumerates the same set (paths + the name field)', () => {
    const refs = enumerateReferences(EXTRAS);
    expect(refs.filter((r) => r.kind !== 'name').map((r) => r.path).sort()).toEqual(EXPECTED_PATHS);
    expect(refs.filter((r) => r.kind === 'name').map((r) => `${r.componentType}.${r.field}=${r.path}`)).toEqual(['Source.ThisObjectAsMU=MuTemplate']);
    // Field locations are reported (array index / dotted record path).
    expect(refs.find((r) => r.path === 'A/Deep')?.field).toBe('Records[0].inner.deep');
    expect(refs.find((r) => r.path === 'A/T2')?.field).toBe('steps[0].targetObjects[1]');
  });

  it('a rewrite through a moved node rewrites every position above, keeping the spelling', () => {
    const plan = planReferenceRewrite({
      referrers: [{ nodePath: 'Cell/Holder', extras: EXTRAS }],
      moves: new Map([['Cell/A', 'Cell/A2']]),
      resolveOld: ({ path }) => (path.startsWith('A/')
        ? { canonical: `Cell/${path}`, spelling: 'relative', stage: 'exact', scopeRootPath: 'Cell' }
        : null),
    });
    const rewritten = plan.steps.map((s) => `${s.componentType}.${s.field}`).sort();
    expect(rewritten).toEqual([
      'Connections.connections', 'CustomRuntimeInstruction.steps', 'Drive_Cylinder.List', 'Drive_Cylinder.Records',
      'Drive_Cylinder.Scalar', 'Kinematic_1.Parent', 'WebPhysicsZone.StaticColliders',
    ]);
    expect(plan.counts.referencesRewritten).toBe(EXPECTED_PATHS.filter((p) => p.startsWith('A/')).length);
    const steps = plan.steps.find((s) => s.field === 'steps')!.value as Array<{ targetObjects: unknown[] }>;
    expect(steps[0]!.targetObjects).toEqual(['A2/T1', { path: 'A2/T2' }, '']);
    // Copy-on-write: the input bag is untouched.
    expect((EXTRAS.Drive_Cylinder as { Scalar: { path: string } }).Scalar.path).toBe('A/Axis');
  });
});
