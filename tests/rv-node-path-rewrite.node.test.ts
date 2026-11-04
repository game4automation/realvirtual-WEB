// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 1 / test 9.1 — the pure reference-rewrite core
 * (`src/core/engine/rv-node-path-rewrite.mjs`): segment boundaries, spelling kept,
 * array / deep / name fields, referrers inside and outside the moved subtree,
 * idempotence, foreign referrers, fallback healing — plus the parity of the core
 * field tables with `REFERENCE_BAKE_TARGETS` (rv-bake-survival.ts).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  NAME_FIELDS, PATH_FIELDS, isComponentReference, matchesPrefix, planReferenceRewrite, respell,
} from '../src/core/engine/rv-node-path-rewrite.mjs';
import type {
  ReferenceRewriteInput, ReferenceRewriteReferrer, ResolveNameHit, ResolveOldHit, ResolveOldQuery,
} from '../src/core/engine/rv-node-path-rewrite.mjs';
import { REFERENCE_BAKE_TARGETS } from '../src/core/engine/rv-bake-survival';

// ─── Fixture: a tiny scene model with the reference resolver's rules ───────

const ROOT = 'Machine';
const ref = (path: string, componentType = 'Drive') => ({ type: 'ComponentReference', path, componentType });

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

/**
 * The resolver of rv-reference-resolver.ts against a set of canonical paths in scope
 * `Machine`: as written below the root (relative), else the root segment stripped
 * (root-prefixed), else a unique suffix match (fallback stage `suffix`).
 */
function resolverFor(nodes: Iterable<string>, opts: { withScope?: boolean } = {}) {
  const set = new Set(nodes);
  return (q: ResolveOldQuery): ResolveOldHit | null => {
    const scope = opts.withScope === false ? {} : { scopeRootPath: ROOT };
    const asWritten = `${ROOT}/${q.path}`;
    if (set.has(asWritten)) return { canonical: asWritten, spelling: 'relative', stage: 'exact' };
    const segs = q.path.split('/');
    if (segs[0] === ROOT) {
      const stripped = [ROOT, ...segs.slice(1)].join('/');
      if (set.has(stripped)) return { canonical: stripped, spelling: 'root-prefixed', stage: 'exact' };
    }
    const hits = [...set].filter((p) => p.endsWith(`/${q.path}`));
    if (hits.length === 1) return { canonical: hits[0], spelling: 'relative', stage: 'suffix', ...scope };
    return null;
  };
}

/** Apply a plan to plain extras (what the editor's setField ops would do). */
function applyPlan(referrers: ReferenceRewriteReferrer[], plan: ReturnType<typeof planReferenceRewrite>, moves: Map<string, string>) {
  const mapPath = (p: string) => {
    for (const [o, n] of moves) if (p === o || p.startsWith(o + '/')) return n + p.slice(o.length);
    return p;
  };
  const out: ReferenceRewriteReferrer[] = referrers.map((r) => ({
    nodePath: mapPath(r.nodePath),
    extras: JSON.parse(JSON.stringify(r.extras)),
  }));
  for (const s of [...plan.steps, ...plan.nameSteps]) {
    const r = out.find((x) => x.nodePath === s.nodePath)!;
    (r.extras![s.componentType] as Record<string, unknown>)[s.field] = s.value;
  }
  return out;
}

const movedNodes = (nodes: string[], moves: Map<string, string>) => nodes.map((p) => {
  for (const [o, n] of moves) if (p === o || p.startsWith(o + '/')) return n + p.slice(o.length);
  return p;
});

// ─── Unit helpers ───────────────────────────────────────────────────────────

