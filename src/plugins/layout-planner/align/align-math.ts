// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * align-math.ts — pure maths of the planner Align tool (plan-779).
 *
 * No UI, no viewer, no planner imports: three.js value types only, so the
 * module runs in Node tests and may be imported statically. All functions use
 * module scratch objects and allocate nothing except the returned tuple of
 * `translateInParentFrame`.
 */

import { Matrix4, Vector3, type Camera } from 'three';

/** Screen-space snap radius for a corner, in CSS pixels. */
export const CORNER_SNAP_PX = 12;

/** Below this world distance (metres) an Align moves nothing. */
export const ALIGN_EPSILON_M = 1e-6;

export interface AlignAxes { x: boolean; y: boolean; z: boolean }
export interface Vec3Like { x: number; y: number; z: number }
export interface ScreenRect { left: number; top: number; width: number; height: number }

const _ndc = new Vector3();
const _inv = new Matrix4();
const _world = new Vector3();

/**
 * Index (0..2) of the triangle corner nearest to the cursor in screen space,
 * or -1 when none lies within `tolPx`. Corners outside the clip volume
 * (behind the camera or beyond far) never win.
 */
export function pickNearestCorner(
  triWorld: readonly [Vector3, Vector3, Vector3],
  cursorPx: { x: number; y: number },
  camera: Camera,
  rect: ScreenRect,
  tolPx: number = CORNER_SNAP_PX,
): 0 | 1 | 2 | -1 {
  let best: 0 | 1 | 2 | -1 = -1;
  let bestSq = tolPx * tolPx;
  for (let k = 0; k < 3; k++) {
    _ndc.copy(triWorld[k]).project(camera);
    if (!(_ndc.z >= -1 && _ndc.z <= 1)) continue;
    const px = rect.left + (_ndc.x + 1) * 0.5 * rect.width;
    const py = rect.top + (1 - _ndc.y) * 0.5 * rect.height;
    const dx = px - cursorPx.x;
    const dy = py - cursorPx.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestSq) { bestSq = d2; best = k as 0 | 1 | 2; }
  }
  return best;
}

function finiteOr0(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * World delta in metres that brings corner A onto corner B plus the offset (metres),
 * on the active axes only (inactive axes: 0). Non-finite components become 0.
 */
export function computeAlignDelta(
  cornerAWorld: Vec3Like,
  cornerBWorld: Vec3Like,
  axes: AlignAxes,
  offsetM: Vec3Like,
  out: Vector3,
): Vector3 {
  out.set(
    axes.x ? finiteOr0(cornerBWorld.x + finiteOr0(offsetM.x) - cornerAWorld.x) : 0,
    axes.y ? finiteOr0(cornerBWorld.y + finiteOr0(offsetM.y) - cornerAWorld.y) : 0,
    axes.z ? finiteOr0(cornerBWorld.z + finiteOr0(offsetM.z) - cornerAWorld.z) : 0,
  );
  return out;
}

/**
 * New record position (metres, in the record parent's local frame) of a
 * placement root at world position `rootWorld` that is translated by
 * `deltaWorld`. `recordParentMatrixWorld` must be the frame the record lives
 * in (layout/model root — not a temporary multi-select pivot) and current.
 */
export function translateInParentFrame(
  rootWorld: Vec3Like,
  recordParentMatrixWorld: Matrix4,
  deltaWorld: Vec3Like,
): [number, number, number] {
  _world.set(rootWorld.x + deltaWorld.x, rootWorld.y + deltaWorld.y, rootWorld.z + deltaWorld.z);
  _inv.copy(recordParentMatrixWorld).invert();
  _world.applyMatrix4(_inv);
  return [_world.x, _world.y, _world.z];
}
