// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SensorRecorderPlugin — Samples sensor occupied states into ring buffers.
 *
 * Lazily registered by SensorChartOverlay on first open.
 * UI components access data via viewer.getPlugin<SensorRecorderPlugin>('sensor-recorder').
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { SensorDataRecorder } from '../core/engine/rv-sensor-recorder';

export class SensorRecorderPlugin implements RVViewerPlugin {
  readonly id = 'sensor-recorder';
  readonly recorder = new SensorDataRecorder(3000, 10);

  private viewer: RVViewer | null = null;
  private _offReady: (() => void) | null = null;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.recorder.setSensors(viewer.transportManager?.sensors ?? []);
    // Sensors of placed references register AFTER this callback (scene-ready
    // contract) — take the complete list once they are all in.
    this._offReady?.();
    this._offReady = viewer.on('placements-materialized', (info) => {
      if (!info.aborted && info.materialized > 0) this.recorder.setSensors(viewer.transportManager?.sensors ?? []);
    });
  }

  onModelCleared(): void {
    this._offReady?.();
    this._offReady = null;
    this.recorder.clear();
  }

  onFixedUpdatePost(dt: number): void {
    this.recorder.sample(dt);
  }
}
