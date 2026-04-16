// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Vector3 } from 'three';
import { CameraStartPosPlugin } from '../src/plugins/camera-startpos-plugin';
import { saveStartPos } from '../src/core/hmi/camera-startpos-store';

describe('CameraStartPosPlugin — FPV guard', () => {
  beforeEach(() => localStorage.clear());

  it('does NOT animate when FPV plugin reports active', () => {
    saveStartPos('FPVTest', { px: 1, py: 1, pz: 1, tx: 0, ty: 1, tz: 0 });
    const viewer = {
      pendingModelUrl: '/models/FPVTest.glb', currentModelUrl: '/models/FPVTest.glb',
      camera: { position: new Vector3() }, controls: { target: new Vector3() },
      scene: { children: [] },
      animateCameraTo: vi.fn(), cancelCameraAnimation: vi.fn(),
      getPlugin: vi.fn().mockImplementation(id => id === 'fpv' ? { isActive: true } : undefined),
    } as any;
    new CameraStartPosPlugin().onModelLoaded({} as any, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });

  it('animates normally when FPV plugin absent', () => {
    saveStartPos('NoFPV', { px: 1, py: 1, pz: 1, tx: 0, ty: 1, tz: 0 });
    const viewer = {
      pendingModelUrl: '/models/NoFPV.glb', currentModelUrl: '/models/NoFPV.glb',
      camera: { position: new Vector3() }, controls: { target: new Vector3() },
      scene: { children: [] },
      animateCameraTo: vi.fn(), cancelCameraAnimation: vi.fn(),
      getPlugin: vi.fn().mockReturnValue(undefined),
    } as any;
    new CameraStartPosPlugin().onModelLoaded({} as any, viewer);
    expect(viewer.animateCameraTo).toHaveBeenCalled();
  });
});
