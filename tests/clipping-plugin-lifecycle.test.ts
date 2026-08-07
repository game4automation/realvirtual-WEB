// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';
import { Box3, Vector3, Mesh, Object3D, MeshStandardMaterial, BoxGeometry } from 'three';
import { EventEmitter } from '../src/core/rv-events';

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

const loadResult = (root: Object3D) =>
  ({ root, boundingBox: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)), drives: [] }) as any;

describe('ClippingPlugin lifecycle', () => {
  it('sets localClippingEnabled on model load', () => {
    const v = mockViewer(null);
    const p = new ClippingPlugin();
    (p as any).onModelLoaded(loadResult(modelRoot().root), v); // base hook calls onStart
    expect(v.renderer.localClippingEnabled).toBe(true);
  });

  it('F6: does NOT attach clippingPlanes to overlay (_tankFillViz) meshes', () => {
    const v = mockViewer(null);
    const p = new ClippingPlugin();
    const m = modelRoot();
    (p as any).onModelLoaded(loadResult(m.root), v);
    expect(m.modelMat.clippingPlanes).not.toBeNull(); // model clipped
    expect(m.overlayMat.clippingPlanes ?? null).toBeNull(); // overlay untouched
  });

  it('onDestroy disables clipping when no TankFillManager & clears set', () => {
    const v = mockViewer(null);
    const p = new ClippingPlugin();
    const m = modelRoot();
    (p as any).onModelLoaded(loadResult(m.root), v);
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

});

describe('ClippingPlugin Planner/DES reattach (layout-content-added)', () => {
  it('binds clipping planes to geometry placed after the initial load', () => {
    const v = eventViewer(null);
    const p = new ClippingPlugin();
    (p as any).onModelLoaded(loadResult(modelRoot().root), v);

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
});
