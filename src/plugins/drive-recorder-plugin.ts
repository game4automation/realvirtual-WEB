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

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.recorder.setDrives(viewer.drives);
  }

  onModelCleared(): void {
    this.recorder.clear();
  }

  onFixedUpdatePost(dt: number): void {
    this.recorder.sample(dt);
  }
}
