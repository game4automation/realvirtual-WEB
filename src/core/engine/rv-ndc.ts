// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ndc — the one canonical NDC→screen-pixel mapping.
 *
 * Several overlays (tooltips, snap points, IK gizmos, facades) project world
 * points to screen space. The projection itself (`Vector3.project(camera)`)
 * and any behind-camera policy stay at the call site — this module only owns
 * the pixel formula so it cannot drift between copies:
 *
 *   x = (ndcX * 0.5 + 0.5) * width  + left
 *   y = (-ndcY * 0.5 + 0.5) * height + top
 */

/** Minimal rect shape (matches DOMRect and {width,height} literals). */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Writable 2D point target (avoids allocation at hot call sites). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Map an NDC coordinate (-1..1) to screen pixels within `rect`.
 * Pass `left: 0, top: 0` for canvas-local coordinates.
 */
export function ndcToScreen(
  ndcX: number,
  ndcY: number,
  rect: ScreenRect,
  out: ScreenPoint,
): ScreenPoint {
  out.x = (ndcX * 0.5 + 0.5) * rect.width + rect.left;
  out.y = (-ndcY * 0.5 + 0.5) * rect.height + rect.top;
  return out;
}
