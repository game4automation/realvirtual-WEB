// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * post-processing-tsl-raytraced.test.ts — plan-762 § 9.5 (pixel, browser,
 * webgpu-gl via tests/helpers/create-test-viewer.ts).
 *
 * The ray traced composite of `TslPostPipeline` without any backend: the
 * irradiance is a plain `DataTexture` (F18 — `setRaytraced` accepts any
 * Texture), so the G-buffer MRT, the depth / history gates and the
 * matrices / generation capture are pinned on the WebGL2 backend of the
 * WebGPURenderer, where CI can run them.
 *
 *  1. Default graph unchanged: no MRT on the scene pass, no G-buffer, and a
 *     Shaded → Raytraced → Shaded round trip returns the identical frame.
 *  2. Composite: irradiance 1 → pixel ≈ the raster diffuse colour; irradiance
 *     0 (with history) → black; sky (depth = 1) keeps the raster output;
 *     N = 0 (alpha 0) keeps the raster output; mix 0 keeps the raster output.
 *  3. Outline channels stay in the graph under the composite.
 *  4. G-buffer: null until the first ray traced render; matrices of the pass
 *     camera; `generation` bumps on a rebuild and on a size change, not per frame.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  Color,
  DataTexture,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  WebGLRenderTarget,
  type Camera,
} from 'three';
import {
  createTestViewer,
  readRenderTargetPixelsAsync,
  type TestViewerHandle,
} from './helpers/create-test-viewer';
import {
  createMaterialContext,
  getTslMaterials,
  preloadTslMaterials,
} from '../src/core/engine/materials/material-factory';
import type { TslPostPipeline } from '../src/core/engine/materials/rv-post-processing-tsl';

const VIEWER_TEST_TIMEOUT = 90_000;
const RT_SIZE = 64;

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

interface RenderTargetRenderer {
  setRenderTarget(t: unknown): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
}

function pixelAt(buf: Uint8Array, x: number, y: number): [number, number, number] {
  const o = (y * RT_SIZE + x) * 4;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

function countDifferingPixels(a: Uint8Array, b: Uint8Array, tol = 6): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > tol) n++;
  }
  return n;
}

