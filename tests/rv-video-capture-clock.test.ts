// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-537 F1 / F1b / F2e / F5b / F9 — the capture clock inside RVViewer:
 * render-time ticks see exactly 1/fps; wall-clock effects (camera animation,
 * follow, pulsing outlines) are SUSPENDED during a capture and come back
 * afterwards; the live loop resumes; the warmup edge case; the preflight of
 * unsupported states; and "no wall clock": real waiting between frames does
 * not change a single camera matrix or sim time.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Box3, Quaternion, Vector3 } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { loadVideoFixture, SLIDE_PATH } from './helpers/video-capture-fixture';
import { recordVideo, type VideoRecordOptions } from '../src/core/engine/rv-video-capture';
import type { RVViewer } from '../src/core/rv-viewer';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import type { FollowSource } from '../src/core/engine/rv-follow-source';

let handle: TestViewerHandle;
let viewer: RVViewer;

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: 400, height: 300 });
  viewer = handle.viewer;
  await loadVideoFixture(viewer);
}, 120_000);

afterAll(() => handle?.dispose());

beforeEach(() => viewer.resetSimulation());

const SMALL: VideoRecordOptions = {
  width: 320, height: 240, fps: 30, seconds: 0.5, warmupSeconds: 0.25, quality: 'standard',
  path: { kind: 'fixed' },
};

function loopRunning(v: RVViewer): boolean {
  return (v as unknown as { loop: { running: boolean } }).loop.running;
}

describe('capture clock (F1)', () => {
  it('render-time ticks receive exactly 1/fps during a capture; the live loop renders again afterwards', async () => {
    const dts: number[] = [];
    let capturing = false;
    let liveFrames = 0;
    const probe: RVViewerPlugin = {
      id: 'video-clock-probe',
      onRender: (dt: number) => { if (capturing) dts.push(dt); else liveFrames++; },
    } as RVViewerPlugin;
    viewer.use(probe);
    try {
      await recordVideo(viewer, {
        ...SMALL,
        onProgress: () => { capturing = true; },
      });
      capturing = false;
      // frames 1..14 rendered after the first onProgress flipped the flag
      expect(dts.length).toBeGreaterThanOrEqual(14);
      for (const dt of dts) expect(dt).toBe(1 / 30);
      liveFrames = 0;
      await new Promise((r) => setTimeout(r, 300));
      expect(liveFrames).toBeGreaterThan(0);
      expect(loopRunning(viewer)).toBe(true);
    } finally {
      viewer.removePlugin('video-clock-probe');
    }
  }, 60_000);

  it('a running camera animation is suspended (path owns the camera) and resumes afterwards', async () => {
    const far = viewer.camera.position.clone().add(new Vector3(30, 30, 30));
    viewer.animateCameraTo(far, new Vector3(0, 0, 0), 5);
    expect(viewer.isCameraAnimating).toBe(true);
    const posDuring: Vector3[] = [];
    await recordVideo(viewer, { ...SMALL, onProgress: () => { posDuring.push(viewer.camera.position.clone()); } });
    // fixed path → the camera never moved during the capture
    for (const p of posDuring) expect(p.distanceTo(posDuring[0])).toBeLessThan(1e-9);
    expect(viewer.isCameraAnimating).toBe(true);
    (viewer as unknown as { _cameraManager: { cancelCameraAnimation(): void } })._cameraManager.cancelCameraAnimation();
  }, 60_000);

  it('follow mode and a pulsing outline are suspended during the capture and restored afterwards', async () => {
    const node = viewer.registry!.getNode(SLIDE_PATH)!;
    const src: FollowSource = {
      label: 'slide',
      getWorldPosition: (o: Vector3) => { node.getWorldPosition(o); },
      getWorldQuaternion: (o: Quaternion) => { node.getWorldQuaternion(o); },
      getBounds: (o: Box3) => { o.setFromObject(node); },
      isAlive: () => true,
    };
    viewer.startCameraFollow(src);
    viewer.outlineManager.setStatusStyle({ pulsePeriod: 0.6 });
    viewer.outlineManager.setStatusOutlined([node]);
    expect(viewer.cameraFollowMode).toBe('follow');
    expect(viewer.outlineManager.hasPulsingOutlines).toBe(true);
    const camDuring: Vector3[] = [];
    let pulsingDuring = true;
    try {
      await recordVideo(viewer, {
        ...SMALL,
        onProgress: () => {
          camDuring.push(viewer.camera.position.clone());
          pulsingDuring = viewer.outlineManager.hasPulsingOutlines;
        },
      });
      // the slide moved, but the follow did not drag the camera along
      for (const p of camDuring) expect(p.distanceTo(camDuring[0])).toBeLessThan(1e-9);
      expect(pulsingDuring).toBe(false);
      expect(viewer.cameraFollowMode).toBe('follow');
      expect(viewer.outlineManager.hasPulsingOutlines).toBe(true);
      expect(viewer.outlineManager.getStatusStyle().pulsePeriod).toBe(0.6);
    } finally {
      viewer.stopCameraFollow(false);
      viewer.outlineManager.clearStatus();
      viewer.outlineManager.setStatusStyle({ pulsePeriod: 0 });
    }
  }, 60_000);
});

