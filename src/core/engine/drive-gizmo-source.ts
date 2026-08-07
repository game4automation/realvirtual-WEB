// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-gizmo-source — the minimal read surface the drive-axis gizmo needs to
 * draw a drive, decoupled from the live RVDrive class.
 *
 * The live `RVDrive` satisfies this interface structurally, so the gizmo keeps
 * working unchanged for running scenes. The asset editor — where Drives are
 * authoring data (rv_extras) and NOT instantiated as live components until
 * save & reload — registers a fallback resolver that builds an authoring-only
 * source from a node's config, so the gizmo also renders in editor mode.
 */

import type { Object3D, Quaternion, Vector3 } from 'three';

/** Everything drive-axis-gizmo-plugin reads off a drive. Mirrors the relevant
 *  RVDrive members (which is assignable to this) 1:1. */
export interface DriveGizmoSource {
  readonly node: Object3D;
  readonly isRotary: boolean;
  readonly UseLimits: boolean;
  readonly LowerLimit: number;
  readonly UpperLimit: number;
  readonly Offset: number;
  readonly currentPosition: number;
  readonly isRunning: boolean;
  readonly jogForward: boolean;
  readonly jogBackward: boolean;
  /** Local-frame motion axis (unit; ReverseDirection applied; zero for Virtual). */
  getAxis(out: Vector3): Vector3;
  /** Authored (home) local orientation — the ring frame for rotary drives. */
  getHomeLocalQuaternion(out: Quaternion): Quaternion;
  /** Convert a linear position/distance (mm) into the node-local axis offset. */
  positionToLocalOffset(pos: number): number;
  /** Set the position the gizmo should VISUALISE (drag preview) without running
   *  the sim — the rotary dot / linear limit-ticks read `currentPosition`, so a
   *  driver sets this to keep them in sync while dragging. Optional: sources
   *  that can't preview simply omit it. */
  setPreviewPosition?(pos: number): void;
  /** Pin the home local orientation used for the rotary ring frame during a
   *  preview. A rotary drag mutates `node.quaternion`, but a source that derives
   *  home FROM the live node (the editor authoring source) would then drift —
   *  so the driver pins the pre-drag home here. No-op for a live RVDrive whose
   *  home is captured at init. */
  setPreviewHome?(homeQuat: Quaternion): void;
  /** Clear all preview state (position + pinned home) — the gizmo returns to
   *  showing the authored/home pose. Called by the driver on release/cancel. */
  endPreview?(): void;
}

/** Produces a gizmo source for a node path when NO live drive exists (editor
 *  authoring mode). Returns null when the node carries no Drive. */
export type DriveGizmoFallbackResolver = (path: string) => DriveGizmoSource | null;

let _fallback: DriveGizmoFallbackResolver | null = null;

/** Register (or clear with null) the authoring fallback. The asset editor sets
 *  this on activate and clears it on deactivate; live modes leave it null. */
export function setDriveGizmoFallbackResolver(resolver: DriveGizmoFallbackResolver | null): void {
  _fallback = resolver;
}

/** Resolve an authoring gizmo source for `path`, or null when none is registered. */
export function resolveDriveGizmoFallback(path: string): DriveGizmoSource | null {
  return _fallback ? _fallback(path) : null;
}
