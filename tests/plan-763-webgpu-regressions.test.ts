// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-763-webgpu-regressions.test.ts — the WebGPU backend completion gate
 * (browser, `webgpu-gl` = WebGPURenderer on its WebGL backend; a real WebGPU
 * adapter does not exist headless).
 *
 *  1. CANVAS — after one full viewer frame the canvas is NOT transparent. The
 *     2026-10-13 grey screen: a `renderer.render()` after the TSL pipeline was
 *     blitted over the finished frame through three's frame-buffer target.
 *  2. PICK — baked chunk geometry keeps its index and the pick backend returns
 *     a hit. The 2026-10-14 bug: the loader stripped the index under WebGPU and
 *     the chunk narrow phase returned nothing.
 *  3. FRAME STATS — the instrumented TSL pipeline books scene / ao / outline /
 *     overlay / post, buckets sum to the total, `other` is empty, and wrapping
 *     is idempotent across a rebuild.
 *  4. REFLECTOR — the TSL floor mirror reflects a red cube onto the floor, is
 *     invisible at strength 0, and hides the checker during its mirror render.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type Intersection,
  type Object3D,
} from 'three';
import { createTestViewer, readRenderTargetPixelsAsync, type TestViewerHandle } from './helpers/create-test-viewer';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';
import {
  createMaterialContext, getTslMaterials, preloadTslMaterials,
} from '../src/core/engine/materials/material-factory';
import {
  createFrameStats, finalizeFrameStats, instrumentTslPasses, resetFrameStats,
  setActiveFrameStats, withActiveBucket, addDelta, drawCallsOf, type RenderInfoLike,
} from '../src/core/engine/rv-frame-stats';
import { groundReflectorConstants } from '../src/core/engine/rv-ground-reflector';

const DEV_ASSETS = await devAssetAvailable(DEV_GLB.europalletEmpty);
const VIEWER_TEST_TIMEOUT = 90_000;
const RT = 64;

let handle: TestViewerHandle | null = null;
afterEach(() => {
  handle?.dispose();
  handle = null;
  vi.restoreAllMocks();
});

