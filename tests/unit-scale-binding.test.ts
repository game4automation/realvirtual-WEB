// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-512 §9.4 — the unit-aware bind against the real pieces: `RvDocument` +
 * scene executors + `SignalBindingManager` + node persistence (rig:
 * tests/helpers/unit-scale-rig.ts; the transaction shape was characterised by
 * the spike, commits 06fe904a/ff676df4).
 *
 * One factor rule for command AND feedback slots, shared scale fields, the
 * write rule F6 (never over a user's value), the 3-op bracket (the factor
 * changes only while the slot is unbound — forward, undo, redo, rollback),
 * verification from the resulting state, serialisation per document, and the
 * v1 boundary (placements, no document).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unitRig, type UnitRig } from './helpers/unit-scale-rig';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { isFieldOverridden } from '../src/core/hmi/rv-field-override';
import {
  bindWithUnitScale,
  evaluateTargetUnits,
  evaluateUnitBinding,
  buildUnitEvalContext,
  reconcileUnitProblems,
  shouldWriteScale,
} from '../src/plugins/signal-bind/unit-scale';
import { createSignalBindingPersistence } from '../src/plugins/signal-bind/signal-binding-persistence';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import type { SignalBindTarget } from '../src/plugins/signal-bind/signal-bind-target';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';
import type { RVViewer } from '../src/core/rv-viewer';

const FP = 'Drive_FollowPosition';
const DS = 'Drive_Simple';

let rigs: UnitRig[] = [];
function rig(opts: Parameters<typeof unitRig>[0]): UnitRig {
  const r = unitRig(opts);
  rigs.push(r);
  return r;
}

function fp(extra: Record<string, unknown> = {}, direction?: string): UnitRig {
  return rig({ behaviors: { [FP]: { ...extra } }, direction });
}

function unitProblems(code?: string) {
  return getProblems().filter((p) => p.id.startsWith('unit:') && (!code || p.code === code));
}

/** Field names of the composite ops of the newest undo entry. */
function lastComposite(r: UnitRig): { label?: string; fields: string[] } {
  const last = r.doc.ops[r.doc.ops.length - 1] as unknown as { kind: string; label?: string; ops?: { fieldName: string }[]; fieldName?: string };
  return last.kind === 'composite'
    ? { label: last.label, fields: last.ops!.map((o) => o.fieldName) }
    : { fields: [last.fieldName!] };
}

beforeEach(() => resetProblemsForTests());
afterEach(() => {
  for (const r of rigs) r.dispose();
  rigs = [];
});

describe('factor rule — command slots', () => {
  it('Ball.h (m) → Drive_FollowPosition.Position on a linear drive writes Scale 1000 with provenance', async () => {
    const r = fp();
    const h = r.signal('Ball.h', 'PLCOutputFloat', 'm');
    const res = await r.bind('Position', h);
    expect(res?.persisted).toBe(true);
    expect(res?.wroteScale).toBe(true);
    expect(r.extras(FP, 'Scale')).toBe(1000);
    expect(r.component<{ Scale: number }>(FP).Scale).toBe(1000);
    expect(r.mapping('Position')?.unitScale).toEqual({ field: 'Scale', factor: 1000, from: 'm', to: 'mm' });
    expect(res?.status).toEqual({ kind: 'auto', field: 'Scale', factor: 1000, from: 'm', to: 'mm' });
    // One undo step: mapping and factor together.
    expect(r.doc.opCount).toBe(1);
    expect(lastComposite(r).fields).toEqual(['Scale', 'Mappings']);
  });

  it('a rotary drive resolves @drive-position to deg: rad → Scale ≈ 57.2958', async () => {
    const r = fp({}, 'RotationZ');
    const phi = r.signal('Arm.phi', 'PLCOutputFloat', 'rad');
    const res = await r.bind('Position', phi);
    expect(r.extras(FP, 'Scale') as number).toBeCloseTo(57.29578, 4);
    expect(res?.status.kind).toBe('auto');
    expect(r.mapping('Position')?.unitScale?.to).toBe('deg');
  });
});

