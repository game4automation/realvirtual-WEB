// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraStartPosPlugin — Per-model camera start position.
 *
 * On every onModelLoaded:
 *  1. Derive a stable per-model key from the URL/filename.
 *  2. Look for a saved preset in localStorage (user override). Priority 1.
 *  3. Otherwise scan viewer.scene.children for `userData.realvirtual.rv_camera_start`
 *     (author default in GLB rv_extras). Priority 2.
 *  4. If a preset exists and FPV is not active, smoothly tween the camera
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

const EPSILON_POS_EQ_TARGET = 1e-3;
const MIN_DURATION = 0.05;
const MAX_DURATION = 60;

/**
 * Exported pure function — testable without a viewer instance.
 * Derives a stable per-model key from a URL or File name.
 */
export function deriveModelKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const noQuery = url.split('?')[0];
  const filename = noQuery.split('/').pop() ?? noQuery;
  const stripped = filename.replace(/\.glb$/i, '');
  return stripped.length > 0 ? stripped : null;
}

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
  return saveStartPos(key, preset) ? 'ok' : 'save-failed';
}

export function clearCurrentCameraStart(viewer: RVViewer): boolean {
  const key = deriveModelKey(viewer.pendingModelUrl ?? viewer.currentModelUrl);
  if (!key) return false;
  clearStartPos(key);
  return true;
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
    { slot: 'settings-tab', component: CameraStartTab, label: 'Start View', order: 290 },
  ];

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    const key = deriveModelKey(viewer.pendingModelUrl ?? viewer.currentModelUrl);
    if (!key) return;

    // Priority 1: LocalStorage user override
    let preset = loadStartPos(key);

    // Priority 2: GLB rv_extras author default — scan scene top-level for userData.realvirtual.rv_camera_start
    if (!preset) preset = this._extractFromScene(viewer);

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
