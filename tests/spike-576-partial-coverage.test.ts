// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * spike-576-partial-coverage.test.ts — plan-576 Phase 1, NACHMESSUNG (SOL R2-2 / R2-4).
 *
 * Erkenntnis, kein Feature. The first spike measured "does this op leave ANY
 * trace in the fold?" and concluded "covered" from that. SOL round 2 proved
 * that inference too coarse in three places, and the SHRUNK design of plan 2.5
 * stands or falls exactly there: the coverage boundary is binary and stops at
 * the first op the producer does not carry COMPLETELY. So the question is no
 * longer "which KINDS does a producer carry?" but
 *
 *     "does this producer carry THIS CONCRETE op completely?"
 *
 * **Every test here passes.** They document the IST state, including where that
 * state is the bug. Nothing is stubbed away: the measurements drive the real
 * `materialise()`, the real `applyOverlayToNode()` (the loader's own overlay
 * merge) and a real `AssetExecutorContext.applyForward()`.
 *
 * -- Measured answer ---------------------------------------------------------
 *
 * | Op variant | carried completely by `_bakeCurrent`? | measurement |
 * |---|---|---|
 * | `transformNode` without `scale` (scene lineage) | **yes** | C1 (control) |
 * | `transformNode` with `scale` on a base-GLB node | **NO** — scale silently dropped | C1 |
 * | `transformNode` with `scale` on an op-created node | **NO** — `spec.scale` untouched | C3 |
 * | `unsetField` on a field set earlier in the SAME log | **yes** | C4 |
 * | `unsetField` on a field that is in the BASE bytes | **NO** — fold emits nothing at all | C5 |
 * | `composite` with all children carried | **yes** | C9 |
 * | `composite` with ONE uncarried child | **NO**, and "half" is not expressible | C7 / C8 |
 *
 * The three gaps have ONE shape: a trace in the fold is evidence about the
 * op's EASY half, never about the op. `transformNode` writes position and
 * rotation and drops scale; `unsetField` removes an overlay entry and cannot
 * remove a base field; a `composite` is flattened and its children are judged
 * one by one, so a single log entry can be part-carried.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { applyOverlayToNode } from '../src/core/engine/rv-extras-overlay-store';
import { AssetExecutorContext } from '../src/core/editor/rv-asset-executors';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp, RvPrimitiveOp } from '../src/core/ops/rv-unified-ops';
import type { RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';
import type { RVViewer } from '../src/core/rv-viewer';

// --- Fixtures ----------------------------------------------------------

let opSeq = 0;
const head = () => ({ id: `op_576_C_${++opSeq}`, ts: 10_000, schemaV: 1 as const });
const op = (rest: Record<string, unknown>) => ({ ...head(), ...rest } as unknown as RvPrimitiveOp);

/** `transformNode`, with or without the OPTIONAL scale (rv-unified-ops.ts:119). */
function transformNode(nodePath: string, scale?: [number, number, number]): RvPrimitiveOp {
  return op({
    kind: 'transformNode',
    nodePath,
    transform: { position: [1, 0, 0], quaternion: [0, 0, 0, 1], ...(scale ? { scale } : {}) },
    prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], ...(scale ? { scale: [1, 1, 1] } : {}) },
  });
}

function setField(value: unknown, nodePath = 'Asset/Box', fieldName = 'TargetSpeed'): RvPrimitiveOp {
  return op({ kind: 'setField', nodePath, componentType: 'Drive', fieldName, value, prev: 50 });
}

function unsetField(nodePath = 'Asset/Box', fieldName = 'TargetSpeed'): RvPrimitiveOp {
  return op({ kind: 'unsetField', nodePath, componentType: 'Drive', fieldName, prev: 50 });
}

function createNode(nodePath = 'Asset/Empty'): RvPrimitiveOp {
  return op({
    kind: 'createNode',
    nodePath,
    transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  });
}

function addNode(nodePath = 'Asset/Lamp'): RvPrimitiveOp {
  return op({
    kind: 'addNode',
    nodePath,
    spec: {
      parentPath: 'Asset', name: 'Lamp',
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
      components: {},
    },
  });
}

