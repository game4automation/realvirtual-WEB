// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-constants.ts — Shared numeric constants used across the WebViewer engine.
 *
 * Centralizes magic numbers for searchability, documentation, and consistency.
 */

/** Unity uses millimeters internally; Three.js uses meters. Divide by this to convert mm → m. */
export const MM_TO_METERS = 1000;

/** Minimum pixel distance before a pointerdown→pointermove sequence is treated as a drag (not a click). */
export const DRAG_THRESHOLD_PX = 8;

/** Default device pixel ratio cap applied to the renderer to limit GPU load on HiDPI screens. */
export const DEFAULT_DPR_CAP = 1.5;

/**
 * Extract the last segment of a hierarchy path (the part after the last '/').
 * Returns the full string if there is no '/'.
 *
 * @example lastPathSegment('Root/Child/Leaf') // 'Leaf'
 * @example lastPathSegment('OnlyName')        // 'OnlyName'
 */
export function lastPathSegment(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.substring(idx + 1);
}
