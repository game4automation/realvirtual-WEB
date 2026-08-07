// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SensorMonitorPlugin — Emits `component-event` (componentType: 'sensor', kind: 'changed')
 * via sensor.onChanged callbacks.
 *
 * Event-based (NOT polling): only fires when a sensor actually changes state.
 * Maintains a ring-buffer event history for debugging / UI display.
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVSensor } from '../core/engine/rv-sensor';
import { RingBuffer } from '../core/engine/rv-ring-buffer';

export interface SensorEvent {
  sensorPath: string;
  occupied: boolean;
  time: number;
}

export class SensorMonitorPlugin implements RVViewerPlugin {
  readonly id = 'sensor-monitor';
  readonly core = true;
  readonly eventHistory = new RingBuffer<SensorEvent>(500);

  private viewer: RVViewer | null = null;
  private sensors: RVSensor[] = [];
  private cleanups: (() => void)[] = [];
  private elapsed = 0;

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.sensors = viewer.transportManager?.sensors ?? [];

    // Event-based: additive listener API preserves the public onChanged callback.
    for (const sensor of this.sensors) {
      const listener = () => {
        const occupied = sensor.occupied;
        const s = sensor;
        // Emit event
        const path = (s.node.userData?.rv as Record<string, unknown> | undefined)?.['path'] as string
          ?? s.node.name;
        this.eventHistory.push({ sensorPath: path, occupied, time: this.elapsed });
        // Payload is ADDITIVE (plan-259 sensor→MU bridge): `mu` carries a
        // value-safe reference to the occupying MU (engine-wide numeric id +
        // display name) so consumers (StopOnExit, script SDK) can resolve the
        // actual MU. Old consumers reading only `occupied` are unaffected.
        const occMu = occupied ? s.occupiedMU : null;
        this.viewer?.emit('component-event', {
          componentType: 'sensor',
          kind: 'changed',
          path,
          payload: {
            occupied,
            mu: occMu ? { id: occMu.id, type: occMu.getName() } : null,
          },
        });
      };
      sensor.addFeedbackListener(listener);
      this.cleanups.push(() => sensor.removeFeedbackListener(listener));
    }
  }

  onFixedUpdatePost(dt: number): void {
    this.elapsed += dt;
  }

  onModelCleared(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.sensors = [];
    this.eventHistory.clear();
    this.elapsed = 0;
  }

  dispose(): void {
    this.onModelCleared();
  }
}
