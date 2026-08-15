// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-constants.ts — Shared numeric constants used across the WebViewer engine.
 *
 * Centralizes magic numbers for searchability, documentation, and consistency.
 */

/** Unity uses millimeters internally; Three.js uses meters. Divide by this to convert mm → m. */
export const MM_TO_METERS = 1000;

/**
 * Default conveyor speed (mm/s) for library transport assets that carry no
 * authored speed — the naming-convention scanner stamps it on the synthetic
 * Transport drive, and the DES transit timer falls back to it when a belt has
 * no drive. 300 mm/s ≈ 18 m/min, a typical pallet roller/chain conveyor speed.
 * (The bare RVDrive default of 100 mm/s is a Unity-parity contract and stays.)
 */
export const DEFAULT_TRANSPORT_SPEED_MM_S = 300;

/**
 * Simulation pause reason owned by the user (toolbar Play/Pause button + Space
 * key, see sim-controller plugin). Editing gestures in the Layout-Planner
 * (placing an asset, moving or changing a placed object) auto-stop the sim by
 * engaging THIS reason, so the user resumes the very same way they always do —
 * pressing Play (or Space). The sim-controller re-exports it as
 * `SIM_CONTROLLER_PAUSE_REASON` for backward compatibility.
 */
export const USER_PAUSE_REASON = 'user';

/**
 * Pause reason used by the Layout-Planner while a 3D edit gesture is in flight
 * (gizmo transform, direct object drag, library drag-in placement). Kept
 * DISTINCT from `USER_PAUSE_REASON` so the planner can auto-resume the sim when
 * the gesture finishes WITHOUT ever clobbering a manual user pause — releasing
 * this reason only resumes when no other reason still holds the sim paused.
 */
export const LAYOUT_EDIT_PAUSE_REASON = 'layout-edit';

/** Minimum pixel distance before a pointerdown→pointermove sequence is treated as a drag (not a click). */
export const DRAG_THRESHOLD_PX = 8;

/** Default device pixel ratio cap applied to the renderer to limit GPU load on HiDPI screens. */
export const DEFAULT_DPR_CAP = 1.5;

/**
 * Three.js layer allocation used across the viewer:
 *   0 — default: geometry, raycasting
 *   2 — ISOLATE_FOCUS_LAYER (rv-group-registry): currently isolated group's subtree
 *   3 — HIGHLIGHT_OVERLAY_LAYER (rv-group-registry): on-top UI pulled out of the
 *       composer and re-rendered above it (highlights, planner gizmos, snap guides)
 *   4 — NO_AO_LAYER (this file): in-scene UI that stays in the composer (correct
 *       depth occlusion + bloom) but must NOT contribute to GTAO/N8AO ambient
 *       occlusion — the AO clone camera disables this layer (see rv-post-processing)
 *   6 — ANNOTATION_LAYER (rv-annotation-renderer): annotation pins, labels, connector lines
 *   7 — MEASUREMENT_LAYER (rv-measurement-renderer): measurement markers, lines, distance labels
 */
export const MEASUREMENT_LAYER = 7;

/**
 * Layer for in-scene UI that must be excluded from SSAO without changing how it
 * looks. Unlike HIGHLIGHT_OVERLAY_LAYER (which is pulled out of the composer and
 * drawn on top), NO_AO objects stay in the normal RenderPass — so they keep
 * correct depth-occlusion against scene geometry and still receive UnrealBloom —
 * but the dedicated AO clone camera turns this layer OFF, so GTAO/N8AO never see
 * them and they cast no AO halos. Used for the placement ghost, the planner grid,
 * and bloom/glow gizmos (WebSensor halos, snap-chain preview).
 *
 * Objects are placed on this layer ONLY (`layers.set(NO_AO_LAYER)`), so the AO
 * camera (which copies the real camera's mask then disables this bit) excludes
 * them. The real cameras enable this layer so the RenderPass still draws them.
 */
export const NO_AO_LAYER = 4;

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
