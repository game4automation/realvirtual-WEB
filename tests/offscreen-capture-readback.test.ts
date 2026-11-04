// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * offscreen-capture-readback.test.ts — plan-763 Phase 1 (browser).
 *
 * The one readback helper behind every capture tool is exercised on BOTH
 * renderer families headless can run: the classic WebGLRenderer (synchronous
 * path, unchanged) and a WebGPURenderer on its WebGL backend (`webgpu-gl`,
 * async path, GL row order, no padding). The real WebGPU backend needs an
 * adapter and is covered by the Node test of `unpadRows` plus the manual
 * real-adapter gate.
 *
 * What is pinned:
 *  - rows come back TOP-DOWN on both renderers (a marker at the top-left of
 *    the picture lands at index 0);
 *  - two readbacks issued back to back into the same target keep their own
 *    pixels (per-call buffers, the second render does not overwrite the first
 *    result);
 *  - a width that is not a multiple of 64 px is read back correctly;
 *  - disposing the capture while a read is in flight neither throws nor
 *    corrupts the result.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  type WebGLRenderer,
} from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { OffscreenCapture } from '../src/core/engine/rv-offscreen-capture';
import type { RendererKind } from '../src/core/rv-viewer';

const VIEWER_TEST_TIMEOUT = 90_000;
const W = 50; // deliberately not a multiple of 64
const H = 40;

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

/** A red plane in the TOP-LEFT quadrant on a dark background, ortho camera. */
function markerScene(color: number): { scene: Scene; camera: OrthographicCamera } {
  const scene = new Scene();
  scene.background = new Color(0x101010);
  const quad = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color }));
  quad.position.set(-0.5, 0.5, 0); // top-left quadrant of a [-1,1] frame
  scene.add(quad);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  return { scene, camera };
}

function px(buf: Uint8Array, x: number, y: number): [number, number, number] {
  const o = (y * W + x) * 4;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

for (const kind of ['webgl', 'webgpu-gl'] as RendererKind[]) {
  describe(`offscreen readback on ${kind} (plan-763)`, () => {
    it('returns top-down rows and keeps two back-to-back readbacks apart', async () => {
      handle = await createTestViewer(kind);
      const { viewer } = handle;
      const renderer = viewer.renderer as unknown as WebGLRenderer;
      const capture = new OffscreenCapture(() => renderer);
      expect(capture.guard('test')).toBeNull();

      const red = markerScene(0xff0000);
      const green = markerScene(0x00ff00);
      try {
        // Both reads are ISSUED inside their passes and awaited together —
        // the second render reuses the target while the first copy is queued.
        const readRed = capture.withPass(
          { width: W, height: H, scene: red.scene, camera: red.camera },
          (ctx) => { renderer.render(red.scene, red.camera); return capture.readPixels(ctx.target, ctx.width, ctx.height); },
        );
        const readGreen = capture.withPass(
          { width: W, height: H, scene: green.scene, camera: green.camera },
          (ctx) => { renderer.render(green.scene, green.camera); return capture.readPixels(ctx.target, ctx.width, ctx.height); },
        );
        expect(renderer.getRenderTarget()).toBeNull(); // state restored before any await
        const [a, b] = await Promise.all([readRed, readGreen]);

        // Top-left (row 1 to stay clear of the edge) is the marker, bottom-right the background.
        expect(px(a, 2, 1)[0], `red marker top-left, got ${px(a, 2, 1)}`).toBeGreaterThan(200);
        expect(px(a, 2, 1)[1]).toBeLessThan(40);
        expect(px(a, W - 3, H - 2)[0], 'background bottom-right').toBeLessThan(40);
        // The second read did not overwrite the first: a stays red, b is green.
        expect(px(b, 2, 1)[1], `green marker, got ${px(b, 2, 1)}`).toBeGreaterThan(200);
        expect(px(b, 2, 1)[0]).toBeLessThan(40);
        expect(px(a, 2, 1)[0]).toBeGreaterThan(200);
        // Row order check on the LAST row too: background, never the marker.
        expect(px(a, 2, H - 1)[0]).toBeLessThan(40);
      } finally {
        capture.dispose();
      }
    }, VIEWER_TEST_TIMEOUT);

    it('survives dispose while a readback is in flight', async () => {
      handle = await createTestViewer(kind);
      const { viewer } = handle;
      const renderer = viewer.renderer as unknown as WebGLRenderer;
      const capture = new OffscreenCapture(() => renderer);
      const red = markerScene(0xff0000);
      const read = capture.withPass(
        { width: W, height: H, scene: red.scene, camera: red.camera },
        (ctx) => { renderer.render(red.scene, red.camera); return capture.readPixels(ctx.target, ctx.width, ctx.height); },
      );
      capture.dispose(); // the copy was enqueued before; the result must still arrive
      const a = await read;
      expect(a.length).toBe(W * H * 4);
      expect(px(a, 2, 1)[0]).toBeGreaterThan(200);
    }, VIEWER_TEST_TIMEOUT);
  });
}
