// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collider-gizmo-sync.ts — lets a component with a `ShowGizmo` field
 * (Sensor, WebPhysicsZone, …) tell the `BoxCollider` on the same node that its
 * gizmo visibility changed.
 *
 * The collider draws its own yellow box while authoring; without this hook a
 * Sensor or zone with `ShowGizmo = false` still showed the collider's box, so
 * the Inspector toggle looked dead. Duck-typed on purpose: the collider module
 * already imports `rv-physics-zone`, a direct import back would be a cycle.
 */

import type { Object3D } from 'three';

interface GizmoVisibilitySync { syncGizmoVisibility(): void }

/** Re-evaluate the collider gizmo visibility of every component on `node`. */
export function syncColliderGizmo(node: Object3D | undefined): void {
  const ud = node?.userData as Record<string, unknown> | undefined;
  if (!ud) return;
  const list = (ud._rvComponentInstances as unknown[] | undefined)
    ?? (ud._rvComponentInstance ? [ud._rvComponentInstance] : []);
  for (const inst of list) {
    const sync = (inst as Partial<GizmoVisibilitySync> | null)?.syncGizmoVisibility;
    if (typeof sync === 'function') sync.call(inst);
  }
}
