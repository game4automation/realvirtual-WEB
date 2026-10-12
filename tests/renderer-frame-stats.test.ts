// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Per-pass frame accounting (rv-frame-stats.ts) on a REAL WebGL renderer.
 *
 * The DevTools tab used to show `renderer.info.render.calls` summed over
 * every pass of the frame (RenderPass + AO + OutlinePass depth/mask/edge +
 * shadow + overlay), so a five-mesh placement read as "+20 draw calls".
 * These tests pin the split: `scene` is the RenderPass alone, the outline
 * passes land in `outline`, `total` is the sum, and without a composer
 * `scene === total`. The viewer-level test pins that `getRendererInfo().frame`
 * is the same object across frames (no per-frame allocation).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector2, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { drawCallsOf,
  createFrameStats, resetFrameStats, addDelta, finalizeFrameStats,
  instrumentComposerPasses, instrumentShadowMap, passBucketOf, countRenderTargets,
  setActiveFrameStats,
  type FrameStats, type RenderInfoLike,
} from '../src/core/engine/rv-frame-stats';
import { createGroundReflector, getReflectorRenderTargets } from '../src/core/engine/rv-ground-reflector';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

function makeRenderer(): WebGLRenderer | null {
  try {
    const r = new WebGLRenderer();
    r.setSize(64, 64);
    (r.info as unknown as { autoReset: boolean }).autoReset = false;
    return r;
  } catch {
    return null; // no GL context — skip silently (same as rv-batched-render.test.ts)
  }
}

function threeMeshScene(): { scene: Scene; camera: PerspectiveCamera; meshes: Mesh[] } {
  const scene = new Scene();
  const meshes: Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xff0000 }));
    m.position.set(i * 2 - 2, 0, 0);
    scene.add(m);
    meshes.push(m);
  }
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  return { scene, camera, meshes };
}

function sumBuckets(f: FrameStats): number {
  return f.scene.calls + f.shadow.calls + f.reflection.calls + f.ao.calls + f.outline.calls + f.post.calls
    + f.overlay.calls + f.plugins.calls + f.other.calls;
}

/** Three boxes + a visible ground reflector (mirror plane at y=0, camera
 *  above it so the mirror faces the camera and actually re-renders). The
 *  checker mesh handed to the factory is NOT in the scene — it only gets
 *  hidden during the mirror render. */
function reflectorScene() {
  const { scene, camera, meshes } = threeMeshScene();
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);
  const checker = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  const reflector = createGroundReflector(false, checker)!;
  reflector.visible = true;
  scene.add(reflector);
  return { scene, camera, meshes, reflector };
}

describe('rv-frame-stats — composer per-pass split', () => {
  it('RenderPass → scene, OutlinePass → outline, total = sum of buckets', () => {
    const renderer = makeRenderer();
    if (!renderer) return;
    try {
      const { scene, camera, meshes } = threeMeshScene();
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const outline = new OutlinePass(new Vector2(64, 64), scene, camera);
      outline.selectedObjects = [meshes[1]];
      composer.addPass(outline);
      composer.addPass(new OutputPass());

      const info = renderer.info as unknown as RenderInfoLike;
      const frame = createFrameStats();
      instrumentShadowMap(renderer.shadowMap as unknown as { render: (...a: unknown[]) => void }, info, frame);

      renderer.info.reset();
      resetFrameStats(frame);
      instrumentComposerPasses(composer.passes, info, frame, [null]);
      composer.render();
      finalizeFrameStats(frame, info);

      expect(passBucketOf(composer.passes[0])).toBe('scene');
      expect(passBucketOf(composer.passes[1])).toBe('outline');
      expect(passBucketOf(composer.passes[2])).toBe('post');

      expect(frame.scene.calls).toBe(3);
      expect(frame.outline.calls).toBeGreaterThanOrEqual(1);
      expect(frame.post.calls).toBeGreaterThanOrEqual(1); // OutputPass fullscreen quad
      expect(frame.shadow.calls).toBe(0);
      expect(frame.total.calls).toBe(renderer.info.render.calls);
      expect(frame.total.calls).toBe(sumBuckets(frame));
      expect(frame.other.calls).toBe(0);
      // Triangles: 3 boxes × 12 = 36 in the scene pass, more in total.
      expect(frame.scene.triangles).toBe(36);
      expect(frame.total.triangles).toBeGreaterThan(36);

      // Second frame: wrapping is idempotent (no double counting).
      renderer.info.reset();
      resetFrameStats(frame);
      instrumentComposerPasses(composer.passes, info, frame, [null]);
      composer.render();
      finalizeFrameStats(frame, info);
      expect(frame.scene.calls).toBe(3);
      expect(frame.total.calls).toBe(sumBuckets(frame));

      // Render-target census: composer's two + the OutlinePass' own buffers.
      expect(countRenderTargets(composer, null)).toBeGreaterThanOrEqual(2 + 5);
    } finally {
      renderer.dispose();
    }
  });

  it('without a composer the scene delta IS the total', () => {
    const renderer = makeRenderer();
    if (!renderer) return;
    try {
      const { scene, camera } = threeMeshScene();
      const info = renderer.info as unknown as RenderInfoLike;
      const frame = createFrameStats();
      renderer.info.reset();
      resetFrameStats(frame);
      const c0 = drawCallsOf(info), t0 = info.render.triangles;
      renderer.render(scene, camera);
      addDelta(frame.scene, info, c0, t0);
      finalizeFrameStats(frame, info);
      expect(frame.scene.calls).toBe(3);
      expect(frame.total.calls).toBe(3);
      expect(frame.other.calls).toBe(0);
      expect(frame.scene.triangles).toBe(frame.total.triangles);
    } finally {
      renderer.dispose();
    }
  });
});

