// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, InstancedMesh, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { documentBase } from '../src/core/editor/active-asset-store';
import { createInlineMeshSimplifyPort, RVMeshSimplifyClient } from '../src/core/editor/rv-mesh-simplify-client';
import { verifyGeometry } from '../src/core/editor/rv-mesh-simplify';
import { makeSpikeViewer } from './helpers/spike-610-ref-fixture';
import type { AssetSimplifyClient } from '../src/core/editor/rv-asset-simplify';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const state = vi.hoisted(() => ({ project: { id: 'synthetic' } as { id: string } | null, tierNone: false }));
vi.mock('../src/core/project/project-store', () => ({ getProjectStore: () => ({ getProject: () => state.project }) }));
vi.mock('../src/core/import/rv-cad-glb-cache', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/import/rv-cad-glb-cache')>();
  return { ...actual, putCadGlb: (...args: Parameters<typeof actual.putCadGlb>) =>
    state.tierNone ? Promise.resolve('none' as const) : actual.putCadGlb(...args) };
});
const docs: AssetDocument[] = [];
beforeEach(() => { state.project = { id: 'synthetic' }; state.tierNone = false; });
afterEach(() => { for (const doc of docs.splice(0)) doc.dispose(); });

function fixture(client?: AssetSimplifyClient) {
  const f = makeSpikeViewer();
  const geometry = new SphereGeometry(.01, 40, 24);
  const a: Mesh = new Mesh(geometry, new MeshStandardMaterial()); a.name = 'A';
  const b: Mesh = new Mesh(geometry, a.material); b.name = 'B'; b.position.x = 1;
  f.model.add(a, b); f.register();
  const pool = client ?? new RVMeshSimplifyClient({ poolSize: 1, createPort: createInlineMeshSimplifyPort });
  const call = vi.spyOn(pool, 'simplify');
  const doc = new AssetDocument(f.viewer, { id: crypto.randomUUID(), name: 'Synthetic',
    base: documentBase('synthetic', 'Synthetic', 'scratch/synthetic.glb'), simplifyClient: pool });
  docs.push(doc);
  return { ...f, a, b, geometry, doc, call, path: f.registry.getPathForNode(a)!, other: f.registry.getPathForNode(b)! };
}
const input = (g: Mesh['geometry'], stretch = 1) => ({ positions: Float32Array.from(g.attributes.position.array),
  normals: Float32Array.from(g.attributes.normal.array), index: Uint32Array.from(g.index!.array), worldStretchMax: stretch });

