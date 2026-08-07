// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-jog-controller — ephemeral drive test-jogging for the Kinematics
 * window in EDITOR mode.
 *
 * The editor runtime is DETACHED (no fixed-update integration), so this
 * controller integrates `drive.currentPosition` itself on a rAF loop and
 * applies it via `drive.applyToNode()`. It is a pure PREVIEW:
 *
 *  - never emits ops (undo history stays clean),
 *  - captures the start position on the first jog and restores it on
 *    `resetToStart()`, `dispose()` and the `asset-editor-pre-export` event
 *    (a jogged pose must never bake into the saved GLB).
 */

import type { RVViewer } from '../../../core/rv-viewer';
import type { RVDrive } from '../../../core/engine/rv-drive';

const SHADOW_UPDATE_INTERVAL_MS = 250;

export class EditorJogController {
  private readonly viewer: RVViewer;
  readonly drive: RVDrive;

  private _dir: -1 | 0 | 1 = 0;
  private _raf: number | null = null;
  private _lastTs = 0;
  private _lastShadowTs = 0;
  /** Position before the first jog (null = untouched). */
  private _savedPosition: number | null = null;
  private readonly _offPreExport: () => void;
  /** Panel readout callback — invoked once per preview tick. */
  onTick: (() => void) | null = null;

  constructor(viewer: RVViewer, drive: RVDrive) {
    this.viewer = viewer;
    this.drive = drive;
    this._offPreExport = viewer.on('asset-editor-pre-export', () => this.resetToStart());
  }

  /** Current latch direction (-1 backward, 0 stopped, 1 forward). */
  get direction(): -1 | 0 | 1 {
    return this._dir;
  }

  /** True once the preview moved the drive away from its captured pose. */
  get hasPreviewPose(): boolean {
    return this._savedPosition !== null && this._savedPosition !== this.drive.currentPosition;
  }

  /** Latch a jog direction (0 stops; pose is kept until reset). */
  jog(dir: -1 | 0 | 1): void {
    if (dir === this._dir) return;
    this._dir = dir;
    if (dir === 0) {
      this._stopLoop();
      this.viewer.markShadowsDirty();
      this.viewer.markRenderDirty();
      return;
    }
    if (this._savedPosition === null) this._savedPosition = this.drive.currentPosition;
    if (this._raf === null) {
      this._lastTs = performance.now();
      this._raf = requestAnimationFrame(this._tick);
    }
  }

  /** Stop and restore the pose captured before the first jog. */
  resetToStart(): void {
    this._dir = 0;
    this._stopLoop();
    if (this._savedPosition !== null) {
      this.drive.currentPosition = this._savedPosition;
      this._savedPosition = null;
      this.drive.applyToNode();
      this.drive.node.updateMatrixWorld(true);
      this.viewer.markShadowsDirty();
      this.viewer.markRenderDirty();
      this.onTick?.();
    }
  }

  /** Stop the loop and restore the pose. Call on unmount / drive switch. */
  dispose(): void {
    this.resetToStart();
    this._offPreExport();
    this.onTick = null;
  }

  private _stopLoop(): void {
    if (this._raf !== null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  private readonly _tick = (ts: number): void => {
    this._raf = null;
    if (this._dir === 0) return;
    const dt = Math.min((ts - this._lastTs) / 1000, 0.1); // clamp tab-switch gaps
    this._lastTs = ts;

    const drive = this.drive;
    let next = drive.currentPosition + this._dir * Math.abs(drive.targetSpeed) * dt;
    if (drive.UseLimits) {
      next = Math.min(Math.max(next, drive.LowerLimit), drive.UpperLimit);
    }
    if (next !== drive.currentPosition) {
      drive.currentPosition = next;
      drive.applyToNode();
      drive.node.updateMatrixWorld(true);
      this.viewer.markRenderDirty();
      if (ts - this._lastShadowTs > SHADOW_UPDATE_INTERVAL_MS) {
        this._lastShadowTs = ts;
        this.viewer.markShadowsDirty();
      }
    }
    this.onTick?.();
    this._raf = requestAnimationFrame(this._tick);
  };
}
