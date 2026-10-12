// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sensor-reset-feedback.test.ts — a simulation reset clears a Sensor THROUGH its
 * change pipeline, so the bound PLC signal follows (plan-569, engine gap 2).
 *
 * `RVTransportManager.reset()` used to write `sensor.occupied = false` directly.
 * `refreshPlantFeedback()` then re-evaluated the sensor, saw "free → free" and fired
 * nothing — a `SensorOccupied` signal that was true before the reset stayed true.
 * Laser welding demo: after a reset taken while Lift02 was down with a pallet,
 * `FG_TS_Lift02_B_Detect` stayed true, the cold-started Lift02 program lowered the
 * EMPTY lift at once and the next pallet rolled onto the lowered lift — the line
 * stalled after a few resets.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

const BOX = { x: 0.1, y: 0.1, z: 0.1 };

function sensorWithSignal(): { sensor: RVSensor; writes: boolean[] } {
  const node = new Object3D();
  const sensor = new RVSensor(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, BOX));
  const writes: boolean[] = [];
  sensor.onChanged = (occupied) => { writes.push(occupied); };
  return { sensor, writes };
}

describe('Sensor feedback on a simulation reset (plan-569)', () => {
  it('an occupied sensor reports "free" when the transport manager resets', () => {
    const tm = new RVTransportManager();
    const { sensor, writes } = sensorWithSignal();
    tm.sensors.push(sensor);
    sensor.occupied = true; // detected before the reset; the bound signal is true

    tm.reset();

    expect(sensor.occupied).toBe(false);
    expect(sensor.occupiedMU).toBeNull();
    expect(writes, 'the change pipeline ran, so the bound signal follows').toEqual([false]);
  });

  it('a free sensor stays silent on a reset (no spurious edge)', () => {
    const tm = new RVTransportManager();
    const { sensor, writes } = sensorWithSignal();
    tm.sensors.push(sensor);

    tm.reset();

    expect(sensor.occupied).toBe(false);
    expect(writes).toEqual([]);
  });

  it('a model unload (disposeSources) clears without writing signals', () => {
    const tm = new RVTransportManager();
    const { sensor, writes } = sensorWithSignal();
    tm.sensors.push(sensor);
    sensor.occupied = true;

    tm.reset(true);

    expect(sensor.occupied).toBe(false);
    expect(writes).toEqual([]);
  });
});
