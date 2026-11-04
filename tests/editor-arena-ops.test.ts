// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.6 (ops part) — the arena op listener on the REAL AssetDocument
 * + executors (mock viewer pattern: rv-editor-pick-maintenance.test.ts).
 *
 * Real op path: transformNode (sync only), setNodeVisible, deleteNode + undo +
 * trash flush, setMaterial (same / other bucket) + undo.
 * Listener contract with synthetic ops (their executors need CAD / analysis
 * payloads this suite does not build): import with and without spare capacity,
 * separate / merge as tree edits + their op kinds, replay suspend → one build,
 * unknown op → one debounced rebuild.
 */
import { describe, it, expect, vi } from 'vitest';
import { Group, Scene, type Mesh } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { EditorArenaManager } from '../src/core/editor/rv-editor-arena';
import { EditorArenaOps, arenaReactionOf } from '../src/core/editor/rv-editor-arena-ops';
import type { RvAssetOp } from '../src/core/ops/rv-unified-ops';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { makeArenaViewerStub, part, testRoleOf, texturedMat, uberMat } from './helpers/editor-arena-fixture';

const IDENTITY = {
  position: [0, 0, 0] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function setup() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const a = new Group(); a.name = 'A';
  const b = new Group(); b.name = 'B';
  const meshA = part('MeshA', uberMat(0xff0000)); meshA.position.x = 0;
  const meshB = part('MeshB', uberMat(0x00ff00)); b.position.x = 5;
  a.add(meshA); b.add(meshB);
  model.add(a, b);
  model.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const stub = makeArenaViewerStub({ scene, registry, get currentModelRoot() { return model; } });
  const viewer = stub as unknown as RVViewer;
  const mgr = new EditorArenaManager({ scene, roleOf: testRoleOf });
  mgr.build(model);
  (stub as { editorArena: unknown }).editorArena = mgr;
  const ops = new EditorArenaOps(mgr, { resolveNode: (p) => registry.getNode(p) ?? null, debounceMs: 5 });
  const doc = scratchAssetDocument(viewer);
  ops.attach(doc.executor);
  const vis = (m: Mesh) => {
    const r = mgr.refOf(m)!;
    return r.arena.mesh.getVisibleAt(r.instanceId);
  };
  return { scene, model, registry, viewer, mgr, ops, doc, a, b, meshA, meshB, vis };
}

