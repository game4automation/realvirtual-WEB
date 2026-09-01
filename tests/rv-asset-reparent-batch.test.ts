// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `AssetDocument.reparentNodesBatch` — the bulk move behind the PLMXML kinematics
 * import (plan-359 §9.4).
 *
 * What these tests pin is not "the nodes end up in the right place" (the
 * per-node reparent path already covers that in rv-asset-create-reparent.test.ts)
 * but the properties that make the bulk path CHEAP and REVERSIBLE:
 * one top-level op, one undo step, one structure event, one BVH rebuild,
 * unchanged world poses, and name collisions resolved before anything moves.
 */
import { describe, it, expect, vi } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D, Euler, Matrix4 } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';

function makeMockViewer(opts?: { instancePick?: boolean }) {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  const registry = new NodeRegistry();
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  };

  const events: string[] = [];
  const rebuildGroupedBvh = vi.fn();
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit(name: string) { events.push(name); },
    on() { return () => {}; },
    rebuildGroupedBvh,
    refitRaycastSubtrees() {},
    // Truthy = editor instance-pick backend installed (no merged groups exist,
    // so no rebuild may be requested — doc-render-picking.md §2.5).
    instancePickIndex: opts?.instancePick
      ? { addSubtree() {}, removeSubtree() {}, bumpResolutionEpoch() {} }
      : undefined,
    buildMeshBvhsAsync() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;

  return { viewer, scene, model, registry, register, events, rebuildGroupedBvh };
}

/** `count` parts spread over two assemblies, every part carrying a mesh-less body. */
function buildAssembly(model: Object3D, count: number): Object3D[] {
  const parts: Object3D[] = [];
  for (let a = 0; a < 2; a++) {
    const asm = new Group();
    asm.name = `Asm_${a}`;
    asm.position.set(a * 10, 0, 0);
    asm.quaternion.setFromEuler(new Euler(0, a * 0.3, 0));
    model.add(asm);
    for (let p = 0; parts.length < count && p < Math.ceil(count / 2); p++) {
      const part = new Group();
      // Repeated across assemblies on purpose: bulk CAD moves collide on names.
      part.name = `Part_${p}`;
      part.position.set(p, p * 0.5, 1);
      asm.add(part);
      parts.push(part);
    }
  }
  return parts;
}

