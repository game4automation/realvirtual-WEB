// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pre-bake-keys.ts — the `userData` keys an `onPreBake` hook writes and the
 * matching component reads back (plan-754 D18).
 *
 * Dependency-free ON PURPOSE: the producer (rv-pre-bake-hooks.ts) and the
 * consumers (rv-drive.ts, rv-sensor.ts) sit on opposite sides of the component
 * graph, and a shared constant must not drag either of them into the other's
 * import closure.
 *
 * Everything stored under these keys is PLAIN JSON DATA — `Object3D.clone()`
 * JSON-round-trips `userData`, and the destructive bake rebuilds every surviving
 * node as a plain `Group` with a JSON copy of it (memory
 * `webviewer-userdata-clone-json-roundtrip`).
 */

/** Authored HOME transform of a drive node, captured before any re-parenting. */
export const RV_DRIVE_HOME_KEY = '_rvDriveHome';

/** Pre-computed sensor beam (origin offset, direction, length in mm). */
export const RV_SENSOR_BEAM_KEY = '_rvBeam';

/**
 * Pre-computed collision box of a sensor (plan-655 B1): centre `c` and half
 * extents `h` in the sensor NODE's local frame (its own units — mm on a
 * SolidCraft body), measured over its mesh subtree before the bake merges it.
 */
export const RV_SENSOR_BOX_KEY = '_rvSensorBox';

/** Plain-data sensor box — node-local centre + half extents, JSON-cloneable. */
export interface PreBakedSensorBox {
  c: [number, number, number];
  h: [number, number, number];
}

/** Plain-data home pose — position, quaternion, scale. */
export interface DriveHomePose {
  p: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
}

/** Plain-data sensor beam — same shape as `SensorBeam`, JSON-cloneable. */
export interface PreBakedSensorBeam {
  originOffset: [number, number, number];
  direction: { x: number; y: number; z: number };
  lengthMm: number;
}
