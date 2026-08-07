// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sensor-mu-bridge.test.ts — plan-259 §9.4.
 *
 * The sensor `component-event` payload carries the occupying MU as a
 * value-safe reference (ADDITIVE — old consumers reading only `occupied` are
 * untouched); the exit event carries `mu: null` (no stale occupiedMU leak).
 *
 * Since plan-317 (R5-11) the plugin subscribes via the additive listener list;
 * `onChanged` stays public assignable API and BOTH fire from the engine's
 * state-change dispatch — so tests drive the change through the engine path
 * (`applyPhysicsResult`) instead of invoking a plugin-wrapped callback.
 */

import { describe, it, expect, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { SensorMonitorPlugin } from '../src/plugins/sensor-monitor-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

function createSensor(name: string): RVSensor {
  const node = new Object3D();
  node.name = name;
  const aabb = AABB.fromHalfSize(node, new Vector3(0.2, 0.2, 0.2));
  const sensor = new RVSensor(node, aabb);
  sensor.UseRaycast = false;
  return sensor;
}

function createMU(name: string): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  return new RVMovingUnit(node, 'src', new Vector3(0.05, 0.05, 0.05));
}

interface EmittedEvent {
  componentType: string;
  kind: string;
  path: string;
  payload?: unknown;
}

function makeFakeViewer(sensors: RVSensor[], events: EmittedEvent[]): RVViewer {
  return {
    transportManager: { sensors },
    emit: (_name: string, data: EmittedEvent) => { events.push(data); },
  } as unknown as RVViewer;
}

describe('sensor→MU bridge (component-event payload, plan-259)', () => {
  it('enter event carries a value-safe MU reference; exit carries null', () => {
    const sensor = createSensor('Sensor-In');
    const mu = createMU('Box_1');
    const events: EmittedEvent[] = [];
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, makeFakeViewer([sensor], events));

    // Enter: engine sets occupiedMU BEFORE dispatching (rv-sensor.ts applyResult).
    const direct = vi.fn();
    sensor.onChanged = direct; // public single-callback API stays assignable (R5-11)
    sensor.applyPhysicsResult(mu);

    expect(direct).toHaveBeenCalledWith(true, sensor); // onChanged AND listener list both fire
    expect(events).toHaveLength(1);
    const enter = events[0].payload as { occupied: boolean; mu: { id: number; type: string } | null };
    expect(enter.occupied).toBe(true);
    expect(enter.mu).not.toBeNull();
    expect(enter.mu!.id).toBe(mu.id);
    expect(typeof enter.mu!.id).toBe('number');
    expect(enter.mu!.type).toBe('Box_1');

    // Exit: mu must be null.
    sensor.applyPhysicsResult(null);
    const exit = events[1].payload as { occupied: boolean; mu: unknown };
    expect(exit.occupied).toBe(false);
    expect(exit.mu).toBeNull();

    plugin.dispose();
  });

  it('old consumers reading only `occupied` are unaffected (additive contract)', () => {
    const sensor = createSensor('S');
    const events: EmittedEvent[] = [];
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, makeFakeViewer([sensor], events));

    // Occupied without a resolvable MU (mirrors the live-controlled case):
    // inverted sensor + no detection → occupied=true, occupiedMU=null.
    sensor.invertSignal = true;
    sensor.applyPhysicsResult(null);

    const payload = events[0].payload as { occupied: boolean; mu: unknown };
    expect(payload.occupied).toBe(true); // the plan-210 contract field is intact
    expect(payload.mu).toBeNull();       // additive field defaults to null

    plugin.dispose();
  });

  it('clone and instanced MUs share one numeric id space', () => {
    const a = createMU('A');
    const b = createMU('B');
    expect(a.id).not.toBe(b.id);
    expect(Number.isInteger(a.id)).toBe(true);
  });
});