describe('reparentNodesBatch — one op, one undo step', () => {
  it('records ONE op for 100 moves and reverts all of them in a single undo', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const parts = buildAssembly(model, 100);
    const target = new Group();
    target.name = 'Link';
    model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    const paths = parts.map((p) => NodeRegistry.computeNodePath(p));
    const moved = await doc.reparentNodesBatch(paths, 'Asset/Link');

    expect(moved).toHaveLength(100);
    expect(target.children).toHaveLength(100);
    expect(doc.getSnapshot().opCount).toBe(1);

    await doc.undo();
    expect(target.children).toHaveLength(0);
    expect(parts.every((p) => p.parent?.name.startsWith('Asm_'))).toBe(true);
    expect(doc.getSnapshot().opCount).toBe(0);
    expect(registry.getNode('Asset/Asm_0/Part_0')).toBe(parts[0]);
    doc.dispose();
  });

  it('restores the original SIBLING ORDER, not just the parents', async () => {
    const { viewer, model, register } = makeMockViewer();
    const asm = new Group(); asm.name = 'Asm'; model.add(asm);
    const names = ['P0', 'P1', 'P2', 'P3', 'P4'];
    for (const n of names) { const g = new Group(); g.name = n; asm.add(g); }
    const target = new Group(); target.name = 'Link'; model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    // Move three of five out of one parent — the case where a naive up-front
    // `prevIndex` snapshot puts them back in the wrong order.
    await doc.reparentNodesBatch(['Asset/Asm/P0', 'Asset/Asm/P2', 'Asset/Asm/P4'], 'Asset/Link');
    expect(asm.children.map((c) => c.name)).toEqual(['P1', 'P3']);

    await doc.undo();
    expect(asm.children.map((c) => c.name)).toEqual(names);
    doc.dispose();
  });

  it('preserves every moved node\'s world pose, and redo reproduces it exactly', async () => {
    const { viewer, model, register } = makeMockViewer();
    const parts = buildAssembly(model, 40);
    const target = new Group();
    target.name = 'Link';
    target.position.set(-3, 7, 2);
    target.quaternion.setFromEuler(new Euler(0.4, -0.2, 1.1));
    target.scale.set(2, 2, 2);
    model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    const before = parts.map((p) => p.matrixWorld.clone());
    const paths = parts.map((p) => NodeRegistry.computeNodePath(p));
    await doc.reparentNodesBatch(paths, 'Asset/Link');

    // The batch defers the world-matrix flush to the end of the composite; if it
    // ever skipped it, THIS is what would go stale (and picking with it).
    const worldMax = (i: number) => maxMatrixDelta(parts[i].matrixWorld, before[i]);
    for (let i = 0; i < parts.length; i++) expect(worldMax(i)).toBeLessThan(1e-6);

    await doc.undo();
    model.updateMatrixWorld(true);
    for (let i = 0; i < parts.length; i++) expect(worldMax(i)).toBeLessThan(1e-6);

    await doc.redo();
    model.updateMatrixWorld(true);
    for (let i = 0; i < parts.length; i++) expect(worldMax(i)).toBeLessThan(1e-6);
    doc.dispose();
  });

  it('dedupes colliding sibling names up front and undo restores the original names', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    // Two assemblies × Part_0..Part_2 → three name collisions under one target.
    const parts = buildAssembly(model, 6);
    const target = new Group();
    target.name = 'Link';
    model.add(target);
    // A name the target ALREADY owns: the batch must skip over it, not steal it.
    const squatter = new Group();
    squatter.name = 'Part_0';
    target.add(squatter);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    const paths = parts.map((p) => NodeRegistry.computeNodePath(p));
    const moved = await doc.reparentNodesBatch(paths, 'Asset/Link');

    const names = target.children.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length); // every sibling addressable
    expect(names).toContain('Part_0');    // the squatter kept its name
    expect(names).toContain('Part_0_1');
    expect(names).toContain('Part_0_2');
    expect(squatter.name).toBe('Part_0');
    // Every returned path resolves to the node that actually moved there.
    for (const p of moved) expect(registry.getNode(p)?.parent).toBe(target);

    await doc.undo();
    expect(parts.map((p) => p.name)).toEqual(
      ['Part_0', 'Part_1', 'Part_2', 'Part_0', 'Part_1', 'Part_2'],
    );
    doc.dispose();
  });

  it('drops descendants of other members instead of stranding their paths', async () => {
    const { viewer, model, register } = makeMockViewer();
    const outer = new Group(); outer.name = 'Outer'; model.add(outer);
    const inner = new Group(); inner.name = 'Inner'; outer.add(inner);
    const target = new Group(); target.name = 'Link'; model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    // Inner is listed FIRST — input order must not decide who survives.
    const moved = await doc.reparentNodesBatch(
      ['Asset/Outer/Inner', 'Asset/Outer'], 'Asset/Link',
    );
    expect(moved).toEqual(['Asset/Link/Outer']);
    expect(outer.parent).toBe(target);
    expect(inner.parent).toBe(outer);
    doc.dispose();
  });

  it('skips cycles, the asset root and same-parent moves without an index', async () => {
    const { viewer, model, register } = makeMockViewer();
    const a = new Group(); a.name = 'A'; model.add(a);
    const innerA = new Group(); innerA.name = 'Inner'; a.add(innerA);
    register();
    const doc = scratchAssetDocument(viewer);

    expect(await doc.reparentNodesBatch(['Asset/A'], 'Asset/A/Inner')).toEqual([]);
    expect(await doc.reparentNodesBatch(['Asset/A/Inner'], 'Asset/A')).toEqual([]);
    expect(await doc.reparentNodesBatch(['Asset'], 'Asset/A')).toEqual([]);
    expect(doc.getSnapshot().opCount).toBe(0);
    doc.dispose();
  });
});

