// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-703 §9.2 — the semantics guard for the three "near pairs".
 *
 * The scene and asset op logs each had 14 primitives + `composite`, and three
 * names looked shared while meaning different things. This file pins BOTH
 * lineages' semantics against the ONE vocabulary, so a later change cannot
 * quietly collapse them.
 *
 * Structure, per the plan: two separate expectation sets per pair — "this is how
 * the scene branch behaved" and "this is how the asset branch behaved" — each
 * naming the Phase-0 row that decided the case. Where a row decided NOT to merge
 * (P2, P3), the two sets assert that the kinds stay distinct and that each still
 * reaches its own executor.
 *
 * ── What plan-710 changed here ──────────────────────────────────────────────
 *
 * The ORIGIN TABLE and every behavioural expectation are unchanged — that is the
 * point of a pinning test. What went away is the scaffolding: each case used to
 * build a LEGACY record and push it through `upcastEditOp` / `upcastAssetOp`
 * first, and asserted `downcastTo*` round-trips. Both vocabularies are gone, so
 * the ops are now constructed in the one that remains and the ~10 downcast
 * assertions have no subject left. The lineage question they answered —
 * "which executor does this op reach?" — is still asserted, through
 * `resolveOpTarget`, which is the mechanism that actually decides it.
 *
 * Renderer-free: real NodeRegistry + real three Scene, no WebGLRenderer.
 */
import { describe, it, expect } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  RV_OP_ORIGIN,
  RV_OP_KINDS,
  type RvOp,
  type RvTransformNodeOp,
  type RvAddNodeOp,
  type RvRemoveNodeOp,
  type RvCreateNodeOp,
  type RvDeleteNodeOp,
} from '../src/core/ops/rv-unified-ops';
import { RvUnifiedExecutor, resolveOpTarget } from '../src/core/ops/rv-unified-executors';

let seq = 0;
function header() {
  seq += 1;
  return { id: 'op_pin_' + seq, ts: 1000 + seq, schemaV: 1 as const };
}

/** Mock viewer: real registry + real Scene, no renderer. */
function makeViewer(opts?: { mirrorScale?: boolean }) {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  const box = new Object3D();
  box.name = 'Box';
  if (opts?.mirrorScale) box.scale.set(-1, 1, 1);
  box.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
  model.add(box);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  // Bake world matrices: the frozen-safe scene path rebuilds the local TRS from
  // matrixWorld, so an un-updated tree would fake a scale of (1,1,1).
  scene.updateMatrixWorld(true);

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  const boxPath = NodeRegistry.computeNodePath(box);
  return { viewer, scene, model, box, boxPath, registry };
}

// ══════════════════════════════════════════════════════════════════════
// Union shape — the counts the Phase-0 table claims
// ══════════════════════════════════════════════════════════════════════

describe('unified vocabulary shape', () => {
  it('has 25 primitives + composite (14 + 14 - 2 identical - 1 merged)', () => {
    expect(RV_OP_KINDS).toHaveLength(26);
    expect(RV_OP_KINDS.filter((k) => k !== 'composite')).toHaveLength(25);
  });

  it('marks every kind with its origin, and only the truly shared ones as "both"', () => {
    const both = RV_OP_KINDS.filter((k) => RV_OP_ORIGIN[k] === 'both').slice().sort();
    // setField/unsetField were payload-identical; composite was form-identical;
    // transformNode is the ONE merge (Phase-0 row P1).
    expect(both).toEqual(['composite', 'setField', 'transformNode', 'unsetField']);
    expect(RV_OP_KINDS.filter((k) => RV_OP_ORIGIN[k] === 'scene')).toHaveLength(11);
    expect(RV_OP_KINDS.filter((k) => RV_OP_ORIGIN[k] === 'asset')).toHaveLength(11);
  });

  it('never invents a kind that existed in neither vocabulary', () => {
    expect(RV_OP_KINDS).not.toContain('setNodeTransform');
  });
});

// ══════════════════════════════════════════════════════════════════════
// PAIR 1 — the scene transform <-> transformNode  (Phase-0 row P1: MERGED)
// ══════════════════════════════════════════════════════════════════════