describe('factor rule — feedback slots (signal = target / S)', () => {
  it('Drive_Simple.IsAtPosition in m at 1000 mm → CurrentPositionScale 1000, the feedback reads 1', async () => {
    const r = rig({ behaviors: { [DS]: {} } });
    const fb = r.signal('PLC.PosM', 'PLCInputFloat', 'm');
    const res = await r.bind('IsAtPosition', fb);
    expect(res?.status.kind).toBe('auto');
    expect(r.extras(DS, 'CurrentPositionScale')).toBe(1000);
    expect(r.store.getFloat('PLC.PosM')).toBe(1);
    r.moveTo(2500);
    expect(r.store.getFloat('PLC.PosM')).toBe(2.5);
  });

  it('Drive_FollowPosition: Position then CurrentPosition (both m) set Scale ONCE, no conflict, feedback 1', async () => {
    for (const order of [['Position', 'CurrentPosition'], ['CurrentPosition', 'Position']] as const) {
      const r = fp();
      const cmd = r.signal('Ball.h', 'PLCOutputFloat', 'm');
      const fb = r.signal('PLC.FbM', 'PLCInputFloat', 'm');
      const src = { Position: cmd, CurrentPosition: fb };
      await r.bind(order[0], src[order[0]]);
      const second = await r.bind(order[1], src[order[1]]);
      expect(r.extras(FP, 'Scale')).toBe(1000);
      // The second bind did not write the shared field again.
      expect(lastComposite(r).fields).toEqual(['Mappings']);
      expect(second?.status.kind).toBe('auto');
      expect(unitProblems()).toEqual([]);
      r.moveTo(1000);
      expect(r.store.getFloat('PLC.FbM')).toBe(1);
    }
  });

  it('the FIRST published feedback is already scaled (1, never 1000)', async () => {
    const r = fp();
    const fb = r.signal('PLC.FbM', 'PLCInputFloat', 'm');
    r.log.length = 0;
    await r.bind('CurrentPosition', fb);
    const fbWrites = r.log.filter((l) => l.startsWith('PLC.FbM='));
    expect(fbWrites.length).toBeGreaterThan(0);
    expect(fbWrites[0]).toBe('PLC.FbM=1');
    expect(fbWrites).not.toContain('PLC.FbM=1000');
  });
});

