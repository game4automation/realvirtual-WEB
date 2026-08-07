// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * post-processing-tsl.test.ts — plan-271 Phase 3 (integration, browser,
 * webgpu-gl via the F10 harness tests/helpers/create-test-viewer.ts).
 *
 * Exercises the TSL node post-processing stack on a REAL
 * `WebGPURenderer({forceWebGL:true})` with async pixel readback:
 *
 *  1. **Saturation** — the shared Rec.601 saturation node measurably changes
 *     pixels: saturation 1 keeps a red plane red, saturation 0 turns the same
 *     frame greyscale (r ≈ g ≈ b).
 *  2. **Selection outline** — outlining a mesh through the pipeline produces
 *     edge pixels that differ from the un-outlined frame (and carry the
 *     configured outline colour).
 *  3. **Desat blit** — the isolate-mode desaturation blit greys out a colored
 *     backdrop through the SAME shared node.
 *  4. **Manager wiring** — under webgpu-gl `outlineManager.available` is true
 *     and setting/clearing a selection flips `useTslPost` on the
 *     PostProcessingManager.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  AmbientLight,
  Color,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
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
  render(scene: Scene, camera: Camera): void;
}

function pixelAt(buf: Uint8Array, x: number, y: number): [number, number, number] {
  const o = (y * RT_SIZE + x) * 4;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

/** Count pixels whose rgb differs from the other buffer by more than `tol`. */
function countDifferingPixels(a: Uint8Array, b: Uint8Array, tol = 12): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > tol) n++;
  }
  return n;
}

/** Red plane on a dark background + camera — the shared mini test scene. */
function buildTestScene(): { scene: Scene; camera: OrthographicCamera; mesh: Mesh } {
  const scene = new Scene();
  scene.background = new Color(0x101010);
  scene.add(new AmbientLight(0xffffff, 1));
  const mesh = new Mesh(
    new PlaneGeometry(0.9, 0.9),
    new MeshBasicMaterial({ color: 0xff0000 }),
  );
  scene.add(mesh);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  return { scene, camera, mesh };
}

