// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TransportStatsPlugin — Samples transport counters at 10Hz into ring buffers.
 *
 * Emits 'mu-spawned' and 'mu-consumed' events when counters change.
 * UI components can poll the ring buffers via usePlugin('transport-stats').
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { RingBuffer } from '../core/engine/rv-ring-buffer';

export class TransportStatsPlugin implements RVViewerPlugin {
  readonly id = 'transport-stats';
  readonly core = true;

  readonly timeBuffer = new RingBuffer<number>(3000);
  readonly spawnedBuffer = new RingBuffer<number>(3000);
  readonly consumedBuffer = new RingBuffer<number>(3000);

  private viewer: RVViewer | null = null;
  private lastSpawned = 0;
  private lastConsumed = 0;
  private elapsed = 0;
  private sampleInterval = 1 / 10; // 10Hz
  private timeSinceSample = 0;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.clear();
  }

  onModelCleared(): void {
    this.clear();
  }

  onFixedUpdatePost(dt: number): void {
    this.elapsed += dt;
    this.timeSinceSample += dt;
    if (this.timeSinceSample < this.sampleInterval) return;
    this.timeSinceSample -= this.sampleInterval;

    const tm = this.viewer?.transportManager;
    if (!tm) return;

    this.timeBuffer.push(this.elapsed);
    this.spawnedBuffer.push(tm.totalSpawned);
    this.consumedBuffer.push(tm.totalConsumed);

    if (tm.totalSpawned !== this.lastSpawned) {
      this.viewer?.emit('mu-spawned', { totalSpawned: tm.totalSpawned });
      this.lastSpawned = tm.totalSpawned;
    }
    if (tm.totalConsumed !== this.lastConsumed) {
      this.viewer?.emit('mu-consumed', { totalConsumed: tm.totalConsumed });
      this.lastConsumed = tm.totalConsumed;
    }
  }

  private clear(): void {
    this.timeBuffer.clear();
    this.spawnedBuffer.clear();
    this.consumedBuffer.clear();
    this.lastSpawned = 0;
    this.lastConsumed = 0;
    this.elapsed = 0;
    this.timeSinceSample = 0;
  }
}
