// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Placement pivot normalization — the ONE definition of where a planner
 * placement's origin sits inside its content.
 *
 * Historically this lived in the layout planner (`model-cache.ts`) and ran only
 * on the PLACE path, when a library GLB is dragged into the scene. Since
 * plan-397 phase 6 a saved scene stores placements as geometry-less
 * `AssetReference` nodes and composition re-fetches the referenced file on
 * every load — so the same normalization has to run on the COMPOSE path too,
 * or a library file whose own root sits off-origin (Unity-authored exports
 * routinely do) comes back shifted by exactly that internal offset. That was
 * visible as the "scattered" DemoPlanner layout: every placement ROOT at its
 * authored position, every composed child dragging its file-local offset in.
 *
 * Core-owned so `rv-glb-compose` may call it without importing a plugin; the
 * planner re-exports it from `model-cache.ts` unchanged.
 */

import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';

const _pivotBox = new Box3();
const _pivotCenter = new Vector3();
const _pivotWorld = new Vector3();
const _pivotOrigPos = new Vector3();

/** Marker component name written by the Unity WebPivot MonoBehaviour into
 *  rv_extras. Presence of this key on any descendant signals an explicit,
 *  hand-authored pivot point that overrides the auto AABB pivot. */
const WEB_PIVOT_KEY = 'WebPivot';

/**
 * Find the first descendant whose rv_extras carries a WebPivot marker.
 * Walks the subtree depth-first and stops at the first match — multiple
 * markers per library object are not supported and the first wins.
 */
export function findWebPivotMarker(root: Object3D): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((node) => {
    if (found) return;
    const rv = (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
    if (rv && rv[WEB_PIVOT_KEY]) found = node;
  });
  return found;
}

/**
 * Recalculate pivot so the local origin lands at either:
 *   1. an explicit Unity-authored WebPivot marker child (if present), or
 *   2. the bottom-center of the model's full axis-aligned bounding box.
 *
 * WebPivot path: the marker's world position is taken as the new origin —
 * both XZ and Y come from the marker. Use this when a library object needs
 * its rotation/snap origin somewhere other than the AABB floor-center
 * (e.g. a robot mounted on a wall, a fixture with an off-center base).
 *
 * AABB path: XZ = AABB centroid, Y = AABB.min.y. Predictable and explicit;
 * asymmetric models (robot with long arm overhang, L-shaped fixture) get a
 * pivot at the AABB centroid above the floor — that's the documented
 * fallback. Callers that need a contact-footprint pivot should provide a
 * WebPivot marker instead.
 *
 * In both cases every direct child of `obj` is shifted by the negative
 * offset so the visual position of the geometry is unchanged. Idempotent:
 * content that already has its pivot at the origin is shifted by ~zero,
 * which is what allows the compose path to run it unconditionally on
 * planner placements.
 */
export function pivotToFloorCenter(obj: Object3D): void {
  // We compute everything in obj's LOCAL space so the offsets we add to
  // child.position (which are local-space values) line up with the AABB
  // that Three.js' setFromObject reports (which is world-space). To bridge
  // the two, temporarily neutralize obj's own transform — then world-space
  // coordinates _are_ obj's local-space coordinates. Without this step,
  // any non-zero obj.position would offset the gizmo from the mesh by
  // exactly obj.position (Unity-authored library objects whose root sat at
  // a non-origin position are the typical trigger).
  _pivotOrigPos.copy(obj.position);
  const origRotX = obj.rotation.x;
  const origRotY = obj.rotation.y;
  const origRotZ = obj.rotation.z;
  obj.position.set(0, 0, 0);
  obj.rotation.set(0, 0, 0);
  obj.updateMatrixWorld(true);

  const marker = findWebPivotMarker(obj);
  let offsetX: number;
  let offsetY: number;
  let offsetZ: number;

  if (marker) {
    // WebPivot wins. With obj reset to identity, the marker's world position
    // _is_ its position in obj's local space — which is exactly the value
    // we need to subtract from every direct child.
    marker.getWorldPosition(_pivotWorld);
    offsetX = -_pivotWorld.x;
    offsetY = -_pivotWorld.y;
    offsetZ = -_pivotWorld.z;
  } else {
    _pivotBox.setFromObject(obj);
    if (_pivotBox.isEmpty()) {
      obj.position.copy(_pivotOrigPos);
      obj.rotation.set(origRotX, origRotY, origRotZ);
      return;
    }
    _pivotBox.getCenter(_pivotCenter);
    offsetX = -_pivotCenter.x;
    offsetZ = -_pivotCenter.z;
    offsetY = -_pivotBox.min.y;
  }

  for (const child of obj.children) {
    child.position.x += offsetX;
    child.position.y += offsetY;
    child.position.z += offsetZ;
  }

  obj.position.copy(_pivotOrigPos);
  obj.rotation.set(origRotX, origRotY, origRotZ);
}