describe('P1 / scene branch — the scale-less transform keeps its semantics', () => {
  const sceneOp = (nodePath = 'Asset/Box'): RvTransformNodeOp => ({
    ...header(),
    kind: 'transformNode',
    nodePath,
    // No `scale` key at all — not `scale: undefined`. The ABSENCE is the
    // lineage marker, and it is what survives a JSON round-trip unchanged.
    transform: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
    prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  });

  it('carries no scale key — never [1,1,1]', () => {
    const op = sceneOp();
    expect(op.kind).toBe('transformNode');
    expect(op.transform.position).toEqual([1, 2, 3]);
    expect('scale' in op.transform).toBe(false);
    expect('scale' in op.prev).toBe(false);
    expect(op.transform.scale).toBeUndefined();
  });

  it('routes to the SCENE executor regardless of the document mode', () => {
    expect(resolveOpTarget(sceneOp(), 'scene')).toBe('scene');
    expect(resolveOpTarget(sceneOp(), 'asset')).toBe('scene');
  });

  it('leaves a mirror scale untouched on forward AND inverse', async () => {
    const { viewer, box, boxPath } = makeViewer({ mirrorScale: true });
    expect(box.scale.toArray()).toEqual([-1, 1, 1]);
    const exec = new RvUnifiedExecutor(viewer, 'asset'); // asset MODE, scene op
    const op = sceneOp(boxPath);

    await exec.applyForward(op);
    expect(box.position.toArray()).toEqual([1, 2, 3]);
    expect(box.scale.toArray()).toEqual([-1, 1, 1]); // the whole point

    await exec.applyInverse(op);
    expect(box.position.toArray()).toEqual([0, 0, 0]);
    expect(box.scale.toArray()).toEqual([-1, 1, 1]);
    exec.dispose();
  });
});

