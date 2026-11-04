// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraStartPosPlugin — Per-model camera start position.
 *
 * On every onModelLoaded:
 *  1. Derive a stable per-model key from the URL/filename.
 *  2. Look for a saved preset in localStorage (user override). Priority 1.
 *  3. Otherwise read the document's own `SceneCamera` from the model root's
 *     scene extras (`scenes[0].extras.realvirtual.SceneCamera`). Priority 2.
 *  4. Otherwise scan viewer.scene.children for `userData.realvirtual.rv_camera_start`
 *     (Unity author default in GLB rv_extras). Priority 3.
 *  5. If a preset exists and FPV is not active, smoothly tween the camera
 *     via viewer.animateCameraTo(). Otherwise: fall through to the engine's
 *     default fit-to-bounds behavior.
 *
 * Defense-in-depth: rejects NaN/Infinity in coordinates AND duration; clamps
 * duration to [0.05, 60] s; refuses to animate when position equals target
 * (would produce a NaN quaternion).
 */

import { Vector3 } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import type { ModelCameraStart } from '../core/hmi/camera-startpos-types';
import {
  loadStartPos, saveStartPos, clearStartPos, hasStartPos,
} from '../core/hmi/camera-startpos-store';
import { CameraStartTab } from '../core/hmi/settings/CameraStartTab';
import { getSceneCamera, cameraStartFromSceneCamera } from '../core/engine/rv-asset-reference';

const EPSILON_POS_EQ_TARGET = 1e-3;
const MIN_DURATION = 0.05;
const MAX_DURATION = 60;

/**
 * Walk the active scene's op log and return the latest `setCamera` preset
 * (or null if there is none / the scene is null). Pure helper.
 */
function extractScenePreset(scene: import('../core/hmi/scene/rv-scene-types').RvScene | null): ModelCameraStart | null {
  if (!scene) return null;
  // Scan back-to-front; the latest setCamera op wins.
  for (let i = scene.edits.ops.length - 1; i >= 0; i--) {
    const op = scene.edits.ops[i];
    if (op.kind === 'setCamera') return op.preset;
    if (op.kind === 'composite') {
      for (let j = op.ops.length - 1; j >= 0; j--) {
        const child = op.ops[j];
        if (child.kind === 'setCamera') return child.preset;
      }
    }
  }
  return null;
}

// The derivation itself lives in `core/engine/rv-model-key.ts` (plan-740 D-A3):
// this module statically imports React/MUI through CameraStartTab, so anything
// under `core/engine/` that needs the key must not reach in here. Re-exported
// unchanged so every existing importer keeps working.
import { deriveModelKey } from '../core/engine/rv-model-key';
export { deriveModelKey };

function isFin(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Clamps duration to safe bounds; defaults to 1.0 if undefined or non-finite. */
function clampDuration(value: number | undefined): number {
  const raw = value ?? 1.0;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, isFin(raw) ? raw : 1.0));
}

// ---- Exported viewer helpers (used by CameraStartTab + external callers) ----

export function saveCurrentCameraAsStart(viewer: RVViewer): 'ok' | 'no-model' | 'save-failed' {
  const key = deriveModelKey(viewer.pendingModelUrl ?? viewer.currentModelUrl);
  if (!key) return 'no-model';
  const p = viewer.camera.position;
  const t = viewer.controls.target;
  // Defensive: skip save if camera somehow has non-finite state.
  if (!isFin(p.x) || !isFin(p.y) || !isFin(p.z) || !isFin(t.x) || !isFin(t.y) || !isFin(t.z)) {
    return 'save-failed';
  }
  const preset: ModelCameraStart = {
    px: p.x, py: p.y, pz: p.z,
    tx: t.x, ty: t.y, tz: t.z,
    duration: 1.0,
    savedAt: Date.now(),
    source: 'user',
  };
  // Capture current preset for undo, then write through executor (via SceneStore op)
  // so the change enters the unified op log alongside overlay edits and placements.
  const prev = loadStartPos(key);
  const ok = saveStartPos(key, preset);
  if (ok) emitCameraOp(preset, prev);
  return ok ? 'ok' : 'save-failed';
}

export function clearCurrentCameraStart(viewer: RVViewer): boolean {
  const key = deriveModelKey(viewer.pendingModelUrl ?? viewer.currentModelUrl);
  if (!key) return false;
  const prev = loadStartPos(key);
  clearStartPos(key);
  emitCameraOp(null, prev);
  return true;
}

/**
 * Push a `setCamera` op into the SceneStore op log so camera saves
 * participate in undo/redo. The executor's forward writes to the same
 * localStorage key (idempotent — value already there from saveStartPos),
 * so this doesn't double-apply.
 */
function emitCameraOp(preset: ModelCameraStart | null, prev: ModelCameraStart | null): void {
  // Lazy import to avoid pulling SceneStore types into this module's surface.
  void Promise.all([
    import('../core/hmi/scene/scene-store-singleton'),
    import('../core/hmi/scene/rv-scene-edits'),
  ]).then(([singleton, edits]) => {
    const sceneStore = singleton.getSceneStore();
    if (!sceneStore) return;
    void sceneStore.applyOp({
      id: edits.freshOpId(), ts: Date.now(), schemaV: 1,
      kind: 'setCamera', preset, prev,
    });
  }).catch(() => { /* SceneStore unavailable; visual state still correct */ });
}

