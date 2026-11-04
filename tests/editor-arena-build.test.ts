// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.5 — EditorArenaManager.build() on the canonical fixture
 * (uber + 2 textured materials ≥ 16 + 1 below threshold + transparent + keep +
 * shared geometry + mirrored mesh), rendered with a real WebGL2 renderer.
 *
 * Note: plan §9.5 still says "Quellen visible=false" — superseded by review A1:
 * sources stay `visible = true` with `layers.mask = 0`.
 */
import { describe, it, expect } from 'vitest';
import {
  AmbientLight, BatchedMesh, BoxGeometry, Color, PerspectiveCamera, UnsignedByteType, WebGLRenderer, WebGLRenderTarget,
  type BufferAttribute, type BufferGeometry, type Material, type Mesh,
} from 'three';
import { EditorArenaManager, hasDetachedBuffers } from '../src/core/editor/rv-editor-arena';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { arenaMeshesIn, buildArenaFixture, KEEP_KEY, part, uberMat } from './helpers/editor-arena-fixture';

// Production role lookup (bakeRoleOf) with a registered keep capability.
registerComponentSchema(KEEP_KEY, {}, { bake: 'keep' });

function snapshotSources(meshes: Mesh[]) {
  return meshes.map((m) => {
    const g = m.geometry as BufferGeometry;
    const attrs = Object.keys(g.attributes).sort().map((k) => {
      const a = g.getAttribute(k) as { array: ArrayLike<number>; count: number; version: number };
      return { k, ref: a.array, count: a.count, version: a.version, first: a.array[0] };
    });
    const mat = m.material as Material;
    return {
      geometry: g, uuid: g.uuid, index: g.index?.array, attrs,
      material: mat, matVersion: mat.version, visible: m.visible,
      userData: JSON.stringify(m.userData),
    };
  });
}

function renderOnce(scene: import('three').Scene): number {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const renderer = new WebGLRenderer({ canvas });
  const camera = new PerspectiveCamera(60, 1, 0.1, 500);
  camera.position.set(8, 6, 40);
  camera.lookAt(8, 5, 0);
  camera.updateMatrixWorld();
  const target = new WebGLRenderTarget(64, 64, { type: UnsignedByteType });
  renderer.setRenderTarget(target);
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderer.render(scene, camera);
  const calls = renderer.info.render.calls;
  renderer.setRenderTarget(null);
  target.dispose();
  renderer.dispose();
  return calls;
}

