// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';
import { Box3, Vector3, Mesh, Object3D, MeshStandardMaterial, BoxGeometry } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { disposePlacedRoot } from '../src/core/engine/rv-placement-integrate';
import { bakeTree, group } from './fixtures/bake-fixture';

function mockViewer(tankFill: object | null) {
  const renderer = { localClippingEnabled: false } as any;
  return { renderer, tankFillManager: tankFill, markRenderDirty() {} } as any;
}

/** Viewer mock with a real event bus so the plugin's `layout-content-added`
 *  subscription (Planner/DES reattach) fires. */
function eventViewer(tankFill: object | null) {
  const emitter = new EventEmitter();
  const renderer = { localClippingEnabled: false } as any;
  return {
    renderer,
    tankFillManager: tankFill,
    markRenderDirty() {},
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as any;
}

function modelRoot(): { root: Object3D; modelMat: MeshStandardMaterial; overlayMat: MeshStandardMaterial } {
  const root = new Object3D();
  const modelMat = new MeshStandardMaterial();
  const overlayMat = new MeshStandardMaterial();
  root.add(new Mesh(undefined, modelMat));
  const ov = new Mesh(undefined, overlayMat);
  ov.userData._tankFillViz = true; // overlay marker
  root.add(ov);
  return { root, modelMat, overlayMat };
}

// The plugin persists the axis state per model hash and restores it on load; a
// previous test's enabled axis would bind the planes at load time.
beforeEach(() => {
  for (const key of Object.keys(localStorage)) if (key.startsWith('rv-clipping-')) localStorage.removeItem(key);
});

const loadResult = (root: Object3D) =>
  ({ root, boundingBox: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)), drives: [] }) as any;

async function keepAsset() {
  const template = group('Asset');
  const kept = new Mesh(new BoxGeometry(1, 1, 1), [new MeshStandardMaterial(), new MeshStandardMaterial()]);
  kept.name = 'Kept';
  kept.userData.realvirtual = { BakeRole: 'keep' };
  template.add(kept);
  return bakeTree(template);
}

describe('ClippingPlugin lifecycle', () => {
  it('sets localClippingEnabled on model load', () => {
    const v = mockViewer(null);
    const p = new ClippingPlugin();
    (p as any).onModelLoaded(loadResult(modelRoot().root), v); // base hook calls onStart
    expect(v.renderer.localClippingEnabled).toBe(true);
  });

  it('binds the planes on first use, not at model load, and keeps them bound', () => {
    const v = mockViewer(null);
    const p = new ClippingPlugin();
    const m = modelRoot();
    (p as any).onModelLoaded(loadResult(m.root), v);
    // Not bound at load: an unclipped shader variant, which compileAsync can pre-build.
    expect(m.modelMat.clippingPlanes ?? null).toBeNull();
    p.setAxis('x', { enabled: true });
    const planes = m.modelMat.clippingPlanes;
    expect(planes).toHaveLength(3);
    // Disabling the axis keeps the binding (stable array → no recompile on toggle).
    p.setAxis('x', { enabled: false });
    expect(m.modelMat.clippingPlanes).toBe(planes);
  });

  it('F6: does NOT attach clippingPlanes to overlay (_tankFillViz) meshes', () => {
    const v = mockViewer(null);
    const p = new ClippingPlugin();
    const m = modelRoot();
    (p as any).onModelLoaded(loadResult(m.root), v);
    p.setAxis('x', { enabled: true });
    expect(m.modelMat.clippingPlanes).not.toBeNull(); // model clipped
    expect(m.overlayMat.clippingPlanes ?? null).toBeNull(); // overlay untouched
  });

  it('onDestroy disables clipping when no TankFillManager & clears set', () => {
    const v = mockViewer(null);
    const p = new ClippingPlugin();
    const m = modelRoot();
    (p as any).onModelLoaded(loadResult(m.root), v);
    p.setAxis('x', { enabled: true });
    (p as any).onModelCleared(); // base hook calls onDestroy
    expect(v.renderer.localClippingEnabled).toBe(false);
    expect(m.modelMat.clippingPlanes).toBeNull();
  });

  it('onDestroy keeps clipping enabled when TankFillManager active', () => {
    const v = mockViewer({});
    const p = new ClippingPlugin();
    const m = modelRoot();
    (p as any).onModelLoaded(loadResult(m.root), v);
    (p as any).onModelCleared();
    expect(v.renderer.localClippingEnabled).toBe(true); // TankFill keeps it on
  });

  it.each(['onModelCleared', 'dispose'] as const)('%s removes material dispose listeners', (cleanup) => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    const m = modelRoot();
    p.onModelLoaded(loadResult(m.root), v);
    p.setAxis('x', { enabled: true });
    const listener = (p as any)._onMaterialDispose;
    expect(m.modelMat.hasEventListener('dispose', listener)).toBe(true);

    p[cleanup]();
    expect(m.modelMat.hasEventListener('dispose', listener)).toBe(false);
    expect((p as any).clippedMaterials.size).toBe(0);

    p.onModelLoaded(loadResult(modelRoot().root), v);
    p.setAxis('y', { enabled: true });
    const baseline = (p as any).clippedMaterials.size;
    m.modelMat.dispose();
    expect((p as any).clippedMaterials.size).toBe(baseline);
    p.dispose();
  });

});