export function hasCurrentCameraStart(viewer: RVViewer): boolean {
  const key = deriveModelKey(viewer.pendingModelUrl ?? viewer.currentModelUrl);
  return !!key && hasStartPos(key);
}

// ---- Plugin class — state-less ----

export class CameraStartPosPlugin implements RVViewerPlugin {
  readonly id = 'camera-startpos';
  readonly core = true;

  readonly slots: UISlotEntry[] = [
    { slot: 'settings-tab', component: CameraStartTab, label: 'Start View', order: 110 },
  ];

  /**
   * Resolve the camera preset that would be applied for the currently loaded
   * model, or null if there is none. Priority order:
   *   0. per-scene `setCamera` op (unified Scene model, latest wins)
   *   1. localStorage user override (per-base default)
   *   2. the document's own `SceneCamera` (scene extras on the model root)
   *   3. GLB rv_extras author default (`rv_camera_start`)
   *
   * The `SceneCamera` is read HERE, not only through the localStorage copy that
   * `SceneStore._adoptFromLoadedGlb` writes: that adoption runs AFTER
   * `onModelLoaded`, so on the very first open of a document the browser had no
   * copy yet and the viewer framed the bounds instead (plan-498 Nachkorrektur).
   * The adoption only stores the value; it never animates, so nothing jumps twice.
   *
   * Public + side-effect-free so the loader (RVViewer.loadScene) can tell
   * whether a preset already positioned the camera before deciding to fall
   * back to fit-to-content framing.
   */
  resolvePreset(viewer: RVViewer): ModelCameraStart | null {
    let preset: ModelCameraStart | null = extractScenePreset(viewer.currentScene);
    const key = deriveModelKey(viewer.pendingModelUrl ?? viewer.currentModelUrl);
    if (!preset && key) preset = loadStartPos(key);
    if (!preset) {
      const root = viewer.currentModelRoot;
      const sceneCamera = root ? getSceneCamera(root) : null;
      if (sceneCamera) preset = cameraStartFromSceneCamera(sceneCamera);
    }
    if (!preset) preset = this._extractFromScene(viewer);
    return preset;
  }

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    // RVViewer.loadScene() stashes `currentScene` BEFORE invoking loadModel so
    // the per-scene preset read inside resolvePreset is reliable here.
    const preset = this.resolvePreset(viewer);

    if (!preset) return; // → Fit-to-Bounds Fallback

    if (this._isFPVActive(viewer)) return;

    const pos = new Vector3(preset.px, preset.py, preset.pz);
    const tgt = new Vector3(preset.tx, preset.ty, preset.tz);

    // Guard: position == target → lookAt() produces NaN quaternion
    if (pos.distanceToSquared(tgt) < EPSILON_POS_EQ_TARGET * EPSILON_POS_EQ_TARGET) {
      console.warn('[CameraStartPos] preset position equals target — skipping animation');
      return;
    }

    const duration = clampDuration(preset.duration);
    viewer.animateCameraTo(pos, tgt, duration);
  }

  onModelCleared(viewer: RVViewer): void {
    viewer.cancelCameraAnimation?.();
  }

  // --- Private helpers ---

  /**
   * Scan the Three.js scene for a top-level node with `userData.realvirtual.rv_camera_start`.
   * Since LoadResult does not expose the GLB root, we walk viewer.scene.children directly.
   * First match wins.
   */
  private _extractFromScene(viewer: RVViewer): ModelCameraStart | null {
    const sceneObj = viewer.scene;
    if (!sceneObj) return null;
    for (const child of sceneObj.children) {
      const rv = child.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) continue;
      const authorDefault = rv.rv_camera_start as Record<string, unknown> | undefined;
      if (!authorDefault) continue;

      const c = authorDefault.CameraTransformPos;
      const t = authorDefault.TargetPos;
      // Array.isArray() is the correct way to reject [x,y,z]-form — typeof [] === 'object' in JS
      if (!c || !t || Array.isArray(c) || Array.isArray(t)
          || typeof c !== 'object' || typeof t !== 'object') continue;
      const co = c as Record<string, unknown>;
      const to = t as Record<string, unknown>;
      if (!isFin(co.x) || !isFin(co.y) || !isFin(co.z)) continue;
      if (!isFin(to.x) || !isFin(to.y) || !isFin(to.z)) continue;

      const rawDuration = authorDefault.duration;
      // Unity LHS → glTF RHS: negate X (convention from parseCameraPos in maintenance-parser.ts)
      return {
        px: -(co.x as number), py: co.y as number, pz: co.z as number,
        tx: -(to.x as number), ty: to.y as number, tz: to.z as number,
        duration: isFin(rawDuration) ? (rawDuration as number) : 1.0,
        source: 'author',
      };
    }
    return null;
  }

  private _isFPVActive(viewer: RVViewer): boolean {
    const fpv = viewer.getPlugin?.('fpv') as { isActive?: boolean } | undefined;
    return fpv?.isActive === true;
  }
}
