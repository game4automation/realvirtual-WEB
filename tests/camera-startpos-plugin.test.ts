// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vector3 } from 'three';
import {
  CameraStartPosPlugin,
  saveCurrentCameraAsStart, clearCurrentCameraStart, hasCurrentCameraStart,
} from '../src/plugins/camera-startpos-plugin';
import { saveStartPos } from '../src/core/hmi/camera-startpos-store';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

function mockViewer(url: string | null = '/models/T.glb'): RVViewer {
  return {
    pendingModelUrl: url,
    currentModelUrl: url,
    camera: { position: new Vector3() } as any,
    controls: { target: new Vector3() } as any,
    scene: { children: [] } as any,
    animateCameraTo: vi.fn(),
    cancelCameraAnimation: vi.fn(),
    getPlugin: vi.fn().mockReturnValue(undefined),
  } as unknown as RVViewer;
}

describe('CameraStartPosPlugin', () => {
  beforeEach(() => localStorage.clear());

  it('does nothing when no preset exists', () => {
    const plugin = new CameraStartPosPlugin();
    plugin.onModelLoaded({} as LoadResult, mockViewer('/models/NoPreset.glb'));
    const viewer = mockViewer('/models/NoPreset.glb');
    plugin.onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });

  it('calls animateCameraTo with saved preset', () => {
    saveStartPos('HasPreset', { px: 5, py: 6, pz: 7, tx: 1, ty: 2, tz: 3, duration: 0.8 });
    const viewer = mockViewer('/models/HasPreset.glb');
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).toHaveBeenCalledOnce();
    const [pos, tgt, dur] = (viewer.animateCameraTo as any).mock.calls[0];
    expect(pos.toArray()).toEqual([5, 6, 7]);
    expect(tgt.toArray()).toEqual([1, 2, 3]);
    expect(dur).toBe(0.8);
  });

  it('clamps negative duration to 0.05 (via GLB author default path)', () => {
    const viewer = mockViewer('/models/NegDur.glb');
    // GLB author default with duration=-5: isFin(-5) is true → preset.duration=-5
    // clampDuration(-5) = Math.min(60, Math.max(0.05, -5)) = 0.05
    (viewer as any).scene = { children: [{ userData: { realvirtual: { rv_camera_start: {
      CameraTransformPos: { x: -1, y: 0, z: 0 }, TargetPos: { x: 0, y: 1, z: 0 }, duration: -5,
    }}}}] } as any;
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    const [, , dur] = (viewer.animateCameraTo as any).mock.calls[0];
    expect(dur).toBe(0.05);
  });

  it('rejects Infinity duration in GLB extras → defaults to 1.0', () => {
    // Simulate a GLB author-default with duration = Infinity (manipulated GLB).
    // _extractFromScene rejects via isFin → defaults to 1.0 → clamp to 1.0.
    const viewer = mockViewer('/models/InfDur.glb');
    (viewer as any).scene = { children: [{ userData: { realvirtual: { rv_camera_start: {
      CameraTransformPos: { x: -1, y: 0, z: 0 }, TargetPos: { x: 0, y: 1, z: 0 },
      duration: Infinity,
    }}}}] } as any;
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    const [, , dur] = (viewer.animateCameraTo as any).mock.calls[0];
    expect(dur).toBe(1.0); // isFin rejected Infinity → default 1.0
  });

  it('clamps finite duration > MAX_DURATION to 60', () => {
    // Inject finite extreme duration; clampDuration should pin to MAX_DURATION = 60.
    const viewer = mockViewer('/models/HugeDur.glb');
    (viewer as any).scene = { children: [{ userData: { realvirtual: { rv_camera_start: {
      CameraTransformPos: { x: -1, y: 0, z: 0 }, TargetPos: { x: 0, y: 1, z: 0 },
      duration: 120,
    }}}}] } as any;
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    const [, , dur] = (viewer.animateCameraTo as any).mock.calls[0];
    expect(dur).toBe(60);
  });

  it('skips animation when position == target (guard)', () => {
    saveStartPos('Same', { px: 1, py: 2, pz: 3, tx: 1, ty: 2, tz: 3 });
    const viewer = mockViewer('/models/Same.glb');
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });

  it('saveCurrentCameraAsStart persists current camera state', () => {
    const viewer = mockViewer('/models/SaveTest.glb');
    viewer.camera.position.set(10, 20, 30);
    viewer.controls.target.set(1, 2, 3);
    expect(saveCurrentCameraAsStart(viewer)).toBe('ok');
    const raw = localStorage.getItem('rv-camera-start:SaveTest');
    const parsed = JSON.parse(raw!);
    expect(parsed.px).toBe(10);
    expect(parsed.source).toBe('user');
  });

  it('saveCurrentCameraAsStart returns "no-model" when no URL', () => {
    expect(saveCurrentCameraAsStart(mockViewer(null))).toBe('no-model');
  });

  it('saveCurrentCameraAsStart returns "save-failed" on NaN camera state', () => {
    const viewer = mockViewer('/models/NanCam.glb');
    viewer.camera.position.set(NaN, 0, 0);
    expect(saveCurrentCameraAsStart(viewer)).toBe('save-failed');
  });

  it('saveCurrentCameraAsStart returns "save-failed" on quota exceeded', () => {
    const viewer = mockViewer('/models/QuotaTest.glb');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(saveCurrentCameraAsStart(viewer)).toBe('save-failed');
    vi.restoreAllMocks();
  });

  it('clearCurrentCameraStart removes preset', () => {
    saveStartPos('ClearTest', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0 });
    expect(clearCurrentCameraStart(mockViewer('/models/ClearTest.glb'))).toBe(true);
    expect(localStorage.getItem('rv-camera-start:ClearTest')).toBeNull();
  });

  it('hasCurrentCameraStart reflects state', () => {
    const viewer = mockViewer('/models/HasCheck.glb');
    expect(hasCurrentCameraStart(viewer)).toBe(false);
    saveStartPos('HasCheck', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0 });
    expect(hasCurrentCameraStart(viewer)).toBe(true);
  });

  it('hasCurrentCameraStart returns false when no URL', () => {
    expect(hasCurrentCameraStart(mockViewer(null))).toBe(false);
  });

  it('onModelCleared cancels any in-flight tween', () => {
    const viewer = mockViewer();
    new CameraStartPosPlugin().onModelCleared(viewer);
    expect(viewer.cancelCameraAnimation).toHaveBeenCalled();
  });

  it('handles model switch A -> B (uses new key)', () => {
    saveStartPos('ModelA', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0 });
    saveStartPos('ModelB', { px: 9, py: 0, pz: 0, tx: 0, ty: 1, tz: 0 });
    const plugin = new CameraStartPosPlugin();
    const viewerA = mockViewer('/models/ModelA.glb');
    plugin.onModelLoaded({} as LoadResult, viewerA);
    expect((viewerA.animateCameraTo as any).mock.calls[0][0].toArray()[0]).toBe(1);
    const viewerB = mockViewer('/models/ModelB.glb');
    plugin.onModelLoaded({} as LoadResult, viewerB);
    expect((viewerB.animateCameraTo as any).mock.calls[0][0].toArray()[0]).toBe(9);
  });
});
