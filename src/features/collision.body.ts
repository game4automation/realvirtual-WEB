// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * collision.body.ts — body of the on-demand collision feature (plan-781 F21).
 *
 * Imported ONLY through `collision.register.ts`'s `load: () => import('./collision.body')`.
 * It brings the manager and its geometry modules (bodies, narrowphase, tri-tri) —
 * the startup path carries only the `CollisionRole` marker, the eager registrar slot
 * (`rv-collision-slot.ts`) and a `viewer.collisionManager` that is null until here.
 *
 * `activate` is idempotent: a second call finds the installed manager and stops.
 * It wires what lives as long as the viewer — the geometry source (the bake
 * registry), the status-outline host and the machining bridge — and hands the
 * manager to the viewer, which replays the slot's buffered registrations and wires
 * the current model at once (late activation) and every later model at its load.
 */

import type { RVViewer } from '../core/rv-viewer';
import { RVCollisionManager } from '../core/engine/rv-collision-manager';
import { showStatusOutline, hideStatusOutline } from '../core/engine/rv-status-outline';

//! Activates collision detection in the viewer. Idempotent — a retry after a failure is safe.
export function activate(viewer: RVViewer): void {
  if (viewer.collisionManager) return;
  const manager = new RVCollisionManager();
  // plan-781: bodies are segment ranges of the baked chunks, resolved through the
  // registry (an instance seam — the manager builds no structure of its own).
  manager.setGeometrySource(viewer.bakeRegistry);
  // plan-394: collided bodies get the pulsing STATUS outline in the warning orange
  // of the collision cards (SEVERITY_COLORS.warning).
  manager.setHighlightHost({
    showCollision: (roots) => showStatusOutline(viewer, roots, 0xffa726,
      { ownerKey: 'collision', pulsePeriod: 0.6 }),
    hideCollision: () => hideStatusOutline(viewer, 'collision'),
  });
  // plan-409: machining reports which cutter is legitimately inside which workpiece.
  viewer.machiningManager.setCollisionBridge(manager);
  viewer.installCollisionManager(manager);
}
