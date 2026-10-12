// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Names of the RUNTIME visualisation a Sensor builds on every load
 * (rv-sensor.ts): the box `<node>_sensorViz` and the ray tube `<node>_sensorRay`.
 *
 * Neither is file content. The export used to prune only `_sensorViz`, so every
 * save wrote the ray tube into the GLB and the next load built another one next
 * to it — one more beam per round trip. Three.js / the export dedup then
 * renamed the copies `_sensorRay_1`, `_sensorRay_1_1`, … which is why the match
 * accepts any run of `_<n>` suffixes: a file polluted before the fix is cleaned
 * by the same rule that keeps new saves clean. The box outline
 * (`<node>_sensorViz_edges`) used to be unnamed and is matched the same way.
 */
const SENSOR_RUNTIME_VIZ_NAME = /_sensor(?:Viz|Ray)(?:_edges)?(?:_\d+)*$/;

/** True for a node name produced by a Sensor's runtime visualisation (any dedup suffix). */
export function isSensorRuntimeVizName(name: string): boolean {
  return SENSOR_RUNTIME_VIZ_NAME.test(name);
}