function setCamera(): RvPrimitiveOp {
  return op({ kind: 'setCamera', preset: { position: [1, 2, 3], target: [0, 0, 0] }, prev: null });
}

function composite(label: string, ops: RvPrimitiveOp[]): RvOp {
  return { ...head(), kind: 'composite', label, ops } as unknown as RvOp;
}

const fold = (ops: RvOp[]) => JSON.stringify(materialise(ops));

/** A base-GLB node that already carries the field in its rv_extras. */
function baseNodeWith(value: unknown): Object3D {
  const node = new Object3D();
  node.name = 'Box';
  node.userData.realvirtual = { Drive: { TargetSpeed: value } };
  return node;
}

function driveOf(node: Object3D): Record<string, unknown> {
  return (node.userData.realvirtual as Record<string, Record<string, unknown>>).Drive;
}

// ======================================================================
// LUECKE 1 -- transformNode with a scale the fold throws away (R2-2).
// ======================================================================

describe('C -- Luecke 1: transformNode mit Skalierung', () => {
  it('MESSUNG C1: the fold drops `scale` entirely -- yet leaves a trace, so the old fixture called it covered', () => {
    // The fold's only transform carrier is `NodeTransformEntry`
    // (rv-scene-edits.ts:256-260) and it HAS NO SCALE FIELD -- position and
    // quaternion only. `applyForwardPure` case 'transformNode'
    // (rv-scene-edits.ts:432-437) copies exactly those two.
    const withScale = materialise([transformNode('Asset/Box', [2, 3, 4])]);
    expect(withScale.nodeTransforms).toHaveLength(1);
    const entry = withScale.nodeTransforms[0];

    // The concrete field, by name: there is none, and no stand-in either.
    expect(Object.keys(entry).sort()).toEqual(['nodePath', 'position', 'quaternion']);
    expect('scale' in entry).toBe(false);
    expect((entry as unknown as Record<string, unknown>).scale).toBeUndefined();

    // Byte-blind: the op WITH a scale of (2,3,4) folds to the same thing as the
    // op without any scale. The scale is not merely unapplied, it is
    // unrepresentable -- so no downstream consumer can recover it
    // (`bakeIntoGlb` iterates these entries at rv-scene-glb-bake.ts:1030, the
    // viewer applies them at rv-viewer.ts:5501 via `applyLocalPose(node,
    // position, quaternion)`).
    expect(fold([transformNode('Asset/Box', [2, 3, 4])]))
      .toBe(fold([transformNode('Asset/Box')]));

    // And THIS is the measurement gap: the trace test the first spike used says
    // "covered" for both, because position alone already moves the fold.
    const traceAgainstEmpty = fold([transformNode('Asset/Box', [2, 3, 4])]) !== fold([]);
    expect(traceAgainstEmpty).toBe(true);
  });

  it('MESSUNG C2: the asset executor DOES carry the scale -- the asymmetry is real, not a type artefact', async () => {
    // Counter-measurement: a producer that carries the op COMPLETELY exists, so
    // "not completely carried" is a statement about `_bakeCurrent`, not about a
    // scale nobody ever applies. `rv-asset-executors.ts:954` passes
    // `scale: t.scale ?? node.scale.toArray()` into `applyTransform`.
    const { viewer, tree } = makeAssetViewer();
    const ctx = new AssetExecutorContext(viewer);
    await ctx.applyForward(transformNode('Asset/Box', [2, 3, 4]) as never);

    const box = tree.root.getObjectByName('Box')!;
    expect(box.scale.toArray()).toEqual([2, 3, 4]);
    expect(box.position.toArray()).toEqual([1, 0, 0]);
  });

  it('MESSUNG C3: on an op-created node the scale is dropped too -- `spec.scale` is never written', () => {
    // The second branch of case 'transformNode' (rv-scene-edits.ts:427-431)
    // folds the transform into the creation spec -- but only `spec.position`
    // and `spec.quaternion`. `NodeSpec` HAS a `scale` (rv-scene-edits.ts:207),
    // so here the sink exists and is still not fed.
    const edits = materialise([addNode('Asset/Lamp'), transformNode('Asset/Lamp', [2, 3, 4])]);
    expect(edits.addedNodes).toHaveLength(1);
    const spec = edits.addedNodes[0].spec;

    expect(spec.position).toEqual([1, 0, 0]);
    expect(spec.scale).toEqual([1, 1, 1]); // the addNode value, not (2,3,4)
    expect(fold([addNode('Asset/Lamp'), transformNode('Asset/Lamp', [2, 3, 4])]))
      .toBe(fold([addNode('Asset/Lamp'), transformNode('Asset/Lamp')]));
  });
});