describe('shared scale fields', () => {
  it('Drive_Simple: Speed (m/s) then Accelaration (mm/s2) — ScaleSpeed stays 1000, the second is a conflict', async () => {
    const r = rig({ behaviors: { [DS]: {} } });
    const speed = r.signal('PLC.Speed', 'PLCOutputFloat', 'm/s');
    const acc = r.signal('PLC.Acc', 'PLCOutputFloat', 'mm/s2');
    await r.bind('Speed', speed);
    const second = await r.bind('Accelaration', acc);
    expect(r.extras(DS, 'ScaleSpeed')).toBe(1000);
    expect(second?.status).toMatchObject({ kind: 'conflict', field: 'ScaleSpeed', factor: 1, otherSlot: 'Speed' });
    expect(r.mapping('Accelaration')?.unitScale).toBeUndefined();
    const conflicts = unitProblems('unit-scale-conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe(`unit:${r.nodePath}:.:Accelaration`);
  });

  it('...and the reverse order is symmetric', async () => {
    const r = rig({ behaviors: { [DS]: {} } });
    const speed = r.signal('PLC.Speed', 'PLCOutputFloat', 'm/s');
    const acc = r.signal('PLC.Acc', 'PLCOutputFloat', 'mm/s2');
    await r.bind('Accelaration', acc);
    const second = await r.bind('Speed', speed);
    expect(r.extras(DS, 'ScaleSpeed')).toBe(1);
    expect(second?.status).toMatchObject({ kind: 'conflict', field: 'ScaleSpeed', factor: 1000, otherSlot: 'Accelaration' });
    expect(unitProblems('unit-scale-conflict').map((p) => p.id)).toEqual([`unit:${r.nodePath}:.:Speed`]);
  });
});

describe('write rule F6 — never over the user', () => {
  it('re-bind after a manual Scale = 500 keeps 500, the mapping carries no provenance, status manual', async () => {
    const r = fp();
    const h = r.signal('Ball.h', 'PLCOutputFloat', 'm');
    await r.bind('Position', h);
    await r.edit(FP, 'Scale', 500);
    const res = await r.bind('Position', h);
    expect(r.extras(FP, 'Scale')).toBe(500);
    expect(Object.hasOwn(r.mapping('Position')!, 'unitScale')).toBe(false);
    expect(res?.status).toMatchObject({ kind: 'manual', factor: 1000, current: 500 });
  });

  it('a field the user set to the default 1 is overridden and stays 1 (scene overlay, main-model node)', async () => {
    const r = fp();
    await r.edit(FP, 'Scale', 1);
    expect(isFieldOverridden(r.viewer, r.nodePath, FP, 'Scale')).toBe(true);
    const res = await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    expect(r.extras(FP, 'Scale')).toBe(1);
    expect(res?.status).toMatchObject({ kind: 'manual', factor: 1000, current: 1 });
    expect(Object.hasOwn(r.mapping('Position')!, 'unitScale')).toBe(false);
  });

  it('manual 500 → bind whose factor happens to be 500 → re-bind in cm: stays 500 (no applied provenance)', async () => {
    const r = fp();
    await r.edit(FP, 'Scale', 500);
    const half = r.signal('Odd.x', 'PLCOutputFloat', 'halfm', { dims: { m: 1 }, factor: 0.5, offset: 0 });
    const first = await r.bind('Position', half);
    expect(first?.wroteScale).toBe(false);
    expect(Object.hasOwn(r.mapping('Position')!, 'unitScale')).toBe(false);
    const cm = r.signal('Ball.hcm', 'PLCOutputFloat', 'cm');
    const res = await r.bind('Position', cm);
    expect(r.extras(FP, 'Scale')).toBe(500);
    expect(res?.status).toMatchObject({ kind: 'manual', factor: 10, current: 500 });
  });

  it('re-bind without a manual change (m → cm) rewrites Scale = 10 and updates the provenance', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    const res = await r.bind('Position', r.signal('Ball.hcm', 'PLCOutputFloat', 'cm'));
    expect(r.extras(FP, 'Scale')).toBe(10);
    expect(r.mapping('Position')?.unitScale).toEqual({ field: 'Scale', factor: 10, from: 'cm', to: 'mm' });
    expect(res?.status.kind).toBe('auto');
    expect(lastComposite(r).fields).toEqual(['Mappings', 'Scale', 'Mappings']);
  });

  it('shouldWriteScale is exactly rule F6', () => {
    expect(shouldWriteScale({ current: 1, isOverridden: false, factor: 1000 })).toBe(true);
    expect(shouldWriteScale({ current: 1, isOverridden: true, factor: 1000 })).toBe(false);
    const prev = { field: 'Scale', factor: 1000, from: 'm', to: 'mm' };
    expect(shouldWriteScale({ current: 1000, isOverridden: true, previous: prev, factor: 10 })).toBe(true);
    expect(shouldWriteScale({ current: 500, isOverridden: true, previous: prev, factor: 10 })).toBe(false);
  });
});

describe('reset to auto (one transaction: factor + provenance)', () => {
  it('manual → reset → auto; a later re-bind in cm writes 10; undo/redo walk the steps', async () => {
    const r = fp();
    const h = r.signal('Ball.h', 'PLCOutputFloat', 'm');
    await r.bind('Position', h);
    await r.edit(FP, 'Scale', 500);
    await r.bind('Position', h); // manual, no provenance
    expect(Object.hasOwn(r.mapping('Position')!, 'unitScale')).toBe(false);
    const before = r.doc.opCount;
    const res = await r.reset('Position');
    expect(r.doc.opCount - before).toBe(1);
    expect(lastComposite(r).fields).toEqual(['Mappings', 'Scale', 'Mappings']);
    expect(r.extras(FP, 'Scale')).toBe(1000);
    expect(r.mapping('Position')?.unitScale).toEqual({ field: 'Scale', factor: 1000, from: 'm', to: 'mm' });
    expect(res?.status.kind).toBe('auto');
    await r.bind('Position', r.signal('Ball.hcm', 'PLCOutputFloat', 'cm'));
    expect(r.extras(FP, 'Scale')).toBe(10);
    await r.doc.undo();
    expect(r.extras(FP, 'Scale')).toBe(1000);
    expect(r.mapping('Position')?.signal).toBe('Ball.h');
    expect(r.mapping('Position')?.unitScale?.factor).toBe(1000);
    await r.doc.redo();
    expect(r.extras(FP, 'Scale')).toBe(10);
    expect(r.mapping('Position')?.signal).toBe('Ball.hcm');
  });

  it('reset on a bound feedback slot: the first emission after the reset carries the new factor; undo restores 500', async () => {
    const r = fp();
    const fb = r.signal('PLC.FbM', 'PLCInputFloat', 'm');
    await r.bind('CurrentPosition', fb);
    await r.edit(FP, 'Scale', 500);
    await r.bind('CurrentPosition', fb);
    r.log.length = 0;
    await r.reset('CurrentPosition');
    expect(r.log.filter((l) => l.startsWith('PLC.FbM='))[0]).toBe('PLC.FbM=1');
    r.log.length = 0;
    await r.doc.undo();
    expect(r.extras(FP, 'Scale')).toBe(500);
    expect(r.log.filter((l) => l.startsWith('PLC.FbM='))[0]).toBe('PLC.FbM=2');
  });
});