describe('portable module', () => {
  it('has no imports and touches no Node or DOM API', () => {
    const src = readFileSync(new URL('../src/core/engine/rv-node-path-rewrite.mjs', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(|\bBuffer\b|node:|\bdocument\.|\bwindow\./);
  });
});

describe('isComponentReference', () => {
  it('accepts the rv-ODT shape only', () => {
    expect(isComponentReference(ref('A/B'))).toBe(true);
    expect(isComponentReference({ type: 'ComponentReference', path: '' })).toBe(true);
    expect(isComponentReference({ type: 'ComponentReference', path: 3 })).toBe(false);
    expect(isComponentReference({ type: 'ScriptableObject', path: 'A' })).toBe(false);
    expect(isComponentReference([ref('A')])).toBe(false);
    expect(isComponentReference(null)).toBe(false);
    expect(isComponentReference('A/B')).toBe(false);
  });
});

describe('matchesPrefix — segment boundary', () => {
  it('PLC matches PLC and PLC/…, never PLC_Programs', () => {
    expect(matchesPrefix('PLC', 'PLC')).toBe(true);
    expect(matchesPrefix('PLC/FG01/X', 'PLC')).toBe(true);
    expect(matchesPrefix('PLC_Programs', 'PLC')).toBe(false);
    expect(matchesPrefix('PLC_Programs/Station01', 'PLC')).toBe(false);
    expect(matchesPrefix('A/BC', 'A/B')).toBe(false);
    expect(matchesPrefix('X/PLC', 'PLC')).toBe(false);
  });
});

describe('respell — the written spelling is kept', () => {
  it('asset-relative stays relative', () => {
    expect(respell('Mount/Kine', 'Machine/Mount/Kine', 'Machine/Base/Kine', 'relative')).toBe('Base/Kine');
    expect(respell('Mount/Kine', 'Machine/Mount/Kine', 'Machine/Base/Kine', 'relative', 'Machine')).toBe('Base/Kine');
  });
  it('root-prefixed stays root-prefixed, with the author\'s root segment', () => {
    expect(respell('Machine/Mount/Kine', 'Machine/Mount/Kine', 'Machine/Base/Kine', 'root-prefixed')).toBe('Machine/Base/Kine');
    // A placement: the root segment is the authored asset name, the scope root its placement path.
    expect(respell('Arburg/Mount/Kine', 'Layout/Arburg_1/Mount/Kine', 'Layout/Arburg_1/Base/Kine', 'root-prefixed'))
      .toBe('Arburg/Base/Kine');
  });
  it('an unscoped path is relative to the origin', () => {
    expect(respell('Machine/Mount/Kine', 'Machine/Mount/Kine', 'Machine/Base/Kine', 'relative', '')).toBe('Machine/Base/Kine');
  });
  it('a target leaving the scope cannot be written relative → null', () => {
    expect(respell('Mount/Kine', 'Machine/Mount/Kine', 'Other/Kine', 'relative', 'Machine')).toBeNull();
  });
});

// ─── planReferenceRewrite ──────────────────────────────────────────────────

describe('planReferenceRewrite', () => {
  const NODES = [
    'Machine', 'Machine/PLC', 'Machine/PLC/FG01', 'Machine/PLC/FG01/X', 'Machine/PLC/FG01/Y',
    'Machine/PLC_Programs', 'Machine/PLC_Programs/Station01',
    'Machine/Walls', 'Machine/Walls/A', 'Machine/Walls/B', 'Machine/Other', 'Machine/Other/C',
    'Machine/Cell', 'Machine/Cell/Lift', 'Machine/Cell/Drive', 'Machine/Conveyor', 'Machine/Conveyor/Drive',
    'Machine/Mount', 'Machine/Mount/Kine', 'Machine/Src', 'Machine/Src/Box', 'Machine/Zone',
  ];

  const run = (referrers: ReferenceRewriteReferrer[], moves: Map<string, string>, extra: Partial<ReferenceRewriteInput> = {}, nodes = NODES) =>
    planReferenceRewrite({ referrers: deepFreeze(referrers), moves, resolveOld: resolverFor(nodes), ...extra });

  it('segment boundary: moving PLC → Signals rewrites PLC/FG01/X, not PLC_Programs/Station01', () => {
    const moves = new Map([['Machine/PLC', 'Machine/Signals']]);
    const referrers = [{
      nodePath: 'Machine/Cell/Lift',
      extras: { Drive_Cylinder: { In: ref('PLC/FG01/X', 'PLCOutputBool'), Program: ref('PLC_Programs/Station01', 'StProgram'), Speed: 5 } },
    }];
    const plan = run(referrers, moves);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ nodePath: 'Machine/Cell/Lift', componentType: 'Drive_Cylinder', field: 'In' });
    expect(plan.steps[0].value).toEqual({ type: 'ComponentReference', path: 'Signals/FG01/X', componentType: 'PLCOutputBool' });
    expect(plan.counts.referencesRewritten).toBe(1);
    expect(plan.warnings).toEqual([]);
  });

  it('keeps both spellings: relative and root-prefixed references', () => {
    const moves = new Map([['Machine/Mount', 'Machine/Base']]);
    const referrers = [{
      nodePath: 'Machine/Cell/Lift',
      extras: { TransportSurface: { DriveReference: ref('Mount/Kine'), Legacy: ref('Machine/Mount/Kine') } },
    }];
    const plan = run(referrers, moves);
    const byField = Object.fromEntries(plan.steps.map((s) => [s.field, (s.value as { path: string }).path]));
    expect(byField).toEqual({ DriveReference: 'Base/Kine', Legacy: 'Machine/Base/Kine' });
  });

  it('array field: StaticColliders hits merge into ONE step with the complete value', () => {
    const moves = new Map([['Machine/Walls', 'Machine/Hopper/Walls']]);
    const referrers = [{
      nodePath: 'Machine/Zone',
      extras: { WebPhysicsZone: { StaticColliders: ['Walls/A', 'Walls/B', 'Other/C'], Gravity: 1 } },
    }];
    const plan = run(referrers, moves);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].field).toBe('StaticColliders');
    expect(plan.steps[0].value).toEqual(['Hopper/Walls/A', 'Hopper/Walls/B', 'Other/C']);
    expect(plan.steps[0].prev).toBe(referrers[0].extras.WebPhysicsZone.StaticColliders);
  });

  it('ComponentReference array: several hits → one step', () => {
    const moves = new Map([['Machine/Walls', 'Machine/Hopper/Walls']]);
    const referrers = [{
      nodePath: 'Machine/Zone',
      extras: { WebVisibility: { AdditionalTargets: [ref('Walls/A', ''), ref('Other/C', ''), ref('Walls/B', '')] } },
    }];
    const plan = run(referrers, moves);
    expect(plan.steps).toHaveLength(1);
    expect((plan.steps[0].value as Array<{ path: string }>).map((r) => r.path)).toEqual(['Hopper/Walls/A', 'Other/C', 'Hopper/Walls/B']);
  });

  it('deep field: steps[].targetObjects / targetObject merge into one `steps` step, other data kept', () => {
    const moves = new Map([['Machine/Walls', 'Machine/Hopper/Walls']]);
    const steps = [
      { instruction: 'one', targetObjects: ['Walls/A', 'Other/C'], targetObject: 'Walls/B', url: 'u' },
      { instruction: 'two', targetObjects: ['Walls/B'], targetObject: { path: 'Walls/A' } },
      { instruction: 'three', targetObject: ref('Walls/A', '') },
    ];
    const referrers = [{ nodePath: 'Machine/Zone', extras: { CustomRuntimeInstruction: { steps, Title: 't' } } }];
    const plan = run(referrers, moves);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].field).toBe('steps');
    expect(plan.steps[0].value).toEqual([
      { instruction: 'one', targetObjects: ['Hopper/Walls/A', 'Other/C'], targetObject: 'Hopper/Walls/B', url: 'u' },
      { instruction: 'two', targetObjects: ['Hopper/Walls/B'], targetObject: { path: 'Hopper/Walls/A' } },
      { instruction: 'three', targetObject: ref('Hopper/Walls/A', '') },
    ]);
    // The ComponentReference-shaped target is rewritten once (generic walk), not twice.
    expect(plan.counts.referencesRewritten).toBe(5);
  });

  it('records inside an array: Connections.connections[].source / target', () => {
    const moves = new Map([['Machine/Cell', 'Machine/Area/Cell']]);
    const connections = [
      { source: 'Cell/Lift', target: 'Conveyor/Drive', kind: 'flow' },
      { source: 'Conveyor/Drive', target: 'Cell/Drive' },
    ];
    const referrers = [{ nodePath: 'Machine/Zone', extras: { Connections: { connections } } }];
    const plan = run(referrers, moves);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].value).toEqual([
      { source: 'Area/Cell/Lift', target: 'Conveyor/Drive', kind: 'flow' },
      { source: 'Conveyor/Drive', target: 'Area/Cell/Drive' },
    ]);
  });

  it('a `_N` dedup key uses its base type\'s path fields (Kinematic_1.Parent)', () => {
    const moves = new Map([['Machine/Mount', 'Machine/Base']]);
    const referrers = [{ nodePath: 'Machine/Cell', extras: { Kinematic_1: { Parent: 'Mount/Kine', GroupNamePrefix: 'Mount' } } }];
    const plan = run(referrers, moves);
    expect(plan.steps).toEqual([expect.objectContaining({ componentType: 'Kinematic_1', field: 'Parent', value: 'Base/Kine' })]);
  });

  it('referrer inside the moved subtree: addressed by its POST-move path', () => {
    const moves = new Map([['Machine/Cell', 'Machine/Area/Cell']]);
    const referrers = [{
      nodePath: 'Machine/Cell/Lift',
      extras: { TransportSurface: { DriveReference: ref('Cell/Drive'), Outside: ref('Conveyor/Drive') } },
    }];
    const plan = run(referrers, moves);
    expect(plan.steps).toEqual([expect.objectContaining({
      nodePath: 'Machine/Area/Cell/Lift', oldNodePath: 'Machine/Cell/Lift', field: 'DriveReference',
      value: ref('Area/Cell/Drive'),
    })]);
  });

  it('reference from the moved subtree out: unchanged, no step', () => {
    const moves = new Map([['Machine/Cell', 'Machine/Area/Cell']]);
    const referrers = [{ nodePath: 'Machine/Cell/Lift', extras: { TransportSurface: { DriveReference: ref('Conveyor/Drive') } } }];
    const plan = run(referrers, moves);
    expect(plan.steps).toEqual([]);
    expect(plan.counts.referencesSeen).toBe(1);
  });

  it('name field: unique target renamed → name step; moved only → nothing', () => {
    const referrers = [{ nodePath: 'Machine/Src', extras: { Source: { ThisObjectAsMU: 'Box' } } }];
    const resolveName = (): ResolveNameHit => ({ canonical: 'Machine/Src/Box' });
    const renamed = run(referrers, new Map([['Machine/Src/Box', 'Machine/Src/Crate']]), { resolveName });
    expect(renamed.nameSteps).toEqual([expect.objectContaining({ nodePath: 'Machine/Src', componentType: 'Source', field: 'ThisObjectAsMU', value: 'Crate', prev: 'Box' })]);
    expect(renamed.counts.nameFieldsRewritten).toBe(1);
    expect(renamed.steps).toEqual([]);

    const moved = run(referrers, new Map([['Machine/Src/Box', 'Machine/Src/Holder/Box']]), { resolveName });
    expect(moved.nameSteps).toEqual([]);
  });

  it('name field: ambiguous → warning, no step; without a resolver → warning, no step', () => {
    const referrers = [{ nodePath: 'Machine/Src', extras: { Source: { ThisObjectAsMU: 'Box' } } }];
    const moves = new Map([['Machine/Src/Box', 'Machine/Src/Crate']]);
    const ambiguous = run(referrers, moves, { resolveName: () => ({ canonical: null, ambiguous: true }) });
    expect(ambiguous.nameSteps).toEqual([]);
    expect(ambiguous.warnings).toEqual([expect.objectContaining({ code: 'name-field-ambiguous', field: 'ThisObjectAsMU', path: 'Box' })]);

    const unchecked = run(referrers, moves);
    expect(unchecked.nameSteps).toEqual([]);
    expect(unchecked.warnings).toEqual([expect.objectContaining({ code: 'name-field-unchecked' })]);

    // A name that no renamed node had stays silent.
    const other = run([{ nodePath: 'Machine/Src', extras: { Source: { ThisObjectAsMU: 'Pallet' } } }], moves, {
      resolveName: () => ({ canonical: null, ambiguous: true }),
    });
    expect(other.warnings).toEqual([]);
  });

  it('a foreign referrer (referenced content) is skipped entirely', () => {
    const moves = new Map([['Machine/Mount', 'Machine/Base']]);
    const referrers = [
      { nodePath: 'Machine/Layout/Arburg_1/Part', extras: { TransportSurface: { DriveReference: ref('Mount/Kine') } } },
      { nodePath: 'Machine/Cell', extras: { TransportSurface: { DriveReference: ref('Mount/Kine') } } },
    ];
    const plan = run(referrers, moves, { isForeign: (p) => p.startsWith('Machine/Layout/Arburg_1') });
    expect(plan.steps.map((s) => s.nodePath)).toEqual(['Machine/Cell']);
    expect(plan.counts.skippedForeign).toBe(1);
  });

  it('a fallback hit onto a moved node is healed onto the exact new path; without a scope root it is a warning', () => {
    const moves = new Map([['Machine/Mount', 'Machine/Base']]);
    const referrers = [{ nodePath: 'Machine/Cell', extras: { TransportSurface: { DriveReference: ref('Kine') } } }];
    const healed = run(referrers, moves);
    expect(healed.steps[0].value).toEqual(ref('Base/Kine'));
    expect(healed.counts.referencesHealed).toBe(1);

    const noScope = planReferenceRewrite({ referrers, moves, resolveOld: resolverFor(NODES, { withScope: false }) });
    expect(noScope.steps).toEqual([]);
    expect(noScope.warnings).toEqual([expect.objectContaining({ code: 'reference-heal-needs-scope' })]);
  });

  it('unresolved and empty references are left alone', () => {
    const moves = new Map([['Machine/Mount', 'Machine/Base']]);
    const referrers = [{ nodePath: 'Machine/Cell', extras: { TransportSurface: { A: ref('Gone/Away'), B: ref('') }, Kinematic: { Parent: '' } } }];
    const plan = run(referrers, moves);
    expect(plan.steps).toEqual([]);
    expect(plan.counts.unresolved).toBe(1);
  });

  it('idempotent: a second run with the same map over the rewritten state plans nothing', () => {
    const moves = new Map([['Machine/PLC', 'Machine/Signals'], ['Machine/Src/Box', 'Machine/Src/Crate'], ['Machine/Cell', 'Machine/Area/Cell']]);
    const referrers: ReferenceRewriteReferrer[] = [
      { nodePath: 'Machine/Cell/Lift', extras: { Drive_Cylinder: { In: ref('PLC/FG01/X'), Legacy: ref('Machine/PLC/FG01/Y') }, TransportSurface: { DriveReference: ref('Cell/Drive') } } },
      { nodePath: 'Machine/Zone', extras: { WebPhysicsZone: { StaticColliders: ['Cell/Lift', 'Walls/A'] }, Connections: { connections: [{ source: 'Cell/Drive', target: 'PLC/FG01' }] } } },
      { nodePath: 'Machine/Src', extras: { Source: { ThisObjectAsMU: 'Box' } } },
    ];
    const nameResolver = (nodes: string[]) => ({ name }: { name: string }): ResolveNameHit | null => {
      const hits = nodes.filter((p) => p.startsWith('Machine/Src/') && p.endsWith('/' + name));
      return hits.length === 1 ? { canonical: hits[0] } : null;
    };
    const first = run(referrers, moves, { resolveName: nameResolver(NODES) });
    expect(first.steps.length).toBeGreaterThan(0);
    expect(first.nameSteps).toHaveLength(1);

    const after = applyPlan(referrers, first, moves);
    const afterNodes = movedNodes(NODES, moves);
    const second = planReferenceRewrite({
      referrers: deepFreeze(after), moves, resolveOld: resolverFor(afterNodes), resolveName: nameResolver(afterNodes),
    });
    expect(second.steps).toEqual([]);
    expect(second.nameSteps).toEqual([]);
    // …and the rewritten references resolve on the moved tree, exactly.
    const resolve = resolverFor(afterNodes);
    expect(resolve({ path: 'Signals/FG01/X', componentType: undefined, referrerPath: '' })?.stage).toBe('exact');
    expect((after[0].extras!.Drive_Cylinder as Record<string, { path: string }>).Legacy.path).toBe('Machine/Signals/FG01/Y');
  });

  it('never mutates its input (frozen extras) and plain objects work as the move map', () => {
    const referrers = [{ nodePath: 'Machine/Zone', extras: { WebPhysicsZone: { StaticColliders: ['Walls/A'] } } }];
    const plan = planReferenceRewrite({
      referrers: deepFreeze(referrers),
      moves: { 'Machine/Walls': 'Machine/Hopper/Walls' },
      resolveOld: resolverFor(NODES),
    });
    expect(plan.steps[0].value).toEqual(['Hopper/Walls/A']);
    expect(referrers[0].extras.WebPhysicsZone.StaticColliders).toEqual(['Walls/A']);
  });
});

