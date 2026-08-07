// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * dissolve-pipeflow-baseline.test.ts — plan-271 test 9.7 (integration,
 * browser, F10 harness).
 *
 * GLSL reference behavior captured BEFORE the TSL ports — and, parametrized
 * over both renderer kinds, the SAME assertions serve as the TSL PARITY test
 * after the ports (plan-271 Phase 2):
 *
 *  - MU dissolve (VANISH): progress 0 → object visible, progress 1 → fully
 *    discarded (async pixel readback); dispose() restores the original look.
 *  - Dissolve clone-per-MU: two dissolve instances never share uniforms —
 *    driving one MU to progress 1 must not affect the other.
 *  - Pipe flow: `update(dt)` accumulates the time uniform EXCLUSIVELY from
 *    the dt argument (SimulationLoop time base) — never wall-clock
 *    (plan-271 review finding 5; pause determinism).
 *
 * kinds: 'webgl' (GLSL baseline) and 'webgpu-gl' (TSL variant on
 * WebGPURenderer's WebGL2 backend). Real 'webgpu' needs local hardware and is
 * covered by the local compute/parity suites, not CI.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  Scene,
  WebGLRenderTarget,
  type Camera,
} from 'three';
import {
  createTestViewer,
  readRenderTargetPixelsAsync,
  type TestViewerHandle,
} from './helpers/create-test-viewer';
import { createMUDissolve } from '../src/core/engine/rv-mu-dissolve';
import { PipeFlowManager } from '../src/core/engine/rv-pipe-flow';

const VIEWER_TEST_TIMEOUT = 60_000;
const RT_SIZE = 64;

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

interface AsyncRenderer {
  setRenderTarget(t: unknown): void;
  render(scene: Scene, camera: Camera): void;
}

/** Render into a target. Both families accept plain render() after the
 *  init() that RVViewer.create() already awaited (renderAsync is deprecated). */
function renderTo(
  renderer: AsyncRenderer,
  rt: WebGLRenderTarget,
  scene: Scene,
  camera: Camera,
): void {
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
}

function rgbSumAt(buf: Uint8Array, x: number, y: number): number {
  const o = (y * RT_SIZE + x) * 4;
  return buf[o] + buf[o + 1] + buf[o + 2];
}

/** Lit test scene on black background with an ortho camera at z=5. */
function makeScene(): { scene: Scene; camera: OrthographicCamera } {
  const scene = new Scene();
  scene.background = new Color(0x000000);
  scene.add(new AmbientLight(0xffffff, 1.2));
  const sun = new DirectionalLight(0xffffff, 2.0);
  sun.position.set(0.3, 0.4, 1);
  scene.add(sun);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  return { scene, camera };
}

function makeBox(x: number): Mesh {
  const mesh = new Mesh(
    new BoxGeometry(0.8, 0.8, 0.2),
    new MeshStandardMaterial({ color: 0xff2222, roughness: 1, metalness: 0 }),
  );
  mesh.position.set(x, 0, 0);
  mesh.updateMatrixWorld(true);
  return mesh;
}

