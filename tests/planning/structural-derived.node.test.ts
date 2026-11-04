// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-681 §2.2 / 9.3a — the `structural-derived-locked` lock.
 *
 * What a structural rebuild derived (the PalletYard at another size) is
 * transient: it is never saved. The lock refuses an authoring op on it BEFORE
 * the op applies — through `applyOp`, `applyPlanned`, a composite that hides one
 * such child among legal ones, undo / redo, and a structural op on an ancestor
 * that would carry a derived root along. Scene AND history stay untouched.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  STRUCTURAL_DERIVED_LOCKED, StructuralDerivedLockedError, generatedOwnerOf, markStructuralDerived,
  clearStructuralDerived, structuralDerivedOwnerOf, structuralDerivedRefusal,
} from '../../src/core/engine/rv-structural-derived';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';

/** Root → Yard → { Conveyor_V3 (derived) → Belt, Conveyor_V1 (source) }. */
function scene() {
  const root = new Object3D(); root.name = 'Root';
  const yard = new Object3D(); yard.name = 'Yard'; root.add(yard);
  const derived = new Object3D(); derived.name = 'Conveyor_V3'; yard.add(derived);
  const belt = new Object3D(); belt.name = 'Belt'; derived.add(belt);
  const source = new Object3D(); source.name = 'Conveyor_V1'; yard.add(source);
  markStructuralDerived(derived, 'palletYard');
  const byPath = new Map<string, Object3D>([
    ['Root', root], ['Root/Yard', yard], ['Root/Yard/Conveyor_V3', derived],
    ['Root/Yard/Conveyor_V3/Belt', belt], ['Root/Yard/Conveyor_V1', source],
  ]);
  return { root, yard, derived, belt, source, locate: (p: string) => byPath.get(p) ?? null };
}

let seq = 0;
const setField = (nodePath: string): RvOp => ({
  id: `op-${++seq}`, kind: 'setField', nodePath, componentType: 'Conveyor', fieldName: 'Speed', value: 2, prev: 1,
} as unknown as RvOp);
const removeNode = (nodePath: string): RvOp => ({ id: `op-${++seq}`, kind: 'removeNode', nodePath } as unknown as RvOp);
const composite = (ops: RvOp[]): RvOp => ({ id: `op-${++seq}`, kind: 'composite', label: 'batch', ops } as unknown as RvOp);

describe('structuralDerivedRefusal', () => {
  it('refuses an op on a derived root and below it, lets a source node through', () => {
    const s = scene();
    expect(structuralDerivedRefusal(setField('Root/Yard/Conveyor_V3'), s.locate)?.code).toBe(STRUCTURAL_DERIVED_LOCKED);
    expect(structuralDerivedRefusal(setField('Root/Yard/Conveyor_V3/Belt'), s.locate)?.owner).toBe('palletYard');
    expect(structuralDerivedRefusal(setField('Root/Yard/Conveyor_V1'), s.locate)).toBeNull();
  });

  it('refuses a STRUCTURAL op on an ancestor (it would carry the derived root along), not a value edit', () => {
    const s = scene();
    expect(structuralDerivedRefusal(removeNode('Root/Yard'), s.locate)?.nodePath).toBe('Root/Yard');
    expect(structuralDerivedRefusal(setField('Root/Yard'), s.locate)).toBeNull();
  });

  it('refuses creating a node below a derived root (the target path does not resolve yet)', () => {
    const s = scene();
    const add = (nodePath: string): RvOp => ({ id: `op-${++seq}`, kind: 'addNode', nodePath } as unknown as RvOp);
    expect(structuralDerivedRefusal(add('Root/Yard/Conveyor_V3/Belt/NewPart'), s.locate)?.code).toBe(STRUCTURAL_DERIVED_LOCKED);
    expect(structuralDerivedRefusal(add('Root/Yard/NewPart'), s.locate)).toBeNull();
  });

  it('checks every child of a composite', () => {
    const s = scene();
    const r = structuralDerivedRefusal(composite([setField('Root/Yard/Conveyor_V1'), setField('Root/Yard/Conveyor_V3/Belt')]), s.locate);
    expect(r?.nodePath).toBe('Root/Yard/Conveyor_V3/Belt');
  });

  it('a cleared mark unlocks, an unresolvable target is not this rule\'s business', () => {
    const s = scene();
    clearStructuralDerived(s.derived);
    expect(structuralDerivedOwnerOf(s.belt)).toBeNull();
    expect(structuralDerivedRefusal(setField('Root/Yard/Conveyor_V3'), s.locate)).toBeNull();
    expect(structuralDerivedRefusal(setField('Root/Nowhere'), s.locate)).toBeNull();
  });

  it('reads the Generated owner marker', () => {
    const n = new Object3D();
    expect(generatedOwnerOf(n)).toBeNull();
    n.userData.realvirtual = { Generated: { owner: 'palletYard' } };
    expect(generatedOwnerOf(n)).toBe('palletYard');
  });
});

describe('RvDocument op guard + history guard (scene-store wiring, plan-681)', () => {
  function doc() {
    const s = scene();
    const applied: string[] = [];
    const inverted: string[] = [];
    const d = new RvDocument({
      id: 'scene', name: '', mode: 'scene',
      executor: {
        applyForward: async (op) => { applied.push(op.id); },
        applyInverse: async (op) => { inverted.push(op.id); },
      },
    });
    d.addOpGuard((op) => {
      const r = structuralDerivedRefusal(op, s.locate);
      return r ? new StructuralDerivedLockedError(r) : null;
    });
    d.addHistoryGuard((op) => structuralDerivedRefusal(op, s.locate) === null);
    return { s, d, applied, inverted };
  }

  it('applyOp on a derived node rejects with the lock, nothing applied or recorded', async () => {
    const { d, applied } = doc();
    await expect(d.applyOp(setField('Root/Yard/Conveyor_V3'))).rejects.toMatchObject({ code: STRUCTURAL_DERIVED_LOCKED });
    expect(applied).toEqual([]);
    expect(d.ops.length).toBe(0);
  });

  it('applyPlanned with a composite hiding one derived child rejects as a whole', async () => {
    const { d, applied } = doc();
    await expect(d.applyPlanned(() => ({
      op: composite([setField('Root/Yard/Conveyor_V1'), setField('Root/Yard/Conveyor_V3')]), result: 1,
    }))).rejects.toBeInstanceOf(StructuralDerivedLockedError);
    expect(applied).toEqual([]);
    expect(d.ops.length).toBe(0);
  });

  it('a source edit applies; an undo / redo of an entry that became derived is refused, the stacks stay', async () => {
    const { s, d, applied, inverted } = doc();
    const op = setField('Root/Yard/Conveyor_V1');
    await d.applyOp(op);
    expect(applied).toEqual([op.id]);
    markStructuralDerived(s.source, 'palletYard');
    await d.undo();
    expect(inverted).toEqual([]);
    expect(d.ops.length).toBe(1);
    clearStructuralDerived(s.source);
    await d.undo();
    expect(inverted).toEqual([op.id]);
    markStructuralDerived(s.source, 'palletYard');
    await d.redo();
    expect(applied).toEqual([op.id]);
    expect(d.ops.length).toBe(0);
  });
});
