// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Floor/drop helpers of the Layout Planner, plus the re-export of the model
 * cache that moved to the core (`core/engine/rv-model-cache`).
 *
 * - ModelCache (re-export): loads + caches GLB models — owned by the viewer's
 *   placement instancer since 2026-09-17
 * - pivotToFloorCenter: recalculates pivot to bottom-center of full AABB
 * - alignToFloor: shifts a group so its bounding box bottom sits at Y=0
 *
 * `unwrapGltfRoot` now lives in `core/engine/rv-gltf-unwrap` — the editor's
 * `parseGlbSubtree` needs the identical definition of "content root". It is
 * re-exported here (and from the plugin index) for backwards compatibility.
 */

import {
  Group,
  Vector3,
  Box3,
  Raycaster,
} from 'three';
import type { Object3D, Scene, Mesh } from 'three';
import { unwrapGltfRoot } from '../../core/engine/rv-gltf-unwrap';
// Pivot normalization moved to the core (2026-08-31): composition needs the
// identical definition when it re-grafts a saved placement's content, and the
// engine must not import a plugin. Re-exported here so every existing planner
// call site keeps working unchanged.
import { pivotToFloorCenter } from '../../core/engine/rv-placement-pivot';

export { unwrapGltfRoot, pivotToFloorCenter };

// ─── Align to Floor ─────────────────────────────────────────────────────

const _alignBox = new Box3();

/** Shift group so its bounding box bottom sits at Y=0. */
export function alignToFloor(obj: Group): void {
  _alignBox.setFromObject(obj);
  if (_alignBox.isEmpty()) return;
  obj.position.y -= _alignBox.min.y;
}

// ─── Drop to Surface ───────────────────────────────────────────────────

const _dropBox = new Box3();
const _dropOrigin = new Vector3();
const _dropDir = new Vector3(0, -1, 0);
const _dropRaycaster = new Raycaster();

/**
 * Build the list of meshes a `dropToSurface` raycast should consider — every
 * visible scene mesh except `selfObj`'s own descendants and infrastructure
 * (ghosts, gizmos, layout floor, ground plane, highlight/ghost overlays).
 *
 * Exposed as a separate helper so callers can cache the result across many
 * raycasts of the SAME object — e.g. live drop-to-surface during a drag,
 * where the scene composition doesn't change between pointermove frames.
 * The `scene.traverse` is the expensive part of `dropToSurface`; caching
 * cuts a per-frame O(scene-mesh-count) walk down to a single raycast.
 */
export function collectDropTargets(scene: Scene, selfObj: Object3D): Mesh[] {
  const selfMeshes = new Set<Object3D>();
  selfObj.traverse((child) => { selfMeshes.add(child); });

  const targets: Mesh[] = [];
  scene.traverse((child) => {
    if (!(child as Mesh).isMesh) return;
    if (selfMeshes.has(child)) return;
    if (!child.visible) return;
    if (child.userData._isGhost) return;
    if (child.userData._isSourceGhost) return; // source preview ghost — not a drop surface
    if (child.userData._isSourcePreview) return; // source showcase instance — not a drop surface
    if (child.userData._layoutFloor) return;
    if (child.userData._rvGizmo || hasAncestorTag(child, '_rvGizmo')) return;
    if (child.userData._rvGizmoOverlay) return;
    if (child.userData._highlightOverlay) return;
    if (child.userData._isGhostOverlay) return;
    if (child.userData._rvGroundPlane || hasAncestorTag(child, '_rvGroundPlane')) return;
    // FloorGizmo: walk ancestors. The gizmo's hidden Y-axis bars sit inside
    // a Group with visible=false, but Three.js's per-mesh raycast only checks
    // the mesh's own visibility, so the seg meshes still get hit. Match the
    // gizmo root by name to exclude every descendant in one check.
    if (hasAncestorNamed(child, '_floorGizmo')) return;
    targets.push(child as Mesh);
  });
  return targets;
}

/**
 * Raycast downward to find the highest surface below the object's XZ footprint
 * and place its bounding box bottom on that surface. Falls back to Y=0 (floor)
 * if no elevated surface is hit.
 *
 * @param obj      The placed object (must already be in the scene).
 * @param scene    The Three.js scene to raycast against.
 * @param targets  Optional pre-computed candidate-mesh list (see
 *                 `collectDropTargets`). When omitted, this function
 *                 traverses the scene itself — the expected cost on
 *                 single one-shot drops at drag-end. Pass a cached list
 *                 for live drop during a drag (60 Hz).
 * @returns        The surface Y the object was placed on (0 if floor).
 */