describe('feedback preconditions → not-effective', () => {
  it('ScaleFeedbackPosition = false: bound, not auto, Problems unit-scale-not-effective, no write', async () => {
    const r = fp({ ScaleFeedbackPosition: false });
    const res = await r.bind('CurrentPosition', r.signal('PLC.FbM', 'PLCInputFloat', 'm'));
    expect(res?.persisted).toBe(true);
    expect(res?.status).toMatchObject({ kind: 'not-effective', blockedBy: 'ScaleFeedbackPosition=false' });
    expect(r.extras(FP, 'Scale')).toBeUndefined();
    const p = unitProblems('unit-scale-not-effective');
    expect(p).toHaveLength(1);
    expect(p[0].detail).toContain('ScaleFeedbackPosition=false');
  });

  it('Drive_FollowPosition with CurrentPositionScale = 2: not-effective', async () => {
    const r = fp({ CurrentPositionScale: 2 });
    const res = await r.bind('CurrentPosition', r.signal('PLC.FbM', 'PLCInputFloat', 'm'));
    expect(res?.status).toMatchObject({ kind: 'not-effective', blockedBy: 'CurrentPositionScale=2' });
    expect(unitProblems('unit-scale-not-effective')).toHaveLength(1);
  });
});

describe('the 3-op bracket at the relay writer (SOL R3 #1)', () => {
  it('re-bind A(m) → B(cm): forward only B=100, undo only A=1, redo only B=100; ONE undo step', async () => {
    const r = fp();
    const a = r.signal('PLC.FbM', 'PLCInputFloat', 'm');
    const b = r.signal('PLC.FbCm', 'PLCInputFloat', 'cm');
    await r.bind('CurrentPosition', a);
    const tag = (l: string) => (l.startsWith('PLC.FbM=') ? l.replace('PLC.FbM', 'A') : l.startsWith('PLC.FbCm=') ? l.replace('PLC.FbCm', 'B') : null);
    const seen = () => r.log.map(tag).filter(Boolean);
    r.log.length = 0;
    const before = r.doc.opCount;
    await r.bind('CurrentPosition', b, 'Re-bind to B');
    expect(seen()).toEqual(['B=100']);
    expect(r.doc.opCount - before).toBe(1);
    expect(lastComposite(r)).toEqual({ label: 'Re-bind to B', fields: ['Mappings', 'Scale', 'Mappings'] });
    r.log.length = 0;
    await r.doc.undo();
    expect(seen()).toEqual(['A=1']);
    expect(r.extras(FP, 'Scale')).toBe(1000);
    r.log.length = 0;
    await r.doc.redo();
    expect(seen()).toEqual(['B=100']);
  });

  it('an element with a control slot bound too: the control slot stays bound through the bracket', async () => {
    const r = fp();
    const cmd = r.signal('Ball.h', 'PLCOutputFloat', 'm');
    const a = r.signal('PLC.FbM', 'PLCInputFloat', 'm');
    const b = r.signal('PLC.FbCm', 'PLCInputFloat', 'cm');
    await r.bind('Position', cmd);
    await r.bind('CurrentPosition', a);
    const hooks: string[] = [];
    const off = r.manager.addBindingsChangedListener((id) => hooks.push(id));
    await r.bind('CurrentPosition', b);
    off();
    // Re-dispatch count (spike restrisk 2): the bracket re-applies the element twice.
    expect(hooks).toEqual([r.nodePath, r.nodePath]);
    expect(r.manager.getBindingLiveness(r.nodePath, 'Position', '.')).toBe('live');
    // B is cm but the shared Scale belongs to Position (m, provenance) → conflict, no write.
    expect(r.extras(FP, 'Scale')).toBe(1000);
    expect(r.mapping('CurrentPosition')?.signal).toBe('PLC.FbCm');
  });
});