describe('editor arena build (§9.5)', () => {
  it('3 arenas, correct standalone set, sources masked (visible stays true), arenas outside the root', () => {
    const f = buildArenaFixture();
    const mgr = new EditorArenaManager({ scene: f.scene });
    mgr.build(f.root);

    expect(mgr.arenas.length).toBe(3);
    expect(mgr.arenas.map((a) => a.bucket.kind)).toEqual(['uber', 'material', 'material']);
    expect(new Set(mgr.standalone)).toEqual(new Set([...f.texC, f.transparent, f.keepMesh]));

    for (const m of [...f.uber, ...f.texA, ...f.texB]) {
      expect(mgr.refOf(m)).toBeDefined();
      expect(m.visible).toBe(true);
      expect(m.layers.mask).toBe(0);
    }
    for (const m of mgr.standalone) expect(m.layers.mask).toBe(1);

    const arenas = arenaMeshesIn(f.scene);
    expect(arenas.length).toBe(3);
    for (const a of arenas) {
      expect(a.parent).toBe(f.scene);
      let inRoot = false;
      f.root.traverse((o) => { if (o === a) inRoot = true; });
      expect(inRoot).toBe(false);
      const bm = a as unknown as {
        frustumCulled: boolean; perObjectFrustumCulled: boolean; sortObjects: boolean;
        castShadow: boolean; receiveShadow: boolean; userData: Record<string, unknown>;
        raycast: (...args: unknown[]) => void;
      };
      expect(bm.frustumCulled).toBe(false);
      expect(bm.perObjectFrustumCulled).toBe(false);
      expect(bm.sortObjects).toBe(false);
      expect(bm.castShadow && bm.receiveShadow).toBe(true);
      expect(bm.userData._rvBatchedRender).toBe(true);
      const hits: unknown[] = [];
      bm.raycast({}, hits);
      expect(hits.length).toBe(0);
    }

    // dedup: the uber arena holds 6 geometries for 7 instances
    const uber = mgr.arenas[0];
    expect(uber.geometryIds.size).toBe(6);
    expect(uber.used.instances).toBe(7);
    expect(uber.capacity.instances).toBe(Math.ceil(7 * 1.25) + 64);
    expect(uber.rmTexture).toBeDefined();
    mgr.dispose();
  });

  it('one rendered frame = arenas + visible standalone draw calls (= stats estimate)', () => {
    const f = buildArenaFixture();
    f.scene.add(new AmbientLight(0xffffff, 1));
    f.scene.background = new Color(0);
    const before = renderOnce(f.scene);
    expect(before).toBe(f.all.length); // one call per mesh without arenas

    const mgr = new EditorArenaManager({ scene: f.scene });
    mgr.build(f.root);
    mgr.beforeFrame();
    const calls = renderOnce(f.scene);
    expect(mgr.stats().drawCallsEstimate).toBe(3 + 5);
    expect(calls).toBe(mgr.stats().drawCallsEstimate);
    mgr.dispose();
    expect(renderOnce(f.scene)).toBe(before);
  });

  it('source geometry, materials and userData are untouched by build + dispose', () => {
    const f = buildArenaFixture();
    const snap = snapshotSources(f.all);
    const mgr = new EditorArenaManager({ scene: f.scene });
    mgr.build(f.root);
    mgr.beforeFrame();
    mgr.dispose();
    const after = snapshotSources(f.all);
    expect(after.length).toBe(snap.length);
    for (let i = 0; i < snap.length; i++) {
      const a = after[i];
      const b = snap[i];
      expect(a.geometry).toBe(b.geometry);
      expect(a.uuid).toBe(b.uuid);
      expect(a.index).toBe(b.index);
      expect(a.material).toBe(b.material);
      expect(a.matVersion).toBe(b.matVersion);
      expect(a.visible).toBe(b.visible);
      expect(a.userData).toBe(b.userData);
      expect(a.attrs).toEqual(b.attrs);
    }
    for (const m of f.all) expect(m.layers.mask).toBe(1);
  });

  it('empty document → no arena; build() twice → still exactly one set of arenas', () => {
    const f = buildArenaFixture();
    const mgr = new EditorArenaManager({ scene: f.scene });
    const empty = new (f.root.constructor as new () => typeof f.root)();
    f.scene.add(empty);
    mgr.build(empty);
    expect(mgr.arenas.length).toBe(0);
    mgr.build(f.root);
    mgr.build(f.root);
    expect(arenaMeshesIn(f.scene).length).toBe(3);
    mgr.dispose();
  });

  it('add() beyond capacity grows the arena in place (no rebuild), instances keep their slots', () => {
    const f = buildArenaFixture();
    const mgr = new EditorArenaManager({ scene: f.scene });
    mgr.build(f.root);
    const uber = mgr.arenas[0];
    const cap = uber.capacity.instances;
    const fresh = Array.from({ length: cap }, (_, i) => part(`N${i}`, uberMat(0x112233), [i, -3, 0]));
    f.root.add(...fresh);
    f.root.updateMatrixWorld(true);
    const firstRef = mgr.refOf(f.uber[0])!;
    mgr.add(fresh);
    expect(mgr.arenas[0]).toBe(uber);
    expect(uber.capacity.instances).toBeGreaterThan(cap);
    expect(uber.used.instances).toBe(7 + cap);
    expect(mgr.stats().grows).toBeGreaterThan(0);
    expect(mgr.refOf(f.uber[0])).toBe(firstRef);
    mgr.dispose();
  });
  it('a mesh whose buffers a worker BVH build holds (detached) is deferred, drawn on its own, and joins once they are back', () => {
    const f = buildArenaFixture();
    // Exactly what GenerateMeshBVHWorker does: TRANSFER the position buffer
    // (detaching it) and later hand back a fresh array.
    const geo = new BoxGeometry(1, 1, 1);
    const late = part('Late', uberMat(0x445566), [20, 0, 0], geo);
    f.root.add(late);
    f.root.updateMatrixWorld(true);
    const pos = geo.getAttribute('position') as BufferAttribute;
    const kept = (pos.array as Float32Array).slice();
    structuredClone(pos.array.buffer, { transfer: [pos.array.buffer as ArrayBuffer] });
    expect(hasDetachedBuffers(geo)).toBe(true);

    const mgr = new EditorArenaManager({ scene: f.scene });
    expect(() => mgr.build(f.root)).not.toThrow();
    expect(mgr.refOf(late)).toBeUndefined();
    expect(late.layers.mask).toBe(1); // untouched: keeps drawing on its own
    expect(mgr.stats().deferred).toBe(1);
    expect(mgr.refOf(f.uber[0])).toBeDefined(); // the rest is batched

    // Still detached: retries change nothing.
    for (let i = 0; i < 40; i++) mgr.beforeFrame();
    expect(mgr.stats().deferred).toBe(1);

    (pos as unknown as { array: Float32Array }).array = kept; // the worker's restore
    for (let i = 0; i < 16; i++) mgr.beforeFrame();
    expect(mgr.stats().deferred).toBe(0);
    expect(mgr.refOf(late)?.arena.bucket.kind).toBe('uber');
    expect(late.layers.mask).toBe(0);
    mgr.dispose();
    expect(late.layers.mask).toBe(1);
  });

  it('a build that throws half-way leaves nothing behind (sources unmasked, no arena, not built)', () => {
    const f = buildArenaFixture();
    const mgr = new EditorArenaManager({ scene: f.scene });
    const orig = BatchedMesh.prototype.addGeometry;
    let n = 0;
    BatchedMesh.prototype.addGeometry = function (this: BatchedMesh, ...args: Parameters<BatchedMesh['addGeometry']>) {
      if (++n === 4) throw new Error('boom');
      return orig.apply(this, args);
    };
    try {
      expect(() => mgr.build(f.root)).toThrow('boom');
    } finally {
      BatchedMesh.prototype.addGeometry = orig;
    }
    expect(mgr.isBuilt).toBe(false);
    expect(arenaMeshesIn(f.scene).length).toBe(0);
    for (const m of f.all) expect(m.layers.mask).toBe(1);
    mgr.build(f.root);
    expect(mgr.arenas.length).toBe(3);
    mgr.dispose();
  });
});