/** A constant irradiance texture: rgb = e (0..1), alpha = sample count (0 or 1). */
function irradianceTexture(e: number, n: number): DataTexture {
  const v = Math.round(e * 255);
  const tex = new DataTexture(new Uint8Array([v, v, v, n > 0 ? 255 : 0]), 1, 1, RGBAFormat, UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

/** Orange plane in the middle, dark sky around it. */
function buildScene(): { scene: Scene; camera: OrthographicCamera; mesh: Mesh } {
  const scene = new Scene();
  scene.background = new Color(0x202020);
  const mesh = new Mesh(new PlaneGeometry(0.9, 0.9), new MeshBasicMaterial({ color: 0xff8000 }));
  scene.add(mesh);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { scene, camera, mesh };
}

async function renderTo(
  viewer: TestViewerHandle['viewer'],
  pipeline: TslPostPipeline,
  rt: WebGLRenderTarget,
  scene: Scene,
  camera: Camera,
): Promise<Uint8Array> {
  const renderer = viewer.renderer as unknown as RenderTargetRenderer;
  renderer.setRenderTarget(rt);
  pipeline.render(scene, camera);
  renderer.setRenderTarget(null);
  return readRenderTargetPixelsAsync(viewer, rt);
}

async function setup(): Promise<{ viewer: TestViewerHandle['viewer']; pipeline: TslPostPipeline }> {
  handle = await createTestViewer('webgpu-gl');
  const { viewer } = handle;
  viewer.loop.stop();
  await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
  const tsl = getTslMaterials();
  expect(tsl).not.toBeNull();
  return { viewer, pipeline: new tsl!.TslPostPipeline(viewer.renderer) };
}

/** The scene pass's MRT node (PassNode keeps it in `_mrt`; null = plain colour pass). */
function sceneMrt(pipeline: TslPostPipeline): unknown {
  return (pipeline.passes[0]?.node as unknown as { _mrt?: unknown })._mrt ?? null;
}

describe('TSL ray traced composite (plan-762 § 9.5)', () => {
  it('leaves the default graph untouched and round-trips Shaded → Raytraced → Shaded', async () => {
    const { viewer, pipeline } = await setup();
    const { scene, camera } = buildScene();
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    const one = irradianceTexture(1, 1);
    try {
      pipeline.setSaturation(0.999); // engage the pipeline without the ray traced mode
      expect(pipeline.raytracedReady).toBe(false);
      const shaded = await renderTo(viewer, pipeline, rt, scene, camera);
      expect(sceneMrt(pipeline), 'the default scene pass has no MRT').toBeNull();
      expect(pipeline.raytracedGBuffer).toBeNull();
      const buildsBefore = pipeline.buildCount;

      pipeline.setRaytraced(one);
      expect(pipeline.raytracedReady).toBe(true);
      expect(pipeline.anyEffectActive).toBe(true);
      await renderTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount, 'entering rebuilds exactly once').toBe(buildsBefore + 1);
      expect(sceneMrt(pipeline), 'the ray traced scene pass is an MRT G-buffer').not.toBeNull();
      expect(pipeline.raytracedGBuffer).not.toBeNull();

      pipeline.setRaytraced(null);
      const again = await renderTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount).toBe(buildsBefore + 2);
      expect(sceneMrt(pipeline)).toBeNull();
      expect(pipeline.raytracedGBuffer, 'leaving drops the G-buffer').toBeNull();
      expect(countDifferingPixels(shaded, again, 0), 'the Shaded frame is identical after the round trip').toBe(0);
    } finally {
      one.dispose();
      rt.dispose();
      pipeline.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('composites diffuse × irradiance with the depth and history gates', async () => {
    const { viewer, pipeline } = await setup();
    const { scene, camera } = buildScene();
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    const one = irradianceTexture(1, 1);
    const zero = irradianceTexture(0, 1);
    const half = irradianceTexture(0.5, 1);
    const noHistory = irradianceTexture(0, 0);
    try {
      pipeline.setSaturation(0.999);
      const raster = await renderTo(viewer, pipeline, rt, scene, camera);
      const plane = pixelAt(raster, 32, 32);
      const sky = pixelAt(raster, 2, 2);
      expect(plane[0], `the plane renders orange, got rgb(${plane})`).toBeGreaterThan(200);
      expect(plane[1]).toBeGreaterThan(60);

      // E = 1 → the raster diffuse colour (unlit material, no specular).
      pipeline.setRaytraced(one);
      const lit = await renderTo(viewer, pipeline, rt, scene, camera);
      const litPlane = pixelAt(lit, 32, 32);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(litPlane[c] - plane[c]), `E = 1 must reproduce the diffuse colour: ${litPlane} vs ${plane}`).toBeLessThanOrEqual(3);
      }
      // Sky has depth 1 → the raster output, untouched.
      expect(pixelAt(lit, 2, 2)).toEqual(sky);

      // E = 0 with history → black geometry, sky unchanged.
      pipeline.setRaytracedIrradiance(zero);
      const dark = await renderTo(viewer, pipeline, rt, scene, camera);
      const darkPlane = pixelAt(dark, 32, 32);
      expect(darkPlane[0] + darkPlane[1] + darkPlane[2], `E = 0 must be black, got rgb(${darkPlane})`).toBeLessThan(6);
      expect(pixelAt(dark, 2, 2)).toEqual(sky);

      // E = 0.5 lies between (sRGB-encoded, so above half the byte value).
      pipeline.setRaytracedIrradiance(half);
      const mid = pixelAt(await renderTo(viewer, pipeline, rt, scene, camera), 32, 32);
      expect(mid[0]).toBeGreaterThan(darkPlane[0] + 50);
      expect(mid[0]).toBeLessThan(litPlane[0]);

      // N = 0 (reset / rows outside the budget so far) → the raster output, not black.
      pipeline.setRaytracedIrradiance(noHistory);
      const reset = await renderTo(viewer, pipeline, rt, scene, camera);
      expect(countDifferingPixels(raster, reset, 3), 'no history must show the raster frame').toBe(0);

      // null → the placeholder (black, N = 0) → raster output as well.
      pipeline.setRaytracedIrradiance(null);
      const placeholder = await renderTo(viewer, pipeline, rt, scene, camera);
      expect(countDifferingPixels(raster, placeholder, 3)).toBe(0);

      // Mix 0 (wireframe / capture, F17) → raster output with history present, no rebuild.
      pipeline.setRaytracedIrradiance(zero);
      const builds = pipeline.buildCount;
      pipeline.setRaytracedMix(0);
      const paused = await renderTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount, 'the mix is a uniform, not a rebuild').toBe(builds);
      expect(countDifferingPixels(raster, paused, 3)).toBe(0);
      pipeline.setRaytracedMix(1);
      const back = pixelAt(await renderTo(viewer, pipeline, rt, scene, camera), 32, 32);
      expect(back[0] + back[1] + back[2]).toBeLessThan(6);
    } finally {
      for (const t of [one, zero, half, noHistory]) t.dispose();
      rt.dispose();
      pipeline.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('keeps the outline channels visible over the composite', async () => {
    const { viewer, pipeline } = await setup();
    const { scene, camera, mesh } = buildScene();
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    const zero = irradianceTexture(0, 1);
    try {
      pipeline.setRaytraced(zero);
      const plain = await renderTo(viewer, pipeline, rt, scene, camera);
      pipeline.setOutlineStyle('selection', {
        visibleEdgeColor: 0x00ff00, hiddenEdgeColor: 0x003300, edgeStrength: 8, edgeThickness: 3, edgeGlow: 0,
      });
      pipeline.setOutlined('selection', [mesh]);
      const outlined = await renderTo(viewer, pipeline, rt, scene, camera);
      expect(countDifferingPixels(plain, outlined, 12), 'the outline must still draw edges').toBeGreaterThan(10);
      let greenish = 0;
      for (let i = 0; i < outlined.length; i += 4) {
        if (outlined[i + 1] > outlined[i] + 40 && outlined[i + 1] > outlined[i + 2] + 40) greenish++;
      }
      expect(greenish).toBeGreaterThan(5);
    } finally {
      zero.dispose();
      rt.dispose();
      pipeline.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('records the pass camera and bumps the generation on rebuild and resize only', async () => {
    const { viewer, pipeline } = await setup();
    const { scene, camera } = buildScene();
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    const one = irradianceTexture(1, 1);
    const renderer = viewer.renderer as unknown as RenderTargetRenderer;
    try {
      pipeline.setRaytraced(one);
      expect(pipeline.raytracedGBuffer, 'null before the first ray traced pass rendered (spike 0.a)').toBeNull();
      await renderTo(viewer, pipeline, rt, scene, camera);
      const gb = pipeline.raytracedGBuffer!;
      expect(gb).not.toBeNull();
      expect(gb.isOrthographic).toBe(true);
      expect(gb.cameraPosition).toEqual([0, 0, 5]);
      expect(gb.width).toBeGreaterThan(0);
      expect(gb.height).toBeGreaterThan(0);
      const expected = new Matrix4().multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
      for (let i = 0; i < 16; i++) expect(gb.viewProjectionInverse[i]).toBeCloseTo(expected.elements[i], 5);
      // plan-767 F6: the forward P·V next to the inverse
      const fwd = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      for (let i = 0; i < 16; i++) expect(gb.viewProjection[i]).toBeCloseTo(fwd.elements[i], 5);
      for (const t of [gb.depth, gb.diffuse, gb.normal, gb.specular]) expect(t).toBeTruthy();
      expect(gb.normal.type).toBe(UnsignedByteType);
      const g0 = gb.generation;

      await renderTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.raytracedGBuffer!.generation, 'a plain frame keeps the generation').toBe(g0);

      // Rebuild (AO toggle) → new pass, new textures, higher generation.
      pipeline.setAoEnabled(true);
      await renderTo(viewer, pipeline, rt, scene, camera);
      const g1 = pipeline.raytracedGBuffer!.generation;
      expect(g1).toBeGreaterThan(g0);
      pipeline.setAoEnabled(false);
      await renderTo(viewer, pipeline, rt, scene, camera);
      const gb2 = pipeline.raytracedGBuffer!;
      const g2 = gb2.generation;
      expect(g2).toBeGreaterThan(g1);

      // Size change (drawing buffer) → same object, higher generation, new size.
      const w0 = gb2.width;
      renderer.setSize(320, 200, false);
      await renderTo(viewer, pipeline, rt, scene, camera);
      const gb3 = pipeline.raytracedGBuffer!;
      expect(gb3.generation).toBeGreaterThan(g2);
      expect(gb3.width).not.toBe(w0);

      // A moved camera updates the matrices in place.
      camera.position.set(1, 0, 5);
      camera.updateMatrixWorld();
      await renderTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.raytracedGBuffer!.cameraPosition[0]).toBeCloseTo(1, 6);
      expect(pipeline.raytracedGBuffer!.generation).toBe(gb3.generation);
    } finally {
      one.dispose();
      rt.dispose();
      pipeline.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);
});