for (const kind of ['webgl', 'webgpu-gl'] as const) {
  const label = kind === 'webgl' ? 'GLSL baseline' : 'TSL parity';

  describe(`MU dissolve — ${label} (${kind})`, () => {
    it('progress 0 → visible, progress 1 → discarded, dispose() restores', async () => {
      handle = await createTestViewer(kind);
      const { viewer } = handle;
      const { scene, camera } = makeScene();
      const mesh = makeBox(0);
      scene.add(mesh);
      mesh.updateMatrixWorld(true);

      const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
      const renderer = viewer.renderer as unknown as AsyncRenderer;

      // World-Y bounds of the box (centered at origin, height 0.8)
      const dissolve = createMUDissolve(mesh, -0.4, 0.4, viewer.isWebGPU);

      dissolve.setProgress(0);
      renderTo(renderer, rt, scene, camera);
      let px = await readRenderTargetPixelsAsync(viewer, rt);
      expect(rgbSumAt(px, 32, 32), 'progress 0: box must be visible').toBeGreaterThan(30);

      dissolve.setProgress(1);
      renderTo(renderer, rt, scene, camera);
      px = await readRenderTargetPixelsAsync(viewer, rt);
      expect(rgbSumAt(px, 32, 32), 'progress 1: box must be fully discarded').toBeLessThan(10);

      // dispose() must restore the original (undissolved) material.
      dissolve.dispose();
      renderTo(renderer, rt, scene, camera);
      px = await readRenderTargetPixelsAsync(viewer, rt);
      expect(rgbSumAt(px, 32, 32), 'after dispose: original material restored').toBeGreaterThan(30);

      rt.dispose();
    }, VIEWER_TEST_TIMEOUT);

    it('two dissolve instances never share uniforms (clone-per-MU)', async () => {
      handle = await createTestViewer(kind);
      const { viewer } = handle;
      const { scene, camera } = makeScene();
      const meshA = makeBox(-0.5);
      const meshB = makeBox(0.5);
      scene.add(meshA, meshB);
      meshA.updateMatrixWorld(true);
      meshB.updateMatrixWorld(true);

      const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
      const renderer = viewer.renderer as unknown as AsyncRenderer;

      const dissolveA = createMUDissolve(meshA, -0.4, 0.4, viewer.isWebGPU);
      const dissolveB = createMUDissolve(meshB, -0.4, 0.4, viewer.isWebGPU);

      // Drive ONLY A to full dissolve — B must stay untouched.
      dissolveA.setProgress(1);
      renderTo(renderer, rt, scene, camera);
      const px = await readRenderTargetPixelsAsync(viewer, rt);
      expect(rgbSumAt(px, 16, 32), 'MU A at progress 1 must be discarded').toBeLessThan(10);
      expect(rgbSumAt(px, 48, 32), 'MU B (progress 0) must stay visible').toBeGreaterThan(30);

      dissolveA.dispose();
      dissolveB.dispose();
      rt.dispose();
    }, VIEWER_TEST_TIMEOUT);
  });

  describe(`pipe flow time base — ${label} (${kind})`, () => {
    it('update(dt) accumulates the time uniform ONLY from dt (no wall-clock)', async () => {
      handle = await createTestViewer(kind);
      const { viewer } = handle;
      const { scene, camera } = makeScene();

      // Minimal pipe: a node whose largest child mesh has UVs (BoxGeometry)
      // and an _rvPipe payload with active flow.
      const pipeNode = new Object3D();
      pipeNode.userData._rvPipe = { flowRate: 1 };
      const pipeMesh = new Mesh(
        new BoxGeometry(1.2, 0.3, 0.3),
        new MeshStandardMaterial({ color: 0x888888 }),
      );
      pipeNode.add(pipeMesh);
      scene.add(pipeNode);
      pipeNode.updateMatrixWorld(true);

      const manager = new PipeFlowManager([pipeNode], viewer.isWebGPU);
      expect(manager.entries.length).toBe(1);
      const entry = manager.entries[0];

      if (kind === 'webgpu-gl') {
        // TSL variant: handles exist immediately, no GLSL shader hook.
        expect(entry.tsl).not.toBeNull();
        expect(entry.shader).toBeNull();
      }

      const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
      const renderer = viewer.renderer as unknown as AsyncRenderer;

      // First update makes the overlay visible; first render compiles the
      // GLSL patch (onBeforeCompile runs at draw → entry.shader appears).
      manager.update(0);
      renderTo(renderer, rt, scene, camera);

      // Let REAL wall-clock time pass between the dt steps — the uniform must
      // reflect the dt SUM only (0.5 + 0.25), not elapsed time.
      manager.update(0.5);
      await new Promise((resolve) => setTimeout(resolve, 60));
      manager.update(0.25);

      const uTime = kind === 'webgpu-gl'
        ? entry.tsl!.uTime.value
        : (entry.shader!.uniforms.uTime.value as number);
      expect(uTime, 'uTime must be exactly the sum of the passed dt values').toBeCloseTo(0.75, 10);

      // The overlay still renders without errors after the updates.
      renderTo(renderer, rt, scene, camera);

      manager.dispose();
      rt.dispose();
    }, VIEWER_TEST_TIMEOUT);
  });
}