describe('verification and rollback', () => {
  it('a failure AFTER the extras write, BEFORE the runtime took it: verifyApplied throws, everything rolls back', async () => {
    const r = fp();
    const comp = r.component<Record<string, unknown>>(FP);
    let scale = comp.Scale as number;
    Object.defineProperty(comp, 'Scale', {
      configurable: true,
      get: () => scale,
      set: (v: number) => { if (v === 1000) throw new Error('injected'); scale = v; },
    });
    const res = await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    expect(res?.persisted).toBe(false);
    expect(res?.error).toContain('running component');
    expect(r.doc.opCount).toBe(0);
    expect(r.extras(FP, 'Scale')).toBeUndefined();
    expect(r.mapping('Position')).toBeUndefined();
    expect(r.manager.getBindingLiveness(r.nodePath, 'Position', '.')).toBeUndefined();
  });

  it('a bind during a scene load (ops dropped) reports persisted: false, no provenance, no problem', async () => {
    const r = fp();
    r.canApply.value = false;
    const res = await r.bind('Position', r.signal('Ball.rad', 'PLCOutputFloat', 'rad'));
    expect(res?.persisted).toBe(false);
    expect(r.mapping('Position')).toBeUndefined();
    expect(r.extras(FP, 'Scale')).toBeUndefined();
    expect(unitProblems()).toEqual([]);
  });
});

describe('serialisation per document', () => {
  it('two overlapping binds become two undo steps; a failing second rolls back and leaves the first intact', async () => {
    const r = fp();
    const fb = r.signal('PLC.FbM', 'PLCInputFloat', 'm');
    const cmd = r.signal('PLC.Cmd', 'PLCOutputFloat');
    // Hold the first bind's mapping op mid-transaction.
    const g = r.gate((op) => op.kind === 'setField' && op.fieldName === 'Mappings');
    const p1 = r.bind('CurrentPosition', fb, 'Bind A');
    // The second bind fails its runtime verification.
    const orig = r.manager.getBindingLiveness.bind(r.manager);
    r.manager.getBindingLiveness = (id, slot, cp) => (slot === 'Position' ? undefined : orig(id, slot, cp));
    const p2 = r.bind('Position', cmd, 'Bind B');
    await g.reached;
    g.release();
    const [a, b] = await Promise.all([p1, p2]);
    r.manager.getBindingLiveness = orig;
    expect(a?.persisted).toBe(true);
    expect(b?.persisted).toBe(false);
    expect(r.doc.ops.map((o) => (o as { label?: string }).label)).toEqual(['Bind A']);
    expect(r.extras(FP, 'Scale')).toBe(1000);
    expect(r.persistence().read().map((m) => m.slot)).toEqual(['CurrentPosition']);
    // The chain survived the failure.
    const c = await r.bind('Position', cmd, 'Bind C');
    expect(c?.persisted).toBe(true);
    expect(r.doc.opCount).toBe(2);
  });
});

describe('undo / redo and the unbindAll path', () => {
  it('one undo takes mapping AND Scale back; redo restores both', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    await r.doc.undo();
    expect(r.extras(FP, 'Scale')).toBeUndefined();
    expect(r.component<{ Scale: number }>(FP).Scale).toBe(1);
    expect(r.mapping('Position')).toBeUndefined();
    await r.doc.redo();
    expect(r.extras(FP, 'Scale')).toBe(1000);
    expect(r.mapping('Position')?.unitScale?.factor).toBe(1000);
  });

  it('an incompatible FIRST binding → undo to zero mappings (unbindAll) → redo: the warning follows', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Arm.phi', 'PLCOutputFloat', 'rad'));
    expect(unitProblems('unit-mismatch')).toHaveLength(1);
    await r.doc.undo();
    expect(unitProblems()).toEqual([]);
    await r.doc.redo();
    expect(unitProblems('unit-mismatch')).toHaveLength(1);
  });

  it('an undo that removes the whole component key leaves nothing to trip over', async () => {
    const r = fp();
    // The behavior extras start empty: undoing the only field removes the key.
    await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    await r.doc.undo();
    expect((r.node.userData.realvirtual as Record<string, unknown>)[FP]).toBeUndefined();
    expect(isFieldOverridden(r.viewer, r.nodePath, FP, 'Scale')).toBe(false);
    const ghost = { kind: 'direct-property', componentPath: '.', componentType: FP, slot: 'Position', signal: 'Ball.h', direction: 'plcOutput', enabled: true } as SignalMapping;
    const status = evaluateUnitBinding(ghost, buildUnitEvalContext(r.viewer, r.target, [ghost]));
    expect(status).toMatchObject({ kind: 'manual', factor: 1000, current: 1 });
  });
});

