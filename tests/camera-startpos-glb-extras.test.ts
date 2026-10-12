// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { CameraStartPosPlugin } from '../src/plugins/camera-startpos-plugin';
import { saveStartPos } from '../src/core/hmi/camera-startpos-store';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';
import { setSceneCamera } from '../src/core/engine/rv-asset-reference';
import { readCameraStartFromScene } from '../src/core/hmi/scene/rv-scene-glb-read';

function mockViewerWithSceneExtras(url: string, extras: any): RVViewer {
  return {
    pendingModelUrl: url, currentModelUrl: url,
    camera: { position: new Vector3() } as any,
    controls: { target: new Vector3() } as any,
    scene: { children: [{ userData: { realvirtual: extras } }] } as any,
    animateCameraTo: vi.fn(),
    cancelCameraAnimation: vi.fn(),
    getPlugin: vi.fn().mockReturnValue(undefined),
  } as unknown as RVViewer;
}

describe('CameraStartPosPlugin — GLB rv_extras via viewer.scene', () => {
  beforeEach(() => localStorage.clear());

  it('reads author default from rv_camera_start (Unity LHS → glTF RHS, X negated)', () => {
    const viewer = mockViewerWithSceneExtras('/models/Author.glb', {
      rv_camera_start: {
        CameraTransformPos: { x: 2, y: 3, z: 4 },
        TargetPos:          { x: 1, y: 0, z: 0 },
      },
    });
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    const [pos, tgt] = (viewer.animateCameraTo as any).mock.calls[0];
    expect(pos.toArray()).toEqual([-2, 3, 4]);
    expect(tgt.toArray()).toEqual([-1, 0, 0]);
  });

  it('uses LOWERCASE userData.realvirtual key (not REALVIRTUAL)', () => {
    // Uppercase key — must NOT be recognized
    const viewer = mockViewerWithSceneExtras('/models/Upper.glb', {}) as any;
    viewer.scene.children[0].userData = {
      REALVIRTUAL: { rv_camera_start: {
        CameraTransformPos: { x: 2, y: 3, z: 4 },
        TargetPos:          { x: 1, y: 0, z: 0 },
      }},
    };
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });

  it('LocalStorage preset takes priority over GLB extras', () => {
    saveStartPos('Prio', { px: 99, py: 99, pz: 99, tx: 0, ty: 1, tz: 0 });
    const viewer = mockViewerWithSceneExtras('/models/Prio.glb', {
      rv_camera_start: {
        CameraTransformPos: { x: 1, y: 1, z: 1 },
        TargetPos: { x: 0, y: 0, z: 0 },
      },
    });
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect((viewer.animateCameraTo as any).mock.calls[0][0].toArray()).toEqual([99, 99, 99]);
  });

  it('ignores malformed rv_camera_start gracefully', () => {
    const viewer = mockViewerWithSceneExtras('/models/Broken.glb', { rv_camera_start: { foo: 'bar' } });
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });

  it('REJECTS array format [x,y,z] (via Array.isArray check)', () => {
    const viewer = mockViewerWithSceneExtras('/models/Arr.glb', {
      rv_camera_start: {
        CameraTransformPos: [1, 2, 3],
        TargetPos:          [0, 0, 0],
      },
    });
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });

  it('REJECTS NaN in GLB extras', () => {
    const viewer = mockViewerWithSceneExtras('/models/Nan.glb', {
      rv_camera_start: {
        CameraTransformPos: { x: NaN, y: 0, z: 0 },
        TargetPos:          { x: 0, y: 1, z: 0 },
      },
    });
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });

  it('REJECTS Infinity in GLB extras', () => {
    const viewer = mockViewerWithSceneExtras('/models/Inf.glb', {
      rv_camera_start: {
        CameraTransformPos: { x: Infinity, y: 0, z: 0 },
        TargetPos:          { x: 0, y: 1, z: 0 },
      },
    });
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });

  it('scans multiple scene children to find extras', () => {
    const viewer = {
      pendingModelUrl: '/models/Multi.glb', currentModelUrl: '/models/Multi.glb',
      camera: { position: new Vector3() },
      controls: { target: new Vector3() },
      scene: { children: [
        { userData: {} }, // Light-like node
        { userData: { realvirtual: { rv_camera_start: {
          CameraTransformPos: { x: -1, y: 2, z: 3 }, TargetPos: { x: 0, y: 0, z: 0 },
        }}}},
      ]},
      animateCameraTo: vi.fn(),
      cancelCameraAnimation: vi.fn(),
      getPlugin: vi.fn().mockReturnValue(undefined),
    } as any;
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).toHaveBeenCalledOnce();
  });
});