describe('time model edge case (F2e)', () => {
  it('warmupSeconds = 1/60 at 30 fps is exactly one fixed step', async () => {
    const t0 = viewer.simTime;
    const r = await recordVideo(viewer, { ...SMALL, warmupSeconds: 1 / 60 });
    expect(r.warmupSteps).toBe(1);
    expect(r.simStart - t0).toBeCloseTo(1 / 60, 12);
    expect(r.simEnd - r.simStart).toBeCloseTo(0.5, 12);
  }, 60_000);
});

describe('preflight (F1b)', () => {
  const expectUntouched = async (fn: () => void, undo: () => void, msg: RegExp) => {
    const pos = viewer.camera.position.clone();
    const w = (viewer.renderer.domElement as HTMLCanvasElement).width;
    fn();
    try {
      await expect(recordVideo(viewer, SMALL)).rejects.toThrow(msg);
      expect(viewer.isCapturing).toBe(false);
      expect(loopRunning(viewer)).toBe(true);
      expect(viewer.camera.position.equals(pos)).toBe(true);
      expect((viewer.renderer.domElement as HTMLCanvasElement).width).toBe(w);
    } finally {
      undo();
    }
  };

  it('DES mode → clear error, viewer untouched', async () => {
    const v = viewer as unknown as { _kernel: { mode: string } | null };
    const saved = v._kernel;
    await expectUntouched(
      () => { v._kernel = { ...(saved as object), mode: 'des' } as { mode: string }; },
      () => { v._kernel = saved; },
      /DES mode/,
    );
  });

  it('logic not active → clear error', async () => {
    const v = viewer as unknown as { logicRunState: string };
    await expectUntouched(() => { v.logicRunState = 'gated'; }, () => { v.logicRunState = 'active'; }, /logic is not active/);
  });

  it('multiuser follower → clear error', async () => {
    const tm = viewer.transportManager!;
    await expectUntouched(() => { tm.preplacedActivationBlocked = true; }, () => { tm.preplacedActivationBlocked = false; }, /multiuser/);
  });

  it('no model → clear error', async () => {
    const h = await createTestViewer('webgl', { width: 200, height: 150 });
    try {
      await expect(recordVideo(h.viewer, SMALL)).rejects.toThrow(/No model/);
      expect(h.viewer.isCapturing).toBe(false);
    } finally {
      h.dispose();
    }
  }, 60_000);

  it('WebGPU renderer → clear error', async () => {
    // Unit-level: a real 'webgpu-gl' viewer init is flaky under a loaded
    // headless run; the preflight only reads the renderer-family flag.
    const v = viewer as unknown as { isWebGPU: boolean };
    const own = Object.getOwnPropertyDescriptor(v, 'isWebGPU');
    await expectUntouched(
      () => { Object.defineProperty(v, 'isWebGPU', { value: true, configurable: true, writable: true }); },
      () => { if (own) Object.defineProperty(v, 'isWebGPU', own); },
      /WebGL renderer/,
    );
  });
});

describe('no wall clock (F1/F5b/F9)', () => {
  it('slow vs fast real waiting between frames → identical camera matrices and sim times per frame', async () => {
    const run = async (waitMs: (i: number) => number) => {
      viewer.resetSimulation();
      const base = viewer.simTime;
      const mats: number[][] = [];
      const sims: number[] = [];
      await recordVideo(viewer, {
        ...SMALL,
        path: { kind: 'orbit', sweepDeg: 90, easing: 'inOut' },
        onProgress: async (i) => {
          const cam = viewer.camera;
          mats.push([...cam.matrixWorld.elements, ...cam.projectionMatrix.elements]);
          sims.push(viewer.simTime - base);
          const ms = waitMs(i);
          if (ms > 0) await new Promise((r) => setTimeout(r, ms));
        },
      });
      return { mats, sims };
    };
    const fast = await run(() => 0);
    const slow = await run((i) => (i % 3 === 0 ? 35 : 5));
    expect(slow.mats.length).toBe(15);
    expect(slow.sims).toEqual(fast.sims);
    slow.mats.forEach((m, i) => m.forEach((e, k) => expect(e).toBeCloseTo(fast.mats[i][k], 9)));
    // the orbit really moved the camera
    expect(fast.mats[0][12]).not.toBeCloseTo(fast.mats[14][12], 3);
  }, 60_000);
});
