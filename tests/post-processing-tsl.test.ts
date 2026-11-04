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
  BoxGeometry,
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

  it('overlay layers are composited inside the pipeline over the graded frame', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;

    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    // Red plane (scene) + a green overlay quad on its own layer in the upper
    // left corner, excluded from the camera like the viewer does for its
    // overlay layers. The overlay material matches the viewer's overlay
    // contract (depthTest off).
    const OVERLAY_LAYER = 5;
    const { scene, camera } = buildTestScene();
    camera.layers.disable(OVERLAY_LAYER);
    const overlay = new Mesh(
      new PlaneGeometry(0.6, 0.6),
      new MeshBasicMaterial({ color: 0x00ff00, depthTest: false }),
    );
    overlay.position.set(-0.6, 0.6, 1);
    overlay.layers.set(OVERLAY_LAYER);
    scene.add(overlay);

    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    const without = new tsl!.TslPostPipeline(viewer.renderer);
    const withOverlay = new tsl!.TslPostPipeline(viewer.renderer, { overlayLayerMask: 1 << OVERLAY_LAYER });
    try {
      expect(without.compositesOverlayLayers).toBe(false);
      expect(withOverlay.compositesOverlayLayers).toBe(true);

      // Without an overlay pass the camera exclusion hides the quad.
      const plain = await renderPipelineTo(viewer, without, rt, scene, camera);
      const plainCorner = pixelAt(plain, 8, 56); // readback is bottom-up → y 56 ≙ top rows
      expect(plainCorner[1], `overlay layer must stay hidden without the pass, got rgb(${plainCorner})`).toBeLessThan(60);

      // With the overlay pass the quad is composited on top ...
      const composed = await renderPipelineTo(viewer, withOverlay, rt, scene, camera);
      const corner = pixelAt(composed, 8, 56);
      expect(corner[1], `overlay quad must be composited green, got rgb(${corner})`).toBeGreaterThan(150);
      expect(corner[0], `overlay must cover the frame, got rgb(${corner})`).toBeLessThan(60);

      // ... and the rest of the frame is untouched: the red plane stays red
      // and the scene background was NOT painted over it by the overlay pass.
      const centre = pixelAt(composed, 32, 32);
      const plainCentre = pixelAt(plain, 32, 32);
      expect(centre[0], `plane must stay red under the overlay pass, got rgb(${centre})`).toBeGreaterThan(80);
      expect(Math.abs(centre[0] - plainCentre[0]) + Math.abs(centre[1] - plainCentre[1]) + Math.abs(centre[2] - plainCentre[2]),
        `frame outside the overlay must match the plain pipeline, got rgb(${centre}) vs rgb(${plainCentre})`).toBeLessThan(12);
      // The background pixel restores the scene background after the pass.
      expect(scene.background, 'overlay pass must restore scene.background').not.toBeNull();
    } finally {
      without.dispose();
      withOverlay.dispose();
      rt.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  // ── plan-763: bloom, status channel + pulse, toon edges ───────────────

  it('bloom bleeds beyond a bright plane, lives in the graph only while enabled (one rebuild per toggle)', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    // A white plane on a dark background: bloom must lift the background
    // pixels right outside the plane.
    const { scene, camera, mesh } = buildTestScene();
    (mesh.material as MeshBasicMaterial).color.setHex(0xffffff);
    const pipeline = new tsl!.TslPostPipeline(viewer.renderer);
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    try {
      const base = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      const builds0 = pipeline.buildCount;
      const outside0 = pixelAt(base, 6, 32); // left of the plane (plane spans ~17..46 px)
      expect(outside0[0], `background should be dark without bloom, got ${outside0}`).toBeLessThan(40);

      pipeline.setBloom(true, 2.0, 0.6, 0);
      const bloomed = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount, 'enabling bloom rebuilds the graph once').toBe(builds0 + 1);
      const outside1 = pixelAt(bloomed, 6, 32);
      expect(outside1[0] - outside0[0], `bloom must brighten the pixel next to the plane, got ${outside0} → ${outside1}`).toBeGreaterThan(10);

      // Parameter changes are live uniforms — no rebuild.
      pipeline.setBloom(true, 0.5, 0.6, 0);
      await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount, 'a strength change must not rebuild').toBe(builds0 + 1);

      // Disabling takes the node OUT of the graph and restores the base frame.
      pipeline.setBloom(false, 0.5, 0.6, 0);
      const off = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount, 'disabling bloom rebuilds once').toBe(builds0 + 2);
      expect(countDifferingPixels(base, off)).toBeLessThan(5);
      expect(pipeline.anyEffectActive).toBe(false);
    } finally {
      rt.dispose();
      pipeline.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('status channel outlines with the configured colour and its pulse factor scales the edge', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    const { scene, camera, mesh } = buildTestScene();
    (mesh.material as MeshBasicMaterial).color.setHex(0x404040);
    // Fixed clock: the pulse cosine is evaluated at t = 0 → factor 1.
    const pipeline = new tsl!.TslPostPipeline(viewer.renderer, { now: () => 0 });
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    try {
      const base = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      pipeline.setOutlineStyle('status', {
        visibleEdgeColor: 0xff0000, hiddenEdgeColor: 0x330000, edgeStrength: 8, edgeThickness: 3, edgeGlow: 0, pulsePeriod: 0,
      });
      pipeline.setOutlined('status', [mesh]);
      expect(pipeline.anyEffectActive).toBe(true);
      const builds = pipeline.buildCount;
      const outlined = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      let reddish = 0;
      for (let i = 0; i < outlined.length; i += 4) {
        if (outlined[i] > outlined[i + 1] + 40 && outlined[i] > outlined[i + 2] + 40) reddish++;
      }
      expect(reddish, 'status outline pixels should show the red edge colour').toBeGreaterThan(5);

      // Pulse factor 0 removes the edge without touching the graph.
      pipeline.setOutlinePulse('status', 0);
      const pulsedOut = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount, 'the pulse is a uniform, never a rebuild').toBe(builds);
      expect(countDifferingPixels(base, pulsedOut)).toBeLessThan(5);

      // A pulse period hands the factor to the clock: at t = 0 the cosine is 1
      // and the edge is back at full strength.
      pipeline.setOutlineStyle('status', { pulsePeriod: 0.6 });
      const pulsedIn = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      expect(countDifferingPixels(base, pulsedIn)).toBeGreaterThan(10);
    } finally {
      rt.dispose();
      pipeline.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('toon edges draw a silhouette from the MRT normal + depth, with AO off and MSAA requested', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    // A cube in front of a same-coloured plane: no colour edge, only a
    // depth/normal edge where the cube's silhouette meets the plane.
    const { scene, camera } = buildTestScene();
    const cube = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshBasicMaterial({ color: 0xff0000 }));
    cube.position.set(0, 0, 1);
    cube.rotation.set(0.4, 0.6, 0);
    scene.add(cube);
    // samples 4 + edges + bloom + AO off: the one combination where MSAA and
    // the depth read of the edge node meet — it must build and render.
    const pipeline = new tsl!.TslPostPipeline(viewer.renderer, { samples: 4 });
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    try {
      const base = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      const builds0 = pipeline.buildCount;

      pipeline.setToonEdges(true, 1, 1.5, 0.05, 0x0000ff, 100);
      pipeline.setBloom(true, 0.3, 0.2, 0.9);
      const edged = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount, 'edges + bloom enabled together build once').toBe(builds0 + 1);
      let bluish = 0;
      for (let i = 0; i < edged.length; i += 4) {
        if (edged[i + 2] > edged[i] + 40 && edged[i + 2] > edged[i + 1] + 40) bluish++;
      }
      expect(bluish, 'edge pixels should show the blue line colour at the cube silhouette').toBeGreaterThan(5);

      pipeline.setToonEdges(false, 1, 1.5, 0.05, 0x0000ff, 100);
      pipeline.setBloom(false, 0.3, 0.2, 0.9);
      const off = await renderPipelineTo(viewer, pipeline, rt, scene, camera);
      expect(pipeline.buildCount, 'disabling both rebuilds once').toBe(builds0 + 2);
      expect(countDifferingPixels(base, off)).toBeLessThan(5);
    } finally {
      rt.dispose();
      pipeline.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('FXAA stands in for MSAA only while AO / edges force a single-sample scene pass', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    // A tilted flat-red cube on a dark background: every silhouette pixel is
    // either red, background, or — only with some antialiasing — a blend.
    const { scene, camera, mesh } = buildTestScene();
    mesh.visible = false;
    const cube = new Mesh(new BoxGeometry(0.9, 0.9, 0.9), new MeshBasicMaterial({ color: 0xff0000 }));
    cube.rotation.set(0.5, 0.7, 0.3);
    scene.add(cube);
    const blendedPixels = (buf: Uint8Array): number => {
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) {
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        const background = Math.max(r, g, b) < 40;
        const red = r > 150 && g < 80 && b < 80;
        if (!background && !red) n++;
      }
      return n;
    };
    // Edges enabled with amount 0 draw nothing but force the single-sample
    // pass — the cleanest way to take MSAA away without changing the picture.
    const edgesOnButInvisible = (p: TslPostPipeline): void => p.setToonEdges(true, 0, 1, 0.05, 0x000000, 100);

    const aliased = new tsl!.TslPostPipeline(viewer.renderer, { samples: 4, postAntialias: 'none' });
    const auto = new tsl!.TslPostPipeline(viewer.renderer, { samples: 4 });
    const noAA = new tsl!.TslPostPipeline(viewer.renderer, { samples: 0 });
    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    try {
      // MSAA live → no FXAA in the graph.
      await renderPipelineTo(viewer, auto, rt, scene, camera);
      expect(auto.postAntialiasActive, 'MSAA live: FXAA stays out of the graph').toBe(false);

      edgesOnButInvisible(aliased);
      edgesOnButInvisible(auto);
      edgesOnButInvisible(noAA);
      const hard = await renderPipelineTo(viewer, aliased, rt, scene, camera);
      const soft = await renderPipelineTo(viewer, auto, rt, scene, camera);
      const plain = await renderPipelineTo(viewer, noAA, rt, scene, camera);
      expect(aliased.postAntialiasActive, 'postAntialias none: no FXAA').toBe(false);
      expect(auto.postAntialiasActive, 'samples 4 + single-sample pass: FXAA built').toBe(true);
      expect(noAA.postAntialiasActive, 'samples 0: nothing to stand in for').toBe(false);
      expect(auto.passes.some((p) => p.bucket === 'post'), 'FXAA node instrumented as post').toBe(true);
      // The harness GPU does not multisample measurably and the FXAA texture
      // is sized to the renderer's drawing buffer, not to this 64 px target
      // (the quad is minified into it), so the pixel claims stay modest: FXAA
      // changes the frame along the silhouette and never blends less.
      expect(countDifferingPixels(soft, hard), 'FXAA changes silhouette pixels').toBeGreaterThan(5);
      expect(blendedPixels(soft), 'FXAA never blends less than the hard frame').toBeGreaterThanOrEqual(blendedPixels(hard));
      expect(countDifferingPixels(hard, plain), 'postAntialias none equals an unantialiased pipeline').toBeLessThan(5);

      // Edges off again → MSAA is back and FXAA leaves the graph.
      auto.setToonEdges(false, 0, 1, 0.05, 0x000000, 100);
      await renderPipelineTo(viewer, auto, rt, scene, camera);
      expect(auto.postAntialiasActive).toBe(false);
    } finally {
      rt.dispose();
      aliased.dispose();
      auto.dispose();
      noAA.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);
});
