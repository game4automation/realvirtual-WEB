// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DriveRecorderPlugin — Samples drive positions and speeds into ring buffers.
 *
 * Lazily registered by DriveChartOverlay on first open.
 * UI components access data via viewer.getPlugin<DriveRecorderPlugin>('drive-recorder').
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { DriveDataRecorder } from '../core/engine/rv-drive-recorder';

export class DriveRecorderPlugin implements RVViewerPlugin {
  readonly id = 'drive-recorder';
  readonly recorder = new DriveDataRecorder(3000, 10);

  /** Unsubscribe handle of the `drives-changed` subscription. */
  private _off: (() => void) | null = null;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.recorder.setDrives(viewer.drives);
    // plan-411 Phase 1: a drive created in the editor must appear in the chart
    // without a reload, and a removed one must not keep a stale ring buffer.
    this._off?.();
    this._off = viewer.on('drives-changed', () => this.recorder.setDrives(viewer.drives));
  }

  onModelCleared(): void {
    this._off?.();
    this._off = null;
    this.recorder.clear();
  }

  dispose(): void {
    this._off?.();
    this._off = null;
  }

  onFixedUpdatePost(dt: number): void {
    this.recorder.sample(dt);
  }
}