export function dropToSurface(
  obj: Object3D,
  scene: Scene,
  targets?: Mesh[],
  centerOnBelt = false,
): number {
  scene.updateMatrixWorld(true);
  _dropBox.setFromObject(obj);
  if (_dropBox.isEmpty()) return 0;

  // Offset from obj.position.y to the bounding box bottom — we preserve this
  // so the pivot stays correct regardless of where the object's local origin is.
  // ASSUMPTION: obj.parent is at world identity (no scaling, no Y offset). True
  // for single-select planner placements parented to layoutRoot / modelRoot.
  // Multi-select members are temporarily under a centroid pivot Group — callers
  // should NOT invoke this from inside a multi-select drag.
  const pivotToBottom = obj.position.y - _dropBox.min.y;

  const candidates = targets ?? collectDropTargets(scene, obj);

  if (candidates.length === 0) {
    obj.position.y = pivotToBottom;
    return 0;
  }

  // Cast a single downward ray from the bbox XZ center
  const cx = (_dropBox.min.x + _dropBox.max.x) / 2;
  const cz = (_dropBox.min.z + _dropBox.max.z) / 2;
  const castY = 50; // well above any scene content
  _dropRaycaster.far = 100;
  _dropOrigin.set(cx, castY, cz);
  _dropRaycaster.set(_dropOrigin, _dropDir);

  const hits = _dropRaycaster.intersectObjects(candidates, false);
  if (hits.length > 0) {
    const surfaceY = hits[0].point.y;
    if (surfaceY > 0.01) {
      // Lateral centering: when requested and we landed on a transport-surface
      // drop plane, snap the object's XZ onto the belt's centre line (keeps the
      // along-belt position; only the cross-belt offset is removed). The plane
      // carries a back-reference to its RVTransportSurface in userData.
      if (centerOnBelt) {
        const surf = hits[0].object.userData._rvDropSurfaceInstance as
          { snapToCenterLine?(p: Vector3): void } | undefined;
        surf?.snapToCenterLine?.(obj.position);
      }
      obj.position.y = surfaceY + pivotToBottom;
      return surfaceY;
    }
  }

  // No elevated surface — place on floor (Y=0)
  obj.position.y = pivotToBottom;
  return 0;
}

/**
 * Drop a multi-select PIVOT Group to the surface below.
 *
 * Companion to {@link dropToSurface} for the centroid pivot built by
 * MultiSelectPivot during multi-object drags. Key differences:
 *
 *   - **Cast XZ:** the pivot's CURRENT world XZ (= the transform gizmo's
 *     position). The bbox center would be wrong for asymmetric selections
 *     (e.g. one big + one small object), because the user reads the gizmo,
 *     not the bbox.
 *   - **Adjust target:** shifts `pivot.position.y` by the delta required to
 *     put the UNION AABB bottom on the surface. Members move rigidly as
 *     the pivot's children, so relative Y offsets between selected objects
 *     are preserved.
 *
 * @param pivot    The selection pivot Group (members live as its children).
 * @param scene    The Three.js scene to raycast against.
 * @param targets  Optional pre-computed candidate-mesh list (see
 *                 {@link collectDropTargets}). Pass a cached list for live
 *                 drop during a drag (60 Hz).
 * @returns        The surface Y the selection was placed on (0 if floor).
 */
export function dropPivotToSurface(
  pivot: Object3D,
  scene: Scene,
  targets?: Mesh[],
): number {
  scene.updateMatrixWorld(true);
  _dropBox.setFromObject(pivot);
  if (_dropBox.isEmpty()) return 0;

  const candidates = targets ?? collectDropTargets(scene, pivot);

  // Cast from the pivot's WORLD XZ — that's exactly where the user sees
  // the gizmo. The pivot is always parented to the scene root, so world
  // XZ equals local XZ; getWorldPosition is the defensive choice.
  pivot.getWorldPosition(_dropOrigin);
  const castX = _dropOrigin.x;
  const castZ = _dropOrigin.z;

  let surfaceY = 0;
  if (candidates.length > 0) {
    const castUp = 50; // well above any scene content
    _dropRaycaster.far = 100;
    _dropOrigin.set(castX, castUp, castZ);
    _dropRaycaster.set(_dropOrigin, _dropDir);
    const hits = _dropRaycaster.intersectObjects(candidates, false);
    if (hits.length > 0 && hits[0].point.y > 0.01) {
      surfaceY = hits[0].point.y;
    }
  }

  // delta = where the union-bbox bottom should land minus where it is now.
  // Apply to pivot.position.y so every child member shifts rigidly.
  pivot.position.y += surfaceY - _dropBox.min.y;
  return surfaceY;
}

/** Check if `child` is a descendant of `ancestor` (or is `ancestor` itself). */
function isDescendantOf(child: Object3D, ancestor: Object3D): boolean {
  let cur: Object3D | null = child;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/** Check if any ancestor (including self) has the given userData tag set to truthy. */
function hasAncestorTag(obj: Object3D, tag: string): boolean {
  let cur: Object3D | null = obj.parent;
  while (cur) {
    if (cur.userData[tag]) return true;
    cur = cur.parent;
  }
  return false;
}

/** Check if `obj` itself or any ancestor has the given name. */
function hasAncestorNamed(obj: Object3D, name: string): boolean {
  let cur: Object3D | null = obj;
  while (cur) {
    if (cur.name === name) return true;
    cur = cur.parent;
  }
  return false;
}

// ─── Model Cache (moved to the core) ────────────────────────────────────
//
// `ModelCache` and its helpers live in `core/engine/rv-model-cache` since the
// placement instancer became viewer-owned (plan-753 structure hardening,
// 2026-09-17). Re-exported so every existing import keeps working.
export {
  ModelCache,
  AbortError,
  RESOLVED_KEY_PREFIX,
  resolvedCacheKey,
  applyNamingScanToMaster,
  ensureNeutralPlacementRoot,
  getDecodeTimings,
  clearDecodeTimings,
} from '../../core/engine/rv-model-cache';
export type {
  AcquiredAsset,
  AcquireFn,
  ModelCacheUberOptions,
  BakeStats,
  DecodeTiming,
} from '../../core/engine/rv-model-cache';