function centrePixel(canvas: HTMLCanvasElement): [number, number, number, number] {
  const c2 = document.createElement('canvas');
  c2.width = canvas.width;
  c2.height = canvas.height;
  const ctx = c2.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  const d = ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

describe('plan-763 WebGPU regressions (webgpu-gl)', () => {
  it.skipIf(!DEV_ASSETS)('canvas is not transparent after a full viewer frame', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    expect(await viewer.loadModel(DEV_GLB.europalletEmpty)).toBeTruthy();
    viewer.aoMode = 'gtao'; // the pipeline path (AO forces the TSL post branch)
    // Render through the SAME path as the live loop and sample the canvas in
    // the same tick — the drawing buffer is only valid until the task ends.
    expect(viewer.renderFrameForCapture()).toBe(true);
    const px = centrePixel(viewer.renderer.domElement);
    expect(px[3], `canvas centre must be opaque after a frame, got rgba(${px})`).toBe(255);
    expect(px[0] + px[1] + px[2], 'and not black').toBeGreaterThan(0);
  }, VIEWER_TEST_TIMEOUT);

  it.skipIf(!DEV_ASSETS)('baked chunks keep their index and the pick backend hits them', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    expect(await viewer.loadModel(DEV_GLB.europalletEmpty)).toBeTruthy();
    const root = viewer.currentModelRoot!;
    // Every drawn mesh of the baked model (chunk or keep mesh) keeps the index
    // the pick structure addresses triangles through — the loader used to
    // convert all of them to non-indexed under WebGPU.
    const meshes: Mesh[] = [];
    root.traverse((o) => { const m = o as Mesh; if (m.isMesh && m.visible) meshes.push(m); });
    expect(meshes.length, 'the model draws at least one mesh').toBeGreaterThan(0);
    const indexed = meshes.filter((m) => m.geometry.index !== null);
    expect(indexed.length, 'indexed meshes survive the WebGPU load').toBeGreaterThan(0);

    // A ray from well outside the model through its centre must hit it —
    // through the pick backend (baked chunks) or the keep meshes' own pick
    // raycast; both need the index the loader used to strip.
    root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(root);
    const centre = box.getCenter(new Vector3());
    const extent = box.getSize(new Vector3()).length();
    const origin = centre.clone().add(new Vector3(1, 1, 1).normalize().multiplyScalar(extent * 2 + 1));
    const dir = centre.clone().sub(origin).normalize();
    const raycaster = new Raycaster(origin, dir);
    const hits: Intersection<Object3D>[] = [];
    const backend = (viewer as unknown as { _pickBackend: { raycast(r: Raycaster, out: Intersection<Object3D>[]): void } | null })._pickBackend;
    backend?.raycast(raycaster, hits);
    hits.push(...raycaster.intersectObject(root, true));
    expect(hits.length, 'a ray through the model centre must hit the model').toBeGreaterThan(0);
  }, VIEWER_TEST_TIMEOUT);

  it('frame stats: instrumented pipeline passes sum to the total, other stays empty, re-wrap is idempotent', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    viewer.pauseRendering(); // nothing else draws between reset and finalize
    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    const scene = new Scene();
    scene.background = new Color(0x202020);
    scene.add(new AmbientLight(0xffffff, 1));
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xff0000 }));
    scene.add(mesh);
    const overlay = new Mesh(new PlaneGeometry(0.3, 0.3), new MeshBasicMaterial({ color: 0x00ff00, depthTest: false }));
    overlay.position.set(-0.6, 0.6, 1);
    overlay.layers.set(5);
    scene.add(overlay);
    const camera = new PerspectiveCamera(50, 1, 0.1, 50);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);
    camera.layers.disable(5);

    const renderer = viewer.renderer as unknown as { info: RenderInfoLike & { reset(): void }; setRenderTarget(t: unknown): void };
    const info = renderer.info;
    const frame = createFrameStats();
    const pipeline = new tsl!.TslPostPipeline(viewer.renderer, {
      overlayLayerMask: 1 << 5,
      instrument: (passes) => instrumentTslPasses(passes, info, frame),
    });
    pipeline.setAoEnabled(true);
    pipeline.setOutlineStyle('selection', { edgeStrength: 5, edgeThickness: 2 });
    pipeline.setOutlined('selection', [mesh]);
    const rt = new WebGLRenderTarget(RT, RT);
    try {
      const frameOnce = async (): Promise<void> => {
        // FRAME-typed node updates run once per animation frame; a second
        // pipeline render inside the same task would skip them.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        info.reset();
        resetFrameStats(frame);
        setActiveFrameStats(frame);
        renderer.setRenderTarget(rt);
        const c0 = drawCallsOf(info), t0 = info.render.triangles;
        withActiveBucket('post', () => pipeline.render(scene, camera));
        addDelta(frame.post, info, c0, t0);
        renderer.setRenderTarget(null);
        finalizeFrameStats(frame, info);
        setActiveFrameStats(null);
      };
      await frameOnce();
      const builds = pipeline.buildCount;
      expect(frame.scene.calls, 'scene pass booked').toBeGreaterThan(0);
      expect(frame.ao.calls, 'AO booked').toBeGreaterThan(0);
      expect(frame.outline.calls, 'outline booked').toBeGreaterThan(0);
      expect(frame.overlay.calls, 'overlay pass booked').toBeGreaterThan(0);
      expect(frame.post.calls, 'the output quad stays in post').toBeGreaterThan(0);
      expect(frame.other.calls, 'nothing unaccounted').toBe(0);
      const sum = frame.scene.calls + frame.ao.calls + frame.outline.calls + frame.overlay.calls + frame.post.calls;
      expect(sum).toBe(frame.total.calls);

      // Second frame on the same graph: the wrap is not applied twice.
      const first = { ...frame.scene };
      await frameOnce();
      expect(pipeline.buildCount).toBe(builds);
      expect(frame.scene.calls).toBe(first.calls);
      expect(frame.other.calls).toBe(0);

      // A rebuild (AO off) re-instruments the fresh nodes.
      pipeline.setAoEnabled(false);
      await frameOnce();
      expect(pipeline.buildCount).toBe(builds + 1);
      expect(frame.ao.calls).toBe(0);
      expect(frame.other.calls).toBe(0);
      expect(frame.scene.calls + frame.outline.calls + frame.overlay.calls + frame.post.calls).toBe(frame.total.calls);
    } finally {
      rt.dispose();
      pipeline.dispose();
      viewer.resumeRendering();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('TSL floor mirror reflects a red cube onto the floor and hides the checker in the mirror', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    // A dark floor checker stand-in, a red cube above it, camera at a grazing
    // angle so the Fresnel term is strong.
    const scene = new Scene();
    scene.background = new Color(0x000000);
    scene.add(new AmbientLight(0xffffff, 3));
    const checker = new Mesh(new PlaneGeometry(200, 200), new MeshBasicMaterial({ color: 0x00ff00 }));
    checker.rotation.x = -Math.PI / 2;
    checker.visible = false; // only the mirror plane draws; the checker exists for the hide contract
    scene.add(checker);
    const cube = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xff0000 }));
    cube.position.set(0, 0.6, 0);
    scene.add(cube);
    const camera = new PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0.8, 5);
    camera.lookAt(0, 0.2, 0);

    let passes = 0;
    let checkerVisibleDuringMirror: boolean | null = null;
    const mirror = tsl!.createGroundReflectorTsl(checker, groundReflectorConstants(), {
      resolutionScale: 0.5,
      wrapPass: (run) => { passes++; checkerVisibleDuringMirror = checker.visible; return run(); },
    });
    scene.add(mirror.mesh);
    mirror.mesh.visible = true;
    checker.visible = true; // visible in the scene (drawn under the mirror plane)
    const rt = new WebGLRenderTarget(RT, RT);
    const renderer = viewer.renderer as unknown as { setRenderTarget(t: unknown): void; render(s: Scene, c: PerspectiveCamera): void };
    const shoot = async (): Promise<Uint8Array> => {
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      return readRenderTargetPixelsAsync(viewer, rt);
    };
    // The floor pixel below the cube (lower half of the frame, centre column).
    const floorPx = (buf: Uint8Array): [number, number, number] => {
      const o = ((RT >> 2) * RT + (RT >> 1)) * 4; // readback is bottom-up: row 16 ≙ lower quarter
      return [buf[o], buf[o + 1], buf[o + 2]];
    };
    try {
      // Baseline: mirror plane hidden (the viewer hides it while reflection
      // is off) — the floor pixel is the green checker alone.
      mirror.mesh.visible = false;
      const off = await shoot();
      const a = floorPx(off);
      expect(a[0], `no red on the floor without the mirror, got ${a}`).toBeLessThan(40);

      mirror.mesh.visible = true;
      mirror.setStrength(1);
      const on = await shoot();
      const b = floorPx(on);
      expect(b[0] - a[0], `the mirror must bring the red cube onto the floor, got ${a} → ${b}`).toBeGreaterThan(30);
      expect(passes, 'the mirror pass ran through the wrapper').toBeGreaterThan(0);
      expect(checkerVisibleDuringMirror, 'the checker is hidden during the mirror render').toBe(false);
      expect(checker.visible, 'and restored afterwards').toBe(true);

      mirror.setBlur(1); // rebuilds the colour graph; must still render
      const blurred = await shoot();
      expect(floorPx(blurred)[0]).toBeGreaterThan(a[0]);
    } finally {
      rt.dispose();
      mirror.dispose();
    }
  }, VIEWER_TEST_TIMEOUT);
});
