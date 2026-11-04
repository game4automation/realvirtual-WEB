// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-599 §9.1 — `RVViewer.renderAuxiliaryPass(fn)`, the generic hook for an
 * extra off-screen render outside the main pass.
 *
 * Inside `fn`: ground reflector hidden, global clipping planes off, XR off,
 * `scene.matrixWorldAutoUpdate` off. Afterwards (also when `fn` throws)
 * reflector visibility, clipping planes, local clipping, XR, the scene flag,
 * `autoClear` and the active render target are back. Returns false (fn not
 * run) during a video capture and under a WebGPURenderer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mesh, Plane, Vector3, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

let handle: TestViewerHandle;
let viewer: RVViewer;

beforeAll(async () => {
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
});

afterAll(() => handle?.dispose());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = () => viewer as any;

describe('RVViewer.renderAuxiliaryPass (plan-599 §9.1)', () => {
  it('isolates the pass and restores every touched piece of state', () => {
    const gl = viewer.renderer as unknown as WebGLRenderer;
    const reflector = new Mesh();
    reflector.visible = true;
    internals()._groundReflector = { mesh: reflector };
    const clip = [new Plane(new Vector3(0, 1, 0), 0)];
    gl.clippingPlanes = clip;
    gl.localClippingEnabled = true;
    gl.xr.enabled = true;
    gl.autoClear = false;
    const prevRT = new WebGLRenderTarget(4, 4);
    gl.setRenderTarget(prevRT);
    viewer.scene.matrixWorldAutoUpdate = true;

    let seen: Record<string, unknown> | null = null;
    const ok = viewer.renderAuxiliaryPass((r, scene) => {
      seen = {
        renderer: r === gl,
        scene: scene === viewer.scene,
        reflector: reflector.visible,
        clip: r.clippingPlanes.length,
        xr: r.xr.enabled,
        auto: scene.matrixWorldAutoUpdate,
      };
      const own = new WebGLRenderTarget(8, 8);
      r.setRenderTarget(own);
      r.autoClear = true;
      r.render(scene, viewer.camera);
      own.dispose();
    });
    expect(ok).toBe(true);
    expect(seen).toEqual({ renderer: true, scene: true, reflector: false, clip: 0, xr: false, auto: false });
    expect(reflector.visible).toBe(true);
    expect(gl.clippingPlanes).toBe(clip);
    expect(gl.localClippingEnabled).toBe(true);
    expect(gl.xr.enabled).toBe(true);
    expect(gl.autoClear).toBe(false);
    expect(gl.getRenderTarget()).toBe(prevRT);
    expect(viewer.scene.matrixWorldAutoUpdate).toBe(true);

    // cleanup
    gl.setRenderTarget(null);
    prevRT.dispose();
    gl.clippingPlanes = [];
    gl.xr.enabled = false;
    gl.autoClear = true;
    internals()._groundReflector = null;
  });

  it('restores everything when fn throws (the error propagates)', () => {
    const gl = viewer.renderer as unknown as WebGLRenderer;
    const reflector = new Mesh();
    internals()._groundReflector = { mesh: reflector };
    const clip = [new Plane(new Vector3(1, 0, 0), 1)];
    gl.clippingPlanes = clip;
    const tmp = new WebGLRenderTarget(2, 2);
    expect(() => viewer.renderAuxiliaryPass((r) => {
      r.setRenderTarget(tmp);
      throw new Error('boom');
    })).toThrow('boom');
    tmp.dispose();
    expect(reflector.visible).toBe(true);
    expect(gl.clippingPlanes).toBe(clip);
    expect(gl.getRenderTarget()).toBe(null);
    expect(viewer.scene.matrixWorldAutoUpdate).toBe(true);
    gl.clippingPlanes = [];
    internals()._groundReflector = null;
  });

  it('returns false and does not run fn during a video capture', () => {
    internals()._capture = { clockSec: 0, frameDt: 1 / 30 };
    let ran = false;
    try {
      expect(viewer.renderAuxiliaryPass(() => { ran = true; })).toBe(false);
    } finally {
      internals()._capture = null;
    }
    expect(ran).toBe(false);
    expect(viewer.renderAuxiliaryPass(() => { ran = true; })).toBe(true);
    expect(ran).toBe(true);
  });
});

describe('RVViewer.renderAuxiliaryPass under WebGPURenderer', () => {
  it('returns false (no classic WebGL renderer)', async () => {
    const h = await createTestViewer('webgpu-gl');
    try {
      let ran = false;
      expect(h.viewer.renderAuxiliaryPass(() => { ran = true; })).toBe(false);
      expect(ran).toBe(false);
    } finally {
      h.dispose();
    }
  }, 30_000);
});