describe('rv-frame-stats — ground reflector as a nested pass', () => {
  afterEach(() => setActiveFrameStats(null));

  it('direct render: mirror draws land in `reflection`, `scene` keeps only the visible draws', () => {
    const renderer = makeRenderer();
    if (!renderer) return;
    try {
      const { scene, camera, reflector } = reflectorScene();
      const info = renderer.info as unknown as RenderInfoLike;
      const frame = createFrameStats();
      setActiveFrameStats(frame);

      renderer.info.reset();
      resetFrameStats(frame);
      const c0 = drawCallsOf(info), t0 = info.render.triangles;
      renderer.render(scene, camera);
      addDelta(frame.scene, info, c0, t0);
      finalizeFrameStats(frame, info);

      // Scene pass: 3 boxes + the mirror plane itself = 4 draws / 36 + 2 tris.
      expect(frame.scene.calls).toBe(4);
      expect(frame.scene.triangles).toBe(38);
      // Mirror render (onBeforeRender, blur off): the 3 boxes once more; the
      // Reflector hides itself during its inner render, the checker is hidden
      // by our wrapper.
      expect(frame.reflection.calls).toBe(3);
      expect(frame.reflection.triangles).toBe(36);
      expect(frame.total.calls).toBe(7);
      expect(frame.total.calls).toBe(sumBuckets(frame));
      expect(frame.other.calls).toBe(0);

      // Hidden mirror → nothing nested, scene is back to the 3 boxes.
      reflector.visible = false;
      renderer.info.reset();
      resetFrameStats(frame);
      const c1 = drawCallsOf(info), t1 = info.render.triangles;
      renderer.render(scene, camera);
      addDelta(frame.scene, info, c1, t1);
      finalizeFrameStats(frame, info);
      expect(frame.scene.calls).toBe(3);
      expect(frame.reflection.calls).toBe(0);

      // Without an active frame the reflector still renders, just unbooked.
      setActiveFrameStats(null);
      reflector.visible = true;
      renderer.info.reset();
      resetFrameStats(frame);
      renderer.render(scene, camera);
      expect(info.render.calls).toBe(7);
      expect(frame.reflection.calls).toBe(0);

      // Render-target census: mirror + 2 blur targets.
      expect(getReflectorRenderTargets(reflector).length).toBe(3);
      expect(countRenderTargets(null, null, getReflectorRenderTargets(reflector))).toBe(3);
      expect(countRenderTargets(null, null)).toBe(0);
      reflector.dispose();
    } finally {
      renderer.dispose();
    }
  });

  it('composer + OutlinePass: the mirror fires in the RenderPass AND the outline depth pass, neither bucket keeps the mirror draws', () => {
    const renderer = makeRenderer();
    if (!renderer) return;
    try {
      const { scene, camera, meshes, reflector } = reflectorScene();
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const outline = new OutlinePass(new Vector2(64, 64), scene, camera);
      outline.selectedObjects = [meshes[1]];
      composer.addPass(outline);
      composer.addPass(new OutputPass());
      const info = renderer.info as unknown as RenderInfoLike;
      const frame = createFrameStats();
      setActiveFrameStats(frame);

      const renderFrame = () => {
        renderer.info.reset();
        resetFrameStats(frame);
        instrumentComposerPasses(composer.passes, info, frame, [null]);
        composer.render();
        finalizeFrameStats(frame, info);
      };

      // Baseline: mirror hidden.
      reflector.visible = false;
      renderFrame();
      const outlineBase = frame.outline.calls;
      const postBase = frame.post.calls;
      expect(frame.scene.calls).toBe(3);
      expect(frame.reflection.calls).toBe(0);

      // Mirror visible: the RenderPass (3 boxes + plane) triggers a mirror
      // render of the 3 boxes; the OutlinePass depth pass renders the full
      // scene with an overrideMaterial — onBeforeRender fires again — but it
      // hides the SELECTED object first, so that mirror render draws 2 boxes.
      // The mask pass hides every non-selected object (the mirror included),
      // so the mirror does not fire a third time. 3 + 2 = 5 draws, 60 tris.
      reflector.visible = true;
      renderFrame();
      expect(frame.scene.calls).toBe(4);
      expect(frame.scene.triangles).toBe(38);
      expect(frame.reflection.calls).toBe(5);
      expect(frame.reflection.triangles).toBe(60);
      // Outline grows by exactly the plane's own depth draw — no mirror draws.
      expect(frame.outline.calls).toBe(outlineBase + 1);
      expect(frame.post.calls).toBe(postBase);
      expect(frame.total.calls).toBe(renderer.info.render.calls);
      expect(frame.total.calls).toBe(sumBuckets(frame));
      expect(frame.other.calls).toBe(0);

      // Composer's two + OutlinePass buffers + the reflector's three.
      const withoutReflector = countRenderTargets(composer, null);
      expect(countRenderTargets(composer, null, getReflectorRenderTargets(reflector))).toBe(withoutReflector + 3);
      reflector.dispose();
    } finally {
      renderer.dispose();
    }
  });

  it('after the frame is closed and detached, out-of-loop renders (reflector + shadow map) book NOTHING', () => {
    const renderer = makeRenderer();
    if (!renderer) return;
    try {
      const { scene, camera } = reflectorScene();
      const info = renderer.info as unknown as RenderInfoLike;
      const frame = createFrameStats();
      instrumentShadowMap(renderer.shadowMap as unknown as { render: (...a: unknown[]) => void }, info, frame);

      // One complete frame, the way the viewer does it.
      setActiveFrameStats(frame);
      renderer.info.reset();
      resetFrameStats(frame);
      const c0 = drawCallsOf(info), t0 = info.render.triangles;
      renderer.render(scene, camera);
      addDelta(frame.scene, info, c0, t0);
      finalizeFrameStats(frame, info);
      setActiveFrameStats(null);
      expect(frame.reflection.calls).toBe(3);
      expect(frame.scene.calls).toBe(4);
      const snapshot = JSON.parse(JSON.stringify(frame)) as FrameStats;

      // Out-of-loop renders: a direct scene render with the visible mirror
      // (the web_status drawTest probe / a screenshot) and a forced shadow
      // map pass. The counters keep running, the closed frame must not move.
      renderer.render(scene, camera);
      renderer.render(scene, camera);
      (renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = true;
      renderer.shadowMap.render([], scene, camera);
      expect(info.render.calls).toBeGreaterThan(snapshot.total.calls);
      expect(frame).toEqual(snapshot);
      expect(frame.scene.calls).toBe(4);
      expect(frame.reflection.calls).toBe(3);
    } finally {
      renderer.dispose();
    }
  });
});

describe('RVViewer.getRendererInfo().frame', () => {
  let handle: TestViewerHandle | null = null;
  afterEach(() => { handle?.dispose(); handle = null; });

  it('is reference-stable across frames and reports scene draw calls', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    for (let i = 0; i < 3; i++) {
      const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0x00ff00 }));
      m.position.set(i * 2 - 2, 0, 0);
      viewer.scene.add(m);
    }
    viewer.renderFrameForCapture();
    const first = viewer.getRendererInfo();
    const frameRef = first.frame;
    expect(frameRef.scene.calls).toBeGreaterThanOrEqual(3);
    expect(first.drawCalls).toBe(frameRef.scene.calls);
    expect(first.triangles).toBe(frameRef.scene.triangles);
    expect(frameRef.total.calls).toBe(sumBuckets(frameRef));
    expect(frameRef.total.calls).toBeGreaterThanOrEqual(frameRef.scene.calls);

    viewer.renderFrameForCapture();
    const second = viewer.getRendererInfo();
    expect(second.frame).toBe(frameRef); // no per-frame allocation
    expect(second.frame.scene.calls).toBeGreaterThanOrEqual(3);
    expect(second.frame.total.calls).toBe(sumBuckets(second.frame));
    expect(typeof second.renderTargets).toBe('number');
    expect(second.bake.instances).toBe(0);
  });

  it('is not mutated by a direct renderer.render outside the loop (drawTest probe / screenshot)', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    for (let i = 0; i < 3; i++) {
      const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0x00ff00 }));
      m.position.set(i * 2 - 2, 0, 0);
      viewer.scene.add(m);
    }
    viewer.renderFrameForCapture();
    const frame = viewer.getRendererInfo().frame;
    expect(frame.scene.calls).toBeGreaterThanOrEqual(3);
    const snapshot = JSON.parse(JSON.stringify(frame)) as FrameStats;

    // What web_status' drawTest probe does: render the scene directly,
    // several times, with the frame closed. The last frame must stay as is.
    for (let i = 0; i < 3; i++) viewer.renderer.render(viewer.scene, viewer.camera);
    expect(viewer.getRendererInfo().frame).toBe(frame);
    expect(frame).toEqual(snapshot);
  });
});
