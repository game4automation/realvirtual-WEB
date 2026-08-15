// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.7 — F8: structural ops never reach into a reference; value ops do and land
 * in `AssetOverrides.byNodeId` of the reference node (plan-703 Phase 7).
 *
 * The two halves are tested against the SAME node, because that is the whole
 * claim: the boundary is not around a node, it is around a KIND of change. A
 * test that refused one node and accepted a different one would prove nothing.
 *
 * Renderer-free: `guardReferenceOp` takes its lookup as a closure, so the
 * situation is three `Object3D`s and a `Map`.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  getAssetOverrides,
  setAssetReference,
} from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import {
  RV_OVERRIDABLE_OP_KINDS,
  RV_STRUCTURAL_OP_KINDS,
  guardReferenceOp,
  isStructuralOpKind,
  opTargetPaths,
  overrideTargetOf,
  overriddenFieldsOf,
  readOverride,
  revertComponentOverride,
  writeOverride,
} from '../src/core/ops/rv-reference-guard';
import type { RvOp } from '../src/core/ops/rv-unified-ops';

// ─── Fixture ────────────────────────────────────────────────────────────

/**
 * root
 *  +- Own            <- the open file's own content
 *  +- Ref            (AssetReference "Gripper")
 *     +- Inner       (NodeId "n-inner") <- both halves target THIS node
 */
function buildScene() {
  const root = new Object3D(); root.name = 'root';
  const own = new Object3D(); own.name = 'Own'; root.add(own);
  const ref = new Object3D(); ref.name = 'Ref'; root.add(ref);
  const inner = new Object3D(); inner.name = 'Inner'; ref.add(inner);

  setAssetReference(ref, { assetId: 'Gripper' });
  setNodeId(inner, 'n-inner');

  const byPath = new Map<string, Object3D>([
    ['root', root], ['root/Own', own], ['root/Ref', ref], ['root/Ref/Inner', inner],
  ]);
  const locate = (nodePath: string) => {
    const node = byPath.get(nodePath);
    if (!node) return null;
    // The production caller hands in `outermostReference`; here the fixture is
    // one level deep, so "is Ref an ancestor (inclusive)" is the same answer.
    let cur: Object3D | null = node;
    while (cur) { if (cur === ref) return { reference: ref }; cur = cur.parent; }
    return { reference: null };
  };
  return { root, own, ref, inner, locate };
}

let seq = 0;
function op(partial: Record<string, unknown>): RvOp {
  return { id: `op_${++seq}`, ts: Date.now(), schemaV: 1, ...partial } as unknown as RvOp;
}

// ─── Classification ─────────────────────────────────────────────────────