describe('P1 / asset branch — the full-TRS transform keeps its semantics', () => {
  const assetOp = (nodePath = 'Asset/Box'): RvTransformNodeOp => ({
    ...header(),
    kind: 'transformNode',
    nodePath,
    transform: { position: [4, 5, 6], quaternion: [0, 0, 0, 1], scale: [2, 2, 2] },
    prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  });

  it('carries the full TRS — the authored intent', () => {
    const op = assetOp();
    expect(op.transform.scale).toEqual([2, 2, 2]);
    expect(op.prev.scale).toEqual([1, 1, 1]);
  });

  it('routes to the ASSET executor regardless of the document mode', () => {
    expect(resolveOpTarget(assetOp(), 'asset')).toBe('asset');
    expect(resolveOpTarget(assetOp(), 'scene')).toBe('asset');
  });

  it('DOES write the scale, and undo restores the previous scale', async () => {
    const { viewer, box, boxPath } = makeViewer();
    const exec = new RvUnifiedExecutor(viewer, 'scene'); // scene MODE, asset op
    const op = assetOp(boxPath);

    await exec.applyForward(op);
    expect(box.position.toArray()).toEqual([4, 5, 6]);
    expect(box.scale.toArray()).toEqual([2, 2, 2]);

    await exec.applyInverse(op);
    expect(box.scale.toArray()).toEqual([1, 1, 1]);
    exec.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════════
// PAIR 2 — addNode <-> createNode  (Phase-0 row P2: NOT merged)
// ══════════════════════════════════════════════════════════════════════

describe('P2 / scene branch — addNode stays its own kind', () => {
  const op = (): RvAddNodeOp => ({
    ...header(),
    kind: 'addNode',
    nodePath: 'Asset/Way',
    spec: {
      parentPath: 'Asset',
      name: 'Way',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      components: { IKTarget: { Enabled: true } },
    },
  });

  it('keeps its component-bearing NodeSpec — the payload createNode has no room for', () => {
    expect(op().kind).toBe('addNode');
    expect(RV_OP_ORIGIN.addNode).toBe('scene');
    expect(op().spec.components.IKTarget).toEqual({ Enabled: true });
  });

  it('reaches the scene executor even from an asset-mode document', () => {
    expect(resolveOpTarget(op(), 'asset')).toBe('scene');
  });
});

describe('P2 / asset branch — createNode stays its own kind', () => {
  const op = (nodePath = 'Asset/Empty'): RvCreateNodeOp => ({
    ...header(),
    kind: 'createNode',
    nodePath,
    transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  });

  it('carries only transform + optional index — no components, ever', () => {
    expect(op().kind).toBe('createNode');
    expect(RV_OP_ORIGIN.createNode).toBe('asset');
    expect(Object.keys(op()).slice().sort())
      .toEqual(['id', 'kind', 'nodePath', 'schemaV', 'transform', 'ts']);
  });

  it('creates a bare Object3D, and undo DETACHES TO TRASH (identity preserved)', async () => {
    const { viewer, model, registry } = makeViewer();
    const exec = new RvUnifiedExecutor(viewer, 'asset');
    const path = NodeRegistry.computeNodePath(model) + '/Empty';
    const created0 = op(path);

    await exec.applyForward(created0);
    const created = registry.getNode(path);
    expect(created).toBeTruthy();
    expect((created as Object3D).children).toHaveLength(0);

    await exec.applyInverse(created0);
    expect(model.children).not.toContain(created);
    // The ORIGINAL object survives in the hidden trash — that is what lets a
    // later-added child survive an undo/redo cycle. addNode has no such trash.
    expect((created as Object3D).parent?.name).toBe('_rvAssetTrash');
    exec.dispose();
  });

  it('reaches the asset executor even from a scene-mode document', () => {
    expect(resolveOpTarget(op(), 'scene')).toBe('asset');
  });
});

// ══════════════════════════════════════════════════════════════════════
// PAIR 3 — removeNode <-> deleteNode  (Phase-0 row P3: NOT merged)
// ══════════════════════════════════════════════════════════════════════

describe('P3 / scene branch — removeNode stays its own kind', () => {
  const op = (): RvRemoveNodeOp => ({
    ...header(),
    kind: 'removeNode',
    nodePath: 'Asset/Way',
    spec: {
      parentPath: 'Asset',
      name: 'Way',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      components: { IKTarget: {} },
    },
  });

  it('carries the full spec — its undo RE-CREATES, it has no trash to restore from', () => {
    expect(op().kind).toBe('removeNode');
    expect(RV_OP_ORIGIN.removeNode).toBe('scene');
    expect(op().spec.name).toBe('Way');
  });

  it('reaches the scene executor — deleteNode could not supply the spec back', () => {
    expect(resolveOpTarget(op(), 'asset')).toBe('scene');
  });
});

describe('P3 / asset branch — deleteNode stays its own kind', () => {
  const op = (nodePath = 'Asset/Box'): RvDeleteNodeOp => ({
    ...header(),
    kind: 'deleteNode',
    nodePath,
  });

  it('carries ONLY a path — no spec exists, because the trash holds the objects', () => {
    expect(RV_OP_ORIGIN.deleteNode).toBe('asset');
    expect(Object.keys(op()).slice().sort()).toEqual(['id', 'kind', 'nodePath', 'schemaV', 'ts']);
  });

  it('reaches ANY subtree and undoes via the trash group, restoring the ORIGINAL object', async () => {
    const { viewer, model, box, boxPath, registry } = makeViewer();
    const exec = new RvUnifiedExecutor(viewer, 'asset');
    const del = op(boxPath);

    // Not an op-created node — a base-GLB node. removeNode could never touch it.
    await exec.applyForward(del);
    expect(model.children).not.toContain(box);
    expect(registry.getNode(boxPath)).toBeNull();
    expect(box.parent?.name).toBe('_rvAssetTrash');
    expect(box.parent?.visible).toBe(false);

    await exec.applyInverse(del);
    expect(model.children[0]).toBe(box); // same instance, original sibling slot
    expect(registry.getNode(boxPath)).toBe(box);
    exec.dispose();
  });

  it('reaches the asset executor even from a scene-mode document', () => {
    expect(resolveOpTarget(op(), 'scene')).toBe('asset');
  });
});

// ══════════════════════════════════════════════════════════════════════
// The genuinely shared kinds — the ONE place the document mode decides
// ══════════════════════════════════════════════════════════════════════

describe('setField / unsetField — identical payload, target chosen by mode', () => {
  const op = (nodePath: string): RvOp => ({
    ...header(),
    kind: 'setField',
    nodePath,
    componentType: 'Drive',
    fieldName: 'TargetSpeed',
    value: 200,
    prev: 50,
  });

  it('routes by mode, not by payload', () => {
    expect(resolveOpTarget(op('Asset/Box'), 'scene')).toBe('scene');
    expect(resolveOpTarget(op('Asset/Box'), 'asset')).toBe('asset');
    const unset = { ...op('Asset/Box'), kind: 'unsetField' } as RvOp;
    expect(resolveOpTarget(unset, 'asset')).toBe('asset');
    expect(resolveOpTarget(unset, 'scene')).toBe('scene');
  });

  it('writes the same userData in either mode (payload parity is real)', async () => {
    for (const mode of ['scene', 'asset'] as const) {
      const { viewer, box, boxPath } = makeViewer();
      const exec = new RvUnifiedExecutor(viewer, mode);
      const rv = () => (box.userData.realvirtual as Record<string, Record<string, unknown>>);
      await exec.applyForward(op(boxPath));
      expect(rv().Drive.TargetSpeed).toBe(200);
      await exec.applyInverse(op(boxPath));
      expect(rv().Drive.TargetSpeed).toBe(50);
      exec.dispose();
    }
  });
});