describe('arena op listener — real AssetDocument', () => {
  it('transformNode: no listener work, the pre-frame sync moves the instance', async () => {
    const { doc, mgr, ops, meshA } = setup();
    const ref = mgr.refOf(meshA)!;
    const spy = vi.spyOn(ref.arena.mesh, 'setMatrixAt');
    doc.transformNode('Asset/A', { ...IDENTITY, position: [3, 0, 0] }, IDENTITY);
    await doc.whenIdle();
    expect(ops.counters.ignored).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    mgr.beforeFrame();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('setNodeVisible → setVisibleAt on the next frame; undo shows it again', async () => {
    const { doc, mgr, ops, meshA, vis } = setup();
    doc.setNodeVisible('Asset/A', false);
    await doc.whenIdle();
    expect(ops.counters.visibility).toBe(1);
    mgr.beforeFrame();
    expect(vis(meshA)).toBe(false);
    expect(meshA.visible).toBe(true); // the source itself is never hidden
    expect(meshA.layers.mask).toBe(0);
    await doc.undo();
    await doc.whenIdle();
    mgr.beforeFrame();
    expect(vis(meshA)).toBe(true);
  });

  it('delete → hidden instance (trash), undo → visible, trash flush → removed and layer restored', async () => {
    const { doc, mgr, meshA, meshB, vis } = setup();
    await doc.deleteNodes(['Asset/A']);
    await doc.whenIdle();
    mgr.beforeFrame();
    expect(vis(meshA)).toBe(false);
    await doc.undo();
    await doc.whenIdle();
    mgr.beforeFrame();
    expect(vis(meshA)).toBe(true);
    await doc.redo();
    await doc.whenIdle();
    doc.executor.flushTrash();
    expect(mgr.refOf(meshA)).toBeUndefined();
    expect(meshA.layers.mask).toBe(1);
    expect(mgr.refOf(meshB)).toBeDefined();
  });

  it('setMaterial (op) re-buckets or recolours exactly the painted meshes; undo restores', async () => {
    const { doc, mgr, ops, meshA, meshB } = setup();
    const before = meshA.material;
    doc.setMaterial(['Asset/A'], {
      name: 'Glass', color: '#ffffff', metalness: 0, roughness: 0.1, opacity: 0.3, transparent: true,
    });
    await doc.whenIdle();
    expect(ops.counters.material).toBe(1);
    expect(meshA.material).not.toBe(before);
    expect(mgr.isStandalone(meshA)).toBe(true);
    expect(meshA.layers.mask).toBe(1);
    expect(mgr.refOf(meshB)).toBeDefined();
    await doc.undo();
    await doc.whenIdle();
    expect(meshA.material).toBe(before);
    expect(mgr.refOf(meshA)).toBeDefined();
    expect(meshA.layers.mask).toBe(0);
  });
});

describe('arena op listener — contract with synthetic ops', () => {
  const op = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ id: `op-${kind}`, ts: 0, schemaV: 1, kind, ...extra }) as unknown as RvAssetOp;

  it('reaction table (composites take the strongest child)', () => {
    expect(arenaReactionOf(op('transformNode'))).toBe('none');
    expect(arenaReactionOf(op('addComponent'))).toBe('none');
    expect(arenaReactionOf(op('setNodeVisible'))).toBe('visibility');
    expect(arenaReactionOf(op('deleteNode'))).toBe('visibility');
    expect(arenaReactionOf(op('setMaterial'))).toBe('material');
    for (const k of ['importCad', 'createNode', 'separateMesh', 'mergeMesh']) {
      expect(arenaReactionOf(op(k))).toBe('reconcile');
    }
    expect(arenaReactionOf(op('somethingNew'))).toBe('rebuild');
    expect(arenaReactionOf(op('composite', {
      label: 'x', ops: [op('transformNode'), op('importCad'), op('setNodeVisible')],
    }))).toBe('reconcile');
  });

  it('import with spare capacity: new meshes join the arena, no growth', () => {
    const { mgr, ops, model, meshA } = setup();
    const uber = mgr.refOf(meshA)!.arena;
    const imported = new Group();
    // Spare capacity = instance slots AND an already-staged geometry (a new
    // geometry would need vertex room beyond the 25 % reserve of this tiny arena).
    const parts = [part('I0', uberMat(), [0, 1, 0], meshA.geometry), part('I1', uberMat(), [0, 2, 0], meshA.geometry)];
    imported.add(...parts);
    model.add(imported);
    model.updateMatrixWorld(true);
    ops.handle(op('importCad'), 'forward');
    expect(ops.counters.reconcile).toBe(1);
    for (const p of parts) expect(mgr.refOf(p)?.arena).toBe(uber);
    expect(mgr.stats().grows).toBe(0);
  });

  it('import beyond capacity grows in place; textured import ≥ 16 forms a new arena, < 16 standalone', () => {
    const { mgr, ops, model } = setup();
    const uber = mgr.arenas[0];
    const many = Array.from({ length: uber.capacity.instances + 5 }, (_, i) => part(`M${i}`, uberMat(), [i, 3, 0]));
    const tex = texturedMat('T');
    const texParts = Array.from({ length: 16 }, (_, i) => part(`T${i}`, tex, [i, 6, 0]));
    const fewTex = texturedMat('F');
    const fewParts = Array.from({ length: 3 }, (_, i) => part(`F${i}`, fewTex, [i, 9, 0]));
    model.add(...many, ...texParts, ...fewParts);
    model.updateMatrixWorld(true);
    ops.handle(op('importCad'), 'forward');
    expect(mgr.stats().grows).toBeGreaterThan(0);
    expect(mgr.arenas[0]).toBe(uber);
    expect(mgr.refOf(texParts[0])!.arena.bucket).toEqual({ kind: 'material', material: tex });
    for (const p of fewParts) expect(mgr.isStandalone(p)).toBe(true);
  });

  it('separate / merge: tree edits followed by their ops are reconciled (new parts in, source hidden in trash)', () => {
    const { mgr, ops, model, scene, meshB, vis } = setup();
    // separate: the source goes to an invisible trash group, its parts replace it
    const trash = new Group();
    trash.visible = false;
    scene.add(trash);
    const parent = meshB.parent!;
    trash.add(meshB);
    const islands = [part('B_1', uberMat(0x00ff00)), part('B_2', uberMat(0x00ff00))];
    parent.add(...islands);
    model.updateMatrixWorld(true);
    ops.handle(op('separateMesh'), 'forward');
    mgr.beforeFrame();
    for (const p of islands) expect(vis(p)).toBe(true);
    expect(vis(meshB)).toBe(false);
    // merge (inverse direction of the same idea): islands → trash, merged mesh in
    for (const p of islands) trash.add(p);
    const merged = part('B_merged', uberMat(0x00ff00));
    parent.add(merged);
    model.updateMatrixWorld(true);
    ops.handle(op('mergeMesh'), 'forward');
    mgr.beforeFrame();
    expect(vis(merged)).toBe(true);
    for (const p of islands) expect(vis(p)).toBe(false);
    expect(ops.counters.reconcile).toBe(2);
  });

  it('in-place geometry swap is invalidated by reconcile (remove + add)', () => {
    const { mgr, ops, meshA } = setup();
    const oldRef = mgr.refOf(meshA)!;
    meshA.geometry = part('x', uberMat()).geometry;
    ops.handle(op('createNode'), 'forward');
    const ref = mgr.refOf(meshA)!;
    expect(ref).not.toBe(oldRef);
    expect(ref.arena.geometryIds.has(`${meshA.geometry.uuid}|0`)).toBe(true);
  });

  it('replay: suspended listener ignores ops, resume runs exactly one build', () => {
    const { mgr, ops } = setup();
    const build = vi.spyOn(mgr, 'build');
    ops.suspend();
    ops.suspend(); // nests (recompose inside replay)
    ops.handle(op('importCad'), 'forward');
    ops.handle(op('setNodeVisible'), 'forward');
    ops.resume();
    expect(build).not.toHaveBeenCalled();
    ops.resume();
    expect(build).toHaveBeenCalledTimes(1);
    expect(ops.counters.suspendedOps).toBe(2);
  });

  it('unknown op → one debounced rebuild', async () => {
    const { mgr, ops } = setup();
    const rebuild = vi.spyOn(mgr, 'rebuild');
    ops.handle(op('mystery'), 'forward');
    ops.handle(op('mystery2'), 'forward');
    expect(ops.rebuildPending).toBe(true);
    expect(rebuild).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 30));
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(ops.counters.rebuilds).toBe(1);
  });

  it('detach: no listener after dispose', async () => {
    const { doc, ops } = setup();
    ops.dispose();
    doc.setNodeVisible('Asset/A', false);
    await doc.whenIdle();
    expect(ops.counters.visibility).toBe(0);
  });
});
