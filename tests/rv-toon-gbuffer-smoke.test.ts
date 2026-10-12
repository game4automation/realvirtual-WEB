// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-toon-gbuffer-smoke — WebGL baseline for the toon G-buffer (plan-740 §9.9,
 * review finding T5), and the home of the P2.0 spike (D-A10).
 *
 * TWO things are pinned here, both with a real WebGLRenderer:
 *
 *  1. The G-buffer override material renders. Its fragment packs the view
 *     normal into RGB and normalized linear depth into A, and the alpha must
 *     grow monotonically as the camera backs off. That is the behaviour the
 *     `edges`/`normals` channels inherit, and it had never been covered by a
 *     test — the toon outline is a visual feature, so a silently broken
 *     G-buffer would only show up as "the lines went away".
 *
 *  2. It survives `scene.overrideMaterial` over a **BatchedMesh**. This is the
 *     P2.0 spike: the whole batched render pipeline draws through arenas, and
 *     an override shader that forgets `<batching_pars_vertex>` /
 *     `<batching_vertex>` renders every instance at the identity transform
 *     (doc-render-picking §1.6 point 5). `MeshDepthMaterial` with
 *     `RGBADepthPacking` is checked in the same pass, because the depth channel
 *     rides on three's own batching-aware shader rather than on ours.
 *
 * The material comes from `rv-gbuffer-material.ts` (P2.2 extraction). The same
 * shader source still backs `RVToonMaterialManager`, so a regression there
 * fails here first.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  BatchedMesh,
  BoxGeometry,
  Color,
  Matrix4,
  MeshDepthMaterial,
  PerspectiveCamera,
  RGBADepthPacking,
  Scene,
  LinearSRGBColorSpace,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { createGBufferMaterial } from '../src/core/engine/rv-gbuffer-material';
import { unpackRGBADepth } from '../src/core/engine/rv-gbuffer-material';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

const SIZE = 64;
let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

/** A scene whose only content is a batched unit cube at the origin. */
function batchedCubeScene(): { scene: Scene; dispose(): void } {
  const scene = new Scene();
  const geo = new BoxGeometry(1, 1, 1);
  const idx = geo.index!;
  const batched = new BatchedMesh(1, geo.attributes.position.count, idx.count);
  const geoId = batched.addGeometry(geo);
  const instId = batched.addInstance(geoId);
  batched.setMatrixAt(instId, new Matrix4());
  scene.add(batched);
  return {
    scene,
    dispose() {
      batched.dispose();
      geo.dispose();
      scene.clear();
    },
  };
}

function centerPixel(px: Uint8Array): [number, number, number, number] {
  const o = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
  return [px[o], px[o + 1], px[o + 2], px[o + 3]];
}

/** Render `scene` through `override` at `distance` and read the centre pixel. */
function probe(
  renderer: WebGLRenderer,
  scene: Scene,
  override: import('three').Material,
  distance: number,
  near: number,
  far: number,
): [number, number, number, number] {
  const camera = new PerspectiveCamera(45, 1, near, far);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const rt = new WebGLRenderTarget(SIZE, SIZE);
  // LINEAR, not sRGB: three gamma-encodes the output according to the target
  // texture colour space, and a G-buffer/depth pass writes NUMBERS, not colour.
  rt.texture.colorSpace = LinearSRGBColorSpace;
  const prevRT = renderer.getRenderTarget();
  const prevClear = new Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  try {
    scene.overrideMaterial = override;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    const px = new Uint8Array(SIZE * SIZE * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, px);
    return centerPixel(px);
  } finally {
    scene.overrideMaterial = null;
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    rt.dispose();
  }
}

describe('toon G-buffer (WebGL baseline + P2.0 spike)', () => {
  it('renders a BatchedMesh through scene.overrideMaterial and packs normal+depth', async () => {
    handle = await createTestViewer('webgl');
    const renderer = handle.viewer.renderer as unknown as WebGLRenderer;
    const { scene, dispose } = batchedCubeScene();
    const mat = createGBufferMaterial();
    try {
      const near = 0.1;
      const far = 20;
      mat.uniforms.uNear.value = near;
      mat.uniforms.uFar.value = far;

      const close = probe(renderer, scene, mat, 3, near, far);
      // Anything but the clear colour proves the arena drew at all — the whole
      // point of the spike. The front face looks straight at the camera, so the
      // encoded normal (n*0.5+0.5) is ≈ (0.5, 0.5, 1.0) → blue-dominant.
      expect(close, 'centre pixel must not be the clear colour').not.toEqual([0, 0, 0, 0]);
      expect(close[2]).toBeGreaterThan(200);
      expect(Math.abs(close[0] - 128)).toBeLessThan(24);
      expect(Math.abs(close[1] - 128)).toBeLessThan(24);

      // Alpha carries linear depth normalized near→far: back the camera off and
      // it must grow. (A batching-blind override would render the instance at
      // the identity transform and this relation would not hold.)
      const farther = probe(renderer, scene, mat, 8, near, far);
      expect(farther[3]).toBeGreaterThan(close[3]);
    } finally {
      mat.dispose();
      dispose();
    }
  });

  it('MeshDepthMaterial(RGBADepthPacking) yields metric depth over a BatchedMesh', async () => {
    handle = await createTestViewer('webgl');
    const renderer = handle.viewer.renderer as unknown as WebGLRenderer;
    const { scene, dispose } = batchedCubeScene();
    const depthMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    try {
      const near = 0.1;
      const far = 100;
      // Camera at z=3 looking at the origin; the cube's front face sits at
      // z=0.5, so the visible surface is 2.5 m away.
      const px = probe(renderer, scene, depthMat, 3, near, far);
      const d = unpackRGBADepth(px[0], px[1], px[2], px[3], near, far);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(2.3);
      expect(d).toBeLessThan(2.7);
    } finally {
      depthMat.dispose();
      dispose();
    }
  });
});
