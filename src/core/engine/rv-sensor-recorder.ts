// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Sensor Data Recorder — samples sensor occupied states into ring buffers.
 *
 * Samples at a fixed rate (default 10 Hz) to build timeline data for the
 * sensor chart overlay. Each sensor gets a boolean-as-number (0/1) ring buffer.
 * A shared time buffer stores elapsed simulation seconds.
 */

import { RingBuffer } from './rv-ring-buffer';
import type { RVSensor } from './rv-sensor';

export interface SensorTimeSeries {
  sensor: RVSensor;
  /** Sensor path (hierarchy path or node name). */
  path: string;
  /** 0 = not occupied, 1 = occupied. Step chart data. */
  state: RingBuffer<number>;
}

export class SensorDataRecorder {
  readonly timeBuffer: RingBuffer<number>;
  readonly series: SensorTimeSeries[] = [];
  private elapsedTime = 0;
  private sampleInterval: number;
  private timeSinceLastSample = 0;

  /**
   * @param capacity   Number of samples to keep per sensor.
   * @param sampleRate Samples per second (default 10 = every 100ms).
   */
  constructor(capacity = 3000, sampleRate = 10) {
    this.timeBuffer = new RingBuffer<number>(capacity);
    this.sampleInterval = 1 / sampleRate;
  }

  /** Bind sensors — call after model load. Clears existing data. */
  setSensors(sensors: RVSensor[]): void {
    this.series.length = 0;
    this.timeBuffer.clear();
    this.elapsedTime = 0;
    this.timeSinceLastSample = 0;

    for (const sensor of sensors) {
      const path = (sensor.node.userData?.rv as Record<string, unknown> | undefined)?.['path'] as string
        ?? sensor.node.name;
      this.series.push({
        sensor,
        path,
        state: new RingBuffer<number>(this.timeBuffer.capacity),
      });
    }
  }

  /** Call every simulation fixed-update tick. */
  sample(dt: number): void {
    this.elapsedTime += dt;
    this.timeSinceLastSample += dt;

    if (this.timeSinceLastSample < this.sampleInterval) return;
    this.timeSinceLastSample -= this.sampleInterval;

    this.timeBuffer.push(this.elapsedTime);
    for (const s of this.series) {
      s.state.push(s.sensor.occupied ? 1 : 0);
    }
  }

  /** Clear all recorded data. */
  clear(): void {
    this.timeBuffer.clear();
    this.elapsedTime = 0;
    this.timeSinceLastSample = 0;
    for (const s of this.series) {
      s.state.clear();
    }
  }
}