// ======================================================================
// LUECKE 2 -- unsetField against a field that is already in the base (R2-2).
// ======================================================================

describe('C -- Luecke 2: unsetField auf Basis- vs. Log-Feld', () => {
  it('MESSUNG C4: unsetField of a field set in the SAME log is carried completely', () => {
    // Case the old fixture measured (`setupFor('unsetField')` prepends a
    // `setField`). The pair cancels inside the overlay, and since the base
    // never had the field, the resulting bytes are right.
    expect(fold([setField(400), unsetField()])).toBe(fold([]));
    expect(materialise([setField(400), unsetField()]).overlay.nodes).toEqual({});

    // Applied to a base node WITHOUT the field, nothing is left behind.
    const clean = new Object3D();
    clean.name = 'Box';
    clean.userData.realvirtual = { Drive: { Speed: 1 } };
    applyOverlayToNode(clean, 'Asset/Box', materialise([setField(400), unsetField()]).overlay);
    expect('TargetSpeed' in driveOf(clean)).toBe(false);
  });

  it('MESSUNG C5: unsetField of a BASE field emits NOTHING -- the base value survives the fold', () => {
    // `applyForwardPure` case 'unsetField' (rv-scene-edits.ts:445-452) is a
    // `delete` on the OVERLAY: `if (!compOv) return;`. The overlay starts empty
    // (`emptyOverlay()`, :301) and knows nothing about the loaded bytes, so an
    // unset of a field the overlay never held is a no-op...
    expect(fold([unsetField()])).toBe(fold([]));
    expect(materialise([unsetField()]).overlay.nodes).toEqual({});

    // ...and the real overlay merge therefore leaves the base value in place.
    // This is the loader's own function and the same RFC 7396 semantics
    // `bakeIntoGlb` writes with (`applyPatchToGltfNode`,
    // rv-scene-glb-bake.ts:550-566), so the bytes keep the field as well.
    const node = baseNodeWith(50);
    const changed = applyOverlayToNode(node, 'Asset/Box', materialise([unsetField()]).overlay);
    expect(changed).toBe(false);
    expect(driveOf(node).TargetSpeed).toBe(50);

    // The user, however, HAS seen it disappear: `unsetFieldForward`
    // (rv-scene-executors.ts:238) calls `deleteUserDataField` on the live node.
    // Live state and folded state therefore disagree -- which is exactly what
    // "not completely carried" has to mean.
  });

  it('MESSUNG C6: the delete mechanism EXISTS (null deletes) -- unsetField simply never produces it', () => {
    // So the gap is not "bytes cannot express a deletion". A `null` in the
    // overlay deletes (rv-extras-overlay-store.ts:87 → applyComponentPatch,
    // mirrored by rv-scene-glb-bake.ts:560). `unsetField` folds to an ABSENT
    // key instead of a `null` one -- an absent key means "no opinion".
    const node = baseNodeWith(50);
    const nullPatch: RVExtrasOverlay = {
      $schema: 'rv-extras-overlay/1.0', $source: 'edits',
      nodes: { 'Asset/Box': { Drive: { TargetSpeed: null } } },
    } as unknown as RVExtrasOverlay;
    expect(applyOverlayToNode(node, 'Asset/Box', nullPatch)).toBe(true);
    expect('TargetSpeed' in driveOf(node)).toBe(false);
  });
});

// ======================================================================
// LUECKE 3 -- composite with mixed children (R2-4).
// ======================================================================