// plan-498 Nachkorrektur: the document's own `SceneCamera` (scenes[0].extras on
// the model root) must apply on the FIRST open — before SceneStore's adoption has
// copied it into localStorage, which only happens after onModelLoaded.
describe('CameraStartPosPlugin — SceneCamera from the model root', () => {
  beforeEach(() => localStorage.clear());

  const FILE_CAM = { px: 5, py: 6, pz: 7, tx: 1, ty: 2, tz: 3, duration: 0.5, source: 'user' as const };

  function viewerWithSceneCamera(url: string, rvCameraStart?: unknown): RVViewer {
    const root = new Object3D();
    setSceneCamera(root, FILE_CAM);
    const viewer = mockViewerWithSceneExtras(url, rvCameraStart ? { rv_camera_start: rvCameraStart } : {});
    (viewer as unknown as { currentModelRoot: Object3D }).currentModelRoot = root;
    return viewer;
  }

  it('applies the file SceneCamera on the first open (empty browser storage)', () => {
    const viewer = viewerWithSceneCamera('/models/FirstOpen.glb');
    const plugin = new CameraStartPosPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).toHaveBeenCalledOnce();
    const [pos, tgt, duration] = (viewer.animateCameraTo as any).mock.calls[0];
    expect(pos.toArray()).toEqual([5, 6, 7]);
    expect(tgt.toArray()).toEqual([1, 2, 3]);
    expect(duration).toBe(0.5);
    // The loader asks the same question to decide against fit-to-content.
    expect(plugin.resolvePreset(viewer)).toMatchObject({ px: 5, tx: 1 });
  });

  it('a camera the user saved in this browser beats the file SceneCamera', () => {
    saveStartPos('BrowserWins', { px: 99, py: 98, pz: 97, tx: 0, ty: 1, tz: 0 });
    const viewer = viewerWithSceneCamera('/models/BrowserWins.glb');
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    const [pos] = (viewer.animateCameraTo as any).mock.calls[0];
    expect(pos.toArray()).toEqual([99, 98, 97]);
  });

  it('the file SceneCamera beats the Unity rv_camera_start author default', () => {
    const viewer = viewerWithSceneCamera('/models/FileBeatsUnity.glb', {
      CameraTransformPos: { x: 2, y: 3, z: 4 },
      TargetPos:          { x: 1, y: 0, z: 0 },
    });
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    const [pos] = (viewer.animateCameraTo as any).mock.calls[0];
    expect(pos.toArray()).toEqual([5, 6, 7]);
  });

  it('the later adoption (localStorage copy) resolves to the same preset and animates nothing', () => {
    const viewer = viewerWithSceneCamera('/models/Adopt.glb');
    const plugin = new CameraStartPosPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    const before = plugin.resolvePreset(viewer);
    // What SceneStore._adoptFromLoadedGlb does after onModelLoaded.
    const root = (viewer as unknown as { currentModelRoot: Object3D }).currentModelRoot;
    saveStartPos('Adopt', readCameraStartFromScene(root)!);
    expect(plugin.resolvePreset(viewer)).toMatchObject({
      px: before!.px, py: before!.py, pz: before!.pz, tx: before!.tx, ty: before!.ty, tz: before!.tz,
    });
    expect(viewer.animateCameraTo).toHaveBeenCalledOnce();
  });

  it('ignores a SceneCamera with a non-finite coordinate', () => {
    const root = new Object3D();
    root.userData.realvirtual = { SceneCamera: { px: NaN, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 } };
    const viewer = mockViewerWithSceneExtras('/models/NaNCam.glb', {});
    (viewer as unknown as { currentModelRoot: Object3D }).currentModelRoot = root;
    new CameraStartPosPlugin().onModelLoaded({} as LoadResult, viewer);
    expect(viewer.animateCameraTo).not.toHaveBeenCalled();
  });
});