// ─── Parity with REFERENCE_BAKE_TARGETS (plan-610 Phase 1 step 3) ─────────

describe('parity: core field tables ↔ REFERENCE_BAKE_TARGETS', () => {
  /**
   * pathString entries of the bake table that are deliberately NOT rewrite fields.
   * Each needs a reason.
   */
  const PATH_STRING_EXCEPTIONS: Record<string, string> = {
    'Kinematic.GroupNamePrefix': 'a group-name prefix, not a node path — renaming a node never changes it',
    'Group.GroupNamePrefix': 'a group-name prefix, not a node path — renaming a node never changes it',
  };
  const key = (e: { component: string; field: string }) => `${e.component}.${e.field}`;

  it('every pathString entry of the bake table is in PATH_FIELDS or a justified exception', () => {
    const core = new Set(PATH_FIELDS.map(key));
    for (const e of REFERENCE_BAKE_TARGETS.filter((x) => x.kind === 'pathString')) {
      const k = key(e);
      if (core.has(k)) continue;
      expect(PATH_STRING_EXCEPTIONS[k], `${k} is a pathString in REFERENCE_BAKE_TARGETS but neither in PATH_FIELDS nor a justified exception`).toBeTruthy();
    }
  });

  it('every core path / name field reaches the bake table with its kind', () => {
    const bake = new Map(REFERENCE_BAKE_TARGETS.map((e) => [key(e), e.kind]));
    for (const e of PATH_FIELDS) expect(bake.get(key(e)), key(e)).toBe('pathString');
    for (const e of NAME_FIELDS) expect(bake.get(key(e)), key(e)).toBe('nameInSubtree');
    for (const k of Object.keys(PATH_STRING_EXCEPTIONS)) expect(PATH_FIELDS.map(key)).not.toContain(k);
  });

  it('the derived table is byte-identical to the pre-plan-610 literal (order included)', () => {
    expect(REFERENCE_BAKE_TARGETS.map((e) => ({ ...e }))).toEqual([
      { component: 'KinematicJoint', field: 'BodyA', kind: 'ref', bakeTarget: 'chunk' },
      { component: 'KinematicJoint', field: 'BodyB', kind: 'ref', bakeTarget: 'chunk' },
      { component: 'WebVisibility', field: 'AdditionalTargets', kind: 'refArray', bakeTarget: 'chunk' },
      { component: 'Chain', field: 'ChainElement', kind: 'ref', bakeTarget: 'chunk' },
      { component: 'Source', field: 'ThisObjectAsMU', kind: 'nameInSubtree', bakeTarget: 'chunk' },
      { component: 'RibbonWinder', field: 'RollMesh', kind: 'ref', bakeTarget: 'chunk' },
      { component: 'RibbonRoller', field: 'MantleMesh', kind: 'ref', bakeTarget: 'chunk' },
      { component: 'RibbonWinder', field: 'MantleMesh', kind: 'ref', bakeTarget: 'chunk' },
      { component: 'RibbonDancer', field: 'MantleMesh', kind: 'ref', bakeTarget: 'chunk' },
      { component: 'CustomRuntimeInstruction', field: 'steps.targetObjects', kind: 'pathString', bakeTarget: 'chunk' },
      { component: 'CustomRuntimeInstruction', field: 'steps.targetObject', kind: 'pathString', bakeTarget: 'chunk' },
      // plan-769: the only row added since plan-610 — LogicStep_Enable.Target became a PATH_FIELDS entry.
      { component: 'LogicStep_Enable', field: 'Target', kind: 'pathString', bakeTarget: 'chunk' },
      { component: 'EnergyChain', field: 'Anchor', kind: 'ref', bakeTarget: 'merge' },
      { component: 'EnergyChain', field: 'Follower', kind: 'ref', bakeTarget: 'merge' },
      { component: 'KinematicTarget', field: 'TargetLink', kind: 'ref', bakeTarget: 'merge' },
      { component: 'Kinematic', field: 'Parent', kind: 'pathString', bakeTarget: 'merge' },
      { component: 'Kinematic', field: 'GroupNamePrefix', kind: 'pathString', bakeTarget: 'merge' },
      { component: 'Group', field: 'GroupNamePrefix', kind: 'pathString', bakeTarget: 'merge' },
      { component: 'WebPhysicsZone', field: 'StaticColliders', kind: 'pathString', bakeTarget: 'merge' },
      // plan-661 (intentional addition): the 2D zone's node references.
      { component: 'WebPhysicsZone2D', field: 'Surface', kind: 'ref', bakeTarget: 'merge' },
      { component: 'WebPhysicsZone2D', field: 'Guides', kind: 'refArray', bakeTarget: 'merge' },
      { component: 'WebPhysicsZone2D', field: 'KinematicDrives', kind: 'refArray', bakeTarget: 'merge' },
      // plan-673: the ORDER of a policy's axes is its actuator order, so a
      // target that vanished in the bake would shift every axis after it.
      { component: 'LocomotionPolicy', field: 'Axes', kind: 'refArray', bakeTarget: 'merge' },
      { component: 'Connections', field: 'connections.source', kind: 'pathString', bakeTarget: 'merge' },
      { component: 'Connections', field: 'connections.target', kind: 'pathString', bakeTarget: 'merge' },
      // Intentional addition: RobotIK.TCP. `merge`, not `chunk` — the node must only
      // EXIST so the joint chain can read its world matrix; it draws nothing.
      { component: 'RobotIK', field: 'TCP', kind: 'pathString', bakeTarget: 'merge' },
      // plan-2016 S1: Source.Destination — the MU parent node only has to exist.
      { component: 'Source', field: 'Destination', kind: 'pathString', bakeTarget: 'merge' },
      // plan-2016 S4: Grip.PickAlignWithObject — only the align node's world pose is read.
      { component: 'Grip', field: 'PickAlignWithObject', kind: 'pathString', bakeTarget: 'merge' },
    ]);
    expect(Object.isFrozen(REFERENCE_BAKE_TARGETS)).toBe(true);
  });
});
