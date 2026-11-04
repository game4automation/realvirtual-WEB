// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Central simulation speed of the continuous simulation — one master factor.
 *
 * 1 = normal, 0.5 = half speed, 2 = double, 0 = stopped. It is applied in two
 * ways that together make "simulated time runs N× faster":
 *  - every Drive multiplies its targetSpeed by it (relative speeds between
 *    drives are preserved), so the fixed 60 Hz step stays a 60 Hz step;
 *  - the time-based logic advances its clock by {@link scaleSimDt}: the sim
 *    clock (`viewer.simTime`, hence statistics), Source interval spawning,
 *    LogicStep Delay, material-flow / script timers, the DES Animated clock
 *    in continuous mode and the ST-PLC timer clock.
 * The sim toolbar ("Simulation speed") and the MCP tool
 * `web_drive_speed_override` set it. Not persisted — it is a live override.
 */

let _factor = 1;
const listeners = new Set<() => void>();

/** Current master speed factor (1 = normal). */
export function getDriveSpeedOverride(): number {
  return _factor;
}

/** Set the master speed factor. Clamped to [0, 100]. */
export function setDriveSpeedOverride(factor: number): number {
  const f = Number.isFinite(factor) ? Math.max(0, Math.min(factor, 100)) : 1;
  if (f !== _factor) {
    _factor = f;
    for (const l of listeners) l();
  }
  return _factor;
}

/**
 * Simulated seconds that pass during one fixed tick of `dt` real seconds at the
 * current simulation speed. Hot path: one multiplication, no allocation.
 */
export function scaleSimDt(dt: number): number {
  return dt * _factor;
}

/** Subscribe to override changes (for reactive UI). Returns an unsubscribe fn. */
export function subscribeDriveSpeedOverride(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
