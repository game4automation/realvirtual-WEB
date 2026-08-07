// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-axis-math.ts — pure world-space axis math for the drive axis gizmo
 * (plan-249). No Scene/Renderer dependency so the critical F4 world-space
 * composition is unit-testable in isolation.
 */

import { MathUtils } from 'three';
import type { Quaternion, Vector3 } from 'three';

// ── Screen-constant gizmo sizing ──
/** Gizmo occupies at most this fraction of the viewport height (never too big). */
export const GIZMO_MAX_SCREEN_FRAC = 0.4;
/** …and at least this fraction (stays visible when zoomed far out). */
export const GIZMO_MIN_SCREEN_FRAC = 0.14;
/** Full height of the core gizmo in design units (shaft 1.1 + 2 tips ≈ 1.4). */
export const GIZMO_DESIGN_HEIGHT = 1.4;

/**
 * World-space height that exactly fills the viewport at a given camera
 * distance (perspective) — the basis for screen-constant sizing.
 */
export function perspectiveViewportWorldHeight(fovDeg: number, distance: number): number {
  return 2 * Math.tan(MathUtils.degToRad(fovDeg) / 2) * distance;
}

/**
 * Group scale so the gizmo keeps a fixed on-screen size: its design height
 * maps to `GIZMO_MAX_SCREEN_FRAC` of the viewport, clamped so it never drops
 * below `GIZMO_MIN_SCREEN_FRAC`. Independent of object size → a large part no
 * longer produces an oversized gizmo. `viewportWorldHeight` is the world span
 * of the full viewport height at the gizmo's distance (see
 * `perspectiveViewportWorldHeight`, or `(top-bottom)/zoom` for orthographic).
 */
export function computeGizmoScale(viewportWorldHeight: number): number {
  return (viewportWorldHeight * GIZMO_MAX_SCREEN_FRAC) / GIZMO_DESIGN_HEIGHT;
}

/** Lower bound for the scale (keeps the gizmo visible when zoomed far out). */
export function minGizmoScale(viewportWorldHeight: number): number {
  return (viewportWorldHeight * GIZMO_MIN_SCREEN_FRAC) / GIZMO_DESIGN_HEIGHT;
}

/**
 * Compose a drive's LOCAL direction axis into world space.
 *
 * Both drive kinds act in the node's OWN local (home) frame, so both pass the
 * home quaternion as `baseQuat`; `baseQuat = null` still works for a node with
 * no home rotation (identity):
 *   - LINEAR drives translate along the object's own axis (`applyToNode`:
 *     `position = basePos + (baseQuat ⊗ axis) * offset`) → world axis =
 *     parentWorldQuat ⊗ baseQuat ⊗ axis.
 *   - ROTARY drives rotate AFTER the home orientation (`applyToNode`:
 *     `quaternion = baseQuat * delta(axis, angle)`) → world axis =
 *     parentWorldQuat ⊗ baseQuat ⊗ axis (the axis is invariant under its own
 *     delta rotation, so home == current for this purpose).
 *
 * The caller is responsible for the null-parent guard (`if (!node.parent) …`,
 * pattern `rv-robot-ik.ts`) and the Virtual-drive zero-vector guard
 * (`localAxis.lengthSq() < 1e-6`) BEFORE calling this.
 *
 * Writes into `out` (normalized) and returns it. No allocation.
 */
export function resolveWorldAxis(
  localAxis: Vector3,
  parentWorldQuat: Quaternion,
  baseQuat: Quaternion | null,
  out: Vector3,
): Vector3 {
  out.copy(localAxis);
  if (baseQuat) out.applyQuaternion(baseQuat);
  out.applyQuaternion(parentWorldQuat);
  return out.normalize();
}