/** Render one pipeline frame into `rt` and read it back. */
async function renderPipelineTo(
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

describe('TSL node post-processing (plan-271 Phase 3)', () => {
  it('saturation node changes pixels measurably; selection outline produces edge pixels', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    expect(viewer.isWebGPU).toBe(true);

    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    const { scene, camera, mesh } = buildTestScene();
    const pipeline = new tsl!.TslPostPipeline(viewer.renderer);
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);

    try {
      // ── 1. Saturation ──────────────────────────────────────────────
      pipeline.setSaturation(1); // identity
      const colored = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      const c = pixelAt(colored, 32, 32);
      expect(c[0], `plane should render red through the pipeline, got rgb(${c})`).toBeGreaterThan(80);
      expect(c[0] - c[1], `red must dominate green at saturation 1, got rgb(${c})`).toBeGreaterThan(40);

      pipeline.setSaturation(0); // full greyscale
      const grey = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      const g = pixelAt(grey, 32, 32);
      // Rec601 luma of the red plane — channels converge.
      expect(Math.abs(g[0] - g[1]), `saturation 0 must grey out the plane, got rgb(${g})`).toBeLessThan(12);
      expect(Math.abs(g[1] - g[2]), `saturation 0 must grey out the plane, got rgb(${g})`).toBeLessThan(12);
      // … and the frame measurably differs from the colored one.
      expect(countDifferingPixels(colored, grey)).toBeGreaterThan(50);

      // ── 2. Selection outline ───────────────────────────────────────
      pipeline.setSaturation(1);
      const noOutline = await renderPipelineTo(viewer, pipeline, rt, scene, camera);

      pipeline.setOutlineStyle('selection', {
        visibleEdgeColor: 0x00ff00,
        hiddenEdgeColor: 0x003300,
        edgeStrength: 8,
        edgeThickness: 3,
        edgeGlow: 0,
      });
      pipeline.setOutlined('selection', [mesh]);
      const outlined = await renderPipelineTo(viewer, pipeline, rt, scene, camera);

      const changed = countDifferingPixels(noOutline, outlined);
      expect(changed, 'outlining the mesh must change edge pixels').toBeGreaterThan(10);
      // The changed pixels carry the configured green outline colour somewhere.
      let greenish = 0;
      for (let i = 0; i < outlined.length; i += 4) {
        if (outlined[i + 1] > outlined[i] + 40 && outlined[i + 1] > outlined[i + 2] + 40) greenish++;
      }
      expect(greenish, 'outline pixels should show the green edge colour').toBeGreaterThan(5);

      // Clearing the selection restores the un-outlined frame.
      pipeline.setOutlined('selection', []);
      const cleared = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      expect(countDifferingPixels(noOutline, cleared)).toBeLessThan(5);
    } finally {
      rt.dispose();
      pipeline.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('desat blit greys a colored backdrop through the shared Rec601 node', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;

    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    const { scene, camera } = buildTestScene();
    const blit = tsl!.createDesatBlitTsl();
    const out = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    const renderer = viewer.renderer as unknown as RenderTargetRenderer;

    try {
      // Backdrop into the blit RT …
      blit.setSize(RT_SIZE, RT_SIZE);
      renderer.setRenderTarget(blit.renderTarget);
      renderer.render(scene, camera);
      // … then desaturated blit into the output RT.
      blit.saturation.value = 0;
      renderer.setRenderTarget(out);
      blit.blit(viewer.renderer);
      renderer.setRenderTarget(null);

      const px = await readRenderTargetPixelsAsync(viewer, out);
      const p = pixelAt(px, 32, 32);
      expect(p[0] + p[1] + p[2], `backdrop must be visible, got rgb(${p})`).toBeGreaterThan(30);
      expect(Math.abs(p[0] - p[1]), `desat blit must grey the red plane, got rgb(${p})`).toBeLessThan(12);
      expect(Math.abs(p[1] - p[2]), `desat blit must grey the red plane, got rgb(${p})`).toBeLessThan(12);
    } finally {
      out.dispose();
      blit.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('outline manager wiring: available under webgpu-gl, selection flips useTslPost', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;

    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    expect(getTslMaterials()).not.toBeNull();

    // Under webgpu-gl the outline manager routes to the TSL pipeline.
    expect(viewer.outlineManager.available).toBe(true);

    // aoMode defaults to 'gtao' — under WebGPU that (correctly) keeps the TSL
    // AO active once the pipeline exists, mirroring WebGL where useComposer
    // also stays true after outlines clear. Turn AO off so the outline
    // flip-flop below is observable in isolation.
    viewer.aoMode = 'off';

    const pp = (viewer as unknown as {
      _postProcessing: { useTslPost: boolean; useComposer: boolean };
    })._postProcessing;
    expect(pp.useTslPost).toBe(false); // nothing active yet
    expect(pp.useComposer).toBe(false); // composer NEVER engages under WebGPU

    const probe = new Object3D();
    viewer.scene.add(probe);
    viewer.outlineManager.setOutlined([probe]);
    expect(viewer.outlineManager.hasOutlines).toBe(true);
    expect(pp.useTslPost, 'selection must engage the TSL post path').toBe(true);

    // Let the viewer's own render loop draw at least one frame through the
    // TSL branch (render → useTslPost → renderTslPost). An exception in the
    // pipeline would surface as an uncaught error and fail the test.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    viewer.outlineManager.clearAll();
    expect(pp.useTslPost, 'clearing the selection must release the TSL post path').toBe(false);

    // AO re-engages the TSL post path on its own (native TSL GTAO).
    viewer.aoMode = 'gtao';
    expect(pp.useTslPost, 'AO must engage the TSL post path').toBe(true);
    viewer.aoMode = 'off';
    expect(pp.useTslPost).toBe(false);
  }, VIEWER_TEST_TIMEOUT);
});