describe('AssetDocument mesh simplification (synthetic)', () => {
  it('uses one undo step and interns all users through undo, redo and replay', async () => {
    const f = fixture();
    const result = await f.doc.simplifyNodes([f.path], {});
    expect(result.simplified).toHaveLength(1);
    expect(result.coUsers).toEqual([f.other]);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.doc.getSnapshot().opCount).toBe(1);
    const simplified = f.a.geometry;
    expect(simplified).not.toBe(f.geometry);
    expect(f.doc.executor.geometryKeyOf(simplified)?.quality).toBe('source|simplify:v1:e=0.5:r=0:nw=1:lb=1');
    expect(f.b.geometry).toBe(simplified);
    await f.doc.undo();
    expect(f.a.geometry).toBe(f.geometry); expect(f.b.geometry).toBe(f.geometry);
    await f.doc.redo();
    expect(f.a.geometry).toBe(simplified); expect(f.b.geometry).toBe(simplified);
    const replay = fixture();
    await replay.doc.replayOps(f.doc.toDraft().ops);
    expect(replay.a.geometry).toBe(replay.b.geometry);
    expect(Array.from(replay.a.geometry.index!.array)).toEqual(Array.from(simplified.index!.array));
    expect(Array.from(replay.a.geometry.attributes.position.array)).toEqual(Array.from(simplified.attributes.position.array));
  });

  it('uses the maximum stretch of unselected users and verifies world deviation', async () => {
    const f = fixture(); f.model.scale.setScalar(10); f.b.scale.set(2, 1, 1);
    const preview = await f.doc.previewSimplify([f.path], {});
    expect(preview.geometries[0].worldStretchMax).toBeCloseTo(20);
    await f.doc.simplifyNodes([f.path], {}, { preview });
    expect(f.call).toHaveBeenCalledTimes(1);
    for (const user of [f.a, f.b]) {
      const originalWorld = f.geometry.clone().applyMatrix4(user.matrixWorld);
      const simplifiedWorld = user.geometry.clone().applyMatrix4(user.matrixWorld);
      expect(verifyGeometry(input(originalWorld), input(simplifiedWorld), .5)).toBeNull();
      originalWorld.dispose(); simplifiedWorld.dispose();
    }
  });

  it.each(['multi-material', 'vertex-color', 'tangent', 'instanced'])('skips %s without replacing geometry', async reason => {
    const f = fixture();
    if (reason === 'multi-material') f.a.material = [new MeshStandardMaterial()];
    if (reason === 'vertex-color' || reason === 'tangent') {
      const size = reason === 'tangent' ? 4 : 3;
      f.geometry.setAttribute(reason === 'tangent' ? 'tangent' : 'color', new BufferAttribute(new Float32Array(f.geometry.attributes.position.count * size), size));
    }
    let path = f.path;
    if (reason === 'instanced') {
      const mesh = new InstancedMesh(f.geometry, new MeshStandardMaterial(), 1); mesh.name = 'Instances';
      f.model.add(mesh); f.register(); path = f.registry.getPathForNode(mesh)!;
    }
    const result = await f.doc.simplifyNodes([path], {});
    expect(result.skipped).toContainEqual({ path, reason });
    expect(f.a.geometry).toBe(f.geometry); expect(f.doc.getSnapshot().opCount).toBe(0);
  });

  it('discards a preview after a transform change and after undo', async () => {
    const f = fixture();
    const preview = await f.doc.previewSimplify([f.path], {});
    f.b.scale.setScalar(2);
    await f.doc.simplifyNodes([f.path], {}, { preview });
    expect(f.call).toHaveBeenCalledTimes(2);
    await f.doc.undo();
    const sameSource = await f.doc.previewSimplify([f.path], {});
    await f.doc.simplifyNodes([f.path], {}, { preview: sameSource });
    expect(f.call).toHaveBeenCalledTimes(3);
    await f.doc.undo();
    // UUID and world matrices now match again; only the history revision differs.
    await f.doc.simplifyNodes([f.path], {}, { preview: sameSource });
    expect(f.call).toHaveBeenCalledTimes(4);
  });

  it('rejects a missing project before any worker call', async () => {
    const f = fixture(); state.project = null;
    await expect(f.doc.simplifyNodes([f.path], {})).rejects.toThrow('Mesh simplification needs a project');
    expect(f.call).not.toHaveBeenCalled();
  });

  it('rejects tier none before any worker call', async () => {
    const f = fixture(); state.tierNone = true;
    await expect(f.doc.simplifyNodes([f.path], {})).rejects.toThrow('Mesh simplification needs a project');
    expect(f.call).not.toHaveBeenCalled();
  });

  it('respects document locks before starting workers', async () => {
    const f = fixture();
    const token = f.doc.tryLock('test-run');
    try {
      await expect(f.doc.simplifyNodes([f.path], {})).rejects.toThrow();
      expect(f.call).not.toHaveBeenCalled();
    } finally { f.doc.unlock(token); }
  });

  it('includes unselected geometry as a contact partner without replacing it', async () => {
    const f = fixture();
    const partner = new Mesh(new SphereGeometry(.01, 32, 20), new MeshStandardMaterial());
    partner.name = 'Partner'; partner.position.z = 1;
    f.model.add(partner); f.register();
    const original = partner.geometry;
    await f.doc.simplifyNodes([f.path], {});
    expect(partner.geometry).toBe(original);
    expect(f.call.mock.calls[0][0].geometries).toHaveLength(2);
    expect(f.call.mock.calls[0][0].targetGeometryIds).toEqual([f.geometry.uuid]);
    await f.doc.undo();
    await f.doc.simplifyNodes([f.path, f.registry.getPathForNode(partner)!], {});
    expect(f.doc.getSnapshot().opCount).toBe(1);
    expect(f.doc.getSnapshot().undoLabel).toBe('Simplify');
    await f.doc.undo();
    expect(f.a.geometry).toBe(f.geometry); expect(partner.geometry).toBe(original);
  });

  it('replays a following separation with the same geometry and child order', async () => {
    const build = () => {
      const f = fixture();
      f.a.geometry = f.b.geometry = mergeGeometries([
        new SphereGeometry(.01, 32, 20), new SphereGeometry(.01, 32, 20).translate(.04, 0, 0),
      ]);
      return f;
    };
    const f = build();
    await f.doc.simplifyNodes([f.path], {});
    expect(await f.doc.separateMesh(f.path, 'islands')).toHaveLength(2);
    const replay = build();
    await replay.doc.replayOps(f.doc.toDraft().ops);
    const signature = (mesh: Mesh) => mesh.children.map(n => ({ name: n.name,
      positions: Array.from((n as Mesh).geometry.attributes.position.array),
      index: Array.from((n as Mesh).geometry.index!.array) }));
    expect(signature(replay.a)).toEqual(signature(f.a));
  });

  it('cancels an in-flight request without changing the document', async () => {
    const f = fixture();
    const promise = f.doc.simplifyNodes([f.path], {}, { onProgress: () => f.doc.cancelSimplify() });
    await expect(promise).rejects.toMatchObject({ name: 'MeshSimplifyAbortError' });
    expect(f.a.geometry).toBe(f.geometry); expect(f.b.geometry).toBe(f.geometry);
    expect(f.doc.getSnapshot().opCount).toBe(0);
  });
});
