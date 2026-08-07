// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pending-pulse.ts — the "this is still loading" motion cue on a placeholder
 * (plan-371 F6).
 *
 * The pulse is a `box` gizmo from the shared {@link GizmoOverlayManager}, NOT a
 * private requestAnimationFrame loop. That matters for three reasons: the
 * manager's `tick()` is already driven from the viewer's fixed update, its blink
 * phase is global (so several placeholders pulse in step instead of beating
 * against each other), and its teardown is centralised — a leaked pulse would
 * otherwise keep a deleted placement's material alive forever.
 *
 * Two accessibility rules are non-negotiable:
 *
 *  1. **1.5 Hz, never 3.** {@link CONFLICT_BLINK_HZ} is reused verbatim so the
 *     viewer has exactly ONE pulse speed, and it sits at half the WCAG 2.3.1
 *     flash threshold rather than on it.
 *  2. **`prefers-reduced-motion: reduce` turns the pulse OFF.** Reduced motion
 *     is a request for no motion, not for gentler motion — the wireframe box,
 *     the thumbnail and the HMI status line already carry the message without
 *     moving. The preference is watched live, so flipping the OS setting takes
 *     effect without a reload.
 */

import type { Object3D } from 'three';
import type { GizmoHandle, GizmoOverlayManager } from '../../core/engine/rv-gizmo-manager';
import {
  CONFLICT_BLINK_HZ,
  createReducedMotionWatcher,
  type MatchMediaFn,
  type ReducedMotionWatcher,
} from '../signal-bind/conflict-blink';

/** Instrument Blue — same accent as the placeholder wireframe it wraps. */
const PULSE_COLOR = 0x4fc3f7;

/** Millimetre → metre. */
const MM_TO_M = 0.001;

/**
 * Halo inflation. The pulse box is deliberately a hair larger than the
 * placeholder's own wireframe: exactly coincident line segments z-fight, and
 * the small offset also reads as a halo rather than a doubled outline.
 */
const PULSE_INFLATE = 1.05;

/** What the controller needs from its host. */
export interface PendingPulseDeps {
  /** Lazy because the planner outlives any single viewer attachment. */
  gizmoManager(): GizmoOverlayManager | null;
  /** Injectable for tests — see `tests/badge-reduced-motion.test.ts`. */
  matchMedia?: MatchMediaFn;
}

/**
 * Owns one pulse per pending placement.
 *
 * Placeholders are `LineSegments`-only, so `computeSubtreeAABB` (which counts
 * `isMesh` descendants) cannot measure them and falls back to a 10 cm stub. The
 * catalog footprint is therefore stamped onto the gizmo root directly after
 * creation — `GizmoHandle.root` is documented as the escape hatch for exactly
 * this kind of caller-side transform.
 */
export class PendingPulseController {
  private _handles = new Map<string, GizmoHandle>();
  private _deps: PendingPulseDeps;
  private _watcher: ReducedMotionWatcher;

  constructor(deps: PendingPulseDeps) {
    this._deps = deps;
    this._watcher = createReducedMotionWatcher(
      () => this._applyBlink(),
      deps.matchMedia,
    );
  }

  /** The blink rate every live pulse currently runs at (0 = reduced motion). */
  get blinkHz(): number {
    return this._watcher.matches() ? 0 : CONFLICT_BLINK_HZ;
  }

  /**
   * Attach a pulse to `node`, sized from the catalog footprint in millimetres.
   * Restarting an id replaces the previous pulse (used by retry).
   */
  start(id: string, node: Object3D, sizeMm: readonly [number, number, number]): void {
    const gizmos = this._deps.gizmoManager();
    if (!gizmos) return;
    this.stop(id);

    const handle = gizmos.create(node, {
      shape: 'box',
      color: PULSE_COLOR,
      opacity: 0.85,
      blinkHz: this.blinkHz,
      // Ride along with the placeholder: the drag moves it every pointer frame.
      attachToNode: true,
      // A loading indicator must never steal hover from the placement it marks.
      excludeFromRaycast: true,
    });

    handle.root.scale.set(
      sizeMm[0] * MM_TO_M * PULSE_INFLATE,
      sizeMm[1] * MM_TO_M * PULSE_INFLATE,
      sizeMm[2] * MM_TO_M * PULSE_INFLATE,
    );
    // The placement origin sits at the box's floor centre, so lift the halo by
    // half its height to make it concentric with the placeholder box.
    handle.root.position.set(0, (sizeMm[1] * MM_TO_M) / 2, 0);

    this._handles.set(id, handle);
  }

  /** Remove the pulse for one placement. Idempotent. */
  stop(id: string): void {
    const handle = this._handles.get(id);
    if (!handle) return;
    handle.dispose();
    this._handles.delete(id);
  }

  /** Remove every pulse — teardown, model change, scene reload. */
  stopAll(): void {
    for (const handle of this._handles.values()) handle.dispose();
    this._handles.clear();
  }

  /** True while `id` has a live pulse. */
  has(id: string): boolean {
    return this._handles.has(id);
  }

  dispose(): void {
    this.stopAll();
    this._watcher.dispose();
  }

  /** Re-apply the current motion preference to every live pulse. */
  private _applyBlink(): void {
    const blinkHz = this.blinkHz;
    for (const handle of this._handles.values()) handle.update({ blinkHz });
  }
}