describe('ClippingPlugin Planner/DES reattach (layout-content-added)', () => {
  it('binds clipping planes to geometry placed after the initial load', () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    (p as any).onModelLoaded(loadResult(modelRoot().root), v);
    p.setAxis('x', { enabled: true }); // section tool in use → placements bind at once

    // Simulate a Planner/DES placement: a subtree added later, with a normal
    // model material and an overlay (tank-fill) material that must stay unclipped.
    const placed = new Object3D();
    const placedMat = new MeshStandardMaterial();
    const overlayMat = new MeshStandardMaterial();
    placed.add(new Mesh(new BoxGeometry(2, 2, 2), placedMat));
    const ov = new Mesh(new BoxGeometry(2, 2, 2), overlayMat);
    ov.userData._tankFillViz = true;
    placed.add(ov);

    v.emit('layout-content-added', { root: placed });

    expect(placedMat.clippingPlanes).not.toBeNull(); // placed geometry now clipped
    expect(overlayMat.clippingPlanes ?? null).toBeNull(); // overlay still exempt
    expect(v.renderer.localClippingEnabled).toBe(true);
  });

  it('binds geometry placed BEFORE the first use once an axis is enabled', () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    (p as any).onModelLoaded(loadResult(modelRoot().root), v);

    const placed = new Object3D();
    const placedMat = new MeshStandardMaterial();
    placed.add(new Mesh(new BoxGeometry(2, 2, 2), placedMat));
    v.emit('layout-content-added', { root: placed });
    expect(placedMat.clippingPlanes ?? null).toBeNull(); // not yet in use

    p.setAxis('y', { enabled: true });
    expect(placedMat.clippingPlanes).toHaveLength(3);
  });

  it('grows the bounding box when placed geometry extends beyond it', () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    (p as any).onModelLoaded(loadResult(modelRoot().root), v); // bbox = [-1,1]^3

    const placed = new Object3D();
    const mesh = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
    mesh.position.set(10, 0, 0); // extends bbox.max.x to ~11
    placed.add(mesh);

    v.emit('layout-content-added', { root: placed });

    expect((p as any).bbox.max.x).toBeGreaterThan(1);
  });

  it('creates a bounding box for an initially empty (bbox-less) scene', () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    // Empty Planner scene: load result carries an empty bounding box → bbox null.
    (p as any).onModelLoaded(
      { root: new Object3D(), boundingBox: new Box3(), drives: [] } as any,
      v,
    );
    expect((p as any).bbox).toBeNull();

    const placed = new Object3D();
    placed.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial()));
    v.emit('layout-content-added', { root: placed });

    expect((p as any).bbox).not.toBeNull();
  });
  it('forgets a placement removed before the first use (no retained subtrees across DES runs)', () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    (p as any).onModelLoaded(loadResult(modelRoot().root), v);
    const pendingRoots = () => (p as any)._pendingRoots.length;
    const pendingChunks = () => (p as any)._pendingChunks.size;
    const base = pendingRoots(); // the model root itself

    // 50 "runs": each re-instantiates a placement (with chunks) and disposes the previous one.
    let prev: Object3D | null = null;
    let lastMat: MeshStandardMaterial | null = null;
    for (let run = 0; run < 50; run++) {
      if (prev) v.emit('layout-content-removed', { root: prev, path: null });
      const placed = new Object3D();
      lastMat = new MeshStandardMaterial();
      const chunk = new Mesh(new BoxGeometry(1, 1, 1), lastMat);
      // Payload-only chunk: first use must bind it through the pending Map.
      expect(placed.children).not.toContain(chunk);
      v.emit('layout-content-added', { root: placed, chunks: [chunk] });
      prev = placed;
    }
    expect(pendingRoots()).toBe(base + 1);
    expect(pendingChunks()).toBe(1);

    // The surviving placement still binds on first use.
    p.setAxis('x', { enabled: true });
    expect(lastMat!.clippingPlanes).toHaveLength(3);
    expect(pendingRoots()).toBe(0);
    expect(pendingChunks()).toBe(0);
  });

  it('releases disposed Keep-clone materials while Section is active without changing shared planes', async () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    const model = modelRoot();
    const registry = new BakeRegistry();
    v.bakeRegistry = registry;
    const baked = await keepAsset();
    p.onModelLoaded(loadResult(model.root), v);
    p.setAxis('x', { enabled: true });
    const baseline = (p as any).clippedMaterials.size;
    const sharedPlanes = model.modelMat.clippingPlanes;
    try {
      for (let run = 0; run < 50; run++) {
        const root = new Object3D();
        const inst = registry.instantiate(baked, root);
        expect(inst.keep).toHaveLength(1);
        const materials = inst.keep[0].material as MeshStandardMaterial[];
        expect(materials[0]).not.toBe((baked.keep[0].mesh.material as MeshStandardMaterial[])[0]);
        // A live model and every placement also use this same material.
        root.add(new Mesh(undefined, model.modelMat));
        v.emit('layout-content-added', { root, keep: inst.keep });
        expect((p as any).clippedMaterials.size).toBe(baseline + materials.length);
        for (const mat of materials) expect(mat.clippingPlanes).toBe(sharedPlanes);

        disposePlacedRoot(v, root);
        expect(inst.released).toBe(true);
        expect((p as any).clippedMaterials.size).toBe(baseline);
        expect(model.modelMat.clippingPlanes).toBe(sharedPlanes);
        for (const mat of materials) {
          expect(mat.hasEventListener('dispose', (p as any)._onMaterialDispose)).toBe(false);
        }
      }
    } finally {
      p.dispose();
      registry.releaseAll();
      baked.dispose();
    }
  });

  it('removes each announced nested instance root exactly once through disposePlacedRoot', async () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    const registry = new BakeRegistry();
    v.bakeRegistry = registry;
    const template = group('Asset');
    template.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    const baked = await bakeTree(template);
    p.onModelLoaded(loadResult(modelRoot().root), v);
    const baseline = [...(p as any)._pendingRoots];
    const added: Object3D[] = [];
    const removed: Object3D[] = [];
    const offAdded = v.on('layout-content-added', ({ root }: { root: Object3D }) => added.push(root));
    const offRemoved = v.on('layout-content-removed', ({ root }: { root: Object3D }) => removed.push(root));
    try {
      const outer = new Object3D();
      let parent = outer;
      for (let depth = 0; depth < 3; depth++) {
        const root = depth === 0 ? outer : new Object3D();
        if (depth > 0) parent.add(root);
        const inst = registry.instantiate(baked, root);
        expect(inst.chunks).toHaveLength(1);
        v.emit('layout-content-added', { root, chunks: inst.chunks });
        parent = root;
      }
      expect((p as any)._pendingRoots).toHaveLength(baseline.length + added.length);
      expect((p as any)._pendingChunks.size).toBe(added.length);
      disposePlacedRoot(v, outer);

      expect(removed).toHaveLength(added.length);
      for (let i = 0; i < added.length; i++) {
        expect(removed.filter((root) => root === added[i])).toHaveLength(1);
        expect(removed[removed.length - 1 - i]).toBe(added[i]);
      }
      expect((p as any)._pendingRoots).toEqual(baseline);
      expect((p as any)._pendingChunks.size).toBe(0);
      expect(registry.instanceRootsUnder(outer)).toHaveLength(0);
    } finally {
      offAdded();
      offRemoved();
      p.dispose();
      registry.releaseAll();
      baked.dispose();
    }
  });

  it('cleans old event listeners on model clear and reload on the same emitter', () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    const oldResult = loadResult(modelRoot().root);
    p.onModelLoaded(oldResult, v);
    const placed = new Object3D();
    const chunk = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    v.emit('layout-content-added', { root: placed, chunks: [chunk] });
    p.onModelCleared();

    const attach = vi.spyOn(p as any, '_attachSubtree');
    const forget = vi.spyOn(p as any, '_forgetPending');
    v.emit('layout-content-added', { root: placed, chunks: [chunk] });
    v.emit('layout-content-removed', { root: placed });
    v.emit('render-mode-changed', {});
    v.emit('model-loaded', { result: oldResult });
    expect(attach).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    expect((p as any)._pendingRoots).toHaveLength(0);
    expect((p as any)._pendingChunks.size).toBe(0);

    const current = loadResult(modelRoot().root);
    p.onModelLoaded(current, v);
    v.emit('render-mode-changed', {});
    v.emit('model-loaded', { result: oldResult });
    expect((p as any)._pendingRoots).toEqual([current.root]);
    v.emit('layout-content-added', { root: placed, chunks: [chunk] });
    expect(attach).toHaveBeenCalledTimes(1);
    expect((p as any)._pendingChunks.get(placed)).toEqual([chunk]);
    v.emit('layout-content-removed', { root: placed });
    expect(forget).toHaveBeenCalledTimes(1);
    expect((p as any)._pendingRoots).toEqual([current.root]);
    expect((p as any)._pendingChunks.size).toBe(0);
    p.dispose();
    attach.mockRestore();
    forget.mockRestore();
  });
});
