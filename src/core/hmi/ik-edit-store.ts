// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-edit-store.ts — Bridge between IKTargetEditPlugin (3D) and the React popover.
 *
 * The plugin pushes the active pathpoint (its editable IKTarget values + a controller
 * for mutations) here; the IKTargetQuickEdit content reads it via useSyncExternalStore.
 * The live world anchor is supplied separately via the generic popover request's
 * getWorld() closure (projected each frame by AnchoredPopover).
 */

export interface IKEditValues {
  interpolation: string;        // 'PointToPoint' | 'PointToPointUnsynced' | 'Linear'
  speedToTarget: number;        // 0..1
  linearSpeed: number;          // mm/s
  linearAccel: number;          // mm/s^2
  enableBlending: boolean;
  blendRadius: number;          // mm
  waitForSeconds: number;       // s
  pickAndPlace: boolean;
}

/** Numeric pose components editable in the quick-edit (world frame). */
export type PoseField = 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz';

export interface IKEditActive extends IKEditValues {
  /** Target node path (stable identity for React keys). */
  path: string;
  name: string;
  /** True while the current pose is reachable by the solver (red ring otherwise). */
  reachable: boolean;
  /** Reachable IK configurations at the current pose (0 = no live solve). */
  solutionCount: number;
  /** 0-based index of the applied configuration within the reachable set (-1 = unknown). */
  solutionIndex: number;
  /** World position in millimeters (rounded to 0.1). */
  poseMm: [number, number, number];
  /** World rotation as XYZ Euler in degrees (rounded to 0.1). */
  poseDeg: [number, number, number];
}

export interface IKEditController {
  setProp<K extends keyof IKEditValues>(field: K, value: IKEditValues[K]): void;
  /** Set one world-pose component (mm for x/y/z, degrees for rx/ry/rz). */
  setPose(field: PoseField, value: number): void;
  /** Align the TCP orientation: nearest axis exactly world-down / snap to world axes. */
  align(mode: 'down' | 'world'): void;
  /** Insert a new waypoint before / after the active one (interpolated pose). */
  addPoint(where: 'before' | 'after'): void;
  deleteTarget(): void;
  /** Step to the previous/next reachable IK configuration (elbow/shoulder/wrist branch). */
  cycleSolution(dir: 1 | -1): void;
  /** Show (dir) / hide (null) a ghost preview of the neighboring configuration. */
  previewSolution(dir: 1 | -1 | null): void;
  close(): void;
}

class IKEditStore {
  private _active: IKEditActive | null = null;
  private _controller: IKEditController | null = null;
  private readonly _listeners = new Set<() => void>();

  subscribe = (l: () => void): (() => void) => { this._listeners.add(l); return () => { this._listeners.delete(l); }; };
  getSnapshot = (): IKEditActive | null => this._active;

  getController(): IKEditController | null { return this._controller; }

  setActive(active: IKEditActive, controller: IKEditController): void {
    this._active = active; this._controller = controller; this._notify();
  }
  /** Merge changed editable values (after an edit) and re-render. */
  updateValues(v: Partial<IKEditValues> & Partial<Pick<IKEditActive, 'reachable' | 'solutionCount' | 'solutionIndex' | 'poseMm' | 'poseDeg'>>): void {
    if (!this._active) return;
    this._active = { ...this._active, ...v };
    this._notify();
  }
  clear(): void {
    if (!this._active) return;
    this._active = null; this._controller = null; this._notify();
  }

  private _notify(): void { for (const l of this._listeners) l(); }
}

export const ikEditStore = new IKEditStore();
