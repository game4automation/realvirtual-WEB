// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 1a — THE reference walk `visitReferences` (rv-node-path-rewrite.mjs):
 * the same positions `planReferenceRewrite` resolves, a setter that writes in place,
 * the two visit orders its consumers rely on, and the twins that now run on it
 * (the audit's `forEachStoredReference`, the migration's `enumerateReferences`).
 */
import { describe, it, expect } from 'vitest';
import { planReferenceRewrite, visitReferences, type VisitedReference } from '../src/core/engine/rv-node-path-rewrite.mjs';
import { enumerateReferences } from '../src/core/engine/rv-reference-migration.mjs';
import { forEachStoredReference } from '../src/core/engine/rv-reference-audit';

const CR = (path: string, componentType = 'realvirtual.Drive') => ({ type: 'ComponentReference', path, componentType });

function extras(): Record<string, unknown> {
  return {
    Drive_Cylinder: {
      Scalar: CR('A/Axis'),
      Empty: CR(''),
      List: [CR('A/One'), CR('A/Two'), null, 'plain'],
      Records: [{ inner: { deep: CR('A/Deep') } }],
      NotARef: { path: 'A/LooksLikeAPath' },
    },
    CustomRuntimeInstruction: {
      steps: [
        { instruction: 'x', targetObjects: ['A/T1', { path: 'A/T2' }, ''], targetObject: 'A/Legacy' },
        { instruction: 'y', targetObjects: [CR('A/T3', 'UnityEngine.Transform')] },
      ],
      signal: CR('Signals/Go', 'realvirtual.PLCOutputBool'),
    },
    Kinematic_1: { Parent: 'A/Mount', GroupNamePrefix: 'A/Prefix' },
    WebPhysicsZone: { StaticColliders: ['A/Wall1', 'A/Wall2'] },
    Connections: { connections: [{ source: 'A/Out', target: 'B/In' }] },
    Source: { ThisObjectAsMU: 'MuTemplate' },
    AssetOverrides: { byPath: { 'A/Axis': { Drive: { TargetSpeed: 1 } } } },
  };
}

describe('plan-769 visitReferences', () => {
  it('visits exactly what planReferenceRewrite resolves (non-empty), plus the name field', () => {
    const seen: string[] = [];
    planReferenceRewrite({
      referrers: [{ nodePath: 'X', extras: extras() }],
      moves: new Map(),
      resolveOld: ({ path }) => { seen.push(path); return null; },
    });
    const visited: VisitedReference[] = [];
    visitReferences(extras(), (r) => visited.push(r));
    expect(visited.filter((r) => r.kind !== 'name' && r.path !== '').map((r) => r.path).sort()).toEqual(seen.sort());
    expect(visited.filter((r) => r.kind === 'name').map((r) => r.path)).toEqual(['MuTemplate']);
    // Empty strings are visited too — what counts as "no reference" is the caller's rule.
    expect(visited.filter((r) => r.path === '').length).toBe(2);
    // A CR inside a declared path field is visited ONCE, as a reference.
    expect(visited.filter((r) => r.path === 'A/T3').map((r) => r.kind)).toEqual(['ref']);
    // A `{ path }` record of a path field is flagged; one outside a declared field is not a position.
    expect(visited.find((r) => r.path === 'A/T2')?.record).toBe(true);
    expect(visited.some((r) => r.path === 'A/LooksLikeAPath' || r.path === 'A/Prefix')).toBe(false);
  });

  it('the setter writes in place, at the visited position', () => {
    const bag = extras();
    visitReferences(bag, (r) => {
      if (r.kind === 'ref' && r.path === 'A/Deep') r.set({ type: 'ComponentReference', address: '#deep', componentType: 'realvirtual.Drive' });
      if (r.kind === 'path' && r.path === 'A/Mount') r.set({ address: '#mount' });
      if (r.kind === 'path' && r.path === 'A/Wall2') r.set({ unresolvedPath: 'A/Wall2', reason: 'missing' });
    });
    expect((bag.Drive_Cylinder as { Records: Array<{ inner: { deep: unknown } }> }).Records[0]!.inner.deep)
      .toEqual({ type: 'ComponentReference', address: '#deep', componentType: 'realvirtual.Drive' });
    expect((bag.Kinematic_1 as { Parent: unknown }).Parent).toEqual({ address: '#mount' });
    expect((bag.WebPhysicsZone as { StaticColliders: unknown[] }).StaticColliders[1]).toEqual({ unresolvedPath: 'A/Wall2', reason: 'missing' });
  });

  it('orders: by-key (the migration / baseline) and refs-first (the audit); skipComponent', () => {
    const bag = {
      C: { Parent: 'P/Path', Ref: CR('P/Ref') },
    };
    const table = [{ component: 'C', field: 'Parent', shape: 'path' as const }];
    const byKey: string[] = [];
    visitReferences(bag, (r) => byKey.push(r.path), { pathFields: table });
    expect(byKey).toEqual(['P/Path', 'P/Ref']);
    const refsFirst: string[] = [];
    visitReferences(bag, (r) => refsFirst.push(r.path), { pathFields: table, order: 'refs-first' });
    expect(refsFirst).toEqual(['P/Ref', 'P/Path']);
    const skipped: string[] = [];
    visitReferences(extras(), (r) => skipped.push(r.componentKey), { skipComponent: (k) => k !== 'Source' });
    expect(skipped).toEqual(['Source']);
  });

  it('the twins on it: the audit walk and the migration enumeration agree on the positions', () => {
    const audit: string[] = [];
    forEachStoredReference(extras(), (r) => audit.push(`${r.componentType}|${r.writtenPath}|${r.index ?? ''}|${r.subPath ?? ''}`));
    expect(audit).toContain('CustomRuntimeInstruction|A/T2|0|targetObjects[1].path');
    expect(audit).toContain('Drive_Cylinder|A/Deep|0|inner.deep');
    // The audit skips AssetOverrides and the name field; the migration labels locations.
    expect(audit.some((a) => a.startsWith('AssetOverrides') || a.startsWith('Source'))).toBe(false);
    const mig = enumerateReferences(extras());
    expect(mig.find((r) => r.path === 'A/T2')?.field).toBe('steps[0].targetObjects[1]');
    expect(new Set(mig.filter((r) => r.kind !== 'name').map((r) => r.path))).toEqual(
      new Set(audit.map((a) => a.split('|')[1])),
    );
  });
});