describe('persistence details', () => {
  it('the helper writes through the anchored record: carrierSignalName survives into the document', async () => {
    const r = fp();
    // The carrier node is itself a registered signal → the node persistence anchors by name.
    r.store.register('AxisCarrier', r.nodePath, 0, 'PLCOutputFloat');
    await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    const doc = (r.node.userData.realvirtual as { SignalLinks: { Mappings: SignalMapping[] } }).SignalLinks.Mappings;
    expect(doc[0].carrierSignalName).toBe('AxisCarrier');
    expect(doc[0].unitScale?.factor).toBe(1000);
  });

  it('omitUndefined: no status other than a write leaves a unitScale key, and the draft JSON round-trips', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Plain.x', 'PLCOutputFloat'));
    const m = r.mapping('Position')!;
    expect(Object.hasOwn(m, 'unitScale')).toBe(false);
    for (const v of Object.values(m)) expect(v).not.toBeUndefined();
    const wire = JSON.parse(JSON.stringify(r.doc.ops)) as unknown;
    expect(wire).toEqual(r.doc.ops);
  });

  it('an unrelated unresolvable link of the same target survives a bind (mergeAppliedMappings)', async () => {
    const r = fp();
    const orphan: SignalMapping = {
      kind: 'direct-property', componentPath: 'Gone/Axis', componentType: FP, slot: 'Position',
      signal: 'Old.sig', interfaceId: 'plc', direction: 'plcOutput', enabled: true,
    };
    const p = r.persistence();
    await r.editTarget.setFieldAsync!(r.nodePath, 'SignalLinks', 'Mappings', [orphan], undefined);
    await r.bind('CurrentPosition', r.signal('PLC.FbM', 'PLCInputFloat', 'm'));
    expect(p.read().map((m) => `${m.componentPath}:${m.slot}`)).toEqual(['Gone/Axis:Position', '.:CurrentPosition']);
  });
});

describe('what the unit logic leaves alone', () => {
  it('a signal without a unit (CONNECT): no unitScale, field unchanged, no problem', async () => {
    const r = fp();
    const res = await r.bind('Position', r.signal('PLC.Pos', 'PLCOutputFloat'));
    expect(res?.status).toEqual({ kind: 'none' });
    expect(r.extras(FP, 'Scale')).toBeUndefined();
    expect(unitProblems()).toEqual([]);
  });

  it('rad → mm: the binding exists, Scale unchanged, Problems unit-mismatch with nodePath', async () => {
    const r = fp();
    const res = await r.bind('Position', r.signal('Arm.phi', 'PLCOutputFloat', 'rad'));
    expect(res?.persisted).toBe(true);
    expect(r.manager.getBindingLiveness(r.nodePath, 'Position', '.')).toBeDefined();
    expect(res?.status).toMatchObject({ kind: 'mismatch', reason: 'incompatible', from: 'rad', to: 'mm' });
    expect(r.extras(FP, 'Scale')).toBeUndefined();
    const p = unitProblems('unit-mismatch');
    expect(p).toHaveLength(1);
    expect(p[0].nodePath).toBe(r.nodePath);
    expect(p[0].severity).toBe('warning');
  });

  it('an unknown unit without FmuUnits → unit-unknown', async () => {
    const r = fp();
    const res = await r.bind('Position', r.signal('Odd.f', 'PLCOutputFloat', 'furlong'));
    expect(res?.status.kind).toBe('unknown');
    expect(unitProblems('unit-unknown')).toHaveLength(1);
  });
});

