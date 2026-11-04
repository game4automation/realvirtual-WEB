// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-sensor-data-tools — `web_sensor_read` (plan-664 test 9.4).
 *
 * The tool is a pure reader over the sensor data channel, so it can be tested
 * without a viewer: fill the channel the way a sensor does and assert the
 * answer. Two things are worth pinning beyond "it returns the numbers":
 *
 *  - the UNIT. The channel speaks metres, the tool answers in mm, and an agent
 *    that reads a scan is reading the authoring side of the sensor. A silent
 *    change of that convention would make every `RangeMax` an agent computes
 *    from a scan wrong by a factor of 1000.
 *  - the two NEGATIVE answers. "No such sensor" and "no scan yet" are different
 *    facts; collapsing them into one error is how an agent ends up adding a
 *    second component to a node that already has one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { queryValue } from './helpers/query-value';
import type { RVViewer } from '../src/core/rv-viewer';
import { getSensorDataStore, type ScanFrame, type SensorInfo } from '../src/core/engine/rv-sensor-data-store';
import { HIT_MU, HIT_NONE, NO_HIT, buildFan } from '../src/core/engine/rv-ray-scan';

const PATH = 'Yard/Stapler_1';

function info(over: Partial<SensorInfo> = {}): SensorInfo {
  return {
    type: 'LaserScanner', rayCount: 5, rangeMinMm: 20, rangeMaxMm: 8000,
    rateHz: 25, latencyMs: 40, fieldOfViewDeg: 180, angularResolutionDeg: 45,
    seed: 0x1234, ...over,
  };
}

/** A five-ray frame: the middle ray sees an MU at 1.234 m, the rest miss. */
function frame(): ScanFrame {
  const ranges = new Float32Array([NO_HIT, NO_HIT, 1.234, NO_HIT, NO_HIT]);
  const hitKind = new Uint8Array([HIT_NONE, HIT_NONE, HIT_MU, HIT_NONE, HIT_NONE]);
  const sensorWorld = new Float32Array(16);
  sensorWorld[0] = 1; sensorWorld[5] = 1; sensorWorld[10] = 1; sensorWorld[15] = 1;
  sensorWorld[12] = 2; sensorWorld[13] = 0.3; sensorWorld[14] = -5;
  return { seq: 7, simTime: 12.5, ranges, hitKind, angles: buildFan(180, 45), sensorWorld };
}

const viewer = { modes: { activeMode: 'hmi' } } as unknown as RVViewer;

afterEach(() => { getSensorDataStore().clear(); });

describe('web_sensor_read', () => {
  it('lists the registered ray sensors without a path', async () => {
    getSensorDataStore().register(PATH, info());
    getSensorDataStore().register('Yard/Gate', info({ type: 'Rangefinder', rayCount: 1 }));
    const out = JSON.parse(await queryValue(viewer, 'sensor.read', { path: '' }));
    expect(out.sensors).toEqual([
      { path: PATH, type: 'LaserScanner', rays: 5, scans: 0 },
      { path: 'Yard/Gate', type: 'Rangefinder', rays: 1, scans: 0 },
    ]);
  });

  it('answers the configuration and the scan in mm and degrees', async () => {
    getSensorDataStore().register(PATH, info());
    getSensorDataStore().publish(PATH, frame());
    const out = JSON.parse(await queryValue(viewer, 'sensor.read', { path: PATH }));
    expect(out.path).toBe(PATH);
    expect(out.type).toBe('LaserScanner');
    expect(out.rangeMaxMm).toBe(8000);
    expect(out.rateHz).toBe(25);
    expect(out.latencyMs).toBe(40);
    expect(out.seed).toBe(0x1234);

    const scan = out.scan;
    expect(scan.seq).toBe(7);
    expect(scan.simTime).toBe(12.5);
    expect(scan.hits).toBe(1);
    // Metres in the channel, mm in the answer — the convention this test exists for.
    expect(scan.minDistanceMm).toBeCloseTo(1234, 1);
    expect(scan.rangesMm[2]).toBeCloseTo(1234, 1);
    expect(scan.rangesMm[0]).toBe(-1);
    expect(scan.hitKinds).toEqual(['none', 'none', 'mu', 'none', 'none']);
    // The fan as three numbers, not 5 (or 271) repeated angles.
    expect(scan.angleFromDeg).toBeCloseTo(-90, 3);
    expect(scan.angleToDeg).toBeCloseTo(90, 3);
    expect(scan.angleStepDeg).toBeCloseTo(45, 3);
    expect(scan.originMm).toEqual([2000, 300, -5000]);
    expect(scan.forward).toEqual([0, 0, 1]);
  });

  it('separates "no such sensor" from "has not measured yet"', async () => {
    const missing = JSON.parse(await queryValue(viewer, 'sensor.read', { path: 'Yard/Nothing' }));
    expect(missing.error).toMatch(/No ray sensor/);
    expect(missing.hint).toMatch(/Rangefinder|LaserScanner/);
    expect(missing.scan).toBeUndefined();

    getSensorDataStore().register(PATH, info());
    const quiet = JSON.parse(await queryValue(viewer, 'sensor.read', { path: PATH }));
    expect(quiet.error).toBeUndefined();
    expect(quiet.scan).toBeNull();
    expect(quiet.rayCount ?? quiet.rays).toBe(5);
    expect(quiet.note).toBeTruthy();
  });

  it('reports a scan in which every ray missed as a scan, not as an error', async () => {
    getSensorDataStore().register(PATH, info());
    const f = frame();
    f.ranges.fill(NO_HIT);
    f.hitKind.fill(HIT_NONE);
    getSensorDataStore().publish(PATH, f);
    const out = JSON.parse(await queryValue(viewer, 'sensor.read', { path: PATH }));
    expect(out.scan.hits).toBe(0);
    expect(out.scan.minDistanceMm).toBe(-1);
    expect(out.error).toBeUndefined();
  });
});

describe('the sensor data channel', () => {
  it('a subscriber hears its own sensor and the unsubscribe is honoured', () => {
    const store = getSensorDataStore();
    store.register(PATH, info());
    store.register('Yard/Gate', info());
    const seen: number[] = [];
    const off = store.subscribe(PATH, (f) => seen.push(f.seq));
    store.publish(PATH, frame());
    store.publish('Yard/Gate', frame());
    expect(seen).toEqual([7]);
    off();
    store.publish(PATH, frame());
    expect(seen).toEqual([7]);
  });

  it('publishing to an unregistered path is ignored, and unregister takes the frame with it', () => {
    const store = getSensorDataStore();
    store.publish(PATH, frame());
    expect(store.get(PATH)).toBeNull();
    store.register(PATH, info());
    store.publish(PATH, frame());
    expect(store.get(PATH)!.seq).toBe(7);
    store.unregister(PATH);
    expect(store.get(PATH)).toBeNull();
    expect(store.infoOf(PATH)).toBeNull();
  });

  it('a throwing subscriber does not stop the others', () => {
    const store = getSensorDataStore();
    store.register(PATH, info());
    const seen: number[] = [];
    store.subscribe(PATH, () => { throw new Error('boom'); });
    store.subscribe(PATH, (f) => seen.push(f.seq));
    expect(() => store.publish(PATH, frame())).not.toThrow();
    expect(seen).toEqual([7]);
  });
});