describe('op classification', () => {
  it('the two lists are disjoint — a kind is structural or overridable, never both', () => {
    for (const kind of RV_OVERRIDABLE_OP_KINDS) {
      expect(RV_STRUCTURAL_OP_KINDS.has(kind)).toBe(false);
    }
  });

  it('tree surgery, identity and material are all structural', () => {
    for (const kind of ['createNode', 'deleteNode', 'reparentNode', 'renameNode',
      'addComponent', 'removeComponent', 'setMaterial', 'mergeMesh', 'separateMesh',
      'setNodeVisible', 'transformNode'] as const) {
      expect(isStructuralOpKind(kind)).toBe(true);
    }
  });

  it('setField / unsetField are the overridable pair, and only those two', () => {
    expect([...RV_OVERRIDABLE_OP_KINDS].sort()).toEqual(['setField', 'unsetField']);
  });

  it('opTargetPaths reports every path an op touches, composites included', () => {
    expect(opTargetPaths(op({ kind: 'deleteNode', nodePath: 'a' }))).toEqual(['a']);
    expect(opTargetPaths(op({ kind: 'setMaterial', nodePaths: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(opTargetPaths(op({ kind: 'mergeMesh', rootPath: 'r', sourcePaths: ['a'] })))
      .toEqual(['r', 'a']);
    expect(opTargetPaths(op({
      kind: 'reparentNode', nodePath: 'n', newParentPath: 'p2', prevParentPath: 'p1',
    }))).toEqual(['n', 'p2', 'p1']);
    expect(opTargetPaths(op({
      kind: 'composite',
      label: 'x',
      ops: [op({ kind: 'setField', nodePath: 'a' }), op({ kind: 'deleteNode', nodePath: 'b' })],
    }))).toEqual(['a', 'b']);
  });
});

// ─── The refusal ────────────────────────────────────────────────────────

describe('structural ops inside a reference are REFUSED', () => {
  it('refuses each structural kind on a node inside the reference', () => {
    const s = buildScene();
    for (const kind of ['deleteNode', 'renameNode', 'reparentNode', 'createNode',
      'addComponent', 'removeComponent', 'setNodeVisible', 'transformNode'] as const) {
      const verdict = guardReferenceOp(
        op({ kind, nodePath: 'root/Ref/Inner', newParentPath: 'root', prevParentPath: 'root/Ref' }),
        s.locate,
      );
      expect(verdict.ok, `${kind} should be refused`).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toBe('structural-in-reference');
        expect(verdict.referenceNode).toBe(s.ref);
      }
    }
  });

  it('refuses on the reference node ITSELF — it is inside its own scope', () => {
    const s = buildScene();
    const verdict = guardReferenceOp(op({ kind: 'deleteNode', nodePath: 'root/Ref' }), s.locate);
    // Deleting the reference node is the parent's own content change and IS
    // allowed by the composition model, but not through this guard's lens:
    // `locate` reports the node as inside its own reference. The production
    // caller uses `outermostReference`, which is inclusive for exactly the same
    // reason the selection rule is — the reference is one thing, not two.
    expect(verdict.ok).toBe(false);
  });

  it('the message tells the user what to do instead', () => {
    const s = buildScene();
    const verdict = guardReferenceOp(op({ kind: 'deleteNode', nodePath: 'root/Ref/Inner' }), s.locate);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toContain('referenced asset');
      expect(verdict.message).toContain('every instance');
    }
  });

  it('a composite cannot smuggle a structural op past a legal one', () => {
    const s = buildScene();
    const verdict = guardReferenceOp(op({
      kind: 'composite',
      label: 'batch',
      ops: [
        op({ kind: 'setField', nodePath: 'root/Ref/Inner', componentType: 'Drive', fieldName: 'TargetSpeed' }),
        op({ kind: 'deleteNode', nodePath: 'root/Ref/Inner' }),
      ],
    }), s.locate);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.nodePath).toBe('root/Ref/Inner');
  });

  it('the SAME structural op on the file’s own content is accepted', () => {
    const s = buildScene();
    const verdict = guardReferenceOp(op({ kind: 'deleteNode', nodePath: 'root/Own' }), s.locate);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.scope).toBe('own-content');
  });

  it('an unclassified kind near a reference fails SAFE', () => {
    const s = buildScene();
    const verdict = guardReferenceOp(
      op({ kind: 'somethingNew', nodePath: 'root/Ref/Inner' }),
      s.locate,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('unclassified-in-reference');
  });
});

// ─── The acceptance, and where it lands ─────────────────────────────────

describe('setField on the same node is ACCEPTED and routes to the reference', () => {
  it('reports the override scope and names the owning reference node', () => {
    const s = buildScene();
    const verdict = guardReferenceOp(op({
      kind: 'setField', nodePath: 'root/Ref/Inner', componentType: 'Drive', fieldName: 'TargetSpeed',
    }), s.locate);
    expect(verdict.ok).toBe(true);
    if (verdict.ok && verdict.scope === 'override') {
      expect(verdict.referenceNode).toBe(s.ref);
      expect(verdict.nodePath).toBe('root/Ref/Inner');
    } else {
      throw new Error('expected an override verdict');
    }
  });

  it('unsetField is accepted the same way', () => {
    const s = buildScene();
    const verdict = guardReferenceOp(op({
      kind: 'unsetField', nodePath: 'root/Ref/Inner', componentType: 'Drive', fieldName: 'TargetSpeed',
    }), s.locate);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.scope).toBe('override');
  });

  it('overrideTargetOf names the reference node and the node id inside it', () => {
    const s = buildScene();
    const target = overrideTargetOf(s.inner, s.root);
    expect(target?.referenceNode).toBe(s.ref);
    expect(target?.nodeId).toBe('n-inner');
  });

  it('overrideTargetOf is null for the file’s own content and for the reference itself', () => {
    const s = buildScene();
    expect(overrideTargetOf(s.own, s.root)).toBeNull();
    // The reference node's OWN fields are this file's content, not an override
    // of anything — writing them into its own AssetOverrides would be circular.
    expect(overrideTargetOf(s.ref, s.root)).toBeNull();
  });

  it('the value lands in AssetOverrides.byNodeId of the reference node', () => {
    const s = buildScene();
    writeOverride(s.ref, 'n-inner', 'Drive', 'TargetSpeed', 250);

    const overrides = getAssetOverrides(s.ref);
    expect(overrides?.byNodeId).toEqual({ 'n-inner': { Drive: { TargetSpeed: 250 } } });
    expect(readOverride(s.ref, 'n-inner')).toEqual({ Drive: { TargetSpeed: 250 } });
    expect(overriddenFieldsOf(s.ref, 'n-inner', 'Drive')).toEqual(['TargetSpeed']);
    // …and NOT on the node it describes.
    expect(getAssetOverrides(s.inner)).toBeNull();
  });

  it('a second field joins the same patch instead of replacing it', () => {
    const s = buildScene();
    writeOverride(s.ref, 'n-inner', 'Drive', 'TargetSpeed', 250);
    writeOverride(s.ref, 'n-inner', 'Drive', 'Acceleration', 10);
    writeOverride(s.ref, 'n-inner', 'Sensor', 'Enabled', false);

    expect(getAssetOverrides(s.ref)?.byNodeId).toEqual({
      'n-inner': { Drive: { TargetSpeed: 250, Acceleration: 10 }, Sensor: { Enabled: false } },
    });
  });

  it('a literal null is stored — it is an RFC 7396 delete, not a revert', () => {
    const s = buildScene();
    writeOverride(s.ref, 'n-inner', 'Drive', 'TargetSpeed', null);
    expect(overriddenFieldsOf(s.ref, 'n-inner', 'Drive')).toEqual(['TargetSpeed']);
    expect(readOverride(s.ref, 'n-inner')?.Drive.TargetSpeed).toBeNull();
  });
});