describe('v1 boundary', () => {
  it('no edit target: the mapping is kept, no field op, status not-applied', async () => {
    const r = fp();
    const off: EditTarget = { ...r.editTarget, available: false } as EditTarget;
    Object.defineProperty(off, 'available', { value: false });
    setActiveEditTarget(off);
    const res = await bindWithUnitScale(r.viewer, r.target, r.persistence(), r.row('Position'),
      r.signal('Ball.h', 'PLCOutputFloat', 'm'), { editTarget: off });
    expect(res?.persisted).toBe(true);
    expect(res?.status).toMatchObject({ kind: 'not-applied', factor: 1000 });
    expect(r.doc.opCount).toBe(0);
    expect(r.extras(FP, 'Scale')).toBeUndefined();
    expect(r.mapping('Position')?.unitScale).toBeUndefined();
  });

  it('a planner placement: mapping without unitScale, no field write, not-applied with the factor', async () => {
    const r = fp();
    let placedMappings: SignalMapping[] = [];
    const planner = {
      id: 'layout-planner',
      store: {
        getSnapshot: () => ({ placed: [{ id: 'P1', signalMappings: placedMappings }] }),
        updateSignalMappings: (_id: string, next: SignalMapping[]) => { placedMappings = next; },
        subscribe: () => () => {},
      },
      getPlacedRootById: (id: string) => (id === 'P1' ? r.node : null),
    };
    const viewer = { ...(r.viewer as unknown as Record<string, unknown>), getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined) } as unknown as RVViewer;
    const target: SignalBindTarget = { kind: 'placed', placedId: 'P1', node: r.node, label: 'P1' };
    r.manager.getElementSlots('P1', r.node, 'own');
    const persistence = createSignalBindingPersistence(viewer, target);
    const res = await bindWithUnitScale(viewer, target, persistence, r.row('Position'), r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    expect(res?.persisted).toBe(true);
    expect(res?.status).toMatchObject({ kind: 'not-applied', factor: 1000, from: 'm', to: 'mm' });
    expect(placedMappings[0].unitScale).toBeUndefined();
    expect(r.doc.opCount).toBe(0);
    expect(r.extras(FP, 'Scale')).toBeUndefined();
    // The plugin reconciles through the viewer that knows the planner.
    reconcileUnitProblems(viewer, 'P1');
    const hint = getProblems().find((p) => p.id === 'unit:P1:.:Position');
    expect(hint?.code).toBe('unit-scale-not-applied');
    expect(hint?.detail).toContain('×1000');
  });
});

describe('evaluateTargetUnits', () => {
  it('reports one status per mapping in persisted order', async () => {
    const r = fp();
    await r.bind('Position', r.signal('Ball.h', 'PLCOutputFloat', 'm'));
    await r.bind('CurrentPosition', r.signal('PLC.Fb', 'PLCInputFloat'));
    const out = evaluateTargetUnits(r.viewer, r.target, r.persistence().read());
    expect(out.map((e) => `${e.mapping.slot}:${e.status.kind}`)).toEqual(['Position:auto', 'CurrentPosition:none']);
  });
});

describe('MCP web_signal_bind', () => {
  it('binds through the same unit-aware path and answers with unitScale / unitStatus, confirmed from state', async () => {
    const { McpSignalBindTools } = await import('../src/plugins/mcp-bridge/rv-mcp-signal-bind-tools');
    const r = fp();
    r.signal('Ball.h', 'PLCOutputFloat', 'm');
    const viewer = Object.assign(r.viewer, { behaviors: { getActiveBinds: () => [] } });
    const tools = new McpSignalBindTools(() => viewer);
    const answer = JSON.parse(await tools.webSignalBind(r.nodePath, '.', 'Position', 'Ball.h')) as Record<string, unknown>;
    expect(answer.error).toBeUndefined();
    expect(answer.persisted).toBe(true);
    expect(answer.unitScale).toEqual({ field: 'Scale', factor: 1000, from: 'm', to: 'mm' });
    expect(answer.unitStatus).toBe('auto');
    expect(r.extras(FP, 'Scale')).toBe(1000);
    // Identical to the inspector path: one undo step with both ops.
    expect(r.doc.opCount).toBe(1);
    expect(lastComposite(r).fields).toEqual(['Scale', 'Mappings']);
  });
});
