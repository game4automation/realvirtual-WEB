// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-drag-driver — the seam between the (shared, mode-agnostic) drive-axis
 * gizmo and the editor-specific "preview the drive's motion, then spring back"
 * behaviour.
 *
 * The gizmo owns the drag GESTURE (raycast a handle, project pointer motion to a
 * drive position value). It knows nothing about how to move objects, kinematic
 * groups, or animate a spring-back — it just forwards a position to whatever
 * driver is registered. The asset editor registers a driver on activate and
 * clears it on deactivate; in every other mode no driver is registered, so the
 * gizmo stays purely passive (its drag listeners are not even attached).
 *
 * Mirrors the dependency-inversion of `drive-gizmo-source.ts`'s fallback
 * resolver: core defines the extension point, the editor supplies the impl.
 */

import type { Object3D } from 'three';
import type { DriveGizmoSource } from './drive-gizmo-source';
import type { ViewerHost } from './rv-viewer-host';

/** One drag interaction's context, passed to every driver call. */
export interface DriveDragContext {
  /** Typed as the capability subset, not RVViewer: engine/ must not import the
   *  viewer (plan-182 Phase 2). RVViewer satisfies this structurally. */
  viewer: ViewerHost;
  /** The drive being previewed (live RVDrive or authoring editor source). */
  source: DriveGizmoSource;
  /** The drive's axis node — the object whose motion is previewed. */
  node: Object3D;
  /** The drive position the gesture wants to preview (mm for linear, ° for
   *  rotary — same units as `currentPosition`). */
  position: number;
}

/**
 * Applies (and unwinds) a live preview of a drive's motion.
 * - `preview` — show the drive at `ctx.position` (snapshots home on first call).
 * - `release` — animate back to home (spring), then restore exactly.
 * - `cancel` — restore home immediately (Esc / interruption / pre-export).
 */
export interface DriveDragDriver {
  preview(ctx: DriveDragContext): void;
  release(ctx: DriveDragContext): void;
  cancel(ctx: DriveDragContext): void;
  /** True when the gizmo should NOT start a drag (e.g. the editor's transform
   *  gizmo is engaged) — the drive gizmo yields so the two never fight. */
  isBlocked?(): boolean;
}

let _driver: DriveDragDriver | null = null;
const _listeners = new Set<() => void>();

/** Register (or clear with null) the active drag driver. Notifies subscribers so
 *  the gizmo can attach/detach its pointer listeners. */
export function setDriveDragDriver(driver: DriveDragDriver | null): void {
  _driver = driver;
  for (const fn of _listeners) fn();
}

/** The active drag driver, or null when dragging is disabled (non-editor). */
export function getDriveDragDriver(): DriveDragDriver | null {
  return _driver;
}

/** Subscribe to driver register/clear (returns an unsubscribe). */
export function subscribeDriveDragDriver(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}
