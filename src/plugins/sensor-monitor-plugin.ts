// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SensorMonitorPlugin — Emits `component-event` (componentType: 'sensor', kind: 'changed')
 * via sensor.onChanged callbacks.
 *
 * Event-based (NOT polling): only fires when a sensor actually changes state.
 * Maintains a ring-buffer event history for debugging / UI display.
 *
 * Sensors come and go after the main load — placements materialised by the
 * PlacementInstancer, editor component adds and separate/merge rebuilds, a
 * gated model's late logic activation, placement / subtree removal. All of
 * them register through the transport manager (`addSensor` / `removeSensors`
 * / `clearSensors`), so the plugin follows its ONE notification point
 * (`onSensorsChanged`) plus an initial reconciliation in `onModelLoaded`.
 * Listeners are tracked per sensor, so attaching is idempotent.
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
  /** The feedback listener installed per monitored sensor (its removal closure). */
  private readonly tracked = new Map<RVSensor, () => void>();
  /** Unsubscribe from the transport manager's sensor registration changes. */
  private offSensorsChanged: (() => void) | null = null;
  private elapsed = 0;

  /** Number of sensors currently carrying a monitor listener (diagnostics, tests). */
  get monitoredCount(): number {
    return this.tracked.size;
  }

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.unsubscribe();
    const tm = viewer.transportManager;
    if (tm && typeof tm.onSensorsChanged === 'function') {
      this.offSensorsChanged = tm.onSensorsChanged((added, removed) => {
        for (const sensor of removed) this.detach(sensor);
        for (const sensor of added) this.attach(sensor);
      });
    }
    this.reconcile();
  }

  onFixedUpdatePost(dt: number): void {
    this.elapsed += dt;
  }

  onModelCleared(): void {
    this.unsubscribe();
    this.detachAll();
    this.eventHistory.clear();
    this.elapsed = 0;
  }

  dispose(): void {
    this.onModelCleared();
    this.viewer = null;
  }

  /** Bring the tracked set in line with `transportManager.sensors` (initial load, replayed load). */
  private reconcile(): void {
    const sensors = this.viewer?.transportManager?.sensors ?? [];
    if (this.tracked.size > 0) {
      const current = new Set(sensors);
      for (const [sensor, cleanup] of this.tracked) {
        if (!current.has(sensor)) { cleanup(); this.tracked.delete(sensor); }
      }
    }
    for (const sensor of sensors) this.attach(sensor);
  }

  private detach(sensor: RVSensor): void {
    const cleanup = this.tracked.get(sensor);
    if (!cleanup) return;
    cleanup();
    this.tracked.delete(sensor);
  }

  private attach(sensor: RVSensor): void {
    if (this.tracked.has(sensor)) return;
    // Event-based: additive listener API preserves the public onChanged callback.
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
    this.tracked.set(sensor, () => sensor.removeFeedbackListener(listener));
  }

  private detachAll(): void {
    for (const cleanup of this.tracked.values()) cleanup();
    this.tracked.clear();
  }

  private unsubscribe(): void {
    const off = this.offSensorsChanged;
    this.offSensorsChanged = null;
    off?.();
  }
}