describe('reparentNodesBatch — cost per top-level op', () => {
  it('emits ONE structure event and ONE BVH rebuild for 100 moves (legacy backend)', async () => {
    const { viewer, model, register, events, rebuildGroupedBvh } = makeMockViewer();
    const parts = buildAssembly(model, 100);
    const target = new Group(); target.name = 'Link'; model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    events.length = 0;
    await doc.reparentNodesBatch(parts.map((p) => NodeRegistry.computeNodePath(p)), 'Asset/Link');

    expect(events.filter((e) => e === 'editor-structure-changed')).toHaveLength(1);
    // Measured against the SPY, not the classification helper — the helper only
    // returns a boolean, so it cannot show how often a rebuild was requested
    // (plan-359 §9.4, SOL-Runde 2 Finding 5).
    expect(rebuildGroupedBvh).toHaveBeenCalledTimes(1);
    doc.dispose();
  });

  it('requests ZERO BVH rebuilds with the instance-pick backend installed', async () => {
    const { viewer, model, register, events, rebuildGroupedBvh } =
      makeMockViewer({ instancePick: true });
    const parts = buildAssembly(model, 50);
    const target = new Group(); target.name = 'Link'; model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    events.length = 0;
    await doc.reparentNodesBatch(parts.map((p) => NodeRegistry.computeNodePath(p)), 'Asset/Link');

    expect(rebuildGroupedBvh).not.toHaveBeenCalled();
    expect(events.filter((e) => e === 'editor-structure-changed')).toHaveLength(1);
    doc.dispose();
  });

  it('the per-node path still costs one event per node — the contrast this replaces', async () => {
    const { viewer, model, register, events } = makeMockViewer({ instancePick: true });
    const parts = buildAssembly(model, 20);
    const target = new Group(); target.name = 'Link'; model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    events.length = 0;
    await doc.reparentNodes(parts.map((p) => NodeRegistry.computeNodePath(p)), 'Asset/Link');
    // 20 reparents + the pre-renames for the repeated Part_N names.
    expect(events.filter((e) => e === 'editor-structure-changed').length)
      .toBeGreaterThanOrEqual(20);
    doc.dispose();
  });
});

describe('reparentNodesBatch — draft replay', () => {
  it('replays from a recorded draft onto a freshly built scene', async () => {
    const first = makeMockViewer();
    const parts = buildAssembly(first.model, 30);
    const target = new Group(); target.name = 'Link'; first.model.add(target);
    first.register();
    first.model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(first.viewer);
    await doc.reparentNodesBatch(
      parts.map((p) => NodeRegistry.computeNodePath(p)), 'Asset/Link',
    );
    const ops = doc.toDraft().ops;
    doc.dispose();

    // Same scene shape, untouched — the draft must reproduce the result.
    const second = makeMockViewer();
    buildAssembly(second.model, 30);
    const target2 = new Group(); target2.name = 'Link'; second.model.add(target2);
    second.register();
    second.model.updateMatrixWorld(true);
    const replayed = scratchAssetDocument(second.viewer);
    await replayed.replayOps(ops);

    expect(target2.children).toHaveLength(30);
    expect(target2.children.map((c) => c.name).sort())
      .toEqual(target.children.map((c) => c.name).sort());
    replayed.dispose();
  });
});

function maxMatrixDelta(a: Matrix4, b: Matrix4): number {
  let max = 0;
  for (let i = 0; i < 16; i++) max = Math.max(max, Math.abs(a.elements[i] - b.elements[i]));
  return max;
}
