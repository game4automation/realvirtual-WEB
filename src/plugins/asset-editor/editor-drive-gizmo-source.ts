// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-drive-gizmo-source — authoring-only DriveGizmoSource for editor mode.
 *
 * In the asset editor a Drive is rv_extras config, not a live RVDrive, so the
 * drive-axis gizmo has nothing to attach to. This adapter reads that config
 * LIVE (every access re-reads userData) and derives the same axis / kind /
 * limits the live drive would — reusing directionToGltfAxis + isRotation, so
 * the two can never drift. Registered as the gizmo's fallback resolver while
 * the editor is active (see AssetEditorPlugin).
 */

import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { DriveGizmoSource } from '../../core/engine/drive-gizmo-source';
import { DriveDirection, directionToGltfAxis, isRotation } from '../../core/engine/rv-coordinate-utils';
import { linearPositionToLocalOffsetFromAxis } from '../../core/engine/rv-drive-units';

/** Drive component keys in rv_extras (Drive, Drive_1, …). */
const DRIVE_KEY_RE = /^Drive(_\d+)?$/;

/** Scratch for the unit conversion — this source is queried per frame. */
const _axis = new Vector3();
const _home = new Quaternion();

/** The node's Drive component data, or null when it has none. */
function driveConfig(node: Object3D): Record<string, unknown> | null {
  const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
  if (!rv) return null;
  for (const key of Object.keys(rv)) {
    if (DRIVE_KEY_RE.test(key)) {
      const data = rv[key];
      if (data && typeof data === 'object') return data as Record<string, unknown>;
    }
  }
  return null;
}

function num(cfg: Record<string, unknown> | null, key: string, dflt: number): number {
  const v = cfg?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * Reads a node's rv_extras Drive config live so config edits (Direction,
 * limits, offset) rebuild/reorient the gizmo exactly like a live drive. No
 * motion: currentPosition is the authored StartPosition and run/jog flags are
 * always false (no motion pulse). When the Drive is removed getAxis returns the
 * zero vector, which the gizmo already treats as "hide".
 */
class EditorDriveGizmoSource implements DriveGizmoSource {
  readonly isRunning = false;
  readonly jogForward = false;
  readonly jogBackward = false;

  /** Drag-preview position set by the drive-drag driver; null = show authored
   *  StartPosition. Only the visual (dot / limit ticks) reads it — the driver
   *  moves the actual node. */
  private _previewPosition: number | null = null;
  /** Pre-drag home orientation, pinned during a preview so the rotary ring frame
   *  does not follow the node while the driver rotates it. */
  private _previewHomeQuat: Quaternion | null = null;

  constructor(readonly node: Object3D) {}

  private cfg(): Record<string, unknown> | null {
    return driveConfig(this.node);
  }

  private get direction(): DriveDirection {
    const d = this.cfg()?.['Direction'];
    return typeof d === 'string' ? (d as DriveDirection) : DriveDirection.LinearX;
  }

  get isRotary(): boolean { return this.cfg() ? isRotation(this.direction) : false; }
  get UseLimits(): boolean { return this.cfg()?.['UseLimits'] === true; }
  get LowerLimit(): number { return num(this.cfg(), 'LowerLimit', -180); }
  get UpperLimit(): number { return num(this.cfg(), 'UpperLimit', 180); }
  get Offset(): number { return num(this.cfg(), 'Offset', 0); }
  get currentPosition(): number {
    return this._previewPosition ?? num(this.cfg(), 'StartPosition', 0);
  }

  setPreviewPosition(pos: number): void {
    this._previewPosition = pos;
  }

  setPreviewHome(homeQuat: Quaternion): void {
    this._previewHomeQuat = homeQuat.clone();
  }

  endPreview(): void {
    this._previewPosition = null;
    this._previewHomeQuat = null;
  }

  getAxis(out: Vector3 = new Vector3()): Vector3 {
    const cfg = this.cfg();
    if (!cfg) return out.set(0, 0, 0); // Drive removed → zero axis → gizmo hides
    out.copy(directionToGltfAxis(this.direction));
    if (cfg['ReverseDirection'] === true) out.negate();
    return out;
  }

  getHomeLocalQuaternion(out: Quaternion = new Quaternion()): Quaternion {
    // During a preview the driver rotates the node, so return the pinned pre-drag
    // home; otherwise the node's current orientation IS the home (editor is still).
    return out.copy(this._previewHomeQuat ?? this.node.quaternion);
  }

  positionToLocalOffset(pos: number): number {
    // Same parent-frame correction the live drive applies — an authored axis
    // inside a CAD subtree is in millimetres, not metres (see rv-drive-units).
    return linearPositionToLocalOffsetFromAxis(
      this.node, pos, this.getAxis(_axis), this.getHomeLocalQuaternion(_home),
    );
  }
}

/** Build an authoring gizmo source for the node at `path`, or null when it has
 *  no Drive component. Wire this as the gizmo fallback in editor mode. */
export function resolveEditorDriveGizmoSource(viewer: RVViewer, path: string): DriveGizmoSource | null {
  const node = viewer.registry?.getNode(path);
  if (!node || !driveConfig(node)) return null;
  return new EditorDriveGizmoSource(node);
}