describe('revert', () => {
  it('undefined removes one field and leaves the rest', () => {
    const s = buildScene();
    writeOverride(s.ref, 'n-inner', 'Drive', 'TargetSpeed', 250);
    writeOverride(s.ref, 'n-inner', 'Drive', 'Acceleration', 10);

    writeOverride(s.ref, 'n-inner', 'Drive', 'TargetSpeed', undefined);
    expect(overriddenFieldsOf(s.ref, 'n-inner', 'Drive')).toEqual(['Acceleration']);
  });

  it('reverting the last field leaves NO husk behind', () => {
    const s = buildScene();
    writeOverride(s.ref, 'n-inner', 'Drive', 'TargetSpeed', 250);
    writeOverride(s.ref, 'n-inner', 'Drive', 'TargetSpeed', undefined);

    // An AssetOverrides holding an empty patch would keep the badge lit at zero.
    expect(getAssetOverrides(s.ref)).toBeNull();
    expect(readOverride(s.ref, 'n-inner')).toBeNull();
  });

  it('revertComponentOverride clears one component and spares the others', () => {
    const s = buildScene();
    writeOverride(s.ref, 'n-inner', 'Drive', 'TargetSpeed', 250);
    writeOverride(s.ref, 'n-inner', 'Drive', 'Acceleration', 10);
    writeOverride(s.ref, 'n-inner', 'Sensor', 'Enabled', false);

    revertComponentOverride(s.ref, 'n-inner', 'Drive');
    expect(getAssetOverrides(s.ref)?.byNodeId).toEqual({ 'n-inner': { Sensor: { Enabled: false } } });
  });

  it('reverting a field that was never overridden changes nothing', () => {
    const s = buildScene();
    writeOverride(s.ref, 'n-inner', 'Drive', 'Nothing', undefined);
    expect(getAssetOverrides(s.ref)).toBeNull();
  });
});
