// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pose-align.ts — Pure orientation-alignment helpers.
 *
 * The axis-alignment helpers serve the IK target quick-edit ("Down" / "World"
 * align shortcuts). Both operate on WORLD-frame quaternions and return NEW
 * quaternions — minimal rotations from the current orientation, so the target
 * never flips to a surprising far-away pose.
 *
 * `lookRotation` (plan-268) is the Unity-parity forward/up orientation used by
 * the path traveler to align a carrier along a path tangent. It supports an
 * `out` target so the per-tick pose path allocates nothing.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';

/** The 24 axis-aligned (signed-permutation, det=+1) world orientations. */
let _axisAligned: Quaternion[] | null = null;

function axisAlignedQuaternions(): Quaternion[] {
  if (_axisAligned) return _axisAligned;
  const dirs = [
    new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
    new Vector3(0, 1, 0), new Vector3(0, -1, 0),
    new Vector3(0, 0, 1), new Vector3(0, 0, -1),
  ];
  const out: Quaternion[] = [];
  const m = new Matrix4();
  const z = new Vector3();
  for (const x of dirs) {
    for (const y of dirs) {
      if (Math.abs(x.dot(y)) > 1e-6) continue; // must be perpendicular
      z.crossVectors(x, y); // right-handed → det +1
      m.makeBasis(x, y, z);
      out.push(new Quaternion().setFromRotationMatrix(m));
    }
  }
  _axisAligned = out; // 6 × 4 = 24
  return out;
}

/**
 * The axis-aligned world orientation closest to `q` (minimal rotation angle).
 * Quaternion distance via |dot| — handles the double cover.
 */
export function nearestAxisAlignedQuaternion(q: Quaternion): Quaternion {
  let best: Quaternion | null = null;
  let bestDot = -1;
  for (const cand of axisAlignedQuaternions()) {
    const d = Math.abs(q.dot(cand));
    if (d > bestDot) { bestDot = d; best = cand; }
  }
  return best!.clone();
}

const _axes: Vector3[] = [
  new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0), new Vector3(0, -1, 0),
  new Vector3(0, 0, 1), new Vector3(0, 0, -1),
];
const _rotated = new Vector3();
const _bestAxis = new Vector3();

/**
 * Rotate `q` minimally so that whichever of its (signed) local basis axes is
 * currently CLOSEST to `dir` points exactly along `dir`. Generic "make the
 * tool vertical" without assuming a tool-axis convention: the user roughly
 * orients the target, the shortcut finishes the job.
 */
export function alignClosestAxisTo(q: Quaternion, dir: Vector3): Quaternion {
  const target = dir.clone().normalize();
  let bestDot = -Infinity;
  for (const a of _axes) {
    _rotated.copy(a).applyQuaternion(q);
    const d = _rotated.dot(target);
    if (d > bestDot) { bestDot = d; _bestAxis.copy(_rotated); }
  }
  const delta = new Quaternion().setFromUnitVectors(_bestAxis.clone().normalize(), target);
  return delta.multiply(q); // premultiply: world-frame correction
}

// ── lookRotation (plan-268 — path traveler pose) ─────────────────────────

const _lkZ = new Vector3();
const _lkX = new Vector3();
const _lkY = new Vector3();
const _lkUp = new Vector3();
const _lkM = new Matrix4();

/**
 * Unity-parity `Quaternion.LookRotation(forward, up)`: the orientation whose
 * local +Z points along `forward` with local +Y as close to `up` as possible.
 *
 * Degenerate inputs are guarded (no NaN): a zero-length `forward` returns
 * identity; `forward` parallel to `up` falls back to a stable substitute up
 * axis. Pass `out` to avoid allocation in hot paths (per-tick pose updates).
 */
export function lookRotation(forward: Vector3, up: Vector3, out?: Quaternion): Quaternion {
  const q = out ?? new Quaternion();
  if (forward.lengthSq() < 1e-12) return q.identity();
  _lkZ.copy(forward).normalize();
  _lkUp.copy(up);
  if (_lkUp.lengthSq() < 1e-12) _lkUp.set(0, 1, 0);
  _lkX.crossVectors(_lkUp, _lkZ);
  if (_lkX.lengthSq() < 1e-12) {
    // forward ∥ up — substitute a world axis that is guaranteed non-parallel.
    _lkUp.set(0, 1, 0);
    if (Math.abs(_lkZ.y) > 0.9) _lkUp.set(0, 0, 1);
    _lkX.crossVectors(_lkUp, _lkZ);
  }
  _lkX.normalize();
  _lkY.crossVectors(_lkZ, _lkX);
  _lkM.makeBasis(_lkX, _lkY, _lkZ);
  return q.setFromRotationMatrix(_lkM);
}