describe('C -- Luecke 3: composite mit gemischten Kindern', () => {
  it('MESSUNG C7: children are judged INDIVIDUALLY -- a composite can be half carried', () => {
    // `flattenOps` (rv-scene-edits.ts:364-371) splices a composite's children
    // into the primitive stream; `applyForwardPure` then sees children, never
    // the composite. So a composite of one carried and one dropped child folds
    // to exactly its carried half.
    const mixed = composite('create + edit', [createNode(), setField(400)]);
    expect(fold([mixed])).toBe(fold([setField(400)]));

    // Proof the half is a HALF and not a nothing: the carried child is there...
    expect(materialise([mixed]).overlay.nodes['Asset/Box']).toEqual({ Drive: { TargetSpeed: 400 } });
    // ...and the dropped child left no trace whatsoever (createNode hits the
    // `default` branch, rv-scene-edits.ts:483).
    expect(materialise([mixed]).addedNodes).toEqual([]);
    expect(fold([mixed])).not.toBe(fold([createNode()]));
  });

  it('MESSUNG C8: a composite is ONE log entry -- so "half" is not expressible as a prefix', () => {
    // This is what makes R2-4 a contract question rather than a detail: the
    // coverage prefix counts entries of `doc._ops`, and the composite is one
    // of them, while the fold consumed two children.
    const mixed = composite('create + edit', [createNode(), setField(400)]);
    const log: RvOp[] = [mixed];
    expect(log).toHaveLength(1);
    expect((mixed as unknown as { ops: RvPrimitiveOp[] }).ops).toHaveLength(2);

    // `prefix = 1` would declare the whole entry contained -- including the
    // `createNode` nothing wrote (the Festo mechanism, one level deeper than
    // MESSUNG A2). `prefix = 0` is the only honest answer, and it costs the
    // carried `setField` a replay -- which is harmless, because a replayed
    // carried op is idempotent on its own result, while a SKIPPED uncarried op
    // is lost.
    expect(fold(log)).toBe(fold([setField(400)]));

    // Composites never nest (rv-unified-ops.ts:189/193: `ops: RvPrimitiveOp[]`),
    // so the AND over children is one level deep, not a recursion. The TYPE
    // carries that already -- `c.kind !== 'composite'` is a TS2367 error on
    // `RvPrimitiveOp`, which is a stronger guarantee than a runtime check, so
    // the measurement is made against the erased kind on purpose. (It also
    // means `flattenOps`' non-recursive single splice is sufficient, despite
    // its doc comment saying "recursively".)
    const children = (mixed as unknown as { ops: Array<{ kind: string }> }).ops;
    expect(children.every((c) => c.kind !== 'composite')).toBe(true);
  });

  it('MESSUNG C9: a composite whose children are ALL carried is carried completely (control)', () => {
    const allCarried = composite('field + camera', [setField(400), setCamera()]);
    expect(fold([allCarried])).toBe(fold([setField(400), setCamera()]));
    expect(materialise([allCarried]).cameraStart).not.toBeNull();
  });

  it('MESSUNG C10: the gap generalises -- a composite with an UNCARRIED VARIANT of a carried kind', () => {
    // Luecke 1 and Luecke 3 compose: the child kind (`transformNode`) is in the
    // 14 "covered" kinds of MESSUNG A1, yet this child is not carried because
    // of its payload. A kind-level predicate would wave this composite through.
    const scaled = composite('scale + edit', [transformNode('Asset/Box', [2, 3, 4]), setField(400)]);
    expect(fold([scaled])).toBe(fold([transformNode('Asset/Box'), setField(400)]));
    expect(materialise([scaled]).nodeTransforms[0]).not.toHaveProperty('scale');
  });
});

// --- The asset-side counter-measurement needs a tree -------------------

function makeAssetViewer() {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  for (const name of ['Box', 'Frame']) {
    const node = new Object3D();
    node.name = name;
    node.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
    root.add(node);
  }
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  const viewer = {
    get scene() { return scene; },
    get registry() { return registry; },
    get currentModelRoot() { return root; },
    currentModelUrl: 'spike576://asset.glb',
    signalStore: null,
    transportManager: null,
    instancePickIndex: undefined,
    groups: undefined,
    getPlugin: () => undefined,
    markRenderDirty() {},
    markShadowsDirty() {},
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    rebuildIKPaths() {},
    emit() {},
    on() { return () => {}; },
  };
  return { viewer: viewer as unknown as RVViewer, tree: { scene, root, registry } };
}
