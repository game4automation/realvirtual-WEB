// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraEventsPlugin — Emits 'camera-animation-done' when a camera animation finishes.
 *
 * Watches the viewer's internal camera animation state each render frame.
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';

export class CameraEventsPlugin implements RVViewerPlugin {
  readonly id = 'camera-events';
  readonly core = true;
  private viewer: RVViewer | null = null;
  private wasAnimating = false;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
  }

  onRender(): void {
    if (!this.viewer) return;
    const isAnimating = this.viewer.isCameraAnimating;
    if (this.wasAnimating && !isAnimating) {
      this.viewer.emit('camera-animation-done', {});
    }
    this.wasAnimating = isAnimating;
  }
}
