// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Sensor registration helpers - every write of `RVTransportManager.sensors`
 * goes through here, so the manager's `addSensor` / `removeSensors` stay the
 * ONE notification point for `onSensorsChanged` (sensor monitor ->
 * `component-event`). Type-only imports: safe to use from `rv-sensor`
 * without an import cycle.
 */

import type { RVSensor } from './rv-sensor';
import type { RVTransportManager } from './rv-transport-manager';

/** What the sensor write helpers need: the list, and the manager API when it is a real manager. */
export type SensorListHost = { sensors: RVSensor[] } & Partial<Pick<RVTransportManager, 'addSensor' | 'removeSensors' | 'removeSensor'>>;

/**
 * Register a sensor through {@link RVTransportManager.addSensor} (the one
 * notification point). A structural host (test rig, perf harness) without the
 * API gets a plain push — it has no {@link RVTransportManager.onSensorsChanged}
 * listeners to miss.
 */
export function addSensorTo(tm: SensorListHost, sensor: RVSensor): void {
  if (typeof tm.addSensor === 'function') tm.addSensor(sensor);
  else tm.sensors.push(sensor);
}

/** Remove the sensors matching `predicate` through {@link RVTransportManager.removeSensors} (see {@link addSensorTo}). */
export function removeSensorsFrom(tm: SensorListHost, predicate: (sensor: RVSensor) => boolean): RVSensor[] {
  if (typeof tm.removeSensors === 'function') return tm.removeSensors(predicate);
  const removed = tm.sensors.filter(predicate);
  if (removed.length > 0) tm.sensors = tm.sensors.filter((s) => !predicate(s));
  return removed;
}

/** Remove ONE sensor through {@link RVTransportManager.removeSensor}; a no-op when it is not registered (see {@link addSensorTo}). */
export function removeSensorFrom(tm: SensorListHost, sensor: RVSensor): boolean {
  if (typeof tm.removeSensor === 'function') return tm.removeSensor(sensor);
  const index = tm.sensors.indexOf(sensor);
  if (index < 0) return false;
  tm.sensors = tm.sensors.filter((s) => s !== sensor);
  return true;
}
